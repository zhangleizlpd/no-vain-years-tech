---
feature_id: 066-hk-option-cold-start
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-22'
updated_at: '2026-08-22'
---

# Tasks: 066-hk-option-cold-start（港股期权接入与锚冷启动开通港股）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0043`](../../docs/adr/0043-server-flat-module-paradigm.md)（扁平 / 贫血 / 护城河）+ [`ADR-0047`](../../docs/adr/0047-marketdata-pluggable-data-access.md)（port + per-adapter 约束档 + 基准敏感维度不得静默换源）+ [`ADR-0035`](../../docs/adr/0035-data-layer-governance.md)（migration 治理）+ [`ADR-0040`](../../docs/adr/0040-multi-layer-test-gate.md)（EXHAUSTIVE BRANCHING）+ [`ADR-0066`](../../docs/adr/0066-time-semantics-ubiquitous-language.md)（四条时间轴）
**Branch**: `066-hk-option-cold-start`

**一句话**：行情网关本来就认港股（已实测），要改的是 server 侧**四张市场映射表 + 三个独立维度行 + 一条以锚集为闸的工作集判据**；而开通港股会**激活一个今天够不到的既有不变量缺口**（T03），不修则港股次新股锚永远没日线。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Ax）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。本片的并行组：**T01 / T02 / T03 三者互不依赖**（各改各的文件，彼此无序约束 —— 约束只存在于 T01→T04、T02→T04、T03→T06 这三条**下游**边）；**T08（标的 IV）与 T10（实时报价）彼此独立、也独立于 T01–T07 那条链**；T12 独立于全部 server task。⚠️ T13 依赖 T12（e2e 断言要等 rules 改完），**不是**并行对。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Mobile]` / `[Mobile-E2E]` / `[E2E]` / `[Manual]`。**本片无 `[Contract]`** —— 零 controller / DTO 改动 ⇒ 无 OpenAPI 变更 ⇒ 不需要 api-client regen。
- 🚨 **FR / SC 一律逐条枚举，禁写 `FR-004~FR-008` 这类范围记法** —— 本仓自审纪律是逐条 `grep`，范围记法会让中间几条每次都被报成零命中。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 期权链适配器（改：认 hk + `'N/A'` 规范化） | `apps/server/src/marketdata/futu-option-chain.adapter.ts` |
| 期权快照适配器（改：认 hk） | `apps/server/src/marketdata/futu-option-snapshot.adapter.ts` |
| 标的 IV 适配器（改：认 hk） | `apps/server/src/marketdata/futu-underlying-iv.adapter.ts` |
| 实时报价适配器（改：认 hk） | `apps/server/src/marketdata/futu-realtime-quote.adapter.ts` |
| 实时报价市场路由（改：补 hk 槽位） | `apps/server/src/marketdata/marketdata.module.ts` |
| 维度执行器（改：锚作用域工作集） | `apps/server/src/marketdata/dimension-executor.ts` |
| 冷启动判据层（改：能力表 + 结局值域 + 日线判据显式化） | `apps/server/src/marketdata/anchor-cold-start.rules.ts` |
| 冷启动编排（改：seed 默认值 + 无期权分支） | `apps/server/src/marketdata/anchor-cold-start.usecase.ts` |
| 链发现（改：seed 默认值走同一 helper） | `apps/server/src/marketdata/sync-option-contract.usecase.ts` |
| 交易时段表（改：港股午休还原两段） | `apps/server/src/marketdata/market-session.rules.ts` |
| 标的 IV 纯函数（改：分位样本只数真实观测） | `apps/server/src/marketdata/underlying-iv.rules.ts` |
| 采集闸（**只读参照，勿改**） | `apps/server/src/marketdata/anchor-driven-sync-gate.ts` 的 `ANCHOR_GATED_MARKETS` —— 🚨 **绝不加 hk** |
| migration（**新建** ×1，纯 seed 无 DDL） | `apps/server/prisma/migrations/<yyyymmddhhmm>_seed_hk_option_dimensions/` |
| 冷启动 IT（改：补港股分支） | `apps/server/test/integration/marketdata.cold-start-060.market-outcome.it.spec.ts` |
| 港股期权 IT（**新建**） | `apps/server/test/integration/marketdata-066.hk-option.it.spec.ts` |
| vendor fixture（**新建**，PoC 原始响应） | `apps/server/src/marketdata/__fixtures__/hk-option-*.json` |
| 雷达纯函数（改：去掉 hk 的无盘中标记） | `apps/mobile/src/optionsdesk/radar.rules.ts` |
| 文案（改：常驻说明下线） | `apps/mobile/src/optionsdesk/optionsdesk-copy.ts` |
| 雷达 e2e（改：双向断言反转） | `apps/mobile/e2e/optionsdesk-anchors-radar.spec.ts` |
| U2 采样器（**仓外**，一次性取证） | `broker-hk:/home/admin/nvy-u2/` —— 收尾必删，见 T16 |

## 🚨 排序铁律（违反会产生不可部署或静默错数的中间态）

1. **T01 → T04**：适配器不认 hk 之前 seed 维度，维度一跑就 throw。
2. **T02 → T04**：锚作用域工作集**必须先于**维度 seed。反了的话 `hk_option_contract` 上线那一刻工作集是**整个港股 universe**，链发现（单 code 接口 × 每票多窗）会炸成小时级墙钟并占满 10/30s 的桶。
3. **T03 → T06**：`needSync` seed 缺口必须**先于**开通冷启动。T06 是让 seed 路径变可达的那一步，反了就会在窗口期内建出永久没有日线的港股标的。
4. **T06 → T07**：时段闸与放弃路径要验的分支，前提是冷启动对港股已开通（否则第 1c 步就返回，那些分支根本够不到）。
5. **T09 是 P1 故事的真正终点，且它被 U2 卡着**：在 HKEX 的 OI 归属日实测出结论之前，`COLD_START_CAPABILITY.hk.optionSnapshot` 保持 `false`、`hk_option_daily_snapshot` 保持 `enabled = false`（spec `FR-016`）。⇒ **T01–T08 可以照常推进并各自合入**，只有快照那一档等 08-25。🚨 别为了"让 SC-001 早点绿"提前翻这两个开关 —— 归属错了不报错，只让持仓量整体偏一天。
6. **T10 的四处改动必须同一个 task**（含港股午休还原）。漏第三处 ⇒ 午休盘口被当成盘中价写进锚表，雷达照常渲染、排序照常成立、**没有任何断言会红**。
7. **T14 → T15**：wg1 隧道是 E2E 实跑的硬前置。PoC 走 SSH 在港机本机打不需要它，T15 要让**本机的 NestJS 进程**连 shim，SSH 打不通这条。

---

## Server

- [ ] T01 [P] [Server] **期权链 / 快照适配器认 hk + `'N/A'` 规范化**（`FR-001`, `FR-004`, `FR-005`, plan §A8, §A11）：两个适配器的 `MARKET_TO_FUTU_PREFIX` 各加 `hk: 'HK'`（链适配器的反向映射同步加）。🚨 **同 task 修 `strOrNull` 对 `'N/A'` 的处理** —— 网关侧 `clean_value` 只处理空值/非有限数、字符串原样透传（`mappers.py:50-51`），而 `strOrNull`（`futu-option-chain.adapter.ts:98`）是「非空字符串即返回」⇒ 字面量 `"N/A"` 会被当成一个有效结算方式写进 `settlementMode`；美股返 AM/PM 永远撞不到，**港股每一行都会**。🚫 **MUST NOT 顺手改 `futu-underlying-iv.adapter.ts` 的 `numToString`** —— 那处形态相近但**已经正确**（`Number('N/A')` 为 NaN ⇒ 落 `null`，注释写明「不回落成 0，因为分位上 0 = 一年最低」）。🚨 关联键**只能**用 `stock_owner`：港股合约标识词根是交易所助记符（`HK.TCH260929C460000` 里的 `TCH`），**不是**标的数字代码 `00700`，从标识反推不出标的 —— 美股是可反推形态，别把假设带过来。→ verify: 用 PoC 落进 `__fixtures__/` 的真实港股响应写适配器单测，断 ① 132 行合约全部解析出正确的 `underlying` 与 `strikePrice` / `expiryDate` / `optionType`；② `settlementMode` 落 `null` **而不是字符串 `"N/A"`**（这条是本 task 的核心回归钉）；③ **负例**：传一个未登记市场（如 `cn:600519`）**throw 且零 vendor 调用**，不是静默返空集

- [X] T02 [P] [Server] **锚作用域维度：工作集以锚集为闸，`needSync` 退出谓词**（`FR-006`, `FR-007`, `FR-008`, plan §A3）：新增一张**代码级登记表**（与 `COLD_START_CAPABILITY` 同范式，**一处登记**，禁散进 executor 的 if 分支）声明「哪些维度是锚作用域的」；这些维度的工作集改为 `{ market ∈ scope, status: 'active' } ∩ 锚集`，**`needSync` 不进谓词**。锚集读取复用 `sync-option-contract.usecase.ts:135 seedAnchoredInstruments` 已在用的同一条跨 ctx 只读路径（`// CROSS-CONTEXT-READ:` + `select: { ticker }`），不开新口子。🚫 **MUST NOT 把 `hk` 加进 `ANCHOR_GATED_MARKETS`** —— `anchor-driven-sync-gate.ts:11-18` 粗体写明：关闸路径（`notIn`）放到 cn/hk 会把全部 cn/hk 在市标的一次性移出工作集，**直接打死 22:00 那 18 个理杏仁维度**。→ verify: 🚨 **美股等价性必须是断言不是承诺** —— 构造三种行「有锚 + `needSync=true`」「有锚 + `needSync=false`」「无锚 + `needSync=true`」，断 ① 新旧判据在**美股**上产出**同一集合**（前两种进、第三种不进）；② 第三种行**不**进港股期权维度工作集（这条是港股侧的真闸，`needSync` 恒真给不出任何收窄）；③ 整库零港股锚时港股期权维度工作集为**空**且判定为**成功**（`SC-002`）；④ 既有 `{cn,hk}` 维度（`eod_bar` / `profile`）的工作集**逐元素不变**（`FR-007`, `SC-004`）；⑤ 🆕 **跨维度集合快照对比**（`SC-005`）—— 对**全部**已注册维度各取一次工作集快照，断开通港股前后**美股侧逐维度逐元素相同**。前四条只覆盖「判据」这一层，`SC-005` 要的是「各维度覆盖的标的集合」这一层，缺这条它就只在覆盖表里有名字、正文零命中

