---
feature_id: 014-stock-detail
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-03'
---

# Tasks: 014-stock-detail（股票详情 — 富途式顶 Tab + 同花顺式固定底栏）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `014-stock-detail` | **Mockup**: [`design/`](./design/)（v2 baseline `股票详情 v2.html` + `StockDetailKit3.jsx`）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Contract / Verify / 共享 Foundational 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`（per sdd.md）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读 DB 单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（rules / kline-geometry）= vitest 无 DB；**US6 server 段 Independent Test = `[Server-IT]` 全 boot**；mobile 纯逻辑（涨跌色 / 加删文案 / memberships 派生勾选态 / K线几何）= vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004-013）
- **portfolio = 既有第 4 bounded context（01 bootstrap，013 已加 watchlist 两表）**：本特性**续写**，**零新表 / 零 migration / 零新 token / 零新依赖**（`react-native-svg@15.12.1` 已装）；仅加 1 读 UC + 1 controller + 1 DTO。**零跨 ctx 业务调用**（intra only，无 R2/R3 → 无 `// CROSS-CONTEXT-*` 注释）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（经 `AccountModule` export，非 use case 调用，无注释要求）；moat `MODEL_OWNERSHIP` 的 `group`/`watchlistItem` owner **013 已登记，不重加**
- 🚨 **ADR-0048 头号不变性**：**014 server 段 NEVER DI marketdata**；详情/K线/报价由 **mobile client 直调 015 EP3/EP4 client-side merge**（014 server 与 015 运行时零跨 ctx）。`[Verify]` 须验 portfolio 零 `prisma.<marketdataTable>.*` + 零 marketdata UC 注入
- **加/删自选 = 窄义（仅系统「自选」组，clarify G3 / D1）**；自定义组关系由**编辑分组面板**（multi-select）显式管理，全复用 013 端点（EP1/2/7/9）。watchlist-status 端点返 `{ inWatchlist(自选组), memberships[{groupId,itemId}] }`
- **两段式 PR（per Constitution §V）**：**PR1 = Server**（T001–T005，ships 真后端 + **api-client regen committed**）→ **PR2 = Mobile**（T006–T016，消费 PR1 已 merge 的 typed client + 两层验证 per sdd.md §V）。**PR1 描述须 cite §V 例外**（regen 随 PR1 merged，PR2 消费已落地 client，沿 005/011/013 先例）

## Path Conventions

