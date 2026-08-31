---
feature_id: 071-optionsdesk-hk-realtime-recall
spec_ref: ./spec.md
status: draft
created_at: '2026-08-31'
updated_at: '2026-08-31'
adr_refs: ['0043', '0062', '0064', '0066', '0067', '0068']
context7_verified: []
---

# Implementation Plan: 港股期权实时窄召回接线 — 港股锚盘中拿到与美股同构的实时选约表

## Summary _(mandatory)_

把港股接进 optionsdesk 的实时窄召回读路径（ADR-0068 sunset trigger #1 的兑现）。**不新开读路径**：市场差异全部表达为「能力声明 + 参数取值」的差异，判据单点不动（FR-012；六条机器不变量本就会拦第二份判据面）。server 侧四处取值改动 —— 窗能力白名单加 hk、bootstrap 下界转 per-market（上界按构造沿用）、实时路径业务日基准改按锚所属市场解析、guard 逻辑零改动（白名单一变自动不再命中 hk）。契约与 mobile **零代码改动**。另收口一处**语义债**：行情底座的市场时段表把港股合成单段（午休不建模）时，其三条支撑句里已有两条过期、一条现已为假；本片顺手恢复两段并更正注释（FR-017/018），它同时是「供应方午休不区分」这一反证分支的前置（FR-019）。行军门控是否对港股放开，由本片一轮三判据的适用性判定决定（FR-013）。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 单 feature 单分支单 PR（§V；本片实际是纯 server + 测试面，mobile 零代码）；TDD 红绿闭环，每条新测试须定向变异证明能红（§II）；扁平/贫血/护城河零违背（§IV：零新表、零写路径、零新 endpoint、零跨 ctx 新增、零新 class；D3a 触及 marketdata 的时段表**数据 + 注释**，不跨 import 边界、不动其 use case）；mockup-first 免（§I：零新组件、零新屏、零文案改动，UI 面本片不动）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 既有 optionsdesk IT（Testcontainers 真 boot + 真 DI 容器）承载 —— 零新 endpoint；spec `state_branches` 14 条在 usecase/adapter IT 穷举（D6）。
- [x] **Mobile / Web**: 无代码改动 ⇒ 无新 e2e 交互面；新增**契约冒烟**打真后端覆盖港股 symbol 下的选约表（FR-015，今天该覆盖为零）。
- [x] **Evidence**: impl 期 IT/contract-smoke commit + pad 回放与行军适用性判定结论回写 spec（体例同 067/068/069/070）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖。vendor 面复用既有 `OPTION_SNAPSHOT_READ_PORT` / `MARKET_STATE_PORT` / `TRADING_CALENDAR_PORT`，三者**均已 market 参数化**（D3 核录）。**Evidence**: N/A。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] 本 feature mono-native（071 spec / ADR-0068 均 mono 原生），无迁移面。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question / sunset trigger affected                                                                       | Classification | Mitigation / next step                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0068 | sunset #1「**港股实时接线**（market 参数化从留形状转实装）→ 重审 guard 复用 `source_unavailable` 是否升格」     | **mitigated**  | 本片即该触发器；裁决 = **不升格、值域不扩**（spec FR-010 / clarify），ADR 消费注记随本 PR 回写                                                                                      |
| ADR-0068 | sunset #2/#3/#4/#5（fillMode / laddering / φ-exit / 财报复测）                                                 | accepted-as-is | 均非本片触发                                                                                                                                                                       |
| ADR-0068 | 「后果」段遗留项 ②「hk 锚收租待其自身标定片」                                                                  | **partially**  | 本片做**单向适用性判定**（三判据，D5）而非标定；不过则仍不放开，结论落 spec 并排期                                                                                                 |
| ADR-0064 | 5 条 sunset（多路召回 / LLM 精排 / p95 阈值 / 第二消费方 / 多方参与）                                          | accepted-as-is | 逐条核过，本片一条不触发 —— 加市场不是加召回路，不改精排，不新增消费方                                                                                                             |
| ADR-0066 | OQ #1「hk 半日市的日历源给不出半日标记」                                                                       | accepted-as-is | 本片够不到：实时闸只读日历的 `trading` / `non-trading` 二分 + **供应方市场状态**，从不读 `session_kind`；半日市下午由供应方状态挡（spec `state_branch` 4 的实现路径正是这条）      |
| ADR-0066 | OQ #2/#3（`sync_run` 写入行数口径 / 夜盘市场的 session 标识）                                                  | accepted-as-is | 与本片无关                                                                                                                                                                         |
| ADR-0067 | 3 条 sunset（vendor 全改带外缺失 / 第 2 个消歧形态 / shim 统一承担）                                           | accepted-as-is | 本片不新增 vendor 字段解析，缺失语义面零触及                                                                                                                                       |
| ADR-0062 | Open Questions = 无                                                                                            | n/a            | —                                                                                                                                                                                  |