- [X] T03 [P] [Server] **修 seed 点破坏「港股 `needSync` 恒真」不变量**（`FR-009`, plan §A4）：`anchor-cold-start.usecase.ts:465` 的 `seedInstrument` 与 `sync-option-contract.usecase.ts:272` 的 `seedAnchoredInstruments` 都**无条件**写 `needSync: false`，理由注在原地（「重算的唯一权威是采集闸」）—— **这条理由只对被闸管的市场成立**。港股没有闸、`sync-universe` 的 update 分支又刻意不写该列 ⇒ 被这两处首建的港股行**永远停在 `false`**，同时被 22:00 的 `eod_bar`、`sync-profile`、backfill CLI 三个消费方静默排除，那只标的**永远没有日线**（而 `daily_bar` 是雷达跌破判据的输入）。⇒ 两处走**同一个 helper**，默认值与 `sync-universe.usecase.ts:107` 对齐（`needSync: market !== 'us'`），注释写明分工：**create 路径定默认值，闸只负责被闸市场的重算**。→ verify: 🚨 **必须自己造反例** —— 用 universe **已收录**的港股票做断言毫无意义（`needSync` 本来就是 `true`，seed 分支根本没跑，绿了什么都没证明）。用一个 `Instrument` 表里**不存在**的港股代码建锚，逼 `seedInstrument` 走 create 分支，断 ① 落 `needSync = true`；② 该行随后**能被 `eod_bar` 的工作集捞到**（`SC-006`，这才是缺口的真实后果面）；③ 同样路径下的**美股**标的仍落 `needSync = false`（不误伤既有语义）

