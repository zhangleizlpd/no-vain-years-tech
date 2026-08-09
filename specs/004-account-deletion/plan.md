---
feature_id: 004-account-deletion
spec_ref: ./spec.md
status: implemented
created_at: '2026-05-26'
updated_at: '2026-05-29'
adr_refs: ['0019', '0022', '0023', '0024', '0030', '0032', '0033', '0035', '0040', '0041', '0043']
context7_verified: []
---

# Implementation Plan: 004-account-deletion（注销 → 15 天冻结 → 撤销 / 匿名化）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `004-account-deletion` | **Master**: [`account-migration master`](../../docs/private/plans/2026-05/05-25-account-migration-master.md) → 批 C | **Engine**: [`p3`](../../docs/private/plans/2026-05/05-25-account-migration-p3-usecase-steps.md)

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per p3 §3）。

## Summary _(mandatory)_

004 = 账号注销全生命周期 5 UC 首次落地：①**SendDeletionCode**（authed：发 DELETE_ACCOUNT 码）②**DeleteAccount**（authed：验码 → ACTIVE→FROZEN（freezeUntil=now+15d）+ 撤全 token + 发 `AccountDeletionRequestedEvent`）③**SendCancelDeletionCode**（public：仅 FROZEN-in-grace 真发 CANCEL_DELETION 码，4 ineligible 静默 200 + dummy 哈希）④**CancelDeletion**（public：验码 → FROZEN→ACTIVE + 重发 token + 发 `AccountDeletionCancelledEvent`）⑤**AnonymizeFrozenAccount**（scheduler：grace 期满 FROZEN→ANONYMIZED + 撤 token + 发 `AccountAnonymizedEvent`）。范式 = ADR-0043 扁平贫血 + 单向 Moat。client（per clarify）= cancel-deletion 屏 + FROZEN 登录拦截 modal（delete-account 发起屏延后 settings shell）。

**bounded context**：**auth** 编排 4 个 user-facing/public UC（持多 ctx 事务，含 sms-code 验证）；**account** 持 3 个状态转换 Commit UseCase（freeze / cancellation / anonymization，conditional UPDATE）+ 状态转换 rules + 匿名化 scheduler；**security** 扩 `revokeAllForAccount` 收 tx client + 复用 token 签发/持久化。`account` / `account_sms_code` / `refresh_token` / `outbox_event` 表**已 db-pull，无 migration**（004 首次激活 `account_sms_code` 表）。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | Request | Response | trace FR |
|---|---|---|---|---|---|---|
| EP1 | POST | `/api/v1/accounts/me/deletion-codes` | **bearer** | 无 body | **204** / 401 / 429 / 503 | FR-S01, FR-S02, FR-S18, FR-S21 |
| EP2 | POST | `/api/v1/accounts/me/deletion` | **bearer** | `{ code: string }`（`@Matches(/^\d{6}$/)`，非法 → 400 `FORM_VALIDATION`） | **204** / 401 `INVALID_DELETION_CODE` / 400 / 429 | FR-S03~S06, FR-S18, FR-S19 |
| EP3 | POST | `/api/v1/auth/cancel-deletion/sms-codes` | none（public） | `{ phone: string }`（`@Matches(E.164)`，非法 → 422 `INVALID_PHONE_FORMAT`） | **200**（eligible/ineligible 字节级一致） / 422 / 429 / 503 | FR-S07, FR-S08, FR-S18, FR-S21 |
| EP4 | POST | `/api/v1/auth/cancel-deletion` | none（public） | `{ phone, code }`（缺字段 → 400） | **200** `LoginResponse{accountId,accessToken,refreshToken}` / 401 `INVALID_CREDENTIALS` / 422 / 400 / 429 | FR-S09~S12, FR-S18, FR-S19 |
| — | scheduler | （每日 cron，非 HTTP） | — | — | — | FR-S13~S16 |

