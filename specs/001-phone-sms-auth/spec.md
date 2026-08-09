---
feature_id: 001-phone-sms-auth
modules: [auth, security, account]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-04'
updated_at: '2026-05-29'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# v2 frontmatter fields (per mono-orchestrator-ready 0.2.0 + ADR-0024 amend + ADR-0039)
web_compat: untested
web_compat_notes: 'server impl 已 ship;mobile client 切片本轮启动(account-migration p3 login;Step 1b de-stale 起);Expo Web export 路径仍未冒烟,client impl 完成后回填'
agent_friction_observed: true
agent_friction_notes: 'F-002 Typecheck-Boot-Gap (nx run server:test pass 但 boot 需 Prisma+Redis Testcontainers); F-006 Indirect-Spec-Module-Mapping (本 spec 实证横跨 auth/security/account 3 context,modules 字段必显式 list, per ADR-0032 物理拆 + ADR-0034 operation catalog 缓解)'
perf_budgets:
  - endpoint: 'POST /api/v1/phone-sms-auth'
    p95_ms: 200
    p99_ms: 500
    timing_defense:
      diff_p95_ms: 50
  - endpoint: 'POST /api/v1/sms-codes'
    p95_ms: 150
    p99_ms: 400

state_branches:
  - 'registered user: correct SMS code → token issued, last_login_at updated'
  - 'unregistered user: correct SMS code → account auto-created ACTIVE, token issued'
  - 'FROZEN/ANONYMIZED account with correct code → 401 INVALID_CREDENTIALS, byte-identical to code-error'
  - 'any user: SMS code expired (>5min) → 401 INVALID_CREDENTIALS'
  - 'concurrent phone-sms-auth requests same unregistered number → single Account created (idempotent)'
---

# Feature Specification: Phone SMS Auth (unified login/register)

> ⚠️ **[ARCHITECTURE GOVERNANCE NOTE (2026-05-24)]**
> This spec was implemented under the legacy Hexagonal/DDD architecture.
> The narrative (e.g., "aggregate root", "hexagonal layers") is preserved for historical record.
> However, future implementations MUST follow the **Flat + Anemic + Moat** paradigm defined in **[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)**.

**Feature Branch**: `001-phone-sms-auth`（per [ADR-0024](../../docs/adr/0024-spec-feature-first-layout.md)；Plan 1 期间合入的 PR 使用旧命名 `feature/phone-sms-auth-<usX>` 不追溯）
**Created**: 2026-05-04 / **mono W2 implemented**: 2026-05-17
**Status**: Server Draft（mono W2 PoC 首个业务 use case，从零实现） / Client 段保留作 W4+ mobile impl reference
**Module**: server `apps/server` NestJS Module `auth` / client `apps/mobile/app/(auth)/login`（W4+ 物理迁入）
**Input**: User description: "登录注册合二为一：客户端只输入手机号 + SMS code 一键登录；server 自动判已注册→login / 未注册→自动创建+login。参考大陆主流 app 范式（网易云音乐 / 小红书 / 拼多多）"

> **mono W2 migration context**（2026-05-17）：
>
> 本 spec server 端为 mono W2 PoC 从零实现（W2 焦点 = V1/V2 验收），业务规则与 user-facing 行为以 NestJS / Prisma / TS 描述；client 段（FR-C\*）保留作 W4+ mobile use case 落地的契约 reference。
>
> **本 spec 双层结构**：同时承载 server (`apps/server` `auth` Module) 与 client (`apps/mobile/app/(auth)/login`) 双侧约束。User Scenarios / Functional Requirements / Success Criteria 各自分 `Server` / `Client` 子段；Clarifications 与 Open Questions 分别打 `[from server]` / `[from app]` 标签。
>
> **W2 焦点 server**：implement 阶段（W2.4）仅 server domain + application + infrastructure 层；client 段属 W4+ mobile use case scope，不在本 W2 implement 内消费。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 主流程：已注册用户登录（Priority: P1）

已注册大陆手机号用户回访场景下，输入「手机号 + SMS code」一气呵成完成登录，得到新的 access/refresh token 立即可用。**用户视角不存在"注册"或"登录"区分**。

**Why this priority**: 主路径，所有已注册用户的回访入口；M1.2 业务下注册路径与登录路径合一。

**Independent Test (server)**: Testcontainers 起 PG + Redis + Mock SMS gateway，预先注册 ACTIVE 账号 → POST `/api/v1/accounts/sms-codes` `{phone}`（无 purpose 字段，per FR-S04）→ POST `/api/v1/accounts/phone-sms-auth` `{phone, code}` → 断言 200 + `{accountId, accessToken, refreshToken}` + `Account.lastLoginAt` 更新。

**Independent Test (client)**: vitest `vi.mock` `~/auth` 的 phone-sms-auth wrapper（封装 Orval `useAccountPhoneSmsAuthControllerAuth`）返回 `{accountId, accessToken, refreshToken}`，渲染 `<LoginScreen>` → fireEvent 输入手机号 → press "获取验证码" → 输入 6 位码 → press "登录" → 断言 store.session 已设置 + AuthGate 自动 redirect 到 `/(app)/`。

**Acceptance Scenarios**:

