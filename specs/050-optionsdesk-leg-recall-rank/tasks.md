---
feature_id: 050-optionsdesk-leg-recall-rank
spec_ref: ./spec.md
plan_ref: ./plan.md
status: in-progress
created_at: '2026-08-11'
updated_at: '2026-08-11'
---

# Tasks: 050-optionsdesk-leg-recall-rank（optionsdesk 选约引擎 P1 — 召回 / 打标 / 精排）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Branch**: `050-optionsdesk-leg-recall-rank`
**主 plan**: `docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）
- 层级：`[Server]`（Small 纯函数 / use case）· `[Server-IT]`（Medium，Testcontainers）· `[Contract]`（DTO + OpenAPI + api-client regen）· `[Docs]`
- **层级 → size 映射**（`docs/conventions/testing.md`，= plan **D-TEST-1** / **D-TEST-2** / **D-TEST-3** 三层分工）：`[Server]` 的 verify 落 **Small** `*.spec.ts`（零容器，plan D-TEST-1）· `[Server-IT]` = **Medium** `*.it.spec.ts`（Testcontainers，plan D-TEST-2；perf 档 plan D-TEST-3）
- **测试不独立成 task**（per `sdd.md`），绑在每个实现 task 的 `verify:` 里；**IT 例外**（跨多文件、单独成 task）
- 每 task = 30min–2h 单 commit 单元；`- [ ]` pending / `- [X]` done
- 🚨 **FR / SC / plan 决策的引用一律写全**（`FR-002` 而非 `FR-001/002`）—— 缩写会让「逐条 grep 交叉核对」这个判据**自己失效**：`grep FR-002` 在 `FR-001/002` 上零命中，于是看着有覆盖、机械扫描说没有。本文件首轮就踩了这个，11 条 FR + 2 条 plan 决策静默漏扫

## Path Conventions

| 面                         | 路径                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| server 业务（optionsdesk） | `apps/server/src/optionsdesk/`（扁平，无 domain/application/infrastructure 子目录）                        |
| server IT（Medium）        | `apps/server/test/integration/optionsdesk-050.*.it.spec.ts`                                                |
| 治理检查                   | `scripts/checks/check-optionsdesk-rule-constants.ts`（**扩既有，勿新建**）                                 |
| 契约                       | `apps/server/src/optionsdesk/optionsdesk.dto.ts` → `apps/server/openapi.json` → `packages/api-client/src/` |
| schema / migration         | **零改动** —— 本片全部派生请求时算                                                                         |
| mobile                     | **零改动** —— 显示口径归 P2                                                                                |

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **`rentAbsDeltaBand(null)` 取并集在召回下对、在打标下错**（plan D-MARK-1）——同一条「不替人做方向性假设」的原则，在**召回**语义下导出「取并集放宽收进来」、在**打标**语义下导出「不打标」。**这不是笔误型错误，是正确的直觉在错误的语义下应用**，code review 时看着完全合理。照抄会让「水位未选」时全表冒出一片推荐标。⇒ `isRecommended` 的 `null` 分支直接 `return false`，**不复用** `rentAbsDeltaBand`。
2. **min-max 归一化 MUST 先判 `min === max`**（plan D-RANK-1）——否则 `(v−min)/(max−min)` = `0/0` = `NaN`。NaN 进 `Array.prototype.sort`，**比较结果不可预测且不抛任何错**（与 NaN 的任何比较恒 `false`）⇒ 顺序变成 V8 实现相关。单测必须显式断言 `Number.isNaN(...) === false`，光断言 `[0,1]` 区间**抓不到**（NaN 的所有比较都 false，区间断言会「通过」）。
3. **`markActivity` MUST 在召回之后、筛选之前**（plan D-MARK-3, FR-016/FR-024）——最自然的写法是「先筛再排名」（少算一些），那样写出来照样能跑、数字照样有，**只是全错**。本片无筛选 ⇒ 召回集 == 排名基准；P3 加筛选时 MUST NOT 把它挪前。
4. **语义翻转 MUST 连带改名**（plan D-RECALL-1）——`isBuildLeg` 现役语义「建仓**族成员**」判据 `|Δ|∈[0.40,0.55] ∧ DTE≤14`，新语义「进建仓**召回集**」判据 `DTE∈[1,49] ∧ K−bid<spot ∧ 两道门槛`。`legTabs()` 的名字与返回类型完全一样 ⇒ 沿用则调用点一行不改而判据全错。同源教训：049 的 `offset`→`tx`（不改名则真机方向反了）。
5. **有效成本判据 MUST 只作用建仓**（FR-004）——收租不接货、不受此限。误加到收租会砍掉大量本来正确的深虚腿，而且**不会红**。
6. **`recallTabs` 入参里 MUST NOT 有 `absDelta`**（FR-009）——这是「Δ 已降级为标」的**结构保证**而非事后约定：拿不到这个量就不可能拿它做召回判据。想塞回去必须先改签名，那一步 review 看得见。
7. **月度日 MUST 一次查回**（plan D-MARK-2）——链上到期日几十个，逐个查是几十次往返。`−7` 天窗口的依据（美股连续休市含周末从不超过 4 个日历日）MUST 带注释，否则下次有人改成 3 也看不出问题。
8. **跨 ctx 读 `trading_day` MUST 带 `// CROSS-CONTEXT-READ:` 注释**——`scripts/checks/check-server-moat.ts` 机器强制，缺注释直接拒（lefthook + CI）。
9. **`tabOrder` 与 `tabs` MUST 同源派生**（plan D-API）——两处表达同一个成员关系，各算一份必 drift，而**两边都算得出结果**。
10. **`legs[]` 的既有排序 MUST NOT 顺手清理**（plan D-API）——有了 `tabOrder` 后它确实不再承载语义，但旧客户端（P2 未上）仍按它渲染。改了会看起来乱，**而这不是编译期能发现的**。保留现役排序键并加注释说明它是 legacy 载体顺序。
11. **两个门槛计数不是可选装饰，且语义不对称**（FR-008）——权利金门槛作用于全 Tab ⇒ 有腿真的从 UI 上消失（**部分推翻 047 FR-005**），`removedByPremiumFloor` 是这笔取舍的唯一补偿；流动性门槛只把腿排除出意图 Tab，`excludedFromIntentTabs` 描述的**不是**消失。🚫 MUST NOT 用同一个暗示「滤掉」的容器名把两者混为一谈 —— 用户看到「滤除 12 条」会以为那 12 条不见了。
12. **特征集 MUST NOT 进 DTO**（FR-019b）——会被「只加不删」永久锁死。机械判据：生成的 OpenAPI schema 里 `grep RankingFeatures` 零命中。
13. **MUST NOT 下沉 SQL**（plan D-RECALL-3）——主 plan P1 行的字面表述已显式否决。召回四条判据没有一条含费率；下沉会制造第二份判据实现，drift 时**两边都算得出数、不会红**。
14. **047 既有 IT 红了 MUST 逐条判「该红 / 不该红」**（T015）——**批量改绿是本片最大的风险动作**。不该红却红了 = 改坏了；该红却绿了 = 判据没生效。
15. **DTE 在特征集里但 MUST NOT 进 ranker**（FR-022）——两条禁令都要守：不许当主键，也不许「离理想 DTE 越近越靠前」。机械判据：`rateDescendingRanker` 函数体 `grep dte` 零命中。

