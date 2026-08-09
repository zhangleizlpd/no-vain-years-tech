---
feature_id: 005-device-management
spec_ref: ./spec.md
status: done
created_at: '2026-05-26'
updated_at: '2026-05-29'
adr_refs: ['0019', '0022', '0024', '0030', '0032', '0033', '0040', '0041', '0043']
context7_verified: []
---

# Implementation Plan: 005-device-management（登录设备列表 + 单设备远程撤销）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `005-device-management` | **Master**: [`account-migration master`](../../docs/private/plans/2026-05/05-25-account-migration-master.md) → 批 D | **Engine**: [`p3`](../../docs/private/plans/2026-05/05-25-account-migration-p3-usecase-steps.md)

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per p3 §3）。
> **本批 server-only**（clarify 2026-05-26）：mobile 登录管理屏延后到 settings shell 落地（见 spec § Out of Scope）。

## Summary _(mandatory)_

005 = 设备/登录管理 2 UC 迁移：①**ListDevices**（authed：分页返回账号活跃 refresh token，每行 enrich `location`(ip2region 解析) + `isCurrent`(x-device-id 头比对)）②**RevokeDevice**（authed：按 recordId 撤销单行，防自撤 409 / 反枚举 404 / 幂等 / affected-count 乐观锁 + 同 tx 发 `DeviceRevokedEvent`）。范式 = ADR-0043 扁平贫血 + 单向 Moat（`auth → security`）。附 ③**采集补强**（FR-S14）：token-创建路径（login + cancel-deletion controller）补读 `x-device-name`/`x-device-type` 头入库（client 已发，persist 服务已支持）—— refresh **inherits** 不改。新基础设施 = **ip2region geo**（`ip2region.js` + xdb 资产）+ **`DeviceRevokedEvent`** 首发。

**bounded context**：**auth** 编排 2 个 authed user-facing UC（持 controller `/v1/auth/devices` + revoke 持 tx）；**security**（平台 infra）扩 `RefreshTokenService` 加 list/revoke-one 单行操作 + 新 `IpGeoService`。`refresh_token` / `outbox_event` 表**已 db-pull，含全部设备列 + 偏索引 `idx_refresh_token_account_device_active`，无 migration**。account context **不参与**（accountId 取自 JWT sub，无 account 表读写）。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | Request | Response | trace FR |
|---|---|---|---|---|---|---|
| EP1 | GET | `/api/v1/auth/devices` | **bearer** + `x-device-id` 头 | query `?page=0&size=10`（size 上限 100，超限截断；`@Query` int 校验） | **200** `DeviceListResponse{page,size,totalElements,totalPages,items[]}` / 401 / 429 | FR-S01~S05, FR-S12, FR-S13 |
| EP2 | DELETE | `/api/v1/auth/devices/:recordId` | **bearer** + `x-device-id` 头 | path `recordId`（行 PK；`@Param` int 校验，非法 → 400） | **200**（空 body；成功/幂等一致）/ 401 / 404 `DEVICE_NOT_FOUND` / 409 `CANNOT_REMOVE_CURRENT_DEVICE` / 429 | FR-S06~S12, FR-S13 |

- `DeviceListItem` = `{ id, deviceId, deviceName, deviceType, location, loginMethod, lastActiveAt, isCurrent }`（**无 `ipAddress`** —— FR-S04 在 auth 响应映射层剥除，原始 IP 不序列化）。
- 路径：authed 设备管理沿用旧 Java `/v1/auth/devices`（auth 命名空间，与既有公开/authed auth 端点一致）。全局前缀 `api`。
- 错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter）；code = `DEVICE_NOT_FOUND`（404，新增 1 个）/ `CANNOT_REMOVE_CURRENT_DEVICE`（409，新增 1 个）/ `RATE_LIMITED`（429，复用）/ `FORM_VALIDATION`（400 path/query 校验，复用）。401 缺 `x-device-id` / 未认证沿用既有鉴权失败映射（**不**新增 `did` claim，per clarify）。旧 Java `AUTH_FAILED` 在 mono 不存在。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（3 点写回）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；反枚举字节级 404 / 并发恰一撤销 / 原子回滚 / IP 隐藏 / geo 私网→null 均专测（Testcontainers PG+Redis） |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 按此拆；server-only 单 PR |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 单向 `auth → security`；revoke 由 **auth 持 tx** 委托 `security.revokeOneForAccount(tx)`（R2 forward）+ `outbox.publish(tx, DeviceRevokedEvent)`（R3）；list 经 `security.listActiveByAccount` 读（R2 读，platform service）+ `security.IpGeoService` 解析（platform infra，ADR-0041 例外，无 R2/R3）；auth 内零 `tx.refreshToken.*`；跨 ctx 注入点 `// CROSS-CONTEXT-SYNC`/`-ASYNC`；`check-server-moat.ts` 关 |
| V. 类型同步链 Nx-driven | ✅ | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval）→ api-client typed（**本批无 mobile 消费**，但 contract 仍 regen 供后续登录管理屏）；同 1 PR |