- [ ] T04 [Server] **三个港股期权维度 seed + 依赖边**（`FR-015`, plan §A1）：新建 migration（**纯 seed 无 DDL**）插三行 `market_scope = {hk}`：`hk_option_contract`（cron `0 0 23 * * *`，`batch_size 1`，`history_depth NULL`）· `hk_option_daily_snapshot`（cron `0 30 23 * * *`，`batch_size 400`，**`enabled = false`**，见排序铁律 4）· `hk_underlying_iv_daily`（cron `0 0 23 * * *`，`batch_size 500`，**`history_depth 1095`**）。依赖边：`universe → hk_option_contract` soft、`universe → hk_underlying_iv_daily` soft、**`hk_option_contract → hk_option_daily_snapshot` hard**。🚫 **MUST NOT 给现有维度的 `market_scope` 加 `hk`** —— `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时直接 throw（北京 06:00 时 us=D-1 而 hk=D），而**该 throw 存在的目的就是禁止这种混用**；即使绕过它，混 scope 维度的工作集恒为全 scope，港股休市而美股开市的日子会对港股全量发请求。**cron 为什么是 23:00**（这就是 `FR-015` 的落地点）：22:00 是仓里既有的港股锚点（`eod_bar` + 18 个理杏仁维度全在这一刻），runbook 记「22:00 起、当晚 ~22:30 就位」，而 worker `concurrency=1`，23:00 留余量。→ verify: 🚨 **补 hard 边相邻性断言** —— hard 边要求两端在派生全序里**相邻**（`assertEdgesExpressible`），排错了不是 seed 红、是**夜间 flow 装配运行期 throw** 而 seed 自己跑得绿绿的；照 `dimension-executor.spec.ts` 既有的「047 T003 依赖拓扑守卫」补一条。另断 ② 三行 `market_scope` 恰为 `{hk}`、`hk_option_daily_snapshot.enabled` 为 `false`；③ **三行的 `cron_expr` 解析出的下一触发时刻均晚于同日 22:00、早于次日 00:00**（`FR-015` 的机械断言 —— 写死字符串比对会在有人改 cron 时静默放行）；④ migration 在空库单向可用

- [ ] T05 [Server] **结局值域 8 → 9：`no_option_chain`**（`FR-013`, `FR-014`, `FR-014a`, plan §A5）：`COLD_START_OUTCOME` 加一档，语义是**终态、非错误、不告警**，与 `BACKFILL_INCOMPLETE`（ERROR 级、需人工介入）严格区分。判据**取自库**：该标的 `option_contract` 计数为 0 ⇒ 无挂牌期权；🚫 **MUST NOT 取采集统计量** —— 「有合约但整批被落库前拒掉」那种情形统计量同样为空，两件事会被混成一个。**零 migration**：`anchor_cold_start_run.outcome` 实查是 `VARCHAR(32)` 且**无 CHECK 约束**，新值 15 字符。**这不是可选的润色** —— 港股绝大多数标的没有挂牌期权（实测腾讯 8 / 小米 8 / 海底捞 7 / 药明康德 8 个到期日，而**颐海国际 0、网龙 0**），折进 `backfill_incomplete` 会让每一只无期权的港股锚都产出一条无从处理的告警。→ verify: 断 ① 无挂牌期权的港股标的落 `no_option_chain` 且**不产生 ERROR 级日志**（`SC-011` 前半）；② 有期权但目标交易日快照未落库的落 `backfill_incomplete` 且**产生** ERROR（`FR-013`, `SC-011` 后半，Edge Case 2）；③ 两者可由 `outcome` 字段直接分开统计（零折叠，`state_branches` 8）；④ 美股既有八档行为**逐点不变**（纯增量）

- [ ] T06 [Server] **开通港股冷启动 + 日线判据显式化**（`FR-010`, `FR-011`, plan §A2）：`COLD_START_CAPABILITY.hk` 从空表项改为 `{ deltaDimensions: ['hk_option_contract'], optionSnapshot: false }`（`optionSnapshot` 暂 `false`，由 T10 翻）。🚫 **`deltaDimensions` 不含任何日线维度** —— 港股日线已由 22:00 的理杏仁 `eod_bar` 覆盖，加富途口径会撞 ADR-0047 §6 明禁的「基准敏感维度静默换源」（同一 `(instrument_id, trade_date, adjust='none')` 唯一键两个源抢写，而 `createMany(skipDuplicates)` 让先到的永久占位）。⚠️ **连带必改**：`dataAlreadyPresent`（`anchor-cold-start.usecase.ts:487`）的日线复判现在写的是 `deltaDimensions.length === 0 || dailyBar.count > 0`，港股 `deltaDimensions` 非空但**不含日线** ⇒ 该表达式会要求日线在场而日线不由本维度组保证。**把判据显式化**：按「本市场的 capability 里有没有日线档」判，而不是按「`deltaDimensions` 是否为空」判 —— 否则下一个加市场的人会踩，且踩了不报错。→ verify: 断 ① 港股锚不再落 `market_not_enabled`（`FR-010`）；② 休市时段建港股锚 → 补齐期权合约集（`state_branches` 1 的链那半，快照那半在 T10）；③ 目标交易日数据已具备 → **零对外请求**（`state_branches` 4）；④ 建锚事务回滚 → 不发起冷启动（Edge Case 9）；⑤ 重复投递 → 第二次起零对外请求、零新增行（Edge Case 10）；⑥ 港股 capability 不含日线维度，且 `dataAlreadyPresent` 的日线复判走**显式能力判据**而非 `deltaDimensions.length`（`FR-011`）

- [ ] T07 [Server] **冷启动的时段闸与放弃路径**（`FR-012`, plan §A2）：本 task **不新增实现面**，是把 T06 开通后**变得可达**的四条分支逐条钉住 —— 它们的实现早已存在（`isSessionUnderway` 的盘中闸、日历三态的放弃路径、配额顺延），但**在港股上从未被执行过**，而这四条错了都不报错。→ verify: 断 ① 连续竞价时段建锚 → 补链但**不写任何按交易日归属的快照**（`FR-012`, `state_branches` 2）；② **午休时段建锚 → 判定同盘中，不写快照**（`state_branches` 3 —— 🚨 用 `isSessionUnderway`（**含午休**）的语义，**MUST NOT** 换成 `isWithinTradingSession`；这条与 T11 把港股还原成两段**互不冲突**：前者取 min/max 拆段后逐点不变，后者管的是盘中采价）；③ 交易日历缺港股的行 → 放弃 + 需人工介入记录，**不猜日期**（`state_branches` 6）；④ 交易日历前瞻视野未覆盖港股的今天 → 同样放弃、**不猜口径**（Edge Case 8）；⑤ 供应方配额耗尽 → 顺延、**不记失败**、不破坏已落数据（`state_branches` 7）

- [ ] T08 [P] [Server] **标的 IV 适配器认 hk + 回填跨窗 + 分位样本只数真实观测**（`FR-002`, `FR-018`, `FR-019`, `FR-019a`, plan §A9）：`futu-underlying-iv.adapter.ts` 的 `MARKET_TO_FUTU_PREFIX` 加 `hk: 'HK'`。`hk_underlying_iv_daily.history_depth = 1095` 走既有 `splitBackfillWindows()` —— 🚨 **单个 364 天窗港股只返 244 个交易日、美股 250，两者都不足 `IVP_MIN_WINDOW_TRADING_DAYS = 252`**，只拉一年会让分位恒为 `insufficient_window` **且不报错**。港股历史起点实测 **2023-06-27**（美股 2023-06-26），总深约 3.15 年 / ~773 行。⚠️ **补一条只在港股才够得到的污染路径**：无挂牌期权的标的其概览整行为空值观测（网关返 200 + 整行 `'N/A'`，经 `numToString` 落 `null`），若这类空行累积到 252 就被判「样本充足」，会让一个毫无意义的分位看起来可算 ⇒ 样本判据必须只数**真实有值**的观测。→ verify: 断 ① 港股标的完成首次回填后分位**可算**（`SC-007` 前半）；② 只回填一年（244 行）时分位为「不可算」而**不是** 0（`SC-007` 后半 + `state_branches` 13）；③ 无挂牌期权标的的分位**恒为不可算**，不因空值观测累积而变成可算（`SC-012`）；④ 用 PoC 落进 `__fixtures__/` 的真实港股 `/his-vol` 响应断解析正确

- [ ] T09 [Server] **`oiAsOf` 按市场分叉 + 翻开快照两个开关**（`FR-016`, plan §A6）🚨 **本 task 被 U2 卡着，08-25 出结论后才动**：若实测证明 HKEX 22:00 的 EOD 已把当日 OI 定稿 → 给 `resolveSnapshotSpec` 增一个**按市场的 `oiRefreshedAtEod` 事实位**，由调用方从登记表喂进来（**纯函数仍零 I/O**）；若证否 → 现规则逐字适用，本 task 只剩翻开关。🚫 **MUST NOT 把 `eod` / `premarket_backfill` 两条 `oiAsOf` 路径抹平**（规则层注释明禁）：抹平后永远不会红，但两条路径产出的 OI 差一天，而活跃度排名与 UI 的 `asOf` 都读它。收尾把 `COLD_START_CAPABILITY.hk.optionSnapshot` 翻 `true`、`hk_option_daily_snapshot.enabled` 翻 `true`。→ verify: 断 ① 港股快照的 `oi_as_of` 与实测口径一致（结论进 spec `## Clarifications`，断言引用它）；② 美股两条路径的 `oiAsOf` **逐点不变**（分叉是增量不是改写）；③ 快照落库后 `net_open_interest` / `contract_nominal_value` / `owner_lot_multiplier` 三个港股独有字段**有真值**（PoC 实测 132/132 非空）；④ 希腊值缺失的行**照常在库**并带标注、不丢行（`SC-010`, `state_branches` 20）