---

## Phase 1: 召回层（阻塞其余全部）🎯

- [X] T001 [Server] **`leg-recall.rules.ts` 新建**（FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-009, plan D-RECALL-1, D-RECALL-2, D-RECALL-4）：新建 `apps/server/src/optionsdesk/leg-recall.rules.ts` —— ① 常量单点：`BUILD_RECALL_DTE = [1,49]` · `RENT_RECALL_DTE = [30,365]` · `PREMIUM_FLOOR`（绝对下限 + spot 百分比双参数）· `LIQUIDITY_MAX_RELATIVE_SPREAD` ② `relativeSpread(bid, ask)` = `(ask−bid)/mid`，`mid = (bid+ask)/2`；任一缺失 → `null` ③ `passesPremiumFloor(bid, spot)` —— 无 `bid` → `false`（🚫 MUST NOT 当 0） ④ `passesLiquidityGate(bid, ask)` —— 无 `ask` → `false`（fail-closed） ⑤ `recallTabs(context, leg): LegTab[]` —— **入参不含 `absDelta`**（Guardrail 6）。全部金额比较走 `Prisma.Decimal`，有效成本取**严格小于**（`K − bid < spot`）。复杂度 `O(1)`/腿 → verify: `leg-recall.rules.spec.ts`（Small）红→绿 —— DTE **四个端点**（1 / 49 / 30 / 365 各自在带内）+ **恰好 `K − bid == spot` 必须不进建仓** + 重叠区 `DTE=35` 同时进两 Tab + `DTE=400` 只进 `all` + 无 `bid` / 无 `ask` 两条 + greeks 缺失（`absDelta` 根本不在签名里，用**类型层**证明）+ 收租**不受**有效成本约束

