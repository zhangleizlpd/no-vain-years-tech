---
feature_id: 003-tokens
spec_ref: ./spec.md
status: done
created_at: '2026-05-25'
updated_at: '2026-05-25'
adr_refs: ['0019', '0022', '0023', '0024', '0030', '0032', '0041', '0043']
context7_verified: []
---

# Implementation Plan: 003-tokens（refresh-token 持久化 + 轮换 + 全端登出）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `003-tokens` | **Master**: [`account-migration master`](../../docs/private/plans/2026-05/05-25-account-migration-master.md) → 批 B | **Engine**: [`p3`](../../docs/private/plans/2026-05/05-25-account-migration-p3-usecase-steps.md)

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per p3 §3）。

## Summary _(mandatory)_

003-tokens = refresh-token 服务端**完整生命周期**首次落地：①**签发即持久化**（接入既有 `phone-sms-auth` 登录流 + refresh 自身）②**轮换**（`POST /api/v1/accounts/refresh-token`：原子 revoke 旧 + 签新 + insert 新，继承 device 血缘 + 更 IP，affected-count 乐观锁）③**全端登出**（`POST /api/v1/accounts/logout-all`：撤账号全部 active，幂等 204）。bounded context：`auth` 编排 user-facing 端点，`security` 持有 refresh-token 持久化/轮换/撤销操作（auth → security = R2 CROSS-CONTEXT-SYNC，轮换失败回滚整请求）。client（per clarify）= api-client 透明续期拦截器 + `X-Device-Id` 头注入 + logout-all wrapper 逻辑，**无可见 UI**。范式 = ADR-0043 扁平贫血 + Moat。`RefreshToken` 表已 db-pull，**无 migration**。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | Request | Response | trace FR |
|---|---|---|---|---|---|---|
| EP1 | POST | `/api/v1/accounts/refresh-token` | none（凭 body 的 refresh token） | `{ refreshToken: string }`（`@IsNotEmpty`，空 → 400） | 200 `{ accountId, accessToken, refreshToken }`（复用 `001` `LoginResponse` shape）/ 401 ProblemDetail | FR-S04~S10, FR-S14, FR-S15 |
| EP2 | POST | `/api/v1/accounts/logout-all` | **bearer**（access token） | 无 body | **204** 空 body / 401 / 429 | FR-S11~S15 |

- 命名空间与既有端点一致（`@Controller('v1/accounts')` + 全局前缀 `api`，per `main.ts:55` / `account-phone-sms-auth.controller.ts:20`）；**不**用旧栈的 `/auth/` 前缀。
- 错误响应一律 RFC 9457 ProblemDetail（复用 `001` 全局 filter）；code 复用 `INVALID_CREDENTIALS` / `RATE_LIMITED`，**无新增 code**。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（3 fork 写回）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 每 impl task 红→绿→typecheck/lint→tasks.md `[X]`→commit 6 步闭环；server 并发/原子性/反枚举有专测 |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 按此拆；三位一体同 1 PR |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅ | auth/security/account 边界 per ADR-0032；ADR-0043 五条（零 class 倾向 / 贫血裸 row / 无 repository / 扁平 / rules 纯函数 / Moat）；auth→security 跨 ctx 注入点带 `// CROSS-CONTEXT-SYNC`；`check-server-moat.ts` 关 |
| V. 类型同步链 Nx-driven | ✅ | server `@nestjs/swagger` 装饰器 → `nx run server:export-openapi` → `nx affected -t generate`（Orval api-client regen）→ mobile 消费；server + api-client + mobile **同 PR** |

## Architecture Notes _(mandatory)_

### Bounded Context 落位（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）

| 操作 | context | 类型 | 跨 ctx | 备注 |
|---|---|---|---|---|
| refresh-token（端点编排） | **auth** | 编排 UseCase | R2 读 → `account.inspect-account-status-by-id`；R2 写 → `security.rotate-refresh-token` | 已登记 catalog（`refresh-token = auth, R2 → security.rotate-refresh-token`） |
| logout-all（端点编排） | **auth** | 编排 UseCase | R2 写 → `security.revoke-all-refresh-tokens` | catalog ship 时新增行 |
| persist-refresh-token | **security** | Service 方法 | — | 被 auth 登录流 + refresh 流调用 |
| rotate-refresh-token | **security** | Service 方法 | — | 原子轮换（tx + affected-count），失败抛 → auth 回滚 |
| revoke-all-refresh-tokens | **security** | Service 方法 | — | updateMany 幂等 |
| inspect-account-status-by-id | **account** | 只读 UseCase（新） | — | 既有 `InspectAccountStatusUseCase.execute(phone)` 仅按 phone；refresh 只有 `accountId` → 新增 by-id 变体（返回同 `AccountStatusInspection` kind） |

### Server side（ADR-0043 扁平贫血，文件平铺）

