[TASK CLOSURE CONVENTION — prepended by michael-speckit-presets/task-closure preset]

Every task heading uses spec-kit native checkbox state:

- `- [ ]` = pending
- `- [X]` = completed (flipped by /speckit.implement after the task ships)

**Per-task closure protocol** (executed inside /speckit.implement):

1. Complete TDD cycle (red → green); pass lint + typecheck.
2. In tasks.md, flip the task heading's `[ ]` to `[X]`.
3. `git add` implementation + tests + **tasks.md in the same stage**.
4. Proceed to commit.

**Hard rule**: tasks.md MUST be staged in the same commit as implementation
code. The /speckit-tasks-verify hook (after_implement) reports any divergence.

[END TASK CLOSURE CONVENTION]

[CONTEXT7 GROUNDING (IMPLEMENT PHASE) — prepended by michael-speckit-presets/context7-injection preset]

When /speckit.implement executes a task that uses a third-party library
class / function / API (i.e., NOT project-internal code or well-established
stdlib):

1. BEFORE writing the impl, call `mcp__context7__query-docs` with a specific
   question about the EXACT API surface needed.
2. Verify the import path + method signature match current docs.
3. If the impl-time API diverges from what plan.md cited, note the divergence
   in the impl commit message.

[END CONTEXT7 GROUNDING (IMPLEMENT PHASE)]

---

# Tasks: Phone SMS Auth (W2 server scope)

**Input**: Design documents from [`specs/001-phone-sms-auth/`](./)
**Prerequisites**: spec.md ✅ + plan.md ✅
**Tests**: **MANDATORY**（Constitution Principle II Test-First TDD NON-NEGOTIABLE）— 不是 OPTIONAL

**Organization**: Tasks 按 spec User Story 分 phase；US1/US2/US3 是 P1 server-impl 焦点；US4 限流 defer W3；US5 client-only defer W4+。

## Format

`[ID] [P?] [Story] Description in src/path/file.ts`

- **[P]**: 可并行（不同文件 + 无依赖）
- **[Story]**: US1 / US2 / US3 / Foundational（不绑 US）
- 路径相对 mono root

## Path Conventions

- Source: `apps/server/src/auth/{domain,application,infrastructure,web}/`
- Test: 单测与源码 co-located（`*.spec.ts`）；integration test `apps/server/test/integration/`
- DB / Redis 走 mono `docker-compose.dev.yml`（已启 5433 / 6380）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Constitution IV gate + 测试框架 + lint 闭环。Implement 前 mandatory。

- [X] T001 装 vitest 2 + @nx/vite + 配 nx test target 在 `apps/server/project.json`（Constitution II TDD prerequisite；CI 加 `Test (nx test server)` job + mono ruleset required check）
- [X] T002 装 `eslint` 9 flat config + `@nx/eslint` + `eslint-plugin-boundaries` + 配 4 类规则在 `apps/server/eslint.config.mjs`（domain ↛ infra/web / web ↛ infra / 跨 module 经 api / shared ↛ business）+ 配 nx lint target；CI 加 `Lint (nx lint server)` job + ruleset required check（Constitution IV gate）
- [X] T003 [P] 装 `class-validator` `class-transformer` 已在 W1.4 ship；verify `apps/server/main.ts` 全局 `ValidationPipe({ transform: true, whitelist: true })` 已配（spec FR-S04）— **verified** main.ts:1+18
- [X] T004 [P] 验证 W1.4 db pull 后 Prisma schema 含 `account` 表（id / phone / status enum / created_at / last_login_at）+ `event_publication` 表（id / event_type / payload Json / published_at / created_at）；缺则补 migration（FR-S11 outbox）— **verified** schema.prisma 含 model account / model event_publication

**Checkpoint**: Setup done → nx test / nx lint 在 CI 必跑；implement phase 可启动

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 跨 US 复用基础设施（VO / ports / module skeleton / global filter）；所有 US 实现前必跑完

