---
feature_id: 003-tokens
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-25'
---

# Tasks: 003-tokens（refresh-token 持久化 + 轮换 + 全端登出）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `003-tokens`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]`（per sdd.md）
- **TDD（强制）**：每个 impl task 内联绑 **unit 测试**（红→绿→typecheck/lint→`[X]`→commit，6 步闭环，per `.claude/rules/implement-task-closure.md`）；**integration 测试（Testcontainers）单列 `[Server-IT]` task**（= 每 US 的 Independent Test 验收）
- 无 task-meta JSON（手动模式，per p3 §3）
- 三位一体：server + contract + mobile **同 1 PR**

## Path Conventions

- server：`apps/server/src/{security,auth,account}/`（ADR-0043 扁平，文件平铺）；IT：`apps/server/test/integration/`
- contract：`apps/server/openapi.json` → `packages/api-client/`（Orval）
- mobile：`apps/mobile/src/auth/`；e2e：`apps/mobile/e2e/`

---

## Phase 1: Setup & 决策

- [X] T001 [Server] 确认 `JwtAuthGuard` 归位决策 → **决策 B**（方案 A「提升到 `security/`」不可行：现 guard 含 `isActive`/`account.rules` 账号状态门控，security→account 被 ESLint boundary 禁令拦死）。已加 `JwtTokenService.verifyAccess(token)→{accountId}`（security 平台层拥有 token 验证 + 单测 5 例）；auth 薄 guard 待 T017（logout-all 控制器，唯一消费方）委托之；account guard + `/me` **完全不动**（零回归，无新行为）

---

## Phase 2: Foundational（security token 基座 — 阻塞 US1/US2/US5）

- [X] T002 [P] [Server] `refresh-token-hasher.ts` in `apps/server/src/security/`：SHA-256 → 64 小写 hex（高熵 token 无 salt/HMAC，per ADR-0023 区分；禁 bcrypt）+ 单测（同输入稳定 / 大写 hex 拒 / 64 长度）。落为**纯函数** `hashRefreshToken`（ADR-0043 零-class），service 直接 import
- [X] T003 [P] [Server] `refresh-token.rules.ts` in `apps/server/src/security/`：纯函数 `isActive(record, now)`（`revokedAt==null && expiresAt>now`）/ `scrubPrivateIp(ip)`（私网/回环→null）/ `normalizeDeviceType(raw)`（→ **UPPERCASE** PHONE/TABLET/DESKTOP/WEB/UNKNOWN，**drift 修正**：plan 写小写但 DB `device_type` 默认 `"UNKNOWN"` + `login_method` `"PHONE_SMS"` 全大写，从 schema 权威）+ 常量 `REFRESH_TTL_DAYS=30` / `ACCESS_TTL_MIN=15`（与 JwtModule `15m` 对齐单一来源）+ 单测（37 断言：表驱动私网/回环/链路本地/IPv4-mapped/公网 IP + 各 deviceType + active/expired/revoked + 过期边界）
- [X] T004 [Server] `refresh-token.service.ts` in `apps/server/src/security/` 骨架：`@Injectable` + 4 方法签名占位（persist/findActiveByHash/rotate/revokeAllForAccount，throw stub）+ 导出 `PersistRefreshTokenInput`/`RotatedTokens` 类型；加入 `SecurityModule` `providers` + `exports`。**构造器 DI 延后增量补**（TS `noUnusedLocals` 不允许提前声明未读注入：T005 补 `PrismaService`+`hashRefreshToken`，T010 补 `JwtTokenService`）；verify typecheck ✅（DI 图静态自洽 + 骨架无新外部依赖，真 boot 由 T007 IT 验）

---

## Phase 3: User Story 1 — 签发即持久化 (P1) 🎯 MVP

**Goal**：登录成功后落 1 条 active refresh-token 行（带 device 元数据 + 30d 过期 + tokenHash）。
**Independent Test**：Testcontainers PG；新号经 phone-sms-auth 成功 → DB 新增 1 active 记录，逐字段断言。

