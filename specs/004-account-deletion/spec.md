---
feature_id: 004-account-deletion
modules: [account, auth, security]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-26'
updated_at: '2026-05-29'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
perf_budgets:
  - endpoint: 'POST /api/v1/accounts/me/deletion-codes'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'POST /api/v1/accounts/me/deletion'
    p95_ms: 120
    p99_ms: 250
  - endpoint: 'POST /api/v1/auth/cancel-deletion/sms-codes'
    p95_ms: 120
    p99_ms: 250
    timing_defense:
      diff_p95_ms: 50
  - endpoint: 'POST /api/v1/auth/cancel-deletion'
    p95_ms: 150
    p99_ms: 300
    timing_defense:
      diff_p95_ms: 50
web_compat: untested
web_compat_notes: 'Client 段（2026-05-26 clarify 定）= 撤销注销屏（cancel-deletion，落 (auth)/）+ FROZEN 登录拦截 modal（改 (auth)/login，server 403 ACCOUNT_IN_FREEZE_PERIOD 已就位）。2026-05-29 amend（branch 004-account-deletion-client，p4 子 plan B3）：settings shell 已 ship（#221），注销发起屏（delete-account）解延后，落 (app)/settings/account-security/delete-account（US10 + FR-C01/C02 + SC-C01 激活），表单走 RHF Golden Sample（mirror cancel-deletion）。本 amend 纯 mobile（5 deletion 端点 #198 已就位，无 server 改）。'
agent_friction_observed: false
state_branches:
  - 'send-deletion-code: ACTIVE 账号 → 6 位数字码 SHA-256 持久化（purpose=DELETE_ACCOUNT, TTL 10min）+ SMS 下发 + 204；账号状态不变、不发事件'
  - 'send-deletion-code: 非 ACTIVE（FROZEN / ANONYMIZED）或未知账号 → 401 INVALID_CREDENTIALS 字节级一致（反枚举，不发 SMS、不写码行）'
  - 'delete-account: 有效 DELETE_ACCOUNT 码 + ACTIVE 账号 → 单事务：码 markUsed + 账号→FROZEN(freezeUntil=now+15d) + 撤销全部 refresh token + 发 AccountDeletionRequestedEvent 到 outbox + 204'
  - 'delete-account: 码 未找到 / 哈希不符 / 已过期 / 已用 → 401 INVALID_DELETION_CODE 字节级一致（4 分支折叠）'
  - 'delete-account: 事务任一步失败（如撤 token 抛错）→ 整体回滚：账号留 ACTIVE、freezeUntil null、码仍 active、无事件'
  - 'delete-account 并发: 5 并发持同码提交 → 恰 1 成功(204)、其余失败；无双重冻结、单一事件'
  - 'send-cancel-code: FROZEN-in-grace(freezeUntil>now) 手机号 → CANCEL_DELETION 码持久化 + SMS + 200'
  - 'send-cancel-code: 4 ineligible 分支（手机号未注册 / ACTIVE / ANONYMIZED / FROZEN-grace 已过）→ 静默 200、不发 SMS、不写码行、跑 dummy 哈希对齐时序（与 eligible 字节级一致）'
  - 'cancel-deletion: FROZEN-in-grace + 有效 CANCEL_DELETION 码 → 原子事务（并发裁决恰一成功）：码 markUsed + 账号→ACTIVE(freezeUntil null) + 发 AccountDeletionCancelledEvent + 签发并持久化新 access+refresh(30d) + 200 LoginResponse'
  - 'cancel-deletion: 5 类失败（手机号未注册 / ACTIVE / ANONYMIZED / FROZEN-grace 已过 / 码无效·错误·已用）→ 401 INVALID_CREDENTIALS 字节级一致；phone-class 分支跑 dummy 哈希'
  - 'cancel-deletion: 事务任一步失败（签发/持久化 token 抛错）→ 回滚：账号留 FROZEN、freezeUntil 不变、码 active、无事件'
  - 'cancel-deletion 并发: 5 并发持同码提交 → 恰 1 成功(200)、其余 401；终态 ACTIVE + freezeUntil null'
  - 'cancel-deletion 与 scheduler grace 竞态: markActiveFromFrozen 时点 grace 已过期 → 折叠 401 INVALID_CREDENTIALS'
  - 'anonymize: FROZEN + freezeUntil≤now → REQUIRES_NEW 单行原子事务（并发裁决恰一成功）：捕获 previousPhoneHash、phone→null、displayName→「已注销用户」、status→ANONYMIZED、freezeUntil→null、撤销全部 refresh token、发 AccountAnonymizedEvent（sms 码为非 PII HMAC 哈希，不删，由 expiresAt 失效）'
  - 'anonymize: scheduler 每批 LIMIT 100；单行失败被 REQUIRES_NEW 隔离（sibling 行不受影响）；领域拒绝（状态漂移 / grace 未满 / phone 已 null）→ skip 不计失败'
  - 'anonymize ⟷ cancel-deletion 互斥（同一 FROZEN-grace-expired 行）: anonymize 恒赢 → 终态 ANONYMIZED；cancel 见 grace 已过 → 401，outbox 无 AccountDeletionCancelledEvent'
  - '限流超限（send-deletion account 1/IP 5；delete account 5/IP 10；send-cancel phone 1/IP 5；cancel phone 5/IP 10，均 /60s）→ 429 + Retry-After；限流在加载账号之前消费'
  - '输入格式非法（码非 \d{6} → 400 校验；手机号非 E.164/非大陆 → 422 INVALID_PHONE_FORMAT）—— 与凭据失败 401 路径区分'
  - 'eligible 发码路径 SMS 网关失败 → 503 SMS_SEND_FAILED'
---

# Feature Specification: Account Deletion Lifecycle（注销 → 15 天冻结 → 撤销 / 匿名化）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-26)]**
> 本 feature 按 **Flat + Anemic + Moat** 范式实现（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）+ bounded context 边界（[ADR-0032](../../docs/adr/0032-backend-bounded-context.md)）。spec 只描述业务行为，不含实现技术词。

**Feature Branch**: `004-account-deletion`
**Created**: 2026-05-26
**Status**: Clarified（mode-1a 抽取重写：旧 meta spec `specs/account/delete-account/` + 旧 Java 5 UseCase + 旧 IT 三源净室提取；旧技术词 0 残留；2026-05-26 clarify 已结算 5 开放点）
**Module**: `account`（状态机：ACTIVE / FROZEN / ANONYMIZED 生命周期）+ `auth`（编排：公开撤销流 / 删除流端点）+ `security`（token 撤销 / 重发、sms-code 存储、反枚举时序）
**Input**:

- 用户可发起**账号注销**：进入 15 天**冻结宽限期**（FROZEN），期间账号不可登录但**可撤销恢复**；宽限期满由后台**匿名化**（ANONYMIZED 终态，不可逆）。
- 旧 Java `mbw-account` 5 个 use case 迁入 mono：`SendDeletionCode` / `DeleteAccount` / `SendCancelDeletionCode` / `CancelDeletion` / `AnonymizeFrozenAccount`。
- 本 feature 首次落地 **outbox 真消费侧之前的事件发布**（删除 / 撤销 / 匿名化三事件同事务写 outbox）+ 首次落地**定时任务（scheduler）**驱动的状态转换。

## Context

- **状态机（account 持有）**：

  ```text
  (none) → ACTIVE
  ACTIVE  ──发起注销(验码)────────────►  FROZEN (freezeUntil = now + 15d)
  FROZEN  ──撤销(验码, grace 未满)──────►  ACTIVE (freezeUntil 清空)
  FROZEN  ──scheduler(grace 期满)──────►  ANONYMIZED (终态, 不可逆)
  ```

  每个 transition 只能从**单一前置状态**进入（贫血状态判定纯函数强制，非法前置 → 拒绝）；`ACTIVE ↔ FROZEN` 与 `FROZEN → ANONYMIZED` 在同一行上互斥，靠并发锁裁决。