- [X] T005 创建 `apps/server/src/auth/auth.module.ts` skeleton（NestJS `@Module({ imports: [], providers: [], exports: [] })`）+ 在 `app.module.ts` import；空 module 跑通 server bootstrap（typecheck pass）
- [X] T006 [P] 实装 RFC 9457 `ProblemDetailFilter` in `apps/server/src/auth/infrastructure/problem-detail.filter.ts`（NestJS `@Catch()` 全局 filter；映射 `BadRequestException` / `UnauthorizedException` / `HttpException` → `application/problem+json`）+ 单测 (FR-S10)
- [X] T007 [P] [Domain] 实装 Phone VO in `apps/server/src/auth/domain/phone.vo.ts`（E.164 +86 regex 校验 `/^\+861[3-9]\d{9}$/` + trim + immutable class）+ 单测覆盖合法 / 不合法 / 边界
- [X] T008 [P] [Domain] 实装 SmsCode VO in `apps/server/src/auth/domain/sms-code.vo.ts`（6 digit `^\d{6}$` + immutable + verify(other) 方法）+ 单测
- [X] T009 [Infra] 实装 `JwtTokenService` in `apps/server/src/auth/infrastructure/jwt-token.service.ts`（封装 `@nestjs/jwt` `JwtService.sign(payload, { expiresIn: '15m' })` + `crypto.randomBytes(32).toString('base64url')` 生 256-bit refresh；从 `ConfigService.getOrThrow('AUTH_JWT_SECRET')` 拿 secret）+ 单测（FR-S09）
- [X] T010 [P] [Domain] 实装 `Account` aggregate in `apps/server/src/auth/domain/account.aggregate.ts`（id / phone / status enum / lastLoginAt；business invariant `markLoggedIn()` / `isActive() / isFrozen() / isAnonymized()`）+ Prisma → Account adapter `Account.fromPrisma()` 工厂；单测
- [X] T011 [P] [Domain] 实装 4 个 port interface in `apps/server/src/auth/application/ports/`：
  - `account.repository.port.ts`（`findByPhone(phone) / save(account) / updateLastLoginAt(id)`）
  - `sms-code.repository.port.ts`（`store(phone, code, ttlSec) / verify(phone, code): boolean | null / clear(phone)`）
  - `sms-gateway.port.ts`（`sendCode(phone, code): Promise<void>`）
  - `outbox-publisher.port.ts`（`publish(eventType, payload): Promise<void>`）
  + 单测（interface 本身无测，但 fake 实现给后续 use case test 用）
- [X] T012 [P] [Domain] 实装 `AccountCreatedEvent` in `apps/server/src/auth/domain/events/account-created.event.ts`（payload `{ accountId, phone, createdAt }`，类型 export 给 outbox 消费）+ 类型 test

**Checkpoint**: Foundational ready → US1/US2/US3 implementation 可启动（per 5 原则 III Atomic Task + II Test-First）

---

## Phase 3: User Story 1 — 已注册主流程 (P1) 🎯 MVP

**Goal**: ACTIVE 账号 phone+code 主流程登录，签 token + 更新 `last_login_at`

**Independent Test**: Testcontainers 启 PG+Redis+MockSms；preseed ACTIVE account → POST `/sms-codes` → POST `/phone-sms-auth` → 200 + tokens；DB last_login_at 更新

### Tests for US1 (Test-First per Constitution II)

- [X] T013 [P] [US1] [Test] Vitest unit test for `AccountPrismaRepository.findByPhone` in `account.prisma.repository.spec.ts`（Testcontainers PG）— RED
- [X] T014 [P] [US1] [Test] Vitest unit test for `SmsCodeRedisRepository.store + lookup + clear` in `sms-code.redis.repository.spec.ts`（Testcontainers Redis）— RED
- [X] T015 [P] [US1] [Test] Vitest unit test for `RequestSmsCodeUseCase`（mock SmsGateway + SmsCodeRepo）— RED
- [X] T016 [P] [US1] [Test] Vitest unit test for `PhoneSmsAuthUseCase` 已注册路径（mock AccountRepo + SmsCodeRepo + JwtTokenService）— RED
- [X] T017 [P] [US1] [Test] Vitest e2e test `accounts.smoke.us1.e2e.spec.ts`（Testcontainers + Nest app + Fastify; preseed ACTIVE → POST endpoints → 200 assertions）— RED

### Implementation for US1

- [X] T018 [Infra] [US1] 实装 `AccountPrismaRepository` in `apps/server/src/auth/infrastructure/account.prisma.repository.ts`（依赖 `PrismaService`；method `findByPhone` / `save` / `updateLastLoginAt`）— GREEN T013
- [X] T019 [Infra] [US1] 实装 `SmsCodeRedisRepository` in `apps/server/src/auth/infrastructure/sms-code.redis.repository.ts`（依赖 ioredis client；`store(phone, code, ttl=300)` 写 `sms_code:<phone>` = bcrypt hash；`lookup` 取 + compare；`clear` del）— GREEN T014
- [X] T020 [Infra] [US1] 实装 `MockSmsGateway` in `apps/server/src/auth/infrastructure/mock-sms.gateway.ts`（in-memory Map<phone, code>；log "发出"；export `getLastCode(phone)` 给 test 读）（W2 占位，W3 替 Aliyun）
- [X] T021 [App] [US1] 实装 `RequestSmsCodeUseCase` in `apps/server/src/auth/application/request-sms-code.usecase.ts`（gen 6 digit code → store Redis + send via SmsGateway；returns void or `{ ttl }`）— GREEN T015
- [X] T022 [App] [US1] 实装 `PhoneSmsAuthUseCase` 已注册路径 in `apps/server/src/auth/application/phone-sms-auth.usecase.ts`（findByPhone → 若 ACTIVE + code 匹配 → `markLoggedIn()` + `updateLastLoginAt` + sign tokens；返回 `{ accountId, accessToken, refreshToken }`）— GREEN T016
- [X] T023 [Web] [US1] 实装 `AccountSmsCodeController` in `apps/server/src/auth/web/account-sms-code.controller.ts`（`POST /api/v1/accounts/sms-codes` + DTO `RequestSmsCodeRequest`）+ `AccountPhoneSmsAuthController` `POST /api/v1/accounts/phone-sms-auth` + DTOs；class-validator 装饰器 + transform；register in `auth.module.ts`
- [X] T024 [US1] E2E smoke pass: GREEN T017（preseed ACTIVE account via Prisma 直接 insert → 2 endpoints 200 → tokens 验证 + last_login_at DB check）

