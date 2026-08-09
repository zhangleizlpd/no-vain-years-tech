---
feature_id: 005-device-management
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-26'
---

# Tasks: 005-device-management（登录设备列表 + 单设备远程撤销）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `005-device-management`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]`（本批 server-only，无 `[Mobile]`）
- **TDD（强制）**：每个 impl task 内联绑 **unit 测试**（红→绿→typecheck/lint→`[X]`→commit，6 步闭环，per `.claude/rules/implement-task-closure.md`）；**integration 测试（Testcontainers）单列 `[Server-IT]` task**（= 每 US 的 Independent Test 验收）
- 无 task-meta JSON（手动模式，per p3 §3）
- 本批 **server-only**（client 登录管理屏延后到 settings shell，per clarify）；contract regen 仍同 PR
- **并发原语**（D4）：单行撤销用 READ COMMITTED + 条件 UPDATE `updateMany` affected-count，**不**用 `FOR UPDATE` / Serializable（per plan D4 + memory `prisma_serializable_p2002_and_p2034`）

## Path Conventions

- server：`apps/server/src/{auth,security}/`（ADR-0043 扁平，文件平铺）；IT：`apps/server/test/integration/`
- 数据资产：`apps/server/src/security/data/ip2region_v4.xdb`（Nx build assets 拷 dist）
- contract：`apps/server/openapi.json` → `packages/api-client/`（Orval）

---

## Phase 1: Setup & 决策（D1/D6）

- [X] T001 [Server] 装 `ip2region.js@3.1.8`（`pnpm -C apps/server add ip2region.js@3.1.8`）+ 从 upstream `lionsoul2014/ip2region` `data/ip2region_v4.xdb` 取文件 commit 到 `apps/server/src/security/data/ip2region_v4.xdb` + `apps/server/project.json` `build` target `assets` 数组加 `{ "glob": "**/*.xdb", "input": "apps/server/src/security/data", "output": "./data" }` + verify `nx build server --skip-nx-cache` 后 `dist/apps/server/data/ip2region_v4.xdb` 存在。锚定 plan：D1 库选型 / D6 资产投递（SWC 不拷非 TS 资产，IPv4-only）

## Phase 2: Foundational（阻塞 US — security geo + refresh-token 扩 + auth event/exception）

- [X] T002 [P] [Server] `ip-geo.service.ts` in `apps/server/src/security/`（`@Injectable` + `OnModuleInit`：`newWithBuffer(IPv4, readFileSync(<dist>/data/ip2region_v4.xdb))` 建单例 searcher，`__dirname` 相对解析非 bundler import）：`resolve(ip: string | null): Promise<string | null>` —— 私网/loopback/null/非法/IPv6/不可解析 → null；命中 → 按 `ip2region.js` 新 5 字段 `Country|Province|City|ISP|iso` 切 `省(idx1)+市(idx2)` 拼接（中国境内）。注册 `SecurityModule` providers + **exports**。单测：公网真值 IP→省市字符串 / 私网（10./192.168./127.）→null / null 入参→null / malformed→null / IPv6→null（真值锚定 `ip2region.js` 实际返回，**非** mock）。**run via `nx test server <file>`**
- [X] T003 [P] [Server] `refresh-token.service.ts` in `apps/server/src/security/` 扩 3 法：`listActiveByAccount(accountId, page, size): Promise<{ rows: RefreshToken[]; total: number }>`（`findMany WHERE {accountId, revokedAt:null} ORDER BY createdAt DESC` + `count`，`size` clamp ≤100，`page` 0-based，偏索引 `idx_refresh_token_account_device_active`）/ `findById(recordId): Promise<RefreshToken | null>`（`findUnique`，供 guard）/ `revokeOneForAccount(recordId, accountId, now, tx?: TxClient): Promise<{ won: boolean }>`（条件 `updateMany WHERE {id, accountId, revokedAt:null}` set revokedAt → `won = count===1`，tx 重载与 `revokeAllForAccount` 同款）+ 单测（Testcontainers PG：list 活跃/已撤销过滤 + createdAt DESC + 分页 + size>100 截断 + 空；findById 命中/miss；revokeOne 跨账号 won=false / 已撤幂等 count=0 / tx rollback 联动）。**回归**：003 rotate / revokeAllForAccount / persist 既有行为不变
- [X] T004 [P] [Server] `device-revoked.event.ts` in `apps/server/src/auth/`：事件类型 + payload `{ accountId, recordId, deviceId, revokedAt, occurredAt }` + `DEVICE_REVOKED_EVENT_TYPE='auth.device.revoked'`（plan D3：`<producer-ctx>.<aggregate>.<action>`，producer=auth；analyze 2026-05-26 确认）（镜像 `account-deletion-requested.event.ts`）+ 单测（payload shape + type 常量）
- [X] T005 [P] [Server] 2 exception in `apps/server/src/auth/`：`device-not-found.exception.ts`（`HttpException` 404，`code='DEVICE_NOT_FOUND'`，RFC 9457 ProblemDetail）+ `cannot-remove-current-device.exception.ts`（409，`code='CANNOT_REMOVE_CURRENT_DEVICE'`），镜像 `auth-attempt-locked.exception.ts` + 单测（status + code 映射）