- server：`apps/server/src/portfolio/`（**既有 module 续写**，ADR-0043 扁平平铺）；**无 schema/migration 改动**（复用 013 `Group`+`WatchlistItem`）；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/portfolio/`（**既有 feature 目录续写**）；复用 `~/core/api`、`~/theme`（quote.up/down/flat 013 已落，**0 重设**）、`~/ui`（`Button`/`Spinner`/`ErrorRow`/`SafeAreaView`/`makeHeaderBackOrParent`）；K线用已装 `react-native-svg@15.12.1`
- mobile 入口：详情页 = **动态路由** `app/(app)/portfolio/[symbol].tsx`（param `symbol`=canonical `cn:600519`，screen 内 `split(':')`→market/code）；从 013 `watchlist-row` 接 `Pressable onPress` 下钻（不改 013 行为契约，仅加导航）；详情 screen 进同 `app/(app)/portfolio/_layout.tsx` Stack（硬刷新返回兜底 anchor+headerLeft，per memory `expo-router web refresh loses back button`）
- e2e：`apps/mobile/e2e/`（**必 mock 015 EP3/EP4 + 014 watchlist-status + 013 groups/items + 003 refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；`getByRole` 收窄 stacked screen；**本地跑前杀 :3000 nx serve 父进程** per memory `nx_serve_respawns_3000_poisons_seed_e2e`）；contract-smoke `apps/mobile/e2e/contract-smoke/stock-detail.contract.ts`（`nx run mobile:contract-smoke`，打 testcontainers 真 server）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）；**本地 server IT/smoke 前 `env -u OSS_*`** per memory `local_it_smoke_needs_env_unset_oss`

---

## Phase 1: Server — watchlist-status 端点（PR1，服务 US6 底栏自选态 + 编辑分组面板）

**Goal**：014 唯一新 server 端点 `GET /api/v1/portfolio/instruments/{market}/{code}/watchlist-status` → `{ inWatchlist(系统「自选」组,窄义), memberships[{groupId,itemId}](所有非持仓组) }`；复用 013 两表，零新表/migration。

- [X] T001 [US6] [Server] `get-watchlist-status.usecase.ts` + `watchlist-status.response.ts`（`apps/server/src/portfolio/`）：UC `@Injectable` 直注 `PrismaService`（镜像 013 `list-watchlist-groups.usecase.ts:20-63`），单查 `prisma.watchlistItem.findMany({ where:{ market, code, group:{ accountId, OR:[{systemKind:null},{systemKind:'watchlist'}] } }, select:{ id:true, groupId:true, group:{select:{systemKind:true}} } })` → `memberships = rows.map(r=>({groupId:r.groupId.toString(), itemId:r.id.toString()}))`，`inWatchlist = rows.some(r=>r.group.systemKind==='watchlist')`。**⚠ D2 null 安全（impl gate 必验）**：自定义组 `systemKind=null` 必须纳入 → 用 `OR` 白名单，**不用** `NOT:{systemKind:'holdings'}`（Prisma `NOT` 生成 `<>` 排除 NULL 行 → 漏自定义组）。DTO `WatchlistStatusResponse { inWatchlist:boolean; memberships:WatchlistMembership[] }` + `WatchlistMembership { groupId:string; itemId:string }`（swagger `@ApiProperty`，嵌套 `type:[WatchlistMembership]`，镜像 013 `watchlist-item-list.response.ts:34-78`）。**绑 Testcontainers PG 单测**：在自选组→inWatchlist=true / 仅自定义组→inWatchlist=false 但 memberships 非空（**验 null systemKind 纳入**）/ 仅持仓组→false+空 / 未加→false+空
- [X] T002 [US6] [Server] `watchlist-status.controller.ts` + module 注册（`apps/server/src/portfolio/`）：`@Controller('v1/portfolio/instruments')` + `@Get(':market/:code/watchlist-status')` + `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()` + `@ApiTags('portfolio')` + **复用 013 named throttler `watchlist-read-account`**（`@Throttle({'watchlist-read-account':...})` + `@SkipThrottle` 其余桶，**不新增桶**）+ swagger（200 `WatchlistStatusResponse` / 401 / 429）；account 取 `@Req() req:{user:AuthenticatedUser}` → `req.user.accountId`（镜像 013 `watchlist-groups.controller.ts:75-79`）。`portfolio.module.ts` `controllers` 加 `WatchlistStatusController` + `providers` 加 `GetWatchlistStatusUseCase`
- [X] T003 [US6] [Server-IT] `apps/server/test/integration/watchlist-status.it.spec.ts`（Testcontainers PG 全 boot，run via `nx test server`，覆盖 spec `state_branches` 每条）：authed inWatchlist=true（在自选组）/ inWatchlist=false 但 memberships 非空（仅自定义组，**验 null 纳入**）/ false+空（仅持仓组）/ false+空（未加）/ 未知 symbol false+空 **非 404** / 非法 market false / **反枚举 401**（未认证·非 ACTIVE 字节级一致）/ **限流 429**（read 桶）
- [X] T004 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen `watchlist-status` hook + `WatchlistStatusResponse`/`WatchlistMembership` 类型）→ `packages/api-client` + mobile typecheck 绿。**regen 产物随 PR1 commit**（Constitution §V）
- [X] T005 [Verify] PR1 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿 + `server-bounded-context-catalog.md` Operation Catalog 加 1 行（`get-watchlist-status`，context=portfolio，intra）+ boundaries 0 violation + `pnpm tsx scripts/checks/check-server-moat.ts` 关（**含 portfolio 零 `prisma.<marketdataTable>.*` + 零 marketdata UC 注入，ADR-0048**）

**Checkpoint**：PR1 server ships 真后端 + api-client regen committed → merge 后 PR2 消费。

---

## Phase 2: Mobile Foundational（PR2 共享前置 — 路由 + 详情 screen 骨架 + 数据 hook）

**Goal**：详情页路由 + screen 壳 + 数据 hook，阻塞全部 mobile US。

- [X] T006 [Mobile] 详情数据 hooks + route 骨架：`apps/mobile/src/portfolio/use-watchlist-status.ts`（包 T004 orval hook → `{inWatchlist, memberships}`）+ 复用 015 `useMarketdataControllerDetail(symbol)`（EP3）/ `useMarketdataControllerBars(symbol,{period,adjust})`（EP4）+ Expo `app/(app)/portfolio/[symbol].tsx` 动态路由（`symbol.split(':')`→market/code；**us market gate D9**：us → 不下钻 / 显「美股即将上线」占位）+ 013 `watchlist-row` 接 `Pressable onPress`→`router.push` 下钻（不改 013 契约）+ **vitest**（symbol 解析 / us gate 判定 / memberships→编辑分组勾选态派生）+ typecheck/lint
- [X] T007 [Mobile] [US3] `stock-detail-screen.tsx`（固定顶 + 单 scroll + 固定底编排，condensed 态 `tab!=='chart' || scrollY>150` D5）+ `detail-top-nav.tsx`（nav 行：返回 + 名称 + 代码 + market badge + 搜索 + 收藏；condensed 内联 名称+现价+涨跌+**asOf 日期小字** D10；复用 `makeHeaderBackOrParent`）+ `detail-tabs.tsx`（固定 3-Tab 图表/分析/公司，默认图表，`accessibilityRole='tab'`，选中 surface-sunken+brand 下划线；D6 本地不污染 `~/ui`）+ typecheck/lint

---

## Phase 3: US3 — 报价 header（图表 Tab 首屏，EOD + asOf）（P1）

**Goal**：报价 block 展示 EOD 可算字段 + 数据新鲜度，涨红跌绿，缺字段 `--`。
**Independent Test**：mock 015 detail → 报价区渲染 EOD 字段（最新=收盘/涨跌/涨跌幅/昨收/PE TTM/PB/股息率/总市值/流通市值）+「数据截至 X · 收盘」+ 涨跌色 + 盘中字段不渲染 + 阶段二 dashed 预留（Playwright Web；涨跌色 vitest）。

- [X] T008 [US3] [Mobile] `quote-header.tsx`：EOD 字段网格（来自 015 EP3 `detail.quote`/`detail.valuation`）+ 最新=收盘大字（mono）+ 涨跌额/幅（**quote.up 红/down 绿/flat 灰**，符号 +/- 辅助 a11y）+ **数据新鲜度小字**（`quote.asOf`「数据截至 X」+ `priceKind=eod_close`「收盘」，D10）+ **阶段二扩展区 dashed 占位**（盘中字段预留位不重排，FR-M02）+ 缺字段 `--`；**vitest**（涨跌方向→token 映射 / asOf 文案 / 缺字段占位）

---

## Phase 4: US4 — 图表 Tab K 线（纯 SVG，日/周/月/季/年 + 复权 + 量）（P1）

**Goal**：纯 `react-native-svg` 蜡烛主图 + 成交量副图 + 十字光标 + 周期/复权切换；无分时/逐笔。
**Independent Test**：mock 015 bars（多周期）→ K线渲染（断言 SVG `<rect>`/`<path>`）+ 周期切换（日/周/月/季/年）+ 复权切换（不/前/后）重拉 + 成交量副图 + 涨跌色 + 无分时/逐笔（Playwright Web）。

- [X] T009 [US4] [P] [Mobile] `kline-geometry.ts`（纯函数）：价/量 → SVG 坐标映射 + 抽样/降采样（年 K 多年，NFR）+ 十字光标命中 + OHLC legend 取值；**vitest**（坐标映射 / 抽样边界 / 命中索引）—— 渲染层不可单测，几何折算落纯函数兜底（per memory `playwright rngh longpress drivable`）
- [X] T010 [US4] [Mobile] `kline-chart.tsx`（纯 SVG，port mockup `KLineChart.jsx`：蜡烛 `Rect`+影线 `Line` / 成交量 `Rect` 副图 / 十字光标 touch / 右价格轴 / 底日期轴 / 网格，涨红跌绿用 quote token）+ `chart-tab.tsx`（`quote-header` + 周期 pill（日/周/月/季/年）+ 复权 segment（不/前/后）→ 切换 `useMarketdataControllerBars(symbol,{period,adjust})` 重拉；**不含分时/逐笔**）+ **a11y（FR-M11，C1）**：OHLC legend + 关键数值（现价/涨跌/十字光标选中点 OHLCV）挂 `accessibilityLabel` 使图表数值屏读可达；涨跌色非唯一载体（符号 + 文本辅助）+ typecheck/lint

---

## Phase 5: US5 — 公司 Tab（估值/分位/财务/身份/公司行动）（P1）

**Goal**：理杏仁 5 分区卡 + 分位可视化，缺字段空态。
**Independent Test**：mock 015 detail（valuation/financials/corporateActions/身份）→ 公司 Tab 渲染 5 卡 + PE/PB 分位条 + 缺字段空态 `--`（Playwright Web）。

- [X] T011 [US5] [Mobile] `company-tab.tsx`（5 卡：① 估值 KV PE TTM/静/动·PB·PS·股息率·总/流通市值 ② 估值分位 `PercentileBar` PE/PB y3/y5 ③ 财务 ROE/毛利率/EPS/BPS ④ 静态身份 名称/代码/market/类型/币种/52 周高低 ⑤ 公司行动 分红/拆股只读列表，全来自 015 EP3 `detail`）+ `percentile-bar.tsx`（渐变条低估→高估 + 白心 brand 描边位置点 + 偏低/适中/偏高 <30/30-70/>70 刻度）+ 缺字段空态 `--`（港美股薄/无财报季，FR-M05）+ typecheck/lint

---

## Phase 6: US6 — 固定底栏（加·删自选窄义 + 编辑分组）（P1）

**Goal**：4 项底栏；加/删自选仅 toggle「自选」组；编辑分组 multi-select 管理自定义组（全复用 013 端点）；新建分组居中弹框（复用 013 `createGroup`，无颜色）。
**Independent Test**：mock 自选态+memberships → 底栏不在自选组→「加自选」/ 在→「删自选」（仅删自选组）；编辑分组 sheet 列非持仓组、命中组勾（brand 蓝非红）、勾/取消加入·移出、新建分组弹框无色板；预警/笔记 disabled toast（Playwright Web；加删/勾选态逻辑 vitest）。

- [X] T012 [US6] [Mobile] `bottom-bar.tsx`（同花顺式 4 项）：预警/笔记（disabled `#C7CBD1` + tap toast「即将上线」，OQ1/FR-M09）+ **加·删自选**（star toggle，仅 toggle「自选」组：未自选 brand 描边星「自选」/ 已自选 accent #FF8C00 实心星「已自选」，态随 `inWatchlist`；加=013 EP7 落「自选」/ 删=013 EP9 用 memberships 里自选组 itemId，窄义对称翻，D1）+ **编辑分组**（开 `edit-groups-sheet`）；乐观更新 + 失败回弹 + 错误分流（复用 013 `watchlistItemErrorToast`）；**vitest**（inWatchlist→加/删文案 + 加删调用映射）
- [X] T013 [US6] [Mobile] `edit-groups-sheet.tsx`（FR-M08 同花顺式 multi-select 底部 sheet）：列该账号所有**非持仓**组（自选+自定义，排除持仓，复用 013 `useWatchlistGroups` EP1）为 2 列网格（组名+标的数）；`memberships` 命中组高亮+勾（**brand-soft #E8EEFD 底 + brand-500 ✓，不用红**）；点格 toggle → 加入（013 EP7）/ 移出（013 EP9 用 memberships itemId）；底「＋新建分组」（开 `create-group-dialog`）/「完成」+ `create-group-dialog.tsx`（居中 modal 薄壳：组名 `TextInput`+字符计数+取消/确定，**复用 013 `useWatchlistGroups().createGroup` EP2** + 文案，**不重构 013 内联建组行**，D11；建后缓存刷新→新组现于 sheet 可勾）。**无颜色/无快速建组/无分享**；**vitest**（memberships→勾选态派生 / toggle→加入·移出调用）+ typecheck/lint