**Checkpoint**: US1 MVP — 主流程已注册登录跑通；前后端可冒烟（前端 W4+ 接入时复用）

---

## Phase 4: User Story 2 — 未注册自动注册+登录 (P1 并列)

**Goal**: 未注册号 phone+任意 code（实际 code 来自 sms-codes endpoint）→ server 静默 transactional 创建 Account ACTIVE + 写 outbox event + 签 token；响应字节级与已注册路径同

**Independent Test**: 未注册 phone → POST `/sms-codes` → POST `/phone-sms-auth` → 200 + tokens；DB 新 account row（ACTIVE）；event_publication 新 outbox row

### Tests for US2

- [X] T025 [P] [US2] [Test] Vitest unit `OutboxEventPrismaPublisher` in `outbox-event.prisma.publisher.spec.ts`（Testcontainers PG；assert `outbox_event` row 写入 with event_type + payload Json + published_at = null）— RED
- [X] T026 [P] [US2] [Test] Vitest unit `PhoneSmsAuthUseCase` 未注册路径（mock; assert: account.save + outboxPublisher.publish 都被调；返回 token）— RED
- [X] T027 [P] [US2] [Test] Vitest unit 并发同号自动注册 race（Testcontainers PG；2 parallel `phone-sms-auth` for same NEW phone → 仅 1 row + 同 accountId 返）— RED
- [X] T028 [P] [US2] [Test] Vitest e2e `accounts.smoke.us2.e2e.spec.ts`（未注册 phone → 2 endpoints → 200 + tokens + DB new account row + outbox row）— RED

### Implementation for US2

- [X] T029 [Infra] [US2] 实装 `OutboxEventPrismaPublisher` in `apps/server/src/auth/infrastructure/outbox-event.prisma.publisher.ts`（Prisma `outbox_event.create({ data: { event_type, payload, published_at: null } })`；publish 接受 client 首参由 caller 传 tx context；写新表 `outbox_event` — legacy `event_publication` 保留不动）— GREEN T025
- [X] T030 [App] [US2] PhoneSmsAuthUseCase amend 未注册路径（findByPhone returns null → verify code first → wrap in `prisma.$transaction` with `isolationLevel: 'Serializable'`: `tx.account.create` + `outboxPublisher.publish(tx, AccountCreatedEvent.type, payload)` + sign tokens；catch P2002 unique constraint violation → fallback to login path per FR-S08 sub-clause；ctor 扩 5 参 + `auth.module.ts` 注册 OUTBOX_PUBLISHER provider）— GREEN T026 + T027
- [X] T031 [US2] E2E smoke pass: GREEN T028（响应 body / headers / status 与 US1 ACTIVE 路径**字节级一致**断言）

**Checkpoint**: US2 跑通；FR-S08 并发兜底验证；outbox event 写入

---

## Phase 5: User Story 3 — FROZEN/ANONYMIZED 反枚举 (P1 并列)

**Goal**: FROZEN / ANONYMIZED 账号即使提交正确 code 也返回 401 INVALID_CREDENTIALS（与码错完全一致字节级 + 时延 ≤50ms）

**Independent Test**: preseed FROZEN account + ANONYMIZED account；POST `/phone-sms-auth` with correct code → 401 与 ACTIVE+错码完全同响应；timing P95 差 ≤ 50ms

### Tests for US3