- 路径：authed 删除流沿用 `/v1/accounts/me/*`（account-facing，镜像 002 `/me` profile）；public 撤销流用 `/v1/auth/cancel-deletion(/sms-codes)`（per clarify，FROZEN 无 token）。全局前缀 `api`。
- 错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter）；code = `INVALID_CREDENTIALS`（public 撤销 + 账号状态失败）/ `INVALID_DELETION_CODE`（**新增 1 个**，authed 删除码失败）/ `RATE_LIMITED` / `FORM_VALIDATION` / `INVALID_PHONE_FORMAT`（复用 001）/ `SMS_SEND_FAILED`。**FROZEN 登录 403 `ACCOUNT_IN_FREEZE_PERIOD` 已在 001，004 不改**。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（5 点写回）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；并发恰一/原子回滚/反枚举字节级/scheduler 隔离均专测（Testcontainers PG+Redis） |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 按此拆；三位一体同 1 PR |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 单向 `auth→account→security`；delete/cancel 由 **auth 持 tx** 委托 account.commitX(tx) + security.revokeAll(tx)（forward）；anonymize 在 account → security.revokeAll(tx)（forward），**不**调 auth（sms 码自然过期，避反向）；跨 ctx 注入点 `// CROSS-CONTEXT-SYNC`/`-ASYNC`；`check-server-moat.ts` 关 |
| V. 类型同步链 Nx-driven | ✅ | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval）→ mobile（cancel-deletion 屏 + FROZEN modal）；同 1 PR |

## Architecture Notes _(mandatory)_

### Bounded Context 落位（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)，ship 时新增 Operation 行）

| 操作 | context | 类型 | 跨 ctx | 备注 |
|---|---|---|---|---|
| `send-deletion-code` | **auth** | 编排 UseCase | R2 读 → `account.inspect-account-status-by-id`（ACTIVE 门槛） | authed；发 DELETE_ACCOUNT 码（DB `account_sms_code`） |
| `delete-account` | **auth** | 编排 UseCase（**持 tx**） | R2 写 → `account.commit-account-freeze`(tx) + `security.revoke-all-refresh-tokens`(tx)；R3 → outbox `account.deletion-requested` | authed；tx 内 markUsed(码) + freeze + 撤 token + 发事件 |
| `send-cancel-deletion-code` | **auth** | 编排 UseCase | R2 读 → `account.inspect-account-status`（FROZEN-in-grace 判定） | public；4 ineligible 静默 200 + dummy 哈希 pad |
| `cancel-deletion` | **auth** | 编排 UseCase（**持 tx**） | R2 写 → `account.commit-account-cancellation`(tx) + `security.persist-refresh-token`(tx)；R3 → outbox `account.deletion-cancelled` | public；conditional UPDATE + affected-count；tx 内 markUsed + unfreeze + 持久化新 token + 发事件 |
| `commit-account-freeze` | **account** | Commit UseCase（tx 参与） | — | conditional UPDATE `status ACTIVE→FROZEN, freezeUntil` WHERE status=ACTIVE（affected-count） |
| `commit-account-cancellation` | **account** | Commit UseCase（tx 参与） | — | conditional UPDATE `FROZEN→ACTIVE, freezeUntil=null` WHERE status=FROZEN AND freezeUntil>now |
| `commit-account-anonymization` | **account** | Commit UseCase（**持 tx**，scheduler 触发） | R2 写 → `security.revoke-all-refresh-tokens`(tx)；R3 → outbox `account.anonymized` | conditional UPDATE `FROZEN→ANONYMIZED` WHERE status=FROZEN AND freezeUntil<=now + phone=null + displayName=「已注销用户」+ previousPhoneHash |
| `anonymize-frozen-accounts`（scheduler） | **account** | Cron 调度 | 调 `commit-account-anonymization` 逐行 | 每日；批 100；每行独立 tx（REQUIRES_NEW 等价）；持续失败阈值 3 |
| `revoke-all-refresh-tokens`（扩） | **security** | 平台 infra | — | **加 tx-client 重载**：`revokeAllForAccount(accountId, now, tx?)` |

### Server side（ADR-0043 扁平贫血，文件平铺）

**新增（auth `apps/server/src/auth/`）**：

- `account-deletion.controller.ts`（`@Controller('v1/accounts')`，挂 JwtAuthGuard）：`POST me/deletion-codes`（EP1）+ `POST me/deletion`（EP2）
- `cancel-deletion.controller.ts`（`@Controller('v1/auth/cancel-deletion')`，public）：`POST sms-codes`（EP3）+ `POST`（EP4）
- `send-deletion-code.usecase.ts` / `delete-account.usecase.ts` / `send-cancel-deletion-code.usecase.ts` / `cancel-deletion.usecase.ts`（编排，见下「流」）
- `deletion-code.store.ts`（DB `account_sms_code`，PrismaService 直注，无 repository）：`issue(tx?, accountId, purpose, codeHash, expiresAt)` / `findActive(accountId, purpose, now)` / `markUsed(tx, codeId)`。HMAC-SHA256 hex（复用 ADR-0023 secret，与 `sms-code.store.ts` 同 hasher）
- `deletion-code.rules.ts`（纯函数 + 常量）：`CODE_TTL_MIN=10` / 复用 `generateSmsCode()`（6 位 CSPRNG）+ HMAC compare
- request DTO：`delete-account.request.ts`（`{ code }`）/ `send-cancel-code.request.ts`（`{ phone }`）/ `cancel-deletion.request.ts`（`{ phone, code }`）+ swagger
- 限流 named throttler config（`auth.module.ts`）+ public 端点的 phone-hash / IP 自定义 guard（镜像 `sms-phone-throttler.guard.ts`）