- **反枚举不变性**（贯穿）：
  - 删除流（authed `/me`）：码失败 4 分支（未找到 / 哈希不符 / 过期 / 已用）折叠为字节级一致 401 `INVALID_DELETION_CODE`；账号非 ACTIVE / 未知折叠为 401 `INVALID_CREDENTIALS`（与缺 token / token 失效同字节）。
  - 撤销流（**public unauthed**）：发码侧 4 ineligible 分支静默 200（与真发码字节级一致，仅有无真发 SMS 之差）；提交侧 5 类失败折叠 401 `INVALID_CREDENTIALS`。public 流靠 **dummy 哈希对齐时序**（非 wall-clock pad），防手机号 / 账号状态枚举。
- **横切复用（不重立）**：限流（`@nestjs/throttler` + Redis storage，`001` 配）/ sms-code SHA-256 存储与 timing defense（HMAC constant-time，[ADR-0023](../../docs/adr/0023-sms-code-storage-hmac.md)）/ RFC 9457 ProblemDetail 全局错误映射 / access+refresh token 签发与持久化（`001`/`003` ship）/ outbox 写入（`publish(client, eventType, payload)` 同事务，[ADR-0033](../../docs/adr/0033-outbox-cross-context-comm.md)）均已就位；本 spec 引用，不重新建立。
- **bounded context**（precise 归属 + catalog Operation 行在 `/speckit-plan` 阶段按 [catalog](../../docs/conventions/server-bounded-context-catalog.md) 3 传播规则 + 7 决策问题定）：account 持账号状态机写、security 持 token / sms-code 操作、auth 编排 public 撤销流；删除 / 撤销时**撤销 token** = R2 CROSS-CONTEXT-SYNC（失败回滚整请求）、**发三事件** = R3 CROSS-CONTEXT-ASYNC（outbox）。
- **数据模型已就位**：`Account`（`status` / `freezeUntil` / `previousPhoneHash` / `displayName`）、`AccountSmsCode`（`purpose` / `codeHash` / `expiresAt` / `usedAt`）、`RefreshToken`、`OutboxEvent` 全部已 db-pull（`apps/server/prisma/schema.prisma`），含本 spec 所需全部字段；偏索引 `idx_account_freeze_until_active`（`WHERE status='FROZEN' AND freeze_until IS NOT NULL`）正好驱动 scheduler 扫描。**本 feature 不新增表、不改表结构**（除非 clarify / plan 暴露缺字段）。

## Clarifications

### Session 2026-05-26

- Q: FROZEN 登录 disclosure（403 + freezeUntil）是否已在 mono 001？ → A: **已实现** — `apps/server/src/auth/phone-sms-auth.usecase.ts` 撞 FROZEN 已抛 `AccountInFreezePeriodException`（403 `ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`，不进 timing-pad；ANONYMIZED 仍反枚举折叠 401）。**004 不改 001 登录**，撤销 journey 的拦截入口已存在。
- Q: 注销 / 撤销 验证码失败的错误码口径？ → A: **public 折叠 + authed 专码** — public 撤销流（SendCancelDeletionCode / CancelDeletion）所有失败折叠**字节级一致** 401 `INVALID_CREDENTIALS`（反枚举刚需，与 mono login/refresh 一致）；authed 注销流（DeleteAccount）码失败用独立 401 `INVALID_DELETION_CODE`（authed 无枚举威胁，给前端精确「验证码错误」提示；4 个码失败子类彼此仍字节级一致）。账号状态 / 鉴权失败一律 `INVALID_CREDENTIALS`。复用既有 `ACCOUNT_IN_FREEZE_PERIOD`（403 登录 disclosure）/ `RATE_LIMITED`（429）/ `FORM_VALIDATION`（400 校验）。旧 Java 的 `AUTH_FAILED` 在 mono **不存在**（折叠为 `INVALID_CREDENTIALS`）。
- Q: 004 client 段覆盖哪些屏？ → A: **恢复闭环优先** — 撤销注销屏（`(auth)/cancel-deletion`，(auth) 组已在）+ FROZEN 登录拦截 modal（改 `(auth)/login`，server 403 已就位）落 004；**注销发起屏（delete-account）延后**到 settings shell 就位（独立 feature）。代价：本批 client 不含注销发起入口 —— server 5 端点先就位、待 settings shell 落地后接入 delete-account 屏。
- Q: public 撤销端点形态？ → A: **public unauthed 沿用旧路径** — `POST /api/v1/auth/cancel-deletion(/sms-codes)`（FROZEN 用户无 token；与 mono 公开 login / sms-code 端点一致）。
- Q: SendDeletionCode 返回码（旧 controller 204 vs 旧 spec 散文 200）？ → A: **204 No Content**（与 send-code 无 body 语义一致）。

### Session 2026-05-29（client amend — B3 注销发起屏）

> p4 子 plan B3 起手。settings shell（006）已 ship（#221）→ 2026-05-26 clarify 定的「delete-account 延后」前提解除。spec-merge 约束多已在 Session 2026-05-26 锁（错误码口径 / 端点形态 / RHF Golden Sample）；本轮决落点 + 真分歧（user 确认 2026-05-29）。

- Q: 本 client feature 落点？ → A: **amend 004 原地**（不吃新编号，per p4 决策 #3，与 B2 amend 005 同模式）；branch `004-account-deletion-client`；解 US10 / FR-C01 / FR-C02 / SC-C01 的 `[DEFERRED]`；新建 `tasks-client.md`（已 ship 的 server tasks 不动）。
- Q: 是否含 server 改？ → A: **纯 mobile，无 server 改** —— 注销发码 / 提交 5 端点（US1-3）随 #198 已 ship，Orval `useAccountDeletionControllerSendDeletionCodeForMe`(void) / `SubmitDeletionForMe`({data: DeleteAccountRequest}) 已生成且经 `@nvy/api-client` 桶导出（无 B2 那种契约 quirk / 桶遗漏）。
- Q: 注销发起屏路由落点 + RHF？ → A: 落 `(app)/settings/account-security/delete-account`（settings shell 之内，account-security index「注销账号」行 flip 激活）；表单 **RHF + zodResolver，mirror `use-cancel-deletion-form`**（复用皮、重写肉：双勾选解锁发码 → 6 位码 → 确认 → 清 session → login）。`deleteAccountErrorToast` 统一错误（authed `INVALID_DELETION_CODE` / 429 / 网络 / 未知），mirror `cancel-deletion-errors`。
- Q: 注销成功后路由？ → A: **清本地会话 → login**（账号转 FROZEN 不可登录；delete 清 session ≠ cancel-deletion 的回主页）。无 displayName→onboarding 顾虑（清 session 后 AuthGate 直送 login，#216 回填仅影响有 session 的冷启动）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 发送注销验证码（SendDeletionCode，Priority: P1）

已登录的 ACTIVE 用户发起注销：系统生成一次性 6 位数字验证码（仅单向哈希入库，明文只进短信），写入一条 `purpose=DELETE_ACCOUNT`、10 分钟过期的验证码记录，并向账号注册手机号下发删除验证短信。**不改账号状态、不发任何事件**。账号非 ACTIVE（FROZEN / ANONYMIZED）或不存在时，响应与「鉴权失败」字节级一致（401 `INVALID_CREDENTIALS`），不暴露账号生命周期状态。

**Why this priority**: 是 US2（验码冻结）的前置——无有效删除码则无法冻结。删除流入口。

