---
feature_id: 071-optionsdesk-hk-realtime-recall
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-31'
updated_at: '2026-08-31'
---

# Tasks: 071-optionsdesk-hk-realtime-recall（港股期权实时窄召回接线 — 港股锚盘中拿到与美股同构的实时选约表）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 sunset trigger #1 的兑现）
**Branch**: `071-optionsdesk-hk-realtime-recall`
**病根一句话**：港股期权的数据面上一片就建成了（三个采集维度在 prod 跑、逐腿盘中报价覆盖 96%），但读侧四道 us-only 闸让港股锚在盘中拿不到实时档 —— 周二到周五是一条劝阻下单的红字，**周一连红字都没有**（业务日基准写死美股 ⇒ 折算出周日 ⇒ 闸误判休市，静默给一张收盘表）。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract-Smoke]` / `[Gate]` / `[Ops]`。**本片无 `[Mobile]` / `[Contract]`** —— 契约零新增字段、前端零代码改动（plan §D4 已逐项核过），这是结论不是遗漏。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 窗能力白名单 + bootstrap 取参（改） | `apps/server/src/optionsdesk/leg-window.rules.ts`（+ 同名 spec） |
| sticky moneyness 容差（**视回放结论决定动不动**） | `apps/server/src/optionsdesk/leg-delta-surface.rules.ts`（+ 同名 spec） |
| 实时路径业务日基准（改 `:286` 一处） | `apps/server/src/optionsdesk/leg-retrieval.adapter.ts` |
| 离线路径业务日基准 `:608`（🚫 **本片禁改**） | 同上文件 —— 归后续片 |
| 行军门控（**条件**改，视 T007 结论） | `apps/server/src/optionsdesk/get-legs.usecase.ts` |
| 市场时段表：港股恢复两段 + 注释三处更正 | `apps/server/src/marketdata/market-session.rules.ts`（+ 同名 spec） |
| 供应方状态归一化（**条件**改，仅 T001 证伪时） | `apps/server/src/marketdata/futu-market-state.adapter.ts` |
| Server IT（**新建**） | `apps/server/test/integration/optionsdesk-071.hk-realtime.it.spec.ts` |
| 反例 fixture 迁移（改既有臂②） | `apps/server/test/integration/optionsdesk-068.two-stage.it.spec.ts` |
| 070 臂④ hk 恒 null（**条件**翻面，视 T007） | `apps/server/test/integration/optionsdesk-070.offline-ladder.it.spec.ts` |
| 契约冒烟（**新建**） | `apps/mobile/e2e/contract-smoke/071-hk-realtime.contract.ts` |
| 探针（已落，本片收口其结论） | `ops/bin/hk-option-post-close-probe.py` |
| ADR 回写（sunset #1 消费 + 后果段 ② 更新） | `docs/adr/0068-realtime-narrow-recall-two-stage.md` |
| 取证留档（local-only） | `docs/private/evidence/` · `docs/private/plans/2026-08/` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **`:608` 离线基准 MUST NOT 一起改**（plan §D1c）—— 两处证据面不同：实时那处换基准对候选集零改变（下界已排除 DTE=0），离线那处会改用户可见的腿集合。顺手改了不会红，只会让离线腿集合悄悄变。
2. **比较符 `expiryDate > marketDate` MUST NOT 改成 `>=`**（FR-005）—— DTE=0 的排除单点在 `leg-recall.rules.ts:44` `BUILD_RECALL_DTE.min = 1`（注释 `:41-42` 自陈「下界取 1 是因为读端已滤」）；改成 `>=` 只会让审计多出一批「范围外」计数，净收益为负。T005 的等价性断言就是拦这个。
3. **bootstrap 取参禁内联字面量**（plan §D1b）—— 这两个比例不走子串扫（`0.7` 撞遍全 ctx 注释），靠 `INLINE_COEFFICIENT_RE` 拦「内联系数乘法」⇒ per-market 表的取值 MUST 仍是具名常量、乘法 MUST 消费常量。
4. **上界 `1.05` MUST NOT 做 per-market 标定**（FR-002）—— 它成立是构造性的（`1.03 × axis ≤ 1.03 × spot < 1.05 × spot` 恒成立），给恒真边界编一个标定值 = 伪参数。只补注释。
5. **期权台 MUST NOT 直接 import 时段表**（FR-019）—— `eslint.config.mjs:334-347` 的 `from: optionsdesk` disallow 含 `marketdata-rules`，会直接撞墙；就算能过也是第二份「能不能成交」判据。午休归一化只许落供应方适配层。
6. **翻绊线断言 MUST 在同一 commit 写明理由**（FR-017）—— `market-session.rules.spec.ts:164` 注释原文「谁把 hk 改回两段式, 这里第一个红, 逼他先回去读 FR-011」。它是刻意设的，不是遗留。
7. **降级值域 MUST NOT 扩张**（FR-010）—— 不为「市场未支持」新增状态值；`legTableResponseRealtimeDegrade` 四值不动，前端四条穷举 `Record` 不动。
8. **管道判据与行军参数本片只读**（FR-012）—— `leg-recall` / `leg-fwd-chain` / `leg-march` 的判据面与 φ/β/γ/`OI_MIN` 取值**禁改**；T007 是**判定**不是标定，发现要调参 → 停下报 user。
9. **样本期 MUST 写明**（FR-003 / FR-013）—— 港股只有 6 个交易日、2 只有期权的标的。结论一律写「本样本期成立」，🚫 禁写成全称判断。

## Tasks

- [X] T001 [P] [Ops] **探针结论收口：港股午休的供应方状态字面量**（FR-007; plan §D3; state_branches 2/4; US2）：读回 `broker-hk` 上 `--mode state` 探针的 jsonl（网格 `09:25 / 09:35 / 11:55 / 12:01 / 12:15 / 12:30 / 12:45 / 12:59 / 13:01 / 13:10 / 15:58 / 16:02 / 16:12`），逐拍列出 `market_hk` 的原始字面量；判据 = **逐拍与供应方官方状态表对拍**（2026-08-31 已查证，见 spec Assumptions）——预期值：`09:25 WAITING_OPEN` · `09:35 MORNING` · `11:55 MORNING` · `12:01/12:15/12:30/12:45/12:59 REST` · `13:01/13:10 AFTERNOON` · `15:58 AFTERNOON` · `16:02 HK_CAS` · `16:12 CLOSED`（该网格覆盖了官方表 8 个状态里的 6 个，只差盘前 `NONE`/`AUCTION`）。**本条从「验证未知」降为「确认文档预期」**，不再是设计阻塞项。结论回写 spec `## Assumptions` 那条推断（改成实测陈述 + 逐拍表）。同批归档报价存活曲线的原始 jsonl 供后续离线档片使用。🚨 **收尾必删 `~/nvy-probe`**（清理只有这一条，无 crontab）→ verify: 逐拍表落 `docs/private/plans/2026-08/`；spec Assumptions 那条从「推断」改为「实测」；**证伪时 MUST 停下报 user 并起 T002b**，🚫 禁自行改判据

  > **进度（2026-08-31）—— 午休判据部分已收口，整条 task 未完**
  > - ✅ 逐拍对拍：**13/13 拍全落，13/13 命中，零反例**。午休整段（`12:01`–`12:59` 五拍）逐拍 `REST`；边界两侧 `11:55 MORNING` / `13:01 AFTERNOON`；收盘段 `15:58 AFTERNOON` / `16:02 HK_CAS` / `16:12 CLOSED` 亦全中。**未证伪** ⇒ T002b 判「不适用」。
  > - ✅ spec `## Assumptions` 已从「文档坐实 + 缺实测」改写为**实测陈述 + 逐拍表**（含 A 股 `market_sh` 同拍已 `REST` 的跨市场对照）。
  > - ✅ 逐拍表已落 `docs/private/plans/2026-08/08-31-hk-market-state-probe.md`（local-only）。
  > - ✅ 末三拍已落，顺带实证 `CLOSE_SETTLE_BUFFER_MINUTES.hk = 10`（`16:02` 仍在 CAS、`16:12` 已收）—— 该取值本片不动，只留实测支撑。
  > - ⏳ **报价存活曲线的原始 jsonl 归档**：`--mode chain` 网格 `15:55→22:45` 当日夜间跑完后取回归档。
  > - ⏳ **收尾删 `~/nvy-probe`**：MUST 等上面两项都取回之后才做。
  > - 📌 曲线数据落盘后的下游决策（hk `eod` 轮 / ① 级 / ② 级三个时刻的重定）**不在本片 scope**，已挂 issue #308。