**新增（auth `apps/server/src/auth/`）**：

- `account-token.controller.ts`（`@Controller('v1/accounts')`）：`POST refresh-token`（EP1）+ `POST logout-all`（EP2，挂 JwtAuthGuard）
- `refresh-token.usecase.ts`：refresh 编排（见下「Refresh 流」）
- `logout-all.usecase.ts`：logout-all 编排
- `refresh-token.request.ts`（`{ refreshToken: string }` + `@IsNotEmpty` + Swagger 装饰器）；响应复用既有 `phone-sms-auth.response.ts` 的 `LoginResponse`（`{ accountId, accessToken, refreshToken }`）——**不新造 response class**，避免反枚举字段漂移

**新增（security `apps/server/src/security/`）**：

- `refresh-token.service.ts`（PrismaService 直注，无 repository）：`persist(...)` / `findActiveByHash(hash, now)` / `rotate(record, clientIp)` / `revokeAllForAccount(accountId, now)`。**export 出 SecurityModule**（加入 `exports: [...]`，当前 exports 见 `security.module.ts:130`）
- `refresh-token-hasher.ts`：SHA-256 → 64 小写 hex（高熵 token 无需 salt/HMAC，per [ADR-0023](../../docs/adr/0023-sms-code-storage-hmac.md) 区分：HMAC 用于**低熵** SMS code 反枚举/timing；refresh token 256-bit 高熵，纯 SHA-256 即可，**禁再引 bcrypt**）。预留接口便于 M2+ 换 keyed HMAC
- `refresh-token.rules.ts`（无状态纯函数 + 常量）：`isActive(record, now)` = `revokedAt == null && expiresAt > now`；`normalizeDeviceType(raw)`（→ phone/tablet/desktop/web/unknown）；`scrubPrivateIp(ip)`（私网/回环 → null）；常量 `REFRESH_TTL_DAYS = 30` / `ACCESS_TTL_MIN = 15`（与 `JwtTokenService` 对齐，单一来源）

**修改既有（auth，scope 扩张已确认）**：

- `phone-sms-auth.usecase.ts`：`commitPhoneLogin` 拿 `accountId` + 生成 tokens 后，**调 `security.RefreshTokenService.persist(...)` 落 refresh-token 行**（带 device 元数据 + `loginMethod=PHONE_SMS`）。注入点上方加 `// CROSS-CONTEXT-SYNC: auth → security 持久化 refresh-token（签发即落库）`。device 元数据来源 = controller 透传的 `X-Device-Id` 头（缺失 → service 回退生成 uuid）+ clientIp。`account-phone-sms-auth.controller.ts` 取 `X-Device-Id` 头 + IP 透传 usecase
- `account-sms-code.controller.ts` 等不动

**新增（account `apps/server/src/account/`）**：

- `inspect-account-status-by-id.usecase.ts`：`execute(accountId: bigint): Promise<AccountStatusInspection>`（`findById` + 同 `account.rules.ts` 状态映射）。auth refresh 流经它做账号可登录判定（R2 只读，注入点 `// CROSS-CONTEXT-SYNC`）

**Refresh 流（`refresh-token.usecase.ts`）**：

1. per-IP 限流（throttler，IP tracker）
2. `hasher.hash(rawToken)` → `tokenHash`
3. per-token-hash 限流（自定义 throttler guard / Redis bucket，键 = `refresh:<hash>`；镜像既有 `sms-phone-throttler.guard.ts` 模式）
4. `security.findActiveByHash(tokenHash, now)` → `record | null`；null → **401 `INVALID_CREDENTIALS`**
5. `account.inspectAccountStatusById(record.accountId)` → 非 `ACTIVE`（NOT_FOUND/FROZEN/ANONYMIZED）→ **401 `INVALID_CREDENTIALS`**（反枚举折叠，**不**抛 FROZEN 403——refresh 无 FROZEN 披露语义，与登录不同）
6. `security.rotate(record, clientIp)`（见「并发/事务」）→ `{ accountId, accessToken, refreshToken }`
7. 200 `LoginResponse`

**LogoutAll 流（`logout-all.usecase.ts`）**：JwtAuthGuard 取 `accountId`（JWT `sub`）→ per-account + per-IP 限流 → `security.revokeAllForAccount(accountId, now)`（count 忽略）→ **204**。

**JwtAuthGuard 复用（T001 已决：方案 B）**：既有 `apps/server/src/account/jwt-auth.guard.ts` 同时做两件事 —— token 验证（平台关注点）+ 账号状态门控（`isActive` + `phone !== null`，import `account.rules`，account 关注点）。原推荐的「提升到 `security/`」**不可行**：security→account 被 ESLint `boundaries/dependencies` 禁令拦死（`eslint.config.mjs`），整体迁移 guard 会让 security import `account.rules`。故落 **方案 B**：`JwtTokenService` 新增 `verifyAccess(token): { accountId }`（security 平台层拥有 token 验证，验签/过期/sub 非法即抛，HTTP 401 语义由 guard 负责）；auth 在 logout-all 控制器（T017）自建一个**只验 token** 的薄 guard 委托之。account `/me` 与其 guard **完全不动**（零回归）。logout-all 因此**不被 ACTIVE 状态门控**——frozen 账号仍可登出全端（更符合登出语义，优于复用 account guard）。