- [X] T005 [US1] [Server] `RefreshTokenService.persist(accountId, rawToken, { deviceId?, deviceName?, deviceType?, clientIp, loginMethod })` in `apps/server/src/security/refresh-token.service.ts`：hash token → `prisma.refreshToken.create`（`expiresAt=now+30d`、`deviceId` 缺失回退 uuid v4、`ipAddress=scrubPrivateIp`、`deviceType=normalizeDeviceType`、`revokedAt=null`）+ 构造器补 `PrismaService` DI + 单测（Testcontainers PG：显式 deviceId + 私网 IP→null + deviceType 归一 / 无 deviceId→uuid v4 + 公网 IP 原样）。**run via `nx test server <file>`（cwd=apps/server，prisma migrate deploy 需）**
- [X] T006 [US1] [Server] 改既有登录流接 persist：`phone-sms-auth.usecase.ts` 注入 `RefreshTokenService`（注入点上方 `// CROSS-CONTEXT-SYNC: auth → security 持久化 refresh-token`，7th ctor arg）→ token 生成后调 `persist(accountId, refreshToken, {deviceId, clientIp, loginMethod:'PHONE_SMS'})`；新增 `LoginDeviceContext` 接口，`execute(phone, code, device={})` 透传；`account-phone-sms-auth.controller.ts` `@Ip()` + `@Headers('x-device-id')` 透传 usecase；更新 `phone-sms-auth.usecase.spec.ts`（persist 被调 + device 透传 + 失败路径不 persist + shape 不漂）。**回归验证**：既有 accounts.us1/us2 login+register e2e 25 测全绿（persist 在真 boot 不破登录）
- [X] T007 [US1] [Server-IT] `apps/server/test/integration/tokens.us1-persist.it.spec.ts`（Testcontainers PG+Redis，全 AppModule boot）：登录成功 → DB active 记录逐字段（tokenHash=hash(返回 token) / accountId / expiresAt≈+30d / loginMethod=PHONE_SMS / revokedAt=null / 回环 IP→null）；带 `X-Device-Id`（=头值）vs 不带（回退 uuid v4）两路。2 测全绿

---

## Phase 4: User Story 2 — Refresh 轮换 (P1) + US3 反枚举 + US4 并发

**Goal**：持 refresh token 原子轮换（revoke 旧 + 签新 + insert 新，继承 device 血缘 + 更 IP），全失败臂统一 401，并发恰 1 成功。
**Independent Test**：Testcontainers PG；预置 active 记录 → refresh → 旧撤/新 active/血缘继承/IP 更新；7 路失败字节级一致；10 并发同 token 恰 1。

