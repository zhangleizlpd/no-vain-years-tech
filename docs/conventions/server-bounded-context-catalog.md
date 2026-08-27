# Server Bounded Context Operation Catalog

> 跨 context 操作的传播规则（R1–R3）+ 决策路径（7Q）。决策逻辑是 evergreen 权威；**已实装 operation 清单不手维护**，靠代码派生（见 § Operation Catalog，per [ADR-0034](../adr/0034-auth-account-operation-catalog.md) sunset）。动机与「位置选错 / side effect 漏 / 传播方式选错」三类雷见 ADR-0034 Context；path-triggered 摘要在 `.claude/rules/server-bounded-context-decision.md`。

## 3 传播规则

### R1 — SAME-CTX (intra-context DI)

**场景**：use case 内部业务调同 context 的另一个 use case / `*.rules.ts` 纯函数 / 直注 `PrismaService` 读写自己的表（无 repository port,per ADR-0043）。

**实现**：直接 `@Inject()` 或 import；无注释要求。

```ts
// account/update-display-name.usecase.ts (R1: 同 ctx 自己的表 → 直注 PrismaService,无 repository port)
@Injectable()
export class UpdateDisplayNameUseCase {
  constructor(private readonly prisma: PrismaService) {}
  // 直查/写自己 ctx 的 account 表 (this.prisma.account.*),贫血 row + *.rules.ts 纯函数,无注释
}
```

### R2 — CROSS-CTX-SYNC (orchestration, same tx)

**场景**：编排型 use case 跨 context 调用 callee，且 caller 失败时**必须** rollback callee（事务一致性强需求）。

**实现**：编排型 use case 放**发起该流程的业务域** ctx（账户域 = `auth/`；投资域等其它域 = 该域自身 ctx —— 谁能 import 谁由 `apps/server/eslint.config.mjs` `boundaries` 单向白名单决定），跨业务 ctx 的**构造器注入参数上方 必须（Must）** 加 `// CROSS-CONTEXT-SYNC:` 注释 —— 注入点 = 行为耦合点，R-6 探针 `scripts/checks/check-server-moat.ts` 机器强制（缺则 lefthook + CI 拒；import 上方 / 调用处的注释不被探针采信，per [ADR-0034](../adr/0034-auth-account-operation-catalog.md) § 落地演进路径 Stage C）：

编排层**不碰** `tx.<otherTable>.*`（护城河，per [ADR-0043](../adr/0043-server-flat-module-paradigm.md) § 5）—— 委托 callee 的 UseCase；callee 自持 tx 写自己的表 + 发自己的 event。必要时拆两段（Inspect 读 + Commit 写，per ADR-0043 § 3a）：

```ts
// auth/phone-sms-auth.usecase.ts (编排层,零 tx.account.*)
constructor(
  // CROSS-CONTEXT-SYNC: auth → account 落地登录/注册 (两段式 Saga) —— 注释挂注入点 (探针强制处)
  private readonly inspectAccountStatus: InspectAccountStatusUseCase,
  private readonly commitPhoneLogin: CommitPhoneLoginUseCase,
) {}
// ...
const inspection = await this.inspectAccountStatus.execute(phone); // 第1段: 只读, 反枚举分支
// ...auth 自己校验短信码 (必须夹在读与写之间)...
const { accountId } = await this.commitPhoneLogin.execute(phone); // 第2段: account 自持 tx 写

// account/commit-phone-login.usecase.ts (callee 写自己的表 R1 + 发自己的 event R3)
await this.prisma.$transaction(async (tx) => {
  const created = await tx.account.create({ ... });
  // CROSS-CONTEXT-ASYNC: auth.account.created → 下游消费方
  const payload = buildAccountCreatedEvent(created.id, phone, created.createdAt); // 零-class builder
  await this.outboxPublisher.publish(tx, ACCOUNT_CREATED_EVENT_TYPE, payload);
});
```

**判断**：99% 的 cross-context call **不是** R2。只有「业务正确性要求 caller / callee 共享 tx」才走 R2 — auto-create-or-get / 同步两表 update 等。

### R3 — CROSS-CTX-ASYNC (default for side effects via Outbox)

**场景**：side effect / 通知 / audit / 风控 / search reindex / push notification — 一切 caller 不需要等 callee 结果的 cross-context 通信。

**实现**：通过 `OutboxPublisher.publish(tx, eventType, data)` 写 outbox event。trace_id / occurred_at / event_version / producer_context 由 publisher 自动封 envelope（per ADR-0033）。caller 上方 **建议（Should）加注释**：

```ts
// account/change-phone.usecase.ts (决策示例,未实装; account 改自己的表,直注 PrismaService)
await this.prisma.$transaction(async (tx) => {
  await tx.account.update({ where: { id: accountId }, data: { phone: newPhone } });
  // CROSS-CONTEXT-ASYNC: account.phone-changed → security 撤旧 session + audit 留痕
  await this.outboxPublisher.publish(tx, 'account.phone-changed', { accountId, newPhone });
});
```

