---
paths:
  - 'specs/**/spec.md'
  - 'apps/server/src/**/*.usecase.ts'
  - 'apps/server/src/**/*.module.ts'
---

# Server Bounded Context 决策（path-triggered，触及 server use case / module / spec 自动加载）

## 硬性规则

**改 / 新建 server use case / module / spec 前必读**：[`docs/conventions/server-bounded-context-catalog.md`](../../docs/conventions/server-bounded-context-catalog.md) — 3 传播规则 + 7 决策问题（已实装清单靠代码派生，per ADR-0034 sunset）。实现期 guardrail（并发 / 事务 / 安全 / 改结构前三问）→ [`docs/conventions/server-impl-playbook.md`](../../docs/conventions/server-impl-playbook.md)。

## 简版决策路径（catalog.md 是详版权威）

1. **Q1**：use case 直改某 context 核心表 row state? → 放该表的 **owner ctx**（真相源 = `scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP`，接新表必先登记）。数据 = 贫血 Prisma row（无充血 aggregate class,per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）
2. **Q2**：编排多 context user-facing 流程? → 放**发起该流程的业务域** ctx（账户域 = `auth/`；其它域 = 该域自身，eslint `boundaries` 单向白名单决定谁能 import 谁）
3. **Q3**：平台基座 (DB / cache / JWT / filter / outbox)? → `security/`；跨 ctx 共享 vendor I/O 适配器 → `integrations/`（ADR-0058）
4. **Q4**：完全新业务领域? → **STOP，写新 ctx ADR**（7Q 逐条 + 异质职责；先例 ADR-0052/0055/0057/0062）并同 PR 登记 eslint `boundaries/elements` + moat `BUSINESS_CTX` / `MODEL_OWNERSHIP`
5. **Q5-Q7**（跨 ctx 传播）：
   - callee fail rollback caller? → **R2 CROSS-CTX-SYNC** (同 tx)；编排同请求内读+写 callee 生命周期 → DI callee 的 use case（读半段 = `Inspect*UseCase` 只读 / 写半段 = `Commit*UseCase`,**两段式委托** per [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) §3a）
   - side-effect notification? → **R3 CROSS-CTX-ASYNC** (Outbox)
   - **独立**只读查询（非编排,caller 只为自己的 response 读 callee 数据）? → 本地副本（Outbox replay 物化视图）> `PrismaService` 只读直查 + `CROSS-CONTEXT-READ` > **强一致同步读注入 callee 导出的 port token + interface**（非 use case；注入点标 `CROSS-CONTEXT-SYNC`，先例 optionsdesk → marketdata `TRADING_CALENDAR_PORT`）；**禁** 直 DI 跨 ctx use case

## 跨上下文注释（R-6 探针机器强制 / ADR-0034 Stage C）

按规范在**跨 ctx 注入点（构造器 DI 参数）上方**写注释（不是 import 上方 —— Golden Sample `auth/phone-sms-auth.usecase.ts` 把注释挂注入点，因为注入参数才是行为耦合点）：

- `// CROSS-CONTEXT-SYNC: <reason>` (R2) —— **MUST**：跨业务 ctx 注入 UseCase/Service/port 缺此注释 → `scripts/checks/check-server-moat.ts` 拒（lefthook + CI）
- `// CROSS-CONTEXT-READ: <data scope + 只读>` (Q7-B 临时路径) —— **MUST**：跨 ctx `prisma.<otherTable>.find*` 缺此注释 → 探针拒；跨 ctx **写**永远禁（无逃生口）
- `// CROSS-CONTEXT-ASYNC: <event-type>` (R3) —— **SHOULD**：标在 Outbox `publish(...)` 调用上方；无跨 ctx import 可锚，探针不扫，靠 CR 引导

平台层（`security/` 基座、`integrations/` vendor 适配器）无注释要求；ship 清单（spec `modules:` ↔ 物理 ctx / 注释 / tasks `[X]`）见 canonical § 维护流程。

## 不该用本文件 path 触发的场景

- 修改 `apps/mobile/`、`packages/`、根级 config — 与 server bounded context 无关
- spec.md 改 frontmatter 字段（如 `status` 翻 `draft → implementing`）— 改单字段不触发新 use case 评估
- 修 use case bug fix（不动 cross-context 边界）— catalog 不需要改，但仍建议扫一眼确认未踩雷
