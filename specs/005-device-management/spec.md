---
feature_id: 005-device-management
modules: [security, auth]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-26'
updated_at: '2026-05-29'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
perf_budgets:
  - endpoint: 'GET /api/v1/auth/devices'
    p95_ms: 150
    p99_ms: 300
  - endpoint: 'DELETE /api/v1/auth/devices/{recordId}'
    p95_ms: 120
    p99_ms: 250
web_compat: na
web_compat_notes: 'Client 段（登录管理屏）已定延后（clarify 2026-05-26）—— settings shell（spec B）未建、无正式入口；本批 server-only（2 端点 + 设备名/类型采集补强），无 mobile 改动、无 web e2e。登录管理屏随 settings shell 落地后单独接入（仿 004 delete-account 延后先例）。'
agent_friction_observed: false
state_branches:
  - 'list-devices: 已登录账号 → 该账号全部活跃（revokedAt=null）refresh token 按 createdAt DESC 分页返回；每行 = {id, deviceId, deviceName, deviceType, location, loginMethod, lastActiveAt, isCurrent}；原始 IP 不外露（仅 ip2region 解析后的中文省市，私网/不可解析 → 空）'
  - 'list-devices: isCurrent = 当前请求 x-device-id 请求头与该行 deviceId 相等 → true（不引入 JWT did claim，clarify 2026-05-26 定）'
  - 'list-devices: size 缺省 10、上限 100（超限截断）；page 0-based；空列表（仅当前设备 / 无活跃 token）→ 合法返回空/单元素'
  - 'revoke-device: 目标行存在 ∧ 属本账号 ∧ deviceId≠当前设备 ∧ revokedAt=null → 条件 UPDATE（affected-count 乐观锁）置 revokedAt + 同事务发 DeviceRevokedEvent 到 outbox + 200'
  - 'revoke-device: 目标行 deviceId == 当前设备 → 409 CANNOT_REMOVE_CURRENT_DEVICE（引导走「退出登录」）'
  - 'revoke-device: 目标行不存在 OR 属他人账号 → 404 DEVICE_NOT_FOUND（字节级一致，不泄露归属，反枚举）'
  - 'revoke-device: 已撤销行（revokedAt≠null）→ 幂等 200，不重复发事件'
  - 'revoke-device 并发: N 并发撤销同行 → affected-count 裁决恰 1 真撤销 + 发 1 条事件，其余幂等 200，无重复事件'
  - 'revoke-device: 事务任一步失败（撤销写 / outbox 发布）→ 整体回滚（行未撤、无事件）'
  - 'revoke-device: 缺 x-device-id 设备标识（无法判定当前设备防自撤）/ 未认证 → 401'
  - '采集补强: token 签发路径（login / cancel-deletion controller，refresh 继承父行血缘不读头）补读 x-device-name / x-device-type（client 已发，setup.ts 实证），新登录设备落可读名称/类型；存量行降级 null/UNKNOWN'
  - '限流超限（list 30/account·100/IP；revoke 5/account·20/IP，均 /60s，IP 桶按 socket IP 计）→ 429 + Retry-After'
---

# Feature Specification: Device / Login Management（登录设备列表 + 单设备远程撤销）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-26)]**
> 本 feature 按 **Flat + Anemic + Moat** 范式实现（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）+ bounded context 边界（[ADR-0032](../../docs/adr/0032-backend-bounded-context.md)）。spec 只描述业务行为，不含实现技术词（ip2region 库选型等归 `/speckit-plan`）。

**Feature Branch**: `005-device-management`
**Created**: 2026-05-26
**Status**: Clarified（clean-room mode-1a：旧 Java `mbw-account` `ListDevicesUseCase` / `RevokeDeviceUseCase` + `DeviceManagementController` + 旧 IT 三源净室提取；旧技术词 0 残留；2026-05-26 clarify 结算 3 开放点 → **本批 server-only**）
**Module**: `security`（`refresh_token` 设备元数据读 / 单行撤销、反枚举 404、affected-count 乐观锁）+ `auth`（authed 设备管理端点 `/v1/auth/devices` 编排；token 签发路径补读设备名/类型头）
**Input**:

