# Server 实现 Playbook（并发 / 事务 / 安全）

> 新 server use case **实现期**工程 guardrail 的**单一详版**。沉淀自 001-005 实战。**仅讲 HOW（实现机制）**；WHAT（业务要求）归 spec、边界归属归 [bounded-context catalog](server-bounded-context-catalog.md)。
>
> **引用不复述**（各有单一家，本文不重述）：模块边界 / 护城河 / 跨 ctx 传播 → [catalog](server-bounded-context-catalog.md) + [ADR-0032](../adr/0032-backend-bounded-context.md) / [ADR-0043](../adr/0043-server-flat-module-paradigm.md)；outbox envelope → [ADR-0033](../adr/0033-outbox-cross-context-comm.md)；HMAC sms-code 存储 → [ADR-0023](../adr/0023-sms-code-storage-hmac.md)；ORM → [ADR-0019](../adr/0019-orm-prisma.md)。
>
> path-triggered 摘要见 [`.claude/rules/server-impl-playbook.md`](../../.claude/rules/server-impl-playbook.md)（改 `*.usecase/service/scheduler.ts` 自动加载）。

## Golden Sample

新 server use case 起手**对照样板文件**（文件头 `// GOLDEN SAMPLE` banner）：**简单档**（单 ctx CRUD）→ `account/update-display-name.usecase.ts`；**跨 ctx 档**（编排多 bounded context）→ `auth/phone-sms-auth.usecase.ts`（+ 写半段 `account/commit-phone-login.usecase.ts`）。「学什么 / 不适用边界 / 跨端配对」→ [golden-sample-registry](golden-sample-registry.md)（单一索引，本文不复述）。**默认并发范式不在样板里复述** → § P1；跨行聚合不变性 → § P7。

## 1. 并发 / 事务（Prisma）

### P1 — 单行状态转换 = conditional UPDATE + affected-count（**默认**）

`updateMany({ where: { id, <前置状态/谓词> }, data })` → `count===1` = won（唯一成功者）、`count===0` = lost（前置不满足 / 被并发抢先）。隔离级 **READ COMMITTED（默认即可）**：同行竞争由 DB 行写锁天然串行化（后到者 re-check `where` 不匹配 → count=0）。

- **何时用**：单行状态机转换、单设备撤销、互斥裁决、幂等写。
- **反模式**：单行就上 `SELECT … FOR UPDATE` / Serializable（见 P2）。
- **实证锚**：`refresh-token.service.ts` `rotate`（003，旧仓 #196，10 并发同 token → 恰 1 成功 + 9×401）；004 freeze/cancel/anonymize conditional UPDATE（旧仓 #198）；005 device revoke `revokeOneForAccount`（旧仓 #201）。

### P2 — 禁 FOR UPDATE / Serializable 单行

偏索引（如 `WHERE revoked_at IS NULL`）上 SERIALIZABLE 产 SSI 假冲突（PG `40001`），令**独立行**的高并发写批量失败（004 T015 实证 72/100 假失败）；而 affected-count（P1）已独立保证 exactly-once → SERIALIZABLE 对单行纯冗余 + 有害。

- **实证锚**：`refresh-token.service.ts` `rotate` 注释（"不用 SERIALIZABLE … SSI 假冲突"）。

### P3 — 并发 insert race（**确需** Serializable 时）= P2002 + P2034 双形态

并发创建唯一行（如 find-or-create）若用 Serializable，须 catch **两种**形态：`P2002`（唯一约束撞）→ tx 内 fallback 读已存在行；`P2034`（写冲突 / 序列化失败，整 tx abort）→ **外层 retry 整个 tx**。只 catch P2002 → ~50% flaky。

- ⚠️ **Prisma 7 + adapter-pg 下 P2034 现为 `DriverAdapterError`（`code` undefined）** → 只查 `code === 'P2034'` 会漏。检测要兼容两形态。
- **实证锚**：旧仓 #165。优先仍走 P1（多数 case 用 affected-count，不碰 Serializable）。