## Phase 3: User Story 1 — 查看登录设备列表 ListDevices (P1) 🎯 MVP

**Independent Test**（spec US1）：预置账号 N 活跃 + 已撤销 + 他人行 → authed GET（带 `x-device-id`）→ 仅本账号活跃、createdAt DESC、字段齐、私网行 location 空、响应无 raw IP、当前设备 isCurrent。

- [X] T006 [US1] [Server] `list-devices.usecase.ts` in `apps/server/src/auth/` + `device-list.response.ts`（DTO：envelope `{page,size,totalElements,totalPages,items}` + `DeviceListItem{id,deviceId,deviceName,deviceType,location,loginMethod,lastActiveAt,isCurrent}`，**无 ipAddress**，swagger 装饰器）：注入 `RefreshTokenService`（`// CROSS-CONTEXT-SYNC: auth→security 读 refresh_token 设备列表（R2 只读，经 security 服务方法非直读表）`）+ `IpGeoService`（platform infra）→ `listActiveByAccount(accountId, page, size)` → 逐行 `ipGeo.resolve(row.ipAddress)` 得 location + `isCurrent = row.deviceId === currentDeviceId` + map item（剥 ipAddress）→ envelope。单测（mock：geo enrich / isCurrent 头比对 / **剥 raw IP**（断言响应无 ipAddress 字段）/ 分页 envelope 计算 / 缺 `x-device-id` 头 → isCurrent 全 false 仍返列表）
- [X] T007 [US1] [Server] `device-management.controller.ts` in `apps/server/src/auth/`（`@Controller('v1/auth/devices')`，挂 `JwtAuthGuard`）：`@Get()`（EP1，accountId from JWT sub，currentDeviceId from `@Headers('x-device-id')`，`@Query('page'/'size')` int 校验非法→400 `FORM_VALIDATION`）+ Swagger（200/401/429）+ register `auth.module.ts`（controller + usecase provider）+ named throttler `dev-list-account` 30/60s（AccountIdThrottlerGuard 复用）+ `dev-list-ip` 100/60s + `@SkipThrottle` 其余桶 + 单测（mock usecase 映射 + query 非法 400 + 200 envelope）
- [X] T008 [US1] [Server-IT] `apps/server/test/integration/devices.us1-list.it.spec.ts`（Testcontainers PG+Redis 全 boot）：某账号 login 取 token + 预置该账号 3 活跃（不同 deviceId / 含私网 IP 行 + 公网 IP 行）+ 1 已撤销 + 另账号 1 行 → GET（`x-device-id`=其中一行）→ 200 + items 恰 3（已撤销 + 他人不出现）+ createdAt DESC + 私网行 `location` 空 + **响应 JSON 无任何 raw IP 字面值** + `x-device-id` 命中行 `isCurrent=true` 其余 false；size=500 → 实际 ≤100

## Phase 4: User Story 2 — 撤销某设备 RevokeDevice (P1)

**Independent Test**（spec US2）：预置本账号 A(当前)+B + 他人行 → DELETE B → 200 + B revokedAt + outbox 1 event + A 不变；DELETE A → 409；DELETE 他人/不存在 → 404；DELETE 已撤 B → 幂等 200 无新事件。

