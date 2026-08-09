# Implementation Plan: Phone SMS Auth (W2 server scope)

> ⚠️ **[ARCHITECTURE GOVERNANCE NOTE (2026-05-24)]**
> This plan was implemented under the legacy Hexagonal/DDD architecture.
> The narrative (e.g., "domain / application / infrastructure layers", "hexagonal") is preserved for historical record.
> However, future implementations MUST follow the **Flat + Anemic + Moat** paradigm defined in **[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)**.

**Branch**: `feature/phone-sms-auth-plan` | **Date**: 2026-05-17 | **Spec**: [`spec.md`](./spec.md)
**Input**: Feature specification from `specs/001-phone-sms-auth/spec.md`（per [ADR-0024](../../docs/adr/0024-spec-feature-first-layout.md) feature-first 布局）

## Summary

mono PoC 首个业务 use case：1 个 endpoint（`POST /accounts/phone-sms-auth`）统一 register + login，server 自动判已注册路径 → login / 未注册 → 自动创建+login；配套 1 个 endpoint（`POST /accounts/sms-codes`）发码。FROZEN / ANONYMIZED 账号与码错共享反枚举字节级一致响应（HTTP 401 INVALID_CREDENTIALS，时延差 ≤ 50ms）。SMS Template A 真实验证码（不区分注册/登录），60s 冷却。

**W2 焦点**：server `domain` + `application` + `infrastructure` 层在 NestJS Module `auth` 内实现，达成 [Plan 1 § E.3](../../docs/private/plans/2026-05/05-18-plan1-backend-stack-poc.md) V1（LoC ≤ 旧实现等价 1.5x，`cloc` 对比）+ V2（NestJS Module boundary 对标 ArchUnit 4 类规则）验收。Aliyun SMS 真实集成 / E2E Testcontainers / @nestjs/throttler 限流属 W3+ 范围。

## Technical Context

| 维度 | 选型 | grounding |
|---|---|---|
| Language | TypeScript 5.x on Node 22 LTS | Plan 1 § F lock |
| Framework | NestJS 11.1.21 + Fastify adapter | mono apps/server 已装 |
| ORM | Prisma 7.8 + PostgreSQL 17 | mono W1.4 step 4' db pull |
| JWT | `@nestjs/jwt` ^11 — `JwtModule.registerAsync` + `JwtService.sign(payload, { expiresIn })` / `verifyAsync<T>(token)` | verified `/nestjs/jwt` context7 |
| Retry / Circuit Breaker | `cockatiel` ^3 — `retry(handleAll, { maxAttempts, backoff: ExponentialBackoff() })` + `wrap(retryPolicy, circuitBreakerPolicy)` | verified `/connor4312/cockatiel` context7 |
| Validation | `class-validator` + `class-transformer`（ValidationPipe 全局已配 W1.4 step 5'） | mono main.ts |
| Logger | `nestjs-pino` raw JSON（W1.4 ship；pretty mode defer M3） | mono main.ts |
| Storage | PostgreSQL 17（mbw-poc-postgres 5433） + Redis 8（mbw-poc-redis 6380） | mono W1.4 docker-compose.dev.yml |
| Test | Vitest 2（前后端一致，per Plan 1 § F） — **W2 引入** | (W2.3 task：装 vitest + 配 nx test target) |
| Build | `@nx/js:swc` 转译（W2.0 swap） | mono apps/server/project.json |
| Project Type | web-service backend only（mobile 在 W4+ apps/mobile 物理迁入后消费 client 段） | spec § W2 焦点 |
| Performance | P95 < 200ms（SC-S01 隐含）；SMS gateway 调用 < 2s | 业务常识 |
| Constraints | 字节级反枚举（SC-S03）；时延差 ≤ 50ms；同 phone 60s 冷却（FR-S07） | spec FR-S03/S06/S07 |
| Scale | PoC 阶段 10-100 users，单实例 | Plan 1 PoC |