## Architecture Notes _(mandatory)_

### Bounded Context 落位（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)，ship 时新增 Operation 行）

| 操作 | context | 类型 | 跨 ctx | 备注 |
|---|---|---|---|---|
| `list-devices` | **auth** | 编排 query UC | R2 读 → `security.list-active-refresh-tokens`；调 `security.IpGeoService`（platform infra） | authed；map 行 → enrich `location`(geo) + `isCurrent`(x-device-id 头) + 剥 raw IP |
| `revoke-device` | **auth** | 编排 UC（**持 tx**） | R2 写 → `security.revoke-one-refresh-token`(tx)；R3 → outbox `auth.device.revoked` | authed；find→404/409 guards→tx{conditional revoke affected-count + 发事件} |
| `list-active-refresh-tokens`（扩 `RefreshTokenService`） | **security** | 平台 infra | — | 分页 `findMany WHERE accountId AND revokedAt IS NULL ORDER BY createdAt DESC` + `count`（偏索引）；返回贫血行 + total |
| `find-refresh-token-by-id`（扩 `RefreshTokenService`） | **security** | 平台 infra | — | `findUnique({id})` → 行 \| null（供 auth 做 404/409 guard） |
| `revoke-one-refresh-token`（扩 `RefreshTokenService`） | **security** | 平台 infra | — | conditional `updateMany WHERE {id, accountId, revokedAt:null}` set revokedAt → `{won: count===1}`（affected-count，tx 重载） |
| `resolve-ip-location`（新 `IpGeoService`） | **security** | 平台 infra（ADR-0041） | — | ip2region.js 加载 xdb（onModuleInit，buffer 模式单例）→ `resolve(ip): string\|null`；私网/null/不可解析 → null |

> **event 命名（analyze 2026-05-26 确认，参 004 I1）**：`auth.device.revoked`（`<producer-ctx>.<aggregate>.<action>` —— revoke 由 auth 编排发起，producer_context=`'auth'`，aggregate=`device`，沿旧 Java `DeviceRevokedEvent` 域语言；首个非 `account` aggregate，结构仍合规）。outbox publisher `producerContext` 参数化已于 004 落地，传 `'auth'`（默认即 auth，无需显式）。

### Server side（ADR-0043 扁平贫血，文件平铺）

**新增（auth `apps/server/src/auth/`）**：

