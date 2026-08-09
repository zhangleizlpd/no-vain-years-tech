---
feature_id: 047-optionsdesk-chain-leg-picker
spec_ref: ./spec.md
status: approved
created_at: '2026-08-04'
updated_at: '2026-08-07'
adr_refs: ['0032', '0040', '0043', '0047', '0048', '0053', '0062']
context7_verified: []
---

# Implementation Plan: 意图 Tab 选约表 + 期权链逐日快照管道（M2b）

## Summary *(mandatory)*

在 046 已 ship 的 P2 详情页下方追加「意图 Tab 选约表」，并落它背后的三个 marketdata 采集维度（链合约发现 / 全链逐日快照 / 财报日历 PIT）与四层数据质量防线。技术路径：shim 新增 4 个期权链 / 财报端点 → server 侧按既有 `SyncDimension` 范式挂三个维度（两个 per-code 走锚闸、财报走市场级固定窗）→ optionsdesk 侧一个只读端点做请求时全量派生 → mobile 侧把详情页的纵向滚动容器换成 `SectionList` 承载虚拟化选约表。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**零新增运行时依赖（守 SC-008）。** 三处曾可能触发新依赖、逐条已排除：

1. **虚拟化列表** → RN 原生 `SectionList`（`react-native@0.81.5` 内置），**不引** `@shopify/flash-list`。
2. **横向滚动 offset 同步** → `react-native-reanimated@~4.1.7`，**已装**（`apps/mobile/package.json:72`）。
3. **正态分位函数 `Φ⁻¹`**（σ 距离 ← `|Δ|`，见 D-UI-3）→ 手写 Acklam 有理逼近纯函数（约 20 行、`O(1)`），**不引** `jstat` / `simple-statistics`。判据：单个初等函数不值得挂一个统计库，且 vendor 已给 `Δ`，`Φ⁻¹` 只用于呈现坐标换算，精度要求在 1e-9 量级远宽于逼近误差。

## Constitution Check *(mandatory gate)*

- [X] **Passed** — plan honors all constitution principles.

逐条：**I** SDD 走满且 mockup-first 已插（`design/` 8 帧 + handoff 在案）；**II** TDD 红绿由 tasks 每条绑测试；**III** 任务粒度 30min–2h；**IV** 扁平 + 贫血 + 护城河，跨 ctx 只读直查 + `CROSS-CONTEXT-READ` 注释（D-ARCH-1）；**V** 跨端单 PR，server impl + IT + `api-client` regen + mobile 消费 + 两层验证同 PR 原子 merge。无违规，Complexity Tracking 空。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [X] **Server**: 三个新维度的采集 use case、完整性核对、选约表读端点各至少一条 Testcontainers 真 boot IT（PG 起真容器）。落库前自洽硬门（FR-043/044）用**已采的 2138 行真实样本回放**跑 SC-010 零误拦，不用合成数据 —— 合成数据造不出「做市商让 bid 跌破内在价值」那 706 行。
- [X] **Mobile / Web**: US2 / US3 / US4 各一条 Playwright hermetic e2e（含 SC-012 滚动条长度 = 逻辑总行数 + 可滚到最后一行）；US1 无 UI，不适用。契约冒烟一条 happy-path 进 `apps/mobile/e2e/contract-smoke/`。
- [X] **Evidence**: 待 impl 期 T0xx 回填 commit 链接。本 gate 在 plan 阶段是**承诺项**，tasks 必须为上述每条各出一个 task；`/speckit-analyze` 按此逐条核。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A — 本片零新增第三方包 / SDK / 工具**（见 § Dependencies）。新增的是**既有 vendor（富途 OpenD via futu-shim）的 4 个新 capability**，不是新依赖；它们落既有 `VendorHttpClient` + `DualWindowRateLimiter` + `VendorConstraintProfile` 范式（ADR-0047），server 侧零新抽象。

**Evidence**: `services/futu-shim/src/futu_shim/ratelimit.py` 已有 `option_chain` / `snapshot` / `expiration_date` 三个 capability 的限频档，本片只加路由不加栈。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** 047 全部前置（045 / 046 / #746 / #752 / futu-shim）均为 mono 原生产物，无 meta-repo Java/Spring 迁移面。

- [X] **Evidence**: `rg -n 'org\.springframework|mbw-[a-z]+/src/main/java|org\.mapstruct' specs/047-optionsdesk-chain-leg-picker/` → 零命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0062（optionsdesk bounded context） | Open Questions 段原文 = 「无」；但 `sunset_trigger` 含「P3 下单 / 持仓联动 → 重审是否与 portfolio 合并」 | `accepted-as-is`，**未命中** | FR-012 明禁许愿单入口；FR-017 的水位手选 chip 是 M3 持仓的**降级代理**而非 portfolio 联动（值不来自 portfolio，也不写回）。**绊线**：M3 持仓数据取代手选值那一刻，回本行 + ADR-0062 重审 |
| ADR-0048（marketdata↔portfolio 跨层方向） | `sunset_trigger` #2 = 「出现必须 server 端**强一致同步读** marketdata 的场景」 | `accepted-as-is`，**未命中** | FR-042 是本片对该 trigger 的**可验证反向守卫** —— 代码中不存在盘中主动拉起行情网关的调用，读的一律是 EOD 快照 + 显式 `asOf`。方向假设保持成立 |
| ADR-0053（跨 ctx 纯函数 import） | `sunset_trigger` #2 = 「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`」 | `accepted-as-is`，**未命中** | 本片派生（周化 / 年化 / 折年 / σ距 / 有效成本 / 档位 / 意图矩阵）**全部**落 `apps/server/src/optionsdesk/*.rules.ts`，不 import `marketdata/*.rules.ts`；spot 直接取快照行里 vendor 给的标的价，不走复权换算。ESLint `boundaries` 已把 `marketdata-rules` 显式列进 optionsdesk 的 `disallow`，是这条的机器绊线（`nx lint server` 变红即触发重审） |
| ADR-0047（marketdata 可插拔数据访问） | Open Questions 三条（理杏仁配额 / 东财 ToS / 实时 `QUOTE_PORT` 选型） | `accepted-as-is`，**不相关** | 三条全落在 cn/hk 基本面与实时报价面，本片是 us 期权链 EOD，数据面零交叉 |