- [X] T009 [US2] [Server] `revoke-device.usecase.ts` in `apps/server/src/auth/`（**持 tx**）：取 accountId + currentDeviceId（`x-device-id`，**缺失 → `UnauthorizedException`** FR-S12 防自撤前置）→ `refreshTokenService.findById(recordId)`：`null` **或** `row.accountId !== accountId` → throw `DeviceNotFoundException`（404 折叠，反枚举）；`row.deviceId === currentDeviceId` → throw `CannotRemoveCurrentDeviceException`（409）→ `prisma.$transaction`(READ COMMITTED)：`refreshTokenService.revokeOneForAccount(recordId, accountId, now, tx)`（`// CROSS-CONTEXT-SYNC: 撤单行 token 失败回滚整请求`）→ `won` ? `outbox.publish(tx, DEVICE_REVOKED_EVENT_TYPE, payload)`（`// CROSS-CONTEXT-ASYNC: auth.device.revoked`）: skip（幂等）→ 完成。单测（mock：happy 各步序 + 发事件 / findById null → 404 / 跨账号 → 404（与 null 同响应）/ deviceId==current → 409 / 缺 x-device-id → 401 / won=false（已撤）→ 幂等不发事件 / publish 抛 → 整 tx 回滚无副作用）
- [X] T010 [US2] [Server] `device-management.controller.ts` 加 `@Delete(':recordId')`（EP2，`@Param('recordId')` int 校验非法→400 / `@HttpCode(200)`，currentDeviceId from `x-device-id`）+ Swagger（200/401/404 DEVICE_NOT_FOUND/409 CANNOT_REMOVE_CURRENT_DEVICE/429）+ named throttler `dev-revoke-account` 5/60s + `dev-revoke-ip` 20/60s + register usecase provider + 单测（mock 映射 404/409/200 + recordId 非法 400）
- [X] T011 [US2] [Server-IT] `apps/server/test/integration/devices.us2-revoke.it.spec.ts`（全 boot）：账号 login（设 `x-device-id`=A）+ 预置该账号第二行 B（另 deviceId）+ 他人行 X → DELETE B（带 A 头）→ 200 + DB B `revokedAt` 置 + outbox 1 条 `auth.device.revoked`（payload 逐字段：accountId/recordId=B.id/deviceId=B.deviceId/revokedAt/occurredAt）+ A 行不变；DELETE A（当前）→ 409 `CANNOT_REMOVE_CURRENT_DEVICE` 无事件；DELETE X.id（他人）→ 404 `DEVICE_NOT_FOUND`；DELETE 不存在 id → 404；DELETE B 再次 → 幂等 200 无新事件（outbox 仍 1 条）

## Phase 5: User Story 3 — 撤销反枚举 + 并发恰一成功 (P1, 安全)

**Independent Test**（spec US3）：不存在 vs 跨账号 404 字节级一致；N 并发撤同行 → 恰 1×(撤+事件) + (N-1)×幂等 200。

- [X] T012 [US3] [Server-IT] `apps/server/test/integration/devices.us3-anti-enum-concurrency.it.spec.ts`：①「不存在 recordId」与「他人账号 recordId」两类 DELETE 响应剥 traceId 后 ProblemDetail 深等（字节级一致，均 404 `DEVICE_NOT_FOUND`）②预置 1 未撤销行，5 并发持同 recordId DELETE（service 层直测绕限流）→ 恰 1×（真撤销 won=true + 发 1 事件）+ 4× 幂等 200（won=false），DB `revokedAt` 单次落定 + outbox `auth.device.revoked` 恰 1 条（重复跑 N 次稳定）

## Phase 6: User Story 4 — 限流 (P2)

**Independent Test**（spec US4）：4 桶各超限 → 429 + Retry-After。

- [X] T013 [US4] [Server-IT] `apps/server/test/integration/devices.us4-rate-limit.it.spec.ts`（全 boot + `beforeEach` Redis flushall）：4 规则各超限 → 429 + `Retry-After`（list account 第 31 / IP 第 101 · revoke account 第 6 / IP 第 21）+ 无公网 IP 时 IP 桶跳过

## Phase 7: 采集补强 (FR-S14, 独立可并行)

- [X] T014 [P] [Server] 设备名/类型采集补强：`account-phone-sms-auth.controller.ts`（login）+ `cancel-deletion.controller.ts` 加 `@Headers('x-device-name')` / `@Headers('x-device-type')` 透传到各自 usecase → `RefreshTokenService.persist` meta（`deviceName`/`deviceType`；`cancel-deletion.usecase.ts` L~100 现 `{ deviceId, clientIp, loginMethod }` 补这两字段）。**refresh（`account-token.controller.ts`）不改**（rotate 继承父行血缘）+ 单测（带 name/type 头 → 落库可读值；不带头 → `deviceName=null`/`deviceType=UNKNOWN` 既有行为回归不破）

## Phase 8: Contract（类型同步链，Constitution V）

- [X] T015 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（含 2 端点：GET `v1/auth/devices` · DELETE `v1/auth/devices/:recordId`）→ `nx run api-client:generate`（Orval regen）→ 生成 typed 调用 + react-query hooks（**函数式非 class** ✓）+ api-client/mobile typecheck 绿。**本批 mobile 不消费**（登录管理屏延后），device 端点 regen 供后续 settings shell

## Phase 9: Polish & Verify

