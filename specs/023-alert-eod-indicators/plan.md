---
feature_id: 023-alert-eod-indicators
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-07'
updated_at: '2026-06-07'
adr_refs: ['0024', '0032', '0043', '0048', '0051', '0052', '0053']
context7_verified: []
---

# Implementation Plan: 023-alert-eod-indicators（预警 EOD 指标扩展 — 估值/价格扩展/成交量/技术指标四类条件）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `023-alert-eod-indicators` | **设计源**: [p1 子 plan](../../docs/private/plans/2026-06/06-07-alert-indicator-p1-eod-expansion.md) + [master](../../docs/private/plans/2026-06/06-07-alert-indicator-master.md) | **Mockup baseline**: [`design/`](./design/)（`brief.md` + `handoff-claude-design/添加条件改造.html` + `AddCondKit.jsx`，已验收归档）

> 手动模式（不用 orchestrator）→ 本 plan 无 `orchestrator_config` 块（对齐 011-022）。
> **统一 mockup-first 流程**：spec ✅ → clarify ✅（2026-06-07 3Q）→ mockup ✅ → **plan（本）** → tasks → impl。
> **⚠ 头号架构事实**：023 是 021 alert ctx 的**纯增量**（零新 ctx / 零新表 / 零新端点路径）。两个新跨 ctx 面：① **alert → marketdata 纯函数 import**（复用 `adjusted-bars.rules.ts` 前复权换算，boundaries 细分放行 `*.rules.ts`，**ADR-0053 随 PR-2 落地**）② Q7-B 直查面从 2 张表扩到 5 张（+`adjustment_factor` / `fundamental_snapshot` / `trading_day`）。

## Summary _(mandatory)_

023 = 021 条件词表 4 → 26：**① 词表 + 带参条件模型**（`AlertCondition` 加 `param` 列 + `threshold` 转 nullable，校验/唯一约束按 `(type, param)`）→ **② 指标计算层**（alert ctx 内纯函数：MA/MACD/KDJ/RSI/BOLL + 窗口统计，吃前复权序列——none bars + 因子版本经 marketdata `deriveAdjustedBars` 换算）→ **③ 求值引擎扩展**（021 `alert-evaluation.rules.ts` 纯函数 seam 上扩 22 个 metric，估值条件比 `FundamentalSnapshot` + staleness ≤3 交易日 gate）→ **④ mobile 条件库改造**（添加条件页 1 → 4 分类 + 参数 sheet 变体族，mockup 已定稿）。

- **server 段（主体）**：`apps/server/src/alert/` 内新增 `alert-indicator.rules.ts`（指标纯函数）+ `alert-condition-meta.ts`（词表/参数白名单/单位元数据单源）+ 扩展 `alert-validation.rules.ts` / `alert-evaluation.rules.ts` / `evaluate-alerts.usecase.ts`；1 个 migration（加列 + 唯一约束改造）；**8 个端点路径/方法零变化**，仅 DTO 契约扩展。
- **mobile 段**：`apps/mobile/src/alert/` 改造 `add-condition-screen.tsx`（4 分类 rail）+ `value-input-sheet.tsx` 扩为参数 sheet 变体族 + `use-alert-draft.ts` upsert 键 `(type, param)` + `alert-copy.ts` 词表文案/摘要渲染（含参数与估值日）。

**新基础设施 = 0**：零新表（加列）/ 零新 queue / 零新外部依赖 / 零新 token / 零新库（mockup 验收锁定）。

## API Contracts _(mandatory)_

**8 个端点（EP1-EP8）路径 / 方法 / Auth / 限流桶全部沿用 021 不变**（见 [021 plan](../021-alert-management/plan.md) § API Contracts）。本 feature 仅扩展 payload 契约（向后兼容——021 既有 4 类条件的旧 shape 是新 shape 的子集）：