- [X] T008 [P] [US2] [Server] `RefreshTokenService.findActiveByHash(hash, now)` in `refresh-token.service.ts`：`findUnique({where:{tokenHash}})` + `isActive` 过滤 → record|null + 单测（Testcontainers：active 命中 / expired miss / revoked miss / not-found miss，4 测）
- [X] T009 [P] [US2] [Server] `account/inspect-account-status-by-id.usecase.ts`：`execute(accountId): Promise<AccountStatusInspection>`（`findUnique({where:{id}})` + `account.rules.ts` 状态映射，复用既有 `AccountStatusInspection` kind 联合不另造）+ 注册进 `AccountModule` providers/exports + 单测（mock prisma 6 测：by-id 查 / ACTIVE / NOT_FOUND / phone-null / FROZEN / ANONYMIZED）
- [X] T010 [US2] [Server] `RefreshTokenService.rotate(record, clientIp)` in `refresh-token.service.ts`：interactive `$transaction`（`isolationLevel:'Serializable'`）= 条件 revoke 旧（`updateMany where {id, revokedAt:null}`）→ `count===0` throw `UnauthorizedException('INVALID_CREDENTIALS')`（回滚）→ signAccess + generateRefresh + hash + create 新（继承 deviceId/deviceName/deviceType/loginMethod + 更 ipAddress + expiresAt=now+30d）+ 构造器补 `JwtTokenService` DI（persist/find spec 同步加 jwt arg）+ 单测（Testcontainers 3 测：happy 撤旧插新+血缘继承+更 IP+30d+单 active / 单次使用 count===0→401 回滚 / 私网 IP→null）。**隔离级 = READ COMMITTED**（T015 实证修正：原 Serializable 在共享 `revoked_at IS NULL` 偏索引产 40001 SSI 假冲突，独立 token 高并发批量败 72/100；affected-count 乐观锁已独立保证 exactly-once → Serializable 冗余有害，且 Prisma 7 `DriverAdapterError` 令 `code==='P2034'` 检测漏，retry 形同虚设。改 READ COMMITTED + **去掉外层 retry / P2002 catch**，tokenHash 唯一约束违例靠 tx 原子回滚兜底）
- [X] T011 [US2] [Server] `auth/refresh-token.usecase.ts` 编排：hash → `findActiveByHash`（null→401）→ `inspectAccountStatusById`（非 ACTIVE→401，**不**抛 FROZEN 403）→ `rotate` → `RefreshTokenResult`；跨 ctx 注入点 `// CROSS-CONTEXT-SYNC`（注入 `RefreshTokenService` + `InspectAccountStatusByIdUseCase`）+ 单测（mock 6 测：happy / findActive null→401 / NOT_FOUND·ANONYMIZED→401 / FROZEN→401 非 403 / rotate race→透传 401）。**per-token-hash/IP 限流挪到控制器 guard（T012）非 usecase**；module 注册随控制器 T012
- [X] T012 [US2] [Server] `auth/account-token.controller.ts` `POST /api/v1/accounts/refresh-token`（EP1，复用 `PhoneSmsAuthResponse`）+ `refresh-token.request.ts`（`{refreshToken}` + `@IsNotEmpty`，空→400）+ Swagger 装饰器 + register `auth.module.ts`（controller + `RefreshTokenUseCase` provider）；named throttler `refresh-ip` 100/60s（per-throttler getTracker=ip）+ `refresh-token` 5/60s（per-throttler getTracker=`refresh:<sha256(token)>`）入共享数组 + 控制器 `@SkipThrottle` 其余 5 个 + `@UseGuards(ThrottlerGuard)` + 单测（mock usecase 映射）。**反污染（用户选 A）**：给 shipped `/me` GET/PATCH + `sms-codes` 路由 `@SkipThrottle` 补 `refresh-*`（沿用 /me 范式）；**回归验证**：8 个 accounts/tokens e2e 37 测全绿不被新桶污染
- [X] T013 [US2] [Server-IT] `tokens.us2-rotate.it.spec.ts`（Testcontainers PG+Redis 全 boot）：login 取 active token → refresh → 200 新 access/refresh（≠旧）；DB 旧 `revokedAt` 置、新 active、deviceId/deviceType/loginMethod 继承、`ipAddress`=本次（loopback→null）、`expiresAt`≈+30d；重放已轮换 token → 401（单次使用）。2 测全绿
- [X] T014 [US3] [Server-IT] `tokens.us3-anti-enum.it.spec.ts`：7 路失败（not-found/expired/revoked/forged/account-missing/account-not-eligible(FROZEN)/race-lost(重放)）响应 **字节级一致**（剥 per-request `traceId` 后 ProblemDetail 深等；`detail=INVALID_CREDENTIALS` + status 401 + content-type 一致）；请求体缺/空 token → 400（区分）。2 测全绿
- [X] T015 [US4] [Server-IT] `tokens.us4-concurrency.it.spec.ts`（Testcontainers PG，**service 层直测**绕开 HTTP 的 5/60s+100/60s 限流否则混淆）：10 并发持同一 token rotate → 恰 1 成功 + 9×`UnauthorizedException`，DB active=1；100 并发各不同 token（connection_limit=50 池容量）→ 0 错误 + 各账号 active=1。2 测全绿。**TDD 关键发现**：暴露 rotate 的 Serializable SSI 假冲突 + Prisma 7 `isWriteConflict` 漏检 → 用户选方案 A，rotate 改 READ COMMITTED 去 retry（T010 同步重构）。**遗留**：`commit-phone-login.usecase.ts` 的 `isWriteConflict`(`code==='P2034'`) 同样漏检 Prisma 7 DriverAdapterError（pre-existing，越界未改，建议单独 fix）