**Evidence**: `rg -n '^## Open Questions' docs/adr/*.md` → 逐个读过 0035 / 0047 / 0050 / 0062；0062 明写「无」。ADR-0032 / 0040 / 0043 无 Open Questions 段。**本片不新开 ADR** —— 三个新维度落既有 marketdata 底座、跨 ctx 读走 ADR-0062 已定的 Q7-B，无跨模块 / 不可逆的新决策。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。**本片 `state_branches` 共 24 条**，逐条对应。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable（偏索引 SSI 假冲突）。并发 insert 确需 Serializable 时 catch **P2002 + P2034 双形态**。scheduler 逐行独立 tx。外部 I/O **split-tx**（禁 tx 内持锁等 HTTP）。→ `../../docs/conventions/server-impl-playbook.md`
- **前端（mobile）**：port 走 **Strangler-Fig**（复用 `~/theme`+`~/ui`、Orval 函数式 hook 非 class）；mutation 必失效对应 list query key；enum→copy 映射用 `Record<Enum, X>` 非 `Partial<Record>`。→ `../../docs/conventions/mobile-impl-playbook.md`

---

## D-SOT — 策略 SoT 真值收口（FR-022 的 plan 期 MUST，已完成）

**SoT 文件 = `~/knowledge-vault/期权实战/3_B流方法论/B流-投资体系.md`（第二章 / 第四章 / 第六章）+ `1_sell-put世界观/sell-put-术语口径.md`。** 该文件在仓外，故本节把**用到的条目逐字落这里**，impl 以本节为准；SoT 演进 → 回改本节 → 改配置，反向不成立。

### D-SOT-1 · 档位边界真值（替换 mockup 示例值）

📌 **mockup 图例里的年化 12/8/4% 与周化 1.5/1.0/0.5% 全数作废**（handoff §「mockup ↔ 实现现实」第 3 条已就地标注为示例）。真值：

| 口径 | 好 | 可接受 | 薄（SoT 称「尴尬区」） | 死档 |
| --- | --- | --- | --- | --- |
| **年化**（收租腿 / 锚轴腿） | ≥ 15% | 10–15% | 5–10% | < 5% |
| **周化**（建仓短腿） | ≥ 2% | 1–2% | 0.6–1% | < 0.6% |

- **分档口径恒为 `bid`**（SoT「流动性 = bid 年化一根轴」），分母恒为**准备金 `K − P`**。`ask` 不参与判档。
- **死线 5%（年化）/ 0.6%（周化）是操作门槛，与利率环境无关** —— 不随 T-bill 收益率浮动。
- 全部六个边界值 MUST 落**一处配置常量**（`apps/server/src/optionsdesk/leg-tier.rules.ts` 顶部具名导出），MUST NOT 散落在判定函数内。呈现侧图例文案从同一常量派生，不手抄。

### D-SOT-2 · 「薄」档动作：保 spec 四态 + 显 `ask` 值（08-04 定夺）

SoT 的尴尬区实为**按 `ask` 二分且随意图分叉**的两态：

| bid 档 | 接货意图 | 收租意图 |
| --- | --- | --- |
| 5–10% 且 `ask` 年化 > 10%（周化：0.6–1% 且 `ask` ≥ 1%） | 挂多个卖一 OCO 碰运气 | 跳过继续等 |
| 5–10% 且 `ask` 年化 ≤ 10%（周化：`ask` < 1%） | 跳过继续等 | 跳过继续等 |

**本片处置**：动作列保持 FR-010 的四态（`挂 OCO` / `暂不挂` / `死档剔除` / `无法判档`），薄档一律「暂不挂」；**但薄档行的费率列 MUST 同屏显出该行的 `ask` 口径值**（形如 `7.2% (ask 11.4%)`），使人能自行套用 SoT 的二分。

判据 = SoT 那一格的输出「挂多个卖一 OCO 碰运气」是**第五章执行层**的挂单方式，而本片 FR-012 明禁挂单入口、FR-011 定死动作标签为建议语义 —— 呈现面承载不了它。⇒ 记入下方 **M3 兑现清单**，不是丢弃。

> 🚨 **这不是「自造参数」的豁免口** —— FR-022 约束的是**档位边界与矩阵规则**，本条一个边界都没改，只是把 SoT 的第五态推迟到有挂单面的那一片。

### D-SOT-3 · 意图判定矩阵：落生成规则，不落九宫格

SoT 第四章明写「本表由公式渲染；改规则先改公式再重渲染，**禁逐格手改**」。⇒ impl MUST 实现**公式**，MUST NOT 把 3×3×3 硬编码成查表。

```text
折扣档数 d：卖put区 = 0 · 买区 = 1 · 深买区 = 2
层级序号 l：L1 = 1 · L2 = 2 · L3 = 3
折扣富余  m = d − (l − 1)

m ≥ 1  → 前 m 个 1/3 水位档 = 建仓腿；其后收租，起步深度 = 贴ATM侧
m ≤ 0  → 无建仓授权；收租起步深度 = |m| 档
收租段内每跨一个 1/3 水位档，Δ 深度加一档（贴ATM侧 → 中度 → 深度，深度为地板）
L3 不走建仓网格（建仓仅腰斩触发，本片不实现腰斩，L3 建仓格恒判为收租）
```

**已逐格验算过公式能复现 SoT 那张表**（L1/L2/L3 × 买区/深买区 六格全中，含 L1 深买区「建仓 <2/3」与 L3 买区「≥2/3 深度地板」）。impl 的单测 MUST 把 SoT 那张表逐格作为期望值断言 —— 公式对不上表即红。

**区间映射**（045 五段 → SoT 四区间，边界系数完全一致：0.6V / 0.8V=W / 1.2V）：