| 契约面 | 021 现状 | 023 扩展 | trace FR |
| --- | --- | --- | --- |
| `conditions[]` item（EP3 req / EP4 req / EP1-EP2 resp） | `{type, threshold}` | `{type, threshold?, param?}`——`threshold` 转 optional（金叉死叉/KDJ 超买超卖/BOLL 无阈值）；`param` int optional（MA 周期/新高低窗口/累计天数/分位年限；无参类型省略） | FR-S01-S04, FR-S07 |
| `type` 词表 | 4 值 | **26 值**（见 § 词表 SoT） | FR-S01-S04 |
| Message `conditions[]` snapshot（EP6 resp） | `{type, threshold, actual}` | `{type, param?, threshold?, actual, dataDate?}`——`actual` 为指标/字段实际值；`dataDate` 仅估值条件携带（所用估值快照日期，FR-S01/Clarify Q3） | FR-S08 |

- **校验扩展（FR-S07，`alert-validation.rules.ts` + DTO）**：type ∈ 26 词表；param 白名单 per type（MA ∈ {5,10,20,60,120,250}、新高低 ∈ {60,120,250}、累计 ∈ {3,5,10}、分位 ∈ {3,5}、无参类型必须省略/0）；threshold 值域 per type（价格 >0、百分比类 ∈ (0,100]、PE/PB/量比 >0、分位 ∈ [0,100]、RSI ∈ (0,100)、无参类型禁带）；重复键从 `type` 改 `(type, param)`；conditions 1..4 与其余 021 规则不变。违规 → 400 ProblemDetail。
- **同步链**：PR-1 swagger 扩展 → `export-openapi` → api-client regen（`threshold` 转 nullable 的 DTO **必须显式 `@ApiProperty({ type: 'string', nullable: true })`**，per memory orval 陷阱——021 `note` 同款）。
- **perf SoT** = spec frontmatter `perf_budgets`（CRUD 150/300 不变；读端点沿用 021 预算）。

## 词表 SoT（26 type，`alert-condition-meta.ts` 单源——server 校验 / 求值 / mobile 文案三处共享 shape）

| 组 | type（param 语义 / threshold 语义） |
| --- | --- |
| 021 既有 ×4 | `PRICE_RISE_TO` `PRICE_FALL_TO` `DAILY_GAIN_OVER` `DAILY_LOSS_OVER`（param=0 / threshold 同旧） |
| 估值直比 ×6 | `PE_ABOVE` `PE_BELOW` `PB_ABOVE` `PB_BELOW` `DIVIDEND_YIELD_ABOVE` `DIVIDEND_YIELD_BELOW`（无 param / threshold=阈值） |
| 估值分位 ×4 | `PE_PCTL_ABOVE` `PE_PCTL_BELOW` `PB_PCTL_ABOVE` `PB_PCTL_BELOW`（param=年限 3\|5 / threshold=百分位） |
| 均线穿越 ×2 | `MA_CROSS_UP` `MA_CROSS_DOWN`（param=N / 无 threshold） |
| 新高新低 ×2 | `NEW_HIGH` `NEW_LOW`（param=N / 无 threshold） |
| 累计涨跌幅 ×2 | `PERIOD_GAIN_OVER` `PERIOD_LOSS_OVER`（param=天数 / threshold=%） |
| 成交量 ×2 | `TURNOVER_RATE_OVER` `VOLUME_RATIO_OVER`（无 param / threshold=% \| 倍） |
| 技术指标 ×8 | `MACD_GOLDEN_CROSS` `MACD_DEATH_CROSS` `KDJ_GOLDEN_CROSS` `KDJ_DEATH_CROSS` `KDJ_OVERBOUGHT` `KDJ_OVERSOLD`（全无参）；`RSI_OVERBOUGHT` `RSI_OVERSOLD`（无 param / threshold=RSI 阈值，默认 70/30）；`BOLL_BREAK_UPPER` `BOLL_BREAK_LOWER`（无参，穿越事件 per Clarify Q2） |

## Constitution Check _(mandatory)_

通过，无违反。