**Plan 1 § F 14 项 tech stack 全继承**（不锚定旧 ADR）；细则与 Constitution Tech Stack Constraints 1:1。

## Constitution Check

> Gate: pass before Phase 0；Phase 1 后重 check。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec.md ship → plan.md（this）→ tasks.md（W2.3）→ analyze（W2.3）→ implement（W2.4）；每 phase 独立 PR + review gate |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | W2.4 implement 每 task 走红→绿→typecheck/lint→tasks.md `[X]`→stage→commit；W2.3 task 拆分时每实现 task 绑 RED 测试 task |
| III. Atomic Task 30min-2h + 独立 commit | ✅ | W2.3 拆 tasks 时遵守；每 task 独立 commit + tasks.md `[X]` |
| IV. Module Boundary 显式 + ESLint 强制 | ⚠️ **需 W2.3 task 预装** | mono 当前未装 `eslint-plugin-boundaries`；W2.3 task `T01: 装 eslint + plugin-boundaries 配 4 类规则` 是 implement 前置；CI 加 `lint` job |
| V. 类型同步链 Nx-driven | 🟡 W2 不涉及 | OpenAPI gen / api-client / mobile 消费链是 V8 验收（W4-W5）；本 W2 plan 仅 `@nestjs/swagger` decorator 注解，`export-openapi` Nx target 与 generate 链 W4 实现 |

**结论**：5 原则全 pass 或有 explicit pre-implement task 兜底；可进 Phase 0。

## Project Structure

### Documentation (this feature)

```text
specs/001-phone-sms-auth/
├── spec.md                # feature specification
├── plan.md                # W2.2 this file
├── tasks.md               # W2.3 /speckit-tasks output
└── analysis.md            # W2.3 /speckit-analyze output (consistency report)
```

不分独立 `research.md` / `data-model.md` / `quickstart.md` / `contracts/` 文件夹，全 inline 在本 plan.md（PoC 阶段 spec / plan / tasks 都是单文件，过细拆分降低可读性）。

### Source Code (mono `apps/server`)

```text
apps/server/src/
├── main.ts                                    # 已存在 (W1.4)
├── app/
│   └── app.module.ts                          # import AuthModule
└── auth/                                      # 本 use case 全部代码 (新建)
    ├── auth.module.ts                         # NestJS Module: export AuthService for guards / 跨 module 消费
    ├── domain/                                # 零外部依赖 (Constitution IV-1)
    │   ├── account.aggregate.ts               # Account business invariants
    │   ├── phone.vo.ts                        # Phone value object (E.164 +86 校验)
    │   ├── sms-code.vo.ts                     # 6-digit code + TTL
    │   └── events/
    │       └── account-created.event.ts       # Domain event
    ├── application/                           # use case orchestration
    │   ├── request-sms-code.usecase.ts        # P1: 发码 (FR-S04 无 purpose)
    │   ├── phone-sms-auth.usecase.ts          # P1: 统一登录注册 (FR-S05)
    │   └── ports/                             # 依赖反转 interface
    │       ├── account.repository.port.ts
    │       ├── sms-code.repository.port.ts    # Redis-backed (FR-S02)
    │       ├── sms-gateway.port.ts            # SMS provider abstraction (W2 用 Mock)
    │       └── outbox-publisher.port.ts       # Domain event publish (FR-S11)
    ├── infrastructure/                        # 实现 ports (Constitution IV-2: web ↛ infra)
    │   ├── account.prisma.repository.ts
    │   ├── sms-code.redis.repository.ts
    │   ├── mock-sms.gateway.ts                # W2 占位实现 (W3 替 Aliyun SDK)
    │   ├── outbox-event.prisma.publisher.ts  # outbox 表写入
    │   ├── jwt-token.service.ts               # 封装 @nestjs/jwt (FR-S09)
    │   └── problem-detail.filter.ts           # RFC 9457 (FR-S10)
    └── web/                                   # Controller + DTO
        ├── account-sms-code.controller.ts     # POST /accounts/sms-codes
        ├── account-phone-sms-auth.controller.ts  # POST /accounts/phone-sms-auth
        └── dto/
            ├── request-sms-code.request.ts
            ├── phone-sms-auth.request.ts
            └── phone-sms-auth.response.ts
```