| 045 `AnchorZone` | 价格带 | SoT 区间 | 意图 |
| --- | --- | --- | --- |
| `deep_buy` | spot < 0.6V | 深买区 | 走矩阵（d = 2） |
| `buy` | 0.6V ≤ spot < W | 买区 | 走矩阵（d = 1） |
| `thin` | W ≤ spot < V | 卖put区 | 收租，锚轴 `K ≤ W`（d = 0） |
| `expensive` | V ≤ spot < 1.2V | 卖put区 | 同上 |
| `overvalued` | spot ≥ 1.2V | **不动区** | **不开新仓** |

- **不开新仓 ⟺ `zone === 'overvalued'` 或 L 层 = L4**（SoT「L4 只观察、零动作」）。此时 FR-021 生效：警示注置顶 + 腿数据照常全量展示。
- ⚠️ **mockup 帧 ⑦ 写「L3 · 偏贵区 · 水位 ≥2/3 → 不开新仓」与本表冲突** —— 按 SoT，`expensive`（V..1.2V）仍属卖put区、应出收租意图。**以本表为准**，mockup 那帧记为 drift 不回改（per `sdd-authoring.md`「代码是真相源」）。
- ⚠️ **另记一条 045 遗留、本片不动**：`sell-put-术语口径` §「五区间系数」写的是 `V × 0.6 / 0.8 / 1.2 / 1.6`（多一道 1.6V），045 实装的是 `0.6 / 0.8 / 1.0 / 1.2`。两者在本片用到的三道界（0.6 / 0.8 / 1.2）上完全一致，1.6V 那道界本片零消费。**mention 不改** —— 改它要动 045 已 ship 的区间带与雷达排序，超出本片。

### D-SOT-4 · 腿形态带（Tab 成员判据）

| Tab | 成员判据 | 档位口径 | 排序键 |
| --- | --- | --- | --- |
| 建仓腿·周化 | `\|Δ\| ∈ [0.40, 0.55]` **且** `DTE ≤ 14` 天 | 周化 | 档位（好→可接受→薄→死档）内按周化 `bid` 降序 |
| 收租腿·年化 | 锚轴（卖put区）：`K ≤ W`；市场轴（买 / 深买区）：`\|Δ\|` 落在矩阵输出的 Δ 档内。两轴共用 `DTE ∈ [150, 365]` 天（SoT「5–12 月」的天数化） | 年化 | 档位内按**绝对收益率**降序（SoT「年化达收益门约束下取最大绝对收益」），**非**年化降序 |
| 全腿 | 不筛（除 FR-008 非标 + FR-028a 已到期） | 逐行按其腿族口径 | 统一**档位**键（FR-019），跨族不比数值 |

**Δ 三档**（SoT 第四章）：贴ATM侧 `0.30–0.40Δ` / 中度 `0.15–0.30Δ` / 深度 `0.05–0.15Δ`。

🚫 **未选水位时收租腿 Tab 的 Δ 档取三档并集 `0.05–0.40Δ`**，并在 Tab 内显式注明「水位未选 → 展示全部 Δ 档」。MUST NOT 静默取某一档 —— 那正是 FR-017 否掉的「替人做方向性假设」。

### D-SOT-5 · 活跃度列（Assumptions 留给 plan 的定档）

SoT 第四章原文 = 「整数档优先 + `K ≤ W` 邻域 `OI + Volume` 相对排名取 Top 2-3（**不用**全链 Top-N / OI 中位 / V/OI）」。⇒ 活跃度**不是绝对阈值分档，是当前 Tab 候选集内的相对排名**：

- `整数档`：行权价为整数（做市商深度天然集中）。
- `Top N`：在**当前 Tab 的候选集**内，按 `OI` 与 `Volume` 各自排名之和取前 3。
- 其余留空。

📌 口径注常驻（Assumptions 已定）：`OI` 会 stale（见 D-DATA-4）· `Vol` 更反映当下 · 成交额高 ≠ 真流动。成交额 = `Vol × 权利金 × 100`。

🚨 **本条与 D-API-1 起草时对不上，2026-08-04 定夺如下（实装已按此落地）**：本条说排名是「**当前 Tab 候选集内**的相对排名」，而 D-API-1 说「**Tab 过滤在客户端**」—— 两句合起来无解：端点若只返一套标记，那套必然是「全腿集内的排名」，切到建仓腿 / 收租腿 Tab 后它**语义就错了**（拿 730 行里的排名冒充 40 行里的排名），且**不会有任何东西报错**。

- **定案 = 端点为每条腿返三套标记**（`activityByTab`：全腿 / 建仓腿 / 收租腿各一套；该腿不属某 Tab 时该套为 `null`）。
- **派生仍在 server 单点**：三套都由同一个纯函数按各自候选集算，客户端只按当前 Tab 取用对应那套。
- 🚫 **MUST NOT 让客户端自行重算排名** —— 重算 = 同一判据出现第二份实现，必 drift；而这类 drift 表现为「数字看着都合理、只是排名不对」，是最难被发现的一种。
- **成本**：三套标记 = 每腿多两个小对象，落在 D-API-1 那笔响应体量账里（T038 实测 489 KB，已在 spec frontmatter 登记；该估算当初漏算的正是 tabs 成员 + 三套活跃度标 + 财报标与完整性标）。

### M3 兑现清单（本片显式挂账，不丢）

1. SoT 尴尬区的「挂多个卖一 OCO 碰运气」第五态（D-SOT-2）。
2. FR-017 水位 chip → 真实持仓水位（`w = 该标的占用 ÷ 该层仓位上限`，SoT 第六章）。
3. 腰斩触发的 L3 建仓格（D-SOT-3 公式里已留位，本片恒判收租）。

---

## D-UI — 呈现面

### D-UI-1 · FR-005 手势争用处置（plan 期 MUST，已定）

**根因**：RN 的 `VirtualizedList` 嵌在**同向** `ScrollView` 内会同时坏两件事 —— ① 内层拿到无界高度，虚拟化实际失效（全量渲染 730 行，正是 FR-005 想避免的）② 两个滚动响应者争同一纵向手势。这不是可以调参数绕过去的，是嵌套结构本身的后果。

**处置 = 把详情页的纵向滚动容器本身换成虚拟化列表**，全页只留一个纵向滚动容器：