- `device-management.controller.ts`（`@Controller('v1/auth/devices')`，挂 `JwtAuthGuard`）：`GET`（EP1）+ `DELETE :recordId`（EP2）+ named throttler config + swagger（200/401/404/409/429）
- `list-devices.usecase.ts`（编排 query）：取 accountId(JWT sub) + currentDeviceId(`x-device-id` 头，缺失仅影响 isCurrent，列表仍可返) → `security.listActiveByAccount(accountId, page, size)` → 逐行 `security.ipGeo.resolve(row.ipAddress)` + `isCurrent = row.deviceId === currentDeviceId` → map `DeviceListItem`（剥 ipAddress）→ 分页 envelope
- `revoke-device.usecase.ts`（编排，**持 tx**）：取 accountId + currentDeviceId(`x-device-id`，**缺失 → 401**，FR-S12 防自撤前置) → `security.findById(recordId)`：null **或** `row.accountId !== accountId` → **404 `DEVICE_NOT_FOUND`**（折叠，反枚举）；`row.deviceId === currentDeviceId` → **409 `CANNOT_REMOVE_CURRENT_DEVICE`** → `$transaction`(READ COMMITTED)：`security.revokeOneForAccount(tx, recordId, accountId, now)` → `won` ? `outbox.publish(tx, DeviceRevokedEvent)` : skip（幂等）→ **200**
- `device-revoked.event.ts`（事件类型 + payload `{ accountId, recordId, deviceId, revokedAt, occurredAt }` + `DEVICE_REVOKED_EVENT_TYPE='auth.device.revoked'`，镜像 `account-deletion-requested.event.ts`）
- 错误：`device-not-found.exception.ts`（404 `DEVICE_NOT_FOUND`）+ `cannot-remove-current-device.exception.ts`（409 `CANNOT_REMOVE_CURRENT_DEVICE`），镜像 `auth-attempt-locked.exception.ts`（HttpException 子类 + RFC 9457）
- response DTO：`device-list.response.ts`（envelope + item，swagger 装饰器）
- `auth.module.ts`：注册 controller + 2 usecase + named throttler（4 桶）

**修改既有（security `apps/server/src/security/`）**：

- `refresh-token.service.ts` **扩 3 方法**（贫血行 + affected-count，沿现有范式）：
  - `listActiveByAccount(accountId, page, size): Promise<{ rows: RefreshToken[]; total: number }>`（`findMany` + `count`，偏索引，`size` clamp 100）
  - `findById(recordId): Promise<RefreshToken | null>`（供 auth 404/409 guard）
  - `revokeOneForAccount(recordId, accountId, now, tx?): Promise<{ won: boolean }>`（conditional `updateMany WHERE {id, accountId, revokedAt:null}` → `won = count===1`；tx 重载，与 `revokeAllForAccount` 同款）
- `ip-geo.service.ts`（**新**，platform infra）：`@Injectable` `onModuleInit` 用 `newWithBuffer(IPv4, readFileSync(xdb))` 建单例 searcher → `resolve(ip: string | null): string | null`（私网/null/非法/不可解析 → null；命中 → 取「省+市」拼接，按 `ip2region.js` 新 5 字段格式 `Country|Province|City|ISP|iso` 切 index[1]+[2]）。注册进 `SecurityModule` providers/exports
- `SecurityModule`：export `IpGeoService`（auth 经 import 消费，platform infra 无需 R2/R3）

**修改既有（auth，采集补强 FR-S14）**：

- `account-phone-sms-auth.controller.ts`（login）+ `cancel-deletion.controller.ts`：加 `@Headers('x-device-name')` / `@Headers('x-device-type')`，透传到 use case → `persist` meta（`PersistRefreshTokenInput` 已含 `deviceName`/`deviceType` 字段，service 已 `normalizeDeviceType` + 存储；**仅 controller + usecase 入参缺**）
- `cancel-deletion.usecase.ts`：现 `persist(..., { deviceId, clientIp, loginMethod })`（L100-103）补 `deviceName`/`deviceType`
- **refresh（`account-token.controller.ts`）不改**：`rotate` 继承父行 device 血缘（`record.deviceName`/`deviceType`），无需读头
- **回归**：login / cancel-deletion 不带 name/type 头时 → `deviceName=null` / `deviceType=UNKNOWN`（既有行为不变）

**新增依赖**：`ip2region.js@3.1.8`（`pnpm -C apps/server add ip2region.js@3.1.8`，ISC，pure-JS 零运行时依赖，IPv6-capable，官方 lionsoul binding）+ xdb 数据资产（见 D6）

### 并发 / 事务策略

> **核心决策（D4）**：撤销单行 = **READ COMMITTED + conditional UPDATE affected-count**，与既有 `rotate` / `revokeAllForAccount` **同款**（memory `prisma_serializable_p2002_and_p2034`：单行条件更新禁 `FOR UPDATE`/Serializable，偏索引 SSI 假冲突）。