- 已登录用户可（1）查看自己**所有活跃登录设备**（= 未撤销 refresh token，每台一行），（2）**远程撤销某一台设备**（单设备登出，区别于「全端登出」LogoutAllSessions）。
- 旧 Java `mbw-account` 2 个 use case 迁入 mono：`ListDevices` / `RevokeDevice`。
- 设备元数据（`deviceId` / `deviceName` / `deviceType` / `ipAddress` / `loginMethod`）已随 Plan 1 token 持久化落在 `refresh_token` 表（含偏索引 `idx_refresh_token_account_device_active`）。**本 feature 不新增表、不改表结构。**
- 首次落地 **`DeviceRevokedEvent`**（撤销成功同事务写 outbox）+ 首次落地 **IP → 地理位置解析**（ip2region 的 Node 等价，库选型归 plan）。
- **本批 server-only**：2 端点 + 设备名/类型采集补强；mobile 登录管理屏延后（见 § Out of Scope，clarify 2026-05-26 定）。
- **2026-05-29 amend（branch `005-device-management-client`，p4 子 plan B2）**：mobile 登录管理屏（US5）落地，高保真 port 旧 app；含**一处 server contract 注解修正**（FR-S15，`recordId` @ApiParam type:string + api-client regen，运行时行为不变）。本 amend = server contract polish + mobile client，server↔app 同 1 PR。

## Context

- **核心资源 = `refresh_token` 行**：一台「设备」= 一条活跃 refresh token 行（`revokedAt=null`）。设备列表 = 该账号活跃行的投影；撤销设备 = 把对应行 `revokedAt` 置当前时刻（远程登出，该设备下次刷新即失效）。与 003 `LogoutAllSessions`（撤全部行）正交：本 feature 撤**单行**。

- **反枚举不变性**（贯穿）：
  - **原始 IP 不外露**：列表项只暴露 `ipAddress` 经 ip2region 解析后的中文省市 `location`；私网 / loopback / 不可解析 → `location` 为空。原始 IP 字面值绝不进响应（防设备位置 / 网络拓扑泄露）。
  - **撤销归属不可枚举**：撤销「目标行不存在」与「目标行属他人账号」折叠为**字节级一致** 404 `DEVICE_NOT_FOUND`（不泄露某 recordId 是否存在 / 归谁）。

- **当前设备判定（clarify 2026-05-26 定）**：`isCurrent` 与防自撤均以**当前请求的 `x-device-id` 头**与各行 `deviceId` 比对得出 —— mono access token 只签 `{ sub }`、**无 `did` claim**（`jwt-token.service.ts` 实证），故**不引入 JWT did claim**（避免扩散到 001/003 全部 token 签发路径）。客户端每次 authed 请求已携带 `x-device-id`（`core/api/setup.ts` 实证）。spoofing `x-device-id` 仅影响自身的 isCurrent / 防自撤（自害，非对他人攻击面）。

- **并发控制 = affected-count 乐观锁**：撤销走条件 UPDATE `WHERE id=? AND revoked_at IS NULL`，`affected==1` 为真撤销（发事件）、`affected==0` 为竞态败者（按幂等 200 处理，不发事件）。**禁** `FOR UPDATE` / Serializable（单行条件更新用 READ COMMITTED + affected-count，per memory `prisma_serializable_p2002_and_p2034`）。

- **事务边界 + 跨 context 事件**：撤销成功时，DB 写（置 `revokedAt`）+ outbox 写（`DeviceRevokedEvent`）在**同一事务**内（[ADR-0033](../../docs/adr/0033-outbox-cross-context-comm.md)，`publish(client, eventType, payload)` 同 tx），任一失败整体回滚。事件 `producer_context` 与精确 event-type 字符串（mono `<producer-ctx>.<aggregate>.<action>` 范式，参 004 analyze I1）在 `/speckit-plan` / `/speckit-analyze` 定。**本 feature 仅发布，无 in-process 消费方**（审计 / 通知归后续）。

- **设备名/类型采集补强（clarify 2026-05-26 定）**：mono 现状 token 签发 controller 只读 `x-device-id`（+ IP），未读 `x-device-name` / `x-device-type` → 存量 `refresh_token` 行 `deviceName=null` / `deviceType=UNKNOWN`。客户端**已发**这三头（`core/api/setup.ts` 从 `useDeviceStore`），persist 服务**已支持**存储名/类型（仅 controller 入参缺失）。本批在 token 签发路径（login / cancel-deletion controller，refresh 继承父行血缘不读头）补读这两头入库，使新登录设备具可读名称 / 类型；存量行优雅降级。

- **横切复用（不重立）**：限流（`@nestjs/throttler` + Redis storage，[ADR-0022](../../docs/adr/0022-throttler-nestjs-redis.md)）/ RFC 9457 ProblemDetail 全局错误映射 / `JwtAuthGuard` 鉴权 / `refresh_token` 设备元数据持久化与轮换继承（001/003 ship）均已就位；本 spec 引用，不重新建立。

- **bounded context**（precise 归属 + catalog Operation 行在 `/speckit-plan` 阶段按 [catalog](../../docs/conventions/server-bounded-context-catalog.md) 3 传播规则 + 7 决策问题定）：`security` 持 `refresh_token` 设备数据读 + 单行撤销 + 发 `DeviceRevokedEvent`；`auth` 编排 authed 设备管理端点。