| 原则 | 状态 | 备注 |
| --- | --- | --- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 指标纯函数 vitest 红绿（锚定通达信口径已知序列 + SC-002 行情软件对照样本）；求值/校验扩展走既有 rules spec 扩展；IT 覆盖 spec `state_branches` 全 12 条（含除权假信号回归） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 三段式 PR（见 § Phase 2），tasks 按 30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 零新 ctx；alert 仍叶子；新跨 ctx 面 = 纯函数 import（ADR-0053，boundaries 细分 `marketdata-rules` 元素）+ Q7-B 直查 ×3 新表（探针注释强制）；单向 alert→marketdata 不成环（marketdata 不知道 alert） |
| V. 类型同步链 Nx-driven | ✅ | PR-1 ship 契约扩展 + api-client regen 先 merge；PR-3 mobile 消费 typed client |

## Architecture Notes _(mandatory)_

### D1：指标计算落点 = alert ctx 内纯函数 + 跨 ctx 复用 `deriveAdjustedBars`（**ADR-0053 随 PR-2 落地**）

> **决策路径（catalog 7Q 复评）**：数据获取沿 021 Q7-B 直查先例扩表；**算法落点**三选——(a) alert 内重写前复权换算 = 复制金融关键算法（020 比值口径/跨段 prevClose/防御语义全要重打一遍，drift 风险不可接受）；(b) marketdata 出 indicator 查询服务（DI 注入）= 触发 Q7-C 禁则 or 要新建共享读服务 + marketdata 反向感知「指标」业务概念（底座吃业务语义，方向错）；(c) **alert import marketdata 的 `adjusted-bars.rules.ts` 纯函数**——零运行时耦合（无 DI/无 IO，编译期依赖）、单向 alert→marketdata、算法单源。**取 (c)**。落地 = ESLint boundaries 新细分元素 `marketdata-rules: src/marketdata/*.rules.ts`，仅放行 `alert → marketdata-rules`（adapter/usecase/module import 仍全禁）；ADR-0053 记「跨 ctx 纯函数复用」边界策略（含判据：纯函数 + 无 IO + 算法单源诉求才放行，禁带状态/带 IO 文件混入 `*.rules.ts` 逃逸）。
> **指标计算本身**（MA/MACD/KDJ/RSI/BOLL/窗口统计）= 业务语义在 alert（「金叉」是预警概念非行情概念），落 `apps/server/src/alert/alert-indicator.rules.ts` 纯函数，输入 = 前复权后的 bar 序列（`{tradeDate, open, high, low, close, prevClose, volume, turnoverRate}[]`），输出 = 各指标当日值 + 昨日值（穿越判定用，D6）。

### D2：求值数据流（on-the-fly，零预计算表）

`evaluate-alerts.usecase.ts` 在 021 四步流（load → 去重标的 → 取数 → 纯函数求值 → 触发 tx）上扩第 3 步取数面：

1. 标的集去重后，**按条件需求分层取数**（一条预警只为它实际包含的条件类付查询成本）：
   - 含窗口/指标类条件的标的：`// CROSS-CONTEXT-READ:` 读最近 **520 根** none 口径 `daily_bar`（D5）+ 该标的全部 `adjustment_factor` 版本 → `deriveAdjustedBars(bars, factors, 'forward')` → 喂 `alert-indicator.rules.ts`
   - 含估值类条件的标的：读 `fundamental_snapshot` 最新行 + staleness gate（D4）
   - 含量类/021 既有条件的标的：none bar 现状路径（021 不动；量比多取前 5 根）
2. 求值纯函数签名沿双模 seam（吃快照形数据），新 metric 全部走 `{type, param, threshold}` × 指标值表的查表式比较；warm-up 不足/字段缺失/staleness 超限 → 该条件不命中（021 防御语义，FR-S06）。
3. 触发 tx / 频率后置 / 幂等键 `(alertId, tradeDate)` 全部不动（盘中 p2 接入时该键语义恰好覆盖判重，spec 已确认）。

**容量论证（SC-004 ≤5min）**：自用规模有预警标的 ~几十；窗口查询 520 行 × 每标的 ≈ 单标的 <10ms（`@@unique([instrumentId, tradeDate, adjust])` 索引扫）+ 指标纯函数 O(n) 微秒级 → 全轮秒级，余量 2 个数量级。**不做预计算/缓存**（写放大 5400×指标数×每日 vs 读放大几十×520——读侧便宜得多）。