1. **撤销 = conditional UPDATE + affected-count**：`tx.refreshToken.updateMany({ where: { id: recordId, accountId, revokedAt: null }, data: { revokedAt: now } })` → `count===1`=won（发事件）/ `count===0`=已撤销 or 竞态败者（幂等 200，不发事件）。`WHERE accountId` 双保险（跨账号行 count=0，与 404 guard 叠加防越权撤）。
2. **N 并发撤销同行 = 行写锁 + affected-count**：DB 行写锁串行化同行竞争；先到者 set revokedAt 后，后到者 `WHERE revokedAt IS NULL` 不匹配 → count=0 → 幂等 200。**恰 1 个 won=true → 恰 1 条事件**（FR-S09/SC-S06）。
3. **原子性 + outbox 同 tx**：`revokeOneForAccount(tx)` + `outbox.publish(tx, DeviceRevokedEvent)` 在 auth 持有的同一 `$transaction`；publish 失败 → 整 tx 回滚（行未撤、无事件，FR-S11）。
4. **find→guard→revoke 非原子可接受**：404/409 guard 基于 `findById` 快照（tx 外读）；真撤销在 tx 内 conditional UPDATE 兜底（guard 与 UPDATE 之间行被并发撤 → count=0 幂等 200，无害）。防自撤 409 基于 guard 快照（当前设备不会被自己并发撤，无竞态风险）。
5. **list 只读**：`findMany` + `count`，无锁、无 tx。

### 限流配置（FR-S13，复用既有 throttler infra + AccountIdThrottlerGuard）

| 端点 | per-account | per-IP | 实现 |
|---|---|---|---|
| list-devices | `30/60s` | `100/60s` | named `dev-list-account`（AccountIdThrottlerGuard 复用，004 既有）+ `dev-list-ip` |
| revoke-device | `5/60s` | `20/60s` | named `dev-revoke-account` + `dev-revoke-ip` |

两端点均 authed（有 accountId）→ **无需** 004 的 public phone-hash guard。无公网 IP 时跳过 IP 桶（既有 IP throttler 行为）。`@SkipThrottle` 其余桶防污染。在 `auth.module.ts` 既有 `ThrottlerModule` 配置新增 4 named。

### ip2region geo（新基础设施）

- **库**：`ip2region.js@3.1.8`（D1，npm 实证存在）。`newWithBuffer(IPv4, buf)` 全量载入内存（~11MB xdb）→ `search(ip)` async 返 `Country|Province|City|ISP|iso`（**新格式**，省=index[1]、市=index[2]，与旧 Java 2.x `国家|区域|省份|城市|ISP` 不同 → 解析逻辑重写，单测锚定真值）。
- **xdb 资产（D6）**：从 upstream `data/ip2region_v4.xdb` 取，commit 到 `apps/server/src/security/data/ip2region_v4.xdb`；**关键**：SWC 不拷非 TS 资产 → 加进 `apps/server/project.json` `build` target 的 `assets` 数组 → 落 `dist/`；运行时 `__dirname` 相对解析路径（非 bundler import）。验 **built artifact**（`runtime-smoke` / `nx build` 后探 dist），非仅 `nx serve`。
- **IPv6 延后**：仅 ship v4 xdb；IPv6 地址 → `resolve` 返 null（graceful，符 FR-S04 不可解析→空）。需 IPv6 时另 ship `ip2region_v6.xdb` + 第二 searcher（独立 task）。
- **DB 时效**：upstream 数据不定期更新；committed xdb 视作周期性刷新资产（非自动更新）。PoC 阶段「够用」。

### Cross-cutting