```text
SectionList（唯一纵向滚动容器）
├── ListHeaderComponent   = 046 三块（锚卡 / 温度计 / 区间时序，组件一行不动）
├── section.header        = Tab 栏 + 水位 chip + asOf 标注 + 表头行   ← sticky
├── section.data          = 腿行（虚拟化的那一层）
└── ListFooterComponent   = 图例 + DTE 两段式提示 + FR-011 常驻页脚
```

- **为什么是 `SectionList` 而不是 `FlatList`**：需要**表头行随滚动钉住**（730 行的表，表头滚走就不可读）。`FlatList` 的 `stickyHeaderIndices` 在虚拟化下索引不可靠；`SectionList` 的 `stickySectionHeadersEnabled` 是 RN 原生支持的 sticky 机制。**Android MUST 显式传 `stickySectionHeadersEnabled={true}`**（该 prop 只在 iOS 默认为 true）。
- **FR-001 不受影响**：`AnchorDetailCard` / `IvReadoutBlock` / `PriceZoneChart` 三个组件**一行不改**，只换父容器（`underlying-detail-screen.tsx:69` 的 `ScrollView` → `SectionList`）。版式不动。
- **横向（首列 sticky + 11 列滑动）**：首列（行权价/到期，88px）渲在横向滚动**之外** ⇒ 天然钉住，不依赖 `position: sticky`。右侧列区在表头行与每个数据行各挂一个 `Animated.ScrollView horizontal`，共享同一个 `useSharedValue` offset，用 `useAnimatedRef` + `scrollTo` 同步。**方向正交 ⇒ 与纵向 `SectionList` 不争手势**（RN 的同向嵌套禁令只约束同向）。
- **成本是常数级**：虚拟化后视口内约 15 行 ⇒ 同步的横向容器数 `O(视口行数)`，**不随 730 行增长**。
- **三个 Tab 共用同一个 `SectionList`**，切 Tab 只换 `section.data`（同一份派生结果的三种过滤 + 排序，见 D-API-1）—— MUST NOT 每个 Tab 各挂一个列表实例。
- **验证**：SC-012（滚动条长度 = 逻辑总行数 · 可滚到最后一行）落 Playwright e2e 断言；真机手感按 SC-012 📌 走一遍**不入 CI 门**。
- **web 侧诚实标注**（`web_compat: untested` 不变）：RN-Web 下首列钉住由 flex 布局而非 `position: sticky` 实现，与 mockup 在浏览器里的行为**不等价**；web 只保证「不裁切」（mockup 探针已验 `clientW == scrollW`），大屏形态仍待 p1 §10-8 定案。

### D-UI-2 · 「不渲染 ≠ 不存在」的三处可验证判据

FR-005 要求逻辑集合 / 滚动条 / 导出口径三者均为全量。实现上：

1. 端点返回**全量腿**，客户端零请求分页（D-API-1）。
2. `SectionList` 的 `section.data` 长度 = 逻辑行数，不做任何 `slice`。
3. 行数计数条（mockup 帧 ③「第 1–9 行 / 共 730」）的分母取 `data.length`，**不取渲染窗口大小** —— 这是 SC-012 的可读判据。

### D-UI-3 · Δ 与 σ 距离是同一个数的两种呈现（handoff 硬约束）

`|Δ| = Φ(−σ距)` ⇒ 两列 MUST 由**同一个** `absDelta` 派生，σ 距列 `σ = −Φ⁻¹(|Δ|)`，**MUST NOT 各算各的**（例如一列取 vendor Δ、另一列拿 spot/K/IV 自己反算 —— 那必然在某些行对不上，而显了真值就藏不住）。

- 实现：`apps/server/src/optionsdesk/leg-derive.rules.ts` 导出 `sigmaDistanceFromAbsDelta(absDelta)`，`Φ⁻¹` 用 Acklam 有理逼近（`O(1)`，绝对误差 < 1.15e-9，定义域 `(0,1)` 开区间）。
- **边界处置**：`|Δ| ∈ {0, 1}` 时 `Φ⁻¹` 发散 ⇒ 该行按「数据不全」处置（FR-007），两列同时留空。greeks 缺失时同理 —— **两列要么同时有值、要么同时为空**，不允许一列有一列无。
- **建仓腿 Tab 的行 MUST 真落在 `[0.40, 0.55]` 带内**（D-SOT-4 的成员判据就是 `|Δ|`）⇒ 带判据与显示值是同一个数，天然自洽。单测 MUST 有一条「随机 1000 个 `|Δ|` 往返 `σ → |Δ|` 误差 < 1e-6」的 property 断言。

### D-UI-4 · 同一到期日的财报标必须一致（handoff 硬约束）

财报日是**标的属性不是合约属性** ⇒ 打标函数签名 MUST 为 `earningsMark(symbol, expiryDate, legFamily)`，**不接受合约级输入**。实现上先按 `expiryDate` 分组算一次，再贴回该组所有行 —— **「同一到期日必同标」是结构保证，不是事后断言**。

- 🚨 **输出值域 = 5 值 + `null`**（FR-023 / FR-026；**2026-08-07 实装期由「四值」订正为五值**）：`covered`「覆盖 ✓」/ `buffer_short`「缓冲不足 +Nd」/ `crosses_earnings`「跨财报 ⚠」/ **`no_cross`「不跨」** / `no_date`「无日期」，外加建仓腿恒 `null`（按设计不打标）。<br>**订正理由**：FR-026 + US4-AS5 + `state_branches` 第 12 条三处都要求「无日期」**必须可与「已确认不跨财报」区分**，而四值里没有「已确认不跨」这个值 —— 只能靠留空表达，留空又同时背着「无日期」与「建仓腿无标」，三义挤一个占位符。四值凑不出这条验收。（mockup handoff 写的本就是「五形态同屏」。）
- **三者的呈现面互不相同，MUST NOT 合并**：`null` → 「—」· `no_cross` → **无 chip 的纯文字**（已知答案）· `no_date` → **虚线 chip**（走数据缺口体系，语气是「我们不知道」）。
- 缓冲只约束「最后利空 → 到期」**一侧**（FR-024），达标线 `EARNINGS_BUFFER_MIN_DAYS = 7` 天，`+Nd` 的 N = **还差几天** = `7 − 缓冲天数`（2026-08-04 user 拍板，落 `earnings-mark.rules.ts` 顶部具名常量）。
- **收租长 / 短腿的分界 `RENT_SHORT_MAX_DTE_DAYS = 28` 天**（同上拍板，落 `leg-tab.rules.ts` 顶部具名常量）：`DTE > 28` 走「覆盖 / 缓冲」域，`DTE ≤ 28` 走「跨财报 ⚠」域。⚠️ 与 D-SOT-4 收租腿 Tab 成员判据的 `DTE ∈ [150, 365]` 是两件事，**MUST NOT 合并** —— 后者决定进不进 Tab，本条决定按哪个财报域打标。
- 死档行照常打标（FR-006）—— 打标发生在分档**之前**，不受档位影响。
- **超 vendor 前向视野（约 6 个月）的到期日 MUST 落「无日期」**，MUST NOT 落「不跨」（FR-034 📌）。判据 = 该到期日 > 财报日历当前覆盖窗右端。