- [ ] T10 [P] [Server] **港股实时报价四处连改（含午休还原）**（`FR-003`, `FR-017`, plan §A7）：① `futu-realtime-quote.adapter.ts` 加 `hk: 'HK'`；② `marketdata.module.ts:404` 的 `MarketRoutedRealtimeQuoteAdapter` 补 hk 槽位；③ 🚨 `market-session.rules.ts` 把港股从单段 `[09:30,16:00]` **还原成 `[09:30,12:00] + [13:00,16:00]`**。**四处必须同 task** —— 漏第三处 ⇒ 午休盘口被当成盘中价写进锚表，雷达照常渲染、排序照常成立、**没有任何断言会红**。📌 **还原无回归面（已逐个消费方核实）**：全仓只有两处读这两个谓词 —— `alert/intraday-eval.processor.ts:95` 用 `isWithinTradingSession` 但市场参数**写死** `INTRADAY_MARKET = 'cn'`（`:45`）港股够不到；`anchor-cold-start.usecase.ts:224` 用 `isSessionUnderway` 取 min/max 拆段逐点不变。⇒ 唯一的分段敏感读者是本 task 新接的港股盘中采价。→ verify: 断 ① 港股连续竞价时段实时价投影到锚（`state_branches` 15）；② **午休时段不采、不把午休盘口标成盘中价**（`state_branches` 16，本 task 的核心回归钉）；③ 非交易日 / 收盘后保留收盘档（`state_branches` 17）；④ **半日市当天下午按提前收盘判定**（`state_branches` 18）；⑤ 既有 cn 盘中告警路径**逐点不变**（拆段无回归面的正面实证）