- [X] T032 [P] [US3] [Test] Vitest unit `PhoneSmsAuthUseCase` FROZEN 路径（mock FROZEN account with `freezeUntil` + correct code → throw `AccountInFreezePeriodException` (HTTP 403, body `code: ACCOUNT_IN_FREEZE_PERIOD`, `freezeUntil` ISO string)，不签 token，不调 markLoggedIn，**不走 timing pad** per CL-006）— RED
- [X] T033 [P] [US3] [Test] Vitest unit `PhoneSmsAuthUseCase` ANONYMIZED 路径（mock ANONYMIZED account with phone populated + correct code → dummy bcrypt timing pad runs → throw `UnauthorizedException('INVALID_CREDENTIALS')`，不签 token；assert `TimingDefenseExecutor.executeInConstantTime` was invoked）— RED
- [X] T034 [P] [US3] [Test] Vitest unit timing defense **3 anti-enum 401 paths**（mock ACTIVE+码错 / ACTIVE+码过期 / ANONYMIZED+正确码 → all run TimingDefenseExecutor dummy bcrypt → in-process P95 wall-clock 差 ≤ 5ms across 3 paths；FROZEN excluded per CL-006）— RED
- [X] T035 [P] [US3] [Test] Vitest e2e `accounts.smoke.us3.e2e.spec.ts` 反枚举（per CL-006 amended SC-S03）：(a) 3 个 401 路径 (ACTIVE+码错 / ANONYMIZED+正确码 / ANONYMIZED+码错) 响应 body+headers+status 字节级 equal；(b) FROZEN+正确码 → HTTP 403 + ProblemDetail body 含 `code: ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`（distinct from 401 反枚举吞）；(c) 不 assert P95 ≤ 50ms in e2e（推 W3+ 由独立 IT 覆盖，per spec FR-S06 referencing `SingleEndpointEnumerationDefenseIT`）— RED

### Implementation for US3

- [X] T036 [App] [US3] PhoneSmsAuthUseCase amend FROZEN/ANONYMIZED 路径（per CL-006）：findByPhone returns account；若 status=FROZEN → 取 `freezeUntil` → throw `AccountInFreezePeriodException(freezeUntil)`（disclosure，不签 token，不走 timing pad）；若 status=ANONYMIZED → 走 `TimingDefenseExecutor.pad()` dummy bcrypt → throw `UnauthorizedException('INVALID_CREDENTIALS')`；新增 `AccountInFreezePeriodException` 类 + amend `ProblemDetailFilter` 映射 → HTTP 403 + body { code, freezeUntil } — GREEN T032+T033
- [X] T037 [App] [US3] `BcryptTimingDefenseExecutor` 新写 (TS + `bcrypt` npm, cost=10, `pad()` 接口)；ACTIVE+码错 / ACTIVE+码过期 / ANONYMIZED+正确 / 未注册+码错 4 路径走 executor + dummy bcrypt 保证 timing 一致；新增 `bcrypt` + `@types/bcrypt` deps — GREEN T034
- [X] T038 [US3] E2E smoke pass: GREEN T035（3 个 401 路径 byte-equal + FROZEN 403 + freezeUntil disclosure；P95 ≤ 50ms 测量 defer W3+ `SingleEndpointEnumerationDefenseIT`）

**Checkpoint**: US3 反枚举验收；SC-S03 字节级一致 satisfied

---

## Phase N: Polish & V1/V2 Acceptance (W2 final)

**Purpose**: Plan 1 § E.3 V1/V2 验收 + cross-cutting cleanup

- [X] T039 [P] V1 验收：`cloc apps/server/src/auth` 测量 LoC + 对比旧实现等价类；ratio ≤ 1.5x 才 pass；写报告到 `specs/001-phone-sms-auth/v1-loc-report.md`
- [X] T040 [P] V2 验收：`pnpm nx run server:lint` 0 violation；手测 4 类规则各写 1 个 forbidden import → 验证 lint err；写报告到 `specs/001-phone-sms-auth/v2-boundary-report.md`（含 v5→v6 plugin migration drift 发现 + 修复：`eslint-plugin-boundaries` v6 + legacy `element-types` 语法静默 no-op，amend 为 `boundaries/dependencies` object-selector + `eslint-import-resolver-typescript`）
- [X] T041 [P] AccountCreatedEvent outbox subscriber placeholder：`OutboxEventCronPublisher.scan()` skeleton — 扫 `outbox_event` WHERE `published_at IS NULL` → mark as published（W2 不分发到真消费方，hook 点保留给 W3+ subscriber 接入；不引 `@nestjs/schedule` 新 dep，scan 触发由 W3+ cron infra 决定）
- [X] T042 V3 (CI required): mono main-protection ruleset amend 加 `Lint (nx lint server)` + `Test (nx test server)` 2 个 required check（gh api PUT ruleset 16500378，本 PR 直接以 6 required checks 验收）

---

## Phase O: W3 Infrastructure (rate limit + retry + Aliyun SMS)

**Purpose**: 实装 plan.md R0.2 (rate limit FR-S07) / R0.3 (Aliyun SMS FR-S03) / R0.5 (cockatiel retry) 三个 W2 显式 defer 的 deferred items。

**Ship 顺序**: A1 → A2 → A3 → A4（per memory `feedback_complex_external_dep_migration_last`：复杂外部 SDK 后迁不拖主线）。

**Sub-PR 拆分**: 4 个 sub-PR 对应 A1-A4，每个独立可 ship + auto-merge。

### A1 — ThrottlerModule infra + 第 1 条规则 (sms:&lt;phone&gt; 60s)