**Default**：任何「需要通知其他 context」的场景 default 走 R3。R2 是 R3 的退化版本（仅当事务一致性强需求）。

### Platform infra 例外

`PrismaService` / `REDIS_CLIENT` / `ProblemDetailFilter` / `FormValidationException` 等从 `security/` export 的 **不是** cross-context business call，是 **platform base layer** infrastructure（per [ADR-0041](../adr/0041-server-common-directory-policy.md)）；跨 ctx 共享的 vendor I/O 适配器（OSS / LLM / 推送 gateway 等）归 `integrations/`（per [ADR-0058](../adr/0058-server-integrations-layer.md)）。业务 ctx import / 注入这两层**不需要** R2/R3 注释（探针只扫业务 ctx 之间）。

判断标准：被 import 的 symbol 是「业务 use case（含其调的 `*.rules.ts` 纯函数）」还是「DB client / cache client / 通用 exception / 框架 wrapper / vendor 适配器」。后者无注释要求。

## LLM 决策树（7 questions）

新 use case 起手 `/speckit-specify` 或 `/speckit-plan` 之前跑一遍，按序问、命中即停：

1. **Q1** 本 use case 直接改某 context 核心表 row 的 state？（贫血 Prisma row，无充血 aggregate class，per ADR-0043）→ **放该表的 owner ctx**（真相源 = `scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP`；接新表必先登记 owner，否则探针红）。否则 Q2。
2. **Q2** 本 use case 是编排多 context 共同完成 user-facing 业务流程？（e.g. login = verify code + create-or-get account + issue tokens）→ **放发起该流程的业务域 ctx**（账户域 = `auth/`；其它域 = 该域自身），内部跨 ctx call 按 Q5–Q7 区分 R2/R3。否则 Q3。
3. **Q3** 纯平台基座（DB / cache / JWT / filter / outbox / 通用 crypto）？→ **`security/`**（per ADR-0041）；跨 ctx 共享的 vendor I/O 适配器 → **`integrations/`**（per ADR-0058）。否则 Q4。
4. **Q4** 引入完全新业务领域，现有 ctx 都不沾？→ **STOP，写新 ctx ADR**：7Q 逐条回答 + 「落进现有 ctx 会吃进哪些异质职责」（先例 [ADR-0052](../adr/0052-alert-bounded-context.md) alert / [ADR-0055](../adr/0055-chat-ctx-sse-streaming-llm-provider.md) chat / [ADR-0057](../adr/0057-ideation-bounded-context.md) ideation / [ADR-0062](../adr/0062-optionsdesk-bounded-context.md) optionsdesk），并在同 PR 登记 `apps/server/eslint.config.mjs` `boundaries/elements` + moat `BUSINESS_CTX` / `MODEL_OWNERSHIP`。否则 Q5。
5. **Q5**（只在跨 ctx call 时问）callee 失败必须 rollback caller？→ **R2 CROSS-CTX-SYNC**：同 tx + **必须** `// CROSS-CONTEXT-SYNC: <reason>` 注释（挂注入参数上方，探针强制）。否则 Q6。
6. **Q6**（只在跨 ctx call 时问）调用是 side-effect notification（audit / SMS push / search reindex / 撤 session / ...）？→ **R3 CROSS-CTX-ASYNC**：Outbox publish + 建议 `// CROSS-CONTEXT-ASYNC: <event-type>` 注释。否则 Q7。
7. **Q7**（只在**独立**跨 ctx 读时问 —— 非编排，caller 只为自己的 response 读 callee 数据）：
   - **A. 优先**：调 caller 自己 ctx 已 sync 进来的本地副本（典型 = Outbox event replay 维护的物化视图）
   - **B. 临时**：`PrismaService` 直查 callee 表 —— 仅限**只读** + 标 `// CROSS-CONTEXT-READ:`（探针强制）
   - **C. 禁**：standalone 跨 ctx use case 直 `@Inject()`
   - **D. 强一致同步读**：注入 callee 导出的 **port token + interface**（非 use case：不写表、无生命周期），注入点标 `// CROSS-CONTEXT-SYNC:`；先例 optionsdesk → marketdata `TRADING_CALENDAR_PORT` / `REALTIME_QUOTE_PORT`（ADR-0062）
   - **例外**：R2 编排（同请求读+写 callee 生命周期，如 phone-sms-auth）走 callee 的 `Inspect*UseCase` 只读半段（两段式委托，per ADR-0043 §3a）—— **不**在 C 禁列
     都不是 → 回 Q5（跨 ctx call 必走 sync or async 之一）。

### 决策树死角