- [ ] T11 [Server] **港股与美股链发现串行、不争配额**（`FR-015`, plan §A10, §A12）：确认 `hk_option_contract` 与 `option_contract` 在**同一个** `marketdata-sync` 队列上、worker 保持 `concurrency: 1` ⇒ 结构上不可能并发。🚨 **这条对 cron 触发与冷启动触发同样成立** —— 冷启动是全系统唯一的非 cron 触发者、建锚时刻由人决定，「错峰 cron」保证不了不争，单队列串行才是真保证。采集端纪律沿用：链**永远只传** `code/start/end/option_type`，**不传** `option_cond_type` / `data_filter`（采集端一旦筛就丢证据且不可回补，vendor 不提供历史交易日的链快照）。**容量参照**（2026-08-22 生产实测）：21 只美股锚一轮 `option_contract` ≈ **8 分钟**，全程占满 10/30s 的桶；港股是**另一轮串行叠加**，估墙钟按相加不按取最大。→ verify: 断 ① 两个维度 job 入的是同一队列名；② 同时入队时**串行完成**、无一方因配额耗尽而失败（`SC-009`, `state_branches` 19）；③ 链请求参数**不含** `option_cond_type` / `data_filter`（采集端全开的机械断言）

## Mobile

- [ ] T12 [P] [Mobile] **港股「无盘中报价」常驻说明下线**（`FR-020`, plan §A7 第 4 点）：`radar.rules.ts` 的 `MARKETS_WITHOUT_INTRADAY` 去掉 `'hk'`（该常量随之变成空数组 —— **保留常量本身**，它是「市场能力表」的落点，删掉会让下一个无盘中市场无处可挂）；`optionsdesk-copy.ts` 的 `marketNoIntraday` 文案随之不再被引用 → 一并清理（本次改动产生的 orphan 必须清）。→ verify: `nx test mobile` 绿；`radar.rules.ts` 的 `marketLacksIntraday('hk')` 返 `false`