1. **Given** ACTIVE 账号 `+8613800138000` 已存在，**When** POST `/api/v1/accounts/sms-codes` `{phone}`，**Then** SMS gateway 收到 Template A（真实验证码）请求；5 分钟内验证码 hash 写入 Redis `sms_code:<phone>`
2. **Given** 验证码 5 分钟内有效，**When** POST `/api/v1/accounts/phone-sms-auth` `{phone, code}`，**Then** 返回 200 + `{accountId, accessToken, refreshToken}`；DB `Account.last_login_at` 更新为当前 UTC
3. **Given** 已注册用户连续登录多次，**When** 各 token 单独鉴权请求，**Then** 所有有效 token 都通过（refresh token revoke 在 Phase 1.3 use case 实施）
4. **Given** 用户访问 `/(auth)/login`，**Then** 页面单 form 渲染（无 tab，无密码字段）；手机号 input 可见；submit "登录" 按钮初始 disabled（form invalid **且未请求过验证码**，per FR-C11 gating）。即便用户只填了手机号 + 6 位码但**从未** press "获取验证码"，"登录"按钮仍 disabled（合法验证码只可能在请求后存在；防止凭空输码绕过 SMS 流程）
5. **Given** 输入合法手机号 `+8613800138000`，**When** press "获取验证码"，**Then** 调 `requestSmsCode(phone)`（无 purpose 字段，per FR-S04）；请求成功后"登录"按钮解锁 gating（仍需 form valid）；"获取验证码"按钮 disabled + 60s 倒计时
6. **Given** 输入合法手机号 + 6 位码 `123456`，**When** press "登录"，**Then** state idle → submitting；调 `phoneSmsAuth(phone, code)`；成功后 state success；store.setSession({accountId, accessToken, refreshToken}); AuthGate 监听 isAuthenticated 自动 router.replace `/(app)/`
7. **Given** 用户已登录（store 含 session），**When** 直接访问 `/(auth)/login`，**Then** AuthGate 拦截 → router.replace `/(app)/`（AuthGate 已落地，本 spec 仅消费）

---

### User Story 2 - 主流程：未注册用户自动注册+登录（Priority: P1，并列）

未注册大陆手机号用户首次到访，输入「手机号 + SMS code」流程完全相同；server **静默创建** ACTIVE 账号并签 token。**客户端无感知"创建"动作**——返回响应与已注册路径字节级一致；client 端**操作路径与 User Story 1 完全相同**，client 代码无 phone-existed 分支。

**Why this priority**: 大陆主流 UX 核心 —— 用户无注册心智负担。

**Independent Test (server)**: 未注册号 `+8613900139000`，发起 `/sms-codes` + `/phone-sms-auth` 流程，断言响应**字节级与已注册路径一致**；DB 新增 `Account` 记录 status=ACTIVE，触发 `AccountCreatedEvent` 写 outbox。

**Independent Test (client)**: 同 User Story 1（client 代码无分支，从 client 视角看不出"已注册"vs"未注册"）；后端反枚举字节级一致由 server `SingleEndpointEnumerationDefenseIT` 覆盖。

**Acceptance Scenarios**:

1. **Given** `+8613900139000` 未在 DB 内，**When** POST `/api/v1/accounts/sms-codes` `{phone}`，**Then** SMS gateway 收到 Template A（真实验证码，与已注册路径一致——see FR-S04）；返回 200 OK 字节级与已注册路径同
2. **Given** 验证码有效，**When** POST `/api/v1/accounts/phone-sms-auth` `{phone, code}`，**Then** server transactional 创建 `Account(phone, status=ACTIVE)` + 签 token + outbox 写 `AccountCreatedEvent`；响应 200 + `{accountId, accessToken, refreshToken}` 字节级与已注册路径同
3. **Given** 同一未注册号短时间内重复触发流程（concurrent requests），**When** server 处理，**Then** 仅创建 1 个 Account（DB unique constraint 兜底 + transactional 串行化）；返回相同 accountId
4. **Client**: 与 User Story 1 字节级一致响应保证防枚举；client 端无需任何特殊处理（FR-C01 ~ FR-C05 全适用）

---

### User Story 3 - 异常：FROZEN / ANONYMIZED 账号反枚举（Priority: P1，并列）

注销冻结期账号（FROZEN）或已匿名化账号（ANONYMIZED）尝试登录，系统**不暴露状态信号**——返回与"码错误"完全一致的错误响应（含响应字节 + 时延）。client 仅看 HTTP 401 状态，**不区分 401 子码**，统一映射为"手机号或验证码错误"。

**Why this priority**: 防枚举安全基线（OWASP ASVS V3.2 / 个保法）；已注销用户重新注册的合规边界。

**Independent Test (server)**: 预设 FROZEN 账号 + ANONYMIZED 账号；发 `/sms-codes` + `/phone-sms-auth` 提交正确码，断言响应与"码错误"场景**字节级 + P95 时延差 ≤ 50ms**。

**Acceptance Scenarios**:

1. **Given** 账号 `+8613800138001` status=FROZEN（注销冻结期）+ 验证码正确，**When** POST `/phone-sms-auth`，**Then** 返回 `INVALID_CREDENTIALS` 错误（HTTP 401，与"码错误"完全一致），**不签 token，不更新 last_login_at，不解除冻结**
2. **Given** 账号 `+8613800138002` status=ANONYMIZED（已匿名化）+ 验证码正确，**When** POST `/phone-sms-auth`，**Then** 同上 `INVALID_CREDENTIALS`；该 phone 由 `/sms-codes` 路径 viewing 为"未注册"（用 User Story 2 自动注册路径**仅当** phone NOT EXISTS in DB；ANONYMIZED account 仍存在但 phone 已 NULL，故 phone 在新 account 创建时不冲突）
3. **Given** 攻击者比较"FROZEN 账号"vs"码错误"vs"未注册自动登录"三种响应，**Then** 时延差 ≤ 50ms（per FR-S06 timing defense + dummy bcrypt hash）；status / body / headers 字节级一致（仅"未注册自动登录"返回 200 + token，其他返回 401，但 401 路径间字节级一致）
4. **Client**: 已注册号 + 错码 OR 未注册号 + 任意码 OR FROZEN/ANONYMIZED 账号 + 任意码，提交后端均返回 `INVALID_CREDENTIALS` (HTTP 401)；前端 errorToast = "手机号或验证码错误"（**不区分** 4 种 server 分支，per server SC-S03 反枚举字节级一致）

---

### User Story 4 - 边缘：限流防爆刷 + 网络错 + 401 refresh 透明（Priority: P2）

恶意用户对同一手机号或同一 IP 高频请求 `/sms-codes` 或 `/phone-sms-auth`，系统按规则限流并返回 HTTP 429 + `Retry-After`，避免短信费用爆炸 + 账号枚举辅助暴破。client 端给清晰 toast 不静默；access token 过期 401 由 `~/auth` 的 axios 拦截器透明 refresh，组件层不感知。