- **同步链**（Constitution V）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（api-client regen）→ typed `device-management` 调用（函数式 hook），**同 1 PR**。本批 mobile 不消费（登录管理屏延后），但 contract 先 regen 供后续。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 6 行（见上落位表）+ 标注 `auth.device.revoked` R3 事件 + `revoke-all-refresh-tokens` 同款扩 list/find/revoke-one。
- **跨 ctx 注释**：auth→`security.revokeOneForAccount` 注入点 `// CROSS-CONTEXT-SYNC: 撤单行 token 失败回滚整请求`；auth→`security.listActiveByAccount`/`findById` 注入点 `// CROSS-CONTEXT-SYNC:`（R2 只读，经 security 服务方法读，**非** `prisma.refreshToken` 直读 → 不用 `CROSS-CONTEXT-READ` 逃生口；与 `refresh-token.usecase.ts` 注入 `RefreshTokenService` 同款）；`outbox.publish` 上方 `// CROSS-CONTEXT-ASYNC: auth.device.revoked`；`IpGeoService` 是 ADR-0041 platform infra 不需注释。`check-server-moat.ts` 关。
- **反枚举不变性**：grep EP2「不存在」vs「跨账号」404 响应字节级一致（剥 traceId）；list/revoke 响应 grep 无 raw IP 字段。

## Open Decisions Resolved（批 D 起手必决项 — ⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** ip2region Node 库 | 多候选（node-ip2region 弃用 / ip2region-ts 第三方无 IPv6 / ...） | **`ip2region.js@3.1.8`**（官方 lionsoul JS binding，pure-JS 零运行时依赖，IPv6-capable，ISC，npm 实证）。新格式 5 字段解析（省=idx1/市=idx2）。**新增依赖 + ~11MB 二进制资产入仓** | ⚠️ |
| **D2** isCurrent 机制 | x-device-id 头 vs JWT did claim | **x-device-id 请求头比对**（clarify 2026-05-26 定，不动 token 签发，不扩散 001/003）。spoofing 仅自害非攻击面 | — |
| **D3** revoke 事件传播 | 谁持 tx + 谁发事件 | **auth 编排持 tx** → `security.revokeOneForAccount(tx)`（R2 写，platform 无 event）+ auth `outbox.publish(tx, 'auth.device.revoked')`（R3）。沿 `logout-all`(auth 编排撤 token) + `delete-account`(auth 发事件) 既有范式。event-type `auth.device.revoked`（analyze 2026-05-26 确认）| ⚠️ |
| **D4** 并发原语 | FOR UPDATE vs affected-count | **READ COMMITTED + conditional UPDATE affected-count**（与 `rotate`/`revokeAllForAccount` 同款；memory 推荐；偏索引 SSI 规避）。`WHERE accountId` 防越权撤双保险 | — |
| **D5** 采集补强范围 | 哪些路径读 name/type 头 | **login + cancel-deletion controller**（token-创建路径，persist 新行）；**refresh 不改**（rotate 继承父行血缘）。纯 controller+usecase 入参补，service 已支持存储。**spec FR-S14 措辞「login/refresh/cancel-deletion」→ 精确化为 login+cancel-deletion（refresh inherits）** | ⚠️ |
| **D6** xdb 资产投递 | 仓内 commit vs lfs vs build 下载 | **commit 到 `apps/server/src/security/data/ip2region_v4.xdb`** + Nx `build` target `assets` 数组（SWC 不拷资产）+ 运行时 `__dirname` 解析。IPv4-only（IPv6 延后，地址→null graceful） | ⚠️ |
| **Perf 预算** | 2 端点 P95/P99 | EP1 GET `150/300`（含逐行 in-memory geo 解析）· EP2 DELETE `120/250`（含 tx：conditional revoke + 事件）（spec frontmatter SoT） | — |