- **同时是 R2 + R3 的 case** — R2 写 + R3 publish 归**被调 context 自己的 use case**（高内聚生命周期委托，per [ADR-0043](../adr/0043-server-flat-module-paradigm.md) § 3a）：`CommitPhoneLoginUseCase`（account ctx）在 `$transaction` 内 find-or-create（R2，account 写自己的表）+ `outboxPublisher.publish('auth.account.created')`（R3，account 发自己的事件）。编排层 `auth` 不碰 `tx.account.*`，只委托。注意反枚举时序需求时 R2 要拆**两段式**（`InspectAccountStatusUseCase` 只读 + `CommitPhoneLoginUseCase` 写），见 ADR-0043 § 3a。
- **跨 ctx 读做决策**（caller 校验前需 callee 状态）— 走 callee 的只读 `Inspect*UseCase`（R2 的读半段，返回贫血 discriminated 状态），**不**直 `prisma.<otherTable>` 读（护城河）。这是 Q7 的强一致实时版（Q7-A 物化视图是最终一致版）。
- **跨 ctx 但不在 use case 层** — 比如 Guard / Filter 跨 module 引用。这是 platform infra 例外的扩展场景，看 [ADR-0032](../adr/0032-backend-bounded-context.md) 实装注 — guards/filters 大多归 `security/` 或 `account/`（扁平后无 `web/` 层,per ADR-0043 § 1）。

## Operation Catalog

> **已实装 registry 表已 sunset**（per [ADR-0034](../adr/0034-auth-account-operation-catalog.md) `sunset_trigger`：跨 ctx 操作 > 30 entries → 转 code-derivation；2026-06-02 触发）。「有哪些 ctx / operation / 跨 ctx 传播」不再手维护，靠代码派生：
>
> - **ctx 清单**：`ls -d apps/server/src/*/`；业务 ctx 集合 = `apps/server/eslint.config.mjs` `boundaries/elements` ∩ `scripts/checks/check-server-moat.ts` `BUSINESS_CTX`（`security` / `integrations` 是平台层，不算）
> - **operation + context**：`ls apps/server/src/<ctx>/*.usecase.ts`（文件名 = operation，目录 = context；平台层为 `*.service.ts`）
> - **跨 ctx 传播面**：`grep -rn 'CROSS-CONTEXT-' apps/server/src --include='*.ts'`（SYNC / READ / ASYNC；探针 `check-server-moat.ts` 强制，规则见 § R2 / § R3 / § 维护流程）
> - **provenance**：`git log --follow <usecase>`
>
> 本节只保留**决策逻辑**（上方 3 传播规则 + 7Q 决策树）+ 下方决策示例。

### 决策示例（未实装）

| Operation         | Context               | Predicted Propagation                                                     |
| ----------------- | --------------------- | ------------------------------------------------------------------------- |
| `change-phone`    | account               | **R3** → `account.phone-changed`（→ security 撤旧 session + audit 留痕）  |
| `verify-realname` | account               | **R3** → `account.realname-verified`（→ notification 发成功短信 + audit） |
| `create-note`     | **新 context** `pkm/` | Q4 → 触发新 bounded context 评估                                          |

> **预测常错，以实装为准（004 校正实例）**：anticipated `freeze-account`（预测 account 自发 **R3** `account.frozen`）实装时校正为 —— 冻结由 auth 编排 `delete-account` 发起，落 **R2-sync**（auth 持 tx 调 `account.commit-account-freeze` + `security.revoke-all-refresh-tokens`，FR-S04 同 tx 原子撤 token）+ **R3** `auth.account.deletion-requested`。

## 维护流程（PR review check）

新 use case ship 时，PR 必同时改：

1. **`spec.md` `modules:` frontmatter** — 与 use case 实际落地的物理 context（`apps/server/src/<ctx>/`）一致（CR 人工核，无机器闸）
2. **use case 实装** — 跨业务 ctx 注入参数上方 `// CROSS-CONTEXT-SYNC:`（R2，**Must**，探针硬拒）；跨 ctx 只读经 `PrismaService` 时 `// CROSS-CONTEXT-READ:`（Q7-B，**Must**，探针硬拒）；跨 ctx **写**永远禁（无逃生口）；Outbox publish 上方 `// CROSS-CONTEXT-ASYNC:`（R3，**Should**，探针不扫，CR 引导不阻 merge）—— per [ADR-0034](../adr/0034-auth-account-operation-catalog.md) § 落地演进路径 Stage C
3. **tasks.md** — 对应 task ship 后 `[X]` 翻（`.claude/rules/implement-task-closure.md`）

## 参考

- [ADR-0032](../adr/0032-backend-bounded-context.md) bounded context 拆分本体（决策起源）
- [ADR-0033](../adr/0033-outbox-cross-context-comm.md) Outbox envelope + trace_id（R3 实装基础）
- [ADR-0034](../adr/0034-auth-account-operation-catalog.md) 本目录的决策记录
- [ADR-0041](../adr/0041-server-common-directory-policy.md) `src/common/` 不引入 / platform infra 进 `security/`
- [ADR-0058](../adr/0058-server-integrations-layer.md) `integrations/` 准入
- [05-22 bounded context governance plan](../private/plans/2026-05/05-22-server-bounded-context-governance.md)（本机私有，未公开）— O2 work unit 落地的 plan 入口