### D-UI-5 · 水位 chip 的持久化位置

FR-017 的三选一手选值按标的持久化 ⇒ 落 **optionsdesk 侧锚表两列**（业务实体归 optionsdesk，FR-054）：一列存档位、一列存设置时刻。`null` = 未选（**是常驻分支不是过渡态**，Edge Cases 已明写）。

- 判据：它是**锚的一个属性**（按标的唯一），不是独立生命周期实体 ⇒ 建独立表是过度设计（Senior Engineer Test）。
- 写端点挂 `POST /v1/optionsdesk/anchors/:id/position-bucket`，与 045 的 `anchors/:id/review` 同形。
- **「人工输入」语义 MUST 在 DTO 层显式表达**（不是靠前端记得），M3 接真实水位时由**同一个字段的来源标**区分，不会分不清哪些是人填的。

---

## D-API — 服务端读面

### D-API-1 · 选约表单端点，返回全量腿，三 Tab 客户端过滤

`GET /v1/optionsdesk/underlyings/:symbol/legs`，一次返回该票**全部适格腿**（已滤非标 FR-008 + 已到期 FR-028a），每腿带 `basis`（周化/年化）· `tier`（四档）· `intent`（建仓/收租）· `earningsMark` · 完整性标记。Tab 切换 = 客户端按 D-SOT-4 的成员判据过滤 + 排序。

🚨 **「Tab 过滤在客户端」有一处例外，MUST NOT 推广**：活跃度标记的判据是**当前 Tab 候选集内的相对排名**（D-SOT-5），客户端过滤后再算就等于把判据实现第二遍。⇒ 端点为每腿返 **三套** 活跃度标记（`activityByTab`），客户端只取用不重算。定案与推导见 **D-SOT-5** 末段。

三条理由：① 三个 Tab 是**同一份派生结果**的三种视图，分三次请求会让三个 Tab 的 `asOf` 与档位口径可能不一致 ② FR-005 禁分页，本来就要一次全量 ③ 少两次往返。

- **响应体量**：730 行 × 约 18 个标量字段 ≈ 150–200 KB JSON（紧凑字段名，不嵌套）。单用户自用后端，可接受。
- **无 Redis 缓存（v1）**：FR-041 要求请求时算，缓存派生结果与之不冲突（缓存易失、物化落库才是禁的），但 v1 **先不加** —— 等 T0xx 实测不达档再加，key 含锚版本 + 快照 `asOf`。理由 = 不为未证实的瓶颈先上一层失效逻辑（Senior Engineer Test）。
- **perf 起手档**（frontmatter ⏳ 待定项）：`p50 ≤ 150ms / p95 ≤ 300ms`（服务端那一段口径，不含 RTT 与渲染）。**不照抄 045 的 40/80 · 50/100** —— 本端点是数百行 × 多列 + 请求时全量派生，与前两片的小 DTO 读端不同类。T0xx **单跑该 spec**（非 `nx affected` 全量并行门下）取暖样本（剔除每进程首请求）校准后**写回 spec frontmatter**。
- 水位写端点沿用 045 档位 `40/80`（单行 UPDATE，同类）。

### D-API-2 · 请求时全量派生（FR-041）

周化 / 年化 / 折年 / σ距 / 有效成本 / W / 四区间 / L 层 / 愿卖锚一律请求时算，零物化列。

- W / 四区间 / L 层 / 单票上限 / 愿卖锚 **复用 045 的 `anchor.rules.ts`，不重写**（依赖表已列为「本片零改动」）。
- 新增派生落 `apps/server/src/optionsdesk/leg-derive.rules.ts` + `leg-tier.rules.ts` + `intent-matrix.rules.ts` 三个纯函数文件（扁平、无 class）。
- 复杂度：单票 `O(n)`，n = 该票当日快照行数（实测上界 730）。分组打标（D-UI-4）额外一次 `O(n)` 分桶。全链路 `O(n)`，无排序外的 `O(n log n)` 以上项。
- **请求时「今天」的基准**（canonical = [`docs/conventions/cross-timezone-date-semantics.md`](../../docs/conventions/cross-timezone-date-semantics.md) §3 + §4）：恒取**交易所的今天** `marketDateFor(['us'], now)`，禁宿主本地日期、禁绝对时刻差；DTE 为整数日历日（含周末与节假日），到期日当天 = 0，年化分母日历日除 365（`leg-derive.rules.ts` 的 `DAYS_PER_YEAR` 已是此口径）。落点 = `marketdata/trading-day-gate.ts` 的 `daysToExpiry`（T006a）而非 optionsdesk：消费方跨两侧（optionsdesk 的 Tab 带判据 + `marketdata/option-anomaly.rules.ts` 的 FR-048 豁免线），而 marketdata MUST NOT 依赖 optionsdesk；该文件非 `*.rules.ts`，optionsdesk 直接 import 不触 D-ARCH-1 围栏。
- 🚨 **一处有意的口径错配**：价格来自**上一场 session** 的收盘快照、DTE 从**当前** ET 日期起算 —— 决策是前瞻的，改成快照日基准会系统性多算一天。**不是 bug，禁「修」**；代价是同屏必须有显式 `asOf`（OI 列走独立的 `oi_as_of`，D-DATA-4）。