**spec 微修正（plan 揭示，已同步回 spec）**：D5 FR-S14「login/refresh/cancel-deletion」→「login + cancel-deletion（refresh 继承父行血缘不改）」。

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：(1) **`IpGeoService` 全量载入 11MB xdb 单例** 是离线 geo 固有成本（vs 外部 geo API：隐私 + 延迟 + 境内可达性，海外 API 不可取）—— platform infra 单例非过度设计。(2) **`RefreshTokenService` 扩 3 单行方法** 沿既有 affected-count 范式，非新模式。(3) **auth 持 tx 发单事件** 复用 004 既有编排范式。整体复杂度显著低于 004（2 UC，无 scheduler / 无 sms / 无状态机）。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| `GET /api/v1/auth/devices` | 150 | 300 |
| `DELETE /api/v1/auth/devices/{recordId}` | 120 | 250 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。geo 解析为内存 xdb 查（μs 级），不构成 list 端点瓶颈。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（server-only 单 PR，per p3 §Step2；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Server]` setup：装 `ip2region.js@3.1.8` + commit `ip2region_v4.xdb` + `project.json` build assets + verify dist 拷贝（`nx build` 后探资产）
- `[Server]` security（geo）：`ip-geo.service.ts`（onModuleInit 载 xdb buffer 单例 + `resolve` 解析新 5 字段格式 + 私网/null/IPv6→null）+ 单测（真值锚定：公网 IP→省市、私网→null、IPv6→null、malformed→null）→ 注册 SecurityModule export
- `[Server]` security（refresh-token 扩）：`listActiveByAccount`（分页 + count + size clamp）+ `findById` + `revokeOneForAccount`（conditional affected-count + tx 重载）+ 单测（Testcontainers PG：活跃/已撤销过滤、分页、size 上限、跨账号 won=false、幂等 count=0、tx rollback 联动）。**回归**：003 既有 rotate/revokeAll 不破
- `[Server]` auth（list UC）：`list-devices.usecase.ts` + `device-list.response.ts` DTO + 单测（mock：enrich geo + isCurrent 头比对 + 剥 raw IP + 分页 envelope + 缺 x-device-id 头仍返列表 isCurrent 全 false）
- `[Server]` auth（revoke UC）：`revoke-device.usecase.ts`（持 tx）+ `device-revoked.event.ts` + 2 exception + 单测（mock：happy 发事件 / 404 折叠（null + 跨账号）/ 409 自撤 / 幂等 won=false 不发事件 / 缺 x-device-id 头 401 / publish 抛回滚）
- `[Server]` auth（controller）：`device-management.controller.ts`（GET + DELETE :recordId，JwtAuthGuard，swagger 200/401/404/409/429）+ named throttler 4 桶 + register `auth.module.ts` + 单测（mock 映射 + recordId 非法 400）
- `[Server]` auth（采集补强 FR-S14）：login + cancel-deletion controller 补读 `x-device-name`/`x-device-type` + usecase 透传 persist + 单测（带头→落库、不带头→null/UNKNOWN 回归）
- `[Server-IT]`（Testcontainers PG+Redis 全 boot）：
  - US1 list：N 活跃 + 已撤销 + 他人行 → 仅本账号活跃、createdAt DESC、字段齐、私网行 location 空、**响应无 raw IP**、x-device-id 命中行 isCurrent=true、size>100 截断
  - US2 revoke：撤非当前 → 200 + revokedAt 置 + outbox 1 条 `auth.device.revoked`（payload 逐字段）+ 他行不变；撤当前 → 409；撤他人/不存在 → 404；撤已撤 → 幂等 200 无新事件
  - US3 反枚举+并发：不存在 vs 跨账号 404 字节级一致（剥 traceId）；N 并发撤同行 → 恰 1×(撤+事件) + (N-1)×幂等 200，outbox 恰 1 条
  - US4 限流：4 桶边界（list account 31/IP 101；revoke account 6/IP 21）→ 429 + Retry-After
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（api-client regen device 端点；本批无 mobile 消费）+ api-client/mobile typecheck 绿
- `[Verify]`：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿 + 真后端冒烟（list→revoke 主路径 curl 或 IT 等价 + **built dist xdb 资产探活**）+ catalog 6 Operation 行 + 跨 ctx 注释（`check-server-moat.ts` 0 违规）

预估 task 数：~16-20（server-only：geo + security 扩 + 2 UC + controller + 采集补强 + IT；无 client / 无 scheduler / 无 sms）。**复杂度低于 004**，主要新点 = ip2region 资产投递 + geo 解析 + 首个 `DeviceRevokedEvent`。

---

## Client UI Plan（2026-05-29 amend — US5 / B2，tasks → `tasks-client.md`）

> **本段 = p4 子 plan B2 的 plan 回填**；server 段（上文）已 ship（#201）不动。branch `005-device-management-client`，server contract polish（FR-S15）+ mobile client 同 1 PR。
> **UI 类别 = 类 1 标准 UI**（settings 列表/详情）。旧 app `login-management/` 已是 PHASE-2 mockup 成品 → **高保真 port，跳过占位阶段**（per [sdd.md § 类 1](../../docs/conventions/sdd.md) + memory `design_tokens_reuse_not_redesign`，禁重设计 token）。

### 路由结构（最终态）

```text
# route 文件（仅这 3 个进 app/ —— Expo Router 扫 app/**/*.tsx 当 route）
apps/mobile/app/(app)/settings/account-security/login-management/
  _layout.tsx        # Stack：index title「登录管理」/ [recordId] title「登录设备详情」
  index.tsx          # 设备列表（bespoke DeviceRow + 本机徽标 + 单页 size=100，无分页 CTA）
  [recordId].tsx     # 设备详情（4 字段，读 list query cache）+ 移除按钮（仅 !isCurrent）