---

## Phase 5: User Story 5 — 全端登出 LogoutAll (P1)

**Goal**：撤账号全部 active 记录（含当前 device），幂等 204。
**Independent Test**：Testcontainers PG；账号 A 3 active + 1 已撤销 + 账号 B 2 active → logout-all → A 3 撤、A 已撤销时间戳不变、B 不动。

- [X] T016 [US5] [Server] `RefreshTokenService.revokeAllForAccount(accountId, now)` in `refresh-token.service.ts`：`updateMany where {accountId, revokedAt:null} set revokedAt=now`（count 忽略，幂等；`revokedAt:null` 过滤令已撤行时间戳不变）+ 单测（Testcontainers 2 测：A 3 active+1 已撤→全撤+已撤时间戳不变+B 隔离 / 0 active 幂等不报错）
- [X] T017 [US5] [Server] `auth/logout-all.usecase.ts`（accountId from JWT sub → `revokeAllForAccount` → void）+ `account-token.controller.ts` `POST /api/v1/accounts/logout-all`（EP2，返回 **204**）；**JwtAccessGuard**（T001 决策 B：auth 薄 guard 委托 `JwtTokenService.verifyAccess`，只验 token 不做 isActive 门控 → frozen 也可登出）；guards 挂**方法级**（JwtAccessGuard 先填 req.user → ThrottlerGuard 读 account tracker）；throttler `logout-all-ip` 50/60s + `logout-all-account` 5/60s 入共享数组 + 全路由 `@SkipThrottle` 反污染（refresh/me/sms 补 logout-all-*）+ 单测（usecase 1 / controller logout-all 1）。**JwtAccessGuard 走 e2e 测**（ADR-0040 no-bad-mocks 禁 guard 隔离 `new`，沿用 account guard 仅 e2e 覆盖范式 → T018 IT 覆盖 204 + 401 token 路径）。回归：refresh+me-patch+sms 22 e2e 全绿
- [X] T018 [US5] [Server-IT] `tokens.us5-logout-all.it.spec.ts`（全 boot，token 经模块 `JwtTokenService` 直签避 SMS 限流）：幂等（N→204 + 再次 204 + 0 active→204）+ 隔离（已撤记录时间戳不变 / B 账号 2 active 不受影响）+ 鉴权缺失→401 + 无效 token→401（覆盖 JwtAccessGuard）。4 测全绿

---

## Phase 6: User Story 6 — 限流 (P2)

**Independent Test**：Testcontainers + Redis；refresh 同 token 第 6 次 429、同 IP 第 101 次 429；logout-all 同账号第 6 次 429、同 IP 第 51 次 429。

- [X] T019 [US6] [Server-IT] `tokens.us6-rate-limit.it.spec.ts`（全 boot + `beforeEach` Redis flushall 隔离桶）：4 规则 → 429（refresh-token 第 6 / refresh-ip 第 101 / logout-all-account 第 6 / logout-all-ip 第 51）。4 测全绿。**发现**：ThrottlerException 的 `Retry-After` 头未经 `ProblemDetailFilter` 透出（filter 仅 `body.retryAfterSeconds` 存在时设头）→ 全 throttler 429（含 shipped SMS FR-S07）缺 Retry-After，**pre-existing 跨切面 gap，建议单独 fix**（越界未改）

---

## Phase 7: Contract（类型同步链，Constitution V）

- [X] T020 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（含 `/api/v1/accounts/refresh-token` + `/logout-all`）→ `nx run api-client:generate`（Orval regen）→ 生成 `accountTokenControllerRefresh` / `accountTokenControllerLogoutAll` + react-query hooks（**函数式非 class** ✓）+ api-client/mobile typecheck 绿。**附带**：regen 同步了此前 stale 的 `/healthz` 端点（19 新文件，drift 修正，orval all-or-nothing 无法只 regen 单端点）