- [X] T043 [Infra] 装 dep `@nestjs/throttler` ^6.5.0 + `@nest-lab/throttler-storage-redis` ^1.2.0；`ThrottlerModule.forRootAsync` 配 Redis storage（独立 throttler Redis instance, 与业务 `REDIS_CLIENT` connection 解耦，best practice + 避免 DI ordering 风险）；默认 throttler config `name='sms-phone-60s', limit=1, ttl=60_000`；不全局注册 ThrottlerGuard（保留 controller-level `@UseGuards` 控制 scope，per A1 最小 scope 设计）
- [X] T044 [Web] [Test] `account-sms-code.controller.ts` 加 `@Throttle({ default: { limit: 1, ttl: 60_000 } })` + `@UseGuards(SmsPhoneThrottlerGuard)` (FR-S07 第 1 条 sms:&lt;phone&gt; 60s 1 次)；自定义 `SmsPhoneThrottlerGuard` extends `ThrottlerGuard` override `getTracker` 返回 `sms:<phone>` key (而非 IP)；Testcontainers Redis IT `account-sms-code.rate-limit.it.spec.ts` 2 cases：(a) 同 phone 60s 内第 2 次 → 429 + 标准 `Retry-After` header；(b) 不同 phone 仍 200 (tracker key 是 phone 不是 IP)

### A2 — FR-S07 剩 3 条规则 + 锁 30min + 集成 IT

- [X] T045 [Web] [Test] 加 sms:&lt;phone&gt; 24h 10 次 限流（module 多 throttler config + 复用 guard fallback `getTracker` 走 phone key；controller `@Throttle` decorator drop, throttler 6+ 默认 enforce 全部 module throttler）
- [X] T046 [Web] [Test] 加 sms:&lt;ip&gt; 24h 50 次 限流（per-throttler `getTracker` 返 `ip:<req.ip>` 覆盖 guard fallback）
- [X] T047 [App] [Test] auth:&lt;phone&gt; 5 次失败 → 锁 30min：新 `AuthFailureLockService` (Testcontainers Redis 单测 4 cases) + `AuthAttemptLockedException` domain exception (429) + `ProblemDetailFilter` 加 mapping (Retry-After header + body code `AUTH_ATTEMPT_LOCKED`) + `PhoneSmsAuthUseCase` 入口 wrap `executeInternal` (assertNotLocked → executeInternal → catch UnauthorizedException → recordFailure); 锁状态 100% Redis (per 2026-05-17 W3 起手 user choice "Redis lock store")

### A3 — RetryExecutor port + cockatiel adapter

- [X] T048 [App] [Infra] [Test] 抽 `application/ports/retry-executor.port.ts` interface (`execute<T>(operation: () => Promise<T>): Promise<T>`) + `infrastructure/cockatiel-retry.executor.ts` adapter (`wrap(retry maxAttempts=3 ExponentialBackoff initialDelay=200/maxDelay=2000, circuitBreaker ConsecutiveBreaker(5) halfOpenAfter=10s)` per plan.md R0.5) + unit spec 3 cases (success / transient retry 4 calls / exhausted throws); cockatiel 语义验证 `maxAttempts: N` = N retries + 1 initial = N+1 total (per 2026-05-17 W3 起手 user choice "RetryExecutor port + cockatiel adapter")
- [X] T049 [Infra] 装 dep `cockatiel` ^3.2.1；DI 注册到 `auth.module.ts` (RETRY_EXECUTOR token + CockatielRetryExecutor useClass; W3 SmsGateway 与未来其他外部调用复用 singleton breaker state)

### A4 — Aliyun SMS gateway skeleton + replace MockSmsGateway

- [X] T050 [Infra] 装 dep `@alicloud/dysmsapi20170525` ^4.5.1 + `@alicloud/openapi-core` ^1.0.7 (transitive promote 直接 dep 拿 `$OpenApiUtil.Config` 类型); 写 `aliyun-sms.gateway.ts` impl SmsGatewayPort: ctor 接 (client + signName + templateCode + retryExecutor) testable design; 静态 `createClient(cred)` 工厂; sendCode 内 phoneNumbers 去 +86 prefix + templateParam JSON + 接 RetryExecutor.execute(client.sendSms); response.body.code != 'OK' throw
- [X] T051 [Infra] [Test] `aliyun-sms.gateway.spec.ts` mock SDK + retry executor 4 cases: (a) success path 验 request 字段 (phone 去 +86 / signName / templateCode / templateParam JSON); (b) response code != OK throws; (c) SDK throw RetryExecutor 接到 propagate; (d) 国际号未来扩展 phone 保持原样; 真 SMS env-gated IT defer 到 cred + SignName/TemplateCode 审批后单独 PR (per 2026-05-17 W3 起手 user choice "Skeleton-only")
- [X] T052 [Infra] `auth.module.ts` SMS_GATEWAY provider useFactory: `SMS_GATEWAY=aliyun` → `getOrThrow ALIYUN_ACCESS_KEY_ID/SECRET/SIGN_NAME/TEMPLATE_CODE` fail-fast + new AliyunSmsGateway; `SMS_GATEWAY=mock` (default dev/test) → MockSmsGateway; inject [ConfigService, RETRY_EXECUTOR]