**新增（account `apps/server/src/account/`）**：

- `commit-account-freeze.usecase.ts` / `commit-account-cancellation.usecase.ts`（tx 参与：收 auth 传入的 tx client，conditional UPDATE 自己的 `account` 表，返回 affected-count 语义 `{ won: boolean }`）
- `commit-account-anonymization.usecase.ts`（**持 tx**：account 开 tx，UPDATE + `security.revokeAllForAccount(tx,...)` + `outbox.publish(tx, AnonymizedEvent)`）
- `anonymize-frozen-accounts.scheduler.ts`（`@Cron`：扫 `idx_account_freeze_until_active` 偏索引，批 100，逐行调 commit-anonymization，每行独立 tx；持续失败计数 + 阈值 3 升 ERROR）
- 3 个事件类型 + payload（`account-deletion-requested.event.ts` 等，镜像 `account-created.event.ts`）
- `account.rules.ts` **扩**：`canFreeze(a)` / `canCancelFromFrozen(a, now)` / `canAnonymize(a, now)` / `isFrozenInGrace(a, now)`（纯函数；`freezeUntil` 双作 grace deadline）；常量 `FREEZE_DURATION_DAYS=15` / `ANONYMIZED_DISPLAY_NAME='已注销用户'`

**修改既有（security `apps/server/src/security/`）**：

- `refresh-token.service.ts`：`revokeAllForAccount(accountId, now, tx?: TxClient)` 加可选 tx client 重载（tx 传则 `tx.refreshToken.updateMany`，否则 `this.prisma...`，行为不变）；`persist(accountId, rawToken, meta, tx?)` 同加 tx 重载（cancel 重发 token 入同 tx）
- outbox publisher：`producer_context` 参数化（当前 hardcode `'auth'`；account 发 AnonymizedEvent 应标 `'account'`）—— 加 publish 可选 `producerContext` 入参或按 eventType 推断

**修改既有（auth）**：

- `sms-gateway.port.ts`：`sendCode(phone, code, purpose?: SmsPurpose)` 加 purpose 区分；`aliyun-sms.gateway.ts` 按 purpose 选 templateCode（config 加 DELETE_ACCOUNT / CANCEL_DELETION 模板）；`mock-sms.gateway.ts` 同步
- `auth.module.ts`：注册 4 端点 controller/usecase + named throttler + 引入 account context 的 Commit UseCase（DI，跨 ctx 注入点带注释）

**新增依赖**：`@nestjs/schedule`（scheduler，当前未装）+ `ScheduleModule.forRoot()`（注册于 server root module 或 account module）

**流（编排，逐 UC）**：

