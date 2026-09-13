---
feature_id: 081-optionsdesk-trading-account-shell
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-13'
updated_at: '2026-09-13'
---

# Tasks: 期权台交易账户页骨架（分市场布局）

<!--
A task is a 30min–2h single-commit unit of work. Status semantics:
`- [ ]` = pending · `- [X]` = completed (flipped by /speckit-implement).
测试映射总表在 plan.md §测试映射（state_branches 11 条 → 落点）；analyze 期逐条 grep 对账。
纯 mobile feature：无 ## Server / ## API Client 段。
Clear 检查点批次建议：T001–T003 / T004–T005 / T006–T007 / T008–T009。
2026-09-13 analyze 修订：原 T003（RadarMarketTabs 前缀）无先红步，违反 Constitution §II ⇒ 并入 T003（路由骨架）由其 e2e 臂提供 RED；原雷达入口大任务按 S1 拆为 T005 / T006。
-->

## Mobile

- [X] T001 [Mobile] **值域 + 默认值 + 文案单点**（FR-002, FR-003, FR-004, FR-007; plan §D6/§D9; state_branches 3/8; US2/US3）：新建 `apps/mobile/src/optionsdesk/trading-account.rules.ts` —— `TRADING_ACCOUNT_SEGMENTS = ['positions', 'orders', 'reports'] as const`（顺序即 FR-003 显示序）、`type TradingAccountSegment`、`DEFAULT_TRADING_ACCOUNT_SELECTION = { market: RADAR_MARKETS[0], segment: 'positions' }`（市场值域**复用** `radar.rules.ts` 的 `RADAR_MARKETS`，🚨 禁手写 `['us','hk']`）；`optionsdesk-copy.ts` 新增 `tradingAccount` 段：`title` / `entryA11y` / `segments` / `placeholder`（后两者 `satisfies Record<TradingAccountSegment, …>`，文案逐字取 plan §D9）→ verify: 新建 `trading-account.rules.spec.ts` 先红后绿 —— ① 默认 = 美股 · 持仓 ② 分段顺序 = 持仓 / 订单 / 报表 ③ 三个 `placeholder.title` 均含「建设中」④ 三个 title 两两互异、三个 body 两两互异 ⑤ `tradingAccount` 段全部字符串不含「暂无」「空仓」「无数据」；变异留档：把 positions 的 body 改成「暂无持仓」⇒ 臂 ⑤ 红；`pnpm nx test mobile` 绿

- [X] T002 [Mobile] **进程内选择 store**（FR-004, FR-005, FR-006; plan §D5; state_branches 4/5/6/7; US1/US2）：新建 `apps/mobile/src/optionsdesk/trading-account-store.ts` —— zustand `create()`，**不挂 `persist`**（先例 `src/ideation/annotate-send-store.ts`），状态 `{ market, segment }` 初值取 `DEFAULT_TRADING_ACCOUNT_SELECTION`，动作 `selectMarket(m)` / `selectSegment(s)` 各只改自己那一维；🚨 本 store MUST NOT 读写 `useRadar`（FR-006 结构性保证）→ verify: 新建 `trading-account-store.spec.ts` 先红后绿（`beforeEach` 用 `setState(DEFAULT…)` 复位）—— ① 初值 = 默认 ② `selectMarket('hk')` 后 segment 不变 ③ `selectSegment('reports')` 后 market 不变 ④ 连续交替切换终态 = 最后一次选择；变异留档：`selectMarket` 顺手把 segment 复位为 positions ⇒ 臂 ② 红；`pnpm nx test mobile` 绿