- [X] T002 [P] [Server] **市场时段表：港股恢复两段 + 注释三处更正**（FR-017, FR-018, FR-019; plan §D3a; state_branches 3; US2）：`market-session.rules.ts` 把 hk 的 `segments` 从单段 `[09:30,16:00]` 恢复为 `[09:30,12:00] + [13:00,16:00]`（`halfDaySegments` 不动）；注释更正三处 —— ① 「趁 hk 期权尚未开通落地」这个时机前提已过期 ② 「hk 期权采集仍未开通（`COLD_START_CAPABILITY` 里 hk 是空表项）」**现已为假**（`anchor-cold-start.rules.ts:146` 两档全开）③ 复审触发条件从「将来给 hk 接盘中告警时」扩为「**任何**需要判『此刻能不能成交』的港股消费方」。同名 spec **先红后绿**：① `isWithinTradingSession('hk', 12:30)` 从 `true` 翻 `false`（`:74/:78` 用例与 describe 标题同步改写）② `:104-107`「两谓词不再分道」用例翻成「午休分道」③ `:160-181` 逐分钟等价循环对 hk 加午休段例外 ④ **跨段谓词逐点不变**新增断言：`isSessionUnderway` / `isCloseWriteBlocked` / `sessionCloseMinutes` 三者在 hk 上全天 1440 分钟逐分钟与改动前相同（`spanOf` 取 min/max ⇒ 结构保证，断言把它钉死）⑤ cn / us 全天逐分钟零变化 → verify: 五臂先红 → `pnpm nx test server` 绿；🚨 翻 `:164` 绊线 MUST 在同一 commit message 写明理由（Guardrail 6）；`rg -n "isWithinTradingSession" apps/server/src --glob '!*.spec.ts'` 确认生产调用方仍只有 `alert/` 那一处