**Why this priority**: 复用既有 `RateLimitService` 基础设施；`/sms-codes` 60s 限流是反 SMS 滥发硬性合规要求。边缘错误体验差是 D 类 bug 风险源；refresh 透明性是已实现的契约，本 spec 验证消费侧不破坏它。

**Independent Test (server)**: Testcontainers 测试快速调 `/sms-codes` N 次断言第 2 次起返回 429；24h 内同号 5 次失败码后第 6 次返回 LOCKED（隐藏在 `INVALID_CREDENTIALS` 形态内）。

**Independent Test (client)**: vitest mock 各错误码的 `AxiosError<ProblemDetailResponse>`（Orval/axios 生成的错误类型），断言 errorToast 文案 + state error；refresh 透明性走 packages/api-client 已有测试（本 spec 不重复）。

**Acceptance Scenarios**:

1. **Given** 手机号 60 秒内已请求过 `/sms-codes`，**When** 再次 POST，**Then** 返回 429 + `Retry-After: <秒数>` + body `{code: RATE_LIMITED}`
2. **Given** 同号 24h 内已用错误码尝试 5 次 `/phone-sms-auth`，**When** 第 6 次提交，**Then** 即使码正确也返回 `INVALID_CREDENTIALS`，账号锁 30 分钟
3. **Given** 同 IP 24h 内已请求 50 次 `/sms-codes`（跨手机号），**When** 第 51 次请求，**Then** 返回 429（per `sms:<ip>` bucket）
4. **Client**: 提交 phoneSmsAuth 时后端返回 429，state error + errorToast = "请求过于频繁，请稍后再试"；submit 按钮重新 enabled
5. **Client**: 网络错（axios 抛 `AxiosError` 无 `response`，如 `ERR_NETWORK` / timeout）或 5xx，state error + errorToast = "网络异常，请检查网络后重试"；submit 按钮重新 enabled
6. **Client**: 错误状态下任意 input change，errorToast 清空；state 回 idle

---

### User Story 5 - Client UI 占位：三方 OAuth + 帮助链接（Priority: P2，client-only）

底部三方 OAuth 按钮（微信 / Google / Apple iOS-only） + 底部"登录遇到问题"帮助链接占位 — **存在但 placeholder**，press 后弹"Coming in M1.3"toast，避免空 dead-end。Apple 在 Android 端**不渲染**（Platform.OS conditional render）。（原顶部 close `×` 占位按钮已于 2026-05-29 移除，详见 FR-C08。）

**Why this priority**: M1.2 不实施真实 OAuth + 帮助中心，但 design system 必须为它们留位（mockup 阶段一并定调，避免 M1.3 加入时撞原有布局）。

**Independent Test (client)**: jest mock `expo-router` + Platform.OS，渲染 → press 各 placeholder 按钮 → 断言 toast "Coming in M1.3"；Android 端 mock Platform.OS 为 "android" → 断言 Apple 按钮不出现在 DOM。

**Acceptance Scenarios**:

1. **Given** login 页 iOS / Web 端，**When** press 微信 / Google / Apple 圆形按钮，**Then** errorToast = "<provider> 登录 - Coming in M1.3"，state 不变，无任何 API 调用
2. **Given** login 页 Android 端，**Then** Apple 按钮不渲染（Platform.OS === 'android' 条件）；微信 / Google 按钮仍渲染
3. **Given** login 页任意端，**When** press 底部 "登录遇到问题" link，**Then** errorToast = "帮助中心 - Coming in M1.3"，state 不变

> 备注：原 "立即体验" 游客模式占位已废（per mockup v2 反向修订；游客模式 M2 评估时再决定 UI 入口位置）。

---

### Edge Cases

- **手机号格式异常**：非 E.164 / 非大陆段（不匹配 `^\+861[3-9]\d{9}$`）→ 返回 `INVALID_PHONE_FORMAT`（HTTP 400）；client 端 zod 校验 form invalid，submit 按钮 disabled
- **验证码过期**：超过 5 分钟 → 返回 `INVALID_CREDENTIALS`（不区分"过期"vs"错误"）
- **验证码已使用**：同一码二次提交 → 返回 `INVALID_CREDENTIALS`（单次有效）
- **SMS gateway 失败**：Resend (mock) / 阿里云短信 API 超时 / 错误 → 返回 `SMS_SEND_TIMEOUT`（HTTP 503）
- **Token 签发失败**：JWT 签名异常 → 返回 `INTERNAL_SERVER_ERROR`（HTTP 500），未更新 last_login_at / 未创建 Account（事务回滚）；客户端可重新走 auth 流程
- **并发同号自动注册**：DB unique constraint on `account.phone` + 串行化事务（Prisma `$transaction` with `isolationLevel: 'Serializable'`）保证仅创建 1 个 Account；duplicated insert 落错处理为"作为已注册路径处理"（fallback to login）

## Requirements _(mandatory)_

### Server Requirements (FR-S01 ~ FR-S12)

- **FR-S01（Endpoint）**：唯一 endpoint `POST /api/v1/accounts/phone-sms-auth`，入参 `{phone: string, code: string}`，响应 `{accountId, accessToken, refreshToken}` 或 RFC 9457 ProblemDetail 错误。**无 password / email 字段**
- **FR-S02（Phone 格式）**：`^\+861[3-9]\d{9}$`（仅大陆段）；不匹配 → `INVALID_PHONE_FORMAT` HTTP 400
- **FR-S03（SMS code 存储）**：复用既有 SMS code 基础设施 — Redis `sms_code:<phone>` 5min TTL，hash 存储（不存明文，per CL-002）；存储算法 = **HMAC-SHA256 + `crypto.timingSafeEqual`**（per [ADR-0023](../../../docs/adr/0023-sms-code-storage-hmac.md)，2026-05-18 从 bcrypt cost=12 切换，根因见 FR-S06 timing 段）；secret env `SMS_CODE_HMAC_SECRET` fail-fast；与 SMS gateway / RateLimitService 完全复用
- **FR-S04（SMS Purpose 隐藏）**：`/api/v1/accounts/sms-codes` endpoint 入参**简化为 `{phone}`**（删除 purpose 字段）；server 内部根据 phone 是否存在动态决定 SMS template：
  - phone 存在 ACTIVE → Template A（真实验证码，文案"登录验证码"）
  - phone 不存在 → Template A（真实验证码，文案与上同——per User Story 2 反枚举一致）
  - phone 存在 FROZEN / ANONYMIZED → Template A（仍发，但 `/phone-sms-auth` 提交正确码会被反枚举吞，per User Story 3）
  - **取消 Template C**（旧 login-by-phone-sms 的"未注册号收登录失败提示"）— 新模式下未注册号路径 = 自动注册成功，无需"登录失败"文案