- **数据模型已就位**（`apps/server/prisma/schema.prisma`，db-pull）：`RefreshToken` 含 `id` / `accountId` / `tokenHash` / `expiresAt` / `revokedAt` / `createdAt` / `deviceId`（NOT NULL）/ `deviceName`（nullable）/ `deviceType`（默认 `UNKNOWN`）/ `ipAddress`（nullable）/ `loginMethod`（默认 `PHONE_SMS`）+ 偏索引 `idx_refresh_token_account_device_active`（`(account_id, device_id) WHERE revoked_at IS NULL`）正好驱动列表查询与「当前设备」匹配。

## Clarifications

### Session 2026-05-26

- Q: `isCurrent`（标记当前设备）怎么判定？mono access token 只签 `{ sub }`、无旧 Java 依赖的 `did` claim。 → A: **用 `x-device-id` 请求头比对** —— 当前请求的 `x-device-id` 头（客户端每次 authed 请求已携带，`core/api/setup.ts` 实证）与各行 `deviceId` 相等 → `isCurrent=true`；**不引入 JWT `did` claim**（避免扩散到 001/003 全部 token 签发路径）。同机制用于撤销的防自撤判定。
- Q: `deviceName` / `deviceType` 是否本批补强服务端采集？（client 已发头，server controllers 只读 `x-device-id`，存量行 `null`/`UNKNOWN`） → A: **本批服务端补读** —— token 签发路径（login / cancel-deletion controller，refresh 继承父行血缘不读头）补读 `x-device-name` / `x-device-type` 入库（persist 服务已支持存储，仅 controller 入参缺）；新登录设备具可读名称/类型，存量行降级展示。
- Q: 本批是否落地 mobile「登录管理」屏（US5）？ → A: **延后，server 先行** —— settings shell（spec B）未建、登录管理屏无正式入口；本批 server-only（2 端点 + 采集补强），mobile 屏随 settings shell 落地后单独接入（仿 004 delete-account 延后先例）。spec-merge 约束（字段口径 / 错误码 / user-journey）随之收敛：字段以 server 为真相源（Orval 生成）、错误码 `DEVICE_NOT_FOUND` / `CANNOT_REMOVE_CURRENT_DEVICE` 沿旧 Java、user-journey 留 client feature 再定。

### Session 2026-05-29（client amend — B2）

> p4 子 plan B2「设备管理 client」起手。spec-merge 约束多数已在 Session 2026-05-26 预锁（字段以 server 为真相源 / 错误码 / 路径参数）；本轮决 client 落点 + 真分歧（user 确认 2026-05-29）。

- Q: 本 client feature 的 spec 落点？ → A: **amend 005 原地**（不吃新编号，per p4 决策 #3）；branch `005-device-management-client`；本 spec 补 US5（client）+ Client FR/SC + 翻 Out of Scope 延后段；新建 `tasks-client.md`（已 ship 的 server tasks 不动）。
- Q: 列表项 `id` 是 `string`（bigint JSON 安全），但 Orval 生成的 revoke `recordId` 是 `number`，类型不一致怎么处理？ → A: **修 server `@ApiParam` 加 `type:'string'` + regen api-client**（FR-S15），使 `recordId: string` 与列表 `id: string` 一致，消除 client 侧 `Number()` 精度风险。纯 contract 注解修正（`ParseBigIntPipe` 已从路径 string 解析 bigint，运行时行为不变）；故本 amend **含一处 server 改 + api-client regen**，server↔app 同 1 PR（不再纯 mobile）。
- Q: 撤销交互形态？ → A: **高保真 port 旧 app** —— list 行 → `[recordId]` 详情页（4 字段：名/地点/方式/最近活跃）→ 「移除该设备」按钮（仅非当前设备）→ `RemoveDeviceSheet` 底部确认 sheet；详情页数据读自 list query cache（server 无单设备 GET 端点）。含 `DeviceIcon`（deviceType → glyph，UNKNOWN fallback）。
- Q: 分页？（Orval `list()` fn 不带 page/size 参数，DeviceListResponse 有 page/totalPages） → A: **单页拉取**（`size=100` 经 axios `params` 注入，无「更多设备」CTA）—— PoC 用户设备数 <10，不为 <10 项造分页累加（senior-eng test）。

## User Scenarios & Testing _(mandatory)_

> Server 段（US1-4）已 ship（#201）；**US5 = 2026-05-29 client amend** 新增（见 § Clarifications Session 2026-05-29）。

### User Story 1 — [Server] 查看登录设备列表（ListDevices，Priority: P1）

已登录用户拉取自己的活跃登录设备分页列表，用于（未来的）「登录管理」屏感知「我在哪些设备上登录着」。

**Why this priority**: 设备管理的读侧基座 —— 撤销（US2）必须先能「看到设备」才有操作对象；可独立交付价值（用户审视自己的会话）。