---

## Phase F: W3+ FR-S06 timing defense fix — SMS code storage HMAC 切换

**Purpose**: 修 W3 deferred Item 4 实证 spec gap — `SingleEndpointEnumerationDefenseIT` 200-rep diff ≈ 193ms 违反 FR-S06 P95 ≤ 50ms 阈值。根因 = `SmsCodeRedisRepository.verify` bcrypt cost=12 单边 ~150ms 仅 ACTIVE+码错路径触发,pad 抹不平。

**Ship 决策**: Option B(per project memory `project-fr-s06-timing-defense-spec-gap` + ADR-0023) — SMS code 存储从 bcrypt 改 HMAC-SHA256 + `crypto.timingSafeEqual`，verify <1ms 让 3 路径自然均一,pad 保留作纵深防御。

- [X] T053 [Infra] [Test] rewrite `apps/server/src/auth/infrastructure/sms-code.redis.repository.ts` 用 `crypto.createHmac('sha256', secret).update(code).digest('base64url')` 存 + `crypto.timingSafeEqual` 验; ctor 改 `(redis: Redis, hmacSecret: string)`; spec test `sms-code.redis.repository.spec.ts` 5 原 case + 3 新 case (HMAC deterministic / negative / secret rotation)
- [X] T054 [Infra] `auth.module.ts` SMS_CODE_REPOSITORY provider 从 `useClass` 改 `useFactory` 注入 `REDIS_CLIENT + ConfigService.getOrThrow('SMS_CODE_HMAC_SECRET')` fail-fast; `.env.example` 加 `SMS_CODE_HMAC_SECRET` doc 含轮换策略注脚
- [X] T055 [Test] 4 e2e IT (`accounts.us1/us2/us3.e2e.spec.ts` + `timing-defense.p95.it.spec.ts`) beforeAll 加 `process.env.SMS_CODE_HMAC_SECRET` setup; timing IT 头部 doc 反映新机制 (verify <1ms, pad ~80ms 单边支配, 3 路径均一)
- [X] T056 [Test] RUN_PERF_IT=true PERF_IT_REPS=200 实测 P95 PASS: p95Active_wrong 51.38ms / p95Active_expired 51.57ms / p95Anonymized_any 51.37ms / diff **0.20ms** << 50ms 阈值; 对比 PR #23 实证 diff ≈ 193ms (缩 ~1000x)
- [X] T057 [Docs] ADR-0023 `docs/adr/0023-sms-code-storage-hmac.md` Accepted (2026-05-18) 含 4 options 决策记录 + bcrypt vs HMAC trade-off + 验证证据
- [X] T058 [Spec] `spec.md` FR-S03 / FR-S06 / Key Entities `password_hash` / Change Log 4 处 amend; FR-S06 加 storage sub-clause + ADR-0023 link

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup** (T001-T004)：无依赖 → 立即可启
- **Phase 2 Foundational** (T005-T012)：依赖 Phase 1 → blocks all US
- **Phase 3-5 US1/US2/US3**：均依赖 Phase 2；US 之间**可并行**（不同 user 可写 — solo dev 顺序 P1 priority 同级，按 US1 → US2 → US3 顺序更稳）
- **Phase N Polish** (T039-T042)：依赖所有 US 完成

### Within Each US

- Test tasks（[Test]）MUST 在 implementation 前写完并 RED
- Domain → Infrastructure → Application → Web 自下而上
- 每 task 走 /implement 6 步闭环（红→绿→typecheck/lint→tasks.md `[X]`→stage→commit）

### Parallel Opportunities

- Phase 1 [P] tasks T003 / T004 可并行
- Phase 2 [P] tasks T006 / T007 / T008 / T010 / T011 / T012 可并行（不同文件）
- Phase 3-5 US 之间可并行（solo dev 串行更可控）
- Each US 内 [Test] tasks 都 [P]（不同 *.spec.ts 文件）
- Polish T039 / T040 / T041 可并行

---

## Implementation Strategy

### MVP 顺序

1. Phase 1 Setup → CI 加 lint + test job + ruleset required check（T042 在 polish 也再 amend 一次）
2. Phase 2 Foundational → 跑通空 module + global filter + VOs + ports
3. **US1 (T013-T024)** → MVP 第一刀，主流程跑通；ship 后 STOP-VALIDATE
4. **US2 (T025-T031)** → 加自动注册+outbox
5. **US3 (T032-T038)** → 加反枚举 + timing defense
6. Polish (T039-T042) → V1 LoC + V2 lint 验收报告