**Independent Test**: Testcontainers PG + Redis；ACTIVE 账号持有效 access token 调发码端点 → 断言 204、DB 新增 1 条 `AccountSmsCode`（`purpose=DELETE_ACCOUNT`、`codeHash` 非空且 = 下发码哈希、`expiresAt` ≈ now+10min、`usedAt` 为空）、账号 `status` 仍 ACTIVE；FROZEN 账号调同端点 → 断言 401 `INVALID_CREDENTIALS`（与无 token 字节级一致）、无码行新增。

**Acceptance Scenarios**:

1. **Given** ACTIVE 账号 + 有效 access token，**When** 调发码端点，**Then** 204；DB 落 1 条 active DELETE_ACCOUNT 码（`codeHash` 单向哈希、`expiresAt` 10min 后、`usedAt` 空）；下发短信含 6 位明文码；账号状态不变、无事件
2. **Given** FROZEN 或 ANONYMIZED 账号（持仍有效的旧 access token），**When** 调发码端点，**Then** 401 `INVALID_CREDENTIALS`（与「缺 token / token 失效」字节级一致）；不写码行、不发短信
3. **Given** 同账号 60s 内重复发码，**When** 第 2 次调用，**Then** 429 `RATE_LIMITED` + `Retry-After`（per-account 1/60s）；**限流在加载账号之前消费**（不查库、不发码）
4. **Given** eligible 发码路径短信网关失败，**When** 下发短信，**Then** 503 `SMS_SEND_FAILED`（码行是否保留由 plan 决，默认不因发送失败而泄露）

---

### User Story 2 — [Server] 提交验证码 → 冻结账号（DeleteAccount，Priority: P1）

用户输入收到的 6 位码确认注销：系统在**单个原子事务**内查找仍 active 的 DELETE_ACCOUNT 码、哈希比对、标记码已用、将账号置 FROZEN（`freezeUntil = now + 15 天`）、**撤销该账号全部 refresh token**、向 outbox 发 `AccountDeletionRequestedEvent`。任一步失败整事务回滚（账号留 ACTIVE、码仍 active、无事件）。冻结后所有 session 失效，客户端在 access token 自然过期后被踢出。

**Why this priority**: 主路径——注销的核心动作，状态机 `ACTIVE → FROZEN` 的唯一入口。

**Independent Test**: Testcontainers；预置 ACTIVE 账号 + 1 条 active DELETE_ACCOUNT 码 + 该账号 N 条 active refresh token → 持有效 access token + 正确码调删除端点 → 断言 204；DB 账号 `status=FROZEN`、`freezeUntil` ≈ now+15d、码 `usedAt` 已置、该账号全部 refresh token `revokedAt` 已置、outbox 有 1 条 `AccountDeletionRequestedEvent`。

**Acceptance Scenarios**:

1. **Given** ACTIVE 账号 + active DELETE_ACCOUNT 码 + 正确码值，**When** 调删除端点，**Then** 204；账号→FROZEN、`freezeUntil`=now+15d、码 markUsed、全部 refresh token 撤销、outbox 落 `AccountDeletionRequestedEvent`（payload 含 accountId / freezeAt / freezeUntil / occurredAt）
2. **Given** 冻结成功后，**When** 用此前未过期的 access token 调任意受保护接口，**Then** 账号 FROZEN → 401（access token 自然过期后下次刷新因 token 全撤而失败，踢出在 access 过期时生效，与 `003` 一致）
3. **Given** 事务内撤销 token 步骤抛错，**When** 事务回滚，**Then** 账号保持 ACTIVE、`freezeUntil` 为空、码仍 active、**无** `AccountDeletionRequestedEvent`（原子性：要么全成，要么全不变）
4. **Given** 账号已 FROZEN（重复提交），**When** 再次提交码，**Then** 冻结转换拒绝（非法前置状态）→ 折叠为统一失败响应（不重复冻结、不重复发事件）

---

### User Story 3 — [Server] 删除码反枚举 + 并发恰一成功（Priority: P1）

删除码的所有失败原因对客户端表现为**单一、字节级一致**的 401 `INVALID_DELETION_CODE`（不暴露码属于 未找到 / 哈希不符 / 已过期 / 已用 中哪一类）。同一删除码被并发提交多次时，**恰有一次**冻结成功，其余安全失败——绝不双重冻结、绝不重复发事件。

**Why this priority**: 安全不变性（防码枚举）+ 数据完整性（防双重冻结 / 重复事件）。

**Independent Test**: Testcontainers；构造 4 类码失败各发一次 → 断言响应 body / status / `code` 字节级一致（均 401 `INVALID_DELETION_CODE`）；另预置 1 条 active 码 + 5 个并发持同码提交 → 断言**恰 1 个** 204、其余 4 个失败；DB 账号 FROZEN（仅 1 次）、outbox 仅 1 条 `AccountDeletionRequestedEvent`。

**Acceptance Scenarios**:

1. **Given** 不存在 / 哈希不符 / 已过期 / 已用 的删除码（4 类），**When** 各调一次删除端点，**Then** 4 次响应 body / status / `code` 字节级一致（均 401 `INVALID_DELETION_CODE`）
2. **Given** 1 条 active 删除码，**When** 5 个并发持同码提交，**Then** 恰 1 个 204、其余 4 个失败；账号 FROZEN（单次）、refresh token 撤销（单次）、outbox `AccountDeletionRequestedEvent` 恰 1 条
3. **Given** 请求体 `code` 缺失 / 非 `\d{6}` 格式，**When** 调删除端点，**Then** 400 校验错误（与凭据失败 401 路径**区分**——格式问题非凭据问题）

---

### User Story 4 — [Server] 发送撤销验证码（SendCancelDeletionCode，反枚举，Priority: P1）

FROZEN 用户（无 token）想撤销注销：经 **public 端点**提交手机号请求撤销码。**仅当**「账号存在 ∧ FROZEN ∧ 冻结宽限期未满」时才真正写 `purpose=CANCEL_DELETION` 码并下发短信；其余 4 个 ineligible 分支（手机号未注册 / 账号 ACTIVE / 账号 ANONYMIZED / FROZEN 但 grace 已过）**静默返回 200，不发短信、不写码行**，并跑一次 dummy 哈希对齐时序，使攻击者无法借响应差异 / 时延枚举手机号是否注册或账号状态。

**Why this priority**: 撤销流入口 + 反枚举核心（public 端点，枚举风险最高）。

**Independent Test**: Testcontainers；FROZEN-in-grace 账号手机号调发码端点 → 断言 200 + DB 新增 1 条 active CANCEL_DELETION 码 + 短信下发；4 个 ineligible 分支各调一次 → 断言均 200、**无**码行新增、**无**短信下发；断言 eligible 与 ineligible 响应 body / status 字节级一致。

**Acceptance Scenarios**:

1. **Given** 账号 FROZEN 且 `freezeUntil > now`，**When** 以其手机号调发码端点，**Then** 200；DB 落 1 条 active CANCEL_DELETION 码（10min 过期）；下发撤销验证短信
2. **Given** 手机号未注册 / 账号 ACTIVE / 账号 ANONYMIZED / FROZEN 但 `freezeUntil ≤ now`（4 分支），**When** 调发码端点，**Then** 均 200（与 eligible 字节级一致）；**不**写码行、**不**发短信；跑 dummy 哈希对齐时序
3. **Given** 手机号格式非法（非 E.164 / 非中国大陆），**When** 调发码端点，**Then** 422 `INVALID_PHONE_FORMAT`（先于 eligibility 判定）
4. **Given** 同手机号 60s 内重复请求，**When** 第 2 次调用，**Then** 429 `RATE_LIMITED`（per-phone-hash 1/60s；手机号以哈希作限流 key，不明文落限流器）

---

### User Story 5 — [Server] 提交验证码 → 解冻 + 重发 token（CancelDeletion，Priority: P1）