**Independent Test**: Testcontainers PG；预置某账号 N 条活跃 refresh token（不同 deviceId / 含私网与公网 IP / 含已撤销行）+ 1 条他人账号行 → authed 请求列表（带 `x-device-id` 头）→ 断言：仅返回本账号 N 条活跃行、按 createdAt DESC、每行字段齐备、私网 IP 行 `location` 为空、原始 IP 不出现在任何字段、当前设备行（`x-device-id` 命中）`isCurrent=true`、他人 / 已撤销行不出现。

**Acceptance Scenarios**:

1. **Given** 账号有 3 条活跃 + 1 条已撤销 refresh token，**When** authed GET 设备列表，**Then** 返回恰 3 条（已撤销不计），按 `createdAt` 倒序，每条含 `{id, deviceId, deviceName, deviceType, location, loginMethod, lastActiveAt, isCurrent}`
2. **Given** 某行 IP 为私网 / loopback / 空，**When** 列表返回该行，**Then** `location` 为空且响应任何字段都不含原始 IP 字面值
3. **Given** 请求头 `x-device-id=X`，**When** 列表含 deviceId=X 的行，**Then** 该行 `isCurrent=true`、其余 `false`
4. **Given** size 请求 500，**When** 返回，**Then** 实际每页 ≤ 100（上限截断）

---

### User Story 2 — [Server] 撤销某设备（RevokeDevice，Priority: P1）

用户对列表中某台**非当前**设备点「移除」→ 该设备 refresh token 被撤销（远程登出），该设备下次刷新 token 即失效。

**Why this priority**: 设备管理的核心动作（远程登出可疑 / 丢失设备），安全价值最高。

**Independent Test**: Testcontainers PG+Redis；预置本账号 2 条活跃行（A=当前设备=请求 `x-device-id`、B=另一设备）+ 1 条他人行 → authed DELETE B → 200 + B `revokedAt` 已置 + outbox 1 条 `DeviceRevokedEvent`（payload 逐字段）+ A 不受影响；DELETE A（当前设备）→ 409；DELETE 他人 recordId / 不存在 recordId → 均 404 字节级一致；DELETE 已撤销 B → 幂等 200 无新事件。

**Acceptance Scenarios**:

1. **Given** 目标行属本账号、非当前设备、未撤销，**When** authed DELETE，**Then** 200 + 该行 `revokedAt` 置当前时刻 + outbox 落 1 条 `DeviceRevokedEvent`（payload 含 accountId / recordId / deviceId / revokedAt / occurredAt）
2. **Given** 目标行 deviceId == 当前设备（请求 `x-device-id`），**When** DELETE，**Then** 409 `CANNOT_REMOVE_CURRENT_DEVICE`（引导走「退出登录」），行不变、无事件
3. **Given** 目标 recordId 属他人账号 **或** 不存在，**When** DELETE，**Then** 均 404 `DEVICE_NOT_FOUND`（字节级一致），无事件
4. **Given** 目标行已撤销（`revokedAt≠null`），**When** DELETE，**Then** 幂等 200，不重复发事件

---

### User Story 3 — [Server] 撤销反枚举 + 并发恰一成功（Priority: P1，安全）

撤销端点的安全不变性 + 并发原子性独立验证。

**Why this priority**: 反枚举与并发原子性是安全刚需，必须独立断言（与 US2 功能路径分离，防回归）。

**Independent Test**: ①「他人 recordId」与「不存在 recordId」两类 404 响应剥 traceId 后 ProblemDetail 深等（字节级一致）；②N 并发持同一 recordId 撤销（service 层直测绕限流）→ 恰 1×（真撤销 + 发 1 事件）+ (N-1)× 幂等 200，DB `revokedAt` 单次落定、outbox `DeviceRevokedEvent` 恰 1 条。

**Acceptance Scenarios**:

1. **Given** 不存在的 recordId 与 他人账号的 recordId，**When** 分别 DELETE，**Then** 两响应 status + body（剥 traceId）字节级一致（均 404 `DEVICE_NOT_FOUND`）
2. **Given** 5 并发对同一未撤销行 DELETE，**When** 全部执行，**Then** 恰 1 次真撤销 + 恰 1 条 `DeviceRevokedEvent`，其余幂等 200、无重复事件

---

### User Story 4 — [Server] 限流（Priority: P2）

防设备列表 / 撤销端点被滥用（枚举 recordId / 刷设备列表）。

**Why this priority**: 防滥用加固，非 MVP 阻塞；复用既有 throttler 设施成本低。

**Independent Test**: Testcontainers + Redis flushall；list 桶超限（account 第 31 / IP 第 101）、revoke 桶超限（account 第 6 / IP 第 21）→ 429 + `Retry-After`（IP 桶按 socket IP 计，loopback 仅测试环境）。