- [ ] T13 [Mobile-E2E] **雷达港股页签双向断言反转**（`FR-020`, `SC-008`, plan §A7）：`optionsdesk-anchors-radar.spec.ts:1011-1040` 那条断言现在断的是「港股页签**有**常驻说明」，需反转为「**没有**」，并**保留**美股侧的对照断言（双向，只断单向会让「两个页签都没有」照样绿）。→ verify: `nx run mobile:e2e` 全绿；断言在港股页签**有锚**与**零锚**两种状态下都成立（说明的消失不能依赖有没有行）

## E2E

- [ ] T14 [Manual] **打通本机 dev → `broker-hk` 的 wg1 隧道**（T15 的硬前置）：PoC 阶段走 `ssh $NVY_BROKER_HK_SSH_ALIAS` 在港机本机打 `10.89.0.1:8811`，零基建改动；但 T15 要让**本机的 NestJS 进程**连 shim，SSH 打不通这条。当前实测本机对 `10.89.0.1:8811` **不可达**（`curl` 返 `000`）。→ verify: 本机 `curl -m 5 --noproxy '*' http://10.89.0.1:8811/healthz` 返 **200**，且响应里 `routes` 含 11 条、`version` 非 `unknown`、`opend_connected` 与 `qot_logined` 均为 `true`

  > 备选（若 wg1 provision 成本高）：访客通道 `10.90.0.1:8811` 从本机**已可达**（返 401，token 在 `~/.config/nvy-futu/token`），但它的 nginx 对五个行情端点硬门 `^US\.`。放开成 `^(US|HK)\.` 是可审的小改，但要同步改 `capabilities/capabilities.md`（`install.sh` 的 Gate A 断言两侧集合严格相等，漏一处部署当场红），且**顺带把港股能力给了访客** —— 是不是想要，是另一个决定。