1. **SendDeletionCode**（auth）：JwtAuthGuard 取 accountId → per-account+IP 限流 → `account.inspectAccountStatusById(accountId)` 非 ACTIVE → **401 `INVALID_CREDENTIALS`**（反枚举折叠）→ `generateSmsCode()` + HMAC → `deletion-code.store.issue(accountId, DELETE_ACCOUNT, hash, now+10min)` → `smsGateway.sendCode(phone, code, DELETE_ACCOUNT)` → **204**
2. **DeleteAccount**（auth，持 tx）：取 accountId → 限流 → `deletion-code.findActive(accountId, DELETE_ACCOUNT, now)` + HMAC compare（4 失败折叠 **401 `INVALID_DELETION_CODE`**）→ 开 `$transaction`（READ COMMITTED）：`markUsed(tx, codeId)` + `account.commitAccountFreeze(tx, accountId)`（conditional UPDATE，`won=false`→throw 回滚）+ `security.revokeAllForAccount(tx, accountId, now)` + `outbox.publish(tx, RequestedEvent)` → 204。任一步抛 → 整 tx 回滚（码未用、账号 ACTIVE、无事件）
3. **SendCancelDeletionCode**（auth，public）：phone 格式校验（422）→ per-phone-hash+IP 限流 → `account.inspectAccountStatus(phone)`：**eligible**（FROZEN ∧ freezeUntil>now）→ issue CANCEL_DELETION 码 + `sendCode(phone,code,CANCEL_DELETION)`；**4 ineligible** → `timingDefense.pad()`（dummy 哈希）→ 均 **200**（字节级一致，无 body 差异）
4. **CancelDeletion**（auth，public，持 tx）：phone 格式（422）→ 限流 → 预生成 tokens（sign access + gen refresh，纯函数）→ 开 `$transaction`：`account.commitAccountCancellation(tx, phone, now)`（conditional UPDATE `FROZEN→ACTIVE` WHERE freezeUntil>now，`won=false`→throw）+ `deletion-code.findActive+markUsed(tx)` + HMAC compare（失败 throw）+ `security.persist(tx, refreshHash, meta)` + `outbox.publish(tx, CancelledEvent)` → 200 `LoginResponse`。5 类失败折叠 **401 `INVALID_CREDENTIALS`**（phone-class 分支 `timingDefense.pad()`）
5. **AnonymizeFrozenAccount**（account scheduler）：cron → 扫偏索引 `status=FROZEN ∧ freezeUntil<=now` LIMIT 100 → 逐 id 调 `commitAccountAnonymization(accountId)`：每行独立 `$transaction`：捕获 `previousPhoneHash` → conditional UPDATE `FROZEN→ANONYMIZED, phone=null, displayName=「已注销用户」, freezeUntil=null` WHERE status=FROZEN AND freezeUntil<=now（`won=false`→skip 不计失败）+ `security.revokeAllForAccount(tx)` + `outbox.publish(tx, AnonymizedEvent, 'account')` → commit。领域拒绝/锁冲突 skip；其他异常计 failure，累计阈值升 ERROR

### 并发 / 事务策略（迁移翻车点，逐条实现约束）

> **核心决策（D2）**：mono **无 pessimistic lock 先例**，project MEMORY `prisma_serializable_p2002_and_p2034` 明确单行条件状态转换应 **READ COMMITTED + affected-count**（`FOR UPDATE` 在偏索引上触发 SSI 假冲突）。故 004 **不引 `SELECT…FOR UPDATE`**，用条件 UPDATE + affected-count 等价实现旧 Java「悲观锁」的恰一成功 + 互斥语义。spec 的「悲观锁」措辞 → 修正为行为（见下「spec 修正」）。

1. **状态转换 = conditional UPDATE + affected-count**：每个 commit 用 `tx.account.updateMany({ where: { id, status: <前置>, ...freezeUntil 谓词 }, data: {...} })` → `count===1`=won / `count===0`=lost（前置不满足 / 被并发抢先）。DB 行写锁在 UPDATE 期间天然 serialise 同行竞争。**5 并发同码** → 恰 1 个 `won=true`（其余 count=0 → 折叠失败）。
2. **撤销 ⟷ 匿名化互斥（FR-S16）= 谓词互斥 + 行写锁**：cancel 要 `freezeUntil>now`、anonymize 要 `freezeUntil<=now` —— 同一行两谓词**互斥**，至多一个 UPDATE 命中；行写锁保证先到者 flip status 后，后到者 WHERE status=FROZEN 不再匹配 → count=0。grace 边界（freezeUntil≈now）由 `>` / `<=` 严格划分 → **anonymize 恒赢**（边界归 `<=`）。无需 `FOR UPDATE`。
3. **原子性 + outbox 同 tx**：delete/cancel 的 markUsed + 状态写 + token 操作 + `outbox.publish(tx,...)` 全在 auth 持有的同一 `$transaction`；anonymize 的状态写 + `security.revokeAllForAccount(tx)` + publish 在 account 持有的同一 tx。任一步 throw → 整 tx 回滚（含事件行）。
4. **R2 同事务跨 ctx 写（D3）**：`security.revokeAllForAccount` / `persist` **加 tx-client 重载**，让 token 操作入 caller 的 tx（撤 token 失败回滚整请求，FR-S04/S10 原子性）。**三事件（Requested/Cancelled/Anonymized）发 outbox 供后续消费方**（R3，sink 本 feature out-of-scope）；token 撤销**不依赖**（不存在的）outbox 消费方。**未取 catalog 预设的 `freeze-account` R3-async**——因 spec 要 sync 原子撤 token 且消费方 out-of-scope（详 Open Decisions D3，留 gate review）。
5. **Serializable 不用**：单行条件 UPDATE 用 READ COMMITTED（默认）；不设 Serializable（避 SSI 假冲突 + 规避 Prisma 7 P2034 检测漏 bug，memory `prisma_serializable_p2002_and_p2034`）。无需外层 P2034 retry（无 Serializable）。
6. **sms 码消费在 PG-tx 内**：码在 DB `account_sms_code`，markUsed 与状态写**同 PG tx**（原子回滚，优于 001 Redis 码——见 D1）。
7. **反枚举 + timing**：public 撤销流（EP3/EP4）4/5 ineligible 分支 `timingDefense.pad()`（复用 auth `bcrypt-timing-defense.executor` 的 dummy 哈希，ADR-0023）对齐时序 + 响应字节级一致；authed 删除流（EP1/EP2）账号状态失败折叠 `INVALID_CREDENTIALS`、码失败折叠 `INVALID_DELETION_CODE`（4 子类彼此字节级一致）。**不**引 400ms wall-clock pad、**不**复刻 001 的 50ms 枚举 IT（那是 login 专属）。