**Acceptance Scenarios**:

1. **Given** 同账号 60s 内第 31 次列表请求，**When** 请求到达，**Then** 429 + `Retry-After`
2. **Given** 同账号 60s 内第 6 次撤销请求，**When** 请求到达，**Then** 429 + `Retry-After`

---

### User Story 5 — [Mobile] 登录管理屏（设备列表 + 远程撤销，Priority: P1）

已登录用户从 `设置 → 账号与安全 → 登录管理` 进入，查看自己的活跃登录设备列表（图标 / 设备名 + 「本机」徽标 / 最近活跃·地点），点设备进详情，对**非当前**设备执行远程撤销。消费 US1/US2 server 端点，是 005 的 client 收口（p4 子 plan B2）。

**Why this priority**: server 设备管理（US1-4）已 ship 但无 UI 入口，用户无法实际「看到 / 移除」设备；本屏是该能力对用户可见的唯一路径，闭合 005 价值。

**Independent Test**（Playwright Expo Web，mock API via `e2e/_support/api-mock.ts` `mockJson`）：seed authed（client setup 注入 `x-device-id`）→ mock `GET /api/v1/auth/devices` 返回混 current 行 + 另一设备行 + legacy 行（`deviceName=null` / `deviceType=UNKNOWN` / `location=null`）→ 进登录管理屏 → 断言列表渲染、current 行显「本机」徽标、legacy 行显「未知设备」+ UNKNOWN fallback 图标 + 「—」地点 → 点非当前设备进 `[recordId]` 详情（4 字段）→ 「移除该设备」→ `RemoveDeviceSheet` 确认 → mock `DELETE /api/v1/auth/devices/{recordId}` 200 → sheet 关 + 返回 + 该行从列表消失；另测 mock 409（current）/ 404（不存在）→ 统一错误展示。

**Acceptance Scenarios**:

1. **Given** 列表混 current + 另一设备 + legacy 行（`deviceName=null` / `deviceType=UNKNOWN` / `location=null`），**When** 进登录管理屏，**Then** 渲染全部行、current 行显「本机」徽标且**无移除入口**、legacy 行 `deviceName`→「未知设备」/ `deviceType=UNKNOWN`→fallback 图标 / `location=null`→「—」
2. **Given** 点击非当前设备行，**When** 进入，**Then** 路由 `account-security/login-management/[recordId]`、详情页显 4 字段（设备名 / 登录地点 / 登录方式中文标签 / 最近活跃秒级），数据**读自 list query cache**（server 无单设备 GET 端点；cache miss → fallback 重拉列表；仍缺 → NotFound 态）
3. **Given** 详情页对非当前设备点「移除该设备」→ `RemoveDeviceSheet` 确认，**When** `DELETE` 成功 200，**Then** sheet 关 + 返回列表 + invalidate 重拉 + 该行不再出现
4. **Given** 撤销返回 409 `CANNOT_REMOVE_CURRENT_DEVICE`（防御性，正常详情页对 current 无移除按钮），**When** 错误返回，**Then** 统一错误展示「无法移除当前设备，请改用退出登录」、行不变
5. **Given** 撤销返回 404 `DEVICE_NOT_FOUND`（行已不存在 / 竞态），**When** 错误返回，**Then** 统一错误展示「设备不存在或已被移除」+ 刷新列表
6. **Given** 006 account-security index「登录管理」行此前 disabled 占位，**When** B2 ship，**Then** 该行 enabled → push 登录管理屏（B1 占位激活点）

---

### Edge Cases