- [X] ~~T002b~~ **【不适用 —— 2026-08-31 判定，🚫 不删除，见下】** [Server] **（条件）供应方午休归一化 —— 仅当 T001 与官方状态表不符时执行**（FR-019; plan §D3 条件分支; state_branches 2）：若实测证明供应方在港股午休仍报 `MORNING` / `AFTERNOON`，则在 `futu-market-state.adapter.ts` 的 `normalizeSession` 侧对 hk 交叉本地时段表（该适配层在 marketdata 内 ⇒ 可 import `market-session.rules.ts`），午休降为 `'other'`。🚫 **MUST NOT 改到 optionsdesk 侧**（Guardrail 5）。依赖 T002 的两段表 → verify: adapter 同名 spec 先红后绿（午休 `MORNING` ⇒ `'other'`；非午休 `MORNING` ⇒ `'regular'`；us 逐值不变）；T001 未证伪 ⇒ 本条标注「不适用」并说明理由，🚫 禁静默删除

  > **判定：不适用（2026-08-31）。** 本条的触发条件是「T001 实测证明供应方在港股午休仍报 `MORNING` / `AFTERNOON`」。实测结果相反 —— 午休整段五拍逐拍 `REST`，10/10 命中零反例（表见 T001 进度块与 spec `## Assumptions`）。`REST` 不在常规连续交易白名单内 ⇒ 供应方适配层现有的归一化已把午休判成非常规时段 ⇒ **无需任何改动**。
  > 🚫 **不删除本条**：它记录的是「这条分支被实测排除掉了」，而不是「当初想多了」。将来若供应方改变午休状态字面量、或新增一个带午休的市场，触发条件会重新成立 —— 那时要看到的是这条判定与它依据的实测，而不是一段空白。
  > 📌 连带结论：FR-019「午休归一化只许落供应方适配层」在本片**零代码改动**下已满足；期权台不需要、也不许直接 import 时段表（`eslint.config.mjs` 的 `from: optionsdesk` disallow 会直接撞墙）。

- [X] T003 [Gate] **港股取参取证：容差回放 + bootstrap 下界**（FR-002 取证半, FR-003; plan §D2; US1）：① **容差双日回放** —— 用 hk 现有 6 个 session（`2026-08-21 … 08-28`）构造 5 对：D−1 快照 `|Δ| ∈ 带` → moneyness 包络 `×(1 ± pad)` × D 日 spot → 与 D 日真实落带 K 集合比召回率；**达标线 ≥ 95%**（clarify 裁决，与美股同线）。② **bootstrap 下界** —— 双基面取证：08-17 盘中全链探针（3 票 3134 腿）+ 现有 6 个收盘 session，判据 = 「`K/spot` 低到某比例后 bid 几乎必然落在权利金门槛之下」，结论取**更宽（更低）**的一侧。脚本落 `docs/private/evidence/`（local-only，同 069 先例）→ verify: 两个结论各带一张分布表落 spec 新段「取参实测」；🚨 结论 MUST 写「本样本期成立」（5 对 / 6 session / 2 标的），🚫 禁全称（Guardrail 9） —— 📌 **于 2026-09-04 收口**，三条结论落 spec 新段「取参实测」§1/§2/§3。**样本实际比立项时大一个量级**：10 session / **9 对** / **22 只**标的（港股锚 08-31 扩到 22 只），spec 内已按实际样本改写，🚫 上面括号里的「5 对 / 6 session / 2 标的」是立项时的预估、不是结论射程。① **容差达标 ⇒ 维持单值**：pad `0.025` 下 `rent` 98.9%（1569/1586）· `build` 98.4%（669/680），两意图 ≥ 95% ⇒ `MONEYNESS_PAD_RATIO` **零改动**（FR-003 前一分支）；漏腿全是带缘穿越，结构漏 = 0。② **下界 hk 取 0.6**（拐点在 0.55/0.60 之间：条件通过率 `[0.60,0.65)` 30.8% vs `[0.55,0.60)` 10.5%，实时基面同向更高）—— 已由 T004② 落值。③ **EC3 转论证**（见下方预检表）。⚠️ **回放口径订正**：同合约多来源选行改 `eod` 优先（决策 A，user 2026-09-04 裁决），**生产读端蓄意不动** —— 073 已退役港股盘前补救轮、prod 的 `premarket_backfill` 止于 08-28，而全局改会动美股 greeks 更全的 backfill 行、撞 SC-004。⚠️ **未覆盖**：两个基面都偏收盘口径（下界的多标的**实时**复核挂 2026-09-07 港股交易日）

