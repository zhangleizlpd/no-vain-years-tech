---
feature_id: 081-optionsdesk-trading-account-shell
spec_ref: ./spec.md
status: approved
created_at: '2026-09-13'
updated_at: '2026-09-13'
adr_refs: ['0062']
context7_verified: []
---

# Implementation Plan: 期权台交易账户页骨架（分市场布局）

<!--
This plan is PROSE-ONLY. The data model lives in schema.prisma (SoT); the API
surface lives in @nestjs/swagger decorators → OpenAPI (code-first SoT, per
docs/conventions/api-contract.md). Do NOT mirror either into this file — capture
DESIGN INTENT + decisions in prose under Architecture Notes instead.
-->

## Summary *(mandatory)*

期权台雷达题头新增第 4 个入口（钱包形图标）→ push 进入「交易账户」页：一级复用雷达市场页签（美股 / 港股），二级新建胶囊分段（持仓 / 订单 / 报表），三个分段均为「建设中」静态占位。技术路径：**纯 mobile**，新增一个期权台 stack 路由 + 进程内（非持久）zustand store 记住市场与分段 + 雷达题头布局修正以容纳第 4 个入口。**零 server、零契约、零 schema、零新依赖、零新 token**。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

（`zustand` 与 `react-native-svg` 均为既有依赖：`apps/mobile/package.json` 已含 `zustand ^5.0.13`；`radar-screen.tsx` 已 import `react-native-svg` 画 `GearGlyph` / `SearchGlyph`。进程内非持久 store 的仓内先例 = `apps/mobile/src/ideation/annotate-send-store.ts`。）

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

逐条：§I SDD 全步已走（specify → clarify → Mockup → plan；mockup baseline 与维护者裁决见 `design/handoff.md`）；§II 每 task 红→绿闭环（测试映射见下表，vitest 纯逻辑 + Playwright UI）；§III 30min–2h 粒度留给 /speckit-tasks；§IV 不涉 server bounded context；mobile 侧只在 `apps/mobile/src/optionsdesk/` 内新增文件，跨 feature 零 import（仅 `~/core` `~/ui` `~/theme`）；§V 纯 mobile 单 PR，无契约链。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: N/A —— 本片无新端点、无服务端改动。
- [x] **Mobile / Web**: golden-path flow walked in a real Expo simulator / Web browser session for each new user story (P1).
- [x] **Evidence**: planned —— Playwright hermetic `apps/mobile/e2e/optionsdesk-trading-account.spec.ts` 覆盖 US1 / US2 / US3 金路径；markets-OFF 直达链接走 `apps/mobile/e2e/markets-feature-gate.spec.ts` 的 `GATED_DEEPLINKS` 表；题头 4 入口在**真机窄屏**（Mate50 dev-client）人工核一次并截图贴 PR（web 视口宽松，布局陷阱须真机验，per `.claude/rules/mobile-impl-playbook.md`）。impl 完成后回填链接。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— 零新第三方包 / SDK / 工具（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **Evidence**: N/A — feature is mono-native（期权台 2026-08 诞生于 mono，无 meta-repo 前身）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0062 (optionsdesk ctx) | Open Questions 段为「无」；sunset_trigger #4「期权台扩到下单 / 持仓联动」—— 本片只建页面骨架与「建设中」占位，**不接任何持仓数据** | accepted-as-is | 该 trigger 由后续持仓同步片（master p2a）触发并写复审记录，本片不触碰 |

验证：`rg -l "Open Question|开放问题" docs/adr/` 列出 19 份含该段的 ADR，与本片交集仅 ADR-0062（本 ctx），其 Open Questions 段原文「无」（`docs/adr/0062-optionsdesk-bounded-context.md:124-126`）。

## Architecture Notes *(mandatory)*