- 账号只有当前设备一条活跃 token → 列表返回 1 条且 `isCurrent=true`，无可撤销对象
- 账号 0 条活跃 token（理论上 authed 请求必有当前 token）→ 合法空列表
- `page` 超出末页 → 返回空 `items` + 正确 `totalElements` / `totalPages`
- `deviceName` 为 null / `deviceType` 为 `UNKNOWN`（采集补强前的存量行）→ 优雅降级展示
- ip2region 对公网 IP 解析失败 / 数据库无该段 → `location` 为空（不报错）
- 撤销请求缺 `x-device-id` 头（无法判定 isCurrent / 防自撤）→ 401（拒绝，保证防自撤前置）
- 撤销与「该设备自己刷新 token 轮换」竞态 → 轮换产生新行、撤销针对旧 recordId；affected-count 保证旧行恰一次撤销，新行不受影响
- **[Mobile]** 列表仅当前设备一条 → 渲染 1 行 + 「本机」徽标、无可移除对象（详情页无移除按钮）
- **[Mobile]** 列表加载失败（network / 5xx）→ 全屏 `ErrorRow` + 重试（refetch）
- **[Mobile]** 详情页直链进入（深链 / 刷新）但 list cache 已空 → fallback 重拉列表；命中则正常、未命中显「设备不存在或已被移除」NotFound 态 + 返回
- **[Mobile]** 撤销过程中设备列表被其他操作 invalidate → 以 server 重拉结果为准（撤销成功即从列表消失，幂等 200 同样消失）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 对已登录账号返回其**全部活跃**（`revokedAt IS NULL`）refresh token 列表，按 `createdAt` 降序，分页（`page` 0-based，`size` 缺省 10、上限 100）。
- **FR-S02**: 每个列表项 MUST 含 `{ id（refresh_token 行 PK，撤销路径参数）, deviceId, deviceName, deviceType, location, loginMethod, lastActiveAt, isCurrent }`。
- **FR-S03**: 系统 MUST 标记**当前设备** `isCurrent=true`：以当前请求的 `x-device-id` 头与各行 `deviceId` 比对（clarify 2026-05-26 定，不引入 JWT `did` claim）。
- **FR-S04**: 系统 MUST 把行 `ipAddress` 经地理解析为中文省市 `location`；私网 / loopback / 空 / 不可解析 → `location` 为空。响应**任何字段 MUST NOT** 含原始 IP 字面值（反枚举）。
- **FR-S05**: 系统 MUST 仅返回**请求账号自己**的 token 行（跨账号行不可见）。
- **FR-S06**: 系统 MUST 支持按 `recordId`（行 PK）撤销单个设备：条件 UPDATE `WHERE id=? AND account_id=本账号 AND revoked_at IS NULL` 置 `revokedAt`，affected-count 乐观锁裁决。
- **FR-S07**: 撤销目标行 `deviceId` == 当前设备（请求 `x-device-id`）→ MUST 拒绝，409 `CANNOT_REMOVE_CURRENT_DEVICE`（引导用户走「退出登录」），不撤销、不发事件。
- **FR-S08**: 撤销目标行**不存在** OR **属他人账号** → MUST 返回**字节级一致** 404 `DEVICE_NOT_FOUND`（不泄露归属，反枚举）。
- **FR-S09**: 撤销已撤销行（`revokedAt≠null`，含并发竞态败者 `affected==0`）→ MUST 幂等返回 200，不重复发事件。
- **FR-S10**: 撤销成功（`affected==1`）→ MUST 在**同一事务**内向 outbox 写 `DeviceRevokedEvent`（payload 含 `accountId` / `recordId` / `deviceId` / `revokedAt` / `occurredAt`）。
- **FR-S11**: 撤销 DB 写 + outbox 写 MUST 原子：任一步失败整体回滚（行未撤、无事件）。
- **FR-S12**: 撤销请求缺 `x-device-id` 头（无法判定当前设备）/ 未认证 → MUST 401（保证 FR-S07 防自撤前置）。
- **FR-S13**: 系统 MUST 对两端点限流：list 30/account·100/IP，revoke 5/account·20/IP（均 /60s；IP 桶按 socket IP 计 —— 当前直连部署 trustProxy 未启用、恒见真实公网 IP，故无单独的“无公网 IP 跳过”分支；若后续前置反代 / LB 致源 IP 收敛再议），超限 429 + `Retry-After`。
- **FR-S14**: 系统 MUST 在 token 签发路径（login / cancel-deletion controller，refresh 继承父行血缘不读头）补读 `x-device-name` / `x-device-type` 头并入库（client 已发，`core/api/setup.ts` 实证；persist 服务已支持存储），使新登录设备具可读名称 / 类型；存量行降级展示（`null` / `UNKNOWN`）。**回归**：既有 001/003/004 token 签发路径（无 name/type 头时）行为不变。
- **FR-S15**（2026-05-29 amend）: revoke 端点 `recordId` 路径参数 MUST 在 OpenAPI 声明 `type: 'string'`（`device-management.controller.ts` `@ApiParam` 加 `type:'string'`），使生成的 `@nvy/api-client` revoke 变量 `recordId: string` 与列表项 `id: string`（bigint JSON 安全序列化）类型一致，消除 client 侧 `Number()` 精度桥接。**纯 contract 注解修正**：server 运行时行为不变（`@Param(ParseBigIntPipe) recordId: bigint` 已从路径 string 解析），无 use case 逻辑 / bounded-context 边界改动；改后 MUST 跑 `nx affected --target=generate` regen api-client（per api-contract rule）。

### Client Functional Requirements（2026-05-29 amend — US5）

