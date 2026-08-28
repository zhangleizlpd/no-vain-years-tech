---
paths:
  - 'apps/server/src/**/*.usecase.ts'
  - 'apps/server/src/**/*.service.ts'
  - 'apps/server/src/**/*.scheduler.ts'
---

# Server 实现 guardrails（path-triggered，改 server impl 文件自动加载）

> 🚨 **CRITICAL — 写 server use case / service / scheduler 时严守。** 详版 + 实证锚 + 反模式见 [`docs/conventions/server-impl-playbook.md`](../../docs/conventions/server-impl-playbook.md)（单源，本 rule 不复述）。

**起手对照 Golden Sample**（文件头 `// GOLDEN SAMPLE` banner）：简单单 ctx CRUD → `account/update-display-name.usecase.ts`；跨 ctx 编排 → `auth/phone-sms-auth.usecase.ts`（+ `account/commit-phone-login.usecase.ts`）。分层 + negative 标注见详版 § Golden Sample。

> **全量样板索引（跨 task kind / 含 mobile）→ [golden-sample-registry](../../docs/conventions/golden-sample-registry.md)**（「task kind → 样板文件」单一索引）。

## 改结构 / 换调用形态前（三步，缺一条 = 在打补丁）

> 🚨 **CRITICAL —— 注释里的 `🚫` / `MUST NOT` 是针对某次具体事故的禁令，NOT 解空间的边界。** 发现自己在给一个不该发生的操作加缓存 / 游标 / 跳过判据时，**MUST** 先回头问「这个操作本身该不该发生」。

**先数调用方**（`rg -n '<符号>' apps/server/src --glob '!*.spec.ts'`，数字写进回复）→ **逐条判禁令射程** → **找同仓已做对的对称样本**。实证与展开见详版 § 4。

## 并发 / 事务

- **单行状态转换 = conditional UPDATE + affected-count**（`updateMany where {id,<前置>}` → `count===1` won / `0` lost），READ COMMITTED。**NEVER** 单行上 `SELECT … FOR UPDATE` / Serializable（偏索引 SSI 假冲突，见详版 P2）。
- **并发 insert 确需 Serializable 时**：catch **P2002 + P2034 双形态**（只 catch P2002 会 flaky，见详版 P3）；⚠️ Prisma 7+adapter-pg 下 P2034 = `DriverAdapterError`（code undefined），检测要兼容。
- **outbox 事件**：`publish(tx, eventType, payload)` —— caller 传 tx，事件行与状态写**同 `$transaction`**，任一失败回滚。
- **scheduler**：批扫后**逐行独立 tx**（单行失败隔离）；与并发用户操作互斥靠谓词互斥 + 行写锁。
- **外部 I/O**：split-tx（TX1 PENDING → tx 外调 HTTP → TX2 标结果），**NEVER** tx 内持锁等 HTTP。
- **跨 ctx 写**：两段式 Inspect（读）+ Commit（写），**禁单 upsert**；护城河/传播细则见 [catalog](../../docs/conventions/server-bounded-context-catalog.md) + [`server-bounded-context-decision.md`](server-bounded-context-decision.md)。

## 安全

- **反枚举**：失败分支字节级一致折叠（剥 traceId 后深等）；public 无 token 流跑 **dummy-hash constant-time pad**（非 wall-clock sleep）。
- **哈希**：码/token 比较用 **HMAC-SHA256 constant-time**（ADR-0023），**NEVER bcrypt** 新代码（唯一例外：反枚举 dummy timing pad 见上 §反枚举，bcrypt 在那里只作定耗时 padding、不哈希任何码/token）。
- **PII**：AES-GCM 加密存 + 唯一 hash 防占位 + 终态才解密 + 掩码返回。

## 本地验证 & vendor 配置

- **本地跑 server IT / smoke / export-openapi 的命令矩阵与「红得像代码坏了其实是环境」的假红分类** → [`docs/conventions/local-verification.md`](../../docs/conventions/local-verification.md)（canonical，**本 rule 不复述**；无需任何 env 前缀，「必骗人」档由 PreToolUse hook 在命令时刻硬拦）。
- **新 vendor 配置范式** → 详版 § 3 V1（zod discriminated union + boot `.parse()`；boot healthy ≠ cred 有效）。