---

## Phase 7: US7 — 分析 Tab（研报容器 V1 占位）（P2）

**Goal**：分析 Tab 空态占位指向独立研报 PRD（OQ2）。
**Independent Test**：切分析 Tab → 空态「研报功能即将上线」+ 指向研报 PRD（Playwright Web）。

- [X] T014 [US7] [P] [Mobile] `analysis-tab.tsx`（居中空态：doc 图标 +「研报功能即将上线」+「完整研报阅读能力将在独立版本中提供」指向独立研报 PRD，OQ2/FR-M09）+ typecheck/lint

---

## Phase 8: PR2 两层验证 + Polish（per sdd.md §V）

- [X] T015 [Mobile-E2E] `apps/mobile/e2e/stock-detail.spec.ts`（Playwright Expo Web，hermetic UI）：详情页渲染（顶 Tab 在最顶、报价属图表 Tab）/ 切 3 Tab（公司/分析 nav 显 condensed+asOf）/ 图表切周期·复权（断言 SVG `<rect>`/`<path>` 蜡烛重渲）/ 涨跌色 / 缺字段 `--` / **报价显示 asOf「数据截至 X · 收盘」（D10）** / **us 标的 gate 占位（D9）** / **底栏加·删自选窄义 toggle（仅自选组）** / **编辑分组 sheet（勾未勾组→加入、取消已勾组→移出、选中态 brand 蓝非红）** / **新建分组弹框（无色板）** / 预警·笔记 disabled toast；**mock 015 EP3/EP4 + 014 watchlist-status + 013 groups/items + 003 refresh 端点**
- [X] T016 [Contract-Smoke] `apps/mobile/e2e/contract-smoke/stock-detail.contract.ts`（node 层打 testcontainers 真 server，`nx run mobile:contract-smoke`）：登录 → 调 014 watchlist-status（inWatchlist=false, memberships=[]）→ 加自选「自选」组（013 EP7）→ watchlist-status inWatchlist=true + memberships 含自选组（itemId 对齐落库 id）→ 经编辑分组加入某自定义组（013 EP7）→ memberships +1（含两组、inWatchlist 仍 true）→ round-trip 读回 → 验真落库 + 契约对齐。**scope 决策（2026-06-03）**：015 EP3 详情 / EP4 bars 断言**从本 spec 移除** —— 014 server **零 marketdata 耦合（ADR-0048）**，且 contract-smoke harness 空 marketdata 库 + ctx 不暴露 DB，在 014 里种 015 数据会把契约焊进 015 schema（反 ADR-0048 边界 + 反 contract-smoke 薄壳设计）；015 detail/bars 的真后端契约（种 marketdata + 断 EP3/EP4）归 **015 自己的 contract-smoke**（已登记 015 tasks.md follow-up T016）。014 作消费方，orval 类型已保证契约形状，真数据正确性是 015 的事
- [X] T017 [Verify] PR2 gate：`nx affected -t lint typecheck test build --base=origin/main` 全绿 + **视觉 0 硬编码**（实现文件 grep 无 theme token 外 hex/rgb，含 quote token + 分位条 + 选中态，SC-M06）+ `nx run mobile:contract-smoke` 绿 + tasks.md `[X]` 同步无 drift