### 并发 / 事务策略（迁移翻车点，逐条实现约束）

1. **轮换原子性** — `security.rotate` 用 interactive `prisma.$transaction(async (tx) => { ... })`：tx 内 `signAccessToken` + `generateRefreshToken` + `hash` + **条件 revoke 旧**（`tx.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } })`）→ 检查 `count`：`count === 0` → `throw UnauthorizedException('INVALID_CREDENTIALS')`（**整 tx 回滚**，旧不撤、新不插）→ 否则 `tx.refreshToken.create(新行，继承 device 4 字段 + 更 ipAddress + expiresAt=now+30d)`。返回新 tokens。
2. **乐观锁 = affected-count**：rotate 见上（count=0 → abort）；logout-all 的 `revokeAllForAccount` 同款 `updateMany`，但 `count` **忽略**（0/1/N 均幂等 204）。
3. **Serializable race 双形态**（memory `prisma_serializable_p2002_and_p2034`）：rotate 的 tx 设 `isolationLevel: 'Serializable'`；catch **P2002**（unique `uk_refresh_token_token_hash` 冲突，理论上新 token hash 不撞，但防御）→ 折 401；**外层 retry P2034**（写冲突/序列化失败整 tx abort）——`rotate` 外包一层有限重试（≤3 次），镜像 `commit-phone-login.usecase.ts` 的 P2034 retry 模式。10 并发同 token → 恰 1 成功（affected-count）；100 并发不同 token → 0 错误（独立行无争用）。
4. **反枚举**：refresh 全失败臂（not-found/expired/revoked/forged/account-missing/account-not-eligible/race-lost）→ **字节级一致 401 `INVALID_CREDENTIALS`**；请求体缺 token → 400（`@IsNotEmpty`，与凭据路径区分）。**无 timing defense**（lookup 是 hash-keyed 唯一索引命中，非 secret 比较；与 `001` SMS code 的 HMAC timing 防御不同——不引 `bcrypt-timing-defense.executor`）。

### 限流配置（FR-S14，复用既有 throttler infra，加 per-UC config）

| 端点 | per-IP | per-key | 实现 |
|---|---|---|---|
| refresh-token | `100/60s` | per-token-hash `5/60s` | per-IP：`@Throttle` named `refresh-ip`（IP tracker）；per-token-hash：自定义 guard hash 后消费 Redis bucket `refresh:<hash>`（镜像 `sms-phone-throttler.guard.ts`） |
| logout-all | `50/60s` | per-account `5/60s` | named `logout-all-ip`（IP）+ `logout-all-account`（accountId from JWT `sub`，account 桶先消费） |

超限 → 429 + `Retry-After`。在 `auth.module.ts` 既有 `ThrottlerModule.forRootAsync` 的 `throttlers: []` 数组**新增** named 配置；不新建 `RateLimitService` 类。

### Client side（per clarify：无可见 UI）

- **`packages/api-client`（Orval）**：server openapi.json 产出后 `nx affected -t generate` regen → typed `refresh-token` / `logout-all` 调用 + 函数式 hook（**非 class**，axios 不删）。
- **透明续期拦截器**（`packages/api-client/src/` axios response interceptor）：401 → **single-flight** 一次 refresh（共享 in-flight promise）→ 拿新 access → 重试原请求**一次**（打 `x-nvy-retry` 标记防二次）；**refresh 端点本身豁免**（`/v1/accounts/refresh-token` 不触发拦截）；refresh 失败 → 清 session + 路由 login。镜像旧 app `packages/api-client/src/client.ts` 的 401 中间件**逻辑**，但落 mono Orval/axios 形态。
- **`X-Device-Id` 头注入**：api-client 请求拦截器统一注入 `X-Device-Id`（值来自 mobile 持久化的 device id）。
- **device id 生成/存储**（`apps/mobile/src/auth/` 或 `~/core`）：首次生成 uuid v4 + 本地持久化（`expo-secure-store`，web 走 localStorage fallback）；plan 阶段定具体落点（倾向 `~/auth` 既有 store 旁）。
- **logout-all wrapper 逻辑**（`apps/mobile/src/auth/`）：`logoutAll()` 调 Orval logout-all hook + `finally` 无条件清 session（zustand store clear）+ 路由 login。**无可见登出按钮**（随 settings shell 独立 spec）。
- **Metro `.js` 陷阱**：`apps/mobile` + `@nvy/api-client` 相对 import 一律 **extensionless**（memory `reference_metro_web_cannot_resolve_js_extension_imports`，ESLint `no-restricted-syntax` 已机械拦）。