- [X] T004 [Server] **窗能力表加港股 + bootstrap 取参落值**（FR-001, FR-002 落值半, FR-003 落值半, FR-012; plan §D1a/§D1b; state_branches 1/8/12; US1）：`leg-window.rules.ts` ① `WINDOW_SUPPORTED_MARKETS` 加 `'hk'`（`isSupportedMarket` / `bootstrapWindowFor` 的 throw **零改动** —— 纵深防御自动对 cn 仍生效）② 下界 `STRIKE_ENVELOPE_FLOOR_SPOT_RATIO` 按 T003 结论转 **per-market 具名常量表**（仍住本文件 = 单点不破）③ 上界保持单值 + 补注释写明其构造性成立（Guardrail 4）。`leg-delta-surface.rules.ts` 的容差按 T003 结论决定动不动（达标 ⇒ 不动 + 附证据）。同名 spec **先红后绿**：① `bootstrapWindowFor('hk', spot)` 返港股取值 ② `bootstrapWindowFor('cn', spot)` 仍 throw（FR-009 纵深防御）③ us 取值逐值不变 → verify: 三臂先红 → 绿；`pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0；**自证守卫能红**：临时把 per-market 表改成内联 `.times(new Prisma.Decimal('0.7'))` → 脚本红 → 还原（变异留档，Guardrail 3） —— 📌 **① 随 #310 ship**（`WINDOW_SUPPORTED_MARKETS` 加 `hk`，`bootstrapWindowFor` / `isSupportedMarket` 函数体零改动）。**②③ 于 2026-09-04 落**：下界转 `STRIKE_ENVELOPE_FLOOR_SPOT_RATIO_BY_MARKET`（us `0.7` 逐值不动 = SC-004 / hk **`0.6`**），上界蓄意保持单值 `1.05`（构造性成立：`min(spot,W)×1.03 ≤ spot×1.03 < spot×1.05`，注释已写明）。
  取值依据 = 2026-09-04 直查 prod 22 只港股标的收租段 `K/spot` 分档，**有买价腿**的条件通过率 `[0.60,0.65)` **30.8%** · `[0.65,0.70)` 31.6% · `[0.55,0.60)` 10.5% · `[0.40,0.50)` **0%** ⇒ 拐点在 0.55/0.60 之间；同向第二样本 = 08-31 盘中实时全链（hk:00700）`[0.60,0.65)` 43.3% · `[0.65,0.70)` 55.6%。码数非约束（降到 0.5 时最大单票 185 条 « vendor 400/批）。⚠️ 落值当天只有 **EOD 口径**多标的样本（低档带价腿仅 72 条），**实时口径复核排 09-07**（下一个港股交易日）。
  🚨 **撞值登记**：hk 的 `0.6` 与 `anchor.rules.ts` 的 `ZONE_FLOOR_COEFFICIENT` **字面撞值**（同为「六成」这个自然比例点，语义无关）⇒ 按 `leg-delta-surface` 先例给 `check-optionsdesk-rule-constants` 的 #1 面登记 `leg-window.rules.{ts,spec.ts}` **整文件豁免**（覆盖缺口已在守卫注释写明；该文件参数由 #9 守）。守卫自证已做：内联 `.times(new Prisma.Decimal('0.7'))` ⇒ #9 当场红，已还原。
  🚨 **per-market 化是缓解不是根治**（issue #308）：28 只港股锚里 bootstrap 首日收租恒空数 **8 → 3**（`hk:00005` 上界 0.428×spot · `03690` 0.434 · `01810` 0.464 仍撞）；美股同形态未修（`us:APA` 0.635×spot，受 SC-004 约束本片不动）。🚫 MUST NOT 靠继续调低下界去追 —— `[0.40,0.45)` 档条件通过率实测 0%。spec 有专臂钉住这条，防止有人据此关掉 #308

- [X] T005 [Server-IT] **实时路径业务日基准换市场 + 等价性 + 周一臂**（FR-004, FR-005, FR-006, FR-006a, FR-012; plan §D1c; state_branches 10/11; US1）：`leg-retrieval.adapter.ts:286` `exchangeCalendarDate('us', query.now)` → `exchangeCalendarDate(parsed.market, query.now)`；`:608` 与比较符**一律不动**（Guardrail 1/2）。**新建** `optionsdesk-071.hk-realtime.it.spec.ts`（Testcontainers 真 DI）**先红后绿**四臂：① **周一臂** —— 时刻夹具 = 港股周一盘中（北京 10:00），断言闸判**开市**（改前折算出周日被判 `non-trading` ⇒ 闸 `closed`、零降级标；这条不设断言就看不出修没修）② **等价性（FR-006a）** —— 换基准前后 us 与 hk 的候选集**与其排序**逐值相同（拦「顺手把 `>` 改成 `>=`」）③ 离线路径响应逐值零变化（FR-006 机器判据）④ 链级 `sessionDate` / `marketDate` 在 hk 上等于港股当地日历日 → verify: 四臂先红 → `pnpm nx test server apps/server/test/integration/optionsdesk-071.hk-realtime.it.spec.ts` 绿；定向变异（改回 `'us'`）① 臂红、（改 `>=`）② 臂红，双变异留档

- [X] T006a [Server-IT] **正常态 + 意图分叉 + 时段态（7 臂）**（FR-007, FR-008, FR-016, SC-001, SC-005; plan §D1d/§D3/§D6; state_branches 1/2/4/5/13; US1/US2）：在 T005 建的 IT 里补齐（全部 **fixture 播种**，🚫 禁依赖真锚形态——全库仅一只港股锚能跑通收租）：① 港股盘中 + 基准新鲜 ⇒ 走实时窄召回、`priceKind='realtime'`、时点为**秒级时刻**且与本次取数时刻同源（SC-001）、零降级标 ② **建仓视角同样走实时，且其窗与收租视角的窗不同**（US1-AS2：两视角各自的预测落带 ⇒ 断言两次请求的窗内 code 集合不相等；判据来源是意图→带的单点映射，hk 零新分支） ③ **报价覆盖对拍（SC-005）** —— fixture 令窗内 N 条腿、供应方返 M 条有报价（M &lt; N），断言候选集里带实时报价的腿数**恰为 M**：不多（不凭空造）不少（不额外丢腿） ④ 午休（供应方非 regular）⇒ 中性收盘档 + **零对外呼** + 零降级标 ⑤ 半日市下午 ⇒ 同 ④ ⑥ 非交易日 / 盘前 / 盘后 ⇒ 同 ④ ⑦ 全腿视角 ⇒ 回落收盘档全量 + 零对外呼 → verify: 七臂先红后绿；每臂各做一次定向变异证明能红（变异清单落 PR 描述） —— 📌 **于 2026-09-04 落**，七臂全部落在既有 `optionsdesk-071.hk-realtime.it.spec.ts`（12 个 `it()` 全绿）。变异清单（生产侧一处 / 当场红的臂）：`quoteAsOf` 改取基准时刻 → **①** · DTE 段不再随意图变（取两段并集）→ **②** · 实时批缺行的腿改按骨架成行 → **③** · 时段闸只把 `unknown` 当关闸 → **④+⑤**（同一道供应方闸的两种形态，共用一处变异是设计使然）· 日历闸只把 `unknown` 当关闸 → **⑥** · 全腿视角当单意图处理 → **⑦**。🚨 **两条假变异留档**：① 对调两意图 DTE 段打红 7 条（含②但射程太宽，不算定向）② 打在 `perspectives.length !== 1` 上的「全腿」变异**幸存是假的** —— `['all']` 长度本就是 1，判据在下一行。⚠️ **顺带查实的坑**：`MARKETDATA_PROVIDER=mock` 档下 `TRADING_CALENDAR_PORT` 绑的是 `MockMarketDataAdapter`（星期判据，从不查 `trading_day`）⇒ 本 IT 里 `seedCalendar()` 播的两张表**不驱动实时闸**，要驱动日历闸只能换时刻（星期几）；判据与实证已写进 `seedCalendar` 的注释

- [X] T006b [Server-IT] **空态 / 降级态 / 守卫 + 反例 fixture 迁移（7 臂）**（FR-009, FR-010, FR-011, FR-016; plan §D1a/§D1d/§D6; state_branches 6/7/8/9/12; US1/US3）：续上 IT：① 新锚首日无昨日面 ⇒ 走 bootstrap；**并覆盖「兜底窗圈出的码数超单批上限」的显式处置**（EC3：落既有超限降级值而非静默截断；若 T003 的码数分布证明港股结构上不可达，则改为论证 + 在预检表标明，🚫 禁默认它不会发生） ② 窗内无腿 ⇒ 「规则内无腿」显式空态（非降级非错误），**且响应可回答「为什么空」**（EC2：断言空态携带既有页级四态的成因语义，不是一张没有理由的空表） ③ 无挂牌期权的港股锚 ⇒ 既有终态、不抬告警、与「有期权但今天没采到」可区分 ④ 基准陈旧且补不到 ⇒ 落「实时不可用」而非「源不可用」（两者可区分） ⑤ 供应方取数失败 / 超时 ⇒ 「源不可用」 ⑥ **反例 fixture 迁移** —— `optionsdesk-068.two-stage.it.spec.ts:569-579` 臂② 从「hk = 未支持市场」翻成「hk 走实时」正例；未支持反例换 `cn`（`seedChain` 直接播种、不经建锚校验；先确认 `parseAnchorTicker('cn:…')` 不拒，拒则降为 `bootstrapWindowFor('cn', …)` 纯函数 throw 单测并写明降级理由） ⑦ 降级值域四值不变（FR-010 机器判据） → verify: 七臂先红后绿；`pnpm nx test server` 全绿；每臂定向变异留档 —— 📌 **于 2026-09-04 落**：①②③④⑤⑦ **六条新臂**落进 `optionsdesk-071.hk-realtime.it.spec.ts`（该文件 18 个 `it()` 全绿）；**⑥ 不重复造** —— 反例 fixture 迁移已随 #310 落地（`optionsdesk-068.two-stage.it.spec.ts` 臂② 已迁 `cn` 且留「会失效的断言」、新增臂②b 把 hk 翻成正例、`leg-window.rules.spec.ts` 有 `cn` 纯函数 throw 单测），本片只核验它们仍绿。**EC3 转论证不造夹具**（T003 §3：10 session × 22 标的、下界按落值 0.6 计，最大 234 vs 上限 399）—— 🚫 但断言注释里写明「这不等于它不会发生」。变异清单（生产侧一处 / 红的臂，**六条零串扰**）：bootstrap 下界改回美股档 → **①** · 权利金门槛挡下的腿不再计数 → **②** · 无挂牌合约不再走终态 → **③** · 基准落空改标源不可用 → **④** · 取数失败改标闸未知 → **⑤** · 降级值域加第五个值 → **⑦**。🚨 **两处自查抓到的坑**：① P3 的靶串在 adapter 里命中 **2 次**（实时一处 / 收盘一处），脚本的 `assert count==1` 当场拦下盲改 ② 臂③ 初版夹具连标的行都不建 ⇒ `null` 其实来自「查不到 instrument」那条更早的分支，**测到别的东西上去了**；已改成「标的在册、零期权合约」的真实形态

- [ ] T007 [Gate] **行军参数在港股的适用性判定（单向否决，不是标定）**（FR-013, FR-014; plan §D5; state_branches 14; US1）：复用 069 回放脚本（`docs/private/evidence/069-replay-calibration.ts`，local-only）改造入口喂 hk 收盘链，跑**三条判据**：① 形状类条件在港股净链上的触发率与美股**同量级**（不显著偏高——偏高 = 把常态噪音当异常，表现为推荐档莫名其妙地短且不报错）② 流动性下限不致港股收租候选**整梯清零**（清零梯占比不高于美股基线）③ 档界参数货币无关、直接沿用。🚨 **「同量级 / 不显著」是人工看表裁决，不是自动门** —— impl 期把三张对照表呈给 owner，由其判过不过，🚫 禁自行拍一个倍数当阈值。**三条全过**才放开 `get-legs.usecase.ts:705` 门控为 `perspective === 'rent'`，并把 `optionsdesk-070.offline-ladder.it.spec.ts:405-414` 臂④ 翻成正例；**任一不过**则门控不动、结论落 spec 并起后续标定片 → verify: 三判据各出一张对照表落 spec 新段 + owner 裁决记录；🚨 本条是**判定**不是标定 —— 发现要调 φ/β/γ/`OI_MIN` 任一取值 ⇒ 停下报 user（Guardrail 8）；放开时门控改动须有 IT 臂（hk 收租 march 非 null）+ 070 臂④ 同步翻面

- [X] T008 [P] [Contract-Smoke] **契约冒烟：港股 symbol 下的选约表**（FR-011, FR-015, SC-007; plan §D6; US1/US3）：**新建** `071-hk-realtime.contract.ts` —— 生成的 `@nvy/api-client` 打 testcontainers 真 server（mock provider 档）：① 港股 symbol 请求收租/建仓视角均返 200 且响应**形状与美股逐字段同形**（同一套断言换 market 即可跑，无分支——SC-007 的机器判据）② 降级值域仍是四值（FR-010）③ 专属 ticker + 末尾自清理。🚨 该覆盖**今天为零**（`legs` / `chain-report` 在港股 symbol 下只有一条 server IT）→ verify: `MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm nx run mobile:contract-smoke` 绿；契约零新增字段（`git diff packages/api-client` 应为空 —— 有 diff 即违 FR-011，停下） —— 📌 **于 2026-09-05 落**：新建 `apps/mobile/e2e/contract-smoke/071-hk-realtime.contract.ts` + `run.ts` 注册一行。夹具 = **两市同码**（`us:NVYE` / `hk:NVYE`）的三腿等值收盘快照（DTE 24 / 60 / 120 ⇒ 建仓段与收租段各自非空 —— 两视角都空的话对形退化成恒真断言）。断言分三层：① **与市场无关**的逐份不变量（200 / `available` / 非空 / `eod_close` / `realtimeDegrade` = `gate_unknown` / 每腿 `bandStatus` 键在），同一个函数两市各调一次 = SC-007「无分支」的字面兑现 ② `shapeSignature` 逐字段对形（「路径 → kind 集合」再 `deepEqual`，数组元素并到同一路径 ⇒ 某一腿少一个键也拦得住）③ `march` / `marchMode` **不进对形**、由 `assertMarchGate` 单钉并做成绊线（T007 放开港股收租门控当天它第一个红）。②③ 两条 verify 已落：降级值域四值断言在文件内；`git diff packages/api-client apps/server/openapi.json` **空**。
  变异清单（生产侧一处 / 当场红的靶心，**三条零串扰**，均已还原）：`toLegTableResponse` 的 `spot` 改成只给美股 → **对形臂**红（报文原样：`仅美股有: spot: string` / `仅港股有: spot: null`）· `marchBlock` 的 `market !== 'us'` 反相 → **march 门控臂**红 · `retrieveRealtimeNarrow` 里 `gate === 'unknown'` 的回落标改成只给美股 → **降级标臂**红（`got null`）。
  🚨 **一处如实登记（本环境验不到「港股接上实时」）**：mock 档下 `MARKET_STATE_PORT` 是 054 拒绝壳 ⇒ 闸恒 `unknown`，而 `leg-retrieval.adapter.ts` 的 `retrieveRealtimeNarrow` **闸判之后立刻回落**（早于 #286 市场 guard、早于定窗基准）⇒ 071 改的三处（业务日基准换市场 / 窗白名单加 `hk` / bootstrap 下界 per-market）在本环境**结构上执行不到**，两市的 `gate_unknown` 在 071 之前就是这个值。本 task 守的是**契约面**（FR-011 / SC-007），实时接线的判据在 T006a / T006b 的 13 臂与 T010。文件头已写明，🚫 MUST NOT 把它读成实时接线的证据。
  ⚠️ **verify 命令未整体绿：`31/32 passed`** —— 唯一红的 `optionsdesk-chain-leg-picker (047)`（`legs(rent)` 的腿序在设水位前后翻了：`RENTSTAY` / `RENTDROP` 对调）是**先于本片存在**的 main 缺陷：nightly `e2e-real-backend` 自 2026-09-01 起连红 4 次（末次绿 2026-08-30），已跟踪在 [#317](https://github.com/zhangleizlpd/no-vain-years-tech/issues/317)。本片**零生产代码改动**，且 047 在 `SPECS` 里排在本片之前、用的是另一只 ticker ⇒ 与本 task 无因果。**归属未定，不在本 PR 处置**（初步方向：精排入参含 `isDeltaInIntentBand` ⇐ `isRecommended` ⇐ 标的级意图 ⇐ 水位 ⇒ 那条「顺序不因水位变」的断言与实现相互矛盾 —— 推断，未验证）

- [ ] T009 [Gate] **SC 收口 + ADR-0068 回写 + PR 门**（SC-001, SC-004, SC-005, SC-006, SC-007; FR-010 落档, FR-018 收口; plan §D3/§D4/§D6; US1/US2/US3）：① **SC-001** = T006a-① 臂留档；② **SC-004**（美股逐值相同零例外）= T005-②③ 臂留档；③ **SC-005** = T006a-③ 对拍臂留档；④ **SC-006**（每条状态分支有断言且能红）= T006a/T006b 变异清单留档；⑤ **SC-007** = T008-① 留档；⑥ **ADR-0068 回写** —— sunset trigger #1 标注消费（裁决 = **不升格降级态、值域不扩**，理由：两者对用户是同一件事，而扩值域要连带动契约值域、四条穷举文案与前端穷举映射）+「后果·仍并存」段的 ② hk 锚收租按 T007 结论更新；⑦ spec frontmatter `status → implemented` + `updated_at` bump → verify: `git fetch origin && pnpm nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` exit 0 + gate 脚本（server-moat / test-size / optionsdesk-rule-constants / time-semantics / identifier-boundary / repo-layout）全 0；🚨 跑门前必 `git fetch`（066 因此报过一次假全绿）

- [ ] T010 [Ops] **部署后真时段验收（合并后勾，带到期日）**（SC-002, SC-003; plan §D6; state_branches 1/2; US1/US2）：prod 部署后，连续 **3 个港股交易日**在港股连续竞价时段各抽查 ≥1 次 —— 断言 ① 港股锚选约表无降级横幅、档位条呈秒级时点（SC-002）② 午休时段请求落中性收盘档、零告警、零对外呼（SC-003）。🚨 **本条 MUST 带到期日并挂 issue** —— 同类 task 在 066 因为没有到期日而至今未勾、把那份 spec 永久卡在 `implementing`，本片 MUST NOT 重蹈：开 task 时同步建 issue 并写明「部署后第 3 个港股交易日为到期日，逾期未勾则在 issue 里记录阻塞原因」→ verify: 三次抽查各留一条记录（日期 + 时刻 + 截图或响应片段）回填本条；issue 号回填本行 —— 📌 **跟踪 issue #314**，**到期日 2026-09-03**（部署后第 3 个港股交易日；08-31 部署当日港股已收盘 ⇒ 首个可抽查日为 09-01）
  📌 **登记（2026-09-04）**：原到期日逾期 0/3，阻塞原因（无人执行、无技术阻塞）已补记 #314。**抽查 1/3 完成**（09-04 10:36 盘中，Mate50 release 0.16.0 打 prod）：收租视角 `实时 10:36:51` 秒级 + 无降级横幅 = SC-002 PASS，截图留 `docs/private/evidence/071-t010-spotcheck-1-*.png`；同刻建仓视角因 vendor 活列死码毒批回落收盘档（外因，非本 feature 缺陷，处置 → #342 / FutunnOpen/py-futu-api#261）。到期日重设待 owner 裁决（见 #314 末条）。

## 依赖与并行

```text
T001 [P]（探针收口）───────────┬─(证伪时)→ T002b ──┐
T002 [P]（时段表两段+注释）────┘                    │
T003（取参取证）→ T004（窗能力+落值）→ T005（基准换市场+等价性）→ T006a（正常/意图/时段 7 臂）→ T006b（空态/降级/守卫 7 臂）→ T007 → T009 → T010
                                                                                                        └─→ T008 [P] ──────────┘