### Per-Task Closure 6 步（per task-closure preset + Constitution II/III）

每 task 走：

1. RED：写 *.spec.ts → vitest 跑 → 必报错
2. GREEN：写 impl → vitest 跑过
3. typecheck + lint pass（`pnpm nx run server:typecheck && pnpm nx run server:lint`）
4. tasks.md 该 task `[ ]` 翻 `[X]`
5. `git add` impl + spec + tasks.md 同 stage
6. commit message `feat(auth): <task summary> — T0NN`（per Conventional Commits + Constitution Quality Gates）

每 task 独立 commit；多 task 不混 commit；W2.4 implement 阶段全程禁止 PR 重 scope，每 task = 1 commit + 1 push（PR 累计 commits）

### Stop / Surface 信号（W2.4 implement 期间）

- 任何 task 撞 spec 歧义 → 停 + 问 user（不私自补 spec）
- 任何 task 需新增 npm dep → 停 + 问 user（per memory `feedback_complex_external_dep_migration_last`）
- 任何 task 是 destructive op（rm -rf / drop table / force push） → 停 + 问 user
- 任何 task 跨 PR scope（如改 mono main-protection ruleset） → 停 + 问 user

---

## Notes

- `[Story]` label 映射 spec User Stories 实现 traceability
- 每 US 应能独立 ship（US1 不依赖 US2 实装；US3 amend 接到 US1+US2 已实装的 PhoneSmsAuthUseCase）
- 测试 RED 必先于 impl GREEN（Constitution II NON-NEGOTIABLE）
- per-task closure protocol mandatory（task-closure preset hard rule + Constitution III）
- `[P]` tasks 表示不同文件可并行（solo dev 串行更稳，[P] 标记给未来多 dev 参考）

**Total tasks**: 42（Setup 4 + Foundational 8 + US1 12 + US2 7 + US3 7 + Polish 4）

---

## Phase M: Mobile UI — login slice（account-migration p3 · `[Mobile]` only）

> ⬆️ 上方 T001-T058 = **W2/W3 server scope**（已 ship，历史记录）。本段是 **client 切片** task，对应 plan.md「Mobile UI Plan — login slice」+ de-staled spec `FR-C*`。
>
> **形态** = port（Strangler-Fig，源 = 旧 meta `login.tsx` + `use-login-form.ts`）。**login Golden Sample**（mono 首个 RHF + Strangler-Fig）。`[Server]` / `[Contract]` 层留空（server 已 ship、Orval api-client hook 已生成）。
>
> **Goal**：复用已 ship server 双 endpoint + 已生成 Orval hook，落地单 form 登录屏，RHF Golden Sample 范式落地。
> **Independent test**：web e2e 登录流程跑通 + 组件测 5 态 + 反枚举 client 一致性 + 错误映射。
> **Defer per p3**：FR-C07 OAuth 占位 / FR-C09 help 链接 / freeze 弹窗（随 cancel-account 批 C 补）。

### Foundational（共享，所有 client US 前置）

- [X] T059 [P] [Mobile] port `~/ui` primitives → `apps/mobile/src/ui/{PhoneInput,SmsInput,ErrorRow,PrimaryButton,LogoMark,SuccessCheck}.tsx` + `index.ts` 导出；复用 `~/theme` token + NativeWind className（直搬不重设计，per memory `feedback_design_tokens_reuse_not_redesign`）；a11y props 内联（`accessibilityLabel`/`accessibilityRole`/`accessibilityState`）；**presentational → 无 vitest 单测**（同既有 `Button`/`Spinner`）；verify：`pnpm nx run mobile:typecheck && pnpm nx run mobile:lint` pass；render/视觉/a11y 覆盖 → T066 e2e
- [X] T060 [P] [Mobile] zod `phoneSmsAuthSchema` → `apps/mobile/src/auth/login-form.schema.ts`（phone `/^\+861[3-9]\d{9}$/` 与 server `class-validator @Matches` 同规则 + 互锚注释防漂移；code 6 位数字）；RED：schema 单测（合法 / 非法 phone / code 长度）→ GREEN
- [X] T061 [Mobile] `~/auth` phone-sms-auth wrapper → `apps/mobile/src/auth/phone-sms-auth.ts`（封装 Orval `useAccountPhoneSmsAuthControllerAuth` 的 `mutateAsync` → `useAuthStore.setSession`；hook **不直调** router）+ `~/auth/index.ts` 加 export；RED：单测 mock Orval mutation 断言 `setSession` 被调 → GREEN

### Implementation for US1–US4 — `useLoginForm` hook 行为（vitest `.spec.ts` logic）

> CON1 拆分：hook 拆「核心 / 错误映射」各 ≤2h（Constitution III）。hook 是**纯 logic** → mono vitest `.spec.ts`（node env，不渲染）；反枚举一致性 + 错误映射在 hook 层断言，无需 render。