- **FR-S05（核心分支逻辑）**：`/phone-sms-auth` use case 内部按 phone 查 DB 分支：
  - phone 不存在 → **自动创建** `Account(phone, status=ACTIVE, lastLoginAt=now())` + outbox `AccountCreatedEvent` + 签 token → 返回 200
  - phone 存在 + status=ACTIVE → updateLastLoginAt + 签 token → 返回 200
  - phone 存在 + status=FROZEN → 抛 `AccountInFreezePeriodException` → HTTP 403 + body `code: ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`；**不**走 timing defense pad（disclosure path，wall-clock < 100ms，per spec D `expose-frozen-account-status` FR-002 + CL-006）
  - phone 存在 + status=ANONYMIZED → 反枚举吞下：dummy bcrypt 计算（timing defense pad 仍生效） + 抛 `InvalidCredentialsException` → HTTP 401
- **FR-S06（反枚举 timing defense）**：timing defense 范围**缩为 ANONYMIZED + 码错 + 码过期 + 未注册自动创建 + 已注册 ACTIVE 路径**——FROZEN 路径已显式 disclosure 不参与（per spec D `expose-frozen-account-status` FR-004 + CL-003 `TimingDefenseExecutor.executeInConstantTime` bypassPad 参数）。覆盖范围内成功路径（已注册 ACTIVE / 未注册自动注册）+ 失败路径（ANONYMIZED / 码错 / 码过期）必须**响应 P95 时延差 ≤ 50ms**：
  - SMS code 存储 = HMAC-SHA256 + `crypto.timingSafeEqual`（per FR-S03 + [ADR-0023](../../../docs/adr/0023-sms-code-storage-hmac.md)）— verify 路径耗时 < 1ms,3 个反枚举路径自然时延均一
  - 失败路径仍调用 `TimingDefenseExecutor.pad()` 计算 dummy bcrypt compare(cost=10，~80ms)作纵深防御 — 抹平 redis.get 抖动 / Phone VO 构造 / ConfigService.get / account 查询等任何残余微差异
  - `BcryptTimingDefenseExecutor` 由 TS + `bcrypt` npm 包实现，dummy hash input 用固定内存常量（不依赖 DB password_hash 列）
  - 由独立集成测试 `SingleEndpointEnumerationDefenseIT`（`apps/server/test/integration/timing-defense.p95.it.spec.ts`，env-gated `RUN_PERF_IT=true PERF_IT_REPS=N`）验证 P95 差 ≤ 50ms（**不含 FROZEN 路径**——单独由 spec D `FrozenAccountStatusDisclosureIT` 覆盖）；PoC 阶段 200-rep fast feedback，1000-rep nightly job 在 Plan 2 dedicated slow-IT job 引入时启用
- **FR-S07（限流规则，复用 + 新增）**：
  - 复用 `sms:<phone>` 60s 1 次（per RateLimitService 既有规则）
  - 复用 `sms:<phone>` 24h 10 次
  - 复用 `sms:<ip>` 24h 50 次
  - **新增** `auth:<phone>` 24h 5 次失败后锁 30min（独立 bucket，与历史 `register:<phone>` / `login:<phone>` bucket 替换合并）
- **FR-S08（事务原子性）**：phone-sms-auth use case **单一事务边界**内完成：
  - **执行顺序**：限流 → 验证码消费（Redis DEL） → 查 Account → 状态分支 → (新建 Account 或 updateLastLoginAt) → outbox event（仅新建路径） → Token 签发 → commit
  - 跨表写操作必须在事务内（Prisma `$transaction([...])` 或 nestjs-cls-transactional declarative），rollback on any error；并发同号通过 DB unique constraint + serialization isolation 兜底
- **FR-S09（响应 token 规格）**：access (JWT, TTL 15min) + refresh (random 256-bit, TTL 30day)；JWT secret 从环境变量 `AUTH_JWT_SECRET` 读取（fail-fast on missing）；签发由 `@nestjs/jwt` 实现
  - **Refresh token 持久化**：`RefreshTokenRecord` 表设计移到后续 use case；本 use case 仅签发 + 返回 + 不写持久化记录
- **FR-S10（错误响应格式）**：所有错误响应遵循 RFC 9457 ProblemDetail（`application/problem+json`）；由 NestJS `@Catch()` 全局异常 filter 映射
- **FR-S11（Outbox event）**：自动注册路径 publish `AccountCreatedEvent`（domain event，schema 见 plan.md）— 走 outbox pattern（domain event 持久化到 `outbox_event` 表，per 2026-05-17 W2.4 US2 decision；后台 worker 异步分发），技术选型在 plan.md 决定（候选：自实现 outbox + Prisma + node-cron / BullMQ + Redis）。**2026-05-19 amend**：legacy `event_publication` 表已 drop（per migration `2_drop_legacy_modulith_flyway_tables`）
- **FR-S12（命名 / 路由统一）**：本 use case 是 mono 首次实现 phone-sms-auth；不存在"删除既有 endpoint"动作。路由命名标准化：
  - `POST /api/v1/accounts/sms-codes`（发码，无 purpose 字段）
  - `POST /api/v1/accounts/phone-sms-auth`（统一登录注册）

### Client (App-side) Requirements (FR-C01 ~ FR-C15)