- **FR-C01**: 登录管理屏 MUST 经 `~/api-client` Orval hook（`useDeviceManagementControllerList`）拉设备列表，**禁手写 fetch/axios**（api-contract 硬 invariant）；单页拉取 `size=100`（经 axios `params` 注入，无「更多设备」分页 CTA）。
- **FR-C02**: 列表项渲染 MUST 以 server 为真相源字段（`{id, deviceId, deviceName, deviceType, location, loginMethod, lastActiveAt, isCurrent}`）；降级口径：`deviceName=null`→「未知设备」、`deviceType` 非已知枚举（含 `UNKNOWN`）→ fallback 图标、`location=null`→「—」。
- **FR-C03**: `isCurrent=true` 行 MUST 显「本机」徽标，且**不提供移除入口**（详情页对当前设备隐藏「移除该设备」按钮）。
- **FR-C04**: 设备详情屏（`[recordId]`）数据 MUST 读自 list query cache（server 无单设备 GET 端点）；cache miss → fallback 重拉列表 query；仍缺失 → 「设备不存在或已被移除」NotFound 态 + 返回。
- **FR-C05**: 撤销 MUST 经 Orval `useDeviceManagementControllerRevoke`（`DELETE /api/v1/auth/devices/{recordId}`）；成功后 MUST invalidate 设备列表 query 重拉；mutation `onSuccess` **不导航**，由屏状态机驱动（`RemoveDeviceSheet` 关 + `router.back()`），per `~/auth` wrapper 范式。
- **FR-C06**: 撤销错误 MUST 统一映射展示（错误码沿用 server）：`409 CANNOT_REMOVE_CURRENT_DEVICE`→「无法移除当前设备，请改用退出登录」；`404 DEVICE_NOT_FOUND`→「设备不存在或已被移除」+ 刷新列表；`429`→ Retry-After 提示；network / unknown → 通用错误文案。
- **FR-C07**: 登录管理屏路由 MUST 落 `apps/mobile/app/(app)/settings/account-security/login-management/` **仅 route 文件**（`_layout` Stack + `index` 列表 + `[recordId]` 详情）；**非 route 的 presentational 组件**（`DeviceIcon` / `RemoveDeviceSheet`）MUST 落 `apps/mobile/src/settings/login-management/`（**不进 `app/`** —— Expo Router 扫 `app/**/*.tsx` 当 route，co-locate 会生成 phantom route，per memory `expo_router_app_route_scan`；与 006 把 primitives 放 `~/settings` 同纪律）。路由 param 名 MUST 为 `recordId`（对齐 server，**非**旧 app `[id]`）。
- **FR-C08**: `account-security/index.tsx`「登录管理」行 MUST 由 006 的 disabled 占位 flip 为 enabled → `router.push` 登录管理屏（B1 占位激活点；同 PR 内一行 flip = 集成点）。
- **FR-C09**: port 文件 MUST 完成 import remap（`@nvy/auth`→`~/auth` / `@nvy/design-tokens`(`colors`)→`~/theme` 或 NativeWind class）+ 相对 import extensionless（Metro web 陷阱）；纯逻辑（`formatLastActive`）落 `~/format/datetime` + vitest（含 legacy `null`/`UNKNOWN` 降级用例）。

### Key Entities _(数据涉及)_

- **RefreshToken（活跃行 = 一台设备）**：`id`（行 PK，撤销标识）/ `accountId`（归属）/ `deviceId`（设备稳定标识，NOT NULL，缺失登录时回退 UUID v4）/ `deviceName`（可读名，nullable）/ `deviceType`（PHONE / TABLET / DESKTOP / WEB / UNKNOWN，默认 UNKNOWN）/ `ipAddress`（登录 IP，nullable，仅内部，不外露）/ `loginMethod`（登录方式，轮换继承）/ `createdAt`（= `lastActiveAt` 投影）/ `revokedAt`（撤销标记，null = 活跃）。
- **DeviceRevokedEvent（outbox 事件）**：撤销成功发布，payload `{ accountId, recordId, deviceId, revokedAt, occurredAt }`；event-type 字符串遵 mono `<producer-ctx>.<aggregate>.<action>` 范式（plan/analyze 定）；本 feature 无 in-process 消费方。
- **地理位置解析（service，非持久实体）**：`ipAddress → 中文省市 location`；私网 / 不可解析 → 空。库选型（ip2region Node 等价）归 plan。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 已登录用户能看到自己**全部且仅**活跃登录设备，当前设备被正确标记（集成测试：N 活跃 + 已撤销 + 他人行混入，断言返回集 + isCurrent）。
- **SC-S02**: 设备列表与撤销响应**绝不**包含原始 IP 字面值，位置信息仅以解析后的地点呈现（集成测试逐字段断言 + 私网行 location 空）。
- **SC-S03**: 撤销某设备后，该设备的会话失效（其 refresh token 行 `revokedAt` 置位，后续刷新被拒），其他设备会话不受影响。
- **SC-S04**: 用户**无法**撤销当前正在使用的设备（409），被引导到「退出登录」。
- **SC-S05**: 「他人设备」与「不存在设备」的撤销请求**不可区分**（字节级一致 404）。
- **SC-S06**: N 并发撤销同一设备 → 恰 1 次真撤销 + 恰 1 条事件（无双重撤销 / 重复事件）。
- **SC-S07**: 重复撤销同一设备幂等（第二次起 200 无副作用）。
- **SC-S08**: 两端点限流规则全部生效（超限 429 + Retry-After，各桶边界集成测试覆盖）。
- **SC-S09**: 列表端点（含地理解析）P95 ≤ 150ms、撤销端点 P95 ≤ 120ms（perf budget —— frontmatter `perf_budgets` 为 SoT；PoC 不逐 feature load-test，per 004 先例，不设独立 perf IT task）。
- **SC-S10**: 采集补强后，新登录设备的 `deviceName` / `deviceType` 按 client 发送的头落库（集成测试：带 name/type 头登录 → 列表显示真实名/类型；不带头 → 降级 null/UNKNOWN，既有路径回归不破）。

