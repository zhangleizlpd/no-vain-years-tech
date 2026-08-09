---
paths:
  - 'specs/**/spec.md'
  - 'apps/server/src/**/*.usecase.ts'
  - 'apps/server/src/**/*.module.ts'
---

# Server Bounded Context 决策（path-triggered，触及 server use case / module / spec 自动加载）

## 硬性规则

**改 / 新建 server use case / module / spec 前必读**：[`docs/conventions/server-bounded-context-catalog.md`](../../docs/conventions/server-bounded-context-catalog.md) — 3 传播规则 + 7 决策问题（已实装清单靠代码派生，per ADR-0034 sunset）。

## 简版决策路径（catalog.md 是详版权威）

1. **Q1**：use case 直改某 context 核心表（`account` / `credential` 等）row state? → 放该表所属 context (`account` / `security` / `auth` / `portfolio` 之一)。数据 = 贫血 Prisma row（无充血 aggregate class,per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）
2. **Q2**：编排多 context user-facing 流程? → 放 `auth/`（编排层）
3. **Q3**：纯 platform infra (token / pwd hash / generic crypto)? → 放 `security/`
4. **Q4**：完全新业务领域? → **STOP，走 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) sunset trigger 评估新 bounded context**
5. **Q5-Q7**（跨 ctx 传播）：
   - callee fail rollback caller? → **R2 CROSS-CTX-SYNC** (同 tx)；编排同请求内读+写 callee 生命周期 → DI callee 的 use case（读半段 = `Inspect*UseCase` 只读 / 写半段 = `Commit*UseCase`,**两段式委托** per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) §3a）
   - side-effect notification? → **R3 CROSS-CTX-ASYNC** (Outbox)
   - **独立**只读查询（非编排,caller 只为自己的 response 读 callee 数据）? → SecurityModule 共享读服务 OR Outbox replay 物化视图，**禁** cross-ctx use case 直 DI（与上面编排读区分:编排读是 R2 同请求驱动 callee 生命周期,走 `Inspect*UseCase`）

## 跨上下文注释（R-6 探针机器强制 / ADR-0034 Stage C）

按规范在**跨 ctx 注入点（构造器 DI 参数）上方**写注释（不是 import 上方 —— Golden Sample `auth/phone-sms-auth.usecase.ts` 把注释挂注入点，因为注入参数才是行为耦合点）：

- `// CROSS-CONTEXT-SYNC: <reason>` (R2) —— **MUST**：跨业务 ctx 注入 UseCase/Service 缺此注释 → `scripts/checks/check-server-moat.ts` 拒（lefthook + CI）
- `// CROSS-CONTEXT-READ: <data scope + 只读>` (Q7-B 临时路径) —— **MUST**：跨 ctx `prisma.<otherTable>.find*` 缺此注释 → 探针拒；跨 ctx **写**永远禁（无逃生口）
- `// CROSS-CONTEXT-ASYNC: <event-type>` (R3) —— **SHOULD**：标在 Outbox `publish(...)` 调用上方；无跨 ctx import 可锚，探针不扫，靠 CR 引导

Platform infra 例外（`PrismaService` / `REDIS_CLIENT` / `ProblemDetailFilter` 等从 `SecurityModule` export 的 base layer infra）— 无注释要求，per [ADR-0041](../../docs/adr/0041-server-common-directory-policy.md)。

## 新 use case ship 必带

1. **spec.md `modules:` frontmatter** 与 use case 物理 context（`apps/server/src/<ctx>/`）一致
2. cross-context import — 注释齐全（`check-server-moat` probe 强制）
3. tasks.md 对应 task `[X]` 翻

## 不该用本文件 path 触发的场景

- 修改 `apps/mobile/`、`packages/`、根级 config — 与 server bounded context 无关
- spec.md 改 frontmatter 字段（如 `status` 翻 `draft → implementing`）— 改单字段不触发新 use case 评估
- 修 use case bug fix（不动 cross-context 边界）— catalog 不需要改，但仍建议扫一眼确认未踩雷