- [X] T002 [Server] **`leg-tab.rules.ts` 瘦身 + Δ 带迁出**（FR-009, FR-017, plan D-RECALL-1/D-MARK-1）：删 `legTabs` / `isBuildLeg` / `isRentLeg` / `rentAbsDeltaBand` / `withinBand` / `BUILD_LEG_ABS_DELTA_BAND` / `BUILD_LEG_MAX_DTE_DAYS` / `RENT_LEG_MIN_DTE_DAYS` / `RENT_LEG_MAX_DTE_DAYS` / `ANCHOR_AXIS_ZONES` / `RENT_DEPTH_ABS_DELTA_BANDS` / `RENT_DEPTH_UNION_BAND` / `LegTabLegInput` / `LegTabContext`；**保留** `LEG_TABS` / `LegTab` / `earningsLegFamilyFor` / `RENT_SHORT_MAX_DTE_DAYS`（`FR-017` 财报域划分一行不改）。同 task 新建 `leg-mark.rules.ts` **仅承接两组 Δ 带常量**（`BUILD_RECOMMEND_ABS_DELTA_BAND` / `RENT_RECOMMEND_ABS_DELTA_BANDS`，**值不变**，判定逻辑在 T006）。🚫 **`RENT_DEPTH_UNION_BAND` 整条删不迁** —— 它是召回语义的产物，迁到打标层就是 Guardrail 1 那个坑的入口 → verify: `grep -rn "isBuildLeg\|isRentLeg\|legTabs\|rentAbsDeltaBand\|BUILD_LEG_ABS_DELTA_BAND\|BUILD_LEG_MAX_DTE_DAYS\|RENT_LEG_MIN_DTE_DAYS\|RENT_LEG_MAX_DTE_DAYS\|ANCHOR_AXIS_ZONES\|RENT_DEPTH_UNION_BAND" apps/` **零命中**；`leg-tab.rules.spec.ts` 删掉的用例与保留的用例逐条对应（保留的必须仍绿）；`nx typecheck server` 绿

- [ ] T003 [P] [Server] **扩展 `check-optionsdesk-rule-constants.ts` 覆盖召回阈值**（FR-007, SC-009, plan D-RECALL-2）：给既有脚本加不变量，**两类对象走两套判据**（2026-08-11 analyze 定，读实现后得出）：① **两道门槛阈值（小数）** 沿用既有**子串扫描**，被禁字面量从 `leg-recall.rules.ts` 自身派生（在检查器里写死 = 自己就是第二处硬编码）② **三段 DTE 界（整数）** 改扫**比较表达式** `dteDays\s*[<>=!]+\s*[1-9][0-9]*`。🚫 **DTE 界 MUST NOT 走子串扫描** —— 既有实现 `:76-77` 显式过滤掉不含小数点的字面量，注释原文「整数系数当子串扫会把行号 / 数组下标全扫成违规」，`1` 会命中几乎每一行。🚨 **两套判据的扫描面都 MUST 排除 `*.spec.ts`** —— 既有 `:128-129` 把测试文件也纳进扫描面（守 anchor 系数时无妨，那些值不出现在断言里），而 T001 的单测**必须**写出边界值，照抄扫描面会让 T001 与本 task 的验收条件**直接互斥**。🚫 MUST NOT 新写检查脚本 → verify: 🚨 **先证明它会红**（两类各验一次）—— ① 把某个阈值小数抄进 `get-legs.usecase.ts` ② 把 `dteDays <= 49` 抄进同一文件；跑检查器**两次都必须 exit≠0 且指出该行**，改回后 exit 0。**再证明它不恒红**：不改任何代码跑一次必须 exit 0（现役已实测：收窄成 `[1-9]` 后零命中，不收窄则 `leg-derive.rules.ts:81` 的 `dteDays <= 0` 合法守卫会让它恒红 —— 同 047 T039 那个坑）。⚠️ 若阈值取值与 `leg-tier.rules.ts` 既有六个档界（`0.006`/`0.01`/`0.02`/`0.05`/`0.10`/`0.15`）撞值，检查器会把该文件报成违规 ⇒ **改阈值取值**（回 T017 调整），🚫 **MUST NOT 放宽检查器**（那会让 SC-009 显示为「已机器强制」而实际没有，比不装更糟）

- [ ] T004 [Server] **use case 接召回 + 两个门槛计数**（FR-005, FR-006, FR-008, FR-010, plan D-RECALL-1/D-API）：`get-legs.usecase.ts` 的 `deriveLegs` 把 `legTabs(...)` 换成 `recallTabs(...)`；权利金门槛在**进入腿列表之前**滤（全 Tab 消失），流动性门槛在**Tab 归属时**滤（只 build/rent）；累计 `gateCounts.removedByPremiumFloor` / `gateCounts.excludedFromIntentTabs` 并挂上 `LegTableView`。🚨 **两个数语义不对称**：前者是「移出响应」（真消失），后者是「仍在响应、只进全腿 Tab」（没消失）—— 🚫 容器名 MUST NOT 用 `filteredOut` 这类同时暗示两种语义的词。047 三条读端过滤（仅认沽 / 仅标准 / 到期日 `>` 当日）**原样不动**（`FR-010`）→ verify: `get-legs.usecase.spec.ts`（Small，既有 stub prisma）新增用例 —— 被权利金门槛挡下的腿**不在** `legs[]` 里且只让 `removedByPremiumFloor` +1；被流动性门槛挡下的腿**在** `legs[]` 里、`tabs` 只剩 `all`，且只让 `excludedFromIntentTabs` +1；**两个计数互不串台**（各造一条反例，断言另一个数不动）