| ID     | 需求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-C01 | 单 form 容器（**无 tab**，无密码 / SMS 切换）；用户操作路径单一：phone → SMS code → submit                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-C02 | 手机号格式校验：客户端用 zod regex `/^\+861[3-9]\d{9}$/`；不合法 form invalid，submit 按钮 disabled；不区分大小写空格（trim 处理）                                                                                                                                                                                                                                                                                                                                                                                                        |
| FR-C03 | submit 调 `~/auth` 的 phone-sms-auth wrapper（封装 Orval mutation hook `useAccountPhoneSmsAuthControllerAuth`，body `PhoneSmsAuthRequest`）；server 自动判 login/register（per FR-S05）                                                                                                                                                                                                                                                                                                                                                   |
| FR-C04 | SMS 触发：调 Orval mutation hook `useAccountSmsCodeControllerRequest`（body `RequestSmsCodeRequest`，**无 purpose 字段**，per FR-S04）；60s 倒计时锁按钮防重复点击                                                                                                                                                                                                                                                                                                                                                                        |
| FR-C05 | submit 成功后：`~/auth` 的 phone-sms-auth wrapper 内部调 `useAuthStore` 的 `setSession({accountId, accessToken, refreshToken})`；`AuthGate` (apps/mobile/app/\_layout.tsx) 监听 `isAuthenticated` 自动 `router.replace('/(app)/')`。Hook **不直调** router                                                                                                                                                                                                                                                                                |
| FR-C06 | 错误统一映射（client 错误映射 util，按 `AxiosError` 判别）：401 → "手机号或验证码错误"；429 → "请求过于频繁，请稍后再试"；`AxiosError` 无 `response`（网络错）/ 5xx → "网络异常，请检查网络后重试"；未知错 → "登录失败，请稍后再试"；**不区分 401 子码**（server 单接口 4 分支字节级一致，client 仅看 401 状态）                                                                                                                                                                                                                          |
| FR-C07 | 三方 OAuth 圆形按钮 placeholder：press 弹 toast "<provider> 登录 - Coming in M1.3"；不调任何后端：<br>- 微信（绿色）：iOS / Android / Web 全平台渲染<br>- Google（多彩 G）：iOS / Android / Web 全平台渲染<br>- Apple（黑色苹果）：**iOS only**（`Platform.OS === 'ios'` 条件）                                                                                                                                                                                                                                                           |
| FR-C08 | **已废（2026-05-29 移除）**：原顶部 close `×` 按钮（per mockup v2，2026-05-04 落地，press 时 router.back / 否则 noop）。login 为 `(auth)` 入口路由，无 navigation history → `router.back` 恒为 noop，占位件点击无反应且误导用户，故从 UI 移除。M1.3 若登录改 modal 化（从他处 push 进入、有 history）再评估关闭入口。（更早历史：原 "立即体验" 游客模式占位 per mockup v2 已废，游客模式 M2 评估时再决定 UI 入口位置）                                                                                                                    |
| FR-C09 | 底部 "登录遇到问题" placeholder：press 弹 toast "帮助中心 - Coming in M1.3"；不调后端                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| FR-C10 | SMS "获取验证码" 按钮：成功 / 失败均不区分 toast（成功静默 + 60s 倒计时；失败也只 toast 通用错，**不暴露**"未注册"或"已注册"信号）                                                                                                                                                                                                                                                                                                                                                                                                        |
| FR-C11 | 状态机 5 态 idle / requesting_sms / sms_sent / submitting / (success \| error)；**submit gating**：login 按钮 disabled 当 `!smsSent \|\| !formState.isValid`（`smsSent` 闩锁仅在 `requestSms` 成功后置 true，提交报错保持，`dismissFreeze` 重置）——即用户必须先成功请求验证码才可点"登录"（合法 6 位码只可能在请求后存在）；submitting 期间 submit 按钮 disabled + loading 视觉；success 短动画 ≤ 800ms（绿色对勾 reanimated scale-in）后 AuthGate 接管切走；error 展示 errorToast；error 状态下任意 input change 清空 errorToast 回 idle |
| FR-C12 | 401 → refresh：root layout 已 mount AuthGate（`apps/mobile/app/_layout.tsx`），未登录态进 `/(app)/*` 自动跳 `/(auth)/login`；access token 过期场景由 `~/auth` 的 axios 拦截器透明 refresh（`refreshOnce` / `refreshTokenFlow`），不在本 spec 责任范围                                                                                                                                                                                                                                                                                     |
| FR-C13 | a11y：所有交互 component（input / submit / OAuth / 登录遇到问题 / 获取验证码）必有 `accessibilityLabel`；submit 按钮 disabled 时 `accessibilityState.disabled = true`；错误 toast 使用 `accessibilityLiveRegion='polite'`（Android）/ `accessibilityRole='alert'`（iOS / Web）                                                                                                                                                                                                                                                            |
| FR-C14 | **无 legacy 删除动作**：mono `apps/mobile/app/(auth)/login.tsx` 为全新单 form 落地（当前仅 PHASE 1 占位），旧 meta app 的双 tab（password / sms 切换） / `<PasswordField>` / `loginPasswordSchema` / `loginByPassword` / "忘记密码" / "创建一个" / register 路由在 mono 从不存在,无可删                                                                                                                                                                                                                                                   |
| FR-C15 | `errorScope` 双场景（per mockup v2 设计）：hook (`useLoginForm`) 维护 `errorScope: 'sms' \| 'submit' \| null` 字段；`requestSms` 抛错时 setErrorScope('sms')，`submit` 抛错时 setErrorScope('submit')；UI 据此决定哪个 input 标红边框 + ErrorRow 在哪一栏下方渲染（PhoneInput 旁还是 SmsInput 旁）；clearError / 任意 input change → setErrorScope(null)                                                                                                                                                                                  |

### Key Entities

- **Account（聚合根）**：复用既有 Account；本 use case 不引入新字段
  - `email` 字段保留 schema 但不写入新值（`[DEPRECATED M1.2]`，per PRD 修订）
  - `password_hash` 字段保留 schema 但**不写入新值且不被读取**（mono `BcryptTimingDefenseExecutor` 用固定内存常量作 dummy hash input，不依赖此列，per 2026-05-17 Changelog (c)；M2+ 评估真删该字段）