FROZEN-in-grace 用户输入撤销码：系统在**单原子事务**内（并发裁决保证恰一成功），eligibility 判定、查 active CANCEL_DELETION 码、哈希比对、标记码已用、将账号置回 ACTIVE（清 `freezeUntil`，转换条件**二次校验 grace 未满**以防 scheduler 抢跑）、向 outbox 发 `AccountDeletionCancelledEvent`、签发并持久化新 access + refresh token（refresh TTL 30 天），返回登录态（access + refresh）让客户端直接进主页。任一步失败整事务回滚（账号留 FROZEN、码仍 active、无事件）。

**Why this priority**: 主路径——撤销注销的核心动作，状态机 `FROZEN → ACTIVE` 的唯一入口，且直接重建登录态。

**Independent Test**: Testcontainers；预置 FROZEN-in-grace 账号 + 1 条 active CANCEL_DELETION 码 → 以手机号 + 正确码调撤销端点 → 断言 200 + 返回新 access + refresh；DB 账号 `status=ACTIVE`、`freezeUntil` 为空、码 markUsed、新增 1 条 active refresh token（TTL 30d）、outbox 有 1 条 `AccountDeletionCancelledEvent`。

**Acceptance Scenarios**:

1. **Given** 账号 FROZEN-in-grace + active CANCEL_DELETION 码 + 正确码，**When** 调撤销端点，**Then** 200 + 新 access + refresh（30d）；账号→ACTIVE、`freezeUntil` 清空、码 markUsed、outbox 落 `AccountDeletionCancelledEvent`（payload 含 accountId / cancelledAt / occurredAt）
2. **Given** 撤销成功，**When** 客户端持返回的新 token，**Then** 可正常访问受保护接口（登录态已重建）
3. **Given** 事务内签发 / 持久化 token 步骤抛错，**When** 事务回滚，**Then** 账号保持 FROZEN、`freezeUntil` 不变、码仍 active、**无** `AccountDeletionCancelledEvent`、无新 refresh token

---

### User Story 6 — [Server] 撤销反枚举 + 并发恰一成功（Priority: P1）

撤销提交的所有失败原因对客户端表现为**单一、字节级一致**的 401 `INVALID_CREDENTIALS`（不暴露失败属于 手机号未注册 / 账号 ACTIVE / 账号 ANONYMIZED / FROZEN-grace 已过 / 码无效·错误·已用 中哪一类）；手机号 class 分支在真哈希比对前跑 dummy 哈希对齐时序。同一撤销码被并发提交多次时，**并发裁决**保证**恰有一次**解冻成功（其余 401），绝不重复解冻 / 重复发事件 / 重复签发 token。

**Why this priority**: 安全不变性（防手机号 + 账号状态枚举）+ 数据完整性（并发裁决防 N 线程读 stale FROZEN 快照各自「成功」）。

**Independent Test**: Testcontainers；构造 5 类失败各发一次 → 断言响应字节级一致（均 401 `INVALID_CREDENTIALS`）；另预置 1 条 active 撤销码 + 5 个并发持同码提交 → 断言**恰 1 个** 200、其余 4 个 401；DB 账号 ACTIVE（单次）、`freezeUntil` 空、outbox `AccountDeletionCancelledEvent` 恰 1 条。

**Acceptance Scenarios**:

1. **Given** 手机号未注册 / 账号 ACTIVE / 账号 ANONYMIZED / FROZEN-grace 已过 / 码（无效·错误·已用）（5 类），**When** 各调一次撤销端点，**Then** 5 次响应 body / status / `code` 字节级一致（均 401 `INVALID_CREDENTIALS`）；手机号 class 分支跑 dummy 哈希
2. **Given** 1 条 active 撤销码，**When** 5 个并发持同码提交，**Then** 恰 1 个 200、其余 4 个 401；账号 ACTIVE（单次）、outbox `AccountDeletionCancelledEvent` 恰 1 条、新 refresh token 恰 1 条
3. **Given** 请求体缺 `phone` / `code` 字段，**When** 调撤销端点，**Then** 400 校验错误（与凭据失败 401 路径区分）

---

### User Story 7 — [Server] 冻结期满匿名化（AnonymizeFrozenAccount，scheduler，Priority: P1）

每日定时任务扫描冻结宽限期已满（`status=FROZEN ∧ freezeUntil ≤ now`）的账号，对每个账号在**独立事务（REQUIRES_NEW）**内（并发裁决保证恰一成功）、在清手机号**之前**捕获 `previousPhoneHash = 手机号哈希`、原子执行匿名化（手机号置空、`displayName` 钉为常量「已注销用户」、`status → ANONYMIZED`、清 `freezeUntil`）、**撤销该账号全部 refresh token**、向 outbox 发 `AccountAnonymizedEvent`。匿名化是终态、不可逆；任一策略失败整行事务回滚（无部分匿名化），单行失败被 REQUIRES_NEW 隔离不影响同批 sibling。（sms 验证码为非 PII 的 HMAC 哈希，不随匿名化删除，由 `expiresAt` 自然失效；PII 最小化由 phone 置空满足。）

**Why this priority**: 主路径——状态机 `FROZEN → ANONYMIZED` 的唯一入口；GDPR-style 数据最小化兑现注销承诺。

**Independent Test**: Testcontainers；预置 FROZEN 账号（`freezeUntil` 已过）+ 该账号 active refresh token N 条 → 触发 scheduler 一轮 → 断言账号 `status=ANONYMIZED`、`phone` 为空、`displayName`=「已注销用户」、`previousPhoneHash` = 原手机号哈希、`freezeUntil` 空、该账号 refresh token 全撤、outbox 有 1 条 `AccountAnonymizedEvent`；预置 1 个匿名化步骤抛错的 fixture → 断言整行回滚（无部分匿名化、无事件）。

**Acceptance Scenarios**:

1. **Given** FROZEN 账号 + `freezeUntil ≤ now`，**When** scheduler 处理该行，**Then** 账号→ANONYMIZED、`phone` 置空、`displayName`=「已注销用户」、`previousPhoneHash`=原手机号哈希、`freezeUntil` 空；该账号全部 refresh token 撤销、outbox 落 `AccountAnonymizedEvent`（payload 含 accountId / anonymizedAt / occurredAt）
2. **Given** scheduler 扫描到 > 100 个待匿名化账号，**When** 一轮处理，**Then** 本轮处理至多 100 个（批次上限），其余下轮处理
3. **Given** 某账号匿名化策略（撤 token / 删 sms_code）抛错，**When** 该行事务回滚，**Then** 该行保持 FROZEN（无部分匿名化、无 `AccountAnonymizedEvent`）；同批其他账号**不受影响**（REQUIRES_NEW 隔离）
4. **Given** 账号 `phone` 已为空（重复匿名化 / 已处理），**When** scheduler 再次扫到，**Then** 领域拒绝（短路防重复哈希 null）→ skip，不计为失败
5. **Given** 连续 N 轮 scheduler 持续失败（DB 故障等），**When** 累计达阈值，**Then** 升 ERROR 级告警（运维可观测）；单轮失败不阻塞后续轮次

---

### User Story 8 — [Server] 撤销 ⟷ 匿名化互斥（Priority: P1）

同一 FROZEN-grace-expired 账号被撤销线程（CancelDeletion）与匿名化线程（AnonymizeFrozenAccount）并发攻击时，**并发裁决**（行写锁 + grace 谓词互斥）保证二者 serialise：**匿名化恒赢**——终态为 ANONYMIZED，撤销线程见冻结宽限期已过 → 折叠 401 `INVALID_CREDENTIALS`，且 outbox **无** `AccountDeletionCancelledEvent`（撤销未到 commit）。

**Why this priority**: 数据完整性——边界时刻（grace 刚过）若二者都「成功」会产生既 ACTIVE 又 ANONYMIZED 的矛盾态 + 矛盾事件。