### D-API-3 · markets 合规门控

选约区块随期权台 tab 一并受 markets 合规开关门控（FR-015），**路由级 guard，与 045 / 046 同构** —— 不在组件内加第二道判断（两处判断必 drift）。

---

## D-DATA — 采集与存储

### D-DATA-1 · 三个维度的工作集闸（FR-035 / 035a / 035b）

| 维度 | 接口形态 | 工作集 | 零锚时 |
| --- | --- | --- | --- |
| 链合约发现 | per-code | 锚白名单（继承 `need_sync`） | 跑绿，vendor 请求数 = 0 |
| 全链逐日快照 | per-code（批量 ≤400 codes） | 同上，且 hard 依赖链发现 | 同上 |
| 财报日历 | **市场级**（单次 ≤7 天窗返全市场） | **固定前向时间窗序列，不挂锚闸** | **照常跑并落库** |

🚨 **判据是「接口是不是 per-code」，不是「维度归属哪一片」** —— 046 已在指数维度上订正过一次同形状问题（FR-026 → FR-027）。财报挂锚闸零收窄作用，只会复刻「零锚时静默不采」那个坑。SC-006 只套前两个维度，财报走 SC-006a。

### D-DATA-2 · 链发现的贪心分窗（FR-029）

vendor 硬约束 = **单 code、到期日窗 ≤ 30 天**（官方文档「传入的时间跨度上限为 30 天」，2026-08-04 复核）。⇒ 先 `get_option_expiration_date` 取全部可得到期日，再本地贪心分组（相邻到期日只要跨度 ≤30 天就并进同一次调用）。

- **不设到期日上限，含 LEAPS**（FR-032）。成本不随时间线性增长 —— 远端到期日稀疏（只剩月度 / 季度），实测「5–12 月 8 个到期日 = 5 次调用」。
- **窗口边界不得手算**（E38 定论 2 的纪律）：分组用「上一组末到期日 + 30 天」滚动推进，且**每组窗口包含其首尾到期日本身**；跑完 MUST 做「已发现合约的到期日集合 vs `get_option_expiration_date` 返回集合」的 gap check。

### D-DATA-3 · 采集端采全（含 CALL），呈现端只出 PUT

FR-032「采集端默认全开、过滤放分析端」+ FR-043 硬门同时写了 PUT 与 CALL 两侧 ⇒ **采集 `option_type = ALL`**；选约表按 `PUT` 过滤（Assumptions「本片只含认沽」）。

- 判据：CALL 是 M4（wheel / CC / 愿卖锚）的地基，而快照**漏采即永久缺口** —— 现在省下的是几个 snapshot 批次，将来买不回来。
- 成本核对：链接口一次返双边，**调用数不变**；snapshot 批次从约 6 增到约 12（每 400 codes 一批，限频 60/30s）⇒ SC-009 的 15 分钟仍宽裕。已采样本的 2150 codes 本就是双边合计，体量估算无需上调。

### D-DATA-4 · 🚨 OI 的归属交易日与快照的归属交易日**不是同一天**（本片新发现，plan 期定案）

**官方文档原文**（`openapi.futunn.com` get-option-chain 页，2026-08-04 复核）：「Open interest (OI) 数据每日更新，更新时点取决于具体交易所。**美股期权在盘前时段更新**，港股期权在盘后更新。」

两个直接后果：

1. **正常路径本身就有口径偏差**：T 日收盘后采的快照，其 `OI` 字段其实是 **T−1 日**的持仓量（T 日的 OI 要 T+1 盘前才发布）。这不是 bug，是 OCC/OPRA 的固有节奏 —— 但它意味着「收盘快照的每个字段都归属 T 日」这个直觉假设**是错的**。
2. **FR-046 第 ② 级盘前补采拿到的 OI 反而是 T 日的真值** ⇒ 两条路径产出的行，`OI` 的年份不同。

**处置（08-04 定夺）= 让 OI 带自己的归属日，而不是假装它跟着快照走**：

- 快照行除 `session_date`（归属交易日）外，另存 **`oi_as_of`（OI 的归属交易日）** 与 **`quote_as_of`（本行报价的实际采集时刻）**。
- 正常路径：`oi_as_of = 上一交易日`；盘前补采路径：`oi_as_of = session_date`。两条路径都自洽、都可区分，**且顺带解掉了「收盘快照 OI 恒滞后一日」这个此前无人处理的既有偏差**。
- **UI 侧**：`OI` 列的 `asOf` 取 `oi_as_of` 而非区块级 `asOf`（FR-013 要求每处读数带显式时点，这里正是两个时点）。活跃度（D-SOT-5）用到 OI 时同样按此口径注常驻。
- 🚫 **MUST NOT 为「对齐」而把 OI 归到 `session_date`** —— 那是拿标签掩盖真实 vintage，正是本仓反复吃亏的那类静默。

> 📌 **V-A 前置验证据此结清，不再单跑**：V-A 要验的是「盘前重拉能否原样当昨日快照」。官方文档 + E32 合起来已给出答案：bid/ask 与 `update_time` 逐字节相同（E32 实测 2148/2148），但 **OI 会翻新**（官方文档明示）、**greeks / IV 依赖盘前活跃的正股 spot**（E32 自己实测 6/7 只标的有盘前成交、PEP 已 +0.45%，而 E32 **没有**比对 OI 与 greeks）。⇒ 「原样补回」这个用法在 OI 与 greeks 两个字段上**本就不成立**，再跑一次实测只会复述文档已说的话。改为**按已知漂移设计**：② 级补救保留、字段级语义显式化（上述三个时点列 + FR-040 的来源维度）。spec 的 V-A 行与 FR-046 的 🚩 段应在 tasks 期回写为本条 —— ✅ **已于 2026-08-07 T039 回写完成**（V-A 行加 ✅ 标 + 下方整块换成结清块；FR-046 的 🚩 段换成 ✅ 段并写明三个时点列的落法）。

### D-DATA-5 · 幂等键预留来源维度（FR-040）