### 限流配置（FR-S18，复用既有 throttler infra，加 per-UC named config）

| 端点 | per-IP | per-key | 实现 |
|---|---|---|---|
| send-deletion-code | `5/60s` | per-account `1/60s` | named `del-code-ip` + `del-code-account`（account 桶先消费，AccountIdThrottlerGuard 复用） |
| delete-account | `10/60s` | per-account `5/60s` | named `del-submit-ip` + `del-submit-account` |
| send-cancel-code | `5/60s` | per-phone-hash `1/60s` | named `cancel-code-ip` + 自定义 phone-hash guard（镜像 `sms-phone-throttler.guard.ts`，public 无 accountId） |
| cancel-deletion | `10/60s` | per-phone-hash `5/60s` | named `cancel-submit-ip` + phone-hash guard |

超限 → 429 + `Retry-After`。在 `auth.module.ts` 既有 `ThrottlerModule.forRootAsync` `throttlers: []` **新增** named 配置；限流在加载账号/发码之前消费（FR-S18）。

### Client side（per clarify：恢复闭环，无注销发起屏）

- **`packages/api-client`（Orval）**：server openapi 产出后 `nx affected -t generate` regen → typed `cancel-deletion` / `cancel-deletion/sms-codes` 调用（函数式 hook，非 class；axios 不删）。delete-account 端点也 regen（供后续 settings shell 消费），但本批不接 UI。
- **撤销注销屏**（`apps/mobile/app/(auth)/cancel-deletion.tsx`，port 旧 `cancel-deletion.tsx`）：手机号（路由参数预填 / 可手填）→ 请求撤销码 → 输 6 位码 → 提交 → 成功拿 `LoginResponse` → 路由进主页。RHF + zodResolver（Golden Sample 4 铁律，memory `rhf_form_standard_login_golden_sample`）。错误展示统一（FR-C05）。
- **FROZEN 登录拦截 modal**（改 `apps/mobile/app/(auth)/login.tsx` + `apps/mobile/src/auth/`）：login 调用收到 403 `ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`（001 server 已就位）→ 弹 modal：剩余冻结天数（`freezeUntil` 算）+「撤销注销」（跳 cancel-deletion，手机号路由参数）/「保持注销」（清 form 留登录）。
- **错误码映射**：`cancel-deletion-errors.ts`（port 旧）映射 401 `INVALID_CREDENTIALS` / 422 / 429 → 文案。
- **Metro `.js` 陷阱**：`apps/mobile` + `@nvy/api-client` 相对 import 一律 extensionless（memory `metro_web_cannot_resolve_js_extension_imports`，ESLint 已机械拦）。
- **测试分层**：表单逻辑 / 错误映射 / 剩余天数计算 → vitest logic-level；屏 render / modal / a11y / 路由 → Playwright Expo Web e2e（复用 `apps/mobile/e2e/_support/api-mock.ts`）。

### Cross-cutting

- **同步链**（Constitution V）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（api-client）→ mobile，**同 1 PR**。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 8 行（见上落位表）+ 标注 `account.deletion-requested` / `.deletion-cancelled` / `.anonymized` 三 R3 事件。
- **跨 ctx 注释**：auth→account.commitX 注入点 `// CROSS-CONTEXT-SYNC`；auth/account→security.revokeAll/persist 注入点 `// CROSS-CONTEXT-SYNC`；outbox.publish 上方 `// CROSS-CONTEXT-ASYNC: <event-type>`（`check-server-moat.ts` 关）。
- **反枚举不变性**：grep EP3/EP4 eligible vs ineligible 响应字节级一致；EP2 码失败 4 子类一致。