---

## Phase 8: User Story 7 — 透明续期 (P1) + US8 登出 wrapper (P2)（client，无可见 UI）

**Goal**：401 透明续期（single-flight + retry once + 豁免）；logout-all wrapper（finally 清 session）。
**Independent Test**：vitest logic-level（拦截器调用次数 / 重试 / 清 session）；Playwright Web e2e 端到端续期。

- [X] T021 [P] [US7] [Mobile] device id 生成 + 本地持久化（`apps/mobile/src/auth/`：uuid v4 + `expo-secure-store`，web localStorage fallback）+ api-client 请求拦截器注入 `X-Device-Id` 头 + logic 单测。**已由既有 A3 gap-audit 实装覆盖**（`device-store.ts` `getOrInitId()` 惰性合成 + persist 走 `expo-secure-store`/web `localStorage` fallback + `setup.ts` 请求拦截器注入 `x-device-id`；`device-store.spec.ts` 16 测绿）；**drift（已确认不返工）**：id 用 `nanoid(21)` 非 `uuid v4` —— 功能等价（稳定 per-install 标识，满足 FR-C04），且既有实现额外发 `x-device-name`/`x-device-type`（server 本批次忽略，铺 005）。Surgical Edits 不重写 working code
- [X] T022 [US7] [Mobile] 透明续期拦截器：401 → single-flight 一次 refresh（共享 in-flight promise）→ 新 access 重试原请求一次（`x-nvy-retry` 标记防二次）→ refresh 端点豁免 → 失败清 session + 路由 login（AuthGate 观察 `isAuthenticated`）+ vitest logic-level（18 测：flow 真调 Orval `accountTokenControllerRefresh` 成功 setSession/失败 clearSession + single-flight 调 1 次 + 拦截器 happy 重试带新 token/非-401 不刷/refresh 端点豁免/retry 标记拦/无 refreshToken 跳过/失败透传原 401/并发 401 共享 1 refresh）。**plan drift（已确认按实装走）**：plan 设想拦截器落 `packages/api-client/src/`，但该包是纯 Orval 生成模块绑全局 axios 实例，**不能** import mobile zustand store/router（非法依赖倒置）→ 落 `~/auth/token-refresh.ts`（`makeAuthRefreshResponseInterceptor(client)` 工厂，持 session store）由 `~/core/api/setup.ts` 绑全局 axios response interceptor（请求拦截器同处）。Metro `.js` 陷阱：相对 import extensionless ✓
- [X] T023 [P] [US8] [Mobile] `logout-all` wrapper（`apps/mobile/src/auth/logout-all.ts`）：`logoutAll()` 调 Orval `accountTokenControllerLogoutAll` + `finally` 无条件清 session（zustand `clearSession`，服务端失败 `catch` 吞错不阻塞登出）+ 路由 login（AuthGate 观察 `isAuthenticated`，wrapper 不导航）+ export from `auth/index.ts` + 单测 2 测（成功清 session resolves / 失败仍清 session 且 resolves 不 throw）。**无可见 UI**（登出按钮随 settings shell 独立 spec）
- [X] T024 [US7] [Mobile-E2E] `apps/mobile/e2e/tokens-refresh.spec.ts`（Playwright Web）：seed authed session（refreshToken 有、accessToken 无 = cold-boot）→ AuthGate 落 onboarding → 提交昵称 PATCH `/me` 无 Authorization → **401** → 响应拦截器 single-flight 一次 POST `/refresh-token` → 带新 access 重试 PATCH → **200** → redirect `/profile` 显示新昵称。stateful route handler（PATCH `/me` 按 `Authorization` 头 401↔200 切换 + POST `/refresh-token` 计数）断言 `refreshCalls===1` + unauthed/authed 各 ≥1（FR-C01/C02）。**run 实证：1 passed (6.5s)**，浏览器 console 见 401 后透明续期成功。**实装偏差说明**：plan/spec 设想用 GET `/me`（useMe）触发 401，但 `useMe()` 全仓未挂载（定义未消费）→ 改用 onboarding 提交的 PATCH `/me`（唯一 UI 驱动的已认证业务调用）触发，端到端等价。复用 onboarding e2e seed/选择器范式（非 mockJson，因需按 header stateful）