- [X] T003 [Mobile] **路由 + 屏骨架 + 市场页签前缀 + 深链返回**（FR-002, FR-004, FR-008, FR-010; plan §D0/§D1/§D7/§D10; state_branches 3/10/11; US1）：
  - `radar-market-tabs.tsx` 新增可选 prop `testIdPrefix`（默认 `'optionsdesk-radar-market'`），容器 / 页签 / 圆点三处 testID 改由前缀拼出 —— 🚨 默认值下三个 testID 与现状**逐字相同**（`optionsdesk-radar-market-tabs` / `-tab-${m}` / `-dot-${m}`）；文件头注释补一行说明该 prop
  - `optionsdesk-routes.ts` 加 `OPTIONSDESK_TRADING_ACCOUNT_ROUTE = '/(app)/optionsdesk/trading-account' as const`（JSDoc：入口 = 雷达题头钱包图标）并入 `optionsdesk-routes.spec.ts` 的 `ALL_ROUTES` + 新 describe 块
  - 新建薄路由 `apps/mobile/app/(app)/optionsdesk/trading-account.tsx`（只渲染 `<TradingAccountScreen />`）；`app/(app)/optionsdesk/_layout.tsx` 显式声明 `<Stack.Screen name="trading-account" options={{ headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/optionsdesk') }} />`
  - 新建 `trading-account-screen.tsx` 骨架（屏内 `<Stack.Screen options={{ title }} />` + `RadarMarketTabs testIdPrefix="optionsdesk-trading-account-market" actionableMarkets={[]}` 接 store），由 `src/optionsdesk/index.ts` 导出；🚨 屏内**零** `@nvy/api-client` import、零 loading / error 分支
  - → verify: `optionsdesk-routes.spec.ts` 新臂先红后绿；新建 `apps/mobile/e2e/optionsdesk-trading-account.spec.ts`（`test` 从 `_support/fixtures` import，只 mock `/me` + refresh，其余 `/api/**` 走 fixture 默认 abort）三臂先红后绿 —— ① 深链进入 ⇒ 标题「交易账户」可见、`optionsdesk-trading-account-market-tab-us` 为选中样式（sb 3；**这条同时是 `testIdPrefix` 的 RED**）② 深链进入后 header 返回 ⇒ URL 回到期权台 tab（sb 10；返回照 `optionsdesk-anchors-radar.spec.ts:576-586` 的 `headerBackLocator` / `headerBack` 写法在本文件内定义 —— 那两个是该文件局部函数、未导出；禁 `page.goBack`）③ 切到港股 ⇒ 港股选中样式、页面无任何错误文案（sb 11 前半）；回归证据：`git grep -n "optionsdesk-radar-market-" apps/mobile/e2e` 命中的既有断言**零修改**且 `optionsdesk-anchors-radar.spec.ts` 全绿；变异留档：屏内不传 `testIdPrefix`（落回默认前缀）⇒ 臂 ① 红

- [X] T004 [Mobile] **胶囊分段 + 三类占位**（FR-003, FR-005, FR-007, FR-008; plan §D8/§D9/§D10; state_branches 6/7/8/11; Edge「不出现两个同时选中」; US2/US3）：新建 `trading-account-segments.tsx`（mockup 2b：下沉底 `rounded-full` 轨道 + 三等分段；选中 = `bg-surface` + `shadow-card` + `font-semibold text-ink`，未选 = 透明 + `text-ink-muted`，**底色 + 字重双通道**；每段 `accessibilityRole="tab"` + `testID="optionsdesk-trading-account-segment-${segment}"`；className 超 4 原子拆嵌套 View，禁 inline style，不上提 `~/ui`）；`trading-account-screen.tsx` 接入分段 + 下沉底上的占位卡（`placeholder[segment]` 标题 + 正文，图形块纯 View 几何，不画 SVG、不用 emoji）→ verify: T003 的 e2e 续四臂先红后绿 —— ① 默认「持仓」段选中样式 + 标题「持仓 · 建设中」② 选「订单」后切港股 ⇒ 仍「订单」+「订单 · 建设中」，且**市场页签与分段各恰有一个**为选中样式（sb 6 / Edge）③ 选港股后切「报表」⇒ 港股仍选中，市场与分段**各恰一个**选中（sb 7 / Edge）④ 遍历 2 市场 × 3 分段共 6 组合（`/api/**` 仍全 abort）⇒ 每组标题正确、页面无「暂无 / 空仓 / 无数据」与任何错误文案（sb 8 / sb 11 后半 / SC-002 / SC-003）；变异留档：分段组件切段时调 `selectMarket(DEFAULT)` ⇒ 臂 ② 红

- [X] T005 [Mobile] **雷达题头第 4 入口 + 布局修正**（FR-001; plan §D3/§D4; state_branches 1; SC-001/SC-006; US1）：`radar-screen.tsx` 题头右排 🔍 之后加 40×40 `Pressable`（`testID="optionsdesk-radar-trading-account-button"`，`accessibilityLabel` = `tradingAccount.entryA11y`，`router.push(OPTIONSDESK_TRADING_ACCOUNT_ROUTE)`）+ 屏内 `WalletGlyph`（圆角矩形 + 小圆点，完全照本屏 `GearGlyph` 的尺寸 / stroke 体例）；🚨 右侧入口组容器去掉 `flex-1` 与 `justify-end`（保留 `flex-row`），左侧保持 `flex-1` —— 不改会让入口组向左溢出遮挡标题（mockup 实测）；禁缩小热区、禁挪动既有入口 → verify: T003 的 e2e 续两臂先红后绿（进雷达需最小 radar 端点 mock，照 `optionsdesk-anchors-radar.spec.ts:247` `installOptionsdeskMock` 的形态在本文件内最小复刻）—— ① 雷达点钱包入口 ⇒ 进入交易账户页（sb 1），且从雷达起**恰 3 次点击**到达「港股 · 报表」（SC-001）② 视口 360×800：题头标题与 4 个入口按钮的 boundingBox 两两不相交、每个按钮宽 ≥40（FR-001 / SC-006）；`optionsdesk-anchors-radar.spec.ts` 仍全绿；变异留档：右侧容器恢复 `flex-1` ⇒ 臂 ② 红