## Open Decisions Resolved（批 C 起手必决项 — ⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** sms 码存储 | Redis（001 phone-keyed 无 purpose）vs DB `account_sms_code` | **用 DB `account_sms_code` 表**（已 db-pull 无 migration，004 首个消费者）：purpose 隔离 + accountId + **markUsed 与状态写同 PG tx 原子** + 匿名化可处理。HMAC-SHA256（ADR-0023）。login 仍 Redis（求速）、删除用 DB（求原子）—— 两机制由 atomicity 需求区分，正合 spec | — |
| **D2** 并发原语 | pessimistic `FOR UPDATE` vs affected-count | **READ COMMITTED + 条件 UPDATE affected-count**（mono 无 FOR UPDATE 先例 + MEMORY 推荐；偏索引 SSI 假冲突规避）。谓词互斥 + 行写锁实现 cancel⟷anonymize 互斥。**与 spec「悲观锁」措辞冲突 → 修正 spec 为行为** | ⚠️ |
| **D3** token 撤销传播 | R2 同 tx sync vs R3 outbox async | **R2 sync**（扩 `revokeAllForAccount` 收 tx client）：spec 要 sync 原子撤 token（FR-S04/S10），且 outbox 消费方 out-of-scope。三事件仍发 outbox 供后续消费。**catalog 预设 `freeze-account` 为 R3-async** —— 偏离，因消费方未建。**若你倾向 R3：需先建 outbox 真消费方（超 004 scope）** | ⚠️ |
| **D4** scheduler | 新设施 | 装 `@nestjs/schedule` + `ScheduleModule` + `@Cron`（每日 03:00 Asia/Shanghai）；批 100；每行独立 tx（REQUIRES_NEW 等价）；失败阈值 3 升 ERROR。mono 首个 scheduler | — |
| **D5** sms 模板 | 单模板 vs 多 purpose | 扩 `SmsGateway.sendCode(phone, code, purpose)` + config DELETE_ACCOUNT / CANCEL_DELETION templateCode | — |
| **D6** 匿名化 sms 清理 | 硬删 DB 码行 vs 不删 | **不显式硬删**（避 account→auth 反向越界）：`account_sms_code` 行是**非 PII** 的 HMAC 哈希（+accountId+时间戳），`expiresAt` 过后 findActive 即忽略；匿名化 phone 置空已满足 PII 最小化，残留码行无害，过期码行清扫另行（out-of-scope）。**与 spec「硬删除 sms_code 行」冲突 → 修正 spec** | ⚠️ |
| **Perf 预算** | 4 端点 P95/P99 | EP1 `100/200` · EP2 `120/250`（含 tx：markUsed+freeze+撤 token+事件）· EP3 `120/250`（含 dummy pad）· EP4 `150/300`（含 tx：unfreeze+persist token+事件）；EP3/EP4 timing diff P95 ≤ 50ms（spec frontmatter SoT） | — |