- [ ] T005 [Server-IT] **召回集合 IT**（US1 全 4 条 + US2 全 5 条 AS, SC-001/SC-003）：新建 `apps/server/test/integration/optionsdesk-050.recall.it.spec.ts`（Testcontainers 真 PG，形制照 `optionsdesk-047.leg-picker.it.spec.ts`）→ verify: 🚨 **断言必须是「成员集合逐条相等」不是 `length > 0`** —— 召回换代的失败形态是「返回了腿、数量也合理、只是成员错了」。逐条：① 建仓集内**零条**有效成本 ≥ spot（`SC-001`）② `DTE ∈ [30,49]` 的腿同时出现在两个 Tab ③ `DTE = 400` 只在 `all` ④ greeks 缺失的腿**在**意图 Tab 里（047 下会被挡掉）⑤ 一分钱腿三个 Tab 全不见，`removedByPremiumFloor` 含它、`excludedFromIntentTabs` **不含**它（`SC-003`）⑥ 宽价差腿不在 build/rent、**在** `all`，`excludedFromIntentTabs` 含它、`removedByPremiumFloor` **不含**它 ⑦ 无 `bid` 与无 `ask` 各一条 ⑧ 某 Tab 被清空 → 返空集合且**不是 404**，面板照常有数据

## Phase 2: 打标层（依赖 T002 的常量迁移）

- [ ] T006 [Server] **推荐标纯函数**（FR-011, FR-012, FR-013, plan D-MARK-1）：`leg-mark.rules.ts` 加 `isRecommended(intent, rentDepth, absDelta): boolean` —— `build_position` 取建仓带；`rent` 且 `rentDepth` 非空取该档带；**`rent` 且 `rentDepth` 为 `null` → `false`**；`pending` / `no_new_position` → `false`；`absDelta` 为 `null` → `false`。🚨 **Guardrail 1**：`null` 分支 MUST 直接 `return false`，**MUST NOT** 复用任何返回并集的辅助函数 → verify: `leg-mark.rules.spec.ts`（Small）—— 四种 `intent` × 水位选/未选的**完整真值表**，其中「`rent` + 水位未选恒 `false`」**单独一条并写明它是 Guardrail 1 的守卫**；`absDelta = null` 恒 `false`；带边界（恰好 `0.40` / `0.55` / 三档各自端点）逐个断言

- [ ] T007 [Server] **月度链标：纯函数 + 日历跨 ctx 读**（FR-014, FR-015, plan D-MARK-2）：① 纯函数 `thirdFridayOf(year, month): string`（`O(1)`，零 I/O）② 纯函数 `resolveMonthlyExpiries(candidates, tradingDays): Set<string>` —— 每个候选日若在交易日集内取它，否则取 `≤ 它` 的**最大**交易日 ③ use case 侧：对链上全部到期日取不同 `(year, month)` 算候选集 `F`，**一次**查 `trading_day where market='us' and date between min(F)−7 and max(F)`，注入纯函数。🚫 MUST NOT 逐到期日查；🚫 MUST NOT 从链自身到期日分布反推（clarify 已否决：靠数据形状猜规则，**误判时看起来完全正常**）；`−7` 的依据 MUST 带注释 → verify: `leg-mark.rules.spec.ts` 补 —— `thirdFridayOf` 跨年跨月（含 1 月 / 12 月 / 第三个周五落在月末）+ **假日回退**（构造候选日不在交易日集内，断言取到前一交易日）+ 交易日集为空时不炸；`nx run server -- tsx scripts/checks/check-server-moat.ts` exit 0（`CROSS-CONTEXT-READ` 注释齐全）

- [ ] T008 [Server] **use case 接打标**（FR-016, FR-018, plan D-MARK-3）：每腿挂 `isRecommended` / `isMonthlyChain`；`markActivity` 与财报打标**签名与实现一行不改**，但调用点 MUST 落在**召回之后**（`FR-016`：排名基准 = 该 Tab 召回全量）→ verify: `get-legs.usecase.spec.ts` 补 —— 打标**零拦截**（同一份输入，开关打标不改变任何 Tab 的成员集合）；`markActivity` 的入参断言为召回后的成员数组（不是全链）

- [ ] T009 [Server-IT] **打标 IT**（US3 全 6 条 AS, SC-005）：新建 `apps/server/test/integration/optionsdesk-050.mark.it.spec.ts` → verify: ① 建仓意图下 Δ 带内打标、带外不打 ② **收租意图打开建仓 Tab → 推荐标数恒为 0**（`SC-005`，正确信号不是 bug）③ 水位未选 → 全表推荐标数恒为 0 ④ 真日历表下第三个周五的到期日带月度链标 ⑤ **构造第三个周五为非交易日**（往 `trading_day` 少插一行）→ 标落在前一交易日 ⑥ 打标不改变任何集合

## Phase 3: 精排层