### Client Measurable Outcomes（2026-05-29 amend — US5）

- **SC-C01**: 用户能在登录管理屏看到自己**全部活跃**设备，当前设备被「本机」徽标标记且无移除入口（Playwright：mock 多设备列表 → 断言徽标 / 图标 / 降级文案）。
- **SC-C02**: 用户能对非当前设备执行远程撤销，成功后该行从列表消失（Playwright：mock `DELETE` 200 → invalidate 重拉 → 断言行移除）。
- **SC-C03**: 撤销当前设备（409）/ 不存在设备（404）/ 限流（429）均有统一、可读的错误展示，不泄露内部细节（Playwright 各错误码分支断言）。
- **SC-C04**: legacy 行（`deviceName=null` / `deviceType=UNKNOWN` / `location=null`）优雅降级（「未知设备」/ fallback 图标 / 「—」），不崩溃、不显原始 `null`（Playwright mock legacy 行断言 + `formatLastActive` vitest）。
- **SC-C05**: 生成的 api-client revoke `recordId` 与列表 `id` 类型一致（均 `string`），client 侧**无** `Number()` / `as unknown as number` 数字精度桥接（typecheck + grep 断言）。

## Assumptions

- **设备元数据已持久化**：`refresh_token` 设备列由 Plan 1 / 003 token 签发与轮换写入；本 feature 不新增表、不改表结构（已实证 schema 含全部列 + 偏索引）。
- **当前设备标识 = `x-device-id` 头**：客户端每次 authed 请求携带 `x-device-id`（`core/api/setup.ts` 从 `useDeviceStore` 发送，已实证），isCurrent / 防自撤依赖之；不引入 JWT `did` claim（clarify 2026-05-26 定）。
- **采集补强为纯服务端改动**：client 已发 `x-device-name` / `x-device-type`，persist 服务已支持存储；本批仅 controller 补读，无 mobile 改动。
- **地理解析尽力而为**：ip2region 等价解析失败 / 私网 → `location` 空，不报错、不阻塞列表。
- **撤销 = 单设备登出**，与 003 `LogoutAllSessions`（全端登出）正交，互不替代。

## Out of Scope（本 feature 不做）

- ~~**mobile 登录管理屏（原 US5）**：clarify 2026-05-26 定延后~~ → **已解延后**：settings shell（006-account-settings-shell）已 ship（#221），登录管理屏获正式入口；2026-05-29 经本 amend（branch `005-device-management-client`，p4 子 plan B2）落地为 **US5**（设备列表 + DeviceIcon + `[recordId]` 详情 + `RemoveDeviceSheet` 撤销，高保真 port 旧 app），见 § User Story 5 + § Client Functional Requirements。字段以 server 为真相源（Orval 生成）、错误码沿用 `DEVICE_NOT_FOUND` / `CANNOT_REMOVE_CURRENT_DEVICE`。
- **设备会话审计 / 通知消费方**：`DeviceRevokedEvent` 本 feature 仅发布到 outbox，**无 in-process 消费方**（审计日志 / 异地登录提醒 / 推送归后续 feature）。
- **「全端登出」**：已由 003 `LogoutAllSessions` 覆盖，不在此重做。
- **设备重命名 / 信任设备 / 设备级 2FA**：超出列表 + 撤销范围。
- **精确实时「最近活跃」**：`lastActiveAt` 取 `refresh_token.createdAt`（= 该会话建立 / 上次轮换时刻）投影，非每次 API 调用刷新的活跃心跳。
- **原始 IP / 精确经纬度展示**：反枚举刚需，仅暴露省市级 `location`。
- **JWT `did` claim**：clarify 决定用 `x-device-id` 头判定 isCurrent，不修改 token 签发 payload。