- **新增**：无（不引入新聚合根 / 实体 / 值对象）
- **删除**：无（domain 层无变化；删的是 application / web / DTO 层）

## Success Criteria _(mandatory)_

### Server Measurable Outcomes (SC-S01 ~ SC-S07)

- **SC-S01**：P1 主流程（User Story 1 + 2）端到端 P95 ≤ **600ms**（不含 SMS gateway 调用，从 `/phone-sms-auth` 入到 200 响应）
- **SC-S02**：100 个不同 phone 并发 `/phone-sms-auth` 请求（混合已注册 / 未注册）—— **0 错误，token 数 = 请求数；新建 Account 数 = 未注册请求数**
- **SC-S03（核心反枚举）**：`/phone-sms-auth` 对 **3 种分支**响应（已注册 ACTIVE 成功 / 未注册自动注册成功 / ANONYMIZED + 码错共反枚举吞）的 status / body / headers / P95 时延**字节级一致 / 时延差 ≤ 50ms**；由 `SingleEndpointEnumerationDefenseIT` 1000 次请求验证。**FROZEN 单独由 spec D `expose-frozen-account-status` SC-001 `FrozenAccountStatusDisclosureIT` 验证 disclosure 行为**（不在本 IT 覆盖范围）
- **SC-S04**：限流准确性 — FR-S07 全部 4 条规则集成测试验证生效，错误返回 429 + 正确 `Retry-After`
- **SC-S05**：`/sms-codes` 入参不含 purpose 字段（per FR-S04）；OpenAPI spec 反映新形态
- **SC-S06**：3 个旧 endpoint（`register-by-phone` / `login-by-phone-sms` / `login-by-password`）从 OpenAPI spec 完全消失；前端 `pnpm api:gen` 后旧 API class 自动删除
- **SC-S07**：mono `auth` NestJS Module 通过 `eslint-plugin-boundaries` 4 类规则验证（domain 零依赖 / web ↛ infra / 跨 module 经 api / shared ↛ business module，per Constitution Principle IV）；CI lint 0 violation

### Client Measurable Outcomes (SC-C01 ~ SC-C09)

| ID     | 标准                                                                                                                                                                                                                     | 测量方式                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| SC-C01 | User Story 1-5 全部 happy path 单测通过                                                                                                                                                                                  | `pnpm --filter mobile test` 全绿                                                                     |
| SC-C02 | 反枚举字节级一致（client 视角）：User Story 1 happy（已注册）vs User Story 2 happy（未注册）→ submit 后 state 转移 / errorToast / store.session 写入 / router.replace 调用方式完全一致；client 代码无 phone-existed 分支 | 单测断言两 case 完全 equal（含 state machine snapshot）                                              |
| SC-C03 | 401 自动 refresh 透明：组件层不感知 access token 过期                                                                                                                                                                    | packages/api-client 已有测试覆盖；本 spec 仅"不破坏"约束                                             |
| SC-C04 | 限流场景 (HTTP 429) 提示用户友好且不暴露后端细节                                                                                                                                                                         | 单测 mock 429 → 断言 errorToast = FR-C06 定义                                                        |
| SC-C05 | a11y：所有交互 component 有 accessibilityLabel + 错误用 alert role                                                                                                                                                       | 手测（浏览器 axe DevTools / iOS VoiceOver）+ ESLint react-native-a11y rule（如启用）                 |
| SC-C06 | placeholder 路径（OAuth / 登录遇到问题）不调任何后端 API                                                                                                                                                                 | 单测断言 `requestSmsCode` / `phoneSmsAuth` mock 调用次数 = 0                                         |
| SC-C07 | 视觉 token 化 100%：login.tsx + 关联 `~/ui` 组件零 hex / px / rgb 字面量                                                                                                                                                 | grep `apps/mobile/app/(auth)/login.tsx` + `apps/mobile/src/ui/**` 无 `#[0-9a-f]{3,8}` / `\d+px` 命中 |
| SC-C08 | Apple 按钮 Android conditional render：`Platform.OS === 'android'` 时 Apple Button 不出现在渲染树                                                                                                                        | 单测 mock `Platform.OS = 'android'` → 断言 `<AppleButton>` 不渲染；mock `'ios'` → 断言 渲染          |
| SC-C09 | 三端跑通：浏览器 (RN Web) M1.2 必须；iOS / Android M2 真机渲染                                                                                                                                                           | dev 期手测 + Playwright runtime-debug.mjs（详 `docs/experience/claude-design-handoff.md` § 6）       |

## Clarifications

> Server 端 6 点澄清于 2026-05-04 完成（CL-006 由 2026-05-07 spec D ship 引入）。Client 端 Open Questions 见下方独立段落。

### CL-001：FROZEN / ANONYMIZED 账号在新模式下如何反枚举 _[from server]_

**Q**：旧模式 register / login 双接口分别处理 phone 状态；新模式单接口下 FROZEN 账号尝试登录 / ANONYMIZED 账号 phone 被新用户尝试时，如何避免暴露状态？

**A**：FR-S05 明确分支 + FR-S06 timing defense。FROZEN 账号→反枚举吞为"码错"（CL-006 后改为显式 disclosure）；ANONYMIZED 账号 phone 字段被匿名化为 NULL（per PRD § 5.5），故 ANONYMIZED 账号的"phone"在新 phone-sms-auth 路径下视为"未注册"——可被任意人重新注册（unified auth default 路径），但绑定为新 accountId（不恢复匿名化数据，per PRD § 5.5"不可逆"）。

**落点**：FR-S05 显式 3 分支；User Story 3 含 FROZEN / ANONYMIZED 双场景；Edge Cases 不再有"匿名化 phone 重新注册" 段（自然成为 User Story 2 的子场景）。

### CL-002：`/sms-codes` 删 purpose 字段是否破坏 OpenAPI 兼容 _[from server]_

**Q**：旧 `/sms-codes` 入参支持 `purpose: "register" | "login"`（per login-by-phone-sms FR-009）；新模式删此字段，前端老版本 client 调用会兼容失败吗？

