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
4. **T06 → T07**：T07 要钉的四条分支**全部位于能力闸之后**，未开通时一条都不可达。
   📌 **T09 已不在这条链上**（2026-08-23 解绑）：`oi_as_of` 是快照行上的一个**独立日期列**，不进唯一键、与未平仓合约数的**值**无关 ⇒ 写错了是一条**确定性 `UPDATE`** 的事。而不采 = **永久缺口**（供应方不提供历史快照）。同一条不对称性，`sync-option-snapshot.usecase.ts` 对「日历缺行」那条路径早就选了「落库继续、抬 ERROR」——本片照它办，**不再让一个可回改的列卡住整条链**。
5. **T06 必须一次翻两个开关**：`COLD_START_CAPABILITY.hk`（**建锚路径**）与 `hk_option_daily_snapshot.enabled`（**夜间 cron 路径**）是彼此独立的两条路 —— 冷启动直调采集本体、**不读采集维度的启用状态**（全仓实证：冷启动编排对 `sync_dimension` 零引用）⇒ 只翻其一会让两条路的行为分叉（`FR-016a`）。**两个都翻 `true`。**

   🚫 **MUST NOT 走 `{ optionChain: true, optionSnapshot: false }` 这个中间态**当临时闸。该组合在能力表的本意里不存在（值域只有「开通」与「已知但未开通」两种），而冷启动第 7 步的 chain-only 早退位于**盘中闸、`no_option_chain` 判断、快照落库复判之前** ⇒ 三条同时破：无挂牌期权的港股票落 `backfilled`（结局说谎）、盘中建锚落 `backfilled` 而非 `intraday_skipped`、且 `dataAlreadyPresent` 退化成「合约计数 > 0」使无期权票**每次重复投递都重跑一遍链发现**（破 Edge Case 10）。
6. 🚫 **T10 MUST NOT 动 `market-session.rules.ts`**（原第③处「港股午休还原成两段」已作废）：盘中采价的闸读的是**供应方的市场时段状态**（归一后只有「常规连续交易时段」才准采，午休不在白名单内），**根本不读本地时段表**。三个消费方逐个核过 —— 补数闸要的正是「含午休」的单段语义；盘中采价不读那张表；只有**尚未接入**的盘中告警（市场参数写死 `cn`）将来接 hk 时才需要拆段，那不属于本片。
7. **T17 → T10**：`futu-realtime-quote.adapter.ts` 与快照适配器复用同一个 `vendorTimeToDate`。反了的话港股盘中价会带着偏 12 小时的时间戳落进 `intraday_at`，而那一列是**真判据**（90 秒新鲜度闸读它）—— 快照那列只是证据、偏了不影响判据，实时价这列偏了会让锚**恒被判为陈旧**或**恒被判为新鲜**，取决于偏的方向。
8. **`T06` / `T07` 已部署到 prod → T15**（2026-08-23 改：原文是「T14 → T15」，随 T14 撤销一并改口径）。T15 在 **prod** 上跑真锚验收，**不**在本机 —— 本机 live 联调是被蓄意关掉的一条路，且它验的是生产上不存在的配置。理由全文见 T14 的撤销说明。

## 🗂 推进批次