快照幂等键 = `(合约, 交易日, 来源)`，单源期 `来源` 恒为主源。本片会用到**两个**来源值：`eod`（收盘后正常采集）与 `premarket_backfill`（次日盘前兜底），⇒ 这个维度**本片就已经是活的**，不是纯占位。第二源（嘉信）到位时增加值域，不改主键。

### D-DATA-6 · 完整性核对：逐合约覆盖率（FR-045）

- **分母** = 上一交易日快照里、**到期日 ≥ 当日交易日**的合约集（当日到期的合约当日仍可取快照，官方文档「结束日期请输入今天或未来的日期」）。
- **分子** = 当日实得快照的合约数。逐票汇总，**不看全局总数**。
- **阈值先验起手 = 100%**（配置化）。校准动作落 impl 期观察窗：**至少覆盖一个月度到期日次日**，若发现存在正常态缺行再放阈值，并把成因写回 FR-045。
- 🚫 **MUST NOT 用交易日历打「今天是大到期日所以放宽」的补丁**（循环信任，044 同款）。SC-002 第 ③ 向（回放真实大到期日次日必须不告警）是这条的假阳性守卫，**必须与前两向同时验**。
- **零锚**（`need_sync` 全 false）时：分母为空 ⇒ 判定为「无对象」而非 0%，**不产生告警**（state_branch）。

### D-DATA-7 · 落库前自洽硬门（FR-043 / 044）

`bid ≤ ask`；PUT `Δ ≤ 0` / CALL `Δ ≥ 0`；`|Δ| ≤ 1`；无套利下界 **`ask ≥ 内在价值 − 容差`**。

🚨 **无套利下界用 `ask` 不用 `bid`** —— 实测同一批 2138 行，`ask` 版 0 违规、`bid` 版 **706** 违规（做市商对实值腿的机械占位报价普遍让 bid 跌破内在价值，是市场常态不是脏数据）。这条看着像笔误，**不许在 review 或 impl 时"修正"回 bid**。

- 违规行**逐行拒绝**（不整批回滚）+ ERROR，已落历史数据不受影响。
- SC-010 用已采的 2138 行真实样本回放，误拦必须为 0。

### D-DATA-8 · 兜底 seed 与 FK 处置

- **有锚必有 `Instrument` 行**（FR-028b）：采集侧对已建锚但 `Instrument` 表无对应行的标的做幂等 upsert。**兜底不是主路径** —— `universe` 维度仍是正规通道，seed 只覆盖「新锚建了、universe 还没轮到」的时间差。
- **财报全市场落库遇到 `Instrument` 表外的标的**（新上市 / OTC）→ **跳过并计数**，保 FK 完整；该计数 MUST 作为监控信号呈现（持续升高 = universe 枚举漏了一类标的）。MUST NOT 为规避 FK 而改幂等键。

### D-DATA-9 · 财报 PIT（FR-027 / 034）

**每日重拉整个前向视野**（不是只拉增量窗）—— PIT diff 要发现的是「已公布的日期被改了」，只拉新窗永远看不到旧窗里的改动。按 vendor 窗宽上限分窗，调用数**与锚数量无关**（SC-006a 的可验证判据）。

🚨 **窗宽与窗数于 2026-08-07（T019a）被真 vendor 实测订正：端点差 ≤ 7 → ≤ 6，窗数 26 → 31。**

- **plan 起草时的读法是错的**：vendor 原文「与 `beginDate` 间隔不超过 7 天」指的是**含首尾的 7 天窗**，即**端点差 ≤ 6**；而常量 `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS` 按**端点差**读、于是宽了整一天。
- **实测**（经 77 → 港机隧道打真 shim）：端点差 5 / 6 → **200**；端点差 7 → **502 `NN_ProtoRet_SvrFailed`**；端点差 8 → shim 自己的 400「window too wide」。差 7 在 08-07 / 09-02 / 10-19 三个相隔一个多月的 start 上 **3/3 复现**，不是抖动。
- **为什么它此前没被发现**：`planEarningsWindows` 发出的**每一个**窗都恰好端点差 7 ⇒ 财报采集**窗窗 502**，而 502 映射成瞬时错误会一路重试 / 顺延，**永远不以「参数错」的形状说出来**，只表现为「财报维度一直很慢」。
- **窗数 `Math.ceil(182 / 6) = 31`**。视野 182 天不再被窗宽整除 ⇒ 末窗 MUST **夹紧到视野末端**：越出视野的那几天会落在 `loadExistingRows` 的取数区间外，被每日当成「第一次见」重新 diff，**PIT 三件套失真且不红**。
- 市场级 60/30s 限频下多出的 5 次调用可忽略，SC-009 的墙钟门不受影响。
- 📌 **挂账（知道但本片不改）**：shim 侧同名约束 `EARNINGS_MAX_SPAN_DAYS = 7` 同样偏宽 —— 本该在 shim 就 400、现在会漏到 vendor 变 502。shim 是**已上线服务**（PR #875 已部署港机），收紧要单独 PR + 生产部署。在此之前 **server 侧严于 shim 侧是刻意的**。

变更时记录**变更前日期 + 变更时刻**，并进 WARN 复核名单。

### D-DATA-10 · 业务日期 A′ 与半日市

三个新维度的业务日期 MUST 按 **us 市场时区**求值（继承 #752 的 `marketDateFor`），MUST NOT 沿用全局上海日期 —— 否则日期错位一天且每周固定丢掉周五。采集触发时点按**交易日历**判定而非固定时钟（US 半日市收盘提前）。

---

## D-SHIM — futu-shim 期权链端点（FR-039）

新增 4 条路由，沿 shim 既有纪律（Bearer 鉴权常量时间比对 · 硬限频闸 · 失败语义显式 · 按需拉起空闲自停）：

| 路由 | capability（限频） | 硬约束 |
| --- | --- | --- |
| `GET /option-expirations` | `expiration_date`（60/30s） | 单 code |
| `GET /option-chain` | `option_chain`（**10/30s，官方值**） | 单 code；窗 > 30 天**直接 400 拒绝，绝不截断**（照 `/kline` 超 8 页 400 的先例） |
| `GET /option-snapshot` | `snapshot`（60/30s） | ≤400 codes/批，超出 400 拒绝 |
| `GET /earnings-calendar` | 市场级 | ≤7 天窗，超出 400 拒绝 |