### P4 — transactional outbox：`publish(tx, …)` 同 tx 原子

跨 ctx 异步事件经 outbox：`publish(client, eventType, payload)` —— **caller 显式传 tx client**，让事件行与业务状态写共享同一 `$transaction`，任一步失败整体回滚（含事件行）。port shape 不泄露 Prisma 类型。

- **何时用**：状态转换需通知其他 ctx（R3 async，per catalog）。
- **实证锚**：004 三事件（`auth.account.deletion-requested` 等，旧仓 #198）；005 `auth.device.revoked`（旧仓 #201）；shape → ADR-0033。

### P5 — scheduler 每行独立 tx（每行自持 tx，单行失败不连坐）+ 谓词互斥

批扫多行（`take:100` 偏索引）后**逐行独立 `$transaction`** —— 单行失败被隔离，不连坐 sibling；与并发用户操作（如 cancel）的互斥靠**谓词互斥 + 行写锁**（双方 `where` 谓词不相交 → 至多一个命中）。

- **实证锚**：004 `anonymize-frozen-accounts.scheduler.ts`（每行独立 tx + 与 cancel 互斥，freezeUntil `<=now` vs `>now`，旧仓 #198）。

### P6 — 外部 I/O = split-tx（禁 tx 内持锁等 HTTP）

涉及外部 API（第三方验证等）：**TX1** 存 PENDING → **tx 外**调外部（HTTP 不可在 tx 内持锁）→ **TX2** 标结果（成功/失败）。

- **何时用**：external provider 调用、长耗时 I/O。
- **实证锚**：`alert/dispatch-push-deliveries.usecase.ts`（扫 PENDING → tx 外调 push gateway → conditional `updateMany` 标态 + 有限重试 + sweep 兜底）；`ideation/clarify-turn.usecase.ts`（tx 外检索）；`chat/send-message.usecase.ts`（流式编排全程 tx 外，落库是流前/流后独立短写，[ADR-0055](../adr/0055-chat-ctx-sse-streaming-llm-provider.md)）。

### P7 — 悲观锁兜底（罕用）

仅当 affected-count（P1）表达不了的多行/复杂锁语义，才 `$queryRaw` `SELECT … FOR UPDATE` + interactive `$transaction`。**先尝 P1**。

- **跨行聚合不变性**（min/max cardinality、"组内至少一个 active"、计数约束等 = write skew）：**优先「单行塌缩」** —— 把聚合态反规范化到每组单行（`text[]`/`jsonb`/`count`）使不变性变成单行谓词 → 回到 P1 conditional UPDATE + affected-count（靠 EvalPlanQual 重检，无显式锁）。🔒 谓词必须纯落被锁单行（禁子查询/JOIN 他行）。schema 不可改时才 `FOR UPDATE` 锁**全组**（非仅目标行）。详见 [ADR-0046](../adr/0046-cross-row-invariant-concurrency.md)；实证锚 `portfolio/update-market-preference.usecase.ts`（单行 `active_markets` + min-1）。

### P8 — 跨 ctx 写 = 两段式 Inspect + Commit saga

跨 ctx 生命周期写：**状态判定（Inspect，只读）先于副作用、写（Commit）后于验证**，禁单 `upsert` use case（单 upsert = 绕码建号 0-day + frozen 误更新）。细则（R2 / 注释 / 护城河）→ [catalog](server-bounded-context-catalog.md)（不复述）。

- **实证锚**：`InspectAccountStatus*` + `Commit*`（R-4，旧仓 #160）。

## 2. 安全

### S1 — 反枚举：字节级折叠 + dummy-pad timing

失败分支对外**字节级一致**（剥 traceId 后 ProblemDetail 深等），不泄露"哪步失败 / 资源是否存在 / 归谁"。public 无 token 流额外**跑 dummy 哈希对齐时序**（constant-time pad，**非 wall-clock sleep**）防时序枚举。