**Independent Test**: Testcontainers；预置 FROZEN 账号 `freezeUntil` 恰好刚过 + 1 条 active CANCEL_DELETION 码 → 并发触发 CancelDeletion + AnonymizeFrozenAccount → 断言终态恒为 ANONYMIZED；撤销响应 401 `INVALID_CREDENTIALS`；outbox 有 `AccountAnonymizedEvent`、**无** `AccountDeletionCancelledEvent`。

**Acceptance Scenarios**:

1. **Given** FROZEN-grace-expired 账号 + active 撤销码，**When** 撤销与匿名化并发，**Then** 终态恒 ANONYMIZED；撤销 401；outbox 仅 `AccountAnonymizedEvent`、无 `AccountDeletionCancelledEvent`
2. **Given** 匿名化先 flip 状态为 ANONYMIZED，**When** 撤销线程随后执行条件更新，**Then** 撤销 WHERE status=FROZEN 不再匹配（count=0）→ 折叠 401（反枚举一致路径）

---

### User Story 9 — [Server] 限流（Priority: P2）

四个 user-facing 端点各自受限流保护；超限返回 429 + `Retry-After`，且**限流在加载账号之前消费**（throttle 时不查库、不发码、不触碰状态机）。

**Why this priority**: 防爆刷 / 撞库 / 短信轰炸 / 拒绝服务；P2 因主功能（US1-US8）不依赖它即可演示，但上线必需。

**Independent Test**: Testcontainers + Redis；对每端点按其桶配置连发至超限 → 断言超限请求 429 + `Retry-After`，且限流命中时**未**新增码行 / 未改账号状态（`verify` 账号加载未被调用的等价断言）。

**Acceptance Scenarios**:

1. **Given** SendDeletionCode，**When** 同账号 60s 内第 2 次 / 同 IP 第 6 次，**Then** 429（per-account 1/60s、per-IP 5/60s）
2. **Given** DeleteAccount，**When** 同账号 60s 内第 6 次 / 同 IP 第 11 次，**Then** 429（per-account 5/60s、per-IP 10/60s）
3. **Given** SendCancelDeletionCode，**When** 同手机号 60s 内第 2 次 / 同 IP 第 6 次，**Then** 429（per-phone-hash 1/60s、per-IP 5/60s）
4. **Given** CancelDeletion，**When** 同手机号 60s 内第 6 次 / 同 IP 第 11 次，**Then** 429（per-phone-hash 5/60s、per-IP 10/60s）

---

### User Story 10 — [Client] 注销账号屏（delete-account，authed，Priority: P2）

> ✅ **[ACTIVATED — 2026-05-29 amend / p4 B3]**：settings shell（006）已 ship（#221）→ 延后前提解除，本屏落地。落 `(app)/settings/account-security/delete-account`；account-security index「注销账号」行 flip 激活。server 端点 US1-US3（#198）已就位，本批纯 client 接入。

已登录用户在「设置 → 账号安全 → 注销账号」屏：屏内展示 ≥ 2 行风险提示（① 15 天内可撤销恢复 ② 期满匿名化不可逆），用户须**双重确认勾选**才解锁「发送验证码」；发码后输入 6 位码点「确认注销」→ 成功后客户端被强制登出（清本地会话）并路由到登录页。表单走 RHF + zodResolver（[Golden Sample](../../docs/private/plans/2026-05/05-25-account-migration-master.md)）。

**Why this priority**: P2——用户可见的注销发起入口；settings shell 已就位，本 amend（p4 B3）落地为 A→B→C 链最后一环。

**Independent Test**: Playwright Expo Web e2e（复用 `apps/mobile/e2e/_support/api-mock.ts` 的 `mockJson`）：登录态进 delete-account 屏 → 未勾选时发码按钮禁用 → 勾选双确认 → 发码 → 输码 → 确认 → 断言调删除端点 + 本地会话清空 + 路由登录。

**Acceptance Scenarios**:

1. **Given** 进入注销账号屏，**When** 未完成双重确认勾选，**Then** 「发送验证码」按钮禁用；风险提示 ≥ 2 行可见
2. **Given** 已双重确认勾选，**When** 点发送验证码，**Then** 调发码端点；进入输码态
3. **Given** 输入正确码点确认注销，**When** 删除成功，**Then** 本地会话清空 + 路由到登录页（账号已 FROZEN）
4. **Given** 码错误 / 过期，**When** 提交，**Then** 展示统一错误提示（不区分失败子类，与 server 反枚举一致）

---

### User Story 11 — [Client] FROZEN 登录拦截 + 撤销注销屏（public，Priority: P2）

> ✅ **[IN 004 SCOPE]**（2026-05-26 clarify 定）：FROZEN 拦截 modal + 撤销注销屏落 004。mono 001 登录 FROZEN 403 disclosure（`ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`）已就位 → 拦截入口存在；`(auth)` 组已在 → 撤销屏可直落。

FROZEN 账号尝试手机短信登录时被拦截 modal 拦下，提示「账号注销冷静期，剩余 N 天」+ 两分支：「撤销注销」→ 跳转撤销注销屏（手机号经路由参数预填，免重输）/「保持注销」→ 清 form 留在登录页。撤销注销屏：输入手机号（预填）→ 请求撤销码 → 输 6 位码 → 提交 → 成功后直接登录进主页。表单走 RHF + zodResolver。

**Why this priority**: P2——账号恢复闭环；与登录流耦合（依赖 001 是否暴露 FROZEN 态）。

**Independent Test**: Playwright Web e2e：模拟登录返回 FROZEN disclosure → 断言拦截 modal 出现 + 「剩余天数」展示 → 点撤销 → 撤销屏手机号预填 → 请求码 → 输码 → 提交（mock 200 LoginResponse）→ 断言路由进主页；点「保持注销」→ 断言留登录页 + form 清空。

**Acceptance Scenarios**:

1. **Given** 手机短信登录撞 FROZEN 账号，**When** 服务端返回 FROZEN disclosure，**Then** 客户端弹拦截 modal（剩余天数 + 撤销 / 保持两分支）
2. **Given** 拦截 modal，**When** 点「撤销注销」，**Then** 跳撤销注销屏、手机号预填（路由参数）
3. **Given** 撤销注销屏，**When** 请求撤销码 → 输码 → 提交且成功，**Then** 拿新登录态 → 路由进主页
4. **Given** 拦截 modal，**When** 点「保持注销」，**Then** 留登录页、清 form

---

### Edge Cases

#### Server Edge Cases

- **删除码与账号状态竞态**：码 markUsed 后重载发现账号已 FROZEN（被并发抢先）→ 冻结转换拒绝 → 整事务回滚（不重复冻结）
- **同账号 > 60s 间隔发 2 条 active 删除码**：两条都有效，任一可成功完成冻结（限流只挡频次，不挡多码并存）
- **撤销码与 scheduler 匿名化竞态**：撤销在 `markActiveFromFrozen` 时点二次校验 `freezeUntil > now`，若 scheduler 已抢跑使账号 ANONYMIZED / grace 过期 → 折叠 401（见 US8）
- **匿名化后手机号复用**：被匿名化的手机号在发码 / 登录 / 撤销流中视为「未注册」（反枚举一致，防手机号复用攻击枚举历史账号）
- **purpose 物理隔离**：`DELETE_ACCOUNT` 码不能满足 `CANCEL_DELETION` / `PHONE_SMS_AUTH` 查询，反之亦然（按 `purpose` + active 谓词过滤）
- **匿名化幂等**：`phone` 已为空的行被重复扫到 → 领域拒绝短路，不重复哈希 null、不重复发事件
- **冻结期内账号持未过期 access token**：受保护接口因账号非 ACTIVE 拒绝（账号状态门槛），无需主动失效 access（无状态，自然过期）

#### Client Edge Cases