### D3：schema 演进（migration `yyyymmddhhmm_alert_condition_param`，**无不可逆操作**）

```text
AlertCondition
  threshold Decimal(18,4)  → Decimal? （nullable：无参/无阈值类型）
  + param   Int @default(0)（0=无参 sentinel；MA/窗口=N、累计=天数、分位=年限）
  @@unique([alertId, type]) → @@unique([alertId, type, param])
```

- **sentinel 0 而非 NULL**：PG 唯一约束对 NULL 不去重（NULLS DISTINCT 默认），param NULL 会让「同类型无参重复」失去 DB 双保险——0 sentinel 保住约束完整性，rules 层校验「无参类型 param 必须为 0」。
- **021 存量行零迁移**：旧 4 类条件 `param` 默认 0 即正确语义；`threshold` 转 nullable 对存量无影响。唯一约束从 `(alertId,type)` 放宽到 `(alertId,type,param)` 是纯放宽，无数据冲突可能。
- conditionsSnapshot Json 自然扩展（旧消息缺 `param/dataDate` 字段 → mobile 渲染按 021 文案路径兜底）。

### D4：估值 staleness gate（Clarify Q3 落地）

`fundamental_snapshot` 最新行 `date` 与评估交易日的**交易日距离** ≤3 才求值——距离 = `// CROSS-CONTEXT-READ:` `count(trading_day WHERE market='cn' AND date > snapshot.date AND date <= bar.tradeDate)`（021 D4「不需要日历」的结论仍成立——这里是 023 新需求，仅 count 一条索引查询，不引入 TradingCalendarPort）。超限/无快照行 → 估值条件不命中；命中时 `dataDate` 进 snapshot。

### D5：指标窗口 = 统一 520 根 + 通达信公式口径（SC-002 对照锚）

- **520 根**（≈2 年+）：MA250/NEW_HIGH(250) 需 251；MACD/KDJ/RSI 递推类在 520 根下初始化误差 < 10⁻⁴（EMA 衰减 (25/27)^500 ≈ 0），SC-002 的 1% 容差轻松满足。bars < 需求窗口 → warm-up 不命中（per 条件判，混合预警部分条件可算则照算，spec Edge）。
- **公式口径对齐通达信/同花顺**（国内行情软件事实标准，SC-002 对照基准）：MACD `DIF=EMA(C,12)−EMA(C,26), DEA=EMA(DIF,9)`；KDJ `RSV=(C−LLV(L,9))/(HHV(H,9)−LLV(L,9))×100, K=SMA(RSV,3,1), D=SMA(K,3,1), J=3K−2D`（K/D 初值 50）；RSI `SMA(MAX(C−LC,0),14,1)/SMA(ABS(C−LC),14,1)×100`（Wilder 1/N 递推）；BOLL `MID=MA(C,20), UP/DN=MID±2×STD(C,20)`（样本标准差）。公式常量进 `alert-condition-meta.ts` 注释留痕。

### D6：穿越判定 = 同序列「今日值 + 昨日值」双值，零持久化状态

事件类条件（MA 穿越 / MACD/KDJ 金叉死叉 / BOLL 突破）= 昨日在一侧 ∧ 今日到另一侧——指标纯函数对同一输入序列输出末两日值，比较即得，无需存储昨日评估状态；与「状态类每日触发」（FR-S10）天然区分。

### Mobile side（`apps/mobile/src/alert/` 增量改造，mockup `AddCondKit.jsx` 翻 RN）