### Cross-cutting

- **同步链**（Constitution V）：server controller/DTO/Swagger → `nx run server:export-openapi` 产 `apps/server/openapi.json` → `nx affected -t generate`（api-client）→ mobile 消费，**同 1 PR**。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 `logout-all`（auth, R2 → security.revoke-all）+ `persist-refresh-token` / `rotate-refresh-token` / `revoke-all-refresh-tokens`（security）+ `inspect-account-status-by-id`（account）行。
- **反枚举不变性**：grep refresh/logout-all 失败响应字节级一致；persist 路径不改 `phone-sms-auth` 的成功响应 shape（displayName/refreshToken 字段不漂）。

## Open Decisions Resolved（批 B 起手必决项）

| # | 决策 | 结论 |
|---|---|---|
| **Q#4**（p2 §6：`packages/types` 共享策略） | prisma-nestjs-graphql / 手写 / `@prisma/client` 直 export | **延续 `@prisma/client` 直 export**（002 先例，无 GraphQL → 不引 prisma-nestjs-graphql；无 codegen）。**003 不新增 `packages/types` 条目**——token 的 request/response 是 **API-contract 类型**，经 Orval 从 OpenAPI 生成进 `api-client`，**非** domain 类型，不走 `packages/types`。`RefreshToken` 记录类型纯服务端，mobile 不直接消费 |
| **Perf 预算** | refresh / logout-all P95/P99（spec frontmatter `perf_budgets` SoT + 下方 block） | refresh `P95 ≤ 100ms / P99 ≤ 200ms`（含 tx：lookup+sign+revoke+insert）；logout-all `P95 ≤ 80ms / P99 ≤ 150ms`（单 bulk update）；persist-on-issuance 给登录加 `≤ 30ms` delta（不破 001 登录预算） |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：本 feature **改既有已 ship 登录流**（`phone-sms-auth.usecase.ts` 接持久化）——非违反，是「签发即持久化」生命周期的必要接点（spec Assumptions + 用户确认 scope）。JwtAuthGuard 提升到 security 是顺带的边界归位（ADR-0041），非过度设计。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| `POST /api/v1/accounts/refresh-token` | 100 | 200 |
| `POST /api/v1/accounts/logout-all` | 80 | 150 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`（本 plan 同步回填 spec）。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（三位一体同 1 PR，per p3 §Step2；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Server]` security：`refresh-token-hasher.ts` + 单测 → `refresh-token.rules.ts`（isActive/scrubPrivateIp/normalizeDeviceType/常量）+ 单测 → `refresh-token.service.ts`（persist/findActiveByHash/rotate/revokeAllForAccount，PrismaService 直注）+ 单测；export 出 SecurityModule
- `[Server]` account：`inspect-account-status-by-id.usecase.ts` + 单测
- `[Server]` auth：JwtAuthGuard 提升到 security（决策确认后）→ `refresh-token.usecase.ts` + `logout-all.usecase.ts`（编排 + 跨 ctx 注入 + 注释）+ 单测 → `account-token.controller.ts` + `refresh-token.request.ts` + Swagger 装饰器 → 限流 named config（`auth.module.ts`）+ per-token-hash guard
- `[Server]` 改既有：`phone-sms-auth.usecase.ts` + `account-phone-sms-auth.controller.ts` 接 persist（`X-Device-Id` 头 + IP 透传）+ 单测更新
- `[Server-IT]`（Testcontainers PG+Redis）：US1 持久化 / US2 轮换逐字段 / US3 反枚举 7 路字节级 / US4 并发（10 同 token 恰 1 + 100 不同 token 0 错）/ US5 logout-all 幂等+隔离 / US6 限流 4 规则
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（api-client regen）→ typed refresh/logout-all 调用
- `[Mobile]`：device id 生成/持久化 + `X-Device-Id` 注入拦截器 → 透明续期拦截器（single-flight + retry once + 豁免）+ logic-level 单测 → logout-all wrapper 逻辑 + 单测（**无可见 UI**）
- `[Mobile-E2E]`：Playwright Web e2e 测透明续期（登录 → 模拟 401 → 续期 → 业务请求成功；复用 `apps/mobile/e2e/_support/api-mock.ts`）
- `[Verify]`：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（含 `runtime-smoke`）+ 真后端冒烟 + web e2e + catalog Operation 行 + 跨 ctx 注释（`check-server-moat.ts`）

预估 task 数：~22-28（server 重，client 薄）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-25 | **ID-namespace**: US1-8 / FR-S01..S16 / FR-C01..C05 / SC-S01..S10 / SC-C01..C04