- [ ] T010 [Server] **`leg-rank.rules.ts` 特征集 + 归一化**（FR-019, FR-019a, SC-003a, plan D-RANK-1）：新建 `apps/server/src/optionsdesk/leg-rank.rules.ts` —— `RankingFeatures`（**13 项**：连续 8 = 折算费率 / 有效成本相对 spot 折价 / 相对价差 / OI / Volume / 成交额 / `|Δ|` / DTE；布尔序数 5 = 月度链 / 整数行权价 / Δ 是否落意图带 / 是否跨财报 / 活跃排名）+ `computeRankingFeatures(members): RankingFeatures[]`（**只接受整个候选集，不提供单行版本** —— 同 `markActivity` 的理由）。三条边界：**`min === max` → `0.5`**（Guardrail 2）· 原始量缺失 → `0` · 布尔 → `0/1` 不参与 min-max。归一化后是 `number` 不是 `Prisma.Decimal`（沿 `leg-derive.rules.ts` 量纲纪律）→ verify: `leg-rank.rules.spec.ts`（Small）—— 🚨 **`min===max` 用例必须同时断言 `=== 0.5` 且 `Number.isNaN(v) === false`**（光断言 `[0,1]` 区间抓不到 NaN，因为 NaN 的所有比较都返回 `false`，区间断言会「通过」）+ 候选集只有 1 条腿 + 缺失取 `0` + **13 项在三种边界下全部恒落 `[0,1]`**（`SC-003a`）

- [ ] T011 [Server] **排序器 + 身份键 tie-break + `rankLegs`**（FR-020, FR-021, FR-022, FR-025, FR-026, SC-006, plan D-RANK-2）：`type LegRanker = (a: RankingFeatures, b: RankingFeatures) => number`；本片唯一实现 `rateDescendingRanker`（只读 `rate` 一项）；`rankLegs(members, features, ranker): string[]` —— ranker 返回 `0` 时用**身份键**兜底（到期日升序 → 行权价降序 → 合约代码）。🚨 **确定性次键 MUST NOT 塞进特征集**：到期日 / 行权价 / 合约代码是**身份**不是特征，合约代码更没法归一化。🚫 MUST NOT 引入加权评分（`FR-026`）→ verify: `leg-rank.rules.spec.ts` 补 —— 同输入两次调用**逐行相同**（`SC-006`）+ 费率相同时身份键生效且顺序确定 + **`rateDescendingRanker` 函数体 `grep -i dte` 零命中**（`FR-022` 机械判据）+ ranker 签名只吃 `RankingFeatures`（类型层证明 `FR-020`）

- [ ] T012 [Server] **use case 接精排 + `tierByTab` + 三份有序列表**（FR-021a, FR-023, FR-024, plan D-RANK-3/D-API）：三个 Tab 各跑一遍「召回 → `markActivity` → `computeRankingFeatures` → `rankLegs`」产出 `tabOrder`；每腿算 `tierByTab`（build 用周化档界 / rent 用年化 / **all 恒年化**），**非成员恒 `null`**；现役标量 `tier` / `basis` 定为「进建仓召回集 → `weekly`，否则 `annualized`」。🚫 **`legs[]` 的既有排序键一行不改**（Guardrail 10）→ verify: `get-legs.usecase.spec.ts` 补 —— `tabOrder[t]` 的元素集合 == `{leg.code | t ∈ leg.tabs}`（Guardrail 9 的同源判据）+ `tierByTab` 对非成员恒 `null` + **`legs[]` 的排序键与改造前相同**（tier → 到期日 → 行权价 → code），判据 = 取「改造前后都存在」的那批腿构成的子集，其相对顺序逐条一致。🚫 **MUST NOT 写成「`legs[]` 顺序与改造前逐行相同」** —— 召回换代后成员本来就变了（权利金门槛移走一批），那条断言字面上不可能满足，只会在实现时被随意放宽

- [ ] T013 [Server-IT] **精排 + 一致性 IT**（US4 全 5 条 AS, SC-006）：新建 `apps/server/test/integration/optionsdesk-050.rank.it.spec.ts` → verify: ① 三份有序列表各自按折算费率降序 ② 连续两次请求返回顺序**逐行相同** ③ 同一条腿在两个 Tab 的 `tierByTab` 可不同、`all` 恒年化 ④ `tabOrder` ↔ `tabs` 一致性（两处同源）⑤ DTE 高而费率高的腿排在 DTE 低而费率低的腿之前

## Phase 4: 契约与收口

- [ ] T014 [Contract] **DTO 六个新字段 + OpenAPI + api-client regen**（FR-019b, FR-027, SC-008, plan D-API）：`optionsdesk.dto.ts` 加顶层 `tabOrder` / `gateCounts`（含 `removedByPremiumFloor` + `excludedFromIntentTabs`）/ `basisByTab`，每腿 `isRecommended` / `isMonthlyChain` / `tierByTab`；两个计数的 swagger `description` MUST 各自写明「移出响应」vs「仍在响应、只进全腿 Tab」；swagger 装饰器齐全（⚠️ nullable string 的 `@ApiProperty` 必须显式 `type: 'string'`，否则 orval 误生 objectmap）；跑 `nx run server:export-openapi` + `packages/api-client` regen。🚫 **特征集 MUST NOT 进 DTO**（`FR-019b`）→ verify: `openapi.json` 的 diff **只含新增、零删除零改名**（`SC-008` 的机械判据）+ 生成 schema 里 `grep -i RankingFeatures` 零命中 + `nx typecheck` 全包绿（mobile 不改一行仍编译）