- `add-condition-screen.tsx`：左 rail 1 → 4 分类（`CatRail` 翻 RN，选中态沿既有样式）；条件行加副标题（无参语义说明）；「已添加」判定 `(type, param)`；无参条件点添加**直接入草稿**（不弹 sheet）；搜索跨分类命中（FR-M04，按 `alert-copy` 条件名过滤全词表）。
- `value-input-sheet.tsx` → 参数 sheet 变体族（mockup B1-B6e）：按 `alert-condition-meta` 的 kind 分发——纯阈值 / 周期 chips / 窗口 chips / 天数 chips+阈值 / 分位 chips+百分位 / RSI 预填+出域校验。chip 组 = `Pressable` 组 + 既有 token（零新库）。**预填规则**：新建空、编辑预填现值、RSI 默认 70/30（mockup 验收 #4：其余演示 stub 不进 impl）。
- `use-alert-draft.ts`：upsert/重复判定键 `type` → `(type, param)`；condition shape 加 `param?`。
- `alert-copy.ts`：26 词表文案 + 分类分组 + 摘要渲染（「上穿 MA20」「PE 低于 10倍」「RSI 超卖(30)」式，mockup 卡片 C）+ 消息正文渲染扩展（`actual`/`dataDate`，mockup 卡片 D；旧消息缺新字段走 021 路径兜底）。**KDJ 超卖副标题 = `J < 10`**（spec 为准，mockup drift 已记录不回改）。
- `alert-edit-screen.tsx` / `alert-card.tsx`：条件行/摘要显示含参数——纯文案层变化，结构不动。

### Cross-cutting

- **021 零回归（FR-S09 / SC-005）**：021 既有 rules spec / IT 断言全保留不改；新增 IT 跑混合新旧条件同轮评估；mobile 021 既有 e2e 不改。
- **business-naming / moat**：零新表零新 ctx，moat owner 注册面不动；boundaries 改动仅 `marketdata-rules` 细分（PR-2 与 ADR-0053 同 commit）。
- **prod 数据前置（⚠ 唯一外部 gate）**：warm-up 需各标的足够 none bars（MA250 类条件需 251+；520 是统一取数上限非硬门槛）。**T0 任务实测 prod 深度**（psql 抽查 + 水位），不足 → `marketdata-backfill.cli --history-depth` 补档（019 既有能力，跑一次即收敛）；实测/补档不阻塞 PR-1（契约面无数据依赖），仅 gate PR-2 验收。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
| --- | --- | --- | --- |
| **D1** | 指标计算落点 + 前复权复用 | **alert 内指标纯函数 + import marketdata `adjusted-bars.rules.ts`**；boundaries 细分 `marketdata-rules` 仅放行 rules import；ADR-0053 记边界策略 | ⚠️ 请 review |
| **D2** | on-the-fly vs 预计算 | **on-the-fly 窗口查询**（读放大几十×520 ≪ 写放大 5400×每日）；无缓存无新表 | ⚠️ 请 review |
| **D3** | 带参条件持久化 | **`param Int @default(0)` sentinel + `threshold` 转 nullable + unique `(alertId,type,param)`**；26 细粒度 type 词表；021 存量零迁移 | ⚠️ 请 review |
| **D4** | staleness 交易日距离 | Q7-B count `trading_day`（≤3）；不引入 TradingCalendarPort | ✅ 默认接受 |
| **D5** | 指标窗口/公式口径 | 统一 520 根；通达信公式口径（SC-002 对照锚定同花顺） | ✅ 默认接受 |
| **D6** | 穿越判定状态 | 同序列「今日+昨日」双值纯函数内自足，零持久化状态 | ✅ 默认接受 |
| **D7** | snapshot 契约扩展 | `{type, param?, threshold?, actual, dataDate?}` 向后兼容；旧消息 mobile 兜底渲染 | ✅ 默认接受 |
| **D8** | 量比/换手率口径 | none 口径 volume/turnoverRate 直用（股数不复权；送转日 5 日窗失真为 spec 已知局限） | ✅ 默认接受 |
| **D9** | PR-1/PR-2 间隔期行为 | PR-1 先 ship 契约（新条件可建但引擎未扩 → unknown type 不命中不触发，021 防御语义天然覆盖）；自用可接受，PR-1 描述 flag | ✅ 默认接受 |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| — | — | — |

