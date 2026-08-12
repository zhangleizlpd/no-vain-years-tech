---
feature_id: 050-optionsdesk-leg-recall-rank
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-11'
updated_at: '2026-08-11'
adr_refs: ['0043', '0032', '0034']
context7_verified: []
---

# Implementation Plan: 选约引擎 server 三层重构 —— 召回 / 打标 / 精排（P1）

> 产物 = **仅本文（prose-only）**。data model SoT = `schema.prisma`（本片**零 schema 改动**）、API SoT = swagger 装饰器。**不造** `research.md` / `data-model.md` / `quickstart.md` / `contracts/`。
> 📌 本片是 optionsdesk 选约引擎重构四片中的 **P1**。主 plan：`docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有）。

## Summary

把 047 的「硬分腿族」判定层换成**召回 + 打标 + 精排**三段式：DTE 粗召回 + 三道硬约束（有效成本 / 权利金 / 流动性）、Δ 从过滤器降级为推荐标、新增月度链标、精排收回 server 并下发三份有序列表。纯 server + 契约只加不删；`schema.prisma` 一行不动。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None                                     | N/A  | 本片零新包。金额 / 费率沿用 `Prisma.Decimal`（Decimal.js，已装）；归一化后的统计量用 `number`（沿 `leg-derive.rules.ts` 既有量纲纪律：金额 Decimal / 统计量 number）。月度到期日判定用 `Date` 原生 + 既有 `marketdata.trading_day` 表，**不引日期库**（判据只有「第三个周五」一条，`O(1)` 手写十行） |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 逐条核对：
  - **§I SDD**：specify → clarify（5 问用满配额）→ plan，未跳步。**本片零 UI ⇒ 无 Mockup 步**（Constitution v1.4.0 明写「后端 use case（无 UI）无此步」）。
  - **§II TDD**：每 task 红→绿→typecheck/lint→`[X]`→stage→commit 六步闭环。✅ 本片主体是**纯函数判定**，TDD 落点极实（与 049 的「手势布局纯函数面很薄」相反）——四个新 `*.rules.ts` 全部可 Small 档单测。
  - **§III 原子 task**：下方切分均为 30min–2h 单 commit 粒度。
  - **§IV Module Boundary**：本片全部落在 `optionsdesk/` 内，扁平文件平铺、贫血 Prisma row、直注 `PrismaService`、零 class。**新增一处跨 ctx 只读**（`marketdata.trading_day`），走 `CROSS-CONTEXT-READ` 注释（`check-server-moat.ts` 机器强制），零 `@Inject()` 对方 use case，跨 ctx 写永远禁。
  - **§V 类型同步链 + PR 边界**：契约有新增字段 ⇒ **本 PR 内必须跑** `nx run server:export-openapi` + `packages/api-client` regen（否则 P2 拿不到新类型且 `openapi.json` drift）。⚠️ 但**本片不改一行 mobile 代码** ⇒ 按 §V 字面**非跨端 feature**，故**不落 `[Contract-Smoke]`**、不落 `[Mobile-E2E]`——这是显式判断不是遗漏：契约冒烟验的是「mobile 生成客户端打真 server」，而本片没有任何 mobile 消费点可验。P2 消费新字段时才是跨端片。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: golden path 落 `apps/server/test/integration/optionsdesk-050.*.it.spec.ts`（Testcontainers 真 PG，同 047 既有五个 IT 的形制）。**判据必须是「集合」而非「有值」**——召回换代的失败形态是「返回了腿、数量也合理、只是成员错了」，断言必须逐条比对成员集合与顺序，不能只断言 `legs.length > 0`。
- [x] **Mobile / Web**: N/A —— 本片零 mobile 改动。
- [x] **Evidence**: 两道门槛的阈值由 **T014 用 dev 真实链数据标定**并回写 spec；perf 由 `optionsdesk-050.legs-perf.it.spec.ts` 对照 047 实测档（p50 ≤ 150ms / p95 ≤ 300ms @ 730 行，`optionsdesk-047.legs-perf.it.spec.ts:53-57`）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。改的 `apps/server/src/optionsdesk/*` 全部由 045/046/047（2026-08）在 mono 内新建，无 meta-repo 迁移史。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR          | Open Question / sunset trigger                                                                         | Classification   | Mitigation / next step                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0034** | 跨 ctx 只读直查（Q7-B）是**临时路径**，sunset 到「Outbox replay 物化视图 / SecurityModule 共享读服务」 | `accepted-as-is` | 本片**新增一处**同类只读（`marketdata.trading_day`，月度到期日判定）。它与 047 已有的四处（`instrument` / `option_contract` / `option_daily_snapshot` / `earnings_event`）**同形同注释**，不新增形态、不加深耦合。sunset 到来时五处一起迁，成本不因本片增加 |
| **ADR-0043** | §4 rules 文件持无副作用业务规则                                                                        | `accepted-as-is` | 本片新增三个 `*.rules.ts` 严格遵此：零 I/O、零 DI。**月度到期日的日历查询留在 use case**，纯函数只吃「候选日期集 + 交易日集」两个入参 —— 这是本片唯一一处「纯函数需要外部事实」的地方，处置方式已定死                                                       |
| **ADR-0032** | bounded context 边界                                                                                   | `accepted-as-is` | 本片零新 context、零反向依赖                                                                                                                                                                                                                                |

**Evidence**: 逐条读三个 ADR 的 frontmatter；ADR-0063（横滑）与本片无交集（那是 mobile 片）。

## Architecture Notes

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**：IT MUST 打真 Nest 应用 + Testcontainers PG（同 047 五个既有 IT）。🚫 MUST NOT mock `PrismaService` 去「验证召回集合」——那等于把被测的谓词换成假的。
- **MANDATORY INTEGRATION**：召回换代的核心风险是**集合错**，而集合错在单测里可以被精心构造的 fixture 掩盖。⇒ 每一条召回判据 MUST 有一条打真 DB 的 IT，断言**成员集合逐条相等**。
- **EXHAUSTIVE BRANCHING**：`spec.md` 的 `state_branches` 每条都要有归属。**条数一律实时 grep，别抄本段。**

### General Architecture Notes

> ADR-0043 的「扁平 + 贫血 + 护城河 + 零-class」在本片**完全适用**（纯 server）。详版 guardrails 见 `docs/conventions/server-impl-playbook.md`。

---

### D-RECALL · 召回层（`FR-001`–`FR-010`）

#### D-RECALL-1 · 新建 `leg-recall.rules.ts`，**不原地改** `leg-tab.rules.ts`

现役 `leg-tab.rules.ts` 承担两件事，本片一件整个换代、另一件一行不改：

| 现役职责                                                                     | 本片处置                                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ① Tab 成员判据（`legTabs` / `isBuildLeg` / `isRentLeg` + Δ 带常量 + DTE 界） | **整块换代** → `leg-recall.rules.ts`；Δ 带常量**迁**打标层（不是删，见 D-MARK-1） |
| ② 财报打标域划分（`earningsLegFamilyFor` / `RENT_SHORT_MAX_DTE_DAYS`）       | **一行不改**（`FR-017`），留在原文件                                              |
| ③ `LEG_TABS` / `LegTab` 类型                                                 | 留在原文件 —— Tab 这个概念不随召回换代                                            |

🚨 **语义翻转必须连带改名，这是本片最危险的静默坑**（同源教训：049 D-SCROLL-1 的 `offset`→`tx`，不改名则编译绿而真机方向反了）：

`isBuildLeg(leg)` 现役语义 = 「这条腿是建仓**族成员**」，判据 `|Δ|∈[0.40,0.55] ∧ DTE≤14`。
新语义 = 「这条腿进建仓**召回集**」，判据 `DTE∈[1,49] ∧ K−bid<spot ∧ 两道门槛`。

**入参也变**（新判据要 `spot` / `bid` / `ask`，旧判据只要 `absDelta` / `dteDays` / `strike`）⇒ 签名不兼容 ⇒ 编译器这次帮得上忙。但 `legTabs()` 名字与返回类型完全一样，**沿用它则调用点一行不改、判据全错**。

```text
apps/server/src/optionsdesk/leg-recall.rules.ts（新）
  BUILD_RECALL_DTE / RENT_RECALL_DTE            // DTE 段常量（单点）
  PREMIUM_FLOOR / LIQUIDITY_MAX_RELATIVE_SPREAD // 两道门槛阈值（单点，FR-007）
  recallTabs(context, leg): LegTab[]            // 三个 Tab 的召回归属；all 不设期限段（FR-003）
  passesPremiumFloor(leg, spot): boolean        // 全 Tab 作用（FR-005）
  passesLiquidityGate(leg): boolean             // 只 build/rent（FR-006）；无 ask ⇒ false（fail-closed）
  relativeSpread(bid, ask): Decimal | null      // (ask−bid)/mid
```

🚨 **`recallTabs` 的入参里 MUST NOT 有 `absDelta`**（`FR-009`）—— 这是「Δ 已降级为标」的**结构保证**而非事后约定：拿不到这个量，就不可能拿它做召回判据。想把 Δ 塞回召回就必须先改签名，那一步是显式的、review 看得见的。同理 greeks 缺失的腿照常进召回集（`FR-013` 前半）。

**机械判据**：`grep -rn "isBuildLeg\|isRentLeg\|legTabs\|BUILD_LEG_ABS_DELTA_BAND\|BUILD_LEG_MAX_DTE_DAYS\|RENT_LEG_MIN_DTE_DAYS\|RENT_LEG_MAX_DTE_DAYS\|ANCHOR_AXIS_ZONES" apps/` **零命中**。

📌 **锚轴判据（`K ≤ W`）整条退役**：047 的收租族在卖 put 区走「锚轴」而非 Δ 带。新范式下收租召回只看 DTE 段 + 两道门槛（`FR-002`），Δ 只打标 ⇒ 锚轴不再是成员判据。`ANCHOR_AXIS_ZONES` 与 `isRentLeg` 一并删。**这会扩大收租召回集**（原先买区只收 Δ 带内的腿），属于已 flag 的成员集合行为变化。

#### D-RECALL-2 · 阈值单点 + 机器强制

`FR-007` 要求阈值单点可配、`SC-009` 要求「全仓扫描零重复定义」——后者需要一个**机器判据**，否则只是口号。

仓内已有现成模式：`scripts/checks/check-optionsdesk-rule-constants.ts` 守「档位系数只许出现在 `anchor.rules.ts`」，且**被禁字面量从源文件自身派生**（不在检查器里写死，否则检查器自己就是第二处硬编码）。

⇒ **扩展该脚本**，🚫 MUST NOT 新写一个 —— 同一类不变量分两个文件，调参时必漏一个。

🚨 **但阈值与 DTE 界 MUST 走两套不同判据**（2026-08-11 analyze 定，读实现后得出，不是推测）：

| 对象                                              | 判据                                                                                                   | 为什么不能用另一套                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **两道门槛阈值**（小数）                          | 沿用既有的**子串扫描**（`extractCoefficients` → `findOffenders`）                                      | —                                                                                                                                      |
| **三段 DTE 界**（整数 `1` / `49` / `30` / `365`） | **扫比较表达式**：`dteDays\s*[<>=!]+\s*[1-9][0-9]*` 在 `leg-recall.rules.ts` 与 `*.spec.ts` 之外零命中 | 既有机制第 76–77 行**显式过滤掉不含小数点的字面量**，注释原文：「整数系数当子串扫会把行号 / 数组下标全扫成违规」。`1` 会命中几乎每一行 |

📌 **比较表达式判据必须排除比较对象为 `0` 的形式** —— `leg-derive.rules.ts:81` 的 `dteDays <= 0` 是合法守卫（DTE≤0 时费率无定义），不写 `[1-9]` 会让判据**恒红**。已实测：收窄后现役零命中，收窄前 1 处命中。（同源教训：047 T039 的 `rg 'optionsdesk'` 判据也是因 1 处 pre-existing 命中而恒红，只好改扫依赖形态。）

🚨 **扫描面 MUST 排除 `*.spec.ts`** —— 既有实现 `:128-129` 是 `readdirSync(ctxPath).filter(f => f.endsWith('.ts') && f !== RULES_FILE)`，**测试文件也在扫描面内**。守 anchor 系数时这没问题（那些值不出现在断言里），但**新不变量不一样**：`leg-recall.rules.spec.ts` 必须在断言里写出边界值，照抄扫描面会让它立刻违规。

⚠️ **撞值风险，标定阈值时 MUST 避开**：`leg-tier.rules.ts` 已有六个档界字面量 `0.006 / 0.01 / 0.02 / 0.05 / 0.10 / 0.15`。子串扫描认的是**值不是名字** ⇒ 两道门槛的取值若与其中之一相同，检查器会把 `leg-tier.rules.ts` 报成违规。撞上时 **MUST 改阈值取值**（T017 标定阶段调整），🚫 **MUST NOT 放宽检查器** —— 那会让 `SC-009` 显示为「已机器强制」而实际没有，比不装更糟。

#### D-RECALL-3 · 🚨 本片**不下沉 SQL**（显式否决主 plan P1 行的字面表述）

主 plan P1 行写「召回（… + **费率下沉 SQL**）」。本片**不做**，三条理由：

1. **召回判据根本用不到费率** —— 逐条看：DTE 段（`expiry_date`）、有效成本 `K−bid<spot`、权利金 `bid ≥ max(下限, spot·比例)`、流动性 `(ask−bid)/mid ≤ 上界`。**没有一条含费率**。费率只服务精排，而本片**不截断** ⇒ 排序在内存里做完全够。
2. **下沉会制造第二份判据实现** —— 阈值要在 SQL 里写一份、在 rules 纯函数里再写一份（单测需要它）。这正是 `FR-007` / `SC-009` 要防的事，而且 drift 时**不会红**：两边各自算得出数，只是不是同一个数。
3. **本片收益是负的** —— 047 实测 p50 150ms / p95 300ms @730 行，判定是 `O(n)`、n ≤ 730。下沉省的是那点网络传输，换来一份不可 Small 档单测的判据。

📌 **P3 才是下沉的正确时机**：那时要 server 截断 top-N，`ORDER BY … LIMIT` 必须在 SQL 里，费率随之必须下沉。届时 rules 纯函数仍是判据 SoT、SQL 是它的镜像，且 **MUST 配一条「SQL 结果 == 纯函数结果」的等价 IT** —— 这个代价在有截断收益时才值得付。
⇒ **T015 回写主 plan**：把「费率下沉 SQL」从 P1 行移到 P3 行。

#### D-RECALL-4 · 边界与量纲三条

1. **有效成本判据取严格小于**（`K − bid < spot`）。恰好相等 ⇒ 不进建仓召回：成本持平时「用 put 代替直接买」没有任何优势，只多出被指派的不确定性。
2. **全部金额比较走 `Prisma.Decimal`**，不转 `number` —— 与 `leg-derive.rules.ts` 既有纪律一致。
3. **无 `bid` ⇒ 权利金门槛判 false**（`FR-005` + spec Edge Case）。🚫 MUST NOT 通过「把无 `bid` 当 0」实现 —— 那会污染费率与有效成本的所有下游计算，而且算得出数、不会红。

---

### D-MARK · 打标层（`FR-011`–`FR-018`）

#### D-MARK-1 · 推荐标：Δ 带从召回判据**迁**为打标判据

```text
apps/server/src/optionsdesk/leg-mark.rules.ts（新）
  BUILD_RECOMMEND_ABS_DELTA_BAND               // 自 leg-tab.rules.ts 迁入，值不变
  RENT_RECOMMEND_ABS_DELTA_BANDS               // 同上（三档）
  isRecommended(intent, rentDepth, absDelta): boolean
  thirdFridayOf(year, month): string           // D-MARK-2
  resolveMonthlyExpiries(candidates, tradingDays): Set<string>
```

🚨 **本片最容易照抄错的一点**——现役 `rentAbsDeltaBand(null)` 在水位未选时返回**三档并集**，那在 047 是**对的**；同一个函数迁到打标层是**错的**：

| 语义                                  | 「不替人做方向性假设」导出的行为                        |
| ------------------------------------- | ------------------------------------------------------- |
| **召回**（047）：Δ 带决定腿进不进来   | 未选水位 ⇒ 取**并集**（放宽收进来，别替人砍掉候选）     |
| **打标**（050）：Δ 带决定打不打推荐标 | 未选水位 ⇒ **不打**（`FR-012`；打了就是替人指了个方向） |

**同一条原则，在两个语义下导出相反的行为。** 照抄 `rentAbsDeltaBand` 会让「水位未选」时全表冒出一片推荐标，而它长得完全正常。
⇒ `isRecommended` **不复用** `rentAbsDeltaBand`，`null` 分支直接 `return false`；`rentAbsDeltaBand` 随 `isRentLeg` 一并删。

#### D-MARK-2 · 月度链标：日历查询的形状（`FR-014` / `FR-015`）

判据需要外部事实（哪天是交易日）⇒ 纯函数算不了。分工定死：

1. **纯函数** `thirdFridayOf(year, month)` —— `O(1)`，零 I/O。
2. **use case** 对链上全部到期日取不同的 `(year, month)` → 候选第三个周五集合 `F`。
3. **一次**跨 ctx 查询：`trading_day where market='us' and date between min(F)−7 and max(F)`。
   📌 `−7` 的依据：美股连续休市（含周末）从不超过 4 个日历日，7 天有充足余量。**这个数字 MUST 带注释说明来源**，否则下次有人改成 3 也看不出问题。
4. **纯函数** `resolveMonthlyExpiries(F, tradingDays)` —— 每个 `F` 若在交易日集内取 `F`，否则取 `≤ F` 的最大交易日。
5. 打标：到期日 ∈ 该集合。

🚫 **MUST NOT 逐到期日查** —— 链上到期日有几十个，那是几十次往返。
🚫 **MUST NOT 从链自身的到期日分布反推月度日**（clarify 已否决）—— 靠数据形状猜规则，链数据不全时误判，而**误判时看起来完全正常**（标还在，只是标错了位置）。

跨 ctx 读 MUST 带 `// CROSS-CONTEXT-READ: marketdata.trading_day 只读直查（Q7-B）` 注释（`check-server-moat.ts` 机器强制，缺注释直接拒）。

#### D-MARK-3 · 活跃标：签名不变，但基准变了

`markActivity(members)` 现役已是「候选集内相对排名」，**签名与实现一行不改**。但成员集合换代 ⇒ 排名结果自然变化，**这不是 bug**。

🚨 **顺序纪律**（`FR-016` / `FR-024`）：`markActivity` MUST 在**召回之后、筛选之前**调用。本片无筛选 ⇒ 目前「召回集 == 排名基准」。P3 加筛选时 **MUST NOT** 把筛选挪到它之前——那样写出来照样能跑、数字照样有，只是全错。

---

### D-RANK · 精排层（`FR-019`–`FR-026`）

#### D-RANK-1 · 特征集与归一化（`FR-019` / `FR-019a`）

```text
apps/server/src/optionsdesk/leg-rank.rules.ts（新）
  RankingFeatures                                   // 13 项，全 number ∈ [0,1]
  computeRankingFeatures(members): RankingFeatures[] // 吃整个候选集（min-max 要全集）
  rateDescendingRanker: LegRanker                    // 本片唯一实现
  rankLegs(members, features, ranker): string[]      // 产出有序合约代码
```

`computeRankingFeatures` **只接受整个候选集、不提供单行版本** —— 与 `markActivity` 同形同理由：单行版本必然要拿全局阈值凑，而基准已定为「候选集内 min-max」。

🚨 **除零必须先判，这是 `FR-019a` 第一条的真实动机**：`min === max` 时 `(v−min)/(max−min)` = `0/0` = `NaN`。NaN 一旦进排序，`Array.prototype.sort` 的比较结果**不可预测**（与 NaN 的任何比较恒 `false`）⇒ 顺序变成实现相关，**且不抛任何错**。三条边界：

| 情形                                        | 取值                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 该项在候选集内全等（含候选集只有 1 条腿）   | `0.5`（中性）—— 取 `0` 会把全体误报成「都最差」，取 `1` 反之；常数取值不影响任何排序 |
| 原始量缺失（无 OI / 无成交量 / 费率无定义） | `0`，与 047 活跃度排名「缺失排末位」同口径                                           |
| 布尔量                                      | `0` / `1`，不参与 min-max                                                            |

**量纲**：归一化后是 `number`（统计量），**不是** `Prisma.Decimal` —— 沿 `leg-derive.rules.ts` 的「金额 / 费率用 Decimal，统计量用 number」纪律。

#### D-RANK-2 · 排序器只读特征集，确定性次键在外层（`FR-020` / `FR-025`）

```text
type LegRanker = (a: RankingFeatures, b: RankingFeatures) => number
```

🚨 **确定性次键 MUST NOT 塞进特征集** —— 到期日 / 行权价 / 合约代码是**身份**不是特征，合约代码更没法归一化到 `0–1`。分层：

- `ranker` 只吃 `RankingFeatures`，管**主键**（折算费率降序）⇒ `FR-020` 满足。
- `rankLegs` 在 `ranker` 返回 `0` 时用**身份键**兜底：到期日升序 → 行权价降序 → 合约代码 ⇒ `FR-025` 满足。

📌 归一化是单调变换 ⇒ 「归一化后费率降序」与「原始费率降序」逐行同序（同 `spec` `FR-021` 的 📌：周化 / 年化亦然）。本片三个 Tab 共用同一个 ranker。

🚨 **DTE 在特征集里但 MUST NOT 进 ranker**（`FR-022`）—— 它是 13 项之一（为将来加权备着，不变量 #9），但本片唯一的 ranker 只读 `rate` 一项。**两条禁令都要守**：既不许拿 DTE 当主键，也不许实现「离理想 DTE 越近越靠前」。理由在 spec：那会让年化 20% 的 60 天腿排在年化 8% 的 35 天腿后面，而要的是收益不是接近某个数字。DTE 已隐含在费率的分母里。
**机械判据**：`rateDescendingRanker` 的函数体里 `grep dte` **零命中**。

#### D-RANK-3 · `tier` 的 basis 跟 Tab 走 —— 现役标量字段怎么办（`FR-023` × `FR-027`）

现役 `basis = isBuildLeg(...) ? 'weekly' : 'annualized'`，**每腿一个** —— 因为 047 的腿只属一族。新范式下**同一条腿可同时在 build 与 rent Tab 且 basis 不同** ⇒ `tier` 不再是腿的属性，是 **(腿, Tab)** 的属性。

契约只加不删 ⇒ 现役 `tier` / `basis` **保留**，另加 per-Tab 的。现役那两个字段留什么值？

| 方案                                                  | 判定                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **(选定) 进建仓召回集 → `weekly`，否则 `annualized`** | 规则明确无歧义；是现役语义（「这条腿主要该用哪个口径看」）在新范式下最自然的延续；不需要为喂一个 legacy 字段而保留旧判据       |
| 恒 `annualized`（= 全腿 Tab 口径）                    | ❌ 否决：年化 = 周化 × 52.14，而档界只差 7.5 倍 ⇒ 短腿在年化档界下**普遍显示为「好」**。P1→P2 窗口期里这是**系统性的乐观误导** |
| 冻结 047 旧判据专供 legacy 字段                       | ❌ 否决：要把刚删掉的 Δ 带成员判据再养活一份，是 dead code 的近亲，且调参时必漏                                                |

⚠️ 同时在两个 Tab 的腿取 `weekly`（build 优先）—— 明确规则，不是任意选择。

📌 **`FR-028` 的落点就在这里**：本片有**三处**用户可见的行为变化，PR body MUST 逐条 flag，MUST NOT 当作「无感知升级」——① 召回集合变了（DTE 段 + 三道硬约束）；② 收租召回扩大（锚轴判据退役，D-RECALL-1）；③ 被权利金门槛滤除的腿**从 UI 上消失**（`FR-008` 的两个计数是唯一补偿）。

---

### D-API · 契约增量（`FR-027` / `FR-019b`）

**新增**（只加不删）：

| 字段                                                                            | 位置 | 说明                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabOrder: Record<LegTab, string[]>`                                            | 顶层 | 三份**有序合约代码**（`FR-021a`）                                                                                                                                                                                                                  |
| `gateCounts: { removedByPremiumFloor: number; excludedFromIntentTabs: number }` | 顶层 | 两个门槛计数（`FR-008`），刻意不合并成总数。🚨 **容器名不叫 `filteredOut`**：两个数语义不对称 —— 前者把腿**移出响应**（真消失），后者只把腿**排除出意图 Tab**（仍在全腿 Tab 可见）。用同一个暗示「滤掉」的词做容器名会让第二个数被读成「也消失了」 |
| `basisByTab: Record<LegTab, LegBasis>`                                          | 顶层 | Tab → 口径的**常量映射**，下发一次；免客户端硬编码 `FR-023` 的映射                                                                                                                                                                                 |
| `isRecommended: boolean`                                                        | 每腿 | 推荐标                                                                                                                                                                                                                                             |
| `isMonthlyChain: boolean`                                                       | 每腿 | 月度链标                                                                                                                                                                                                                                           |
| `tierByTab: Record<LegTab, LegTier \| null>`                                    | 每腿 | per-Tab 档位（D-RANK-3）                                                                                                                                                                                                                           |

**保留不动**：`legs[]` 的既有全部字段、`tabs[]`、`activityByTab`、`tier`、`basis`。

🚨 **两条一致性不变量**（都要有 IT 断言）：

1. `tabOrder[t]` 的元素集合 **==** `{ leg.code | t ∈ leg.tabs }` —— 两处表达同一个成员关系，MUST 从**同一处**派生。各算一份必 drift，而**两边都算得出结果**。
2. `tierByTab[t]` 对不属于 `t` 的腿恒 `null` —— 不属于该 Tab 就没有该 Tab 的档位。

🚫 **`legs[]` 的既有排序不许「顺手清理」** —— 有了 `tabOrder` 之后它的顺序确实不再承载语义，但旧客户端（P2 未上）仍按它渲染。改了会看起来乱，而**这不是编译期能发现的**。保留现役排序键（tier → 到期日 → 行权价 → code）并加注释说明它是 legacy 载体顺序、新消费方走 `tabOrder`。P2 切过去后由 P3 评估退役。

🚫 **特征集 MUST NOT 进 DTO**（`FR-019b`）—— 排序已在 server 完成，下发一批无人消费的字段会被「只加不删」永久锁死。机械判据：生成的 OpenAPI schema 里 `grep RankingFeatures` 零命中。

---

### D-TEST · 验证三层分工

#### D-TEST-1 · vitest Small（`*.spec.ts`，纯 rules）

**本片是 049 的反面 —— 纯函数面极厚**，TDD 落点全在这层：

| 文件                       | 必须覆盖的边界                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `leg-recall.rules.spec.ts` | DTE 段**四个端点**（1 / 49 / 30 / 365）· 有效成本 `<` vs `≤`（恰好相等必须不进）· 无 `bid` / 无 `ask` 两条 · 重叠区 `[30,49]` 同时进两个 Tab · greeks 缺失照常进                                 |
| `leg-mark.rules.spec.ts`   | 推荐标四种 intent × 水位选/未选 —— **含并集陷阱那条**（水位未选恒 `false`）· `absDelta` 为 `null` 时恒不打（`FR-013` 后半）· `thirdFridayOf` 跨年跨月 · 假日回退（构造第三个周五不在交易日集内） |
| `leg-rank.rules.spec.ts`   | 归一化三条边界 —— **`min===max` 必须断言产出 `0.5` 且 `Number.isNaN` 为 `false`** · 单条候选集 · 缺失取 `0` · 排序器主键 + 身份键 tie-break 确定性                                               |

❌ 覆盖不了：真实成员集合（fixture 可以精心构造到掩盖判据错）、跨 ctx 查询、契约形状。

#### D-TEST-2 · Testcontainers IT（`apps/server/test/integration/optionsdesk-050.*.it.spec.ts`）

**能覆盖且必须覆盖**：召回集合**逐条相等**（不是 `length > 0`）· 三份有序列表的顺序 · 两个滤除计数与实际相等 · `tabOrder` ↔ `tabs` 一致性 · `tierByTab` 对非成员恒 `null` · 月度链标走真日历表 · 047 既有 15 条 IT 断言的回归（哪些必然变、哪些必须不变要逐条过）。

🚨 **047 既有 IT 会红一批，这是预期的，但每一条都 MUST 逐条判「该红还是不该红」** —— 批量改绿是本片最大的风险动作。不该红却红了 = 改坏了；该红却绿了 = 判据没生效。

#### D-TEST-3 · Perf IT（env-gated）

新增 `optionsdesk-050.legs-perf.it.spec.ts`，照抄 047 那条的 `RUN_PERF_IT` / `PERF_IT_REPS` 范式（默认 skip，CI fast suite 不变慢）。判据 = **不劣于 047 实测档**：p50 ≤ 150ms / p95 ≤ 300ms @ 730 行（`SC-007`）。

---

### 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **`rentAbsDeltaBand(null)` 取并集在召回下对、在打标下错** —— 同一条「不替人做假设」的原则导出**相反**行为。照抄会让「水位未选」时全表冒推荐标，且长得完全正常。（D-MARK-1）
2. **min-max 归一化 MUST 先判 `min === max`** —— 否则产 `NaN`，NaN 进 `sort` 顺序不可预测**且不抛错**。（D-RANK-1）
3. **`markActivity` MUST 在召回之后、筛选之前** —— 最自然的写法是「先筛再排名」（少算一些），那样照样能跑、数字照样有，只是全错。（D-MARK-3）
4. **语义翻转 MUST 连带改名** —— `isBuildLeg` 判据全变，沿用旧名则调用点一行不改而判据全错。`grep` 零命中是完工判据。（D-RECALL-1）
5. **有效成本判据 MUST 只作用建仓** —— 误加到收租会砍掉大量本来正确的深虚腿，而且**不会红**。（`FR-004`）
6. **月度日 MUST 一次查回** —— 逐到期日查是几十次往返；`−7` 天窗口的依据 MUST 带注释。（D-MARK-2）
7. **`tabOrder` 与 `tabs` MUST 同源派生** —— 各算一份必 drift，而两边都算得出结果。（D-API）
8. **`legs[]` 既有排序 MUST NOT 顺手清理** —— 旧客户端仍按它渲染，改了会乱且非编译期可见。（D-API）
9. **跨 ctx 读 `trading_day` MUST 带 `CROSS-CONTEXT-READ` 注释** —— `check-server-moat.ts` 机器强制，缺注释直接拒。
10. **两个门槛计数不是可选装饰，且语义不对称** —— 权利金门槛作用于全 Tab ⇒ 有腿真的从 UI 上消失，`removedByPremiumFloor` 是这笔取舍的唯一补偿；流动性门槛只把腿排除出意图 Tab，`excludedFromIntentTabs` 描述的**不是**消失。🚫 MUST NOT 用同一个暗示「滤掉」的容器名把两者混为一谈。（`FR-008`）
11. **特征集 MUST NOT 进 DTO** —— 会被「只加不删」永久锁死。（`FR-019b`）
12. **MUST NOT 下沉 SQL** —— 主 plan P1 行的字面表述已在 D-RECALL-3 显式否决，照做会制造第二份判据实现。
13. **阈值 MUST 单点** —— 且要靠扩展 `check-optionsdesk-rule-constants.ts` 机器强制，`SC-009` 否则只是口号。（D-RECALL-2）
14. **047 既有 IT 红了 MUST 逐条判该不该红** —— 批量改绿是本片最大的风险动作。（D-TEST-2）

## Task 分解

### Phase 1 · 召回层（阻塞其余全部）

- **T001 [Server]** `leg-recall.rules.ts` 新建：DTE 段 + 有效成本 + 两道门槛 + 阈值常量单点 → verify: 纯函数单测红→绿（四个 DTE 端点 / 有效成本恰好相等 / 无 bid / 无 ask 全覆盖）
- **T002 [Server]** `leg-tab.rules.ts` 瘦身：删成员判据，Δ 带常量迁 `leg-mark.rules.ts`；`earningsLegFamilyFor` 一行不改 → verify: `grep` 八个旧符号零命中；typecheck 绿
- **T003 [Server]** 扩展 `check-optionsdesk-rule-constants.ts` 覆盖新阈值（`SC-009`）→ verify: 故意在别处抄一个阈值字面量 → 检查器**必须红**（先证明它会红，再改回）
- **T004 [Server]** use case 接召回 + 两个门槛计数（`SC-001` / `SC-003`）→ verify: IT 断言建仓集内**零条**有效成本 ≥ spot；召回集合**逐条相等**（🚫 不是 `length > 0`）；`removedByPremiumFloor`（移出响应）与 `excludedFromIntentTabs`（仍在响应、只进全腿）**各自**与实际条数相等且互不串台

### Phase 2 · 打标层（依赖 T002 的常量迁移）

- **T005 [Server]** `leg-mark.rules.ts` 推荐标 → verify: 单测覆盖四种 intent × 水位选/未选，**含「未选恒 false」那条**
- **T006 [Server]** 月度链：`thirdFridayOf` + `resolveMonthlyExpiries` + 日历跨 ctx 读 → verify: 单测含假日回退；IT 走真日历表；`check-server-moat` 绿
- **T007 [Server]** use case 接打标（推荐 / 月度链），活跃与财报签名不变（`SC-005`）→ verify: IT 断言打标零拦截（集合不因打标变化）；**收租意图下全表带标的腿其 `|Δ|` 无一例外落当前收租档带**（按建仓带打出的标恒为 0 条 —— 原写「建仓 Tab 推荐标数恒为 0」，2026-08-11 T009 修正，理由见 spec US3-AS2 注）、待定 / 不开新仓时全表恒为 0

### Phase 3 · 精排层

- **T008 [Server]** `leg-rank.rules.ts` 特征集 + 归一化三条边界（`SC-003a`）→ verify: 单测断言 `min===max` 产 `0.5` 且**非 NaN**；全 13 项在三种边界下恒落 `[0,1]`
- **T009 [Server]** 排序器 + 身份键 tie-break + `rankLegs`（`SC-006`）→ verify: 单测断言同输入两次调用逐行相同；`rateDescendingRanker` 函数体 `grep dte` 零命中（`FR-022`）
- **T010 [Server]** use case 接精排，产出三份有序列表 + `tierByTab` → verify: IT 断言顺序 + `tabOrder`↔`tabs` 一致性 + `tierByTab` 非成员恒 `null`

### Phase 4 · 契约与收尾

- **T011 [Contract]** DTO 新增六个字段（`tabOrder` / `gateCounts` / `basisByTab` / `isRecommended` / `isMonthlyChain` / `tierByTab`）+ swagger 装饰器 + `export-openapi` + `api-client` regen（`SC-008`）→ verify: `openapi.json` diff **只含新增、零删除零改名**（`SC-008` 的机械判据）；生成 schema 里 `grep RankingFeatures` 零命中
- **T012 [Server]** 047 既有 IT 逐条过：判「该红 / 不该红」并各自处置 → verify: 每条改动在 commit message 里写明理由，🚫 MUST NOT 批量改绿
- **T013 [Server]** `optionsdesk-050.legs-perf.it.spec.ts`（env-gated，`SC-007`）→ verify: `RUN_PERF_IT=true` 实跑，p50 ≤ 150 / p95 ≤ 300 @ 730 行
- **T014 [Server]** 用 dev 真实链数据**标定两道门槛阈值**，回写 `spec.md` → verify: 标定前后的召回集行数与被滤条数实测入档；`SC-002` / `SC-004` 各找到至少 1 条实证腿
- **T015 [Docs]** 回填主 plan：P1 退出标准打勾、「费率下沉 SQL」移交 P3、契约增量清单同步给 P2 → verify: 主 plan 四片表与不变量段已更新

**依赖**：`T001→T002→T003`；`T002→T005→T006→T007`；`T008→T009→T010`；`T004`/`T007`/`T010` 全落后才 `T011→T012→T013→T014→T015`。
**关键阻塞**：T001/T002 未过 = 召回判据没换 ⇒ 后面全部无意义。

## Out of Scope（本片明确不做）

| 事项                                                                 | 去向                                             |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| 费率下沉 SQL                                                         | **P3**（D-RECALL-3 显式否决在本片做，理由三条）  |
| 每 Tab 独立请求 / 行权价筛选 / 截断 top-N / 双计数 / 预热            | **P4**                                           |
| 年化周化主次显示、推荐标呈现、`tier` 跟 Tab 着色、Tab 语义改「视角」 | **P2**                                           |
| 加权评分 / 流动性 0–100 复合分                                       | **不做**（`FR-026`）。特征层已备好，切换时零改动 |
| `legs[]` 既有排序退役                                                | P2 切到 `tabOrder` 之后由 **P3** 评估            |
| 045 锚派生 / 意图矩阵 / 财报打标算法                                 | **不动**（`FR-029` / `FR-017`）                  |
| `schema.prisma` 改动                                                 | **零** —— 本片全部派生请求时算                   |

## Complexity Tracking

> Constitution Check 无违规，本表为空。