- [ ] T15 [E2E] **真港股锚跑通整链**（`SC-001`, `SC-003`, `SC-006`, plan §Gate 0.1）：**前置 = T14**。本机 `MARKETDATA_PROVIDER=live` + `FUTU_SHIM_URL` 指隧道内的 shim，用 `/anchor-import` 建一只真实港股锚（该 command 原生支持 `hk:`，nginx 那道闸也是 `^(us|hk):`）。→ verify: **逐条查库，不看日志** —— ① `optionsdesk.anchor` 有该行且 `market='hk'`；② `security.outbox_event` 有一条 `optionsdesk.anchor-created` 且已被 relay 消费；③ `marketdata.instrument` 有 `hk:<code>` 且 `needSync=true`；④ `marketdata.option_contract` 有该标的合约行、到期日阶梯**覆盖到远月不截断**；⑤ `marketdata.option_daily_snapshot` 有目标交易日的行，**`iv` 与五个 greeks 的非 null 率 ≥ 95%**（PoC 实测 132/132 = 100%；缺失行必须带 `greeks_complete=false` 而非丢行），`net_open_interest` **有值**；⑥ `marketdata.anchor_cold_start_run.outcome = 'backfilled'`（**不是** `market_not_enabled`、**不是** `backfill_incomplete`）；⑦ `marketdata.daily_bar` 有该标的目标交易日的行；⑧ 雷达港股页签渲染出该锚、`marketCounts` 的 hk 计数 +1。⚠️ **盯住 `backfill_incomplete`** —— 它专盖「跑完了但快照仍不在库」，是链 child 成功完成但零结果时唯一会显形的信号；看到 `backfilled` 也要顺手查第 ⑤ 条，两者不一致说明落库复判有洞。⚠️ 冷启动是**两相**的（worker `concurrency=1`，第一相入队的 flow 在它返回前一个都跑不了），第一相返回后**不要立刻判失败**，等 parent 的第二相跑完。⚠️ 另跑一遍**无挂牌期权**的港股标的（如 `hk:00777`），断落 `no_option_chain` 且**无 ERROR 级告警**

## Polish

- [ ] T16 [Manual] **U2 结论回填 + 采样器拆除**（`FR-016`, plan §A6）：08-25 读 `broker-hk:~/nvy-u2/oi-samples.jsonl`，比周六基线（周五终值原点，`HK.TCH260929C530000: oi=10772 net_oi=9568`）与周一 `post_eod` 的差异 —— **周一 23:00 ≠ 基线** ⇒ 22:00 EOD 已把当日 OI 定稿 ⇒ `oiAsOf = D`，T09 要做分叉；**相等而周二才变** ⇒ 现规则逐字适用，T09 只剩翻开关。🚨 `21:30 pre_eod` 与 `23:00 post_eod` 这一对是**把变化钉在 22:00 这个事件上**的关键，缺了它只能说「隔夜变了」，说不出「是 EOD 那一刻变的」。结论写进 spec 的 `## Clarifications`。🚨 **收尾必做**：`crontab -e` 删四行 + `rm -rf ~/nvy-u2`。这是**仓外 crontab**，`.claude/rules/scheduled-tasks-registry.md` 的 path-trigger **够不到**，只有本 task 看着它（脚本自带 `STOP_AFTER=2026-08-29` 兜底，但那只防长跑、不代替清理）。→ verify: spec `## Clarifications` 有带日期与样本量的确定结论；`ssh broker-hk 'crontab -l | grep -c nvy-u2'` 返 0；`~/nvy-u2` 不存在

---

## 覆盖自查（analyze 阶段请逐条 `grep` 复核，别信本表的历史数字）