> ✅ **批 A 已于 2026-08-23 完成并 push**：`T01`–`T05` · `T08` · `T10`–`T13` · `T17`。
>
> 🔓 **2026-08-23 解绑**：`T06` / `T07` / `T15` 原本挂在 U2 实测上，**已解绑** —— `oi_as_of` 按现行规则先写、结论落地后**重标**（`FR-016`，理由见排序铁律 4）。挂在 [#164](https://github.com/zhangleizlpd/no-vain-years-tech/issues/164) 上的只剩 `T16` + `T09` 的 ①②③，**它们不阻塞任何人**。

| 批 | Task | 说明 |
| --- | --- | --- |
| **A（已完成）** | `T01`–`T05` · `T08` · `T10`–`T13` · `T17` | — |
| **A′（现在推）** | `T06`（开通，两开关一起翻）→ `T07`；`T15` 在部署到 prod 之后 | 排序铁律 3 / 4 / 8 |
| **B（等 #164，不阻塞）** | `T16`（读 U2 结论）→ `T09` 的 ①②③（`oiAsOf` 分叉 + **重标已采的港股行**） | 重标是一条**确定性 `UPDATE`**（`FR-016`） |

📌 **`T06` + `T07` 落地后，21 条 `state_branches` 全部有 `it()` 覆盖**（1 / 4 → T06；2 / 3 / 6 / 7 → T07；21 → T09 verify ④ **已提前落地**）⇒ 仓库 PR 模板的「状态机闭环」checkbox 可以诚实勾上，**PR 不必再等 `T09` 的 ①②③**。

---

## Server

- [X] T01 [P] [Server] **期权链 / 快照适配器认 hk + `'N/A'` 规范化**（`FR-001`, `FR-004`, `FR-005`, plan §A8, §A11）：两个适配器的 `MARKET_TO_FUTU_PREFIX` 各加 `hk: 'HK'`（链适配器的反向映射同步加）。🚨 **同 task 修 `strOrNull` 对 `'N/A'` 的处理** —— 网关侧 `clean_value` 只处理空值/非有限数、字符串原样透传（`mappers.py:50-51`），而 `strOrNull`（`futu-option-chain.adapter.ts:98`）是「非空字符串即返回」⇒ 字面量 `"N/A"` 会被当成一个有效结算方式写进 `settlementMode`；美股返 AM/PM 永远撞不到，**港股每一行都会**。🚫 **MUST NOT 顺手改 `futu-underlying-iv.adapter.ts` 的 `numToString`** —— 那处形态相近但**已经正确**（`Number('N/A')` 为 NaN ⇒ 落 `null`，注释写明「不回落成 0，因为分位上 0 = 一年最低」）。🚨 关联键**只能**用 `stock_owner`：港股合约标识词根是交易所助记符（`HK.TCH260929C460000` 里的 `TCH`），**不是**标的数字代码 `00700`，从标识反推不出标的 —— 美股是可反推形态，别把假设带过来。→ verify: 用 PoC 落进 `__fixtures__/` 的真实港股响应写适配器单测，断 ① 132 行合约全部解析出正确的 `underlying` 与 `strikePrice` / `expiryDate` / `optionType`；② `settlementMode` 落 `null` **而不是字符串 `"N/A"`**（这条是本 task 的核心回归钉）；③ **负例**：传一个未登记市场（如 `cn:600519`）**throw 且零 vendor 调用**，不是静默返空集

- [X] T02 [P] [Server] **锚作用域维度：工作集以锚集为闸，`needSync` 退出谓词**（`FR-006`, `FR-007`, `FR-008`, plan §A3）：新增一张**代码级登记表**（与 `COLD_START_CAPABILITY` 同范式，**一处登记**，禁散进 executor 的 if 分支）声明「哪些维度是锚作用域的」；这些维度的工作集改为 `{ market ∈ scope, status: 'active' } ∩ 锚集`，**`needSync` 不进谓词**。锚集读取复用 `sync-option-contract.usecase.ts:135 seedAnchoredInstruments` 已在用的同一条跨 ctx 只读路径（`// CROSS-CONTEXT-READ:` + `select: { ticker }`），不开新口子。🚫 **MUST NOT 把 `hk` 加进 `ANCHOR_GATED_MARKETS`** —— `anchor-driven-sync-gate.ts:11-18` 粗体写明：关闸路径（`notIn`）放到 cn/hk 会把全部 cn/hk 在市标的一次性移出工作集，**直接打死 22:00 那 18 个理杏仁维度**。→ verify: 🚨 **美股等价性必须是断言不是承诺** —— 构造三种行「有锚 + `needSync=true`」「有锚 + `needSync=false`」「无锚 + `needSync=true`」，断 ① 新旧判据在**美股**上产出**同一集合**（前两种进、第三种不进）；② 第三种行**不**进港股期权维度工作集（这条是港股侧的真闸，`needSync` 恒真给不出任何收窄）；③ 整库零港股锚时港股期权维度工作集为**空**且判定为**成功**（`SC-002`）；④ 既有 `{cn,hk}` 维度（`eod_bar` / `profile`）的工作集**逐元素不变**（`FR-007`, `SC-004`）；⑤ 🆕 **跨维度集合快照对比**（`SC-005`）—— 对**全部**已注册维度各取一次工作集快照，断开通港股前后**美股侧逐维度逐元素相同**。前四条只覆盖「判据」这一层，`SC-005` 要的是「各维度覆盖的标的集合」这一层，缺这条它就只在覆盖表里有名字、正文零命中

- [X] T03 [P] [Server] **修 seed 点破坏「港股 `needSync` 恒真」不变量**（`FR-009`, plan §A4）：`anchor-cold-start.usecase.ts:465` 的 `seedInstrument` 与 `sync-option-contract.usecase.ts:272` 的 `seedAnchoredInstruments` 都**无条件**写 `needSync: false`，理由注在原地（「重算的唯一权威是采集闸」）—— **这条理由只对被闸管的市场成立**。港股没有闸、`sync-universe` 的 update 分支又刻意不写该列 ⇒ 被这两处首建的港股行**永远停在 `false`**，同时被 22:00 的 `eod_bar`、`sync-profile`、backfill CLI 三个消费方静默排除，那只标的**永远没有日线**（而 `daily_bar` 是雷达跌破判据的输入）。⇒ 两处走**同一个 helper**，默认值与 `sync-universe.usecase.ts:107` 对齐（`needSync: market !== 'us'`），注释写明分工：**create 路径定默认值，闸只负责被闸市场的重算**。→ verify: 🚨 **必须自己造反例** —— 用 universe **已收录**的港股票做断言毫无意义（`needSync` 本来就是 `true`，seed 分支根本没跑，绿了什么都没证明）。用一个 `Instrument` 表里**不存在**的港股代码建锚，逼 `seedInstrument` 走 create 分支，断 ① 落 `needSync = true`；② 该行随后**能被 `eod_bar` 的工作集捞到**（`SC-006`，这才是缺口的真实后果面）；③ 同样路径下的**美股**标的仍落 `needSync = false`（不误伤既有语义）

- [X] T04 [Server] **三个港股期权维度 seed + 依赖边**（`FR-015`, plan §A1）：新建 migration（**纯 seed 无 DDL**）插三行 `market_scope = {hk}`：`hk_option_contract`（cron `0 0 23 * * *`，`batch_size 1`，`history_depth NULL`）· `hk_option_daily_snapshot`（cron `0 30 23 * * *`，`batch_size 400`，**`enabled = false`**，见排序铁律 4）· `hk_underlying_iv_daily`（cron `0 0 23 * * *`，`batch_size 500`，**`history_depth 1095`**）。依赖边：`universe → hk_option_contract` soft、`universe → hk_underlying_iv_daily` soft、**`hk_option_contract → hk_option_daily_snapshot` hard**。🚫 **MUST NOT 给现有维度的 `market_scope` 加 `hk`** —— `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时直接 throw（北京 06:00 时 us=D-1 而 hk=D），而**该 throw 存在的目的就是禁止这种混用**；即使绕过它，混 scope 维度的工作集恒为全 scope，港股休市而美股开市的日子会对港股全量发请求。**cron 为什么是 23:00**（这就是 `FR-015` 的落地点）：22:00 是仓里既有的港股锚点（`eod_bar` + 18 个理杏仁维度全在这一刻），runbook 记「22:00 起、当晚 ~22:30 就位」，而 worker `concurrency=1`，23:00 留余量。→ verify: 🚨 **补 hard 边相邻性断言** —— hard 边要求两端在派生全序里**相邻**（`assertEdgesExpressible`），排错了不是 seed 红、是**夜间 flow 装配运行期 throw** 而 seed 自己跑得绿绿的；照 `dimension-executor.spec.ts` 既有的「047 T003 依赖拓扑守卫」补一条。另断 ② 三行 `market_scope` 恰为 `{hk}`、`hk_option_daily_snapshot.enabled` 为 `false`；③ **三行的 `cron_expr` 解析出的下一触发时刻均晚于同日 22:00、早于次日 00:00**（`FR-015` 的机械断言 —— 写死字符串比对会在有人改 cron 时静默放行）；④ migration 在空库单向可用

- [X] T05 [Server] **结局值域 8 → 9：`no_option_chain`**（`FR-013`, `FR-014`, `FR-014a`, plan §A5）：`COLD_START_OUTCOME` 加一档，语义是**终态、非错误、不告警**，与 `BACKFILL_INCOMPLETE`（ERROR 级、需人工介入）严格区分。判据**取自库**：该标的 `option_contract` 计数为 0 ⇒ 无挂牌期权；🚫 **MUST NOT 取采集统计量** —— 「有合约但整批被落库前拒掉」那种情形统计量同样为空，两件事会被混成一个。**零 migration**：`anchor_cold_start_run.outcome` 实查是 `VARCHAR(32)` 且**无 CHECK 约束**，新值 15 字符。**这不是可选的润色** —— 港股绝大多数标的没有挂牌期权（实测腾讯 8 / 小米 8 / 海底捞 7 / 药明康德 8 个到期日，而**颐海国际 0、网龙 0**），折进 `backfill_incomplete` 会让每一只无期权的港股锚都产出一条无从处理的告警。→ verify: 断 ① 无挂牌期权的港股标的落 `no_option_chain` 且**不产生 ERROR 级日志**（`SC-011` 前半）；② 有期权但目标交易日快照未落库的落 `backfill_incomplete` 且**产生** ERROR（`FR-013`, `SC-011` 后半，Edge Case 2）；③ 两者可由 `outcome` 字段直接分开统计（零折叠，`state_branches` 8）；④ 美股既有八档行为**逐点不变**（纯增量）

- [ ] T06 [Server] **开通港股冷启动：两个开关一次翻**（`FR-010`, `FR-011`, `FR-016`, `FR-016a`, plan §A2）：**前置 = T03**（排序铁律 3）。`COLD_START_CAPABILITY.hk` 从空表项改为 `{ optionChain: true, optionSnapshot: true }`，并在**同一个 commit** 里把 `hk_option_daily_snapshot.enabled` 从 T04 seed 的 `false` 翻成 `true`。🚨 **这两个开关是彼此独立的两条路**（前者管建锚路径、后者管夜间 cron；冷启动直调采集本体、不读维度启用位）⇒ 只翻其一不满足 `FR-016`（见 `FR-016a`）。🚫 **MUST NOT 走 `{ optionChain: true, optionSnapshot: false }` 中间态**当临时闸，三条同时破，理由见排序铁律 5。📌 **`FR-011`（不新增日线采集维度）现在自动满足**：issue #159 起日线整个不在冷启动职责内 —— 建锚那一刻 `CreateAnchorUseCase.seedLastClose` 已同步调过 `EnsureLatestEodBarUseCase`（走同一个 `EOD_BAR_PORT`，按市场路由、hk 走理杏仁、写同一张 `daily_bar`、同一唯一键），能力表里也不再有日线档。⚠️ **但那条路对 universe 未收录的港股票会早退**（`instrument` 行不存在 ⇒ 只 warn 返 `null`，「不猜、不建 instrument 行」是它的明写纪律）：那种标的的日线要靠 T03 修好的 `needSync` 默认值 + 当晚 22:00 的 `eod_bar` 才补得上 —— 这就是「T03 → T06」那条铁律的真实后果面。→ verify: 断 ① 港股锚不再落 `market_not_enabled`（`FR-010`）；② 休市时段建港股锚 → 期权合约集与归属交易日快照**都落库**、结局 `backfilled`（`state_branches` 1）；③ 归属交易日数据已具备 → **零对外请求**（`state_branches` 4）；④ 建锚事务回滚 → 不发起冷启动（Edge Case 9）；⑤ 重复投递 → 第二次起零对外请求、零新增行（Edge Case 10）；⑥ **无挂牌期权的港股标的落 `no_option_chain` 且零 ERROR 级日志**（`SC-011` 前半的港股端到端面 —— T05 那三条是用 `us:` 标的驱动的，本 task 补港股分支）；⑦ 🆕 **两个开关的机械断言**：`COLD_START_CAPABILITY.hk` 两档全 `true` **且**库中 `hk_option_daily_snapshot.enabled` 为 `true`，断言两者**同真同假**（`FR-016a` —— 防将来有人只改一处，而那种偏差不报错）

- [ ] T07 [Server] **冷启动的时段闸与放弃路径**（`FR-012`, plan §A2）：**前置 = T06**（未开通时这四条分支**全部位于能力闸之后**，一条都不可达）。本 task **不新增实现面**，是把 T06 开通后**变得可达**的四条分支逐条钉住 —— 它们的实现早已存在（`isSessionUnderway` 的盘中闸、日历三态的放弃路径、配额顺延），但**在港股上从未被执行过**，而这四条错了都不报错。→ verify: 断 ① 连续竞价时段建锚 → 补链但**不写任何按交易日归属的快照**（`FR-012`, `state_branches` 2）；② **午休时段建锚 → 判定同盘中，不写快照**（`state_branches` 3 —— 🚨 用 `isSessionUnderway`（**含午休**）的语义，**MUST NOT** 换成 `isWithinTradingSession`。单段登记 `[09:30, 16:00]` 正是本条要的语义，**不需要也不允许**为它拆段，见排序铁律 6）；③ 交易日历缺港股的行 → 放弃 + 需人工介入记录，**不猜日期**（`state_branches` 6）；④ 交易日历前瞻视野未覆盖港股的今天 → 同样放弃、**不猜口径**（Edge Case 8）；⑤ 供应方配额耗尽 → 顺延、**不记失败**、不破坏已落数据（`state_branches` 7）

- [X] T08 [P] [Server] **标的 IV 适配器认 hk + 回填跨窗 + 分位样本只数真实观测**（`FR-002`, `FR-018`, `FR-019`, `FR-019a`, plan §A9）：`futu-underlying-iv.adapter.ts` 的 `MARKET_TO_FUTU_PREFIX` 加 `hk: 'HK'`。`hk_underlying_iv_daily.history_depth = 1095` 走既有 `splitBackfillWindows()` —— 🚨 **单个 364 天窗港股只返 244 个交易日、美股 250，两者都不足 `IVP_MIN_WINDOW_TRADING_DAYS = 252`**，只拉一年会让分位恒为 `insufficient_window` **且不报错**。港股历史起点实测 **2023-06-27**（美股 2023-06-26），总深约 3.15 年 / ~773 行。⚠️ **补一条只在港股才够得到的污染路径**：无挂牌期权的标的其概览整行为空值观测（网关返 200 + 整行 `'N/A'`，经 `numToString` 落 `null`），若这类空行累积到 252 就被判「样本充足」，会让一个毫无意义的分位看起来可算 ⇒ 样本判据必须只数**真实有值**的观测。→ verify: 断 ① 港股标的完成首次回填后分位**可算**（`SC-007` 前半）；② 只回填一年（244 行）时分位为「不可算」而**不是** 0（`SC-007` 后半 + `state_branches` 14）；③ 无挂牌期权标的的分位**恒为不可算**，不因空值观测累积而变成可算（`SC-012`）；④ 用 PoC 落进 `__fixtures__/` 的真实港股 `/his-vol` 响应断解析正确

- [ ] T09 [Server] **`oiAsOf` 按市场分叉（纯规则层）**〔批 B · [#164](https://github.com/zhangleizlpd/no-vain-years-tech/issues/164)〕（`FR-016`, plan §A6）🚨 **本 task 的 ①②③ 被 U2 卡着（verify ④ 是例外，已提前落地），但它已不阻塞 T06 / T07 / PR**（2026-08-23 解绑，见排序铁律 4）。**收尾必做**：结论若要求分叉，MUST 对结论落地前已采的港股快照行按结论**重标 `oi_as_of`** —— 依 `source` 与 `session_date` 可判定，一条确定性 `UPDATE`（`FR-016`）（**verify ④ 是例外，已于 2026-08-23 提前落地**，见下）：若实测证明 HKEX 22:00 的 EOD 已把当日 OI 定稿 → 给 `resolveSnapshotSpec` 增一个**按市场的 `oiRefreshedAtEod` 事实位**，由调用方从登记表喂进来（**纯函数仍零 I/O**）；若证否 → 现规则逐字适用，本 task 归零（只留一条把结论钉住的断言）。🚫 **MUST NOT 把 `eod` / `premarket_backfill` 两条 `oiAsOf` 路径抹平**（规则层注释明禁）：抹平后永远不会红，但两条路径产出的 OI 差一天，而活跃度排名与 UI 的 `asOf` 都读它。🚫 **本 task MUST NOT 翻任何开关** —— 开通归 T06，且两个开关必须在**同一个 commit** 里一起翻（`FR-016a`，排序铁律 5）。⇒ 本 task 的验收面**全在纯函数层**，落库面归 T06 与 T15。→ verify: 断 ① `resolveSnapshotSpec` 对 hk 算出的 `oi_as_of` 与实测口径一致（结论进 spec `## Clarifications`，断言引用它）；② 美股两条路径的 `oiAsOf` **逐点不变**（分叉是增量不是改写）；③ 分叉后函数仍**零 I/O**（事实位由调用方从登记表喂进来，不在函数内查库）；④ ✅ **已提前落地（不依赖 U2，2026-08-23）** —— **希腊值缺失的行照常在库并带标注、不丢行**（`SC-010`, `state_branches` 21 —— 2026-08-23 从 T15 挪来：T15 已改为 post-deploy 验收，这一条不该等到部署后才有覆盖，而它在**纯函数层就能断**）。落在 `apps/server/src/marketdata/futu-option-snapshot.adapter.spec.ts` 的 `066 T09 (verify ④)` 段（9 条 `it()`，两种缺失形态 × ⓐⓑⓒ）。⚠️ **T09 整条仍未完成**：checkbox 留 `[ ]`，剩 ①②③ 等 U2。🚨 **两份真实 fixture 里都没有缺失态**，别去里面找：`hk-option-snapshot-00700-2026-08-23.json` 实测 132/132 `greeks_complete=true`；`option-snapshot-us-2026-07-29.csv` 是 7 列瘦投影（`contract_code,option_side,strike_price,bid,ask,delta,underlying_spot`），2150 行 `delta` 空值为 **0**。⇒ 本条必须**自己构造缺失态**（取真实响应里的一行，删掉它的 greeks 块再喂进解析），断 ⓐ 该行**仍在**结果集里（不被丢弃）、ⓑ 带 `greeks_complete=false` 标注、ⓒ 五个希腊值落 `null` 而**不是** 0（0 在下游是有意义的值，与「算不出」方向相反）。📌 丢行的后果是「腿在但算不出档」与「这条腿今天整行没采到」不可区分 —— 前者是数学固有现象，后者是真缺口

- [X] T10 [P] [Server] **港股实时报价两处连改**（`FR-003`, plan §A7）：① `futu-realtime-quote.adapter.ts` 的 `MARKET_TO_FUTU_PREFIX` 加 `hk: 'HK'`；② `marketdata.module.ts:404` 的 `MarketRoutedRealtimeQuoteAdapter` 补 hk 槽位 —— 今天港股锚在每 30 秒的盘中 tick 里落 `unsupported-market`（无实时源路由，属**配置事实**、按纪律不计入熔断），补上槽位这条路才通。🚫 **MUST NOT 动 `market-session.rules.ts`**（排序铁律 6）：盘中采价的闸读的是**供应方的市场时段状态**，归一后只有「常规连续交易时段」准采、午休不在白名单内 ⇒ 天然不采，本地时段表的单段登记与本 task 无关。→ verify: 断 ① 港股连续竞价时段实时价投影到锚（`state_branches` 16）；② **午休时段不采、不把午休盘口标成盘中价**（`state_branches` 17，本 task 的核心回归钉 —— 🚨 断言必须打在**供应方时段状态的归一**这一层，打在本地时段表上验的是另一件事）；③ 非交易日 / 收盘后保留收盘档（`state_branches` 18）；④ **半日市当天下午按提前收盘判定**（`state_branches` 19 —— ⚠️ 供应方在港股半日市 12:00 之后报什么状态**尚未实测**，本条要么补实测、要么在 T15 真锚上收口，**不得凭推断写绿**）；⑤ 既有 cn 盘中告警路径**逐点不变**

- [X] T11 [Server] **港股与美股链发现串行、不争配额**（`FR-015`, plan §A10, §A12）：确认 `hk_option_contract` 与 `option_contract` 在**同一个** `marketdata-sync` 队列上、worker 保持 `concurrency: 1` ⇒ 结构上不可能并发。🚨 **这条对 cron 触发与冷启动触发同样成立** —— 冷启动是全系统唯一的非 cron 触发者、建锚时刻由人决定，「错峰 cron」保证不了不争，单队列串行才是真保证。采集端纪律沿用：链**永远只传** `code/start/end/option_type`，**不传** `option_cond_type` / `data_filter`（采集端一旦筛就丢证据且不可回补，vendor 不提供历史交易日的链快照）。**容量参照**（2026-08-22 生产实测）：21 只美股锚一轮 `option_contract` ≈ **8 分钟**，全程占满 10/30s 的桶；港股是**另一轮串行叠加**，估墙钟按相加不按取最大。→ verify: 断 ① 两个维度 job 入的是同一队列名；② 同时入队时**串行完成**、无一方因配额耗尽而失败（`SC-009`, `state_branches` 20）；③ 链请求参数**不含** `option_cond_type` / `data_filter`（采集端全开的机械断言）

- [X] T17 [P] [Server] **vendor 时间戳按行所属市场解析**（`FR-005a`, plan §A13）：`futu-option-snapshot.adapter.ts` 的 `VENDOR_UPDATE_TIME_ZONE` / `vendorTimeToDate` 固定按美东解释 vendor 的 `update_time`，而港股行给的是**港股当地时刻** —— 2026-08-23 实测：期权行 `09:30:00`、标的行 `16:07:49`，均为港股当地 ⇒ 港股这一列整体**偏 12 小时**。⇒ 引入 `market → tz` 映射按行解析，🚨 **必须与 `session-clock.ts` 的 `EXCHANGE_TIME_ZONE` 同源，MUST NOT 复制第二份**（两份市场时区表漂开的表现是「某个市场的时间戳悄悄差几小时」，不报错）。🚨 **本 task 必须先于 T10**（排序铁律 8）—— `futu-realtime-quote.adapter.ts` 复用同一个 `vendorTimeToDate`，而那条路上 `intraday_at` 是**真判据**（90 秒新鲜度闸读它），不像快照那列只是证据。📌 快照那列今天是纯证据零判据（`option-snapshot.port.ts` 明禁用它顶替采集时刻），偏了不影响任何判据 —— 这也是它一直没被发现的原因。→ verify: 断 ① 用 T01 落进 `__fixtures__/` 的**真实港股快照响应**，解析出的时刻对应港股当地 `09:30` / `16:07`，而不是把它当美东；② **美股行逐点不变**（同一份美股 fixture 解析结果与改动前逐字相同）；③ 映射**取自 `session-clock` 的同一份表**（机械断言：两处不许各存一份市场时区）

## Mobile

- [X] T12 [P] [Mobile] **港股「无盘中报价」常驻说明下线**（`FR-020`, plan §A7 第 4 点）：`radar.rules.ts` 的 `MARKETS_WITHOUT_INTRADAY` 去掉 `'hk'`（该常量随之变成空数组 —— **保留常量本身**，它是「市场能力表」的落点，删掉会让下一个无盘中市场无处可挂）；`optionsdesk-copy.ts` 的 `marketNoIntraday` 文案随之不再被引用 → 一并清理（本次改动产生的 orphan 必须清）。→ verify: `nx test mobile` 绿；`radar.rules.ts` 的 `marketLacksIntraday('hk')` 返 `false`

- [X] T13 [Mobile-E2E] **雷达港股页签双向断言反转**（`FR-020`, `SC-008`, plan §A7）：`optionsdesk-anchors-radar.spec.ts:1011-1040` 那条断言现在断的是「港股页签**有**常驻说明」，需反转为「**没有**」，并**保留**美股侧的对照断言（双向，只断单向会让「两个页签都没有」照样绿）。→ verify: `nx run mobile:e2e` 全绿；断言在港股页签**有锚**与**零锚**两种状态下都成立（说明的消失不能依赖有没有行）

## E2E

- [X] T14 [Manual] ~~**打通本机 dev → `broker-hk` 的 wg1 隧道**~~ —— 🚫 **本条已撤销（2026-08-23），不实施**

  **撤销理由（三条，任一条独立成立）**：

  1. **它削弱一条刻意的安全属性**。shim 绑的是隧道虚拟 IP 而非 `0.0.0.0`，`services/futu-shim/README.md` 写明那是为了「让 shim 在隧道外不可达，**即使安全组规则被放松也一样**」。为跑一次验收把这条隧道扩到一台开发机上，削弱的正是它。
  2. **通向港机的路本来就存在，且不经过开发机**。`ops/runbook/deploy-topology.md` § 1：futu-shim 自己的部署链就是**两跳** `runner → app → 港机（走 wg1 隧道内 SSH）`，消费侧同表写明 `mono app → futu-shim（wg1 隧道）` —— `app` 既是 wg1 的 peer，也是跳板。
  3. **它的前提「本机 live 联调」是被蓄意关掉的**。`docs/conventions/local-verification.md` 明写：`marketdata.config.ts` 蓄意不给 `FUTU_SHIM_URL` / `FUTU_SHIM_TOKEN` 加 `.default()`，`.env` 里的 URL 为空串 ⇒ **显式 `live` 的 boot 必炸**，「本地 live 联调这条路当前蓄意不可用」，开不开还挂在一个开放问题上。

  ⇒ T15 改为**在 prod 上跑**（见下），本条随之不再需要。**MUST NOT** 因为「打通了更方便」把它捡回来 —— 方便不是重开那条口子的理由。

- [ ] T15 [E2E] **真港股锚跑通整链**（`SC-001`, `SC-003`, `SC-006`, plan §Gate 0.1）：**前置 = `T06` / `T07` 已部署到 prod**（**不是**隧道 —— 见 T14 的撤销说明）。用 **prod** 的 `/anchor-import` 建一只真实港股锚（该 command 原生支持 `hk:`，nginx 那道闸也是 `^(us|hk):`），随后逐条查 **prod 的库**。

  🚨 **为什么必须在 prod 跑，而不是本机**：prod 走 wg1 直连 shim + 生产 env；本机即使打通隧道，跑的也是**另一条配置路径**。本 task 的全部价值在「真数据端到端」—— 验在一条**生产上不存在的路**上，绿了也不构成生产链路的证据。这条与 plan `Gate 0.1` 的定位一致：该 gate 在 plan 阶段是「已规划」而非「已完成」，最终由本 task 落证据。

  ⚠️ **这是 prod 写操作**：建锚会往生产库写真行。动手前把标的与参数**呈给维护者确认**，不自主执行。

  → verify: **逐条查库，不看日志** —— ① `optionsdesk.anchor` 有该行且 `market='hk'`；② `security.outbox_event` 有一条 `optionsdesk.anchor-created` 且已被 relay 消费；③ `marketdata.instrument` 有 `hk:<code>` 且 `needSync=true`；④ `marketdata.option_contract` 有该标的合约行、到期日阶梯**覆盖到远月不截断**；⑤ `marketdata.option_daily_snapshot` 有目标交易日的行，**`iv` 与五个 greeks 的非 null 率 ≥ 95%**（PoC 实测 132/132 = 100%；缺失行必须带 `greeks_complete=false` 而非丢行），`net_open_interest` **有值**；⑥ `marketdata.anchor_cold_start_run.outcome = 'backfilled'`（**不是** `market_not_enabled`、**不是** `backfill_incomplete`）；⑦ `marketdata.daily_bar` 有该标的目标交易日的行；⑧ 雷达港股页签渲染出该锚、`marketCounts` 的 hk 计数 +1。⚠️ **盯住 `backfill_incomplete`** —— 它专盖「跑完了但快照仍不在库」，是链 child 成功完成但零结果时唯一会显形的信号；看到 `backfilled` 也要顺手查第 ⑤ 条，两者不一致说明落库复判有洞。📌 **冷启动已不再分两相**（issue #159：链改直调采集本体，两相合一）—— 一次调用直达终局，**不必**再等第二相。若看到「结局已落但快照还没有」，那不是时序未完成，是真缺口。⚠️ 另跑一遍**无挂牌期权**的港股标的（如 `hk:00777`），断落 `no_option_chain` 且**无 ERROR 级告警**

## Polish

- [ ] T16 [Manual] **U2 结论回填 + 采样器拆除**〔批 B · [#164](https://github.com/zhangleizlpd/no-vain-years-tech/issues/164)〕（`FR-016`, plan §A6）：**读取时刻 = 2026-08-25（周二）06:00 之后**。🚨 **别读早了**：关键样本是 **2026-08-24（周一）** 那个交易日的四拍，而判据的后半段要用 **周二 06:00 的 `next_open`** 才能把「周一 EOD 那一刻变的」与「周二才变的」分开 —— 周一当天去读只有半份数据，会得出一个看似确定的错结论。（日历已核：08-24 与 08-25 都是港股交易日。）读 `broker-hk:~/nvy-u2/oi-samples.jsonl`，比周六基线（周五终值原点，`HK.TCH260929C530000: oi=10772 net_oi=9568`）与周一 `post_eod` 的差异 —— **周一 23:00 ≠ 基线** ⇒ 22:00 EOD 已把当日 OI 定稿 ⇒ `oiAsOf = D`，T09 要做分叉；**相等而周二才变** ⇒ 现规则逐字适用，T09 只剩翻开关。🚨 `21:30 pre_eod` 与 `23:00 post_eod` 这一对是**把变化钉在 22:00 这个事件上**的关键，缺了它只能说「隔夜变了」，说不出「是 EOD 那一刻变的」。结论写进 spec 的 `## Clarifications`。🚨 **收尾必做**：`crontab -e` 删四行 + `rm -rf ~/nvy-u2`。这是**仓外 crontab**，`.claude/rules/scheduled-tasks-registry.md` 的 path-trigger **够不到**，只有本 task 看着它（脚本自带 `STOP_AFTER=2026-08-29` 兜底，但那只防长跑、不代替清理）。→ verify: spec `## Clarifications` 有带日期与样本量的确定结论；`ssh broker-hk 'crontab -l | grep -c nvy-u2'` 返 0；`~/nvy-u2` 不存在

---

## 覆盖自查（analyze 阶段请逐条 `grep` 复核，别信本表的历史数字）

| 维度 | 覆盖情况 |
| --- | --- |
| FR-001 | T01 |
| FR-002 | T08 |
| FR-003 | T10 |
| FR-004 | T01 |
| FR-005 | T01 |
| FR-005a | T17 |
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
| FR-016a | T09 |
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
| `state_branches` 1–21 | 1 → T06 ｜ 2 → T07 ｜ 3 → T07 ｜ 4 → T06 ｜ 5 → T03 ｜ 6 → T07 ｜ 7 → T07 ｜ 8 → T05 ｜ 9 → T05 ｜ 10 → T02 ｜ 11 → T02 ｜ 12 → T02 ｜ 13 → T02 ｜ 14 → T08 ｜ 15 → T08 ｜ 16 → T10 ｜ 17 → T10 ｜ 18 → T10 ｜ 19 → T10 ｜ 20 → T11 ｜ 21 → T09 verify ④（**已落地** `39bb8903`；T09 整条待 ①②③） |
| **Acceptance Scenario 11 条** | US1: AS1→T06+T15 · AS2→T07 · AS3→T06 · AS4→T03；US2: AS1→T08 · AS2→T08 · AS3→T08；US3: AS1→T10 · AS2→T10（午休） · AS3→T10（半日市） · AS4→T12+T13 |
| **Edge Case 10 条** | 1 无挂牌期权→T05 ｜ 2 有期权但快照未落→T05 ｜ 3 两者不得折叠→T05 ｜ 4 希腊值缺失→T15 ｜ 5 港美同时触发→T11 ｜ 6 停牌→T01 ｜ 7 两地上市→T01 ｜ 8 日历视野未覆盖→T07 ｜ 9 建锚回滚→T06 ｜ 10 重复投递→T06 |

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
