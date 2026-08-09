---
feature_id: 014-stock-detail
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-03'
updated_at: '2026-06-03'
adr_refs: ['0024', '0032', '0038', '0041', '0043', '0048']
context7_verified: []
---

# Implementation Plan: 014-stock-detail（股票详情 — 富途式顶 Tab + 同花顺式固定底栏）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `014-stock-detail` | **PRD**: [portfolio-05](../../docs/prd/portfolio/portfolio-05-stock-detail-prd.md) | **Mockup baseline**: [`design/`](./design/)（`brief.md` + `handoff-claude-design/股票详情.html` + `StockDetailKit2.jsx` + `KLineChart.jsx` + 截图 `sd-*`）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012/013/015/016）。
> **统一 mockup-first 流程**（per [sdd.md](../../docs/conventions/sdd.md)）：spec ✅ → clarify ✅（2026-05-29，OQ1-3 结算）→ mockup ✅（定稿回填，K 线图表库已锁 = **纯 react-native-svg**）→ **plan（本）** → tasks → impl。本 plan **含完整 UI 段**。纪律②：UI impl 定稿前补两层验证（`[Mobile-E2E]` hermetic + `[Contract-Smoke]` 真后端，per Constitution §V）。
> **⚠ 跨层不变性（[ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md)）**：014 server 段**不 DI marketdata**；详情/K线/报价/估值/财务由 **mobile client 直调 015 EP2/3/4 client-side merge**，014 server 与 015 运行时**零跨 ctx**。014 server 段唯一端点 = **watchlist-status**（读 04/013 自选态，同 ctx）。详见 § Architecture Notes「跨层不变性」。

## Summary _(mandatory)_

014 = **portfolio 第 4 特性**（继 01 市场偏好 / 02 券商账户 / 04 自选）。富途式个股深度研判容器：**固定顶栏**[nav + 内容 3 Tab（图表/分析/公司）] / 滚动内容[报价 block 属图表 Tab、K 线、公司分区卡、分析空态] / **固定底栏**[预警 / 笔记 / 加·删自选（仅 toggle「自选」组）/ 编辑分组]。

- **server 段（极薄）= 1 个新读端点**：`GET .../watchlist-status` → `{ inWatchlist, memberships }`（`inWatchlist` = 在系统「自选」组（窄义，OQ3 2026-06-03 收窄，喂底栏加/删按钮）；`memberships` = 在所有非持仓组的 `{groupId,itemId}`，喂**编辑分组**面板勾选态）。**无新表 / 无 migration**——复用 013 已建 `Group` + `WatchlistItem` 两表。
- **mobile 段（主体）**：详情页 = 3 Tab + 报价 header + **纯 SVG K 线**（蜡烛主图 + 成交量副图 + 十字光标 + 周期日/周/月/季/年 + 复权不/前/后）+ 公司 5 卡（估值/分位/财务/身份/公司行动）+ 分析空态 + 4 项底栏。详情/K线/报价/估值/财务 **client 直调 015 EP3（详情聚合）+ EP4（bars）** 渲染；加/删自选 **复用 013** `addItem`/`deleteItem` + 新 `watchlist-status` hook 驱动底栏文案切换；涨红跌绿复用 013 已落 `quote.up/down/flat` token（**0 重设**）。

**范式** = ADR-0043 扁平贫血 + 单向 Moat；属**既有 `portfolio` bounded context**（不新立 context，续写 04）。**新基础设施** = 0（server 无新表 / 无新 token / 无新依赖——`react-native-svg@15.12.1` 已装，7 处既用）。**唯一新点** = 1 个 portfolio 读 UC + mobile 详情页组件群（含纯 SVG K 线，项目首个数据可视化组件）。