- [ ] T015 [Server-IT] **047 既有 IT 逐条过**（FR-028, plan D-TEST-2）：把 `optionsdesk-047.leg-picker.it.spec.ts` 等既有 IT 全部跑一遍，对每条红的断言判「**该红 / 不该红**」并各自处置：该红 → 改断言并在 commit message 写明**为什么该红**；不该红 → 那是改坏了，回去修实现。🚨 **批量改绿是本片最大的风险动作** —— 不该红却红了 = 改坏了；该红却绿了 = 判据没生效。🚫 MUST NOT `.skip` / 弱化断言 / 删断言 → verify: 全量 `nx test server --skip-nx-cache` 绿；**每条被改的断言在 commit message 里各有一行理由**；改动条数与「预期会变的行为」条数对得上（预期清单：召回集合 / 收租锚轴退役 / 权利金门槛滤除 / `basis` 归属）

- [ ] T016 [Server-IT] **perf IT（env-gated）**（SC-007, plan D-TEST-3）：新建 `apps/server/test/integration/optionsdesk-050.legs-perf.it.spec.ts`，照抄 `optionsdesk-047.legs-perf.it.spec.ts` 的 `RUN_PERF_IT` / `PERF_IT_REPS` 范式（默认 skip，CI fast suite 不变慢）→ verify: `RUN_PERF_IT=true` 实跑 730 行，**p50 ≤ 150ms / p95 ≤ 300ms**（= 047 实测档，`optionsdesk-047.legs-perf.it.spec.ts:53-54`）；读数写进 commit message

- [ ] T017 [Server] **两道门槛阈值实测标定 + 回写 spec**（FR-007, SC-002/SC-004, 主 plan 未决 #2）：用 dev 真实链数据（期权表已由每日同步维护）跑分布统计，定 `PREMIUM_FLOOR` 双参数与 `LIQUIDITY_MAX_RELATIVE_SPREAD` 的值；把标定过程与结论回写 `spec.md` 的 Assumptions/验证段 → verify: 标定前后**召回集行数 + 两个滤除计数**实测入档；`SC-002` 找到至少 1 条「047 下进不了任何意图 Tab、050 下进建仓」的真实腿（记合约代码 + DTE + 有效成本）；`SC-004` 找到至少 1 条 greeks 缺失但进了意图 Tab 的真实腿；🚨 **标定后回看 1–3 天腿是否仍霸榜**（clarify Q2 定的「不加额外分散手段」的前提），若仍霸榜则 flag 给 user 决策**而不是自行加机制**

- [ ] T018 [Docs] **回填主 plan**（plan D-RECALL-3）：更新 `docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md` —— ① 四片表 P1 标 ✅ ship + 退出标准逐条打勾 ② **把「费率下沉 SQL」从 P1 行移到 P3 行**，并写明否决理由三条 + P3 届时 MUST 配「SQL 结果 == 纯函数结果」等价 IT ③ 新增「P1 交付物」段：六个新契约字段的逐字签名 + 四个新 rules 文件的导出清单（P2 照着接）④ 未决 #2 标已定（填入 T017 标定值）→ verify: 主 plan 四片表与不变量段已更新；契约字段清单与 `optionsdesk.dto.ts` 逐字一致

---

## Dependencies & 执行顺序

```text
T001 → T002 → T003
        └──→ T006 → T007 → T008 → T009
T002 → T004 → T005
T010 → T011 → T012 → T013
(T004 & T008 & T012 全落) → T014 → T015 → T016 → T017 → T018
```

- `T003` 与 `T004` 可并行（不同文件）；`T010`/`T011` 与 Phase 1–2 正交，可提前起手（纯函数不依赖 use case）
- **关键阻塞**：`T001` / `T002` 未过 = 召回判据没换 ⇒ Phase 2–4 全部无意义，不要往下做
- `T012` 依赖 `T008`（`tierByTab` 要知道成员关系）与 `T011`（要 `rankLegs`）

## Clear 检查点批次

per `implement-task-closure` 的 clear 批次纪律（批次 ≠ commit 合并，每 task 仍各自 atomic commit）：

1. **批次 A**：T001 – T003（召回判据 + 守门，同一条机制链）
2. **批次 B**：T004 – T005（use case 接召回 + 它的 IT）
3. **批次 C**：T006 – T009（打标层四条）
4. **批次 D**：T010 – T013（精排层四条）
5. **批次 E**：T014 – T016（契约 + 回归 + perf）
6. **批次 F**：T017 – T018（标定 + 回填）

## Acceptance Scenario 覆盖矩阵（20 条 → task，逐条 1:1）