### Testing Invariants（三条硬约束；第一条由 lefthook `no-bad-mocks` 机器守）

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，不写 `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。（本片纯 mobile，不新增任何 NestJS lifecycle 组件。）
- **MANDATORY INTEGRATION**: 用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。（本片无 server 面；mobile 侧对应「真交互」的层是 Playwright hermetic e2e。）
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，都有对应断言落点。本片 11 条分支全部为客户端分支 ⇒ 落 vitest（纯逻辑）或 Playwright（交互 / 渲染），映射见下方「测试映射」表，analyze 期逐条 grep 对账。mobile 测试分层：vitest **只测纯逻辑**，不做组件 render 测（`docs/conventions/testing.md` 不变量 4）。

### General Architecture Notes

> **Architecture paradigm (ADR-0043) — Flat + Anemic + Moat.** Bounded-context edges are enforced by eslint-plugin-boundaries and table ownership by `check-server-moat.ts`; the bullets below say what those gates expect.
> - **Flat Module**: all files live flatly in `apps/server/src/<module>/`; no `domain/`, `application/`, `infrastructure/` or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma); no Domain Classes or Entity Mappers.
> - **No Repositories**: no Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: no `tx.<otherTable>.*`. Cross-context access goes through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).
>
> （本片**不触碰 server**；上述范式照模板保留，mobile 侧对应纪律 = 文件平铺 `apps/mobile/src/optionsdesk/`、纯函数下沉 `*.rules.ts`、跨 feature 零 import。）

### Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：N/A —— 无服务端、无写路径。**不要**为本页发明任何请求、缓存或持久化。
- **安全**：无新数据面、无 PII；本页不 import 任何 `@nvy/api-client` hook（FR-008 的结构性保证，T003 e2e 在 `/api/**` 全 abort 下断言）。
- **前端（mobile）**：无表单；复用 `~/theme` token（className 禁字面量、单元素 ≤4 原子）；返回兜底用 `~/ui` 的 `makeHeaderBackOrParent`；react-native-web 丢弃 `accessibilityState` ⇒ 选中态**双通道编码**（底色 + 字重 / 短横条），e2e 以样式自比较断选中态（同 `radar-market-tabs.tsx:6-7` 体例）。→ `../../docs/conventions/mobile-impl-playbook.md`

### Feature-specific decisions（D 系列，implementer 必须遵守）

- **D0 · 代码命名 = `trading-account`**：UI 面（路由 / 屏 / 组件 / store / testID / copy key）一律以 clarify 定下的页面名「交易账户」的英文 `trading-account` 命名。**不用** `broker-account` —— 那个词在 mobile 已是 012 券商账户绑定（`apps/mobile/src/portfolio/broker-account-list-screen.tsx`），同词双义正是 clarify 要消除的混淆。后续数据层表名（`broker_*`）属持仓同步片的决定，与本片 UI 命名无关。
- **D1 · 路由**：新建 `apps/mobile/app/(app)/optionsdesk/trading-account.tsx`（薄路由文件，只 `return <TradingAccountScreen />`，同 `thermometer.tsx` 体例）；`src/optionsdesk/index.ts` 导出 `TradingAccountScreen`。在 `app/(app)/optionsdesk/_layout.tsx` **显式声明** `<Stack.Screen name="trading-account" options={{ headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/optionsdesk') }} />`（FR-010 深链返回落雷达；同 `thermometer` 声明，**不要**抄 `anchor-cold-start` 那种未声明 headerLeft 的写法 —— 它深链无返回兜底）。页面标题在屏内 `<Stack.Screen options={{ title: COPY.tradingAccount.title }} />` 设置（原生 navigator header，同 `thermometer-screen.tsx:46`）。
  - `optionsdesk-routes.ts` 新增 `OPTIONSDESK_TRADING_ACCOUNT_ROUTE = '/(app)/optionsdesk/trading-account' as const`（JSDoc 注明入口 = 雷达题头钱包图标）；`optionsdesk-routes.spec.ts` 的 `ALL_ROUTES` 表加入该常量并加一个 describe 块（该 spec 头注释要求新路由必须入表）。
- **D2 · markets 门控**：期权台 stack 已整体在 `MarketsRouteGuard` 内（`_layout.tsx:12`），`MARKETS_SURFACES` 已有 `route-stack` 一条覆盖（`markets-gate.tsx:59-63`；`optionsdesk-routes.ts:5-6,25` 明写同 stack 新路由无需单列）⇒ **不新增** `MARKETS_SURFACES` 条目（master plan §8 写的「登记 MARKETS_SURFACES」据此订正）。真正的强制点是 `e2e/markets-feature-gate.spec.ts` 的 `GATED_DEEPLINKS` 表（该文件头注释：stack 新路由**必须**入表）⇒ 加一条 `/optionsdesk/trading-account` 深链，并同步该文件头注释里的计数（现写「面数 8 但深链 14 条」「栈内七条路由」，`markets-feature-gate.spec.ts:17` 起）—— 计数不改不会红，但下一个读者会被旧数误导。
- **D3 · 雷达题头入口**：`radar-screen.tsx` 题头右排在 🔍 之后追加第 4 个 40×40 `Pressable`（`testID="optionsdesk-radar-trading-account-button"`，`accessibilityLabel` 取 copy），`onPress` → `router.push(OPTIONSDESK_TRADING_ACCOUNT_ROUTE)`。图标 `WalletGlyph` 屏内一次性 SVG（圆角矩形 + 小圆点，21×21 / viewBox 24 / `stroke={colors.ink.muted}` / `strokeWidth 1.7`，完全照本屏 `GearGlyph` 体例，**不**抽 `~/ui`，同 `radar-screen.tsx:373` 注释纪律）。次序 ⚙ 🌡 🔍 钱包（mockup 1a）。
- **D4 · 雷达题头布局修正（mockup 实测缺陷，不修即违反 FR-001；由 T005 e2e 的 boundingBox 断言拦）**：现题头左右两侧均为 `flex-1`（`radar-screen.tsx:84,88`），右侧 4 个 40px 热区（160px）超出等分半边 ⇒ 入口组向左溢出、遮挡标题（mockup 首版渲染实测 `titleHit=1`）。修法 = **右侧入口组改为按内容宽度**（去掉 `flex-1` 与 `justify-end`，保留 `flex-row`），左侧保持 `flex-1`；代价是标题离开正中（mockup 实测左移约 29px），**维护者已按 1a 接受**。**禁**缩小热区（SC-006）、**禁**把某个既有入口挪进抽屉（超出本片范围）。验收 = Playwright 在 360×800 视口量标题与 4 个按钮的 boundingBox 两两不相交且每个宽 ≥40 + 真机窄屏截图（Gate 0.1）。
- **D5 · 选择记忆 = 进程内 zustand store**：新建 `trading-account-store.ts`（`create()`，**不挂 `persist`**，先例 `ideation/annotate-send-store.ts`），状态 `{ market, segment }` + `selectMarket` / `selectSegment`。理由：push 屏返回即卸载，`useState`（雷达 `use-radar.ts:70-73` 的做法）只在不卸载的 tab 屏成立，照搬会让 FR-004「同次使用内记住」失效。模块级 store 天然满足「进程存活期间记住、重启回默认」，网页刷新视同重启（spec Assumptions）。**与雷达互相独立（FR-006）是结构性的**：本 store 与 `useRadar` 的 `useState` 是两份状态，本片不读写 `useRadar`（T006 e2e 臂 ③ 断言雷达选择不受影响）。
- **D6 · 值域与默认值单点**：新建 `trading-account.rules.ts`：`TRADING_ACCOUNT_SEGMENTS = ['positions', 'orders', 'reports'] as const`（显示顺序即 FR-003 顺序）、`type TradingAccountSegment`、`DEFAULT_TRADING_ACCOUNT_SELECTION = { market: RADAR_MARKETS[0], segment: 'positions' }`。市场值域**复用** `radar.rules.ts` 的 `RADAR_MARKETS` / `RadarMarket`（契约派生、双向编译期校验，`radar.rules.ts:28,52`）—— **禁**手写 `['us','hk']`。store 初值取 `DEFAULT_TRADING_ACCOUNT_SELECTION`。
- **D7 · 一级市场页签 = 复用 `RadarMarketTabs`**：给 `radar-market-tabs.tsx` 加可选 prop `testIdPrefix`（默认 `'optionsdesk-radar-market'`），把容器 / 页签 / 圆点三处 testID 改为由前缀拼出 —— **默认值下 radar 的三个 testID 逐字不变**（`optionsdesk-radar-market-tabs` / `-tab-${m}` / `-dot-${m}`），既有 radar e2e 零改动。交易账户页传 `testIdPrefix="optionsdesk-trading-account-market"`、`actionableMarkets={[]}`（本页无「可动」信号，FR-002 无圆点）。视觉以现实装为准（代码是真相源；mockup 画的 14px 字号不追）。
- **D8 · 二级胶囊分段 = 本地新建**：`trading-account-segments.tsx`（mockup 2b）：外层下沉底 `rounded-full` 轨道 + 三等分段；选中段 = `bg-surface` + `shadow-card` + `font-semibold text-ink`，未选 = 透明底 + `text-ink-muted`（底色 + 字重双通道）；每段 `accessibilityRole="tab"`、`testID="optionsdesk-trading-account-segment-${segment}"`。className 超 4 原子时拆嵌套 View，不写 inline style。**不上提 `~/ui`**（仓内已登记「统一等分 Tab 是独立重构」，`radar-market-tabs.tsx:8-9`）。
- **D9 · 占位与文案**：`optionsdesk-copy.ts` 新增 `tradingAccount` 段：`title`（交易账户）、`entryA11y`（进入交易账户）、`segments: Record<TradingAccountSegment, string>`（持仓 / 订单 / 报表）、`placeholder: Record<TradingAccountSegment, { title: string; body: string }>`，全部 `satisfies Record<…>`（穷举，漏段即编译红）。文案取 mockup 帧：「持仓 · 建设中 / 上线后在这里按市场查看你在券商的正股与期权持仓，并标注来源券商。」「订单 · 建设中 / 上线后在这里按市场查看委托与成交记录。」「报表 · 建设中 / 上线后在这里按市场查看持仓与交易的统计报表。」（master plan 里写的「即将上线」措辞以 spec + clarify 为准作废。）占位卡图形块用纯 View 几何（色块 / 短横条），**不画 SVG、不用 emoji**。占位与市场无关 —— 两个市场同一分段文案相同，只随分段变。
- **D10 · 屏组件**：`trading-account-screen.tsx`：`SafeAreaView`（edges 底部）→ `RadarMarketTabs`（D7）→ `TradingAccountSegments`（D8）→ 下沉底上的占位卡（D9）。从 store 读选择、调 `selectMarket` / `selectSegment`；**零** api-client import、**零** loading / error 分支（FR-008）。

### 测试映射（state_branches 11 条 → 落点；analyze 期逐条 grep 对账）

| # | state_branch（缩写） | 落点 |
|---|---|---|
| 1 | markets 开 → 题头有入口、点入进页 | Playwright `optionsdesk-trading-account.spec.ts`（点 `optionsdesk-radar-trading-account-button` → 标题「交易账户」可见） |
| 2 | markets 关 → 入口不出现、深链被拦 | `markets-feature-gate.spec.ts` `GATED_DEEPLINKS` 新增一条（markets-OFF 配置下深链被重定向）；入口不出现由 OFF 下期权台 tab 整体隐藏既有断言覆盖 |
| 3 | 首次进入 = 美股 · 持仓 | vitest `trading-account.rules.spec.ts`（默认值）+ Playwright（冷进入断两处选中态） |
| 4 | 同次使用离开再进 → 恢复 | Playwright（选 港股 · 订单 → header 返回 → 再点入口 → 仍 港股 · 订单） |
| 5 | 应用重开 → 回默认 | Playwright（`page.reload()` 后深链进入 → 美股 · 持仓） |
| 6 | 切市场 → 分段不变 | vitest `trading-account-store.spec.ts`（`selectMarket` 不改 segment）+ Playwright |
| 7 | 切分段 → 市场不变 | vitest `trading-account-store.spec.ts`（`selectSegment` 不改 market）+ Playwright |
| 8 | 任一组合 → 专属「建设中」占位、零「暂无 / 空仓 / 无数据」 | vitest（遍历 `placeholder` Record：三处 title 含「建设中」、body 两两互异、全部文案不含三类禁词）+ Playwright（逐段断标题文本） |
| 9 | 账户页切市场 → 雷达市场选择不变 | Playwright（雷达停美股 → 进页切港股 → 返回 → 雷达 `optionsdesk-radar-market-tab-us` 仍为选中样式） |
| 10 | 深链进入无上一页 → 返回落雷达 | Playwright（`page.goto` 深链 → header 返回按钮 → URL 回到期权台 tab；返回照 `optionsdesk-anchors-radar.spec.ts:576-586` 的 `headerBackLocator` / `headerBack` 写法 —— 那两个是该文件内局部函数、未导出，新 spec 内同样定义；**禁** `page.goBack`） |
| 11 | 服务端不可达 → 骨架与占位完整、无错误态 | Playwright（只 mock 会话必需的 `/me` + refresh，其余 `/api/**` 走 fixture 默认 abort → 深链进入并遍历 6 组合全部可见、页面无错误文案）。口径注：`/me` + refresh 是 App 级登录态前置，不属本页依赖；FR-008 / SC-003 的「服务端不可达」指本页相关的服务端调用 |

非分支项：SC-001（Playwright 金路径恰 3 次点击到达任一组合）· SC-006 / D4（360×800 视口 boundingBox 不相交 + 每按钮宽 ≥40）· D7 回归（radar 既有 e2e 不改一行仍全绿，证明 testID 默认值不变）· 路由表（`optionsdesk-routes.spec.ts` 新 describe）。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- 新增：`apps/mobile/app/(app)/optionsdesk/trading-account.tsx` · `src/optionsdesk/trading-account-screen.tsx` · `trading-account-segments.tsx` · `trading-account-store.ts` + `.spec.ts` · `trading-account.rules.ts` + `.spec.ts` · `apps/mobile/e2e/optionsdesk-trading-account.spec.ts`
- 触碰：`app/(app)/optionsdesk/_layout.tsx`（声明屏 + headerLeft）· `src/optionsdesk/index.ts`（导出）· `optionsdesk-routes.ts` + `.spec.ts`（常量 + 表）· `radar-screen.tsx`（第 4 入口 + `WalletGlyph` + 右侧布局修正）· `radar-market-tabs.tsx`（`testIdPrefix` prop）· `optionsdesk-copy.ts`（`tradingAccount` 段）· `e2e/markets-feature-gate.spec.ts`（`GATED_DEEPLINKS` 一条）

## Complexity Tracking

> Fill ONLY if Constitution Check reports violations that need justification.

无违反项。两条体例级注记：① D7 改动已 ship 组件 `RadarMarketTabs`，以「可选 prop + 默认值逐字保持原 testID」做向后兼容，radar 既有测试零改动为回归证据；② D4 改动雷达题头既有布局，是 FR-001 在第 4 入口下的必要修正（mockup 实测遮挡），代价（标题左移）已由维护者按 1a 接受。