**bounded context（per [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题，见 § Architecture Notes）**：**portfolio** 自持的 `watchlist-status` 查询 UC 直注 `PrismaService` 读自己 ctx 的 `Group`/`WatchlistItem`（R1，无 repository port，贫血 row）。**零跨 ctx 业务调用**（无 R2/R3）——详情/K线/报价经 **mobile client-side merge**（per ADR-0048，server 不碰 marketdata）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（`AccountModule` 已 export，account-bound 鉴权 artefact，非业务调用，无注释要求）。

## API Contracts _(mandatory)_

| #   | Method | Path                                                                       | Auth   | Request | Response                                                          | trace FR                       |
| --- | ------ | -------------------------------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------- | ------------------------------ |
| EP1 | GET    | `/api/v1/portfolio/instruments/{market}/{code}/watchlist-status`           | bearer | —       | **200** `WatchlistStatusResponse{ inWatchlist, memberships[{groupId,itemId}] }` / 401 / 429 | FR-S03, FR-S07, FR-S08, FR-M07, FR-M08 |

- `WatchlistStatusResponse` = `{ inWatchlist: boolean, memberships: Array<{ groupId: string, itemId: string }> }`。**`inWatchlist`** = `(market,code)` 在系统「自选」组（`systemKind='watchlist'`，窄义，OQ3 2026-06-03 收窄）→ 喂底栏加/删按钮。**`memberships`** = `(market,code)` 在所有**非持仓**组（系统「自选」+ 自定义组 `null`，排除 `'holdings'`）的 `{groupId,itemId}`（数字串）→ 喂**编辑分组面板**勾选态 + 取消勾时拿 `itemId` 精确删（013 EP9）。加/删自选 + 编辑分组的增删全复用 013（EP7/EP9/EP2/EP1）。
- **未知 symbol → `{ inWatchlist:false, memberships:[] }`（非 404）**（FR-S06）。非法 `market`（∉ `cn/hk/us`）→ 同样空（无行匹配，不报枚举信号；不引入新 400 分支，D4）。
- 鉴权：`JwtAuthGuard` + status==ACTIVE（未认证/非 ACTIVE → 401，反枚举不区分原因，与 /me 一致，FR-S07）。错误一律 RFC 9457 ProblemDetail（复用 001 全局 filter，per [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)）。
- 限流：复用 013 `watchlist-read-account` 桶（`120/60s`，per-account 经 `AccountIdThrottlerGuard`）+ `@SkipThrottle` 其余桶（反污染，FR-S08）。**不新增 throttler 桶**。
- 路径前缀 `api`（全局）。端点路径为 spec 提案（已列 spec frontmatter `perf_budgets`），OpenAPI code-first（swagger 装饰器）阶段定稿。**perf SoT** = spec frontmatter（EP1 p95 100 / p99 200）。
- **详情 / K线 / 报价不在 014 契约**——mobile client 直调 015 **EP3** `GET /api/v1/marketdata/instruments/{symbol}`（聚合 `quote`/`valuation`/`financials`/`corporateActions`/身份）+ **EP4** `GET .../{symbol}/bars?period=&adjust=`（已 ship，`@nvy/api-client` 已含 `marketdataControllerDetail` / `marketdataControllerBars` + RQ hook）。`symbol` = canonical `market:code`（如 `cn:600519`）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`）           | 状态 | 备注                                                                                                                                          |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点                                              |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | watchlist-status UC 红→绿（Testcontainers PG：在自选/在自定义组/仅持仓组→false/未加→false/反枚举 401/限流 429）；mobile 逻辑分流 vitest（涨跌色 / 周期·复权态 / 加删文案 / 蜡烛几何纯函数）+ UI Playwright |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | tasks.md 按此拆；server PR1 + mobile PR2 两段（见 § Phase 2 准备）                                                                            |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 既有 `portfolio` ctx 续写；watchlist-status UC 零 `prisma.<otherTable>.*`（仅 `prisma.watchlistItem.*` / `prisma.group.*`）；**零跨 ctx 业务调用**（详情/K线 client-side merge，per ADR-0048）；guard 复用经 `AccountModule` export；`check-server-moat.ts` 关（`group`/`watchlistItem` owner 013 已登记，不重加） |
| V. 类型同步链 Nx-driven                            | ✅   | server swagger → `nx run server:export-openapi` → `nx affected -t generate`（Orval regen watchlist-status hook）→ mobile 消费；PR1 先 merge，PR2 消费已落地 client |

## Architecture Notes _(mandatory)_

### 🚨 跨层不变性（ADR-0048 — ENFORCED，本特性头号约束）

> **014 server 段 NEVER DI marketdata**。详情（报价 header / 估值 / 分位 / 财务 / 公司行动 / 身份 / 52 周高低）与 K 线由 **mobile client 直调 015 读端点 client-side merge**：
>
> - 详情：mobile 调 `GET /api/v1/marketdata/instruments/cn:600519`（EP3，聚合 `quote`+`valuation`+`financials`+`corporateActions`+身份）→ 渲染报价 header（图表 Tab）+ 公司 Tab 全部分区 + nav condensed 现价。缺维度 null → 占位 `--`（FR-M03/M05）。
> - K 线：mobile 调 `GET /api/v1/marketdata/instruments/cn:600519/bars?period=day&adjust=forward`（EP4，period 日/周/月/季/年服务端聚合 + adjust 不/前/后）→ 纯 SVG 渲染（FR-M04）。
> - **014 server 与 015 运行时零跨 ctx**（仅共享 `market:code` 逻辑键，无 server cross-ctx use case 直 DI，无跨 schema FK）。
> - `WatchlistItem.market` 词表 = `cn`/`hk`/`us`（015 `Instrument.market` 同词表，#302 已对齐；**不做映射**），canonical `cn:600519` 可直喂 015。
> - **报价 EP2（`/quote`）在详情页不单独调**——EP3 详情聚合已含 `quote` header（最新/涨跌/涨跌幅/昨收），condensed 现价复用之。EP2 是 013 列表批量 merge 用，详情页用不上（D3）。

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions，逐条）

| Q     | 问题                                       | 判定                                                                                                                 |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Q1    | 直改 account/credential 核心表 row state？ | **No** — 只读 portfolio 自有 `Group`/`WatchlistItem`，仅逻辑引用 accountId                                           |
| Q2    | 编排多 context user-facing 流程？          | **No** — 单一只读判定，accountId 取自 JWT sub（guard）                                                              |
| Q3    | 纯 platform infra？                        | **No** — 业务领域（portfolio 自选态）                                                                               |
| Q4    | 完全新业务领域？                           | **No** — `portfolio` 已立（01）；本特性续写既有 ctx，不新立                                                         |
| Q5-Q7 | 跨 ctx call 传播？                         | **N/A** — portfolio 无跨 ctx 业务调用。详情/K线经 mobile client-side merge（ADR-0048，非 server cross-ctx）；guard 复用经 `AccountModule` export，非 use case 调用，不触发 R2/R3 |

### Portfolio module 落位（per catalog，ship 时新增 Operation 行）

| 操作                     | context       | 类型           | 跨 ctx | 备注                                                                       |
| ------------------------ | ------------- | -------------- | ------ | -------------------------------------------------------------------------- |
| `get-watchlist-status`   | **portfolio** | intra query UC | —      | authed；读自己 `group` + `watchlistItem` → inWatchlist(自选组,窄) + memberships(所有非持仓组 {groupId,itemId}) |

### Server side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) 扁平贫血，文件平铺于 `apps/server/src/portfolio/`）

**新增（portfolio 既有 module 续写）**：

- `watchlist-status.controller.ts`（`@Controller('v1/portfolio/instruments')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()` + `@ApiTags('portfolio')`）：EP1 `@Get(':market/:code/watchlist-status')` + `@Throttle({ 'watchlist-read-account': ... })` + `@SkipThrottle({ ...其余桶 })` + swagger（200/401/429）。account 取 `@Req() req: { user: AuthenticatedUser }` → `req.user.accountId`（镜像 013 `watchlist-groups.controller.ts:75-79`）。
- `get-watchlist-status.usecase.ts`（`@Injectable`，直注 `PrismaService`，镜像 013 `list-watchlist-groups.usecase.ts:20-63`）：单查 `prisma.watchlistItem.findMany({ where: { market, code, group: { accountId, OR: [{ systemKind: null }, { systemKind: 'watchlist' }] } }, select: { id: true, groupId: true, group: { select: { systemKind: true } } } })` → `memberships = rows.map(r => ({ groupId: r.groupId.toString(), itemId: r.id.toString() }))`，`inWatchlist = rows.some(r => r.group.systemKind === 'watchlist')`。**⚠ 排除持仓组的 null 安全**（D2，impl gate 必验）：自定义组 `systemKind = null` 必须纳入 memberships，故用 `OR: [{ systemKind: null }, { systemKind: 'watchlist' }]` 显式白名单，**不用** `NOT: { systemKind: 'holdings' }`（Prisma `NOT` 生成 `<>` 排除 NULL 行 → 漏掉自定义组）。
- DTO：`watchlist-status.response.ts`（`WatchlistStatusResponse { inWatchlist: boolean; memberships: WatchlistMembership[] }` + `WatchlistMembership { groupId: string; itemId: string }`，swagger `@ApiProperty`（嵌套数组用 `type: [WatchlistMembership]`）；镜像 013 `watchlist-item-list.response.ts:34-78` 体例）。
- **无新 exception**（未知 symbol → false 非 404；非法 market → false）。

**修改既有（platform / cross-cutting，极小）**：

- `apps/server/src/portfolio/portfolio.module.ts`：`controllers` 加 `WatchlistStatusController`；`providers` 加 `GetWatchlistStatusUseCase`。
- `scripts/checks/check-server-moat.ts`：**无需改**（`group`/`watchlistItem` owner=portfolio 013 已登记）。
- **无 Prisma schema 改动 / 无 migration / 无新 throttler 桶 / 无 ESLint boundaries 改动**——全部复用 013 已落基础设施。

### 并发 / 事务策略

> **纯只读端点，无写、无事务、无并发不变性**。单次 `findMany`（覆盖 `@@unique([groupId, market, code])` + `@@index` 路径，跨 account 的 group 已索引 `account_id`）。底栏「加/删自选」走的是 **013 既有写端点**（EP7 add / EP9 delete，013 已定 last-write-wins + 幂等语义），014 不重定义并发。

### 限流配置（复用 013 throttler infra，零新增）

| 端点                                       | per-account | 实现                                       |
| ------------------------------------------ | ----------- | ------------------------------------------ |
| watchlist-status 读（EP1）                 | `120/60s`   | 复用 013 named `watchlist-read-account` 桶 |

全 authed → 复用 `AccountIdThrottlerGuard`，无 IP 桶。`@SkipThrottle` 其余全部桶防污染（与 013 read EP 一致）。

### Mobile side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) strangler-fig + [mobile-impl-playbook](../../docs/conventions/mobile-impl-playbook.md)）

**`apps/mobile/src/portfolio/`（feature dir 已于 01/04 建，续写）** — 新增详情页组件群：

- `stock-detail-screen.tsx`：编排 固定 `DetailTopNav` + `DetailTabs`（图表/分析/公司）→ 单 scroll 容器（按当前 Tab 渲染）→ 固定 `BottomBar`。scroll offset → condensed 现价态（`condensed = tab !== 'chart' || scrollY > 150`，D5）。
- `detail-top-nav.tsx`：nav 行（返回 + 名称 + 代码 + market badge + 搜索 + 收藏）；condensed 态内联 名称 + 现价 + 涨跌（涨红跌绿）。复用 `~/ui` `makeHeaderBackOrParent`（硬刷新返回兜底，per memory `expo-router web refresh loses back button`）。
- `detail-tabs.tsx`：固定 3-Tab 分段控件（图表默认；`accessibilityRole='tab'`；选中 `surface-sunken` 底 + brand 下划线）。**先评估复用 013 `~/ui` `Tabs`**；形态不符（013 Tabs 是横滑分组 + 管理入口）则本地建轻量 segmented（不污染 `~/ui`，D6）。
- `quote-header.tsx`（图表 Tab 内容首屏，**非跨 Tab 常驻**）：EOD 字段网格（最新=收盘大字 + 涨跌额 + 涨跌幅 + 昨收 + PE TTM + PB + 股息率 + 总市值 + 流通市值）+ **阶段二扩展区 dashed 占位**（盘中字段预留位不重排，FR-M02）+ **数据新鲜度小字**（`quote.asOf` 数据日期 + `priceKind=eod_close`「收盘」标注，非当日轻提示「数据截至 X」，clarify G1）。缺字段 `--`。
- `kline-chart.tsx`（**项目首个数据可视化组件，纯 `react-native-svg`**，port mockup `KLineChart.jsx`）：蜡烛主图（`Rect` 实体 + `Line` 影线）+ 成交量副图（`Rect`）+ 十字光标（touch → `Line` + OHLC legend）+ 右价格轴 + 底日期轴 + 网格。涨红跌绿（quote token）。**坐标/缩放/抽样折算逻辑落 `kline-geometry.ts` 纯函数**（vitest 可测，per memory `playwright rngh longpress drivable`：手势折算逻辑纯函数兜底）。大数据量（年 K 多年）→ 抽样/降采样（NFR，FR Mobile Edge）。
- `chart-tab.tsx`：`quote-header` + 周期切换条（日/周/月/季/年 pill）+ 复权切换（不/前/后 segment）+ `kline-chart`；切周期/复权 → `useMarketdataControllerBars(symbol, { period, adjust })` 重拉（015 EP4）。**不含分时/逐笔**（阶段二）。
- `company-tab.tsx`：5 分区卡（① 估值 KV：PE TTM/静/动·PB·PS·股息率·总/流通市值·总股本 ② 估值分位 `PercentileBar`：PE/PB y3/y5 ③ 财务衍生：ROE/毛利率/EPS/BPS ④ 静态身份：名称/代码/market/类型/币种/52 周高低 ⑤ 公司行动：分红/拆股只读列表）。数据全来自 015 EP3 详情聚合。缺字段空态 `--`（港美股薄 / 无财报季，FR-M05）。
- `percentile-bar.tsx`（理杏仁招牌可视化）：渐变条（低估→高估）+ 白心 brand 描边位置点 + 偏低/适中/偏高（<30/30-70/>70）刻度（mockup 定稿规格）。
- `analysis-tab.tsx`：居中空态（doc 图标 +「研报功能即将上线」+ 指向独立研报 PRD，OQ2，FR-M09）。
- `bottom-bar.tsx`（同花顺式固定底栏 4 项）：预警 / 笔记（**disabled `#C7CBD1` + tap toast「X 功能即将上线」**，OQ1/FR-M09）/ **加·删自选**（star toggle，仅 toggle 系统「自选」组，未自选 brand 描边星「自选」/ 已自选 accent #FF8C00 实心星「已自选」，态随 `inWatchlist`，D1）/ **编辑分组**（开 `edit-groups-sheet`，FR-M08）。
- `edit-groups-sheet.tsx`（FR-M08，同花顺式 multi-select，底部 sheet）：列该账号所有**非持仓**组（自选+自定义，排除持仓）为 2 列网格（组名+标的数）；`memberships` 命中的组高亮+勾（**brand-soft 底 + brand-500 ✓，不用红**）；点格 toggle → 加入（013 EP7）/ 移出（013 EP9 用 memberships 的 itemId）；底「＋新建分组」（开 `create-group-dialog`）/「完成」。**无颜色 / 无快速建组 / 无分享**。
- `create-group-dialog.tsx`（居中 modal 薄壳，~40 行）：组名 `TextInput` + 字符计数（对齐 server name 上限）+ 取消/确定；**复用 013 `useWatchlistGroups().createGroup`**（EP2）+ 文案；建后 react-query 缓存刷新 → 新组现于 sheet 可勾。**不重构 013 内联建组行（已 ship）**，014 自建薄壳（D11）。
- `use-watchlist-status.ts`：包新 orval hook → `{ inWatchlist, memberships }`；**底栏加/删自选**复用 **013** `useWatchlistItems` 的 `addItem`（未在「自选」组 → POST 落「自选」，013 EP7）/ `deleteItem`（已在 → 删 memberships 里**「自选」组那条** itemId，013 EP9，窄义对称翻，D1）；**编辑分组**复用 013 `useWatchlistGroups`（列组 EP1 / 建组 EP2）+ `useWatchlistItems`（按组加 EP7 / 移出 EP9）。乐观更新 + 失败回弹 + 错误分流（复用 013 `watchlistItemErrorToast`）。**authed 业务 401 触发 003 refresh 拦截器**（per memory，e2e 须 mock refresh 端点避免误登出）。
- `stock-detail-copy.ts`：中文文案常量。

**`~/ui` 原语**：**默认零新增**（复用 `Button` / `Spinner` / `ErrorRow` / `SafeAreaView` / `SearchBar` / `makeHeaderBackOrParent`）。`detail-tabs` segmented 若判定通用可后续提升，V1 留 portfolio 本地（D6）。各 presentational 无单测（per mono 测试分层）。

**theme token**：**0 新增 / 0 重设**——涨跌复用 013 已落 `colors.quote.up/down/flat`（`#F5333D`/`#06A561`/`#8E9094`，`theme/index.ts:60-67`，NativeWind `text-quote-up/down/flat`）。SC-M06 grep：实现文件无 token 外 hex/rgb。

**Expo route**（per memory `expo-router app route scan` + `expo-router web refresh loses back button`）：

- 详情页 = **动态路由** `app/(app)/portfolio/[symbol].tsx`（param `symbol` = canonical `cn:600519`；screen 内 `symbol.split(':')` → `market`/`code` 喂 watchlist-status）。从 013 自选行 / 搜索结果 `router.push('/(app)/portfolio/cn:600519')` 下钻（013 `watchlist-row.tsx` 当前 presentational 无 onPress → PR2 接 `Pressable onPress`，但**不改 013 行为契约**，仅加导航）。
- **market gate（clarify G2，D9）**：`us` 标的 → **不下钻 / 显「美股即将上线」占位**（016 `marketScope=['cn']` 未同步 us → 零数据，进去全 `--`）；`cn` 全维度、`hk` 可进+缺维度空态 `--`。gate 落 detail screen 入口（或导航前判定），避免 us 满屏占位。
- `app/(app)/portfolio/_layout.tsx` 已存在（013 group 管理 screen 同 Stack）；详情页加进同 Stack。硬刷新返回兜底走 `unstable_settings` anchor + `headerLeft`（per memory）。

### Dependencies & Defensive Additions（Cargo-cult 防火墙 + Vendor 评估）

| 引入的依赖 / Defensive Import | 目的     | Fact-check 锚点 / 决策                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **None**（K 线图表）          | 蜡烛+量图 | **不引** `react-native-skia` / `victory-native` / `wagmi-charts`——**复用已装 `react-native-svg@15.12.1`**（`apps/mobile/package.json:61`，7 处既用：`TabBarIcon`/`SearchBar`/`LogoMark`/`DeviceIcon` 等，web 经 `react-native-web` 渲染为 DOM `<svg>`）。**Vendor 6Q：Q2「已装工具能否等价覆盖」= 能**（mockup `KLineChart.jsx` 已是纯 SVG 蜡烛+量+十字光标参考实现）。**Q3 兼容**：SVG→DOM 节点可被 **Playwright Web 断言**（`locator('path')`/`locator('rect')`），契合 mono UI 测试分层（skia web 走 CanvasKit WASM 渲染到 canvas，Playwright 只能截图不能断言元素 → 与测试分层冲突，已排除）。**Q5 解耦**：阶段一仅 EOD 日频，数据量有界，无 GPU 必要；阶段二高频 realtime 接入再评估（015 `priceKind` seam）。 |

### Cross-cutting

- **同步链**（Constitution V，per [api-contract-trigger](../../.claude/rules/api-contract-trigger.md)）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval regen watchlist-status hook）→ mobile 消费 typed hook。**注意**：mobile 详情/K线消费的是 **015 已 ship 的 marketdata EP3/EP4 hook**（`marketdataControllerDetail`/`Bars`，api-client 已含），非本特性新端点。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 1 行（`get-watchlist-status`，context=portfolio，propagation=intra）。
- **跨 ctx 注释**：portfolio **无** R2/R3 业务调用 → 无 `// CROSS-CONTEXT-SYNC/ASYNC` 注释。`check-server-moat.ts` 验 portfolio 内零 `prisma.<otherTable>.*`（owner 013 已登记，不重加）。
- **反枚举不变性**：watchlist-status 未认证/非 ACTIVE → 统一 401（`JwtAuthGuard`，与 /me 一致）；未知 symbol → `{inWatchlist:false, memberships:[]}`（**不** 404，避免「该 symbol 不存在」枚举信号，FR-S06）。
- **视觉 0 硬编码**（SC-M06）：mobile 实现文件 grep 无 theme token 外 hex/rgb（K 线涨跌、分位条渐变端点均走 token）。
- **盘中字段不渲染 ≠ `--` 占位**（FR-M02 / Mobile Edge）：阶段二无源字段**整块不出现**（dashed 预留区）；区别于「有源但暂缺」的 `--`。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #      | 决策                       | 结论                                                                                                                                                                                                                            | gate?            |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **D1** | 加/删自选 ↔ 自定义组的不对称（已解，clarify 2026-06-03 G3）| **底栏拆两按钮 + OQ3 收窄**：① 加/删自选**窄义**（仅「自选」组，对称 toggle，不碰自定义组）；② **编辑分组面板**（同花顺式 multi-select）显式管理标的↔自定义组。端点返 `memberships[{groupId,itemId}]`（替代原 `itemIds[]`）喂面板勾选态。无误删 / 无死锁                                                                  | ✅ user 定 |
| **D2** | 排除持仓组的 null 安全      | UC where 用 `OR: [{ systemKind: null }, { systemKind: 'watchlist' }]` 显式白名单**而非** `NOT: { systemKind: 'holdings' }`（Prisma `NOT` 生成 `<>` 排除 NULL → 漏掉 `systemKind=null` 的自定义组）。impl 必带覆盖自定义组的 IT | ✅ impl gate（IT 验） |
| **D3** | 详情页报价数据源           | **EP3 详情聚合的 `quote` header**（含最新/涨跌/涨跌幅/昨收）；**不单独调 EP2 `/quote`**（那是 013 列表批量 merge 用）。condensed 现价复用 EP3.quote                                                                            | ✅ 默认接受       |
| **D4** | 非法 market 路径参数       | 返 `inWatchlist:false`（无行匹配），**不新增 400 分支**（路径 param 难 class-validate，且 false 已是安全保守态，不泄枚举）。← 若 tasks 要严格 400 可加 pipe 校验                                                              | ✅ 默认接受       |
| **D5** | condensed 现价触发阈值     | `condensed = tab !== 'chart' || scrollY > 150`（mockup 定稿值）                                                                                                                                                               | ✅ 默认接受       |
| **D6** | detail 3-Tab 原语归属      | V1 portfolio 本地 `detail-tabs.tsx`（先评估复用 013 `~/ui` Tabs；形态不符则不强塞 `~/ui`，避免污染通用层）                                                                                                                    | ✅ 默认接受       |
| **D7** | 加自选状态读取失败兜底     | 默认「加」态（保守不误显已加，spec Mobile Edge）；status query error → `inWatchlist=false`                                                                                                                                     | ✅ 默认接受       |
| **D8** | 持仓标的下钻底栏           | 持仓派生项（holdings 组）不参与 toggle（OQ3 排除）；若标的**仅**在持仓组 → status=false → 显「加自选」（点击落「自选」组，与持仓组并存，符合 04 持仓只读语义）                                                                  | ✅ 默认接受       |
| **D9** | 市场下钻 gate（clarify G2） | `us` gate 不可下钻（016 未同步 us，零数据）；`cn` 全维度 / `hk` 可进+缺维度空态 `--`。gate 落 detail screen 入口判定                                                                                                          | ✅ clarify 定     |
| **D10** | 报价数据新鲜度（clarify G1） | 复用 015 `quote.asOf` + `priceKind`：报价区/condensed 显示数据日期 +「收盘」标注，非当日轻提示「数据截至 X」。无需新端点（asOf 已在 EP3/EP2 契约）                                                                            | ✅ clarify 定     |
| **D11** | 编辑分组面板 + 新建分组复用（clarify G3）| 编辑分组 multi-select 全复用 013 端点（EP1/2/7/9）；新建分组 = 014 薄居中弹框 + 复用 013 `createGroup`（013 建组是内联行 + 嵌已 ship 屏 → 不重构，014 自建薄壳）。无颜色 / 无快速建组 / 无分享                                | ✅ user 定 |
| **Perf** | watchlist-status P95/P99 | EP1 `100/200`（spec frontmatter SoT）                                                                                                                                                                                          | —                |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) **续写既有 portfolio ctx**（非新 context）；server 段是 013 以来**最薄**的一个——1 只读 UC + 1 controller + 1 DTO，**零新表 / 零 migration / 零新依赖 / 零新 token / 零新 throttler 桶**。(2) **无 outbox / 无 scheduler / 无跨 ctx 业务调用 / 无写事务**（详情/K线 client-side merge，per ADR-0048）。(3) 复杂度**全在 mobile**：纯 SVG K 线（项目首个数据可视化）+ 报价 header 网格 + 公司 5 卡 + 分位可视化 + 4 项底栏 + 3-Tab 富途框架。K 线几何折算逻辑抽 `kline-geometry.ts` 纯函数（vitest 兜底，规避 SVG 渲染层不可单测）。