- [X] T016 [Server] catalog Operation 清单新增 6 行：`server-bounded-context-catalog.md` § Operation Catalog 加 `list-devices`/`revoke-device`（auth 编排）+ `list-active-refresh-tokens`/`find-refresh-token-by-id`/`revoke-one-refresh-token`（security 扩 `RefreshTokenService`）+ `resolve-ip-location`（security `IpGeoService`，platform infra）；标注 `auth.device.revoked` R3 事件；spec frontmatter `status: clarified→implemented`；plan frontmatter `status: planned→done`
- [X] T017 [Verify] **全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`）：lint+typecheck（server + api-client 0）/ test（server 全 Testcontainers IT 含 US1-US4；ip-geo + refresh-token 扩单测；api-client）/ build / runtime-smoke（server-boot-smoke 真 boot 探 2 端点契约 + **built dist `data/ip2region_v4.xdb` 资产探活**）+ `check-server-moat.ts` **0 违规**（auth→security 跨 ctx 注释齐：服务注入 `// CROSS-CONTEXT-SYNC` / outbox `// CROSS-CONTEXT-ASYNC`；auth 不直碰 `prisma.refreshToken` 故无 `CROSS-CONTEXT-READ` 逃生口）+ 真后端冒烟（login→list devices→revoke 主路径 curl 或 IT 等价）

---

## Dependencies（完成顺序）

```text
Setup(T001) → Foundational(T002-T005) → US1(T006-T008) → US2(T009-T011) → US3(T012) → US4(T013) → 采集补强(T014) → Contract(T015) → Polish(T016-T017)
```

- **Setup 阻塞 geo**：T001（装 ip2region.js + xdb 资产）→ T002（IpGeoService 载 xdb）。
- **Foundational 阻塞 US**：T002（geo）+ T003（list 法）→ **US1**（T006）；T003（findById/revokeOne）+ T004（event）+ T005（exceptions）→ **US2**（T009）。
- **US1** 内：T006（usecase + DTO）→ T007（controller GET，依赖 T006）→ T008（IT，依赖 T007）。
- **US2** 内：T009（usecase，依赖 T003/T004/T005）→ T010（controller DELETE，依赖 T009 + T007 同 controller 文件）→ T011（IT，依赖 T010）。
- **US3（T012）** 依赖 T010（revoke 端点 + usecase 全落）。
- **US4（T013）** 依赖 T007 + T010（两端点 + 4 throttler 桶全落）。
- **采集补强（T014）** 独立（改 login / cancel-deletion controller，与 device 端点不同文件）——可与 US1-US4 并行。
- **Contract（T015）** 依赖 2 端点全落（T007 + T010）+ DTO（T006）。
- **Polish（T016/T017）** 最后（catalog + frontmatter + 全门 verify）。

## Parallel Opportunities

- **Foundational**：T002（ip-geo）∥ T003（refresh-token 扩）∥ T004（event）∥ T005（exceptions）—— 4 个不同文件，互不依赖。
- **采集补强 T014** ∥ 任意 US 阶段（不同 controller 文件，无共享可变状态）。
- US1 与 US2 的 usecase 层（T006 ∥ T009）不同文件可并行；但二者的 controller task（T007/T010）改同一 `device-management.controller.ts` → **不可并行**（T007 先建文件，T010 加 DELETE）。

## Implementation Strategy

1. **Setup 先行**：T001 把 ip2region.js + xdb 资产投递 + Nx build assets 跑通（D1/D6，**先验 built dist 有 xdb** 再往下，避免 prod ENOENT）。
2. **Foundational 平台层**：geo 解析（T002，真值锚定）+ refresh-token 三单行法（T003，affected-count）+ event/exception（T004/T005）—— 全 [P] 并行。
3. **MVP = US1**（设备列表）：T006-T008，验 list 投影 + geo enrich + isCurrent + **剥 raw IP** 反枚举主路径。
4. **核心动作 US2**（撤销）：T009-T011，auth 持 tx 委托 security 单行撤 + 首个 `DeviceRevokedEvent` outbox 发布；含 404/409 guards + 幂等。
5. **安全/限流加固**：US3（反枚举字节级 + 并发恰一）→ US4（4 桶限流）。
6. **采集补强 + 同步链**：T014（login/cancel-deletion 补读 name/type 头）→ Contract（T015 openapi+Orval regen）。
7. **收尾**：catalog 6 行 + frontmatter + 全门 verify（含 runtime-smoke **built dist xdb 探活**）。
8. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环）；单行撤销全程 affected-count（D4，禁 FOR UPDATE/Serializable）。