---

## Dependencies（完成顺序）

```text
PR1（Server，T001–T005）────────────────────────── merge ───┐
  T001 UC+DTO+单测 → T002 controller+module → T003 IT       │
  T002 → T004 contract regen → T005 PR1 gate                │
                                                            ▼
PR2（Mobile，消费 PR1 已 merge typed client）
  T006 hooks+route 骨架（前置）
    ├─ T007 [US3] screen 壳+nav+tabs ─ T008 [US3] 报价 header
    ├─ T009 [US4] kline-geometry ─ T010 [US4] K线+图表 Tab
    ├─ T011 [US5] 公司 Tab+分位
    ├─ T012 [US6] 底栏 ─ T013 [US6] 编辑分组 sheet+新建弹框（用 T004 watchlist-status hook）
    └─ T014 [US7] 分析空态
  全 US 完 → T015 Mobile-E2E + T016 Contract-Smoke → T017 PR2 gate
```

- **PR1 阻塞 PR2**：T004 regen 的 `watchlist-status` typed hook 是 T006/T011-T013 的输入（Constitution §V，PR1 先 merge）。
- **T006 阻塞全部 mobile US**（route + 数据 hook 是共享前置）。
- **US3/US4/US5/US7 互相独立**（不同文件，T006 后可并行）；**US6（T012/T013）依赖 T004 watchlist-status hook**。