- **限频真值已核实**（SC-009 / Assumptions 的 ⏳ 项结清）：官方 get-option-chain 页原文「每 30 秒内最多请求 10 次获取期权链接口」，2026-08-04 直取 `openapi.futunn.com` 复核（moomoo 镜像本机不可达，未取双镜像）。shim `ratelimit.py` 现有的 `option_chain: (10, 30)` **是官方真值不是保守兜底** —— 与 `history_kline` 那次「漏读官方 60/30s 却挂在 10/30s 兜底」是**不同性质**，本片无需改限频表。SC-009 的 8.4 分钟估算前提成立。
- **`/healthz` MUST 暴露已注册路由集合**，供部署版本闸判断新端点是否真的上线（`/healthz.version == 本次 SHA` 之外再加一层）。
- **拒绝而非排队**（shim 既有设计）：超限返 429 + `Retry-After`，由 server 侧 `budgetExhausted` 延迟重入队且**不耗 attempts**。

---

## D-ARCH — 边界与防线

### D-ARCH-1 · 跨 bounded context（FR-053 / 054 / 055）

- **市场事实**（`option_contract` / `option_daily_snapshot` / `earnings_event`）落 **marketdata**；**业务实体**（水位手选值）落 **optionsdesk**。MUST NOT 把期权链表登记到 optionsdesk 名下。
- optionsdesk 读三张 marketdata 表 → **Q7-B 只读直查 + `// CROSS-CONTEXT-READ: <数据范围 + 只读>` 注释**（注释挂在跨 ctx 查询处，`scripts/checks/check-server-moat.ts` 机器强制）。**MUST NOT** `@Inject()` marketdata 的 use case。
- marketdata 反向只读锚表取工作集 —— 沿用 045 已 ship 的 `anchor-driven-sync-gate.ts`，同样带 `CROSS-CONTEXT-READ`。
- 🚫 **MUST NOT 把 optionsdesk 注册进 marketdata 的维度注册表 / executor 钩子**（底座依赖业务 = 方向错）。
- **MUST NOT import `marketdata/*.rules.ts`**（ADR-0053 绊线，ESLint `boundaries` 已显式 disallow）。spot 直接取快照行里 vendor 给的标的价，不做复权换算。

### D-ARCH-2 · 三道防线的独立性（FR-050 / 051 / 052）

1. **落库前自洽硬门**（D-DATA-7）—— 在写入路径内。
2. **完整性逐票覆盖率**（D-DATA-6）—— 采集后核对，判据挂**数据**不挂 run。
3. **表级健康探针**（`ops/jobs/marketdata-table-health.{sh,sql}`）—— **本片必须同步扩到三个新维度，MUST NOT 等下一片**（M2a 那次漏做、隔日才补，本片不得重犯）。探针 MUST **独立于采集进程**运行（既有反模式：循环信任 / 沉默=健康 / 降级=健康 / 探针与被监控对象同进程）。
4. **采集降级 MUST 留痕 + 告警**，MUST NOT 静默 —— 包括「本日数据来自盘前兜底补采」这个痕（否则「一直靠兜底续命」会被静默掉）。

### D-ARCH-3 · greeks 缺失与 IV 离群的监控口径

- **greeks 缺失只在虚值区告警**（FR-047）。实值区缺失是数学固有现象（bid 跌破内在价值 ⇒ IV 无解，实测 227/2150 行、其中 99.5% 是深实值腿，虚值区零缺失）—— 给固有现象设告警必然长期噪音。
- **IV 离群判定 MUST 结合 DTE**（FR-048）—— 实测 3/2150 的 >500% 全部是 DTE=1 的宽价差，属预期。
- **新的非标 root 出现 → WARN 复核名单**（FR-049，意味着某白名单票发生了并购类公司行为）。

### D-ARCH-4 · FR-052a 磁盘水位告警：定「阈值怎么算」，不拍百分比

spec 明写「🚨 整张估算表待 plan 用实测替换；MUST NOT 拿估算定阈值」。plan 期能做与不能做要分清：

- **能做（落 impl 首个 task）**：重测 prod 77 实际剩余磁盘（p3b §10 记的 6.7 G 是 08-01 数字，可能已 stale）。
- **做不了（物理不可能在 plan 期完成）**：单行宽度必须**落一批真数据后量 `pg_total_relation_size`** —— 本片的表还不存在。
- ⇒ **plan 定的是阈值的计算方式，不是数值**：`告警阈值 = 当前可用空间 − (实测日均增长 × 90 天)`，即**留出不少于 90 天的人工扩容窗口**；日均增长在数据积累满 10 个交易日后由探针自行滚动计算并回写。这满足 FR-052a「按实测年增长速率反推，而非拍一个百分比」。
- 🚫 MUST NOT 用抽稀 / 归档 / 分区压缩替代（不对称性：抽稀不可逆，磁盘可以加）。

### D-ARCH-5 · 合规红线（不是偏好，是禁令）

1. **MUST NOT 抓取 CBOE 免费报价端点** —— ToS 明文禁自动化抓取。本片期权链**唯一**自动化源是富途 OpenD。
2. **MUST NOT 引入任何盘中实时取数路径**（FR-042）—— 可验证判据 = 代码中不存在任何在美股交易时段主动拉起行情网关的调用。SC-007 就按这个判据扫。
3. 落库自用，**零对外暴露、零再分发**。

---

## 三条不要在下游阶段被"优化"掉的决定（承 spec，plan 期原样传递）

1. **采全链、不设行权价带、不设到期日上限**（FR-032）。省下的只是 snapshot 批次数，换来的是「腿静默消失」这一整类无声 bug。
2. **无套利下界用 `ask` 不用 `bid`**（FR-044）。看着像笔误，实测 `bid` 版会当场误拦 706 行正常数据。
3. **完整性告警用逐合约覆盖率，不用行数区间**（FR-045）。采全到期日后合约集天天在变，行数波动本就是正常态；拿它当故障信号必然每月假红一次。

## Complexity Tracking

> Constitution Check 无违规，本表为空。