## Performance Budget

| Endpoint                                                              | P95 (ms) | P99 (ms) |
| -------------------------------------------------------------------- | -------: | -------: |
| `GET /api/v1/portfolio/instruments/{market}/{code}/watchlist-status` |      100 |      200 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。单 `findMany`（覆盖 `@@unique([groupId,market,code])` + `account_id` 索引），无瓶颈。详情/K线/报价不经 014 server（client 直调 015），perf 归 015 spec frontmatter（EP3/EP4）。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**两段式 PR**（推荐，契合 mockup-first 纪律② + Constitution §V cross-end 拆分）：

- **PR1（server，feat(portfolio)）**：watchlist-status UC + controller + DTO + module 注册 + throttler 复用 + IT（Testcontainers PG）+ contract regen（api-client watchlist-status hook）。ships 真后端。**描述须 cite Constitution §V 例外**（api-client regen 随 PR1 merged，PR2 消费已落地 typed client → drift 消解，沿 005/011/013 先例）。
- **PR2（mobile，feat(portfolio)）**：`src/portfolio/` 详情页组件群（screen + top-nav + tabs + quote-header + kline-chart + chart-tab + company-tab + percentile-bar + analysis-tab + bottom-bar + **edit-groups-sheet + create-group-dialog**）+ `use-watchlist-status` hook + 013 add/remove/建组 复用 + `kline-geometry` 纯函数 + Expo `[symbol]` route + 013 row 接导航 + vitest 逻辑分流 + 两层验证（`[Mobile-E2E]` Playwright hermetic + `[Contract-Smoke]` 真后端，per sdd.md §V）。