**Note**：(1) 唯一新边界形态 = 跨 ctx 纯函数 import（D1）——比重写/服务化都简单，且 ADR-0053 把判据钉死防滥用。(2) 指标计算是纯算术（无 IO/无状态/无库），复杂度全在公式正确性 → 用通达信口径锚 + 行情软件对照样本测试覆盖。(3) mobile 全部为既有组件的参数化扩展，mockup 验收零新库。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | -------: | -------: |
| EP3/EP4 写（校验扩展） | 150 | 300 |
| 其余端点 | 021 预算不变 | — |

_SoT = spec frontmatter `perf_budgets`。评估引擎非端点：SC-004 单轮 ≤5min——几十标的 × (520 行索引查 + O(n) 纯函数) 秒级，见 D2 容量论证。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**三段式 PR**（021 同构）：

- **PR-1（server 契约面，feat(alert)）**：migration（D3 加列+唯一约束）+ `alert-condition-meta.ts` 词表单源 + `alert-validation.rules.ts` 扩展（26 type × param/threshold 白名单矩阵红绿）+ DTO/swagger 扩展 + CRUD IT（新词表建/改/重复键拒）+ **api-client regen**（cite §V；D9 间隔期 flag）。
- **PR-2（server 指标+引擎，feat(alert)）**：ADR-0053 + boundaries `marketdata-rules` 细分 + `alert-indicator.rules.ts` 纯函数红绿（MA/MACD/KDJ/RSI/BOLL/窗口统计 × 通达信口径已知序列）+ `evaluate-alerts.usecase.ts` 取数分层（520 根窗口 + `deriveAdjustedBars` + staleness gate）+ 求值扩展 + IT（12 state_branches 全条：除权假信号回归 / warm-up 防御 / staleness 边界 / 穿越事件 vs 状态 / 混合 AND / 021 零回归）。**前置 T0：prod 深度实测（不足则 backfill）**。
- **PR-3（mobile，feat(alert)）**：`alert-copy` 词表/摘要/正文渲染 + `use-alert-draft` 键扩展 + `add-condition-screen` 4 分类 + 参数 sheet 变体族 + vitest（draft 键/摘要渲染/参数校验）+ `[Mobile-E2E]` hermetic（建带参预警全流程，mock 端点）+ `[Contract-Smoke]`（登录 → 建「MA20 上穿 + PE 低于」混合预警 → 列表/编辑回显 param → 改 RSI 阈值 → 删除，落 `apps/mobile/e2e/contract-smoke/alert-indicators.contract.ts`）。

> 依赖：021 三段全 ship ✅；020 `adjusted-bars.rules.ts` ✅；019 backfill CLI ✅。无外部前置（prod 深度实测是数据 gate 非代码依赖）。

### 建议 tasks.md 层级（每 task 30min-2h，预估 **~14-16 task**）

- **PR-1 ~5**：`[Server]` migration+meta 词表 → `[Server]` validation rules 扩展红绿 → `[Server]` DTO/swagger+CRUD 接线 → `[Server-IT]` 校验面 state_branches → `[Contract]` export-openapi+regen+`[Verify]`
- **PR-2 ~6**：`[Server]` T0 prod 深度实测（+按需 backfill）→ `[Server]` boundaries+ADR-0053 → `[Server]` indicator rules 红绿（可拆 2：MA/窗口统计 ＋ MACD/KDJ/RSI/BOLL）→ `[Server]` evaluate UC 取数分层+求值扩展 → `[Server-IT]` 引擎全分支+零回归
- **PR-3 ~5**：`[Mobile]` copy/meta+draft 键扩展+vitest → `[Mobile]` add-condition 4 分类 → `[Mobile]` 参数 sheet 变体族 → `[Mobile-E2E]` → `[Contract-Smoke]`

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-07 | **ID-namespace**: US1-3 / FR-S01..S10 / FR-M01..M04 / SC-001..006 | **ADR**: 0053（跨 ctx 纯函数复用边界，随 PR-2 落）/ 0052（alert ctx + 调度自治，沿用）/ 0051（adjust-on-read 比值口径，被复用）/ 0048（Q7-B 先例）/ 0043（扁平贫血纯函数范式）