**A**：M1 阶段无真实用户 + 客户端 + server 同 PR 周期发布 → 不需要 backward compat。OpenAPI spec 直接 breaking change（删 `purpose` 字段）；前端 `pnpm api:gen` 拉新 spec 后 TS 类型自动更新。

**落点**：FR-S04 明确删 purpose；Out of Scope 加"backward compat for old clients"。

### CL-003：dummy hash 计算的输入来源 _[from server]_

**Q**：旧 register-by-phone FR-013 dummy hash 用 static final 常量 hash；新模式下 FROZEN / ANONYMIZED 账号已存在但 status 非 ACTIVE，是否对其 phone 计算？

**A**：仍用 static final 常量 hash（与既有 `TimingDefenseExecutor` 一致），**不**针对具体 phone / 账号计算（避免引入侧信道）；dummy hash 输入完全静态，仅消耗 CPU 时间。复用既有实现，本 use case 不引入新代码。

**落点**：FR-S06 复用 `TimingDefenseExecutor`，无新增。

### CL-004：自动注册路径并发同号 _[from server]_

**Q**：未注册 phone 在极短时间内被两个客户端同时提交（如重发 SMS 后 race），server 如何避免双 Account 创建？

**A**：DB `account.phone` partial unique index（per PRD § 2.1）+ 事务 SERIALIZABLE isolation level 兜底；duplicated insert 异常 catch → 回退到已注册路径（视作 User Story 1）。FR-S08 显式声明事务边界 + 异常处理。

**落点**：FR-S08 + Edge Cases "并发同号"段。

### CL-005：refresh token 持久化沿用 Phase 1.3 计划 _[from server]_

**Q**：本 use case 不写 RefreshTokenRecord（与既有 register / login 一致），客户端拿到的 refresh token 此时无服务端 revoke 路径——M1.2 阶段是否引入持久化？

**A**：不。Phase 1.3 use case (`refresh-token`) 引入持久化时**统一回填**本 use case + 既有 register / login（虽然 register / login 旧 use case 在 phone-sms-auth 落地时即被删，但回填指 phone-sms-auth 的 token 签发路径）；M1.2 阶段窗口期内客户端拿 refresh token 等同于"30 天内随便用"（无 revoke 通道）。

**落点**：FR-S09 注 "refresh token 持久化在 Phase 1.3 统一回填"；Out of Scope 加"1.x 内自行管理 RefreshTokenRecord"。

### CL-006：FROZEN 反枚举边界变更（per spec D `expose-frozen-account-status`） _[from server]_

**决议**：FROZEN 不再反枚举吞，改为显式 disclosure 返 HTTP 403 + `ACCOUNT_IN_FREEZE_PERIOD`；ANONYMIZED 仍反枚举吞 401 INVALID_CREDENTIALS。

**理由**：

1. PRD § 5.4 + § 7 既定语义；
2. 下游 spec C `delete-account-cancel-deletion-ui` 拦截 modal 设计依赖此 disclosure 信号；
3. ANONYMIZED 是不可逆终态，反枚举防 phone 时序复用攻击价值高；
4. FROZEN 是用户主动注销知情态，信息泄露面小。

**落点**：本 spec FR-S05（第 3 分支拆开 FROZEN/ANONYMIZED 单独表述）+ FR-S06（timing defense 范围明示，FROZEN 不参与）+ SC-S03（IT 路径数 4→3）。FROZEN disclosure 完整业务行为定义待 Account 相关 use case 迁入时补充。

### Client Open Questions _[from app]_

| #   | 问                                                | 决议                                                                                                             |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | "立即体验"游客模式具体行为                        | M2 / M3 决定；M1.2 仅 placeholder toast（mockup v2 落地后已废 entry，等 M2 决策再加）                            |
| 2   | Apple 按钮 Android 端 conditional render 由谁负责 | login.tsx 用 `Platform.OS === 'ios'` 判（不下沉到 ~/ui — AppleButton 组件本身跨端可渲染，由 caller 决定）        |
| 3   | mockup v1（双 tab）design/source/ 是否删除        | 保留作历史参考（visual tokens / `~/theme` token 仍有效）；加 design/SUPERSEDED.md 指针指向 v2                    |
| 4   | 重做 mockup 是否复用 v1 token 命名                | ✅ 复用（`~/theme` token 命名 ink/line/surface/ok/warn/err/accent/brand 不变；新 mockup 仅改 layout / 区域结构） |

## Assumptions

### Server Assumptions

- **A-S01**：复用既有 register-by-phone Assumptions A-001 ~ A-005（SDK / Redis / JWT secret / BCrypt cost / Token TTL）— 仅命名上的 use case 变了，基础设施假设不变
- **A-S02**：M1 阶段 v0.x.x 无真实用户；删旧 endpoint + 改 OpenAPI breaking 是可接受的（per CL-002）
- **A-S03**：DB `password_hash` 字段保留 schema 仅作 timing defense dummy hash 输入；M2+ 评估真删该字段
- **A-S04**：`AccountCreatedEvent` 既存事件类 schema 不变；新模式自动注册路径复用此事件 publish 到 outbox
- **A-S05**：阿里云 SMS Template A 审批已就绪（既有 register-by-phone use case 已审过）；Template C 配置废弃不影响审批资源

### Client Assumptions & Dependencies

- `~/auth` phone-sms-auth wrapper **本轮落地**（封装 Orval mutation hook `useAccountPhoneSmsAuthControllerAuth`，body `PhoneSmsAuthRequest` → response `PhoneSmsAuthResponse`）
- Orval mutation hook `useAccountSmsCodeControllerRequest`（body `RequestSmsCodeRequest`，无 purpose 字段）已随 server ship + `pnpm nx affected --target=generate` 生成于 `packages/api-client/src/generated/accounts/`
- AuthGate / `<Redirect>` root-layout 保护逻辑已落地（`apps/mobile/app/_layout.tsx`）
- `expo-router` v6+ + `useRouter().replace()` 可用
- `Platform` from `react-native` 用于 Apple Android conditional render
- 新版 mockup 若产出，落 `specs/001-phone-sms-auth/design/`（per sdd.md mockup 留迹路径）；旧 v1 design bundle 标 SUPERSEDED 但保留 visual tokens（`~/theme` 仍生效）