> 014 依赖 **013 已 merge**（#312，提供 `Group`/`WatchlistItem` 表 + `useWatchlistItems` add/remove hook）+ **015/016 已 ship**（EP3/EP4 真数据）。

### 建议 tasks.md 层级（每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）

**Server（PR1，~3-4 task）**：

- `[Server]` watchlist-status UC + DTO：`get-watchlist-status.usecase.ts`（直注 Prisma，`OR` 白名单纳入 null 自定义组，返 `{inWatchlist(自选组), memberships[{groupId,itemId}]}`）+ `watchlist-status.response.ts`（swagger，含嵌套 `WatchlistMembership`）+ Testcontainers PG 单测（在自选组→inWatchlist true / 仅自定义组→false 但 memberships 非空 / 仅持仓组→false+空 / 未加→false+空，**D2 null-custom 覆盖**）。
- `[Server]` controller + module + throttler：`watchlist-status.controller.ts`（`@Controller('v1/portfolio/instruments')` + `@Get(':market/:code/watchlist-status')` + guards + named throttler 复用 + swagger 200/401/429）+ PortfolioModule 注册。
- `[Server-IT]`（Testcontainers PG 全 boot，覆盖 spec `state_branches` 每条）：authed inWatchlist=true（在自选组）/ inWatchlist=false 但 memberships 非空（仅在自定义组，**验 null systemKind 纳入 memberships**）/ false+空（仅持仓组）/ false+空（未加）/ 未知 symbol false+空 非 404 / 反枚举 401 / 限流 429。
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（orval regen watchlist-status hook）+ api-client/mobile typecheck 绿。
- `[Verify]`：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿 + catalog 1 Operation 行 + boundaries 0 违规 + `check-server-moat.ts` 关（含 portfolio 零 marketdata 跨 ctx，per ADR-0048）。