**spec 修正（plan 揭示，已同步回 spec.md 保一致）**：D2「悲观锁/FOR UPDATE」→「并发裁决保证恰一成功（条件 UPDATE + affected-count）」；D6 匿名化「硬删除 sms_code 行」→「sms 码自然过期 + phone 置空」。

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) **auth 持多 ctx tx** 是新模式（vs `commit-phone-login` account 持单 ctx tx）—— 因 delete/cancel 须原子跨 sms-code(auth)+account+token(security)，仅 auth 能正向达三者，非过度设计。(2) **扩 `revokeAllForAccount` 收 tx client** 是 R2 同事务的必要接点，非违反。(3) **首个 scheduler + 首个 DB sms 码路径** 是 batch C 业务固有复杂度（注销生命周期 + 定时匿名化），非 over-engineering。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) | timing diff P95 |
| --- | ---: | ---: | ---: |
| `POST /api/v1/accounts/me/deletion-codes` | 100 | 200 | — |
| `POST /api/v1/accounts/me/deletion` | 120 | 250 | — |
| `POST /api/v1/auth/cancel-deletion/sms-codes` | 120 | 250 | ≤ 50ms |
| `POST /api/v1/auth/cancel-deletion` | 150 | 300 | ≤ 50ms |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（三位一体同 1 PR，per p3 §Step2；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Server]` security：`revokeAllForAccount` + `persist` 加 tx-client 重载 + 单测；outbox publisher `producerContext` 参数化 + 单测
- `[Server]` account（rules + commits）：`account.rules.ts` 扩 4 transition 纯函数 + 常量 + 单测 → `commit-account-freeze` / `commit-account-cancellation`（tx 参与，affected-count）+ 单测 → `commit-account-anonymization`（持 tx + security.revokeAll + outbox）+ 单测 → 3 event 类型
- `[Server]` account（scheduler）：装 `@nestjs/schedule` + `ScheduleModule` → `anonymize-frozen-accounts.scheduler.ts`（偏索引扫描 + 批 100 + 逐行 tx + 失败阈值）+ 单测
- `[Server]` auth（sms infra）：`deletion-code.store.ts`（DB account_sms_code，HMAC）+ `deletion-code.rules.ts` + 单测 → `sms-gateway.port` + aliyun/mock gateway 加 purpose + 单测
- `[Server]` auth（4 编排 UC）：`send-deletion-code` → `delete-account`（持 tx）→ `send-cancel-deletion-code`（dummy pad）→ `cancel-deletion`（持 tx）+ 各单测 → 2 controller + 3 request DTO + swagger → named throttler config + public phone-hash guard
- `[Server-IT]`（Testcontainers PG+Redis）：US1 发码（ACTIVE/非ACTIVE 反枚举）/ US2 冻结逐字段 + 原子回滚 / US3 删除码反枚举 4 路 + 并发恰一 / US4 撤销发码 eligible vs 4 ineligible 字节级 + timing / US5 解冻逐字段 + 原子回滚 / US6 撤销反枚举 5 路 + 并发恰一 / US7 匿名化逐字段 + 隔离 + 批次 + 幂等 / US8 撤销⟷匿名化互斥（终态 ANONYMIZED + 事件计数）/ US9 限流 8 规则
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（api-client regen）→ typed cancel-deletion + deletion 端点
- `[Mobile]`：撤销注销屏（`(auth)/cancel-deletion.tsx`，RHF）+ 错误映射 + 单测 → FROZEN 登录拦截 modal（改 login，剩余天数计算）+ 单测
- `[Mobile-E2E]`：Playwright Web e2e —— FROZEN 登录 → 拦截 modal → 撤销跳屏 → 请求码 → 输码 → 提交 → 主页（mock 200 LoginResponse）；保持分支留登录
- `[Verify]`：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（含 `runtime-smoke`）+ 真后端冒烟 + web e2e + catalog 8 Operation 行 + 跨 ctx 注释（`check-server-moat.ts`）

预估 task 数：~32-40（server 重：5 UC + 3 commit + scheduler + sms infra + security 扩；client 薄：1 屏 + 1 modal）。**批 C 是 5 批中最高复杂度**，task 数显著高于 003。

---

## Client UI Plan（delete-account — 2026-05-29 amend / p4 B3，tasks → `tasks-client.md`）

> **本段 = p4 子 plan B3 的 plan 回填**；server 段（上文，5 UC + cancel-deletion 屏）已 ship（#198）不动。branch `004-account-deletion-client`，**纯 mobile，无 server 改**（deletion 端点 #198 已就位、Orval 已生成且桶已导出）。
> **UI 类别 = 类 1 标准 UI**。旧 app `delete-account.tsx` 已是 PHASE-2 mockup 成品 → 高保真 port 视觉，但 **state 重写为 RHF**（mirror `use-cancel-deletion-form` Golden Sample，per [sdd.md § 类 1](../../docs/conventions/sdd.md) + mobile-impl-playbook RHF 4 铁律）。

### 路由结构

```text
apps/mobile/app/(app)/settings/account-security/
  delete-account.tsx     # 注销发起屏（route 文件；presentational 子件 inline，单用不抽 src/）