- **delete-account 屏发码后切走再回**：输码态是否保持 / 重新发码（plan 决；默认重新进屏需重新发码）
- **撤销屏手机号路由参数缺失**（直接深链进入）：手机号输入框可手动填（不强依赖预填）
- **拦截 modal 触发依赖 001 的 FROZEN disclosure**：mono 001 登录撞 FROZEN 已返 403 `ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`（已就位）→ modal 据此触发；ANONYMIZED 仍折叠 401（不触发 modal，按「未注册 / 凭据无效」处理）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 发送注销码 — ACTIVE 账号（authed）请求时，MUST 生成一次性 6 位数字码（高熵随机），仅以**单向哈希**写入 1 条 `AccountSmsCode`（`purpose=DELETE_ACCOUNT`、`expiresAt`=now+10min、`usedAt`=空），明文仅进短信 payload、**永不入库 / 永不日志**；下发删除验证短信。MUST NOT 改账号状态、MUST NOT 发事件。成功返 204。
- **FR-S02**: 发送注销码鉴权与状态门槛 — 缺 / 无效 / 过期 access token，或账号非 ACTIVE（FROZEN / ANONYMIZED）/ 未知 → MUST 折叠为**字节级一致** 401 `INVALID_CREDENTIALS`（不暴露账号生命周期状态）。
- **FR-S03**: 提交注销码（冻结）— 持 active DELETE_ACCOUNT 码 + 正确码值 + 账号 ACTIVE 时，MUST 在**单原子事务**内：标记码已用 → 账号置 FROZEN（`freezeUntil`=now+15 天）→ 撤销该账号**全部** refresh token → 向 outbox 发 `AccountDeletionRequestedEvent`（同事务）。返 204。
- **FR-S04**: 冻结原子性 — FR-S03 任一步失败 MUST 整事务回滚：账号保持 ACTIVE、`freezeUntil` 为空、码保持 active、**不**发事件、不撤 token。
- **FR-S05**: 删除码反枚举 — 码失败 4 分支（未找到 / 哈希不符 / 已过期 / 已用）MUST 折叠为**字节级一致** 401 `INVALID_DELETION_CODE`；请求体 `code` 缺失 / 非 `\d{6}` MUST 返 400 校验错误（与凭据路径区分）。
- **FR-S06**: 冻结并发安全 — 同一删除码并发提交 MUST 保证**恰 1 次**冻结成功（其余安全失败）；MUST NOT 双重冻结、MUST NOT 重复撤 token、MUST NOT 重复发 `AccountDeletionRequestedEvent`。并发裁决用条件更新 + 受影响行数 / 重载状态校验（**禁** `@Version` 风格乐观锁 —— 旧栈无 version 字段，新栈用 markUsed 行锁 + 重载见 FROZEN 即弃的等价语义，per memory `prisma_serializable_p2002_and_p2034`）。
- **FR-S07**: 发送撤销码（public，反枚举）— **public unauthed** 端点接受手机号；**仅当**账号存在 ∧ FROZEN ∧ `freezeUntil > now` 时 MUST 写 1 条 active `CANCEL_DELETION` 码（10min 过期）+ 下发撤销短信；其余 **4 ineligible 分支**（手机号未注册 / ACTIVE / ANONYMIZED / FROZEN-grace 已过）MUST 静默返 200、**不**写码行、**不**发短信，并跑 dummy 哈希对齐时序，使响应 body / status / 时延对 eligible 与 ineligible **不可区分**。
- **FR-S08**: 撤销码手机号校验 — 手机号 MUST 先经格式校验（E.164 中国大陆），非法 → 422 `INVALID_PHONE_FORMAT`（先于 eligibility 判定）；手机号 MUST 以**哈希**作限流 key（不明文落限流器）。
- **FR-S09**: 提交撤销码（解冻 + 重发 token）— FROZEN-in-grace + active CANCEL_DELETION 码 + 正确码时，MUST 在**单原子事务**内：标记码已用 → 账号置 ACTIVE（清 `freezeUntil`，转换**条件谓词二次校验** `status=FROZEN AND freezeUntil > now`）→ 向 outbox 发 `AccountDeletionCancelledEvent`（同事务）→ 签发并持久化新 access + refresh token（refresh TTL 30 天，`loginMethod=PHONE_SMS`）。返 200 + 登录态（access + refresh）。
- **FR-S10**: 解冻原子性 — FR-S09 任一步失败 MUST 整事务回滚：账号保持 FROZEN、`freezeUntil` 不变、码保持 active、**不**发事件、不签发 token。
- **FR-S11**: 撤销反枚举 — 撤销提交 5 类失败（手机号未注册 / 账号 ACTIVE / 账号 ANONYMIZED / FROZEN-grace 已过 / 码无效·错误·已用）MUST 折叠为**字节级一致** 401 `INVALID_CREDENTIALS`；手机号 class 分支 MUST 在真哈希比对前跑 dummy 哈希对齐时序；请求体缺字段 MUST 返 400（与凭据路径区分）。
- **FR-S12**: 撤销并发安全 — 同一撤销码并发提交 MUST 通过**并发裁决**（条件更新 `WHERE status=FROZEN AND freezeUntil>now` + 受影响行数校验，依赖 DB 行写锁 serialise 同行竞争）保证**恰 1 次**解冻成功（其余 401）；MUST NOT 重复解冻、重复发事件、重复签发 token。（具体并发原语见 plan D2：READ COMMITTED + affected-count，非悲观锁。）
- **FR-S13**: 匿名化 scheduler — 定时任务 MUST 周期性（每日）扫描 `status=FROZEN ∧ freezeUntil ≤ now` 账号（用偏索引 `idx_account_freeze_until_active`，每批上限 100），对每个账号在**独立事务（REQUIRES_NEW）**内匿名化（并发裁决保证与 cancel 互斥）。
- **FR-S14**: 匿名化变更集 — 匿名化 MUST 原子执行：在清手机号**之前**捕获 `previousPhoneHash`=手机号哈希 → `phone` 置空 → `displayName` 钉为常量「已注销用户」→ `status`→ANONYMIZED → 清 `freezeUntil` → 撤销该账号**全部** refresh token → 向 outbox 发 `AccountAnonymizedEvent`（同事务）。ANONYMIZED 为**终态**、不可逆。（sms 验证码为非 PII 的 HMAC 哈希，**不**随匿名化硬删，由 `expiresAt` 失效；PII 最小化由 phone 置空满足 —— 见 plan D6。）
- **FR-S15**: 匿名化隔离与幂等 — 单账号匿名化任一策略失败 MUST 整行事务回滚（无部分匿名化、不发事件）；单行失败 MUST 被 REQUIRES_NEW 隔离，不影响同批 sibling；`phone` 已为空的行 MUST 领域拒绝短路（不重复匿名化）；领域拒绝（状态漂移 / grace 未满 / 锁超时）MUST 视为 skip 不计失败；持续失败累计达阈值 MUST 升 ERROR 级告警。
- **FR-S16**: 撤销 ⟷ 匿名化互斥 — 同一 FROZEN-grace-expired 账号被撤销与匿名化并发时，**并发裁决** MUST serialise 二者（cancel 谓词 `freezeUntil>now` 与 anonymize 谓词 `freezeUntil<=now` 互斥 + DB 行写锁）：**匿名化恒赢**（终态 ANONYMIZED，边界 `<=` 归 anonymize）；撤销条件更新 WHERE status=FROZEN 不再匹配（count=0）→ 折叠 401，且 MUST NOT 发 `AccountDeletionCancelledEvent`。
- **FR-S17**: 验证码存储 — 所有验证码（DELETE_ACCOUNT / CANCEL_DELETION）MUST 单向哈希存储（沿用 `001` sms-code 存储范式，ADR-0023）；`purpose` 物理隔离（按 purpose + active 谓词查询，跨 purpose MUST NOT 命中）。
- **FR-S18**: 限流 — 复用既有 `@nestjs/throttler` + Redis storage；新增 per-UC 配置：SendDeletionCode `per-account 1/60s + per-IP 5/60s`、DeleteAccount `per-account 5/60s + per-IP 10/60s`、SendCancelDeletionCode `per-phone-hash 1/60s + per-IP 5/60s`、CancelDeletion `per-phone-hash 5/60s + per-IP 10/60s`；超限 MUST 返 429 + `Retry-After`；限流 MUST 在加载账号之前消费（throttle 时不查库 / 不发码 / 不触状态机）。
- **FR-S19**: 错误响应格式 — 所有错误 MUST 遵循 RFC 9457 ProblemDetail（`application/problem+json`），由既有全局错误映射产出，与既有 use case 一致。
- **FR-S20**: 跨 context 事件与边界 — 三事件（`AccountDeletionRequestedEvent` / `AccountDeletionCancelledEvent` / `AccountAnonymizedEvent`）MUST 经 outbox 同事务发布（R3 CROSS-CONTEXT-ASYNC）；删除 / 撤销 / 匿名化中**撤销 token** 为 R2 CROSS-CONTEXT-SYNC（失败回滚整请求），跨 context 注入点 MUST 带 `// CROSS-CONTEXT-SYNC` 注释；catalog Operation 清单 MUST 新增对应行（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）。
- **FR-S21**: SMS 网关失败 — eligible 发码路径短信下发失败 MUST 返 503 `SMS_SEND_FAILED`（具体码行清理策略 plan 决，默认不因发送失败泄露账号存在性）。