**Structure 决策依据**：
- 4 层（domain / application / infrastructure / web）对标 hexagonal / clean architecture，与旧实现分层一致以使 V1 LoC 对比公平
- `ports/` 在 application 层声明 interface，infrastructure 实现 — Dependency Inversion 实现 Constitution IV-1（domain 零依赖）
- `auth.module.ts` 显式 `exports: [AuthService]`（W2.4 后续 use case 复用 token 验证 / account 查询 时通过 export 拿）

## Phase 0: Research（关键决策）

### R0.1 — Outbox 实现选型（FR-S11）

| 候选 | 优 | 劣 | 决策 |
|---|---|---|---|
| A. **自实现 outbox + node-cron polling** | 零额外依赖；~50 LoC；PoC 足够 | 失败重试 / dead-letter 自己实现 | ✅ 选 A |
| B. BullMQ + Redis | 生产级 retry + delayed jobs + UI | 引入 BullMQ 依赖；W2 over-engineering | 否 |
| C. 已有 nest-outbox / 3rd-party | 现成 | 库维护质量未知 | 否 |

**决策**：自实现 outbox（`outbox_event` 表 + 后台 cron job 异步分发）。W3+ 生产化时若需要重试 / DLQ 再 swap B。

**表名 amend（2026-05-17 US2 起步决策）**：早期 db pull 把 legacy `event_publication` 表（columns: `listener_id / serialized_event / publication_date / completion_date`）带入 mono schema；本 plan 简化 outbox 落 `outbox_event`（独立新表），legacy 表保留不动待后续决策（不绑旧栈技术 schema）。**2026-05-19 follow-up**：migration `2_drop_legacy_modulith_flyway_tables` 已 DROP `event_publication` + `flyway_schema_history`；上述"保留不动"条款语义 supersede。

### R0.2 — Rate Limit（FR-S07）