- [X] T062 [Mobile] [US1] `useLoginForm` 核心 → `apps/mobile/src/auth/use-login-form.ts`：RHF + `zodResolver`（铁律 1 Controller 订阅）；**副作用态分层**（铁律 2：`useAccountSmsCodeControllerRequest` mutation + 60s `useRef` 倒计时在 RHF 外）；`isSubmitting` 单源（铁律 3）；FR-C11 状态机（idle → requesting_sms → sms_sent → submitting → success）；RED：`use-login-form.spec.ts` helper-level（倒计时启停 / requestSms→sms_sent / submit success→setSession，per memory `feedback_vitest_spy_rejection_through_event_handlers`）→ GREEN
- [X] T063 [Mobile] [US2] `useLoginForm` 错误映射 + 反枚举一致性 → `use-login-form.ts`（接 T062）：`AxiosError` → `errorToast` 映射（FR-C06：401 / 429 / 网络错 / 未知）+ `errorScope`（FR-C15 `sms|submit|null`）+ `clearError`；RED：`use-login-form.spec.ts` helper-level —（a）401（US3 不区分子码）/ 429 / `AxiosError` 无 `response` 各映射 + errorScope + clearError（SC-C04/C06）；（b）**反枚举一致性 SC-C02**：mock 已注册 vs 未注册两 Orval 响应 → 断言 hook state / setSession 完全 equal（client 无 phone-existed 分支）→ GREEN

### Implementation for US1 — `login.tsx` 屏（port，presentational，无 vitest，T066 e2e 覆盖）

> CON1 拆分：屏拆「skin 组装 / 状态机接线」各 ≤2h。`app/` 树 presentational → 无 vitest（mono 架构），行为/render 覆盖走 T066 Playwright。

- [X] T064 [Mobile] [US1] `login.tsx` skin 组装 → `apps/mobile/app/(auth)/login.tsx`（替换 PHASE 1 占位）：`<Controller>` 包 `PhoneInput`/`SmsInput`（铁律 1）+ `LogoMark`/标题/`PrimaryButton`/「获取验证码」按钮 + **顶部 close `×`**（FR-C08：有 history → `router.back`，否则 noop）+ FR-C13 全交互 `accessibilityLabel`；verify：typecheck/lint pass + **SC-C07 grep**（`apps/mobile/app/(auth)/login.tsx` + `apps/mobile/src/ui/**` 无 `#[0-9a-f]{3,8}` / `\d+px` / rgb 字面量）；render 覆盖 → T066
- [X] T065 [Mobile] [US1] `login.tsx` 状态机接线 + success → 接 T062–T064：FR-C11 五态视觉（submitting loading + 按钮 disabled）+ `ErrorRow` + `errorScope` 标红边框（铁律 4）+ success reanimated scale-in ≤800ms → AuthGate 接管 `router.replace('/(app)/')`；verify：typecheck/lint pass；行为覆盖 → T066

### Polish / e2e

- [X] T066 [Mobile] web e2e（Playwright Expo Web，SC-C05 + SC-C09）→ `apps/mobile/e2e/login.spec.ts`：US1 happy 全流程浏览器跑通（输入手机号 → 获取码 → 输入码 → 登录 → 进 `/(app)/`）+ 5 态视觉 + 错误 toast + a11y（axe / role 断言，SC-C05）；注意 expo-router web 隐藏 `(auth)` group URL 段 + Desktop Chrome `hasTouch:false`（memory `reference_expo_router_web_hides_route_groups`）；success 走**不清 session** 等价断言路径（memory `feedback_visual_smoke_unreachable_when_finally_clears_session`）

### Phase M Dependencies & Execution

- 全部依赖 server + Orval api-client（已 ship）；**无新 npm dep**（RHF/resolvers/zod + reanimated 4.1 + @playwright/test 均已装）
- **测试分层（mono 架构）**：logic（T060/T061/T062/T063）→ vitest `.spec.ts`（node，`src/`）；presentational（T059/T064/T065）→ 无单测 + typecheck/lint；UI render/a11y/visual（T066）→ Playwright Expo Web
- T059 / T060 `[P]` 可并行（不同文件）；T061 独立
- T062 依赖 T060 + T061；T063 依赖 T062（同 hook 文件）；T064 依赖 T059 + T062；T065 依赖 T063 + T064；T066 依赖 T065
- 每 task 走 /implement 闭环（logic：RED→GREEN→typecheck/lint→`[X]`→commit；presentational：impl→typecheck/lint→`[X]`→commit），per `.claude/rules/implement-task-closure.md`
- **Stop / Surface**：撞 spec 歧义 / 需新 dep / destructive op / 跨 PR scope → 停问 user

**Phase M tasks**: 8（Foundational 3 + US1-US4 hook 2 + US1 屏 2 + e2e 1）