- [X] T006 [Mobile] **离开再进记忆 / 刷新回默认 / 与雷达互不影响**（FR-004, FR-006; plan §D5; state_branches 4/5/9; SC-004/SC-005; US1）：不改实现代码（行为由 T002 store + T003 路由承担），补齐导航层证据 → verify: T003 的 e2e 续三臂先红后绿（先写断言、在 store 被临时换成组件内 `useState` 的变异下看到红）—— ① 选「港股 · 订单」→ 返回雷达 → 再点入口 ⇒ 仍「港股 · 订单」（sb 4 / SC-005）② `page.reload()` 后深链进入 ⇒ 回默认「美股 · 持仓」（sb 5）③ 雷达停美股 → 进页切港股 → 返回 ⇒ 雷达 `optionsdesk-radar-market-tab-us` 仍为选中样式（sb 9 / SC-004）；变异留档：`trading-account-screen.tsx` 临时改用组件内 `useState` 代替 store ⇒ 臂 ① 红（push 屏卸载即丢），恢复后绿

- [X] T007 [P] [Mobile-E2E] **markets-OFF 深链门控**（FR-009; plan §D2; state_branches 2）：`apps/mobile/e2e/markets-feature-gate.spec.ts` 的 `GATED_DEEPLINKS` 表加 `/optionsdesk/trading-account`（期望重定向到 `/profile`，note 注明 081 交易账户页挂在 optionsdesk 栈下、门控靠继承）；同步文件头注释里的面数 / 深链条数 / 栈内路由条数（现写「面数 8 但深链 14 条」「栈内七条路由」，`markets-feature-gate.spec.ts:17` 起）；**不新增** `MARKETS_SURFACES` 条目（plan §D2 取证）→ verify: `nx run mobile:e2e-public` 全绿；变异留档：临时去掉 `app/(app)/optionsdesk/_layout.tsx` 的 `MarketsRouteGuard` 包裹 ⇒ 新条目红（未被重定向），恢复后绿（仅依赖 T003 的路由存在，可与 T004–T006 并行）

## E2E / Gate

- [ ] T008 [Gate] **真机窄屏核题头 + 系统返回手势**（FR-001, FR-004, SC-006; plan Gate 0.1 / §D4; Edge「系统返回手势离开」）：Mate50 dev-client（`run-local-env` 真机模式）打开期权台雷达，确认 ⚙ 🌡 🔍 钱包四入口与标题互不遮挡、各自可单独点中；点钱包进入交易账户页，选「港股 · 订单」后用**安卓系统返回手势**离开，再点入口 ⇒ 仍「港股 · 订单」→ verify: 真机截图三张（雷达题头 / 交易账户页「港股 · 报表」/ 手势返回再进后的「港股 · 订单」）贴 PR body；若真机出现遮挡、误触或记忆丢失，停下回 plan 重议，不在 impl 内自行改方案

- [ ] T009 [Gate] **PR 门 + 覆盖对账 + frontmatter 收口**（SC-001–SC-006）：`pnpm nx affected -t lint,typecheck,test,build,runtime-smoke --base=origin/main` 全绿（按终态串判定，不只看 exit code）+ `scripts/checks/*.ts` 治理脚本全扫绿（含 `check-test-size.ts` / `check-spec-frontmatters.ts`）；spec `state_branches` 11 条、Edge Cases 5 条、SC-001–SC-006 对照 plan §测试映射逐条 grep 到具体 `it()` / `test()` 或真机截图，覆盖表贴 PR body；spec frontmatter `status → implemented`、tasks frontmatter `status → completed`、`updated_at` 刷新；PR body 按模板全段复刻，hard-gate 三 checkbox 落实 → verify: 全绿证据串 + 覆盖表贴 PR body