| AS      | 判据                                             | 归属 task                          |
| ------- | ------------------------------------------------ | ---------------------------------- |
| US1-AS1 | 有效成本 111 > spot（旧判据照收）→ 不进建仓      | T001 · **T005**                    |
| US1-AS2 | DTE=35 且门槛过 → 同时进建仓与收租               | T001 · **T005**                    |
| US1-AS3 | greeks 缺失但其余合格 → 照常进意图候选           | T001 · **T005**                    |
| US1-AS4 | DTE=400 → 两个意图都不进、`all` 可见             | T001 · **T005**                    |
| US2-AS1 | `bid` 低于权利金门槛 → 三 Tab 全不见 + 计数含它  | T001 · T004 · **T005**             |
| US2-AS2 | 价差高于流动性门槛 → 不进 build/rent、`all` 可见 | T001 · T004 · **T005**             |
| US2-AS3 | 完全无 `bid` → 按不满足权利金门槛处置，禁当 0    | T001 · **T005**                    |
| US2-AS4 | 有 `bid` 无 `ask` → 流动性 fail-closed           | T001 · **T005**                    |
| US2-AS5 | 全被挡下 → Tab 空态且仍可进入（非 404）          | **T005**                           |
| US3-AS1 | 建仓意图 → Δ 带内打推荐标、带外不打              | T006 · **T009**                    |
| US3-AS2 | 收租意图 + 建仓 Tab → 推荐标数为 0               | T006 · **T009**                    |
| US3-AS3 | 收租意图 + 水位未选 → 全表零推荐标               | T006 · **T009**                    |
| US3-AS4 | 到期日 = 第三个周五 → 该日全部腿带月度链标       | T007 · **T009**                    |
| US3-AS5 | 第三个周五为假日 → 提前后的到期日仍带标          | T007 · **T009**                    |
| US3-AS6 | 任意标组合 → 不改变集合成员（打标零拦截）        | T008 · **T009**                    |
| US4-AS1 | 有序列表按折算费率降序，client 不重排            | T011 · T012 · **T013**             |
| US4-AS2 | 费率相同 → 两次调用逐行相同                      | T011 · **T013**                    |
| US4-AS3 | DTE 高费率高的腿排在 DTE 低费率低之前            | T011 · **T013**                    |
| US4-AS4 | 同腿两 Tab 档位可不同、`all` 恒年化              | T012 · **T013**                    |
| US4-AS5 | 排序器只能从特征集读量                           | **T011**（类型层 + `grep` 双判据） |

## state_branch 覆盖矩阵（21 条 → task，逐条 1:1）

| #   | 分支                                               | 归属 task                                            |
| --- | -------------------------------------------------- | ---------------------------------------------------- |
| 1   | 有效成本 ≥ spot → 不进建仓；收租不受限             | T001 · T005                                          |
| 2   | 有效成本 < spot 且 DTE∈[1,49] → 进建仓             | T001 · T005                                          |
| 3   | DTE∈[30,49] → 同时进两个意图                       | T001 · T005                                          |
| 4   | DTE∈(49,365] → 只进收租                            | T001 · T005                                          |
| 5   | DTE>365 → 只在 `all`                               | T001 · T005                                          |
| 6   | `bid` 低于权利金门槛 → 三 Tab 全不进 + 计数        | T001 · T004 · T005                                   |
| 7   | 无 `bid` → 同上（禁当 0）                          | T001 · T004 · T005                                   |
| 8   | 价差高于流动性门槛 → 不进 build/rent、`all` 可见   | T001 · T004 · T005                                   |
| 9   | 无 `ask` → 流动性 fail-closed                      | T001 · T005                                          |
| 10  | greeks 缺失 → 进召回集但恒不打推荐标               | T001 · T006 · T005 · T009                            |
| 11  | 建仓意图 + Δ 带内 → 打推荐标                       | T006 · T009                                          |
| 12  | 收租意图 + 水位已选 → 按档带打；未选 → 不打        | T006 · T009                                          |
| 13  | 收租意图 + 建仓 Tab → 零推荐标（配就地说明）       | T006 · T009                                          |
| 14  | 待定 / 不开新仓 → 全表零推荐标，数据照常           | T006 · T009                                          |
| 15  | 到期日 = 第三个周五 → 打月度链标                   | T007 · T009                                          |
| 16  | 第三个周五非交易日 → 取前一交易日，仍打标          | T007 · T009                                          |
| 17  | 某项特征全等（含单条候选集）→ 归一化 `0.5`，禁 NaN | **T010**                                             |
| 18  | 某项原始量缺失 → 归一化 `0`                        | **T010**                                             |
| 19  | 某 Tab 召回集为空 → 空态仍可进入                   | T005                                                 |
| 20  | 折算费率相同 → 身份键定序，两次调用逐行相同        | T011 · T013                                          |
| 21  | 链未就绪 / 跨 ctx 读失败 → 沿用 047 两个显式状态   | **T015**（047 既有 IT 回归，本片 MUST NOT 改其行为） |

## Edge Case 覆盖（7 条 → task）