---

## Phase 9: Polish & Verify

- [X] T025 [Server] catalog Operation 清单新增行：`server-bounded-context-catalog.md` § Operation Catalog 已实装表加 6 行（`refresh-token`/`logout-all` auth 编排 + `inspect-account-status-by-id` account 只读 + `persist`/`rotate`/`revoke-all-refresh-token` security）+ 从 anticipated 表移除已实装的 `refresh-token` + 日期 bump 2026-05-25；spec frontmatter `status: draft→implemented`（**附带修正** `modules: [auth, security]→[auth, security, account]` —— T009 加了 account `inspect-account-status-by-id` use case，倒查需 account in modules，per bounded-context rule）；plan frontmatter `status: drafted→done`
- [X] T026 [Verify] **全门绿**（base=origin/main，--skip-nx-cache）：lint+typecheck（4 projects 0 errors）/ test（server 277 passed +1 skip env-gated perf IT，含 tokens US1-US6 全 Testcontainers IT；mobile 117；api-client；@nvy/checks）/ build（4 projects）/ runtime-smoke（**server-boot-smoke** 真 boot NestFastify+真 PG/Redis 探 `/me`→401 + `/sms-codes`→400 契约 ✓；**mobile** `expo export -p web` 全 bundle + playwright **11 e2e 全绿**含 T024 tokens-refresh + login/onboarding/profile）+ `check-server-moat.ts` **0 违规**。**真后端冒烟说明**：refresh+logout-all 的真 HTTP-against-真后端覆盖由全-AppModule-boot ITs（T013 rotate / T018 logout-all / T019 rate-limit，真 PG+Redis 真 HTTP）+ server-boot-smoke（真 app 启动）提供，比手动 curl 更全；未另跑交互式 curl（IT 等价覆盖）

---

## Dependencies（完成顺序）

```text
Setup(T001) → Foundational(T002-T004) → US1(T005-T007) → US2/3/4(T008-T015) → US5(T016-T018) → US6(T019) → Contract(T020) → US7/8(T021-T024) → Polish(T025-T026)
```

- **US1 是 MVP 基座**（无持久化则 US2/US5 无行可操作）→ 先行。
- **T004（service skeleton + export）阻塞** T005/T008/T010/T016（同文件方法）。
- **US2 内**：T008（findActive）+ T009（inspect-by-id）可并行 [P]；T010（rotate）依赖 T008；T011（usecase）依赖 T008/T009/T010；T012（controller）依赖 T011。
- **US5** 依赖 Foundational（T004）+ T001（guard）；与 US2 共改 `account-token.controller.ts`（顺序合并，非并行）。
- **Contract（T020）** 依赖 server 端点全落（T012 + T017）。
- **Client（US7/8）** 依赖 T020（typed api-client）。
- **T015（并发 IT）** 依赖 T010+T012 全落。

## Parallel Opportunities

- Foundational：T002（hasher）∥ T003（rules）。
- US2：T008（findActive）∥ T009（inspect-by-id）。
- Client：T021（device id 注入）∥ T023（logout wrapper）（不同文件）。

## Implementation Strategy

1. **MVP = US1**（签发持久化）：先让登录落库，建立可轮换/可撤销的基座。
2. **增量**：US2（轮换，含反枚举 US3 + 并发 US4 IT）→ US5（登出）→ US6（限流验证）。
3. **同步链 + client**：server 端点稳定后跑 Contract（T020）→ client 透明续期 + wrapper（US7/8）。
4. **收尾**：catalog + frontmatter + 全门 verify（T025-T026）。
5. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环）。