| 维度 | 覆盖情况 |
| --- | --- |
| FR-001 | T01 |
| FR-002 | T08 |
| FR-003 | T10 |
| FR-004 | T01 |
| FR-005 | T01 |
| FR-006 | T02 |
| FR-007 | T02 |
| FR-008 | T02 |
| FR-009 | T03 |
| FR-010 | T06 |
| FR-011 | T06 |
| FR-012 | T07 |
| FR-013 | T05 |
| FR-014 | T05 |
| FR-014a | T05 |
| FR-015 | **T04**（cron 排在 22:00 之后）+ T11（彼此不撞） |
| FR-016 | T09 + T16 |
| FR-017 | T10 |
| FR-018 | T08 |
| FR-019 | T08 |
| FR-019a | T08 |
| FR-020 | T12 + T13 |
| SC-001 | T15 |
| SC-002 | T02 |
| SC-003 | T15 |
| SC-004 | T02 |
| SC-005 | **T02 verify⑤**（跨维度集合快照对比） |
| SC-006 | T03 + T15 |
| SC-007 | T08 |
| SC-008 | T10 + T13 |
| SC-009 | T11 |
| SC-010 | T09 |
| SC-011 | T05 |
| SC-012 | T08 |
| `state_branches` 1–21 | 1 → T06（链）+ T09（快照） ｜ 2 → T07 ｜ 3 → T07 ｜ 4 → T06 ｜ 5 → T03 ｜ 6 → T07 ｜ 7 → T07 ｜ 8 → T05 ｜ 9 → T05 ｜ 10 → T02 ｜ 11 → T02 ｜ 12 → T02 ｜ 13 → T02 ｜ 14 → T08 ｜ 15 → T08 ｜ 16 → T10 ｜ 17 → T10 ｜ 18 → T10 ｜ 19 → T10 ｜ 20 → T11 ｜ 21 → T09 |
| **Acceptance Scenario 11 条** | US1: AS1→T06+T09+T15 · AS2→T07 · AS3→T06 · AS4→T03；US2: AS1→T08 · AS2→T08 · AS3→T08；US3: AS1→T10 · AS2→T10（午休） · AS3→T10（半日市） · AS4→T12+T13 |
| **Edge Case 10 条** | 1 无挂牌期权→T05 ｜ 2 有期权但快照未落→T05 ｜ 3 两者不得折叠→T05 ｜ 4 希腊值缺失→T09 ｜ 5 港美同时触发→T11 ｜ 6 停牌→T01 ｜ 7 两地上市→T01 ｜ 8 日历视野未覆盖→T07 ｜ 9 建锚回滚→T06 ｜ 10 重复投递→T06 |

> 📌 **2026-08-22 `/speckit-analyze` 回填 —— 五条发现全部已修**，逐条记在这里免得下次又当新问题发现一遍：
>
> - **C1（映射错）**：`FR-015` 原映给串行那条 task，但真正设 cron `23:00` 的是 T04。已改为 T04 主 + T11 副，T04 补 `FR-015` 引用与一条**机械断言**（解析 `cron_expr` 断下一触发时刻晚于同日 22:00 —— 写死字符串比对会在有人改 cron 时静默放行）。改之前 T04 是**唯一零需求引用**的 task。
> - **C2（引用与断言分家）**：`FR-013` 原引在 T06，断言却在 T05；且 T06 阶段 `optionSnapshot` 仍是 `false`，那条路径根本不可达。已挪到 T05。
> - **C3（SC 层盲区 —— 本仓实证过的系统性盲区）**：`SC-005` 原**只在覆盖表里有名字、task 正文零命中**。已在 T02 加 verify⑤ 跨维度集合快照对比：前四条只覆盖「判据」这一层，`SC-005` 要的是「各维度覆盖的标的集合」那一层。
> - **A1（不可度量）**：E2E 的「greeks 非 null 比例**合理**」已改成「非 null 率 **≥ 95%**，缺失行必须带 `greeks_complete=false`」（PoC 实测 132/132 = 100%）。
> - **D1（Constitution III 原子粒度）**：原 T06 有 9 条 verify、原 E2E 那条把 wg1 ops 前置和实跑捆在一起，都超 2h。已拆成 T06/T07 与 T14/T15。task 数 14 → 16。
>
> 📌 **额外抓到一处探针够不到的**：Path Conventions 里 U2 采样器那行原本写「见 T12」，而 U2 任务当时是 T14 —— **指错了但指向一个存在的 task**，所以悬空引用扫描抓不到。已改为 T16。⇒ 引用类检查不能只查「目标存不存在」，还要查「指的是不是那一个」。
>
> 🚨 **写覆盖表时栽过一次，留在这里当证据**：`state_branches` 那一行初稿从第 9 条起**整体错位**（把 13「美股等价性」错标给 IV 那条、把 21「希腊值缺失」错标给结局那条），成因正是「凭记忆对着写」而不是把 21 条真枚举出来逐条对。改正靠脚本把 frontmatter 的 `state_branches` 编号打印出来比对。⇒ **本表这次对了，不构成它下次仍对的证据**；任何时候要用它，先重跑那个枚举。