# 非 route presentational 组件 → src/（禁进 app/，否则 phantom route，per memory expo_router_app_route_scan）
apps/mobile/src/settings/login-management/
  RemoveDeviceSheet.tsx  # 底部确认 sheet（RN Modal，3 态 default/submitting/error）
  DeviceIcon.tsx         # deviceType → svg glyph（5 形态，react-native-svg 已在 deps）
```

+ `account-security/index.tsx`「登录管理」行：006 disabled 占位 → **enabled push**（FR-C08，同 PR 一行 flip = 集成点）。

### 复用资产 + port remap（旧 app → mono）

| 旧 app | mono 落点 | 备注 |
|---|---|---|
| `@nvy/auth` `DeviceItem` / `DeviceListResult` | `@nvy/api-client` `DeviceListItem` / `DeviceListResponse` | Orval 生成，server 真相源；`id: string`（FR-S15 后 revoke `recordId: string` 一致） |
| `lib/hooks/useDevicesQuery(page,size)` | `~/auth/use-devices.ts` `useDevices()` | 包 Orval `useDeviceManagementControllerList`，**单页** `{ axios:{ params:{ size:100 }}}`；queryKey = `getDeviceManagementControllerListQueryKey()`（`['/api/v1/auth/devices']`） |
| 旧 `revokeDevice(recordId)` 裸 fn | `~/auth/use-devices.ts` `useRevokeDevice()` | 包 Orval `useDeviceManagementControllerRevoke`；`onSuccess` → `invalidateQueries(listQueryKey)`；**不导航**（屏状态机驱动，per `~/auth` wrapper 范式） |
| `lib/error/device-errors.ts`（`@nvy/api-client` `ApiClientError`/`ResponseError`） | `~/auth/device-errors.ts` | **重写** for mono `AxiosError<ProblemDetailResponse>`：`isAxiosError(e)` + `e.response?.status` + `e.response?.data?.code`；映射 401 session / 403 `ACCOUNT_IN_FREEZE_PERIOD` frozen / 404 `DEVICE_NOT_FOUND` / 409 `CANNOT_REMOVE_CURRENT_DEVICE` / 429 rate / 5xx+TypeError network / unknown → 文案。**vitest（logic）** |
| `lib/format/datetime.ts` `formatLastActive(iso, 'minute'\|'second')` | `~/format/datetime.ts` | UTC-invariant 纯 fn，**vitest**（minute/second 两 granularity + 边界） |
| inline `Card` | `~/settings/primitives` `Card`（B1 已 port） | 复用 |
| bespoke `ErrorRow`（list 全屏错误态，含 `onRetry` 按钮） | `~/ui` `ErrorRow`（仅 `{ text }`，**无 onRetry**） | list 错误态 = `~/ui ErrorRow`（text）+ **另置** 重试 `Pressable`（`refetch`）；sheet 内错误 = `~/ui ErrorRow`（message-only，契合）。**禁** import 旧 bespoke ErrorRow |
| `colors.ink.*`（DeviceIcon/Chevron svg stroke，className 不收 svg） | `~/theme` `tokens.colors.ink.*` | svg stroke 必须 hex，从 token 取（非 className） |
| `[id]` param + `Number(id)` | `[recordId]` param + **string 直用** | FR-S15 后无 `Number()`；`useLocalSearchParams<{recordId:string}>` |

### 详情页数据源（FR-C04，sever 无单设备 GET）

`[recordId].tsx`：`queryClient.getQueryData<DeviceListResponse>(listQueryKey)` → `items.find(x => x.id === recordId)`；miss → fallback `useDevices()` 重拉；仍缺 → 「设备不存在或已被移除」NotFound 态 + 返回。沿旧 app cache-read 范式（无 `GET /devices/{id}`）。

### 撤销流（FR-C05/C06）

`RemoveDeviceSheet`（port，3 态状态机自持）：confirm → `useRevokeDevice().mutateAsync({ recordId })` → 成功 invalidate 列表 + `onClose()` + `router.back()`；catch → `deviceErrorCopy(mapDeviceError(e))` 顶部 ErrorRow + 回 default 可重试。RN `Modal`（transparent slide）—— **RN-Web 兼容靠 e2e 验**（用 Modal+Pressable，**非 Alert**，规避 RN-Web Alert 单按钮陷阱，per memory `visual_smoke_unreachable_when_finally_clears_session` 邻域教训）。

### FR-S15 server 改（同 PR，纯 contract 注解）

`apps/server/src/auth/device-management.controller.ts` 的 revoke `@ApiParam({ name:'recordId', ... })` 加 `type: 'string'` → `pnpm exec nx affected -t generate`（server openapi → Orval regen）→ api-client revoke `recordId: number → string`。运行时不变（`@Param(ParseBigIntPipe) recordId: bigint` 已从路径 string 解析）；**无新 server 测**（行为不变，既有 revoke IT 回归绿即可）。

### 测试分层（per memory `mono_mobile_test_layering`）

- **vitest（logic）**：`formatLastActive`（granularity + 边界）；`mapDeviceError`/`deviceErrorCopy`（401/403/404/409/429/5xx/TypeError/unknown 全分支 + 文案）。
- **Playwright Expo Web（UI/导航）**：US5 Independent Test 全程（mock list 混 current/legacy → 列表渲染 + 徽标 + 降级 → 详情 4 字段 → sheet → DELETE 200 行移除 / 409 / 404 错误态）。mock 走 `e2e/_support/api-mock.ts` `mockJson`；seed authed via `addInitScript`（仿 `settings-shell.spec.ts` / `profile.spec.ts`，含 `x-device-id`）。
- **presentational（DeviceIcon / DeviceRow / RemoveDeviceSheet / [recordId] / index）**：无单测，typecheck/lint + e2e 覆盖。

### Open Decisions (client)

| # | 决策 | 结论 |
|---|---|---|
| DC1 | DeviceIcon / Chevron svg 依赖 | `react-native-svg@15.12.1` **已在 `apps/mobile/package.json`**（profile.tsx / LogoMark 在用）→ **无新依赖** |
| DC2 | 详情页数据源 | list query cache（server 无单设备 GET）；miss→fallback 重拉→NotFound。沿旧 app 范式（DC2 资产 ground-truth 已 verify） |
| DC3 | 错误映射落点 | 抽 `~/auth/device-errors.ts` helper（logic 可 vitest，per login `mapError` 先例），屏只消费文案 |
| DC4 | 撤销确认 UX | `RemoveDeviceSheet` 底部 RN Modal（高保真 port）；非 Alert（RN-Web 兼容靠 e2e 验） |
| DC5 | 分页 | 单页 `size=100`（无 CTA，PoC <10 设备，senior-eng test）；US5 Independent Test 不覆盖分页 |
| DC6 | wrapper / error-map 落点 | `~/auth/`（设备端点属 `/auth/devices` 命名空间，与 `logout-all`/`cancel-deletion`/`useMe` 同 grouping） |

---

**Plan Version**: 1.0.0（server）/ 1.1.0（+client amend 2026-05-29） | **Created**: 2026-05-26 | **ID-namespace**: US1-4 / FR-S01..S15 / SC-S01..S10（server）· US5 / FR-C01..C09 / SC-C01..C05（client）