其余 ADR 的 Open Question 段逐一扫过（`grep -rl "Open Question" docs/adr/` 21 个文件），与本片无交集。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类**绝对禁止**隔离单元测试（本片预期零新 lifecycle 组件，禁令仍全文有效）。
- **MANDATORY INTEGRATION**: usecase / adapter 层验证必须 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` 真 DI 容器（Testcontainers PG+Redis）。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 14 条每条在 IT 有对应 `it()` 块，100% 路径覆盖（含午休、**本地表两问答案相反**、半日市、周一闸误判、无挂牌期权、规则内无腿、新锚首日、未支持市场守卫八条非 happy-path）。
- **PROVE-IT-CAN-FAIL**: 每条新断言用定向变异证明会红（把 `parsed.market` 改回 `'us'` / 注释掉 guard / 把白名单改回 `['us']`），rebase 后重做。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片**零新表、零写路径、零跨 ctx 新增、零新 endpoint、零新 class** —— 改动全部落 `apps/server/src/optionsdesk/` 既有读路径的**取值**上。

**D1 · 接线点（server，四处，全是取值不是路径）**

- **D1a 能力声明**：`leg-window.rules.ts:27` `WINDOW_SUPPORTED_MARKETS = ['us'] as const` → 加 `'hk'`。`isSupportedMarket`（:101）与 `bootstrapWindowFor` 的 throw（:85-90）**零改动** —— 纵深防御自动对 cn 等仍生效（FR-009）。
- **D1b bootstrap 取参（FR-002）**：下界 `STRIKE_ENVELOPE_FLOOR_SPOT_RATIO`（:52，`0.7`）转 **per-market 具名常量表**（仍住本文件 = 单点不破）；上界 `STRIKE_ENVELOPE_CEILING_SPOT_RATIO`（:58，`1.05`）**保持单值**，补注释写明其成立是构造性的（`1.03 × axis ≤ 1.03 × spot < 1.05 × spot` 恒成立），🚫 MUST NOT 为它编标定值。
  🚨 **守卫形状**：这两个比例**不走子串扫**（`0.7` 撞遍全 ctx 注释，check 脚本 :338 自己写明），靠 `INLINE_COEFFICIENT_RE`（:370）拦「内联系数乘法」⇒ per-market 表的取值 MUST 仍是具名常量、乘法 MUST 消费常量，🚫 禁 `.times(new Prisma.Decimal('…'))`。
- **D1c 业务日基准（FR-004，#274 的实时半）**：`leg-retrieval.adapter.ts:286` `exchangeCalendarDate('us', query.now)` → `exchangeCalendarDate(parsed.market, query.now)`。
  🚫 **`:608`（离线唯一路径）MUST NOT 一起改** —— 两处证据面不同，离线归后续片（spec Out of Scope）。
  🚫 **比较符 `expiryDate > marketDate` MUST NOT 改**（FR-005；DTE=0 的排除单点在 `leg-recall.rules.ts:44` `BUILD_RECALL_DTE.min = 1`，其注释 :41-42 明写「下界取 1 是因为读端已滤，写成 1 是让前置可见、不是多一道判定」）。
- **D1d guard 与日志**：`:293-298` 逻辑零改动（白名单一变，hk 自动不再命中）；`REALTIME_DEGRADE_LOG_TAG` 那句「未支持窗派生」保留 —— 它的服务对象从 hk 换成了「将来的下一个市场」。

**D2 · 取证：pad 与 bootstrap 下界（FR-002 / FR-003）**

- **pad 双日回放**：hk 现有 **6 个 session（2026-08-21 … 08-28）= 5 对**。方法同 068：D−1 快照 `|Δ| ∈ 带` → moneyness 包络 `×(1 ± pad)` × D 日 spot → 与 D 日真实落带 K 集合比召回率。**达标线 ≥ 95%**（clarify 裁决，与美股同线）；达标则 `MONEYNESS_PAD_RATIO`（`leg-delta-surface.rules.ts:40`）**不动**并附证据，未达标才转 per-market（pad 是子串扫，第二处出现即红）。
- **bootstrap 下界**：双基面取证 —— ① 08-17 盘中全链探针（3 只票 3134 腿，`docs/private/plans/2026-08/08-17-hk-option-probe-report.md`）② 现有 6 个收盘 session。判据 = 原义「`K/spot` 低到某比例后 bid 几乎必然落在权利金门槛之下 ⇒ 问了也是白问」，结论取**更宽（更低）**的一侧。
- 🚨 **样本量小是事实不是瑕疵**：5 对回放 / 6 个 session / 2 只有期权的标的。结论 MUST 写「本样本期成立」，🚫 MUST NOT 写成全称判断。脚本落 `docs/private/evidence/`（local-only，同 069 先例），结论回写 spec。

**D3 · 闸、午休与「周一效应」（FR-007 / FR-008）**

- **闸判据链已逐段核过**（`leg-retrieval.adapter.ts:778-799`）：`getMarketSessions()` → `sessions.find(s => s.market === target.market)?.session === 'regular'` → `tradingCalendar.classify(target.market, target.marketDate)`。**两处都已 market 参数化，唯一污染源是 `marketDate`**（D1c 修）。
- **午休（推断在代码层面成立，缺实测）**：`futu-market-state.adapter.ts:59` `REGULAR_SESSION_STATES = {MORNING, AFTERNOON}`；`REST` 在 `KNOWN_VENDOR_STATES`（:70）但不在白名单 ⇒ `normalizeSession('REST') = 'other'`（:111）⇒ 闸 `closed` ⇒ 中性收盘档、零降级标。缺的只有一条：**vendor 在港股午休确实报非 MORNING/AFTERNOON 的值**。
  实测来源 = `ops/bin/hk-option-post-close-probe.py --mode state`（2026-08-31 已挂，网格含 `11:55 / 12:01 / 12:15 / 12:30 / 12:45 / 12:59 / 13:01 / 13:10`）。结论回写 spec Assumptions。
  🚨 **条件分支（实测反证时）落点 = 供应方适配层，不是期权台**（FR-019）：若午休报 MORNING/AFTERNOON，修法是让 `futu-market-state.adapter.ts` 对 hk 在午休把 `MORNING` 归一为 `'other'` —— 它在 marketdata 内 ⇒ **可以** import `market-session.rules.ts`，且它本来就是 vendor→domain 的归一化单点（`normalizeSession:111`）。这样判据仍单点、期权台零改动，两个消费方（实时档闸 + 正股实时价投影）同时拿到正确答案。
  🚫 **MUST NOT 让 optionsdesk 自己去读时段表** —— `eslint.config.mjs:334-347` 的 `from: optionsdesk` disallow 明列 `marketdata-rules`，会直接撞墙；就算能过也是第二份「能不能成交」判据。
  ⚠️ **更正**：本 plan 初稿把「恢复两段」写成了这条分支的出路，那是错的方向 —— optionsdesk 读不到那张表，恢复两段对实时档闸零帮助。两段表的真实定位见 D3a。
- 🚨 **周一效应（plan 期新发现，dev 库实证）**：`classify` 吃的正是那个写死美股的 `marketDate`。北京周一 10:00 折算出的美股日历日是**周日**（`2026-08-31 10:00 CST → 2026-08-30 ET`）；`marketdata.trading_day` 的 hk 周末**无行**，而 `calendar_coverage.hk = 2015-01-01 … 2026-12-31` **含该日** ⇒ `classifyTradingDay`（`trading-day.rules.ts:102-103`「无行 ∧ 在覆盖内 → `non-trading`」）返 `non-trading` ⇒ 闸 `closed` ⇒ `retrieveClosing(query, null)`，**静默收盘档、零降级标**。
  ⇒ 今天的坏法有两种：**周二–周五**是红字 `source_unavailable`（闸开→guard 命中），**周一**是一张看起来完全正常的收盘档表。后者更坏。D1c 一并修掉，**MUST 有专门 IT 臂**（周一时刻夹具），否则修完也看不出修没修。

**D3a · 时段表语义债收口（FR-017 / FR-018 / FR-019，本片新增 scope）**

- **为什么现在做**：`market-session.rules.ts:55-75` 那段注释给了三条支撑句，今天**只剩一条成立** —— ①「趁 hk 期权尚未开通落地」已过期（066 已 ship）②「hk 期权采集仍未开通（`COLD_START_CAPABILITY` 里 hk 是空表项）」**现已为假**（`anchor-cold-start.rules.ts:146` = `{ optionChain: true, optionSnapshot: true }`）③「`isWithinTradingSession` 唯一生产调用方钉死 `cn`」仍成立。而 071 让「港股盘中告警」从**不存在的界面**变成**自然的下一个需求** ⇒ 踩雷概率跳档。
- **拆雷成本实测为零**：只有 `isWithinTradingSession:269`（`segments.some`）会变；`spanOf:294-295` 取 `min(open)/max(close)` ⇒ 两段与单段同为 09:30/16:00，故 `isSessionUnderway:418` / `sessionCloseMinutes:320` / `isWithinCloseSettleBuffer:437` **逐点不变**；半日市走独立的 `halfDaySegments`（`segmentsFor:284`）不受影响。而 `isWithinTradingSession` 唯一生产调用方钉死 `cn` ⇒ **今天零生产行为变化**。
- 🚨 **要翻的是刻意设的绊线，不是遗留**：`market-session.rules.spec.ts:164` 注释原文「谁把 hk 改回两段式, 这里第一个红, 逼他先回去读 FR-011」。⇒ 翻它 MUST 在同一 commit 写明理由。**测试面精确 4 处**：`:73` describe 标题 · `:74/:78` 「午休判 true」用例 · `:104-107` 「两谓词不再分道」用例 · `:160-181` 逐分钟等价循环（hk 要从「除收盘分钟外等价」改为「除收盘分钟**与午休段**外等价」）。
- **注释更正三处**（FR-018）：两条过期/为假的支撑句改掉；复审触发条件从「将来给 hk 接盘中告警时」扩为「**任何**需要判『此刻能不能成交』的港股消费方」—— 原措辞太窄，它把「读端」这类消费方漏在外面。
- **边界**：本片对 marketdata 的改动**仅限**这张表的数据 + 注释 + 其 spec；🚫 不动任何 marketdata use case、不动供应方适配层（除非探针证伪，见 D3 条件分支）。

**D4 · 契约与 mobile（FR-011 / FR-010，零代码改动）**

- **契约零新增字段、零值域扩张**：`legTableResponseRealtimeDegrade` 四值不动（FR-010 裁决）。港股锚开始返回 `priceKind: 'realtime'` + 秒级 `quoteAsOf`，走的是既有字段。
- **mobile 零改动已核**：`radar.rules.ts:76` `MARKETS_WITHOUT_INTRADAY` 已是空数组（066 T12 摘掉 hk）；`leg-tier-bar.rules.ts:217-220` 四条降级文案穷举 `Record` 不动；档位判定 `legQuoteTier` 不认 market。⇒ 本片 mobile 侧**只加测试、不改代码**。
- **ADR-0068 回写**（随 PR）：sunset trigger #1 标注消费（裁决 = 不升格降级态），「后果·仍并存」段的 ② hk 锚收租按 D5 结论更新。

**D5 · 行军参数适用性判定（FR-013 / FR-014）**

- **三条判据同时成立才放开**（clarify 裁决）：① 形状类条件在港股净链上的触发率与美股同量级（不显著偏高）② 流动性下限不致港股收租候选**整梯清零**（清零梯占比不高于美股基线）③ 档界参数是策略定义的年化门槛、货币无关，直接沿用。
- 复用 069 的回放脚本（`docs/private/evidence/069-replay-calibration.ts`，local-only）改造入口喂 hk 收盘链。
- 🚨 **定位是单向否决，不是标定**：样本明显不足以标定新值，但足以判「显著异常即不适用」。三条全过 ⇒ 放开 `get-legs.usecase.ts:705` 的门控为 `perspective === 'rent'`（去掉 market 条件），并把 `optionsdesk-070.offline-ladder.it.spec.ts:405-414` 臂④（「hk 收租 march 恒 null」）翻成正例；任一不过 ⇒ 门控不动，结论落 spec 并起后续标定片。
- FR-014：不出阶梯时该状态 MUST 是门控的显式返回（现状 `{ march: null, marchMode: null }` 已是显式双 null，`get-legs.usecase.ts:699-706` 注释已钉「同出同 null」）—— 与「算出来是空」的区分由该注释与 IT 臂承担。

**D6 · 验证与测试分层（SC 落点）**

- **IT（Testcontainers 真 DI）**：`state_branches` 14 条穷举。新增/改写的关键臂 —— 港股盘中走实时（正例）· 港股午休闸 closed 且零外呼 · **周一时刻闸判开市**（D3）· 半日市下午 · 新锚首日 bootstrap · 未支持市场守卫仍红 · FR-006a 等价性。
- 🚨 **反例 fixture 迁移**：`optionsdesk-068.two-stage.it.spec.ts:569-579` 臂② 今天拿 **hk 当「未支持市场」样本**，本片一接就**失去被试对象**（`IMPORTABLE_MARKETS = ['us','hk']`，`anchor-import.rules.ts:21`，没有第三个市场）。处置 = 臂② 翻成「hk 走实时」正例；反例臂换 `cn`（`seedChain` 直接播种、不经建锚校验，先确认 `parseAnchorTicker('cn:…')` 不拒），拿不到就降为 `bootstrapWindowFor('cn', …)` 的纯函数 throw 单测。
- **FR-006a 等价性断言**：换基准前后，两个市场的候选集与其排序逐值相同 —— 这条专门拦「顺手把 `>` 改成 `>=`」。
- **contract-smoke**：新增 `apps/mobile/e2e/contract-smoke/071-hk-realtime.contract.ts`（FR-015）。
- **SC-002 / SC-003 = 部署后验收**（clarify 裁决）：独立 task，🚨 **MUST 带到期日 + 配套 issue** —— 066 T15 正因无到期日而至今未勾、把那份 spec 卡在 `implementing`。
- **测试分层**：判据纯函数 vitest；usecase/adapter IT（Testcontainers）；契约对齐 contract-smoke。mobile 零改动 ⇒ 不新增 e2e。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：本片零写路径，无 tx 面。
- **配额**：市场状态端口是**单键全市场**（`futu-market-state.adapter.ts` 的 10 秒 TTL 注释；桶 10 发/30s，064 T013 实测撞桶表现为 7–18 秒静默白屏）⇒ 接 hk **不增加**该端口压力。期权快照端口每视角一发、桶 60 发/30s。📌 **登记一条观察项**：港股盘中 = 北京工作时间，而美股盘中是北京深夜 ⇒ 实时档的真实使用频次会显著高于以往，本片不改设计，但 p95 与桶余量进 tasks 预检表。
- **时间语义**：本片核心即时间语义修正 —— `exchangeCalendarDate` 按市场取参、`daysToExpiry` 已按市场取参（#263）。`check-time-semantics.ts` 照跑；🚫 MUST NOT 新造第二个「今天」判定。
- **安全**：不触鉴权 / PII 面。
- **前端**：零改动。

### 决策备选与既有事实核录

**备选否决**：① 为 hk 新开一条读路径 —— 否（FR-012；check 脚本 #2/#3/#7/#9/#10/#11 六条不变量当场红，判据单点是机器强制的）；② 顺手把 `:608` 离线那处一起修 —— 否（两处证据面不同，且离线改动会动用户可见腿集合，归后续片）；③ 把 `>` 改成 `>=` 让当天到期腿进来 —— 否（DTE=0 本就不在召回段，改了只让审计多出一批「范围外」计数，净收益为负）；④ 上界 `1.05` 也做 per-market 标定 —— 否（构造性恒成立，标定一个恒真边界只会制造伪参数）；⑤ 为「市场未支持」新增独立降级态 —— 否（clarify 裁决）；⑥ 本片一并放开行军门控 —— **条件**（D5 三判据全过才放）；⑦ 让 optionsdesk 直接读本地时段表拿午休 —— 否（撞 `eslint.config.mjs:334-347` 的 boundaries 墙，且制造第二份「能不能成交」判据）；⑧ 时段表只改注释、不恢复两段 —— 否（注释改完，代码仍留着一个对「能不能成交」答错的谓词，而拆它成本为零、还是反证分支的前置）。

**既有事实核录**（2026-08-31 plan 期逐项 grep / SQL 核，🚫 未照抄任何二手行号）：

- 窗能力：`leg-window.rules.ts:27` `WINDOW_SUPPORTED_MARKETS = ['us'] as const`；`:52` 下界 `0.7`；`:58` 上界 `1.05`；`:85-90` 未支持即 throw；`:101` `isSupportedMarket`
- 实时路径：`leg-retrieval.adapter.ts:286` 写死 `'us'`（注释自陈沿 #274「不顺手修」）；`:289` 闸；`:293-298` #286 guard；`:778-799` 闸判据体；`:92` `REALTIME_SNAPSHOT_TIMEOUT_MS = 3_000`
- 离线路径：`leg-retrieval.adapter.ts:608` 同款写死 `'us'`（注释给了「港股当天到期腿滤不滤」的语义题）—— **本片不动**
- DTE 下界：`leg-recall.rules.ts:44` `BUILD_RECALL_DTE = { min: 1, max: 49 }`，`:41-42` 注释坐实「下界取 1 是因为读端已滤」；`:52` `RENT_RECALL_DTE = { min: 30, max: 365 }`
- pad / 带：`leg-delta-surface.rules.ts:40` `MONEYNESS_PAD_RATIO = 0.025`；`:98` `resolveDeltaSurfaceWindow` 的 band/pad/w **全是入参**（市场无关，这是「不分入口」成立的结构依据）
- 行军门控：`get-legs.usecase.ts:705` `if (perspective !== 'rent' || market !== 'us')`；`:691-698` 注释「门控不看档位」+「march 与 marchMode 同出同 null」
- 市场状态：`futu-market-state.adapter.ts:59` `REGULAR_SESSION_STATES = {MORNING, AFTERNOON}`；`:70` `KNOWN_VENDOR_STATES` 含 `REST`；`:111` `normalizeSession`
- 日历三态：`trading-day.rules.ts:31` `TradingDayStatus = 'trading' | 'non-trading' | 'unknown'`；`:102-103` 「无行 ∧ 在覆盖内 → non-trading」
- 周一效应实证（dev 库 SQL）：`marketdata.trading_day` 的 hk 周末无行（08-28 Fri / 08-31 Mon 有、08-29·08-30 无）；`marketdata.calendar_coverage.hk = 2015-01-01 … 2026-12-31`（`served_by = static`）
- 建锚市场白名单：`anchor-import.rules.ts:21` `IMPORTABLE_MARKETS = ['us','hk']`（**没有第三个市场** ⇒ 反例 fixture 迁移是硬需求）
- 时段表：`market-session.rules.ts:55-75` hk 单段注释三支撑句；`:97` hk `segments: [[9*60+30, 16*60]]`；`:99` `halfDaySegments: [[9*60+30, 12*60]]`；读者 `:269` / `:294-295` / `:320` / `:418` / `:437`
- 冷启动能力表：`anchor-cold-start.rules.ts:144-147` —— **hk 两档全开**（⇒ 时段表注释里「hk 是空表项」为假）
- `isWithinTradingSession` 生产调用方：全仓唯一 `alert/intraday-eval.processor.ts:95`，参数 `INTRADAY_MARKET = 'cn'`（`:45`）
- 模块边界：`eslint.config.mjs:334-347` `from: optionsdesk` disallow 含 `marketdata-rules` ⇒ **期权台读不到时段表**（这是 D3 条件分支落供应方适配层的硬依据）
- 绊线测试：`market-session.rules.spec.ts:73/:74/:78`、`:104-107`、`:160-181`（`:164` 注释自陈「谁把 hk 改回两段式, 这里第一个红」）
- 守卫脚本：`scripts/checks/check-optionsdesk-rule-constants.ts` 头部十一条不变量表（`:7-19`）；`:338` 明写 bootstrap 两比例不走子串扫；`:370` `INLINE_COEFFICIENT_RE` 形状扫
- mobile：`radar.rules.ts:76` `MARKETS_WITHOUT_INTRADAY = []`；`leg-tier-bar.rules.ts:217-220` 四条降级文案穷举 `Record`
- 反例 fixture：`apps/server/test/integration/optionsdesk-068.two-stage.it.spec.ts:569-579` 臂②（hk = 未支持市场）
- 数据现状（dev = prod 逐值一致）：hk 期权快照 **6 个 session / 11,633 行 / 2026-08-21 … 08-28**；3 只 hk 锚（`hk:00700` / `hk:00777` / `hk:09988`），其中 `00777` 无挂牌期权、`00700` 因 `spot 455.2 > 1.143 × V(385)` 收租窗结构必空 ⇒ **只有 `09988` 能真正跑通收租**（FR-016 的由来）

## Complexity Tracking

无违规，无需 justify。