```

- **T001 / T002 / T003 三条起手可并行**（不同文件面、互不依赖）。
- **T002b 是条件 task** —— T001 未证伪则标「不适用」，🚫 禁静默删除。
- **T006a → T006b 顺序而非并行** —— 同一个 IT 文件，避免并行改同文件。
- **T010 在 PR 合并后执行**（clarify 裁决：部署后验收，不阻塞合并）。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序** —— 本表是派生物，spec 那份数组才是 SoT（zod 强制）。2026-09-04 实撞：本表曾把 spec 的 #9「窗内无腿 ⇒ 空态」排在末位，spec 的 10–14 在这里成了 9–13，而各 task 的 `state_branches n` tag 全跟着本表写 ⇒ 表内自洽、与 spec 全错位。改 spec 顺序 MUST 同步改本表与所有 tag。

| # | branch | 落点 |
| --- | --- | --- |
| 1 | 港股盘中走实时窄召回 | T006a-①② + T005-④ + T008-① |
| 2 | 午休判非开市、中性呈现、归一化落供应方层 | T001（**已实测，10/10 命中**）+ T006a-④ + ~~T002b~~（条件分支**未触发**，判定见该条） |
| 3 | 本地表两问答案相反 | T002-①②③④ |
| 4 | 非交易日 / 收盘后 / 盘前 | T006a-⑥ |
| 5 | 半日市下午 | T006a-⑤ |
| 6 | 基准陈旧 ⇒「实时不可用」 | T006b-④ |
| 7 | 取数失败 ⇒「源不可用」 | T006b-⑤ |
| 8 | 新锚首日 bootstrap | T004-① + T006b-① |
| 9 | 窗内无腿 ⇒ 显式空态 | T006b-② |
| 10 | 当天到期腿不进候选、换基准前后恒等 | T005-② |
| 11 | 美股逐值零变化 | T005-②③ |
| 12 | 未支持市场守卫仍在 | T004-② + T006b-⑥ |
| 13 | 全腿视角回落收盘档 | T006a-⑦ |
| 14 | 港股收租默认不出阶梯、且是显式判定 | T007 |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC | 落点 | 形态 |
| --- | --- | --- |
| SC-001 数据时点与取数时刻同源 | T006a-① | 自动断言 |
| SC-002 盘中零降级横幅 | T010 | **人工抽查（部署后）** |
| SC-003 午休零告警零外呼 | T010 + T006a-④ | 人工抽查 + 自动断言（后者是夹具态，前者是真时段） |
| SC-004 美股逐值相同零例外 | T005-②③ | 自动断言 |
| SC-005 报价覆盖对拍（不多不少） | T006a-③ | 自动断言 |
| SC-006 每条分支有断言且能红 | T006a / T006b 变异清单 | 变异留档 |
| SC-007 契约层零形状差异 | T008-① | 自动断言 |

## Edge Case 覆盖预检（标准矩阵扫得到，但零覆盖必须写明「蓄意」）

| EC | 落点 / 判决 |
| --- | --- |
| EC1 无挂牌期权 | T006b-③ |
| EC2 结构必空且可解释 | T006b-② |
| EC3 bootstrap 超单批上限 | T006b-① + T003 的码数分布 —— **已转论证**（T003 §3：10 session × 22 标的、下界按落值 0.6 计，最大兜底窗码数 **234 vs 上限 399**，本样本期不可达）⇒ T006b-① 不造超限夹具，在预检表标明即可 |
| EC4 当天到期腿 | T005-② |
| EC5 周一效应 | T005-① |
| **EC6** 会话内切市场、时点不互相污染 | **蓄意零覆盖** —— server 侧读路径无状态（每请求各自 `parseAnchorTicker` → 各自判闸取数），前端零代码改动；结构上不可能污染，不为一个结构性不可能态造夹具 |
| **EC7** 缺希腊值的行照常出现 | **继承既有** —— 该行为在采集侧与呈现侧均已实装并有断言（066 数据面 + 既有档位不可定语义），本片零新分支，不重复设臂 |
| **EC8** 每次请求按自己市场判闸 | **蓄意零覆盖** —— 两市时段永不重叠 ⇒ 「同刻两市都开市」不可构造；「按自己市场判闸」由 T005-①④（基准换市场）与 T006a 全组的 per-market 夹具共同承载。供应方状态端口的短 TTL 缓存不违反本条（缓存的是全市场单键原始状态，非闸结论） |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层，046 曾两轮全漏）

| AS | 落点 |
| --- | --- |
| US1-AS1 收租视角实时 | T006a-① |
| US1-AS2 建仓视角独立窗 | T006a-② |
| US1-AS3 两市各自盘中、范式同构 | T008-①（形状同形）+ T005-②③（美股逐值不变）—— ⚠️ 两次**不同时刻**的请求，AS 措辞已于 analyze 期订正 |
| US1-AS4 窗内无腿显式空态 | T006b-② |
| US2-AS1 午休中性零外呼 | T006a-④ + T001 |
| US2-AS2 半日市下午 | T006a-⑤ |
| US2-AS3 非交易日与美股同构 | T006a-⑥ |
| US3-AS1 取数失败⇒源不可用 | T006b-⑤ |
| US3-AS2 基准陈旧⇒实时不可用、可区分 | T006b-④ |
| US3-AS3 未支持市场守卫 | T004-② + T006b-⑥ |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **SC-002 / SC-003 无 CI 断言** —— 只能在真实港股交易时段验，clarify 裁决为部署后验收（T010），**不是遗漏**。
- **无 `[Mobile]` task** —— 前端零代码改动是 plan §D4 逐项核过的结论（`MARKETS_WITHOUT_INTRADAY` 已空、四条降级文案穷举 `Record` 不动、档位判定不认 market），故不设 e2e 交互臂。
- **无 `[Contract]` task** —— 契约零新增字段；T008 的 verify 反过来断言 `git diff packages/api-client` 为空，把「没改契约」也机器化。
- **EC6 / EC7 / EC8** —— 判决见上表，三条均为结构性成立或继承既有，非遗漏。
- **报价存活曲线** —— T001 只归档原始数据，**判读归后续离线档片**（本片 Out of Scope）。
- **午休信息空洞**（[#301](https://github.com/zhangleizlpd/no-vain-years-tech/issues/301)）—— 独立产品决策，本片显式不动。

## Implementation Strategy

MVP = **T003 → T004 → T005**（取参 + 窗能力 + 基准换市场：到这里港股锚在盘中已经能拿到实时档，红字与周一静默两个坏法同时消失）。T001/T002 起手并行、不阻塞主线。T006a/T006b 补齐状态分支穷举，T007 决定行军门控放不放，T008 补契约冒烟，T009 收口，T010 合并后验。

Clear 检查点批次：`T001-T002-T003` / `T004-T005` / `T006a` / `T006b` / `T007-T008` / `T009` / `T010`（每批次后停顿提醒 `/clear`，per Constitution §III；T006a / T006b 各自单独成批 —— 每条 7 臂，合起来会突破 atomic task 的 2h 上限，analyze 期 A1 已裁）。