候选：[`@nestjs/throttler`](https://github.com/nestjs/throttler) 官方推荐 + Redis storage adapter。

**决策**：**defer 到 W3**。W2 implement 仅留 `// TODO: FR-S07 rate limit per W3 task` 标记，不实装。理由：FR-S07 4 条规则验收依赖真实 Redis + 并发测试，PoC 焦点放在 domain + application + 反枚举字节级一致（SC-S03）上更值。

### R0.3 — Aliyun SMS SDK（FR-S03）

候选：`@alicloud/dysmsapi20170525` 官方 SDK。

**决策**：**defer 到 W3**（per memory `feedback_complex_external_dep_migration_last` — 复杂外部 SDK 后迁不拖主线）。W2 用 `MockSmsGateway` 实现 `SmsGatewayPort`，记录"已发"码到 in-memory map + log；E2E 测试可读 mock map 验证 gateway 被正确调。Aliyun 集成在 W3 `T0X: replace MockSmsGateway with AliyunSmsGateway + cockatiel retry` 一个 task 内做。

### R0.4 — JWT 实现（FR-S09）

verified via context7 `/nestjs/jwt`：

```typescript
// auth.module.ts
JwtModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    secret: config.getOrThrow('AUTH_JWT_SECRET'),
    signOptions: { expiresIn: '15m', issuer: 'no-vain-years' },
  }),
  inject: [ConfigService],
})

// jwt-token.service.ts
this.jwtService.sign({ sub: accountId }, { expiresIn: '15m' })  // access
crypto.randomBytes(32).toString('base64url')                      // refresh (256-bit)
```

**Refresh token**：本 use case 不持久化（FR-S09 明示）；签发后返回 client，验 + revoke 在后续 use case。

### R0.5 — Cockatiel retry（W2 不使用，W3 SMS 集成时启用）

verified via context7 `/connor4312/cockatiel`：

```typescript
// aliyun-sms.gateway.ts (W3)
import { retry, handleAll, ExponentialBackoff, wrap, circuitBreaker, ConsecutiveBreaker } from 'cockatiel';
const policy = wrap(
  retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 2000 }) }),
  circuitBreaker(handleAll, { halfOpenAfter: 10_000, breaker: new ConsecutiveBreaker(5) }),
);
return policy.execute(({ signal }) => aliyunSdk.sendSms({ ... }, { signal }));
```

W2 plan 仅 ground lib version + API 形态；W3 implement 时再 inject 到 AliyunSmsGateway。

### R0.6 — Phone E.164 校验

- 服务端：`class-validator` `@Matches(/^\+861[3-9]\d{9}$/)` + `.trim()` + transform
- 与 client zod regex 完全一致

### R0.7 — Module Boundary 工具（Constitution IV）

候选：`eslint-plugin-boundaries`（per [npm](https://www.npmjs.com/package/eslint-plugin-boundaries) 主流方案）

**决策**：W2.3 task `T01: 装 eslint + eslint-plugin-boundaries + 配 4 类规则` 在 implement 第一 task 前预跑；`nx run server:lint` 加入 CI 后 main-protection ruleset required check 第 5 项。

## Phase 1: Design

### D1.1 — Data Model（Prisma schema）

mono W1.4 step 4' 已 `prisma db pull` 反推 V1-V14 schema。本 use case 复用现有表：

```prisma
// apps/server/prisma/schema.prisma (snippets, db-pull 已生成)
model account {
  id          BigInt              @id @default(autoincrement())
  phone       String              @unique
  status      account_status_enum @default(ACTIVE)
  createdAt   DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  lastLoginAt DateTime?           @map("last_login_at") @db.Timestamptz(6)
  @@map("account")
  @@schema("account")
}

enum account_status_enum {
  ACTIVE
  FROZEN
  ANONYMIZED
}

model outbox_event {
  id           String    @id @default(uuid()) @db.Uuid
  event_type   String
  payload      Json
  published_at DateTime? @db.Timestamptz(6)
  created_at   DateTime  @default(now()) @db.Timestamptz(6)

  @@index([created_at], map: "outbox_event_unpublished_idx")
  @@schema("public")
}
```

**SMS code 存 Redis**（不入 DB）：key `sms_code:<phone>`，value `bcrypt(code)`，TTL 300s。Hash 防 DB 泄露场景下 SMS code plaintext 暴露。

**W2 implement 阶段不改 Prisma schema**（V3 验收已通过 W1.4 db pull）；如发现 schema 缺字段需 W2.4 task 显式 `add migration` + `nx run server:prisma:migrate`。

### D1.2 — API Contracts（OpenAPI 3.1，code-first via @nestjs/swagger）

W2 阶段实装 controller + DTO + class-validator 装饰器；`@nestjs/swagger` 装饰器加在 DTO + Controller 上但 `export-openapi` Nx target 推迟到 W4（V8 验收）。

**端点形态**（与 spec.md FR-S04 / FR-S05 一致）：

```yaml
POST /api/v1/accounts/sms-codes
  Request body: { "phone": "+8613800138000" }
  Responses:
    200: 空 body 或 { "ttl": 300 }
    400: ProblemDetail "phone 格式不合法"
    429: ProblemDetail "请求过于频繁" + Retry-After header (W3 实施)

POST /api/v1/accounts/phone-sms-auth
  Request body: { "phone": "+8613800138000", "code": "123456" }
  Responses:
    200: { "accountId": 1, "accessToken": "<JWT>", "refreshToken": "<256-bit base64url>" }
    401: ProblemDetail "INVALID_CREDENTIALS" (4 路径反枚举字节级一致)
    400: ProblemDetail "phone 或 code 格式不合法"
```

**反枚举字节级一致实现要点**（SC-S03）：
- 401 响应 body / headers / status 4 路径完全相同（已注册码错 / 未注册任意码 wait — 注意 spec FR-S05 写未注册任意码自动注册成功，所以未注册路径不返回 401 而是 200 + token；反枚举的是 已注册码错 / FROZEN + 正确码 / ANONYMIZED + 正确码 共 3 路径返 401）
- timing defense：even on FROZEN / ANONYMIZED 路径也走完 hash 比对（dummy bcrypt）保证耗时一致（FR-S06）

### D1.3 — Quickstart（W2.4 implement 完成后跑通）

```bash
# 1. 起依赖
cd /Users/butterfly/Documents/projects/no-vain-years-mono
docker compose -f apps/server/docker-compose.dev.yml up -d

# 2. 跑 server (两 terminal)
pnpm nx build:watch server &   # SWC watch
pnpm nx serve server           # node --watch dist/main.js

# 3. Smoke test 已注册账号 (preseeded via Prisma seed or manual SQL insert)
curl -X POST http://localhost:3000/api/v1/accounts/sms-codes \
  -H 'content-type: application/json' \
  -d '{"phone":"+8613800138000"}'
# Expect 200; check MockSmsGateway log captured code

# 4. Smoke test 未注册号自动注册+登录
curl -X POST http://localhost:3000/api/v1/accounts/sms-codes \
  -H 'content-type: application/json' \
  -d '{"phone":"+8613900139000"}'
curl -X POST http://localhost:3000/api/v1/accounts/phone-sms-auth \
  -H 'content-type: application/json' \
  -d '{"phone":"+8613900139000","code":"<from mock log>"}'
# Expect 200 + tokens; DB new account row + outbox_event row

# 5. Smoke test 反枚举 (已注册码错 / FROZEN / ANONYMIZED 3 路径字节级一致)
# manually verify response bytes equal (use diff on body + curl -i headers)
```

V1 LoC 测量：`cloc apps/server/src/auth` vs 旧实现等价类（详 [`v1-loc-report.md`](v1-loc-report.md)）。

V2 module boundary：`pnpm nx run server:lint` 0 boundaries violation；4 类规则手测：
1. domain 层禁 import infrastructure / web — 写测试 import 必报 lint err
2. web 层禁直接 import infrastructure — 同上
3. 跨 module 经 api / module exports — 写测试 cross-module 直接 import service 必报
4. shared packages 禁 import apps/* — 写测试 packages/* 文件 import auth 必报

## Complexity Tracking

无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：Constitution Principle IV（Module Boundary 显式）当前 mono 未装 `eslint-plugin-boundaries`，属"pre-implement setup 缺失"非"violation"；W2.3 拆 task 时第 1 个 task 即装该 plugin，闭环 gate。

---

## Phase 2 准备（W2.3 /speckit-tasks 输入）

接下来 W2.3 `/speckit-tasks` 应基于本 plan 拆 tasks.md，建议层级：

- `[Setup]` — eslint-plugin-boundaries 装 + 配 4 类规则 / Vitest 装 + nx test target / SMS code Redis client setup
- `[Domain]` — Phone VO / SmsCode VO / Account aggregate / AccountCreated event
- `[Application]` — RequestSmsCodeUseCase / PhoneSmsAuthUseCase + ports
- `[Infrastructure]` — Prisma repositories / MockSmsGateway / JWT service / ProblemDetail filter / Outbox publisher
- `[Web]` — Controllers + DTOs + validation
- `[Smoke]` — Quickstart 5 个 curl 命令跑通 + V1 cloc + V2 lint 验证

每 task 30min-2h + 独立 commit + tasks.md `[X]` flip（per Constitution III + /implement 6 步闭环）。

预估 task 数：20-25 个（4-5 层结构完整覆盖，mono 不含 schema migration + Aliyun SMS 真集成 + rate limit，所以略少）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-17 | **Phase 0 Research grounding**: `/nestjs/jwt` + `/connor4312/cockatiel` via context7

<!-- BEGIN auto-generated: performance-budget (from spec.md frontmatter; do not edit) -->

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) | Timing-defense diff P95 (ms) |
| --- | ---: | ---: | ---: |
| `POST /api/v1/phone-sms-auth` | 200 | 500 | 50 |
| `POST /api/v1/sms-codes` | 150 | 400 | — |

_Edit `perf_budgets:` in spec.md frontmatter to change. Regenerate this block with `pnpm tsx scripts/orchestrator/plan-compiler.ts <spec-dir>`._

<!-- END auto-generated: performance-budget -->

---

# Mobile UI Plan — login slice（account-migration p3 Step 2）

> 上方为 **W2 server scope** plan（已 ship，历史记录保留）。本段是 **client 切片** 的独立 plan：login mobile-only UI，对应 de-staled spec 的 `FR-C*`。
>
> **形态**：port（Strangler-Fig，源 = 旧 meta app `apps/native/app/(auth)/login.tsx` + `lib/hooks/use-login-form.ts`）。**= login/onboarding Golden Sample**（mono 首个 RHF + Strangler-Fig 落地标杆，per [p3 §1](../../docs/private/plans/2026-05/05-25-account-migration-p3-usecase-steps.md)）。

## Summary（client）

复用已 ship 的 server 双 endpoint（`/accounts/sms-codes` 发码 + `/accounts/phone-sms-auth` 登录注册合一）+ 已生成的 Orval api-client，落地单 form 登录屏。**纯 mobile 切片**：tasks 只有 `[Mobile]` 层，`[Server]` / `[Contract]` 留空（server 已 ship、api-client hook 已生成）。

## Scope

**In（本轮）**：FR-C01~C06、C10~C15 —— 单 form（phone + SMS）、zod 校验、Orval hook 调用、60s 倒计时、5 态状态机、`errorScope` 双场景、统一错误映射、a11y、成功动画 → AuthGate 接管。

**Out（defer，per p3 §1「Golden Sample 本轮不含」）**：

- **FR-C07** 三方 OAuth 占位按钮（微信 / Google / Apple）→ 后续 OAuth 阶段
- **FR-C09** 「登录遇到问题」help 链接 → 后续阶段
- **freeze 弹窗**（FROZEN → `ACCOUNT_IN_FREEZE_PERIOD` 403 拦截 modal）→ 随 cancel-account（批 C `delete-account`）阶段补；本轮 freeze 路径走 server 默认 401 反枚举,client 不特判
- FR-C08 顶部 close `×`：**保留**（廉价、port 现成），但不连 OAuth 区

## Strangler-Fig 四层拆（per p3 §4 + memory `project_rhf_form_standard_login_golden_sample`）

| 层                | 处置     | meta 源                                    | mono 落点 / 改写                                                                                              |
| ----------------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **skin**（视觉）  | port ≈1:1 | `login.tsx` className（`bg-surface` 等）   | mono 同栈 NativeWind 4.2 + 同语义 token（`~/theme`：ink/line/surface/brand…）→ className 近乎直搬，**0 新 token** |
| **muscle**（表单） | 重写     | `use-login-form.ts`（`useState`+safeParse） | RHF 7.75 + `@hookform/resolvers/zod` + zod 4 schema（轻范式 → Golden Sample 范式）                            |
| **nervous**（数据）| 重写     | `@nvy/api-client` class + `@nvy/auth.phoneSmsAuth` | Orval mutation hook `useAccountSmsCodeControllerRequest` / `useAccountPhoneSmsAuthControllerAuth`，经 `~/auth` 薄 wrapper |
| **engine**（路由/会话）| 复用 | `phoneSmsAuth` 内部 setSession + AuthGate  | `useAuthStore.setSession`（已存在）+ AuthGate（`apps/mobile/app/_layout.tsx` 已落地）；hook **不直调 router**   |

## 组件清单 & port 目标（`~/ui`）

mono `~/ui` 当前仅 `Button` / `SafeAreaView` / `Spinner`（`index.ts` 近空）。本轮需从 meta `packages/ui` port 入 `apps/mobile/src/ui/` 的 primitive：

| 组件          | mono 现状 | 处置                                    |
| ------------- | --------- | --------------------------------------- |
| `PhoneInput`  | 缺        | port（带 `accessibilityLabel` + 错误标红边框 per FR-C15） |
| `SmsInput`    | 缺        | port（含「获取验证码」按钮 + 倒计时态） |
| `ErrorRow`    | 缺        | port（`accessibilityRole='alert'`，FR-C13） |
| `PrimaryButton` | 缺      | port 或复用现有 `Button`（impl 时定）   |
| `LogoMark` / `SuccessCheck` | 缺 | port（成功动画 reanimated scale-in ≤800ms，FR-C11） |
| `Spinner`     | ✅ 有     | 复用                                    |

> port 即把视觉资产直搬，**禁用 Claude Design 重设计 token**（memory `feedback_design_tokens_reuse_not_redesign`）。OAuth 按钮（`WechatButton`/`GoogleButton`/`AppleButton`）本轮不 port。

## RHF Golden Sample 设计（4 铁律落地）

1. **`<Controller>` 包 `TextInput`**（非 `register`）—— RN `TextInput` 非真 DOM，`register` 静默失效；按字段订阅减重渲染。
2. **表单态 vs 副作用态分层** —— RHF 只管 phone/code 校验 + submit 生命周期；**发验证码 mutation + 60s 倒计时是 RHF 之外**的 `useAccountSmsCodeControllerRequest` + `useRef` 计时器（port 自 meta `startCountdown`）。
3. **`isSubmitting` 单源** —— submit 走 `handleSubmit(async → mutateAsync)`，loading 视觉用 `formState.isSubmitting`，**禁** 再起 `useState(isLoading)`。
4. **错误 + a11y** —— `formState.errors`（zod message）→ `~/ui <ErrorRow>` + `accessibilityLabel`；server 错误（`AxiosError`）经映射 util → `errorToast` + `errorScope`。

**文件落点**（per [ADR-0030](../../docs/adr/0030-package-decomposition.md) 单 consumer 内联）：schema + hook 进 `apps/mobile/src/auth/`（如 `login-form.schema.ts` / `use-login-form.ts`），屏进 `apps/mobile/app/(auth)/login.tsx`，`~/auth` 加 `phone-sms-auth` wrapper（Orval mutation + `setSession`）。

## 状态机（FR-C11 + FR-C15）

`idle → requesting_sms → sms_sent → submitting → (success | error)`。`errorScope: 'sms' | 'submit' | null` 决定哪个 input 标红 + `ErrorRow` 渲染位置；任意 input change → `clearError` + `errorScope=null`。success：reanimated 对勾 ≤800ms → AuthGate 监听 `isAuthenticated` 自动 `router.replace('/(app)/')`。

## 错误映射（client util，按 `AxiosError` 判别）

per FR-C06：401 → "手机号或验证码错误"（不区分 401 子码）；429 → "请求过于频繁，请稍后再试"；`AxiosError` 无 `response`（网络错）/ 5xx → "网络异常，请检查网络后重试"；未知 → "登录失败，请稍后再试"。**不引** meta 的 `mapApiError`/`readErrorCode`（基于 typescript-fetch `ResponseError`）—— 按 Orval/axios 错误形态重写。

## 校验（zod）

`phoneSmsAuthSchema`：phone `/^\+861[3-9]\d{9}$/`（client zod 与 server `class-validator @Matches` **同规则写两处，注释互锚防漂移** per memory）；code 6 位数字。

## 依赖 gate

✅ 已满足（2026-05-25 核实）：`react-hook-form ^7.75.0` + `@hookform/resolvers ^5.2.2` + `zod ^4.4.3`（`apps/mobile/package.json`）。impl 时确认 `zodResolver` import 走 zod4 路径（非 zod3 垫片）。

## 测试策略（per p3 Verification）

> **测试分层 = mono vitest 架构**（`apps/mobile/vitest.config.ts`：node env / `src/**/*.spec.ts` / 不碰 `app/` 树 —— UI 渲染走 Playwright，避 RN→DOM 高成本）。既有 `~/ui` `Button`/`Spinner` 无单测即此故。

- **vitest `.spec.ts`（logic-only）**：zod schema（T060）/ `~/auth` wrapper mock Orval（T061）/ `useLoginForm` hook 行为 —— T062 状态机+倒计时+setSession、T063 错误映射（FR-C06 401/429/网络错，SC-C04）+ **反枚举 client 一致性**（SC-C02：已注册≡未注册 mock 两响应 → hook state/setSession equal，无需渲染）。helper-level（memory `feedback_vitest_spy_rejection_through_event_handlers`）。
- **presentational（无 vitest 单测）**：`~/ui` primitives（T059）/ `login.tsx`（T064/T065）—— 同 `Button`/`Spinner`；verify = typecheck/lint + SC-C07 静态 grep（T064）；render/视觉覆盖 → e2e。
- **Playwright e2e（Expo Web，T066）**：US1 happy 全流程 + 5 态视觉 + a11y（SC-C05 axe/role）+ SC-C09 三端；expo-router web 隐藏 `(group)/` + Desktop Chrome `hasTouch:false`（memory `reference_expo_router_web_hides_route_groups`）；success 不清 session 等价路径（memory `feedback_visual_smoke_unreachable_when_finally_clears_session`）。

## Phase 2 准备（`/speckit-tasks` 输入，[Mobile] only）

task 层级（三位一体里 `[Server]`/`[Contract]` 本切片留空）；tasks.md Phase M 为权威：

1. `[Mobile]` `~/ui` primitive port + index 导出（presentational，无单测）— T059
2. `[Mobile]` zod `phoneSmsAuthSchema` + vitest `.spec.ts` — T060
3. `[Mobile]` `~/auth` wrapper（mock Orval）+ vitest `.spec.ts` — T061
4. `[Mobile]` `useLoginForm` 核心（状态机/倒计时/setSession）+ vitest — T062
5. `[Mobile]` `useLoginForm` 错误映射 + 反枚举一致性 + vitest — T063
6. `[Mobile]` `login.tsx` skin + close × + SC-C07 grep（presentational）— T064
7. `[Mobile]` `login.tsx` 状态机 + success（presentational）— T065
8. `[Mobile]` Playwright e2e（render/a11y/SC-C09）— T066

logic task 走 TDD 红→绿→typecheck/lint→`[X]`→commit；presentational task 走 impl→typecheck/lint→`[X]`→commit（per `.claude/rules/implement-task-closure.md`）。共 8 task。

## 开放决策 / 风险

1. **`PrimaryButton` port vs 复用 `Button`** —— impl 时看 meta `PrimaryButton` 与 mono `Button` 差异定（倾向复用，减重）。
2. **NativeWind className token 对齐** —— 本轮信 `~/theme` + tailwind.config 已对齐（profile.tsx 实证 className + `tokens` 共用）；port 时若有 meta className 在 mono tailwind.config 无定义 → 补 config 不新造 token。
3. **`success` 帧可达性** —— `finally` 无条件 clearSession + AuthGate 同步 redirect 会让 success 帧不可达（memory `feedback_visual_smoke_unreachable_when_finally_clears_session`）；本屏 success 不 clearSession（成功留 session），动画帧可达,但 e2e 断言走等价非清 session 路径。