## Parallel 示例

- PR1 内：T002 写完后 T003（IT）与 T004（contract）可并行不同关注点；T002 与 T001 的纯函数部分顺序绑（同 UC）。
- PR2 内（T006 后）：**T008[US3] / T009[US4] / T011[US5] / T014[US7] 可并行**（不同文件、不同 US、无交叉依赖）。T009（kline-geometry 纯函数）标 `[P]` 可与 US3/US5 并起。

## Implementation Strategy（MVP first）

1. **MVP = PR1 + US3 骨架**（T001–T008）：真后端 watchlist-status + 详情页 3-Tab 框架 + 报价 header（含 asOf）—— 可下钻看到一只股的 EOD 报价。
2. **增量**：US4 K线（数据可视化核心）→ US5 公司 Tab（理杏仁招牌分位）→ US6 底栏自选 + 编辑分组（V1 可闭环真实操作）→ US7 分析占位。
3. **收尾**：T015 hermetic UI e2e + T016 contract-smoke（正交两层）+ T017 PR2 gate。

**预估**：PR1 = 5 task（server）+ PR2 = 12 task（mobile）= **17**。复杂度全在 mobile（纯 SVG K线 + 富途 3-Tab 框架 + 公司分位 + 编辑分组 multi-select）；server 仅 1 只读端点。

---

**Tasks Version**: 1.0.0 | **Created**: 2026-06-03 | **基于** plan.md v1.0.0（含 clarify G1/G2/G3）| **ADR**: 0048（跨层不变性）/ 0043（扁平贫血）/ 0032（bounded context）/ 0038（错误契约）