## Out of Scope

### Server Out of Scope

- **`refresh-token` use case**（token 刷新 + RefreshTokenRecord 持久化）— Phase 1.3 引入
- **`logout-all` use case**（退出所有设备 + revoke RefreshTokenRecord）— Phase 1.4 引入
- **微信 / Google / Apple OAuth** — M1.3 引入
- **运营商一键登录 SDK**（中国移动 / 联通 / 电信免密验证）— M2+ 评估
- **二维码扫码登录** — M2+ 移动端启用后引入
- **Backward compat for old clients calling `/register-by-phone` / `/login-by-phone-sms` / `/login-by-password`** — per CL-002 拒绝；M1 v0.x.x 无真实用户
- **DB schema 真删 `email` / `password_hash` 字段** — M2+ 评估
- **1.x 内自行管理 RefreshTokenRecord** — per CL-005 推迟到 Phase 1.3
- **找回密码 / 修改密码** — password 已废；新模式下"忘记密码"在 UX 中无入口

### Client Out of Scope（M1.2 显式不做）

- 微信 / Google / Apple OAuth **真实流程**（M1.3）；M1.2 仅 placeholder 圆形按钮，press 弹 "Coming in M1.3" toast
- "立即体验" 游客模式真实功能（M2/M3 评估）
- "登录遇到问题" 帮助中心（M1.3）
- 中国运营商一键登录 SDK（中国移动 / 联通 / 电信免密验证；M2+ 评估）
- 二维码扫码登录（M2+ 移动端真机时）
- 多端会话管理（"踢掉其他设备"等，M3+ 内测前）
- iOS / Android 真机渲染验证（M2.1）
- 国际化 / 多语言（M3+）
- 视觉细节（精确 px / hex / 阴影偏移 / 字重值）— 走 mockup → plan.md UI 段吸收
- **register 独立页**（不做；登录注册合一，mono 无 register 独立路由）
- **密码登录 / 忘记密码 / 修改密码**（整套废弃）
- **邮箱登录 / 邮箱注册 / Google email-only 账号**（已废）

## Change Log

- **2026-05-04** — Client 端 spec 整体重写为 unified phone-SMS auth。原 2026-05-03 双 tab 版本（含密码 + 短信 tab + 跳 register）整段废弃；旧 design/source mockup 标 SUPERSEDED；packages/ui 既有 12 组件保留 8，M1.3 impl PR 删 PasswordField + 加 WechatButton + AppleButton。
- **2026-05-07** — Server 端 spec D `expose-frozen-account-status` ship — FR-S05 第 3 分支拆开 FROZEN/ANONYMIZED 单独表述；FR-S06 timing defense 范围明示（FROZEN 不参与）；SC-S03 路径数 4→3；新增 Clarifications CL-006 引用 spec D。本 amendment 与 spec D 同 PR 合入（防 spec drift > 1 week，per constitution Anti-Patterns）。
- **2026-05-17** — mono W2 amend：(a) FR-S11 outbox 表名 `event_publication` → `outbox_event`（per W2.4 US2 决策；legacy 表保留不动）；(b) User Story 3 Acceptance Scenarios L70-73 narrative 保留 pre-CL-006 的早期描述作上下文，实施严格按 FR-S05/FR-S06/SC-S03 post-CL-006 amended terms（FROZEN→403 disclosure，ANONYMIZED→401 反枚举吞 + dummy bcrypt timing pad）；(c) `TimingDefenseExecutor` 用 TS + `bcrypt` npm 包实现，dummy hash input 用固定内存常量（不需 DB password_hash 列）；(d) ANONYMIZED 测试 setup 用 phone NOT NULL hack 触达 code path（生产中 phone 应 NULL per PRD § 5.5，测试为覆盖反枚举行为路径需要 denormalized state）。
- **2026-05-18** — **FR-S03 / FR-S06 storage amend**：SMS code Redis 存储算法从 bcrypt cost=12 切到 HMAC-SHA256 + `crypto.timingSafeEqual`，per [ADR-0023](../../docs/adr/0023-sms-code-storage-hmac.md)。根因 = W3 deferred Item 4 `SingleEndpointEnumerationDefenseIT`（mono PR #23）实测 200-rep diff ≈ 193ms，违反 FR-S06 P95 ≤ 50ms。新机制 verify <1ms 让 3 个反枚举 401 路径时延自然均一,`BcryptTimingDefenseExecutor.pad`(cost=10) 保留作纵深防御。新增 env `SMS_CODE_HMAC_SECRET` fail-fast；Key Entities `password_hash` 注脚补充"不被读取"。
- **2026-05-19** — **Path rename**: spec dir 从 `specs/auth/phone-sms-auth/` 重命名为 `specs/001-phone-sms-auth/`（per [ADR-0024](../../docs/adr/0024-spec-feature-first-layout.md) feature-first 扁平布局）；frontmatter `modules: [auth]` / `owners` / `status: implemented` 同步添加。**业务内容 0 变化**，仅目录结构 + cross-doc ref 调整。
- **2026-05-19** — **Legacy schema cleanup**：Plan 2 Phase 0 § 2.2.1 落 migration `2_drop_legacy_modulith_flyway_tables`：DROP legacy `event_publication` + `flyway_schema_history` 表（早期 db pull 反推进来的非业务表）。`outbox_event` + 5 `account` 业务表全保留。FR-S11 amend "legacy 表保留不动" 条款由本次 cleanup 落地。

## References

- [ADR-0023 SMS code 存储 — HMAC](../../docs/adr/0023-sms-code-storage-hmac.md)（FR-S03 / FR-S06 storage）
- [ADR-0024 spec feature-first 布局](../../docs/adr/0024-spec-feature-first-layout.md)（本 spec 目录结构）
- 限流方案见 [ADR-0022](../../docs/adr/0022-throttler-nestjs-redis.md)（FR-S07）

相关上游业务决策（unified auth 业务范围 / Account 状态机 FROZEN·ANONYMIZED 终态 / refresh token revoke）将在对应 ADR 迁入 mono 后补充。
