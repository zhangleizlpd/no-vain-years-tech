---
feature_id: 083-optionsdesk-trading-account-positions
spec_ref: ./spec.md
status: approved
created_at: '2026-09-15'
updated_at: '2026-09-17'
adr_refs: ['0040', '0043', '0053', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 期权台交易账户页 · 持仓展示与下钻

<!--
This plan is PROSE-ONLY. The data model lives in schema.prisma (SoT); the API
surface lives in @nestjs/swagger decorators → OpenAPI (code-first SoT, per
docs/conventions/api-contract.md). Do NOT mirror either into this file — capture
DESIGN INTENT + decisions in prose under Architecture Notes instead.
-->

## Summary *(mandatory)*

把 082 已同步的券商持仓 / 成交 / 订单只读展示到交易账户页：optionsdesk 新增 4 个读接口（持仓列表、持仓详情、订单详情、新锚券商历史补齐状态），分组 / 排序 / 持仓批次 / 陈旧判定落为纯函数规则；mobile 替换持仓分段占位、新增持仓详情与订单详情两个 push 屏、冷启动结局页加一行券商历史状态。**零新依赖、零 schema 变更、零新 token**；跨端单 PR（server + api-client regen + mobile + 两层验证）。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**显式 no-op 声明**：下拉重读用 RN 内置 `RefreshControl`（先例 `apps/mobile/src/optionsdesk/radar-screen.tsx:281`）；聚焦重取用 expo-router `useFocusEffect`（先例 `apps/mobile/src/portfolio/watchlist-main-screen.tsx:64-67`）；回前台重取用 RN 内置 `AppState`（既有 import 先例 `app-shell-drawer.tsx:78-79`）；分组列表用 RN `SectionList`（先例 `portfolio/trade-history-screen.tsx:149-170`）。均不新增包。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles; the one sunset trigger that fires (ADR-0043 #1) is classified in Gate 0.4.

| 原则 | 本片如何满足 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify（2 个 Session 共 4 问）→ Mockup（`design/handoff.md`，维护者裁决「数字用万缩写」）→ 本 plan；plan 前按维护者要求先做 9 项验证（Architecture Notes「plan 前验证」） |
| II. Test-First TDD | 每 task 红→绿；47 条 `state_branches` 逐条映射落点（测试映射表）；关键判据配反例臂 |
| III. Atomic Task | tasks 阶段按「规则纯函数 / 读接口 / DTO + regen / mobile 列表 / 详情屏 / 冷启动行 / 验证与治理」切片 |
| IV. Module Boundary | server 文件平铺 `apps/server/src/optionsdesk/`；只读自有 `broker_*` / `anchor` 表；跨 ctx 只有既有 `resolveInstrumentNames`（内含 `CROSS-CONTEXT-READ`）与 `TRADING_CALENDAR_PORT`（`CROSS-CONTEXT-SYNC`）；`marketdata/session-clock.ts` 新增一个薄导出（D13，同 082 `exchangeClock` 先例）；零跨 ctx 写 |
| V. 类型同步链 | 新增 4 个 GET 端点 ⇒ `nx run server:export-openapi` → `nx affected -t generate` → mobile 消费，同 PR；mobile 两层验证 = hermetic e2e + 契约冒烟 |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 4 个新端点各由 Medium IT 覆盖（真 PG 隔离库 + 经 HTTP 注入走 `JwtAuthGuard`，账号隔离必须在这一层证明）；契约冒烟用生成的 `@nvy/api-client` 打 testcontainers 真 server；门禁 task 跑 `nx affected` 全量门（含 `server:runtime-smoke`）覆盖 `AppModule` 装配。
- [x] **Mobile / Web**: Playwright hermetic `apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts` 覆盖 US1–US4 金路径；**真机窄屏（Mate50 dev-client）人工核一次**：数字列「万」缩写后不溢出、组头折叠、下拉重读、回前台重读（web 视口宽松且 AppState 在 web 上的触发与真机不同，per `.claude/rules/mobile-impl-playbook.md`）。
- [x] **Evidence**: planned —— 由 tasks 的 `[Server-IT]` / `[Contract-Smoke]` / `[Mobile-E2E]` / `[Gate]` task 落证据；本 gate 在 plan 阶段是「已规划」而非「已完成」。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— 零新第三方包 / SDK / 工具（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] **Evidence**: N/A — mono-native。`rg -l 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk apps/mobile/src/optionsdesk apps/mobile/src/format` → 零命中（2026-09-15 plan 起草时执行）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | sunset trigger / Open Question | Classification | 说明 |
|---|---|---|---|
| ADR-0043 | #1「单个 bounded context use case 数 > 20（扁平单层开始失焦，需内部再分组）」 | **fired · mitigated（维护者 2026-09-15 plan 审批确认）** | optionsdesk 现 20 个（锚与许愿单 14 / 雷达·链报告·腿·详情·温度计 5 / 券商同步 1），本片 +4 ⇒ 24，越线。**缓解 = 文件名分组，不建子目录**：本片 4 个 use case 全部以 `broker` 为名词段（`list-broker-positions` / `get-broker-position` / `get-broker-order` / `list-broker-backfill-runs`），与 082 的 `broker-*.rules.ts` / `sync-broker-account` 同组，`rg -l broker apps/server/src/optionsdesk/*.usecase.ts` 即可列出券商镜像组；在 ADR-0043 追加复审记录写明分组现状与下次复审线 = **optionsdesk use case 达 30 个**（维护者 2026-09-15 定；ADR-0062 的拆出条件另由该 ADR 自己的 sunset 管，不并入本复审线）。**否决的替代**：① 建 `optionsdesk/broker/` 子目录 —— 直接违反 ADR-0043 §1 扁平规则，需先 amend ADR；② 把 4 个读接口并进一个 use case 规避计数 —— 为指标改结构，读接口之间无共享流程；③ 现在把券商镜像拆成独立 ctx —— ADR-0062 的拆出条件（范围开关打开且出现期权台外读取方，或接入第二家券商）均未满足 |
| ADR-0062 | #4「期权台扩到下单 / 持仓联动」 | accepted-as-is（082 已 fired · mitigated） | 本片只为已登记的「期权台范围内券商镜像」加读取面，读取方仍是期权台本身，不产生新的拆出条件 |
| ADR-0053 | 跨 ctx 纯函数 import 细分边 | accepted-as-is | 只 import `marketdata/session-clock.ts`（非 `*.rules.ts`，082 同路径先例）；`daysToExpiry` 在 `marketdata/trading-day-gate.ts`（非 rules 文件） |
| ADR-0066 | 时间语义 | accepted-as-is | 「交易所今天」`exchangeCalendarDate`、到期 `daysToExpiry`、上一交易日 `TradingCalendarPort.previousTradingDay`，均为 §0 速查表既有函数；新增的交易所当地时间串导出在 `session-clock.ts` 内（Rule B 合规，D13） |

- **Evidence**: use case 数 = `ls apps/server/src/optionsdesk/*.usecase.ts | wc -l` → 20（2026-09-15）；ADR-0043 trigger 原文 `docs/adr/0043-server-flat-module-paradigm.md:5-6`；ADR-0062 #4 状态行 `docs/adr/0062-optionsdesk-bounded-context.md:10`。

## Architecture Notes *(mandatory)*

### Testing Invariants（三条硬约束；第一条由 lefthook `no-bad-mocks` 机器守）

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，不写 `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。（本片不新增此类组件；账号隔离依赖既有 `JwtAuthGuard`，只能经 HTTP 注入证明。）
- **MANDATORY INTEGRATION**: 读接口 IT 用 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` + `setupIsolatedDb`（`apps/server/test/_support/isolated-db.ts`）装配并经 HTTP 注入调用 controller（带真 JWT），直接 prisma 种 `broker_*` / `anchor` 行；**不 mock** `PrismaService` / 交易日历 port 以外的任何东西（日历 port 可按既有 IT 体例注入 test double 固定交易日）。
- **EXHAUSTIVE BRANCHING**: spec 的 **47 条** `state_branches` 每条都有对应断言落点（下方测试映射表，analyze 期逐条 grep 对账）。纯判定分支落 Small `*.rules.spec.ts`；**凡涉及读库结果**的分支（账号隔离 / 未归类计数 / 同步时刻取值 / 404 / 订单过滤 / 补齐状态）都要在 Medium IT 再有一条 `it()`。mobile vitest **只测纯逻辑**，不做组件 render 测（`docs/conventions/testing.md` 不变量 4）。

**本片额外的反例臂（都是「不写就永远不会红」的形态）：**

- **FIFO 要能区分 LIFO**：构造「A 开 2 张 @ 高价、B 开 1 张 @ 低价、买回 1 张」，断言 A 剩 1 / B 剩 1 且 A 成本不变。只测单批次或整批平仓的用例对 FIFO / LIFO 两种实现都绿。
- **订单过滤要喂「开仓单下单早于开仓时间」**：开仓订单 `vendorCreatedAt` 早于 `openedAt`、`vendorUpdatedAt` 晚于它，断言该订单**在**列表里。plan 前验证 V2 已证实真实数据里开仓单全部是这个形态，按下单时间过滤会把它们全滤掉而不报错。
- **到期判定要跨北京日界**：美股期权到期日 = 美东今天、但北京时间已是次日的时刻，断言**不**标已到期；到期日 = 美东昨天断言标。只用北京白天时刻测，对「按北京日期判」的错误实现同样绿。
- **陈旧宽限要两侧夹逼**：昨天时点已成功同步、今天尚未成功，当前 = 今天时点 + 59 分钟 → 不陈旧（判定时点仍是昨天）；+ 60 分钟 → 陈旧（判定时点切到今天）。再加「今天非交易日 → 以上一交易日时点为准」一例。
- **账号隔离要用「存在的他人 id」**：以账号 B 请求账号 A 的持仓 id / 订单 id，断言与请求不存在的 id **响应完全相同**（状态码与响应体）。只测不存在 id 对「先查后比账号」的实现同样绿。
- **同步时刻要喂「只有补齐、没有对账」**：某市场只有一条 `target='us:XXX'` 的成功补齐记录（`market` 列为空，V5），断言美股 `syncedAt` = 其 `finishedAt`、港股仍为 null。只按 `market` 列筛的实现会让美股误判「尚未同步」。
- **失败不清空要用「先成功后失败」**：先一条成功对账、再一条失败对账，断言 `syncedAt` 取成功那条、列表照常。
- **万缩写边界**：`9999.99` → `9,999.99`、`10000` → `1.00万`、`-10000` → `-1.00万`、`99999999` → `10000.00万` 与 `100000000` → `1.00亿` 各一例。
- **陈旧要覆盖「昨天也没成功」**：最近成功同步在前天、今天刚过对账时点 10 分钟（仍在宽限内）⇒ **陈旧**。只按「今天时点 + 宽限」判的实现会判不陈旧（analyze H5）。
- **日历不可判定不许猜**：`previousTradingDay` 返回 null ⇒ `stale=false` 且有 warn 日志；另喂一个「按前一日历日猜会得出陈旧」的输入，断言仍不陈旧（analyze H6）。
- **重读失败不许吞掉已显示数据**：列表先成功加载，再让下一次请求失败，断言列表行仍在且出现「刷新失败」提示；再让详情重读返回 404，断言「持仓已不存在」替换了旧数据（analyze H1）。

### General Architecture Notes

> **Architecture paradigm (ADR-0043) — Flat + Anemic + Moat.** Bounded-context edges are enforced by eslint-plugin-boundaries and table ownership by `check-server-moat.ts`; the bullets below say what those gates expect.
> - **Flat Module**: all files live flatly in `apps/server/src/optionsdesk/`; no `domain/`, `application/`, `infrastructure/` or `web/` subdirectories —— 包括「为了分组」而建的 `broker/`（Gate 0.4）。
> - **Anemic Data & Zero-Class**: data equals raw Prisma rows; no Domain Classes or Entity Mappers.
> - **No Repositories**: no Repository interfaces/adapters for your own tables. Inject `PrismaService` directly. Business invariants go in `*.rules.ts`.
> - **The Moat**: no `tx.<otherTable>.*`. 本片只读自有 `broker_*` / `anchor` 表；正股名称走既有 `resolveInstrumentNames`（`optionsdesk/instrument-name.ts:39-62`，内部已挂 `CROSS-CONTEXT-READ`）；**不**读 `option_contract`（乘数改从订单推，D10）。

### Impl Guardrails（仅留本 feature 适用条目）

1. **只读**：本片零写路径、零事务；不留任何下单 / 改单 / 撤单 / 平仓入口（FR-019）。
2. **账号隔离在查询条件里**：所有 `broker_*` 查询 `where` 带 `accountId: req.user.accountId`（`@Req() req: { user: AuthenticatedUser }`，先例 `alert/alerts.controller.ts:15,139,168`；`AuthenticatedUser` 从 `account/jwt-auth.guard.ts:6` import —— `auth/jwt-access.guard.ts:4` 另有同名类型，不是 optionsdesk 所用 guard 的）；按 id 读一律 `findFirst({ where: { id, accountId } })`，不用 `findUnique` 后在代码里比账号（两条路径的响应会不一样，泄露 id 存在性）。
3. **BigInt / Decimal 出边界一律 string**；nullable 标量 `@ApiProperty` 显式 `type`（`scripts/checks/check-api-property-nullable.ts` 强制，否则 orval 生成 `{[k]: unknown} | null`）。
4. **时间只在服务端换算**：交易所当地时间串只经 D13 的 `exchangeLocalDateTime`；不在 optionsdesk 裸用 `Intl.DateTimeFormat`（`check-time-semantics` Rule B）；🚫 mobile 做任何时区换算。
5. **fixture 只用合成值**：代号 `ZQX` / `ZQY` / `ZQR`（082 已核不撞 instrument 表）、港股 `088xx`；不用真实账户 / 持仓 / 成交 / 订单数据（`check-identifier-boundary.ts` L2 私有清单会拦）。服务端 `apps/server/src/optionsdesk/**`（**含 spec**）的数字字面量避开 `0.8` / `0.6` / `1.2` 子串（`check-optionsdesk-rule-constants.ts` #1，082 T012 实撞）。
6. **API 同步链两步分别跑**：`nx run server:export-openapi` → `nx affected -t generate`；漏第一步会静默拿陈旧 json（`docs/conventions/api-contract.md:56-63`）。
7. **mobile hook 依赖**：`useFocusEffect` / `AppState` 回调只依赖 `refetch`（引用稳定），🚫 整个 `useQuery` 结果对象进依赖（自激请求风暴，`.claude/rules/mobile-impl-playbook.md`）。

---

### plan 前验证（2026-09-15，维护者要求「不确定的先 POC 再落 plan」）

数据源 = 082 POC-1 私有原始输出（维护者 2026-09-13 采集，`docs/private/evidence/broker-account-poc/`；本机只做计数统计，数字留私有 p3 子 plan）+ 082 已合代码。

| # | 不确定点 | 结论（定性） | 落点 |
|---|---|---|---|
| V0a | 平均成本口径的盈亏字段 | `raw.unrealized_pl` 与 `raw.pl_ratio_avg_cost` 逐行符合（现价 − 平均成本）口径；`pl_val` / `pl_ratio` 是摊薄口径 | D6 |
| V0b | 期权乘数来源 | 由持仓反推（市值 ÷ 现价 ÷ 数量）存在非整数行，**不可用**；有价订单 `amount ÷（数量 × 价格）` 全部为整数（期权为乘数、正股为 1） | D10 / D11 |
| V1 | 批次能否链到开仓订单行 | 当前持仓周期内成交的订单号全部能在订单表找到 | D10 |
| V2 | 订单列表过滤口径 | 开仓订单**全部**早于开仓时间下单、晚于开仓时间更新 ⇒ 只能按最后更新时间过滤 | D9 |
| V3 | 订单类型文案 | 维护者截图中「限价单」那张单的 API 值为 `NORMAL`；样本值域仅 `NORMAL` | D11 |
| V4 | 持仓 id 是否稳定 | 082 同步对仍存在的持仓原地 `updateMany`，只删被移除的（`sync-broker-account.usecase.ts:395-404`） | D9 |
| V5 | 市场同步时刻的取法 | 补齐记录不写 `market`（`broker-history-backfill.subscriber.ts:76-86`），执行时从 `target` 推（`broker-account.scheduler.ts:168`） | D7 |
| V6 | 冷启动页 ticker 与补齐 `target` 同形 | 两者取自同一事件载荷的 `ticker`（`broker-history-backfill.subscriber.ts:82`、`marketdata/anchor-cold-start.subscriber.ts:55`） | D12 |
| V7 | 治理脚本约束 | 服务端 #1 子串扫描含 spec；移动端只受 #8（与本片无关） | Guardrail 5 |
| V8 | 移动端交易所时区显示 | 零先例（`~/format/as-of.ts` 按设备本地时区）；服务端 `session-clock.ts:97-112` 已有 `Intl` 时区换算 | D13 |
| V9 | 订单枚举值域 | SDK 常量：订单状态 17 值、交易方向 5 值、订单类型 18 值（futu-shim venv `futu/common/constant.py`） | D11 |

**未验证、不卡 plan**：开盘前同步时券商报告的现价是否等于上一交易日收盘价 —— 只影响 SC-001 的比对窗口（spec Assumptions），SC-001 验收时一并核。📌 2026-09-17 amend：已由 T025 第二、三轮核实 —— 美股与港股期权成立；港股正股在原对账时点 09:05 不成立（开市前时段内随竞价变动），且影响的不只是比对窗口 ⇒ 082 港股对账时点改为 08:40（082 FR-010 amend），结论见 spec Assumptions。

---

#### D0 — 命名

- **server 数据层 = `broker`**（沿 082 表名）：use case `list-broker-positions` / `get-broker-position` / `get-broker-order` / `list-broker-backfill-runs`；规则 `broker-position-display.rules.ts` / `broker-lots.rules.ts` / `broker-freshness.rules.ts`；controller `broker-account.controller.ts`；DTO `broker-account.dto.ts`。
- **mobile UI 面 = `trading-account`**（沿 081 D0，`broker-account` 已被 012 占用）：屏 `trading-account-positions-*` / `trading-account-position-screen` / `trading-account-order-screen`，testID 前缀 `optionsdesk-trading-account-`。

#### D1 — 读接口

新 controller `broker-account.controller.ts`，与 `optionsdesk.controller.ts` 同 guard 与限频：`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `optionsdesk-read-account`（`optionsdesk.controller.ts:165,185-217`）；在 `optionsdesk.module.ts` 登记 controller 与 4 个 use case。

| 端点 | 用途 | 未命中 |
|---|---|---|
| `GET /api/v1/optionsdesk/broker-positions?market=us\|hk` | 持仓列表（D3–D8） | — |
| `GET /api/v1/optionsdesk/broker-positions/:id` | 持仓详情：汇总 + 批次（期权）+ 订单列表（D9–D10） | 404 |
| `GET /api/v1/optionsdesk/broker-orders/:id` | 订单详情（D11） | 404 |
| `GET /api/v1/optionsdesk/broker-backfill-runs?tickers=` | 新锚券商历史补齐状态（D12） | — |

- 404 形态照 optionsdesk 既有 not-found 体例（`get-anchor.usecase.ts:36` `NotFoundException('ANCHOR_NOT_FOUND')`，implementer 读其 controller 映射后照抄）；持仓详情与订单详情各自的 **不存在 / 属于他人 / 正股未归类或不在锚集** 三种情况响应逐字节相同（FR-001、FR-002、FR-020）。订单的正股取 `broker_order.underlyingTicker`（082 同步时已判定）。
- `tickers` 逗号分隔，≤ 50 个，每个须匹配锚 ticker 形态 `^(us|hk):`，否则 400。

#### D2 — 账号与连接

- 账号 = `req.user.accountId`；连接 = 该账号的全部 `broker_connection` 行。`hasConnection = 连接数 > 0`，`brokerCount = 连接数`（FR-012：> 1 才显示连接标签，由 mobile 判）。每行带 `connectionLabel` = 该连接的人读标签（082 连接行的 `label` 列），同一券商的多个连接靠它区分（维护者 2026-09-15 analyze Q2）；不用 `brokerCode` 当标签（同券商两行会完全相同）。
- 锚集 = `anchor` 表全部行的 ticker（含 `excluded`；锚全局，master §12-A4），每次请求读一次。

#### D3 — 列表过滤（`broker-position-display.rules.ts`）

对该账号该市场的全部持仓：`underlyingTicker` 为 null ⇒ 计入 `unresolvedCount`、不进列表；非 null 且 ∈ 锚集 ⇒ 进列表；非 null 且 ∉ 锚集 ⇒ 丢弃（FR-001 / FR-011）。**不复用** `broker-scope.rules.ts` 的 `inBrokerScope`（T001 变异 b 钉住） —— 它对未解析行恒返回 true（同步侧「不丢弃」语义，`broker-scope.rules.ts:32-41`），展示侧的语义相反；且展示恒按「只锚标的」，与 `BROKER_SYNC_SCOPE` 无关。

#### D4 — 分组、组值与排序（同一规则文件，全序）

- **分组键** = `underlyingTicker`；每个分组下挂该正股的全部行（多连接各自成行，不合并）。组内行数 ≥ 2 才出组头由 mobile 按 `rows.length` 判（FR-004）。
- **组值**：`groupMarketValue` = 组内 `marketValue` 非空者带符号求和，全部为空 ⇒ null；`groupUnrealizedPl` 同口径（Decimal 运算）。
- **组内排序**：正股行在前、期权行在后；每段内 `openedAt` 升序、null 排段尾 → 代码 → 连接标签 `connectionLabel` → 行 id 兜底。（订正 master §8「→ dealId」：主列表行是合约级汇总，没有成交号可比。）
- **跨组排序**：`|groupMarketValue|` 降序，null 排末 → 正股代码升序（FR-006）。组值恰为 0 按 0 参与排序、不视为无效。
- 复杂度注释：分组 O(n)、排序 O(n log n)。

#### D5 — 组头正股现价

组内有正股行 ⇒ 取组内排序第一的正股行 `currentPrice`；否则取该锚的现价，走既有 `resolveAnchorSpot`（`intraday-spot.rules.ts:110-121`，读法同 `list-anchors.usecase.ts:115-123`）；仍为 null ⇒ 返回 null、mobile 留空（FR-005）。列表里的正股都有锚行（D3 保证），不需要跨 ctx 读行情。

#### D6 — 行字段与口径

- 名称：正股行 = `resolveInstrumentNames` 批量取名，取不到回落 `raw.stock_name`，再回落代码；期权行返回正股名（同一批量结果）+ 由 `parseBrokerCode`（`broker-code.rules.ts:67-88`）解析出的 `{ expiry, right, strike }`。港股「购 / 沽」、美股「Call / Put」、到期日 6 位、行权价去尾零由 **mobile 规则函数**拼（D14）。
- 数量 / 市值 / 现价 / 平均成本取 082 独立列（`qty` / `marketValue` / `currentPrice` / `averageCost`）。
- 持仓盈亏金额 = `raw.unrealized_pl`，比例 = `raw.pl_ratio_avg_cost`（V0a）；解析容忍缺失与 `N/A`（同 adapter 的 `VENDOR_NA` 哨兵，`futu-broker-account.adapter.ts:60-61`）→ null。代码注释写 `EVIDENCE:` 指 V0a（定性 + 私有证据路径，**不写条数**）。
- 已到期 `expired`：期权行 `daysToExpiry({ expiry, now, exchange: market }) < 0`（`marketdata/trading-day-gate.ts:139`，到期日 = 0 不算已到期）；正股恒 false（FR-021）。

#### D7 — 同步时刻与陈旧（`broker-freshness.rules.ts`）

- **最近成功同步时刻**（V5）= 该账号成功（`succeeded`）同步记录中，满足「`kind='reconcile'` ∧ `market=m`」或「`kind='backfill'` ∧（`target='*'` ∨ `target` 以 `m:` 开头）」者的 `finishedAt` 最大值；无 ⇒ null（→ mobile「尚未同步」）。
- **陈旧**（纯函数，入参全部预先算好）：输入 `{ slotMinutes, nowLocal: exchangeClock(m, now), todayStatus, previousTradingDate, lastSyncLocal: exchangeClock(m, syncedAt) }`。
  - **判定时点** = 最近一个**已过宽限**的对账时点：今天不是 `non-trading` 且 `nowLocal.minutesOfDay ≥ slotMinutes + 60` ⇒ 今天的时点；否则 ⇒ 上一交易日的时点（`TradingCalendarPort.previousTradingDay(m, today)`，只在需要时才调）。`unknown` 按交易日处理（同 082）。
  - 陈旧 ⇔ `lastSyncLocal` 早于（判定时点日, `slotMinutes`）。旧写法「只看今天时点 + 宽限」会漏掉「昨天对账也没成功、今天仍在宽限内」—— 数据已旧两天却不提示（analyze H5）。
  - `previousTradingDay` 返回 null ⇒ **不可判定**：纯函数返回 `{ stale: false, undeterminable: true }`，use case 记 `logger.warn`、不标陈旧；不回落日历日（端口契约 `trading-calendar.port.ts:52-69`「null = 不可判定，调用方 MUST NOT 猜」；维护者 2026-09-15 analyze Q1）。
  - `slotMinutes` **复用** `broker-sync-slot.rules.ts` 的 `RECONCILE_SLOT_MINUTES`（`:24`），不另写一份；宽限 60 分钟为本文件常量（spec Assumptions：覆盖 082 同日 3 次 × 15 分钟重试）。
- 列表响应另带 `syncedAtLocal`（D13）供展示。

#### D8 — 列表响应（设计意图，字段 SoT = swagger 装饰器）

顶层：`hasConnection` · `brokerCount` · `syncedAt` / `syncedAtLocal` · `stale` · `unresolvedCount` · `groups[]`。组：`underlyingTicker` · `underlyingName` · `underlyingPrice` · `groupMarketValue` · `groupUnrealizedPl` · `rows[]`。行：`id` · `market` · `brokerCode` · `connectionLabel` · `kind`（`stock` / `option`）· `code` · `name` · `option`（期权才有）· `qty` · `marketValue` · `currentPrice` · `averageCost` · `unrealizedPl` · `unrealizedPlRatio` · `currency` · `openedAt` / `openedAtSource` · `expired`。mobile 的四种非列表状态由 `hasConnection` / `syncedAt` / `groups.length` 判定（D14）。

#### D9 — 持仓详情（`get-broker-position`）

1. `findFirst({ id, accountId })`；不存在，或正股未解析 / 不在锚集 ⇒ 404（FR-020 由 mobile 映射为「持仓已不存在」）。V4 保证 id 在持有期间稳定，不会被每日同步误伤。
2. 汇总 = D8 行字段（含 `market` —— FR-017 标时区用，深链进入时 mobile 只能从这里拿；analyze H4）+ `openedAtLocal`。
3. **订单列表**（FR-013 / FR-016，正股与期权共用）：该连接下 `code = 持仓代码` 或 `comboLegCodes` 含持仓代码的订单；`openedAtSource = 'derived'` ⇒ 只取 `vendorUpdatedAt ≥ openedAt`，`fallback` ⇒ 全部。**按 `vendorUpdatedAt` 不按 `vendorCreatedAt`**（V2：开仓订单全部早于开仓时间下单，按下单时间过滤会滤掉全部开仓单且不报错）。排序：`vendorCreatedAt` 降序，null 排末 → `orderId`。项字段：`id` · `side` · `qty` · `price` · `status` · `createdAtLocal`。
4. 期权 ⇒ 附 D10 批次；正股 ⇒ `lots = null`。

#### D10 — 持仓批次（`broker-lots.rules.ts`）

- **输入**：该连接该合约的全部成交（按 `tradedAt`、`dealId` 升序，与 `broker-opened-at.rules.ts` 同排序键）、券商报告的持仓数量、合约现价、持仓市值、订单号 → `{ 订单 db id, amount, qty, price }` 映射。
- **算法**（单次扫描 O(n)，排序 O(n log n)）：
  1. 带符号累计（`BUY` / `BUY_BACK` 为正，`SELL` / `SELL_SHORT` 为负）；每次累计值由 0 变非 0 或正负翻转，清空批次、开启新周期（翻转那笔成交先抵平旧仓、剩余部分开新批次）。
  2. 与当前持仓同向的成交 = 开仓：按订单号归入批次（同一订单多次成交合并；订单号为 null ⇒ 该笔成交单独成批次，`orderDbId = null`）；批次成本 = 该批次成交的数量加权均价。
  3. 反向成交 = 减仓（含行权 / 被指派 / 到期作废，082 F2：它们都以成交行出现）：按批次开仓时间从早到晚扣减（FIFO）。
  4. 输出剩余数量 ≠ 0 的批次（带 `originalQty` = 该批次开仓成交数量合计、`remainingQty`，FR-013），按开仓时间升序；`restorable` ⇔ 剩余数量之和 = 券商持仓数量（FR-015，不等 ⇒ mobile 显示「批次无法还原」且不渲染批次）。
- **批次数值**：`marketValue = 持仓市值 × 剩余 ÷ 持仓数量`（按比例拆分，不需要乘数）；`unrealizedPl = （现价 − 成本）× 剩余 × 乘数`，乘数 = 开仓订单 `raw.amount ÷（qty × price）` 取整（V0b）；开仓订单行缺失或价格为 0 ⇒ 乘数 null ⇒ 盈亏 null（mobile 显示「—」）。
- 组合单腿：成交行本身按腿合约记录，订单号共享 ⇒ 天然落到各腿合约的批次，且指向同一订单（FR-014）。

#### D11 — 订单详情（`get-broker-order`）

- `findFirst({ id, accountId })`；不存在，或订单 `underlyingTicker` 为 null / 不在锚集 ⇒ 404（与 D1 同形）。
- 字段：`market`（FR-017 标时区用）· `side` · `status` · `orderType` · 名称代码（同 D6）· `comboLegCodes` · `qty` · `price` · `amount`（`raw.amount`）· `dealtQty`（`raw.dealt_qty`）· `dealtAvgPrice`（`raw.dealt_avg_price`）· `dealtAmount` · `currency` · `createdAtLocal`。
- `dealtAmount = dealtQty × dealtAvgPrice × 乘数`，乘数同 D10（取本订单）；`dealtQty` 为 0 或缺失 ⇒ 三个成交字段全部 null（mobile 显示「—」，FR-017）；价格为 0 的订单（到期作废类系统单）成交金额 = 0。
- **枚举文案在 mobile**（`Record<Enum, string>` 穷举，漏值编译红）：订单状态 17 值与交易方向 5 值按 SDK 常量穷举（V9）；订单类型只映射 `NORMAL → 限价单`（V3，维护者截图为证），其余原样显示枚举名 —— 🚫 为未验证的类型编造文案。
- mockup 帧 6 的「系统单」标签**不实现**：指派产生的正股系统单与普通单无可区分字段（V3 / V9 取证时核过），属 mockup 与实现的有意偏离。

#### D12 — 新锚券商历史补齐状态（`list-broker-backfill-runs`）

对请求的每个 ticker，取该账号 `kind='backfill'` ∧ `target=ticker` 的最新一条记录（`createdAt` 降序）：`status` + 对应时刻（`succeeded` / `failed` → `finishedAt`；`running` → `startedAt`；`pending` → `nextAttemptAt`）+ 其 `…Local` 串。无记录的 ticker 不出现在响应里（mobile 显示「未触发」，FR-018）。ticker 与冷启动结局同形（V6），mobile 直接按 ticker 合并。

#### D13 — 交易所当地时间串（server 侧唯一换算点）

`marketdata/session-clock.ts` 新增导出 `exchangeLocalDateTime(market, instant) → 'YYYY-MM-DD HH:mm:ss'`，薄包装文件内既有 `Intl` 换算（照 `timeInTimeZone` `:97-112` 加秒、`hourCycle: 'h23'`），与 082 新增 `exchangeClock` 同一先例（Complexity Tracking）。所有 `…Local` 字段只经它产出。mobile 只做字符串重排（如 `2026/09/08` + `14:05:12`）并按 `market` 拼「（香港）/（美东）」，**不做时区换算**（V8：mobile 零时区先例，避开 Hermes `Intl` 时区支持的不确定性）。

#### D14 — mobile 持仓列表

- **屏**：`trading-account-screen.tsx` 持仓分段改渲染 `TradingAccountPositions`；订单 / 报表分段仍为 081 占位。该文件头注释「MUST NOT import `@nvy/api-client`」（081 FR-008）对持仓分段失效，改写为「订单 / 报表分段零数据面」—— 081 spec 为冻结记录，不回改。
- **数据**：`use-trading-account-positions.ts` 包生成 hook（照 `use-underlying-detail.ts` 体例：query key 常量、`refetch`）；`useFocusEffect` 聚焦重读 + 新建 `use-refetch-on-foreground.ts`（`AppState` 由非 `active` 变 `active` 时调 `refetch`）+ `RefreshControl` 下拉重读；三者只重读本系统数据，不触发券商同步（FR-008）。不改 react-query 全局 `focusManager`（影响全 App 查询）。
- **视图状态**（`trading-account-positions.rules.ts`，纯函数）：**无已加载数据**且请求失败 → 加载失败 + 重试；`!hasConnection` → 暂无交易账户；`syncedAt === null` → 尚未同步；`groups.length === 0` → 暂无持仓（`unresolvedCount > 0` 时仍显示未归类提示）；否则列表（FR-010）。**已有数据时重读失败** → 保持当前视图 + `refetchFailed`，同步时刻行换成「刷新失败，显示的是上次加载的数据」，下次重读成功恢复（FR-023；维护者 2026-09-15 analyze Q3）；不用错误卡替换已显示数据。另含：组头可见（`rows.length ≥ 2`）、券商标可见（`brokerCount > 1`）、未归类提示可见（`unresolvedCount > 0`）、期权名称拼接、到期日 6 位、行权价去尾零。
- **列表**：`SectionList`，每个组一个 section；折叠状态 = 组件内 `useState<Set<string>>`（屏卸载即丢，满足「离开再进恢复全部展开」FR-004），折叠时该 section `data = []` 只留组头。单行组不渲染组头、直接渲染行。
- **数字**（维护者 mockup 裁决，FR-022）：新建 `apps/mobile/src/format/compact-amount.ts`：`|n| < 1万` → 千分位 2 位小数；`1万 ≤ |n| < 1亿` → `x.xx万`；`≥ 1亿` → `x.xx亿`；保号；null / 非法 → `--`。**只用于主列表的市值、组市值、持仓盈亏金额、组持仓盈亏**；数量、价格、比例不缩写；详情页全精度。📌 `portfolio/stock-detail.helpers.ts:107-115` 已有一份含「万亿」档的同类函数（预存在，optionsdesk 不能跨 feature import，本片不重构它）。
- 涨跌色：盈亏金额与比例用 `text-quote-up` / `text-quote-down`（`use-quote-merge.ts:37-48` 体例），0 用 `text-quote-flat`。

#### D15 — mobile 详情屏与路由

- 路由：`app/(app)/optionsdesk/trading-account-position/[id].tsx`、`trading-account-order/[id].tsx`（薄路由，`useLocalSearchParams` 取 id，照 `underlying/[symbol].tsx:18`）；`_layout.tsx` 各加一条 `Stack.Screen`，`headerLeft: makeHeaderBackOrParent('/(app)/optionsdesk/trading-account')`（照 `_layout.tsx:43-46`）；`optionsdesk-routes.ts` 加两个路由常量 + `optionsdesk-routes.spec.ts` 表；`e2e/markets-feature-gate.spec.ts` 的 `GATED_DEEPLINKS` 加两条（照 081 D2：该文件头注释要求栈内新路由入表），同步头注释计数。
- 持仓详情屏：汇总卡 → 「持仓批次」段（`lots.restorable === false` 显示「批次无法还原」提示卡、不渲染批次；`orderDbId === null` 的批次不可点、不显示 `>`）→ 「本合约订单」/「订单」段；404 → 「持仓已不存在」卡（FR-020）。
- 订单详情屏：键值行（FR-017）；404 → 「订单不存在」卡。
- 两屏同样支持聚焦 / 回前台 / 下拉重读（D14 同一 hook 形态）；无已显示数据时加载失败 → 加载失败 + 重试；已有数据时重读失败 → 保留数据、顶部显示「刷新失败，显示的是上次加载的数据」（FR-023）；重读得到 404 → 「持仓已不存在」/「订单不存在」**优先于**已显示的旧数据（FR-020）。
- 期权持仓详情的「本合约订单」项同样可点进订单详情（SC-004 的第三条路径）。

#### D16 — 冷启动结局页

`anchor-cold-start-screen.tsx` 在拿到冷启动结局（`useMarketdataControllerAnchorColdStart`，`:39-43`）后，以其 ticker 列表调生成的 `list-broker-backfill-runs` hook；`RunRow`（`:151-178`）下加一行「券商历史 · 状态 · 时刻」，按 ticker 合并，无记录显示「未触发」。该请求失败时只隐藏这一行，不影响原有冷启动结局展示。

#### D17 — 文案与 testID

`optionsdesk-copy.ts` **新建独立段** `tradingAccountPositions`（不追加进 081 的 `tradingAccount` 段 —— 081 测试 `trading-account.rules.spec.ts:46-50` 断言该段全部字符串不含「暂无 / 空仓 / 无数据」，那是 081 占位仍然有效的不变量，本片的「暂无交易账户 / 暂无持仓」放进去会让它红；analyze H7），内容：四种非列表状态、刷新失败提示、连接标签、陈旧提示（中性措辞「数据可能已过时 · 最近成功同步于 …」—— 接口只给时间判定的 `stale`，不区分「失败」与「未到点」，mockup 帧 2 的「最近一次同步未成功」据此改写）、未归类提示、已到期标、批次无法还原、持仓已不存在、订单不存在、订单状态 / 方向 / 类型映射（`Record` 穷举）、冷启动券商历史状态。testID 照 `docs/conventions/mobile-testid.md` 体例 `optionsdesk-trading-account-<element>[-state]`。

### 测试映射（`state_branches` 47 条 → 落点；analyze 期逐条 grep 对账）

| 层 | 文件 | 覆盖的 `state_branches` 行号 |
|---|---|---|
| Server Small | `broker-position-display.rules.spec.ts` | 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 21, 23, 24 |
| Server Small | `broker-freshness.rules.spec.ts` | 6, 7, 44 |
| Server Small | `broker-lots.rules.spec.ts` | 26, 27, 28, 29, 30, 31, 32 |
| Server Medium | `apps/server/test/integration/optionsdesk-083.broker-positions-read.it.spec.ts` | 1, 2, 3, 5, 6, 7, 8, 9, 20, 21, 23, 44 |
| Server Medium | `optionsdesk-083.broker-position-detail.it.spec.ts` | 25, 29, 30, 34, 35, 36, 39, 40 |
| Server Medium | `optionsdesk-083.broker-order-detail.it.spec.ts` | 38, 39, 45 |
| Server Medium | `optionsdesk-083.broker-backfill-runs.it.spec.ts` | 41, 42 |
| Mobile vitest | `trading-account-positions.rules.spec.ts` · `format/compact-amount.spec.ts` · 文案映射穷举 spec | 1, 2, 3, 4, 10, 11, 12, 20, 22, 38, 41, 42, 43 |
| Mobile E2E | `apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts` | 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 20, 21, 22, 23, 25, 27, 28, 30, 31, 32, 33, 34, 36, 37, 38, 40, 41, 42, 43, 45, 46, 47 |
| Contract Smoke | `apps/mobile/e2e/contract-smoke/optionsdesk-trading-account.contract.ts`（`run.ts:44-91` 登记） | 1, 39 |

- 行 14（回前台重读）：web 端以 `document.visibilitychange` 驱动 `AppState` 做 e2e 断言；若 react-native-web 的映射不触发，改为 Gate 0.1 真机人工核并在 tasks 注明（不是跳过）。
- 契约冒烟的 happy path = 无连接账号请求列表（`hasConnection=false`）+ 请求不存在 id 得 404，验证 URL / 序列化 / 错误码对齐；若冒烟装置已有 DB 种数入口（implementer 先读 `optionsdesk.contract.ts` 头注释），追加一条有持仓的读取。

**SC 落点**：SC-001 / SC-003（真实账户部分）/ SC-008 = 维护者对照富途 App 人工验收（SC-001 价格类字段在「对账成功后至券商持仓现价开始变动前」窗口比对（2026-09-17 amend，原「开盘前窗口」，见 spec SC-001），并顺带核「开盘前现价 = 昨收」）· SC-002 = display rules 固定数据集 · SC-003（构造样本）= lots rules · SC-004 = e2e 点击计数 · SC-005 = 真机计时（Gate 0.1）· SC-006 = IT 账号隔离臂 · SC-007 = IT「先成功后失败」+ freshness rules · SC-009 = backfill-runs IT · SC-010 = `check-identifier-boundary` 私有清单 + PR 前私有数据扫描。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- **server 新增**：`optionsdesk/broker-position-display.rules.ts` · `broker-lots.rules.ts` · `broker-freshness.rules.ts`（+ 同名 `.spec.ts`）· `list-broker-positions.usecase.ts` · `get-broker-position.usecase.ts` · `get-broker-order.usecase.ts` · `list-broker-backfill-runs.usecase.ts` · `broker-account.controller.ts` · `broker-account.dto.ts` · 4 个 `apps/server/test/integration/optionsdesk-083.*.it.spec.ts`
- **server 触碰**：`optionsdesk/optionsdesk.module.ts`（controller + providers）· `marketdata/session-clock.ts`（D13 导出 + spec）· `apps/server/openapi.json`（regen）· `packages/api-client/src/generated/`（regen）
- **mobile 新增**：`src/format/compact-amount.ts`（+ spec）· `src/optionsdesk/use-trading-account-positions.ts` · `use-refetch-on-foreground.ts` · `trading-account-positions.rules.ts`（+ spec）· `trading-account-positions.tsx` · `trading-account-position-screen.tsx` · `trading-account-order-screen.tsx` · `app/(app)/optionsdesk/trading-account-position/[id].tsx` · `trading-account-order/[id].tsx` · `e2e/optionsdesk-trading-account-positions.spec.ts` · `e2e/contract-smoke/optionsdesk-trading-account.contract.ts`
- **mobile 触碰**：`trading-account-screen.tsx`（持仓分段 + 头注释）· `anchor-cold-start-screen.tsx`（D16）· `optionsdesk-copy.ts`（D17）· `optionsdesk-routes.ts` + `.spec.ts` · `app/(app)/optionsdesk/_layout.tsx` · `src/optionsdesk/index.ts` · `e2e/markets-feature-gate.spec.ts` · `e2e/contract-smoke/run.ts`
- **docs**：`docs/adr/0043-server-flat-module-paradigm.md` 复审记录（Gate 0.4）

## Complexity Tracking

无原则违背。越出 optionsdesk 目录的改动与一处已知重复，记录在此便于 review 定位：

| 改动 | 为什么需要 | 更简单的替代为何不行 |
|---|---|---|
| `marketdata/session-clock.ts` 新增导出 `exchangeLocalDateTime` | 订单 / 批次 / 同步时刻要按交易所当地时间显示到秒（FR-017，D13） | optionsdesk 自写 `Intl` 换算被 `check-time-semantics` Rule B 拒；放到 mobile 做换算没有先例且依赖 Hermes 的 `Intl` 时区支持（V8） |
| 新建 `apps/mobile/src/format/compact-amount.ts` | 主列表数字「万」缩写（维护者 mockup 裁决） | 复用 `portfolio/stock-detail.helpers.ts` 的同类函数 = optionsdesk 跨 feature import（被禁）；把它下沉到 `~/format` 并改 portfolio 调用点 = 顺手重构他 feature，超出本片 |
| ADR-0043 #1 sunset trigger 越线（20 → 24） | 4 个读接口各自独立 | 见 Gate 0.4 三个否决的替代 |