```

+ `account-security/index.tsx`「注销账号」行：006 disabled destructive 占位 → **enabled push**（FR-C01，同 PR 一行 flip = 集成点）。

### 复用资产 + port remap（旧 app → mono）

| 旧 app | mono 落点 | 备注 |
|---|---|---|
| `@nvy/auth` `requestDeleteAccountSmsCode()` / `deleteAccount(code)` 裸 fn | `~/auth/delete-account.ts` `useRequestDeletionCode()` / `useDeleteAccount()` | 包 Orval `useAccountDeletionControllerSendDeletionCodeForMe`(void) / `SubmitDeletionForMe`({data:{code}})；**`useDeleteAccount` onSuccess → `clearSession()`**（mirror `logout-all`，不导航）；send 不导航 |
| `delete-account-errors.ts` `mapDeletionError`（旧栈类型） | `~/auth/deletion-errors.ts` `deleteAccountErrorToast(e)` | **重写** for `AxiosError`（duck-type `isAxiosError` + `response.status`），mirror `cancel-deletion-errors`（**一步 toast**，非 kind+copy —— 屏只需文案）：401 `INVALID_DELETION_CODE`→验证码错误 / 429→限流 / 400→格式（防御）/ 5xx+TypeError→网络 / 其余→未知。**vitest** |
| 裸 `useState` 状态机 | `~/auth/use-delete-account-form.ts` | **RHF + zodResolver**（mirror `use-cancel-deletion-form`）：form `{ code }` zod `^\d{6}$`；2 确认勾选 + cooldown 为**副作用态**（local `useState`，铁律 2）；`requestSms` gated by `bothChecked && cooldown===0`；`submit = form.handleSubmit`（`isSubmitting` 单源，铁律 3）；state machine idle→requesting_sms→sms_sent→submitting→success/error。**vitest renderHook**（mirror `use-cancel-deletion-form.spec.ts`：happy-dom + mock 2 mutation hook） |
| 裸 `CodeInput`（6 cell） | `~/ui` `SmsInput`（Controller 包） | 复用 login slice 既有；code 字段走 `<Controller>` |
| 裸 `ErrorRow` | `~/ui` `ErrorRow`(text) | 复用 |
| `WarningBlock` / `CheckboxRow`×2 / `SendCodeRow` / `SectionLabel` / `SubmitButton` | inline in `delete-account.tsx` | delete 专属，单用 → inline（非 route 子件 inline 不触 phantom-route，与 login.tsx 同范式）；token remap `@nvy/design-tokens`→className/`~/theme`，`shadow-cta`（已存） |

### 成功路由（FR-C01）

提交成功 → `useDeleteAccount` onSuccess `clearSession()`（账号转 FROZEN，本地登出）+ 屏 `useEffect(state==='success' → router.replace('/(auth)/login'))` 双保险（mirror settings-shell US3 登出，per memory `visual_smoke_unreachable_when_finally_clears_session`：delete 是 logout-like terminal，断言落 `/login` 非 success overlay，故 clearSession→AuthGate 路径 e2e 可达，settings-shell US3a 已证）。**无 displayName→onboarding 顾虑**（session 清后 AuthGate 直送 login）。

### 测试分层（per memory `mono_mobile_test_layering`）

- **vitest（logic）**：`deleteAccountErrorToast`（全错误分支）；`use-delete-account-form`（renderHook 状态机：未双勾选 send 禁用 / 双勾选可发 / 发码进 sms_sent / 提交 success / 码错 error，mirror cancel form spec）。
- **Playwright Expo Web（UI/导航）**：US10 Independent Test 全程（进屏 → 勾选 gate → 发码 mock 204 → 输码 → 确认 mock 204 → session 清 + /login；mock 401 → 统一错误）。seed authed + `mockJson`，仿 settings-shell US3。
- **presentational（inline 子件）**：无单测，typecheck/lint + e2e。

### Open Decisions (client)

| # | 决策 | 结论 |
|---|---|---|
| DD1 | 注销成功路由 | `clearSession()` + 显式 `router.replace('/(auth)/login')` 双保险（logout-like，非 cancel 的 setSession→home） |
| DD2 | 2 确认勾选落 RHF 还是 local | **local useState**（gate，非提交数据；铁律 2 副作用态分层）；form 仅持 `code` |
| DD3 | 错误映射形态 | 一步 `deleteAccountErrorToast(e):string`（mirror cancel-deletion-errors，屏只需文案，无 device 那种 kind 分支） |
| DD4 | code 输入控件 | 复用 `~/ui SmsInput`（非 port 旧 bespoke CodeInput）；Controller 包 |
| DD5 | presentational 子件落点 | inline in route 文件（单用，与 login.tsx 同；不触 B2 那种 phantom-route，因非独立 .tsx） |

---

**Plan Version**: 1.0.0（server）/ 1.1.0（+client amend 2026-05-29 B3） | **Created**: 2026-05-26 | **ID-namespace**: US1-11 / FR-S01..S21 / FR-C01..C05 / SC-S01..S15 / SC-C01..C04
