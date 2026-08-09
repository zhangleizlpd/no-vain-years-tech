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

## 并发 / 事务

- **单行状态转换 = conditional UPDATE + affected-count**（`updateMany where {id,<前置>}` → `count===1` won / `0` lost），READ COMMITTED。**NEVER** 单行上 `SELECT … FOR UPDATE` / Serializable（偏索引 SSI 假冲突，004 实证 72/100 假失败）。
- **并发 insert 确需 Serializable 时**：catch **P2002 + P2034 双形态**（只 catch P2002 → ~50% flaky）；⚠️ Prisma 7+adapter-pg 下 P2034 = `DriverAdapterError`（code undefined），检测要兼容。
- **outbox 事件**：`publish(tx, eventType, payload)` —— caller 传 tx，事件行与状态写**同 `$transaction`**，任一失败回滚。
- **scheduler**：批扫后**逐行独立 tx**（单行失败隔离）；与并发用户操作互斥靠谓词互斥 + 行写锁。
- **外部 I/O**：split-tx（TX1 PENDING → tx 外调 HTTP → TX2 标结果），**NEVER** tx 内持锁等 HTTP。
- **跨 ctx 写**：两段式 Inspect（读）+ Commit（写），**禁单 upsert**；护城河/传播细则见 [catalog](../../docs/conventions/server-bounded-context-catalog.md) + [`server-bounded-context-decision.md`](server-bounded-context-decision.md)。

## 安全

- **反枚举**：失败分支字节级一致折叠（剥 traceId 后深等）；public 无 token 流跑 **dummy-hash constant-time pad**（非 wall-clock sleep）。
- **哈希**：码/token 比较用 **HMAC-SHA256 constant-time**（ADR-0023），**NEVER bcrypt** 新代码（唯一例外：反枚举 dummy timing pad 见上 §反枚举，bcrypt 在那里只作定耗时 padding、不哈希任何码/token）。
- **PII**：AES-GCM 加密存 + 唯一 hash 防占位 + 终态才解密 + 掩码返回。

## 本地验证 & vendor 配置

- **本地跑 server IT / smoke / export-openapi 的 env 前缀、命令矩阵、以及「红得像代码坏了其实是环境」的四类失败** → [`docs/conventions/local-verification.md`](../../docs/conventions/local-verification.md)（canonical，**本 rule 不复述**）。缺 env 的那几档由 `scripts/pretooluse-local-verify-guard.sh` 在**命令执行时刻**硬拦并给出补齐后的命令 —— 因为这类坑发生在「跑命令」而非「改文件」，光靠 path-trigger 的规则捞不到。
- **新 vendor（SMS / 推送 / OSS 等）配置镜像 `sms.config.ts` 范式**：zod **discriminated union**（按 provider 分支）+ boot 时 `.parse()` 兜底。⚠️ boot healthy ≠ cred 有效（`.parse()` 只校验非空 / 形状，不校验可用性）。