### Client Functional Requirements

> ✅ 范围：**FR-C03 / FR-C04 / FR-C05** 随 004 ship（FROZEN modal + 撤销屏）；**FR-C01 / FR-C02** 2026-05-29 amend（p4 B3）**解延后激活**（注销发起屏，settings shell #221 已就位）。

- **FR-C01** **[ACTIVATED — p4 B3]**: 注销账号屏 — 提供 authed 注销账号屏（落 `(app)/settings/account-security/delete-account`），展示 ≥ 2 行风险提示（15 天可撤销 / 期满不可逆），**双重确认勾选**前「发送验证码」MUST 禁用；发码 → 输 6 位码 → 确认注销；成功后 MUST 清本地会话 + 路由登录页。表单走 RHF + zodResolver（mirror `use-cancel-deletion-form` Golden Sample）。account-security index「注销账号」行 MUST 由 006 disabled 占位 flip 为真 push。
- **FR-C02** **[ACTIVATED — p4 B3]**: 注销错误展示 — 码失败展示**统一**错误提示（`deleteAccountErrorToast`：authed `INVALID_DELETION_CODE` 码错 / 429 限流 / 网络 / 未知；不区分码失败子类，与 server 反枚举一致）。
- **FR-C03**: FROZEN 登录拦截 modal — 手机短信登录撞 FROZEN 账号（服务端 403 disclosure 已就位）时 MUST 弹拦截 modal：展示剩余冻结天数 + 「撤销注销」/「保持注销」两分支；撤销 → 跳撤销屏（手机号路由参数预填）/ 保持 → 清 form 留登录页。
- **FR-C04**: 撤销注销屏 — 提供 public 撤销注销屏：手机号（预填 / 可手填）→ 请求撤销码 → 输 6 位码 → 提交；成功后 MUST 以返回的登录态路由进主页。表单走 RHF + zodResolver。
- **FR-C05**: 撤销错误展示 — 撤销失败展示**统一**错误提示（不区分子类，与 server 反枚举一致）。

> **测试分层（per mono 约定）**：client 表单逻辑 / 状态机 / 错误映射 → vitest logic-level helper 单测；任何 UI render / a11y / 路由 → Playwright Expo Web e2e。

## Key Entities _(数据涉及)_

> 全部表已 db-pull，本 feature **不改表结构**。属性级（不带存储类型）：

- **Account**（账号，归 `account`）— 本 feature 读写字段：
  - `status`：生命周期状态 `ACTIVE` / `FROZEN` / `ANONYMIZED`（终态）
  - `freezeUntil`：冻结宽限期截止时刻；FROZEN 时 = 进入冻结起 + 15 天；ACTIVE / ANONYMIZED 时为空
  - `previousPhoneHash`：匿名化时捕获的原手机号哈希（供反枚举一致性 + 手机号复用防御）；非匿名化时为空
  - `displayName`：匿名化时钉为常量「已注销用户」
  - `phone`：匿名化时置空（释放手机号唯一约束）
  - **active 谓词**（登录 / 发码可用）：`status = ACTIVE`
  - **FROZEN-in-grace 谓词**（可撤销）：`status = FROZEN AND freezeUntil > now`
- **AccountSmsCode**（验证码记录，归 `account`）— 本 feature 涉及字段：
  - `purpose`：`DELETE_ACCOUNT` / `CANCEL_DELETION`（与 `001` 的 `PHONE_SMS_AUTH` 物理隔离）
  - `codeHash`：6 位明文码的单向哈希（明文永不入库）
  - `expiresAt`：过期时刻（签发起 10 分钟）
  - `usedAt`：标记已用时刻；为空 = active（可消费）
  - **active 谓词**：`usedAt` 为空 AND `expiresAt > now`，且 `purpose` 匹配
  - 匿名化时该账号 sms 码**不删**（非 PII HMAC 哈希，由 `expiresAt` 失效；PII 最小化靠 account.phone 置空）
- **RefreshToken**（refresh-token 记录，归 `security`；`003` 已立）— 本 feature 仅**撤销**（`revokedAt` 置位）+ 撤销时**重新签发持久化**（CancelDeletion）；字段沿用 `003`
- **OutboxEvent**（跨 context 事件，归 `public`）— 本 feature 新发 3 类 `eventType`：
  - `AccountDeletionRequestedEvent`：payload `{ accountId, freezeAt, freezeUntil, occurredAt }`
  - `AccountDeletionCancelledEvent`：payload `{ accountId, cancelledAt, occurredAt }`
  - `AccountAnonymizedEvent`：payload `{ accountId, anonymizedAt, occurredAt }`
  - 三事件均与状态写**同事务**落 outbox；真消费侧不在本 feature scope（事件先沉淀，消费方后续）

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 注销发码 — ACTIVE 账号发码后 DB 必有对应 active DELETE_ACCOUNT 码（`codeHash`=下发码哈希、10min 过期）；非 ACTIVE / 未知 → 401 `INVALID_CREDENTIALS` 字节级一致（集成测试覆盖 ACTIVE / FROZEN / ANONYMIZED / 未知 四路径）
- **SC-S02**: 冻结正确性 — 提交正确删除码后账号 FROZEN、`freezeUntil` ≈ now+15d、码 markUsed、全部 refresh token 撤销、outbox 落 1 条 `AccountDeletionRequestedEvent`（集成测试逐字段断言）
- **SC-S03**: 冻结原子性 — 注入撤 token 失败 → 断言账号仍 ACTIVE、无 `freezeUntil`、码仍 active、无事件（集成测试）
- **SC-S04**: 删除码反枚举 — 4 类码失败响应 body / status / `code` 字节级一致（均 401 `INVALID_DELETION_CODE`）；格式非法返 400（集成测试）
- **SC-S05**: 冻结并发安全 — 5 并发同删除码提交恰 1 成功（204）、其余失败；账号 FROZEN（单次）、outbox `AccountDeletionRequestedEvent` 恰 1 条（并发集成测试）
- **SC-S06**: 撤销发码反枚举 — eligible 发码 vs 4 ineligible 分支响应 body / status 字节级一致；eligible 写码行 + 发短信、4 ineligible 均不写码行 / 不发短信；时序差 P95 ≤ 50ms（集成测试 + 时序断言）
- **SC-S07**: 解冻正确性 — 提交正确撤销码后账号 ACTIVE、`freezeUntil` 空、码 markUsed、新增 1 条 active refresh token（30d）、outbox 落 1 条 `AccountDeletionCancelledEvent`、返回可用登录态（集成测试逐字段断言）
- **SC-S08**: 解冻原子性 — 注入 token 签发失败 → 断言账号仍 FROZEN、`freezeUntil` 不变、码仍 active、无事件、无新 token（集成测试）
- **SC-S09**: 撤销反枚举 — 5 类失败响应 body / status / `code` 字节级一致（均 401 `INVALID_CREDENTIALS`）；时序差 P95 ≤ 50ms（集成测试 + 时序断言）
- **SC-S10**: 撤销并发安全 — 5 并发同撤销码提交恰 1 成功（200）、其余 401；账号 ACTIVE（单次）、outbox `AccountDeletionCancelledEvent` 恰 1 条、新 refresh token 恰 1 条（并发集成测试）
- **SC-S11**: 匿名化正确性 — FROZEN-grace-expired 账号匿名化后 `status=ANONYMIZED`、`phone` 空、`displayName`=「已注销用户」、`previousPhoneHash`=原哈希、`freezeUntil` 空、refresh token 全撤、outbox 落 1 条 `AccountAnonymizedEvent`（集成测试逐字段断言）
- **SC-S12**: 匿名化隔离与幂等 — 单行策略失败整行回滚（无部分匿名化、无事件）且不影响同批 sibling；批次上限 100；`phone` 已空行 skip 不计失败（集成测试 + scheduler 单测）
- **SC-S13**: 撤销 ⟷ 匿名化互斥 — 边界并发终态恒 ANONYMIZED；撤销 401；outbox 有 `AccountAnonymizedEvent`、无 `AccountDeletionCancelledEvent`（并发集成测试断言事件计数）
- **SC-S14**: 限流准确性 — FR-S18 四端点八规则集成测试验证生效；429 + 正确 `Retry-After`；限流命中时未触账号加载 / 状态机
- **SC-S15**: 模块边界 — module 边界 CI 检查（ADR-0032）0 violation；跨 context 注入点注释齐全（`scripts/checks/check-server-moat.ts` 通过）；catalog Operation 清单新增对应行；三事件类型名与 catalog / 消费方约定一致