| Edge Case                                                        | 归属 task                                 |
| ---------------------------------------------------------------- | ----------------------------------------- |
| 月度到期日撞假日（判据是「该月的月度到期日」不是「是不是周五」） | **T007**（单测构造）· T009（真日历表）    |
| 有效成本判据只在建仓语义下成立（误加到收租不会红）               | **T001**（收租不受限用例）· T005          |
| 两段 DTE 的重叠区 `[30,49]` 是设计意图不是重复                   | T001 · T005 · T013（两 Tab 档位可不同）   |
| 活跃度排名基准 = 该 Tab 召回全量，顺序恒为 排名→筛选→截断        | **T008**（`markActivity` 入参断言）· T012 |
| 收租意图下建仓 Tab 零推荐标（长得跟打标坏了一样）                | T006 · **T009**                           |
| 门槛把某 Tab 清空 → 仍可进入不禁选                               | **T005**                                  |
| 无 `bid` 与 `bid` 很低是两件事（处置同归但禁当 0 实现）          | **T001**（禁当 0 的机械判据）· T005       |

## SC 覆盖（10 条 → task；**故意零覆盖的已写明**）

| SC                                                        | 归属 task                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| SC-001 建仓集内零条有效成本 ≥ spot                        | **T005**（真实链数据全量核对）                              |
| SC-002 至少 1 条 15–49 天腿从「进不去」变「进建仓」       | **T017**（需真实数据，合成 fixture 证明不了「空档被填上」） |
| SC-003 两个滤除计数各自与实际逐次相等                     | T004 · **T005**                                             |
| SC-003a 13 项特征恒落 `[0,1]`（含三种边界）               | **T010**                                                    |
| SC-004 至少 1 条 greeks 缺失腿进意图候选                  | T005（构造）· **T017**（真实数据实证）                      |
| SC-005 收租意图建仓 Tab 推荐标恒 0 / 待定全表恒 0         | T006 · **T009**                                             |
| SC-006 同输入两次请求三个 Tab 顺序逐行相同                | T011 · **T013**                                             |
| SC-007 端到端不劣于 047 基线（p50 150 / p95 300 @730 行） | **T016**                                                    |
| SC-008 旧客户端零报错渲染（契约向后兼容）                 | **T014**（`openapi.json` diff 只含新增的机械判据）          |
| SC-009 阈值 / 段界 / Δ 带各自只有一处定义                 | **T003**（机器强制，且必须先证明它会红）                    |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 项                                                       | 为什么零覆盖是对的                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR-019b 特征集不下发**                                 | **负向约束**，没有能产出 AS 的正向行为。判据是 T014 的 `grep RankingFeatures` 零命中，不需要单独 task                                                                                                                                    |
| **FR-026 不引入加权评分**                                | 同上。结构上已由 `FR-020`（排序器只读特征集，T011 类型层证明）堵死                                                                                                                                                                       |
| **FR-028 PR body flag 行为变化**                         | **流程要求不是系统行为**。三处必 flag：召回集合变了 / 收租锚轴退役 / 权利金门槛让腿从 UI 消失。证据是 PR body 本身，`pr-creation-protocol.md` 的 CI regex 只扫部署 gate，这条要人工把关                                                  |
| **FR-029 045 锚派生与意图矩阵零改动**                    | **负向约束**。判据 = `git diff` 对 `anchor.rules.ts` / `intent-matrix.rules.ts` 零命中，收口时扫一次                                                                                                                                     |
| **`[Mobile-E2E]` / `[Contract-Smoke]` 两个层级整体缺席** | 本片**零 mobile 改动** ⇒ 按 Constitution §V 字面**非跨端 feature**。契约冒烟验的是「mobile 生成客户端打真 server」，本片没有任何 mobile 消费点可验。P2 消费新字段时才是跨端片 —— 这是 plan Constitution Check 里的**显式判断**，不是遗漏 |
| **`schema.prisma` / migration 零 task**                  | 本片全部派生请求时算，零物化列（沿 047 `FR-041`）                                                                                                                                                                                        |

## MVP

**T001 – T005** = 判定层正确性的完整交付：粗召回 + 有效成本硬判据 + 两道门槛 + 可见计数。它独立可验、独立有价值（建仓视角不再推荐比直接买还贵的腿，136 天空档被填上），且是 P2 / P3 的硬前置。

Phase 2–4 是同 PR 的增量：打标层提升可读性、精排层为将来加权备好特征、契约层解开 P2 的堵。

## 单 PR（Constitution §V）

本片纯 server ⇒ 单 PR。⚠️ 但 **T014 会动 `apps/server/openapi.json` 与 `packages/api-client/src/`**（类型同步链，Constitution §V）—— 这两处产物**必须与 server 改动同 PR**，否则 P2 拿不到新类型且 `openapi.json` drift。
🚨 PR body MUST 逐条 flag 三处用户可见的行为变化（见「故意零覆盖登记」FR-028 行），MUST NOT 当作「无感知升级」交付。