**Mobile（PR2，~6-8 task）**：

- `[Mobile]` K 线几何 + SVG 组件：`kline-geometry.ts`（价/量→坐标·抽样·十字光标命中纯函数）+ vitest + `kline-chart.tsx`（纯 SVG 蜡烛+量+十字光标+轴+网格，涨红跌绿）+ typecheck/lint。
- `[Mobile]` 详情数据 hooks：`use-watchlist-status.ts`（新 orval hook → `{inWatchlist, memberships}` + 013 add/remove/建组 复用 + 乐观更新 + 错误分流 + **mock 003 refresh**）+ 复用 `useMarketdataControllerDetail`/`Bars` + vitest（涨跌色逻辑 / 加删文案随 inWatchlist / 编辑分组勾选态由 memberships 派生 / 周期·复权态）。
- `[Mobile]` 报价 + 图表 Tab：`quote-header.tsx`（EOD 网格 + **asOf 数据日期/「收盘」标注**，D10 + 阶段二 dashed 预留）+ `chart-tab.tsx`（周期/复权切换 → EP4 重拉）+ typecheck/lint。
- `[Mobile]` 公司 Tab：`company-tab.tsx`（5 卡）+ `percentile-bar.tsx`（分位可视化）+ 缺字段空态 + typecheck/lint。
- `[Mobile]` 框架 + 底栏 + 分析 + route：`stock-detail-screen.tsx`（固定顶+滚动+固定底 + condensed 态）+ `detail-top-nav.tsx` + `detail-tabs.tsx` + `analysis-tab.tsx`（空态）+ `bottom-bar.tsx`（4 项：预警/笔记 disabled toast + 加·删自选窄义 + 编辑分组）+ `edit-groups-sheet.tsx`（multi-select，复用 013 EP1/7/9）+ `create-group-dialog.tsx`（薄壳，复用 013 `createGroup` EP2）+ Expo `[symbol]` route（含 **us market gate**，D9）+ 013 `watchlist-row` 接 `Pressable onPress` 导航 + typecheck/lint。
- `[Mobile-E2E]`（Playwright Expo Web，hermetic UI）：渲染详情页（顶 Tab 在最顶、报价属图表 Tab）/ 切 3 Tab（公司/分析 nav 显 condensed）/ 图表切周期·复权（断言 SVG `<rect>`/`<path>` 蜡烛重渲）/ 涨跌色 / 缺字段 `--` / **报价显示 asOf 数据日期 + 「收盘」标注（D10）** / **us 标的 gate 占位（D9）** / 底栏加·删自选窄义 toggle（仅「自选」组）/ 编辑分组 sheet（勾未勾组→加入、取消已勾组→移出、选中态 brand 蓝非红）/ 新建分组弹框（无色板）/ 预警·笔记 disabled toast；**mock 015 EP3/EP4 + watchlist-status + 013 groups/items + 003 refresh 端点**。
- `[Contract-Smoke]`（per sdd.md §V，node 层打 testcontainers 真 server）：登录 → 调 015 EP3 详情（断 valuation/financials 字段）+ EP4 bars（period/adjust）→ 调 014 watchlist-status（inWatchlist=false, memberships=[]）→ 加自选「自选」组（013 EP7）→ watchlist-status inWatchlist=true + memberships 含自选组 → 经编辑分组加入某自定义组（013 EP7）→ memberships +1（inWatchlist 仍 true）→ 验真落库 + 契约对齐。落 `apps/mobile/e2e/contract-smoke/stock-detail.contract.ts`。

预估 task 数：PR1 ~4-5（server）+ PR2 ~7-8（mobile）= **~11-13**。复杂度全在 mobile（纯 SVG K 线 + 富途 3-Tab 框架 + 公司分位可视化）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-03 | **ID-namespace**: US3-7 / FR-S03·S07·S08·S09·S10 / FR-M01..M11 / SC-S03·S05·S06 / SC-M01..M06 | **ADR**: 0048（跨层不变性）/ 0043（扁平贫血）/ 0032（bounded context）/ 0038（错误契约）