### Client Measurable Outcomes

> 范围：**SC-C02 / SC-C03 / SC-C04** 随 004 ship；**SC-C01（注销屏流程）** 2026-05-29 amend（p4 B3）**激活**。

- **SC-C01** **[ACTIVATED — p4 B3]**: 注销屏流程 — 未双确认时发码按钮禁用、双确认后可发码 → 输码 → 确认 → 清会话 + 路由登录（Playwright Web e2e）；错误码失败统一展示（`deleteAccountErrorToast` vitest + e2e）
- **SC-C02**: FROZEN 拦截与撤销 — 登录撞 FROZEN → 拦截 modal（剩余天数 + 两分支）→ 撤销跳屏手机号预填 → 请求码 → 输码 → 提交成功 → 路由主页；保持分支留登录清 form（Playwright Web e2e）
- **SC-C03**: 错误统一展示 — 注销 / 撤销码失败展示统一错误提示（不区分子类，logic-level 单测 + e2e）
- **SC-C04**: 真后端冒烟 — Playwright Web e2e 复用 `apps/mobile/e2e/_support/api-mock.ts`，跑通注销发起与撤销恢复主路径

## Assumptions

- **既有横切复用**：限流（throttler + Redis）/ sms-code SHA-256 存储 + timing defense（ADR-0023）/ RFC 9457 ProblemDetail 全局映射 / access+refresh token 签发与持久化（`001`/`003`）/ outbox `publish(client, eventType, payload)` 同事务（ADR-0033）均已 ship，本 feature 引用不重立。
- **数据表已就位**：`Account` / `AccountSmsCode` / `RefreshToken` / `OutboxEvent` 已 db-pull，字段满足本 spec；**假设无需 schema migration**（若 clarify / plan 暴露缺字段，再走 [migration 治理](../../.claude/rules/migration-rules.md)）。
- **冻结宽限期 = 15 天、验证码 TTL = 10 分钟、撤销重发 refresh TTL = 30 天**：沿用旧系统铁规则（旧 Java IT 实证）；M2+ 可调。
- **匿名化 scheduler 节奏**：默认每日一轮、每批上限 100、持续失败阈值 3 轮升 ERROR（旧系统值）；具体 cron 表达式 / 时区 plan 决。
- **DeleteAccount 无版本号乐观锁**：旧栈 account 实体无 version 字段，靠 markUsed 行锁 + 重载见 FROZEN 即弃裁决并发；新栈用等价机制（条件更新 + 受影响行数 / 状态前置校验），**不**引入 `@Version` 风格乐观锁（避免语义偏移；per memory `prisma_serializable_p2002_and_p2034`）。
- **反枚举时序对齐用 dummy 哈希、非 wall-clock pad**：public 撤销流（发码 / 提交）靠 dummy 哈希拉平 code-hash 计算时序；**不**引入 `001` 登录流的 400ms wall-clock pad、**不**为本 5 UC 复刻登录的枚举防御 IT（那是 phone-sms-auth 专属，per cross-source 调研）。
- **三事件先沉淀、消费方后续**：本 feature 只负责同事务**发布**三事件到 outbox，**不**实现真消费侧（事件 sink / 通知 / 物化）—— 消费方批次另行规划。
- **client 为单一 mono mobile（Expo）**：UI port 自旧 app；**004 client scope（已 clarify 定）= cancel-deletion 屏 + FROZEN 登录 modal**（delete-account 发起屏延后 settings shell）；表单走 RHF + zodResolver Golden Sample。

## Out of Scope（本 feature 不做）

- **outbox 真消费侧**（事件 sink / 推送通知 / 删除审计物化 / 数据导出）→ 后续批次（本 feature 仅发布事件到 outbox）
- **硬删除账号 / 物理删行**（M3+ GDPR 完整擦除）→ 本 feature 终态是 ANONYMIZED（保留行 + 抹 PII），非物理删除
- **单设备登出 / 设备管理** → 归 `005-device-management`
- **实名认证数据在匿名化时的擦除** → **不再需要**（实名认证功能已废弃，2026-05-31，无 `realname_profile` 数据）
- **冻结期内的部分功能降级 UI**（只读模式 / 倒计时常驻）→ 本 feature 冻结即不可登录，无降级态
- **多登录方式撤销重发**（OAuth 等）→ 当前 `loginMethod` 仅手机短信
- **settings shell（设置外壳）本体** → 仍非本 feature scope（归 `006-account-settings-shell`，已 ship #221）。~~注销发起屏（delete-account）延后~~ → **已解延后**：settings shell 就位后，2026-05-29 amend（p4 B3，branch `004-account-deletion-client`）落地 delete-account 屏（FR-C01/C02 + US10 + SC-C01 激活），见 § Clarifications Session 2026-05-29。
- **撤销/登录后「恢复老账号 → 主页」的 displayName 回填**（2026-05-26 T035 e2e 暴露，定**延后**单独处理）→ cancel-deletion 成功（及普通 login）仅 `setSession({accountId, accessToken, refreshToken})`，LoginResponse 不带 `displayName`；`apps/mobile/src/core/api/use-me.ts`（拉 `/me` 回填 displayName）当前**未被任何屏挂载消费**（dead code）→ AuthGate 在 `displayName===null` 态把会话送 `/(app)/onboarding` 而非主页。**影响面超出 004**（普通老用户冷启动登录同样被丢去 onboarding）。本 feature e2e 据现状断言落 `/onboarding`；修复（挂载 useMe / LoginResponse 带 displayName 二选一）归后续独立 task