- **何时用**：authed 凭据/码失败折叠、public 手机号/账号状态探测面、单资源归属（撤销 404）。
- **实证锚**：004 SendCancelDeletionCode 4-ineligible 静默 200 + dummy pad（旧仓 #198）；005 device 404「不存在 vs 跨账号」字节级一致（旧仓 #201）。

### S2 — HMAC constant-time 比较，禁 bcrypt 新代码

短时码 / token（6 位数字、refresh token）比较一律 **HMAC-SHA256 + constant-time compare**（复用 [ADR-0023](../adr/0023-sms-code-storage-hmac.md) secret）。新代码**禁 bcrypt**（慢哈希用于密码场景，码/token 不需要且拖慢时序面）—— 唯一例外：反枚举 dummy timing pad（见 § S1），bcrypt 在那里只作定耗时 padding、不哈希任何码/token。

- **实证锚**：001 sms-code store / 004 deletion-code store（HMAC，旧仓 #198）；ADR-0023。

### S3 — PII：AES-GCM 加密 + 唯一 hash 防占位 + 终态解密 + 掩码

敏感 PII（身份证号 / 银行卡号等）**AES-GCM 加密存**；对需唯一性的字段额外存**确定性 hash + 唯一约束**防多账号占用同一身份；**仅终态才解密** + 对外**掩码**返回。

- **何时用**：敏感个人信息持久化。
- **实证锚**：暂无（mono 尚无 PII 加密字段落地）。

## 3. vendor 配置

### V1 — 新 vendor 配置镜像 `sms.config.ts` 范式

新 vendor（SMS / 推送 / OSS / LLM 等）配置：zod **discriminated union**（按 provider 分支）+ boot 时 `.parse()` 兜底，缺项 / 形状错在启动期红而非首次调用时。⚠️ **boot healthy ≠ cred 有效**（`.parse()` 只校验非空 / 形状，不校验可用性）。加配置项的落点清单走 `config-add` skill / `.claude/rules/config-env-sync.md`。

## 4. 改结构 / 换调用形态前三问（缺一条 = 在打补丁）

🚨 **注释里的 `🚫` / `MUST NOT` 是针对某次具体事故的禁令，NOT 解空间的边界。** 当成边界就会在错误前提里找优化，典型形状是**给一个不该发生的操作加缓存 / 游标 / 跳过判据** —— 正解是删掉那个操作。发现自己在设计这类东西时，**MUST** 先回头问「这个操作本身该不该发生」。

1. **先数调用方、再读注释**（顺序反了必错）：`rg -n '<符号>' apps/server/src --glob '!*.spec.ts'`，把数字写进回复。2026-08-23 实证：`SyncOptionContractUseCase.run` 只有 **1** 个调用方，而注释语气暗示的耦合面大得多。
2. **逐条判禁令射程**：对每条 `🚫` 写出「它约束 X / 我要做 Y / 是否重合」。同日实证：「不许给『工作集选择』开第二个口子」约束的是给 `DimensionJobPayload` 加字段，直调 use case 本体根本不过那条路径 ⇒ 够不到。
3. **找同仓已做对的对称样本**（最强信号常在同一目录）：同日实证：`SyncOptionSnapshotUseCase` 早已是 `run()` 薄适配 + public `collect(...)` 本体两层，而 `SyncOptionContractUseCase` 的本体仍 private —— 对称样本直接给出正解形状（维度采集本体的分层细则见 `marketdata/marketdata-sync.queue.ts` 头注）。

## 5. impl 期 stop-signals

→ [`.claude/rules/implement-task-closure.md`](../../.claude/rules/implement-task-closure.md) § Stop signals（spec 歧义 / 新依赖 / 不可逆 op / 改动溢出本 feature）。
