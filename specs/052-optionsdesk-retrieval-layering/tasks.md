---
feature_id: 052-optionsdesk-retrieval-layering
spec_ref: ./spec.md
plan_ref: ./plan.md
status: implementing
created_at: '2026-08-12'
updated_at: '2026-08-12'
---

# Tasks: 052-optionsdesk-retrieval-layering（选约检索分层落地 + 三视角逐层判据重梳 — P3）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0064`](../../docs/adr/0064-optionsdesk-retrieval-layering.md)
**Branch**: `052-optionsdesk-retrieval-layering`
**主 plan**: `docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有，片序权威在其 §2）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环。
- 层级：`[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]`。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 召回判据 | `apps/server/src/optionsdesk/leg-recall.rules.ts` |
| 粗排（本片新建，恒等） | `apps/server/src/optionsdesk/leg-coarse.rules.ts` |
| 特征与精排 | `apps/server/src/optionsdesk/leg-rank.rules.ts` |
| 打标（活跃标） | `apps/server/src/optionsdesk/leg-derive.rules.ts` |
| 检索 port（本片新建） | `apps/server/src/optionsdesk/leg-retrieval.port.ts` + `.adapter.ts` |
| 编排 | `apps/server/src/optionsdesk/get-legs.usecase.ts` |
| 契约 | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| Server IT | `apps/server/test/integration/optionsdesk-052.retrieval.it.spec.ts` |
| Mobile | `apps/mobile/src/optionsdesk/` |

🚨 **五层是逻辑分层不是目录分层**（ADR-0043）—— 文件平铺，**MUST NOT** 为五层建子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **持仓量条件漏「或当日有成交」**（`FR-008`）—— 全池实测 1014 条 `OI=0` 的腿里有 **34 条当日正在交易**（新挂档）。写成纯 `OI ≥ 下限` 会砍掉它们，而候选集照样出得来、数字照样有。
2. **拿有效成本代替成色条件**（`FR-005`）—— 有效成本更松：`K` 高于 spot 两档但权利金厚时仍能过。两者不等价，别合并。
3. **精排主键用连续流动性值**（plan `D-RANK-1`）—— 纯 lexicographic 下 `OI 501` 无条件压过 `OI 500`，**费率完全失声**。必须先离散化成档。
4. **活跃标只用相对判据**（`FR-024`）—— 实测某到期日 OI 合计仅 **23**，其 top-1 只有 `OI=4`；只用「同到期日 top N」会给它发标。相对 + 绝对两条都要。
5. **在粗排的恒等函数里塞判据**（plan `D-LAYER-1`）—— 它一旦有逻辑就成了**第二个打分点**，直接违反 ADR-0064 决策 1。
6. **客户端算检索条件默认值**（`FR-011`）—— 默认值依赖 spot（每天变），客户端自算必与服务端漂移，且**两边都算得出数**。
7. **计数对「放宽」也显示**（`FR-029`）—— 放宽不产生排除，显示出来是噪音。判据是「用户值 ≠ 默认值 **且更严**」。
8. **全腿视角用成色条件砍腿**（`FR-006` / `FR-020`）—— 会当场打破 `051` 已 ship 的「切到全腿视角看被排除的腿」入口。全腿靠**排序特征沉底**，不砍。
9. **活跃标同分随机决胜**（`FR-024`）—— 数据没变而两次请求顺序不同，是最难查的那类不稳定。次级判据必须确定。
10. **先筛再排名**（`FR-026`）—— 本片的排名基准是**当前检索条件下的召回集**，顺序是 召回（含用户覆盖）→ 排名。写成「先按默认召回、排名、再按用户值筛」会让活跃标分母恒为默认集，**数字有、全错**。
11. **改 `markActivity` 时把它挪出召回之后**（`FR-026`）—— `get-legs.usecase.ts` 现有注释已警告过一次；本片改的是它的**分组维度**，不是它的位置。
12. **建仓视角顺手「优化」**（`FR-007`）—— 它没坏。`SC-005` 要求候选集的变化**全部且仅**由持仓量条件解释（T004 期订正，见该 task），任何**其他**改动都会红。

---

## Phase 1: 检索 port + 层骨架（阻塞其余全部）🎯

- [X] T001 [Server] **检索 port 接口 + Prisma adapter + 假实现**（`FR-031`, `FR-032`, plan `D-PORT-1`）：新建 `leg-retrieval.port.ts`（入参 = 视角 + 已解析的检索条件 + 候选上限；出参 = 候选集）与 `leg-retrieval.adapter.ts`（`PrismaService` 直查 + `// CROSS-CONTEXT-READ` 注释）；测试用假实现同文件簇。`get-legs.usecase.ts` 改注入 port。→ verify: `leg-retrieval.port.spec.ts`（Small）—— 接口签名内 `rg` 扫 `Prisma|sql|cursor|offset|limit` **零命中**（`FR-031` 的机器判据）+ 假实现可在**不起容器**下驱动召回判据（`SC-009`）+ `nx lint server` 绿 + `check-server-moat.ts` 0 违规

  📌 **impl 期两处落法偏离，均已落地**：① 「零存储侧词汇」这条**源码扫描判据落 `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #5**（带两侧探针），不在 Small spec 里 —— Small 档禁磁盘 I/O，治理扫描归 `scripts/checks/`（同 `045` 把 `anchor.rules.spec.ts` 尾部两个源码扫描 `it()` 迁出去的先例）。判据本身按原样执行，只是换了执行面。② **检索条件与候选上限两个入参本 task 不立**：它们分别是 T010 / T005 的交付物（两条 task 各自明写「port 入参接 K」「解出六个维度」），先立空壳等于占位。本 task 落的入参是 `symbol` + `now` + `perspectives`（视角）。

- [X] T002 [Server] **粗排层恒等入口 + 五层边界断言**（`FR-001`, `FR-004`, plan `D-LAYER-1`）：新建 `leg-coarse.rules.ts` 导出恒等入口（吃候选集吐候选池）；`get-legs.usecase.ts` 串进调用链。→ verify: `leg-coarse.rules.spec.ts`（Small）—— 恒等性断言（入 == 出，含空集）+ **函数体零判据**（`rg` 扫该文件内 `if|filter|sort|>=|<=` 零命中，Guardrail 5 的机器判据）+ 五层各自入口有独立单测文件

  📌 **两条源码扫描判据同 T001 落 `scripts/checks` 不变量 #6**（Small 禁磁盘 I/O）：① 粗排函数体词表扫描，`<` / `>` 单字符**蓄意不入表** —— 泛型 `<T>` 会让判据恒红，收窄成 `>=` / `<=`；② 五层入口各有 colocate spec 的**文件存在**断言，表达层（`optionsdesk.dto.ts`）显式排除并写明理由（本片零改动，归 `053`），让「少一层」是读得出来的决定而非遗漏。恒等性断言取 `toBe`（同一引用）而非 `toEqual`：返回副本也算「有逻辑」，且会让下游对候选池的原地写（活跃度标记）悄悄落到副本上。

---

## Phase 2: 召回层判据（US1 —— 缺陷修复，MVP）

- [X] T003 [Server] **成色条件（收租视角）**（`FR-005`, `FR-006`, `FR-007`, plan `D-RECALL-1`）：`leg-recall.rules.ts` 新增纯函数，上界 = `min{行权价 ≥ spot}` **∧** `spot × (1+X)` 取严，闭区间；**只接进收租视角**。X 先用占位常量，标定在 T016。→ verify: `leg-recall.rules.spec.ts`（Small）—— 高于上界不进 / **恰等于上界进**（闭区间边界）/ 稀疏网格下由比例项接管 / 链上无「≥ spot」的档时退化为仅比例项 / **全腿与建仓视角不受该条件影响**（Guardrail 8）

  📌 **impl 期四处判断**：① **网格口径定为「整条链」而非「同到期日」**（2026-08-12 user 定案）—— spec / plan 两处都只写「链上」，而实测两口径**不等价**：远月网格更疏，按到期日各算会让收租多进 16 条（`us:LULU +6` / `us:PEP +7` / `us:PSKY +2` / `us:CPB +1`，`us:PSKY` 15 个到期日里 9 个的上界会松到 `+6.61%`）。定链级的第二条理由是 plan §标定表写的是「**12 条链**的最近一档距离分布」—— 判据口径与 T016 的标定口径 MUST 同一。② **成色上界在权利金门槛之前、对全量腿求一次**：行权价网格是合约属性，与当日报价无关；在过滤后的集合上求会让那一档若被门槛滤掉时上界**跳到下一档而变松**（有专门一条断言守，反例探针验过会红）。③ **判据落 `intentTabsByTerm` 的 rent 分支**，与建仓的有效成本判据对称 ⇒ 被成色挡下的腿**自动不计进流动性排除数**（它本来就进不了收租），不是另写一处。④ **成色兜底比例入守门脚本不变量 #2**（第 4 个阈值，`RECALL_THRESHOLD_COUNT` 3→4）：它同样是 T016 会调的策略参数，不入表就等于新阈值可被抄到别处而无人拦。📌 持仓量下限（T004）与候选上限 K（T005）是**整数**，走不了子串扫描（脚本自身那条「整数当子串扫会把行号扫成违规」的限制），故不入表。

  🔬 **非平凡绿实证**（两次反例探针，均实跑）：把 `passesQualityCeiling` 改成恒 `true` ⇒ 5 条红；把网格来源换成「过完权利金门槛的那批」⇒ **精确 1 条红**（正是守 ② 的那条）。既有 4003 用例零回归的原因也已核实：`get-legs.usecase.spec.ts` 种子 spot `132.40`，链上唯一 `≥ spot` 的档是 `K=145` 且其 DTE=9 本就不在收租段 ⇒ 上界退化为比例项 `137.696`，其余腿全在其下。

- [X] T004 [Server] **持仓量条件（三视角一律）**（`FR-008`, `FR-009`, plan `D-RECALL-1`）：`leg-recall.rules.ts` 新增 `OI ≥ 下限` **或** 当日有成交。下限先用占位常量，标定在 T016。→ verify: 同文件 Small —— `OI=0` 且无成交**不进** / **`OI=0` 但有成交进**（免死条款，Guardrail 1）/ 三视角行为一致 / 成交为 null 与成交为 0 区分对待 / 🚫 **权利金条件的两个常量逐字未变**（代码内仍名 `PREMIUM_FLOOR`，本片只是把它归类为可调检索条件）（`FR-009` 的否定式断言 —— `git diff` 该常量零命中；起草期曾怀疑它误伤，逐段核后被数据否定）

  🚨 **impl 期抓到一条 `/speckit-analyze` 漏掉的 spec 内部冲突，已由 user 裁定并回写 spec**：`FR-008`「三视角一律」与 `SC-005`「建仓候选集本片前后逐条相同」**直接互斥**，实测撞面 **87/236 条**建仓候选（`OI=0` 且当日零成交）。裁定 = **保留一律，`SC-005` 改差集断言**（「变化全部且仅由持仓量条件解释」）。逐条核过那 87 条**不是好货误伤**：全是深度实值腿，平均 bid `12.73`（留下那批仅 `6.50`）、相对价差 `0.194` 反而更窄，能过有效成本判据只因权利金几乎全是内在价值（`us:LULU K=129 bid=3.75` ⇒ 接货成本比 spot 便宜 **0.3%**），而 `OI=0` 且今日零成交 = 挂出去无人应答。📌 **T015 的 `SC-005` 断言据此改写**：验「旧候选集 ∩ 过持仓量条件的腿 = 新候选集」，不是逐条相同。

  📌 **另三处判断**：① **判据 MUST 排在权利金门槛之后**（有专门断言 + 反例探针守）—— 提前会让「两道都不过」的腿不再计进 `removedByPremiumFloor`，而那是 `051` 已 ship 的展示值，它会静默变小。② **蓄意不产第四个计数**：持仓量下限是 T010 六个检索条件之一，可见性走「控件默认值 + 仅收窄态出计数」（spec Clarifications「门槛可发现」）。③ **下限是整数 ⇒ 进不了守门脚本的阈值单点扫描**（子串扫整数会把行号扫成违规，脚本自身写明），单点性靠 review 守，常量注释已写明「没有机器兜底」。

  🔬 **非平凡绿实证**：抽掉判据 ⇒ 5 条红；把它提到权利金门槛之前 ⇒ **精确 1 条红**（正是守 ① 的那条）。另实测 OI 字段全表**零 NULL** ⇒ `null` 分支在当前数据上不触发，但仍按「未采到 ≠ 零」实现并单测（vendor 换源时它就是活的）。

- [X] T005 [Server] **召回层候选上限 K + 触及可观测**（`FR-027`, `FR-028`, plan `D-K-1`）：port 入参接 K；触及时产出可被 SQL / 响应读到的状态，**MUST NOT 只落 log**。K 先用占位常量，标定在 T016。→ verify: Small + IT —— 候选数 < K 不截 / = K 不截 / > K 截到 K 且状态可读 / **K 与表达层的 N 是两个独立参数**（`rg` 扫二者未共用常量）

  📌 **impl 期四处判断**：① **触及状态取「切掉多少条」这一个数**（`droppedByCandidateCap`，一路上浮到 `LegTableView.candidateCapDropped`）—— 蓄意**不配 `reached: boolean`**，它可由 `> 0` 派生，多存一份就多一处会 drift 的真相。② **它不进 `gateCounts`**：那三个数是「判据挡下了什么」，这一个是「保险丝熔断了」，两者处置不同（前者调条件、后者调 K）。③ **切之前必须先定序**：输入顺序来自存储实现的无序批量读，直接 `slice` 会让同一份数据两次请求给出不同的前 K 条 —— 键取 `(DTE, 行权价)` 是**日历顺序不是打分**（ADR-0064 决策 1 禁第二个打分点），且只在触及那一刻生效。④ **上限在三个门槛计数之后施加**：被切的腿早已过门槛，切它不该让「被挡下多少条」跟着变。

  📌 **K 与 N 独立的验收形态**：本片尚无表达层 N（归 `053`），`rg` 扫不出「共用」这件事。落法改为 ① `RECALL_CANDIDATE_CAP` 的量级断言（`> 758` = dev 当前最大链全量，Small spec 一条）+ ② 常量 JSDoc 写明「共用会让『调给用户看几条』顺手改掉召回容量」。`053` 引入 N 时该断言即变成真正的对照。

  📌 **`candidateCap` 走 port 入参而非实现里读常量** —— 这条不只是洁癖：真值取三千量级，造那么多腿只为验一条分支不划算；入参化让 IT 用 `candidateCap: 2` 直接驱动截断路径，而「真常量下不截」由另一条断言守。

  🔬 **非平凡绿实证**：禁掉截断（`|| true` 短路）⇒ **5 条红**（3 条 Small + 2 条 IT）。新建 `optionsdesk-052.retrieval.it.spec.ts`（T015 在此收口），当前 4 条：真库路径 ≤K 不截 / >K 截到 K 且 dropped 可读 / 两次请求成员逐条相同 / 状态上浮到 use case 视图。⚠️ **既有 warning 未动**：`get-legs.usecase.ts:540` 的 `pool.map` arrow complexity 18 是 050 起就有的，本 task 未触及（mention 不改，per Surgical Edits）。

---

## Phase 3: 特征加工 + 精排（US2 —— 排序按可成交性）

- [X] T006 [Server] **特征注册表编译期强制 + 成色特征**（`FR-025`, plan `D-FEAT-1`）：`leg-rank.rules.ts` 的特征集类型改为按键穷举的映射；新增成色特征（供全腿排序用）。→ verify: `leg-rank.rules.spec.ts`（Small）—— 归一化到 `[0,1]` + 全等 / 缺失 / 单条候选三种边界 + 🚨 **先证明它会红**：临时加一个特征键但不实现 ⇒ `nx typecheck server` 变红，删回后归绿（这是 ADR-0064 不变量 ③ 从纪律变机器拦的实证）

  📌 **「编译期强制」这一半在 `050` 就已成立，本 task 是确认 + 留证而非改造**：实跑探针（往 `CONTINUOUS_FEATURE_KEYS` 加 `probeUnimplemented` 不实现）⇒ `TS2741: Property 'probeUnimplemented' is missing in type ... but required in type 'Readonly<Record<..., ContinuousExtractor>>'`，删回后全量归绿。`FR-025` / ADR-0064 不变量 ③ 要的机器拦，`Record<Key, …>` 的穷举映射已经给了 —— 🚫 **不为「本片要有改动」而重写它**（Surgical Edits）。

  📌 **成色特征落 `strikeDiscount = (spot − K) / spot`，派生在 use case 而非特征层**：行权价是**身份键**（`LegIdentity`），进 `RankingLegInput` 就等于允许特征层按身份算特征 —— 那正是 050 用「入参里没有 `absDelta`」立下的同一条结构保证。⇒ 与 `rate` 同构（use case 派生裸值、特征层只归一化）。
  📌 **它与 `effectiveCostDiscount` 是两项、不可互相代替**（Guardrail 2 的连续版，有专门一条断言）：后者含 `bid`，权利金厚的深度实值腿有效成本折价能拿满分 `1`，而成色同时是最差的 `0`。

- [X] T007 [Server] **精排换 lexicographic（分层 + 降级）**（`FR-017`, `FR-018`, `FR-019`, `FR-021`, `FR-022`, plan `D-RANK-1`）：ranker 改为「流动性档（离散）→ 档内折算费率降序 → 费率打平带内长期优先」；候选数 < 阈值时不分档。档界 / 带宽 / 阈值先用占位常量，标定在 T016。→ verify: 同文件 Small —— 厚腿排在薄腿前 / 档内按费率降序 / 打平带内长者优先 / **降级边界取严格小于** / 🚨 **ranker 函数体内 `rg` 扫不到腿的原始字段名**（`FR-022` 的机器判据）

  🚨 **分档口径由数据裁定为「持仓量 + 成交」而非价差**（2026-08-12 user 定案）：plan `D-RANK-1` 的档界注释只提「相对与绝对价差两个口径都要评」，但实测 325 条意图候选显示两者**不是在说同一件事** —— 按 OI 四分位分组时相对价差几乎不动（`0.239 → 0.191`），反过来按价差分组时 OI 中位数**非单调**（`316 → 249 → 90 → 185`）；而 OI 档能把「年化 **80.6%** 而 OI 中位仅 **3**」的公式退化组单独分出来，价差档做不到。这与 spec Assumptions「流动性的有效信号偏向持仓与成交，而非价差窄不窄」一致。📌 **T016 仍按 plan 评两个价差口径，但作为对照而非主键**。

  📌 **impl 期三处判断**：① **档做成「固定取值量」特征而非连续特征** —— min-max 会把「候选集恰好全在同一档」拉伸成 `0..1`，绝对档界的语义当场消失，而排出来的顺序照样有；⇒ 既有的 `ORDINAL_FEATURE_KEYS` 语义从「布尔量」扩为「固定取值量」（布尔是其二值特例），extractor 返回值类型 `boolean → number`。② **打平带宽作用在归一化费率上**（相对口径）：ranker 的输入面只有特征集，绝对口径要为同一个量在特征表里放两份（一份连续、一份按绝对带宽离散），撞 `FR-025` 的精神；代价是候选集里出现极端高费率腿时带宽的绝对含义变大 ⇒ **已写进常量注释，T016 标定时 MUST 验一次「带内腿数占比」**。③ **降级后返回的是 `rateDescendingRanker` 本体**（有断言 `toBe`），不是另写一份同义实现。

  📌 **一处 050 禁令的精确化，非推翻**：050 `FR-022` 写「`dteDays` 在特征集里但 MUST NOT 进 ranker」，而 052 `FR-018` 要求打平带内长期优先。裁法 = 那条禁令盯的是「DTE 当排序主键 / 离理想 DTE 越近越靠前」，本片 DTE 只在**费率已经打平**时决胜 ⇒ 收益仍主导。`rateDescendingRanker` 那侧的机械判据（函数体 `grep -i dte` 零命中）**一字不改**，两处注释均已交叉写明。

  📌 **`FR-022` 的机械判据落 `Function.toString()` 而非磁盘扫描**：沿 050 已有的同款手法（`rateDescendingRanker.toString()` 扫 `dte`），Small 档不碰磁盘。词表取 `bid`/`ask`/`.code`/`expirydate`/`greeks`；🚨 **`strike` 蓄意不入表** —— `strikeDiscount` 是 `FR-020` 的合法特征，入表会让判据恒红。📌 类型层其实已保证 ranker 只吃特征集（`LegRanker` 签名），这条扫描防的是**闭包捕获**外部腿数据 —— 那绕得过类型。

  🔬 **非平凡绿实证**：抽掉档主键 ⇒ 2 条红（厚腿在前 / 降级边界）；把降级边界从 `<` 放宽成 `<=` ⇒ **3 条红**。全量 411 文件 / 4035 用例绿。⚠️ 期间一轮全量出现 `chat-preference.it.spec.ts` **13 条全红**（`ioredis AggregateError`，每条卡满 42s 超时），同一份代码重跑即全绿 ⇒ **Redis 容器启动竞争的环境抖动**，非本片改动（`local-verification.md` §3「红得像代码坏了、其实是环境」那一档）。

- [X] T008 [Server] **全腿视角成色沉底（不砍腿）**（`FR-006`, `FR-020`, plan `D-RANK-1`）：全腿保持费率降序，成色特征参与使深度实值排末段。→ verify: IT —— 深度实值腿**仍在候选集内**（`SC-006` 的一半）+ 排在末段 + 🚨 **被意图视角任一条件排除的腿 100% 可在全腿视角找到**（`SC-006` 全量，`051` 入口的回归防线）

  🚨 **impl 期发现一个盲写必踩的坑：归一化把符号信息弄丢了**。T006 的成色特征 `strikeDiscount` 是连续量，走 min-max ⇒ 候选集里最实值的那条恒取 `0`、最虚值的恒取 `1`，而「`0` 是深度实值还是只是本批里最不虚」**在 ranker 里无从分辨**。⇒ 沉底键必须是**固定取值量** `isInTheMoney`（判据取折价的符号，在归一化**之前**），不能拿归一化后的成色去判。这条踩了不会红：排出来的顺序照样有，只是虚值链里最不虚的那条被当实值沉了底。有专门一条断言守（候选集全是实值时三条逐条判 `1`，而连续项照常拉开成 `0 / … / 1`）。

  📌 **两项并存不是冗余**：`isInTheMoney` 回答「要不要沉底」（离散、跨候选集可比），`strikeDiscount` 回答「没沉底的那批里成色排多少」（连续、候选集内相对）。
  📌 **全腿 ranker 一字不提 DTE**：050 `FR-022` 对它完全有效（`layeredRanker` 的打平带例外只在意图视角成立）—— 全腿混着 10 天与 200 天的腿，期限先验在这里尤其危险。有 `toString()` 断言守。
  📌 **缺失不沉底**：`spot` 脏数据导致折价算不出时判 `false` —— 沉底是**惩罚**，拿不准时 MUST NOT 施加。
  📌 **清掉一处本次改动产生的 orphan**：`get-legs.usecase.ts` 不再直接引用 `rateDescendingRanker`（它仍是 `layeredRanker` 降级路径的返回值），import 已删。

  🔬 **非平凡绿实证**：抽掉沉底键 ⇒ **3 条红**（2 条 Small + 1 条 IT）。IT 新增 2 条：`SC-006` 全量（三条腿各被一个意图条件排除 —— 成色 / 流动性 / 期限段 —— 全腿视角逐条可达）+ 沉底（`P-ITM` 年化**高于**对照腿却仍排末位，证明不是「按费率排恰好排到末尾」）。

  ✅ **最有说服力的证据来自既有单测的回归**：`get-legs.usecase.spec.ts` 的种子里恰好有一条 `C-C`（`K=145` > spot `132.40`，年化 **211%**）——本片之前它是 `tabOrder.all` 的**首位**，T008 之后掉到**末位**（`['C-C','C-D','C-A','C-B']` → `['C-D','C-A','C-B','C-C']`），其余三条逐条保持费率降序、**一条没少**。这正是「收租被公式退化产物占满」这个缺陷在全腿视角的同一副面孔。两条既有断言据此更新（不是放宽 —— 更新后若沉底键失效会立刻回红）。

  ⚠️ **守门抓到一处我自己写的违规**：T007/T008 断言里用了 `rate: 0.8`，撞 `anchor.rules.ts` 的 `W_COEFFICIENT`（不变量 #1 的扫描面**不排除 spec**，脚本文件头写明这是蓄意的不对称）。改用 `0.7` —— 🚫 不能改成 `0.85`：子串扫描下它仍含 `0.8`。

---

## Phase 4: 活跃标（US4）

- [X] T009 [P] [Server] **活跃标改同到期日分组 + 绝对量下限**（`FR-023`, `FR-024`, plan `D-MARK-1`）：`leg-derive.rules.ts` 的 `markActivity` 分组维度由候选集改为到期日，发标需同时满足「组内 top N」与「绝对量过线」。下限先用占位常量，标定在 T016。→ verify: `leg-derive.rules.spec.ts`（Small）—— 标分布覆盖多个到期日 / **整体量低的到期日即使有组内第一也不发标**（Guardrail 4）/ 某到期日无候选不产生空分组不除零 / **同分决胜稳定**（同一输入两次调用结果逐字相同，Guardrail 9）

  🚨 **绝对线的量取「活动量」= `OI + 当日成交`，与 T007 的流动性档界同一个量**。⇒ 定义**下沉到 `leg-derive.rules.ts` 的 `activityVolume()` 单点**，`leg-rank.rules.ts` 的档界函数改为引用它。两处各写一份 `(oi ?? 0) + (vol ?? 0)` 的话，T016 只标定一处就静默 drift —— 而**两边照样都算得出数**。起手值取 `100`（= `LIQUIDITY_TIER_BOUNDS` 第二档界，dev 意图候选 325 条活动量的 `p40 = 108`），语义是「够不着第二档的腿不配发活跃标」。

  🚨 **分组键 MUST 是已归一到「日」的键**（入参 `expiryKey: string`，调用方走 `get-legs.usecase.ts` 既有的 `dateOnlyOf`，与月度链标 / 财报标三处同源）。传 `Date` 对象或 `toISOString()` 全串 ⇒ 同一到期日按时分秒裂成多组、**每组只剩一条腿 ⇒ 条条都是「组内第一」**，标满天飞而函数照常返回，不会红。

  🚨 **绝对线只否决、不递补**：`FR-024` 字面是「进前 N **且**过线」⇒ 前 N 在**全组**内定死，组内第 3 被挡下时第 4 名即使过线也不顶上。反过来写（先滤过线的再取前 N）会把「排名」的分母悄悄换成「过线的那批」—— 名次照样排得出，只是换了口径。有专门一条断言守（构造组内第 3 活动量 `95` < 线、第 4 名 `110` 过线）。

  ⚠️ **一条既有 usecase 断言的判别性来源被本 task 换掉了，不是放宽**：`get-legs.usecase.spec.ts` 的「全链最不活跃的两条腿在建仓 Tab 里仍是 Top」原先靠「同两条腿在全腿 Tab 排不进前三」制造跨 Tab 的可观测差；到期日分组后，该差只在**同一到期日的成员数跨 Tab 不同**时可见，而这份种子的两个到期日与两个意图 Tab 恰好一一对应 ⇒ 差消失。⇒ Guardrail 3 改由同 `it()` 内「每个 Tab 拿到名次的行数 == 该 Tab 成员数」守（把 `markActivity` 挪到筛选之后，被筛掉的腿会 `tabs` 含该 Tab 而 `activityByTab` 为 `null`，立刻红）；「换候选集换归属」那条 047 语义在 `leg-derive.rules.spec.ts` 有专门断言，不在 usecase 层重复。另**新增**一条直接守 `FR-023` 接线的：全腿 Tab 的标条数 > `ACTIVITY_TOP_RANK_COUNT` 且含两条建仓腿。

  📌 **既有单测的量被抬过绝对线**（`5/5` → `505/505` 一类）：047 那批断言测的是「相对排名不是绝对分档」，量级本身不是它们的判据；线下的腿一个标都不发，留着低量会让这批断言对「排名」失去分辨力。抬量后 27 条既有断言**逐条仍绿**。

  🔬 **反例探针 3 次**：抽掉到期日分组（全集一组）⇒ **3 红**（含 usecase 层 1 条）/ 绝对线改成「先滤后取前 N」⇒ **1 红** / 抽掉绝对线 ⇒ **4 红**。

  ✅ verify: `nx test server` **411 文件 / 4052 用例绿**（本批 +8）· `nx lint server` 绿 · `check-server-moat` 0 违规 · `check-test-size` 七条不变量过 · `check-optionsdesk-rule-constants` 零命中。

---

## Phase 5: 检索条件的默认值与覆盖（US3）

- [X] T010 [Server] **系统默认值计算下发 + 用户覆盖 + 三态计数**（`FR-002`, `FR-003`, `FR-011`–`FR-016`, `FR-026`, `FR-029`, `FR-030`, plan `D-CRIT-1`）：`get-legs.usecase.ts` 解出**六个维度**在每个视角下的系统默认值并下发；请求带条件时以请求值召回；

  🚨 **六个维度不是泛指，逐条列明其默认值来源**（这决定本 task 的范围与验收）：

  | # | 维度 | 默认值来源 | 全腿 | 建仓 | 收租 |
  | --- | --- | --- | --- | --- | --- |
  | 1 | 行权价上界 | **依赖 spot + 链上行权价网格** | 不限 | 不限 | `min{K ≥ spot}` ∧ `spot×(1+X)` |
  | 2 | 行权价下界 | 常量 | 不限 | 不限 | 不限 |
  | 3 | DTE 段 | 常量，**三视角不同** | 不限 | `[1,49]` | `[30,365]` |
  | 4 | 权利金下限 | **依赖 spot**（`050` 标定值，`FR-009` 不改） | 同 | 同 | 同 |
  | 5 | 持仓量下限 | 常量（T016 标定） | 同 | 同 | 同 |
  | 6 | 相对价差上界 | 常量，**全腿不设** | — | 有 | 有 |

  ⏳ 第 7 项「单笔权利金下限」**是否设**由 T016 标定裁定；在它裁定前本 task **不实现该维度**。

  每维度产出三态（未覆盖 / 覆盖且放宽 / 覆盖且收窄），**仅收窄态出计数**。→ verify: IT —— 无请求条件时按默认值召回 / 带条件时按请求值 / 🚨 **排名基准 = 当前条件下的召回集**（放宽条件后活跃标重算，Guardrail 10）/ 放宽维度**不出**计数（Guardrail 7）/ 水位变化时召回成员集逐条不变（`FR-016`）/ 🚫 **全仓只有一个 filter 概念**（`FR-003` 的机器判据 —— `rg` 扫服务端与客户端均**不存在**「排名之后再筛一次」的第二条路径）

  🚨 **一处 spec 与 plan 都没定、由 user 于 2026-08-13 裁定的歧义：覆盖作用到哪几个视角**。一次请求返三视角（`047 FR-005`）而 `FR-015` 要每视角各自持有条件状态，两条叠起来有三种自洽读法。**裁定：只作用当前视角**（请求带 `perspective` + 一套条件，另两个视角走各自默认值）。🚫 通吃三视角的读法被否是因为：用户在收租设的行权价上界会同时收窄建仓，而建仓控件仍显示自己的默认值 —— 控件与数据不匹配，且这个不匹配在界面上**无法解释**。⇒ 与 `053`「拆成每视角独立请求」平滑衔接。

  🚨 **三态的判据是「是否产生排除」，不是值比较**（plan `D-CRIT-1` 只写了「更严」，没给可操作定义）。值比较对 **DTE 段**这种双端维度给不出唯一答案（下界放宽 + 上界收窄同时发生 —— 实测既有种子上就是这个形状：收租段 `[30,365]` → `[1,50]` 踢掉 DTE 164 两条、放进 DTE 10 一条）。而计数本来就要逐腿判一遍 ⇒ **判据与计数同源派生**，才不会出现「显示了计数但态是放宽」。📌 `widened` 因此含「方向是收窄但一条腿都没排除掉」——处置与放宽相同（不出计数），为一个不影响行为的区分多养一个状态只会多一处 drift。

  🚨 **计数取边际口径**：「把这一维换回系统默认值、其余维保持用户值，能多看到几条」。两条推论各有断言守：① 被**两个**维度同时挡下的腿，**两维都不计它**（放宽任一条它都进不来）；② **硬门槛**（建仓有效成本）挡下的腿不计进任何维度。

  🚨 **判据搬家：`recallTabs` / `intentTabsExcludedByLiquidity` / `intentTabsByTerm` 三个入口退役**，判据全部并入 `failedCriteria`（返回**不过的维度集合**而非布尔 —— 布尔答不了「是不是只差这一条」）。留着它们就是第二份成员判据，正是 `FR-003` 要消灭的东西（也是 051 退役 `isExcludedFromIntentTabsByLiquidity` 的同一条理由）。⇒ 编译期立刻点名 8 处调用点，**这是本 task 的第一道红**。判据参数化连带改名：`passesPremiumFloor` → `resolvePremiumFloor`（解默认值）+ `passesPremiumMin`（吃任意下限）· `passesOpenInterestGate` → `passesOpenInterestMin` · `passesLiquidityGate` → `passesRelativeSpreadMax`。

  📌 **051 的三个 `gateCounts` 零破坏**，语义由等价形式重述：「整条移出」= 在**每个请求视角**下都不过权利金条件（三视角默认值相同 ⇒ 未覆盖时逐字等价；用户在某视角放宽后那条腿进得去 ⇒ 它不再是整条移出，那个数也就不该再数它，有断言守）；两个流动性数 = 「硬门槛过、且**只**被价差这一维挡下」——与新的边际口径天然是同一个式子。

  ⚠️ **一条既有断言的语义随之变了（不是放宽）**：`无 bid ⇒ tabsOf === []` 而非 `['all']`。051 下无 bid 的腿同样看不见（权利金门槛在更外层「整条移出」，压根走不到 `recallTabs`）——**变的是判定住在哪儿，不是结果**。

  🚨 **`FR-003` 的机器判据落 `check-optionsdesk-rule-constants.ts` 不变量 #7**（读源码 ⇒ Small 档禁磁盘 I/O，同 #5/#6 的处置）：六维判据 + 硬门槛的函数名在召回层之外零命中。📌 `resolvePremiumFloor` / `resolveQualityCeiling` **蓄意不入表** —— 它们解的是默认值不是成员，use case 侧本来就要读得到。⚠️ 起草探针时把调用写进**注释**里，判据没红 —— 那不是平凡绿，是 `findShapeHits` 剥注释；换成真代码即红（`leg-tab.rules.ts` 实测）。

  📌 **链未就绪 ⇒ 六维全 `null`**（spec Edge Case「spot 缺失」）：`null` 表达的是「没有值」不是「不限」。🚫 拿一个假 spot 现算一份填进去，会让「解不出」看起来像「解出来正好是这些值」，而客户端照样能填进控件、照样能点搜。

  🔬 **反例探针 4 次**：覆盖通吃三视角 ⇒ **1 红** / 边际计数不要求「默认值下放行」⇒ **3 红**（含 1 条 IT）/ 边际口径退化成「含该维即计」⇒ **2 红**（含 1 条 IT）/ 全腿也设成色与价差 ⇒ **22 红**。另有一条**自撞的红**：写「两维同挡」断言时用了基线腿的 `volume: 10`，被**免死条款**救回 ⇒ 计数恒 0，那条断言本来在测「OI 维度压根没挡下任何腿」。

  📌 **`recallCandidates` 的 lint complexity 从 19 降到阈值内**：逐腿评判抽成 `evaluateLeg`（返回候选归属 + 三个计数的命中），主循环只累加。⚠️ `get-legs.usecase.ts:577` 那条 complexity 18 是**既有**的（T009 前就在，行号随本次新增代码从 541 移到 577）—— mention 不改。

  ✅ verify: `nx test server` **411 文件 / 4078 用例绿**（本批 +26，含 3 条真库 IT）· `nx test @nvy/checks` 217 绿 · `nx lint server` 绿 · `check-optionsdesk-rule-constants` 七条不变量过 · `check-server-moat` 0 违规 · `check-test-size` 七条不变量过。

- [X] T011 [Contract] **DTO + OpenAPI + api-client regen**（`FR-011`, `FR-029`, plan §V）：`optionsdesk.dto.ts` 加三组字段，**每组均覆盖上表六个维度**（非泛指）：「本次生效条件值」「系统默认值」「每维度三态（未覆盖 / 覆盖且放宽 / 覆盖且收窄）与计数」；nullable string 字段的 `@ApiProperty` 显式 `type: 'string'`；跑 `nx run server:export-openapi` + `nx affected -t generate`，修因新 required 字段编译红的手写 mock 工厂。→ verify: `openapi.json` diff 只增不删 + `nx affected -t build` 绿 + **手写 mock 工厂逐处补齐**（`050` 那次是 7 处）

  🚨 **请求侧也在本 task 落地**（tasks 原文只提响应三组字段，但没有请求参数「用户覆盖」就无从提交）：`LegRetrievalQuery` = `perspective` + 六维，controller `@Query()` 接入，`toRetrievalOverride()` 做映射。

  🚨 **缺键 = 未覆盖，空串 = 覆盖为「不限」**。⇒ 映射**逐键判 `!== undefined`**，🚫 MUST NOT 用真值判断：`''` 与 `'0'` 都是假值，真值判断会把「覆盖为不限」和「下限设为 0」双双吞成「没动过」——而三态照样出得来。有断言守 `openInterestMin=0`。

  🚨 **DTE 段两端 MUST 成对，只给一端 → 400**。半个闭区间不是合法维度值；静默补另一端要么意外放宽（补不限），要么要在 controller 重算默认值——**而那需要 spot**，正是 `FR-011` 禁的第二处计算。这条使「DTE 段是一个维度」在契约层也成立。

  📌 **系统默认值不进请求**：客户端不回传默认值（「复位」= 不带任何参数）。让它回传就等于让它先算一份。

  🔬 **`openapi.json` 逐项比对（不靠肉眼看 diff——它是单行 JSON）**：脚本解析前后两版 ⇒ schema **只增 6 个**（`RetrievalCriteriaResponse` / `RetrievalOutcomesResponse` / `CriterionOutcomeResponse` / `PerspectiveCriteriaResponse` / `LegCriteriaByTabResponse` / `DteBandResponse`）、path **零增删**、既有 schema **零字段删除**（`LegTableResponse` 只增 `criteriaByTab`）、legs 端点新增 7 个 query 参数。

  ✅ **nullable 字段未被 orval 误生 objectmap**：六个 nullable 项在生成的 `RetrievalCriteriaResponse` 里逐条是 `string | null` / `number | null` / `DteBandResponse | null`（`@ApiProperty` 显式 `type` 的既有纪律照办）。

  ⚠️ **手写 mock 工厂补齐 6 处**（050 那次是 7 处）：`leg-picker.rules.spec.ts` · 三个 e2e spec 的 `makeLegTable` · contract-smoke 两处调用点。**hook 签名也变了**（orval 给 `useOptionsdeskControllerLegs(symbol, params?, options?)`）⇒ `use-leg-table.ts` 恒传 `undefined` 占住第二参，真值归 T012。📌 三个 e2e 的六维 mock 抽到 `e2e/_support/optionsdesk-fixtures.ts`——各写一份就是三份必 drift 的镜像，而 drift 时 **typecheck 全绿**（形状对、值不同）。

  📌 **条件值一进 query 就自动进 React Query 的 key**（orval 生成的 key 含 params）⇒ `FR-015`「每视角各自持有条件状态」是**结构保证**，T012 不需要手写隔离。

  ✅ verify: `openapi.json` **只增不删**（逐项比对）· `nx affected -t build` 绿 · `nx typecheck mobile` 绿 · `nx test server` 411 文件 / **4084** 用例绿（本 task +6）· `nx test mobile` 101 文件 / 1459 绿 · `nx lint` 两端绿 · `check-api-property-nullable` / `check-contract-smoke-drift` / `check-test-size` 均过

---

## Phase 6: Mobile 增量 + 两层验证

### 🔁 T010 / T011 修订 —— 活性条件参数化（2026-08-13，mockup review 触发）

`/mockup-gen` 期 user review 指出「持仓 ≥ 1」看不清楚，逐条核后改了**契约**，不只是文案：

🚨 **`openInterestMin`（一个数）→ `livenessMin`（一个维度、两个值）**：判据从 `OI ≥ 下限 或 volume > 0` 改为 `OI ≥ oi 或 当日成交 ≥ volume`。**默认值下逐字等价** —— 成交量是整数张数 ⇒ `> 0` ⟺ `>= 1`，故 `VOLUME_FLOOR = 1` 就是原行为，参数化改的是「这个数在哪儿」不是判据。有断言直接守这条等价性。

🚨 **蓄意做成一个维度而不是两个**（user 确认）：拆开后一条腿被挡 ⟺ 两支都不过 ⇒ 把**任一支**换回默认值都能救它 ⇒ 同一条腿会同时计进两个维度的边际计数，两行「当前条件之外还有 N 条」说的是同一批腿，**加起来双计**。⇒ 与 DTE 段同构：一个维度、值是一对数、覆盖时两端 MUST 成对（只给一端 → 400）。

🚨 **命名同时修掉两处 misleading**：① 「持仓」在本 App 已被 `portfolio` 占用（持仓屏 / 持仓导入 / 持仓规模），而选约屏自己的水位 chip 就在讲「持仓规模」——同屏用它标合约未平仓量会被读成「我的持仓」。② 原名 `openInterestMin` 里却含 volume 判据，与用户看到的标签是同一类错。控件标签取 `OI ≥` / `Vol ≥` 是为**与 12 列表头逐字一致**（`optionsdesk-copy.ts` `oi: 'OI'` / `vol: 'Vol'`）。

📌 同批修掉两处量纲/口径歧义：`价差 ≤ 0.35` → `35%`（无量纲比例，其余五项是金额或张数）；`权利金 ≥` 加后缀「按 bid 判」（控件说权利金而列头是 `bid`）。

⚠️ **守门抓到一处 T011 漏跑它才没暴露的违规**：`@ApiProperty` 的 `example` 里写了真阈值 `'0.2000'` / `'0.3500'`，撞 `check-optionsdesk-rule-constants` 不变量 #2（召回层阈值只住 `leg-recall.rules.ts`，**认值不认名**，文档示例同样算硬编码）。T011 那轮只跑了 `check-api-property-nullable` / `check-contract-smoke-drift` / `check-test-size`，**漏跑了这条**。已改成示意值（`0.2384` / `0.3000`，蓄意不等于默认值）。

✅ verify: `nx test server` 411 文件 / **4087** 用例绿 · `nx test mobile` 1459 绿 · 两端 typecheck / lint 绿 · **六条守门全过**（含本次补跑的 `check-optionsdesk-rule-constants` 七不变量）· `openapi.json` 仍只增不删（新增 `LivenessFloorResponse`，legs 端点参数 `openInterestMin` → `oiMin` + `volMin`）。

---

- [X] T012 [Mobile] **控件默认值回填 + 「搜」/「复位」+ 收窄维度计数行**（`FR-012`, `FR-013`, `FR-015`, `FR-029`, plan `D-CRIT-1`）：**六个维度**的控件各自用服务端下发的默认值填充（维度清单见 T010 表）；⚠️ ~~若六个控件放不进现有筛选行版式 → **停下补 mockup**~~ ⇒ **绊线已触发并走完**（2026-08-13）：容器形态 = **bottom-sheet 抽屉**，Tab 行右端一个 34px 入口带「已改 N 项」徽标，sticky 栈**一层不加**。照 `design/052-criteria-sheet.dc.html`（A1–A6 六帧）实装，逐条决策见 `design/handoff.md`。🚨 抽屉 MUST 走 **RN `Modal` 渲到 root 层**，否则盖不住 Tab 栏（memory `reference_drawer_overlay_bounded_by_tab_content_use_modal`）；ⓘ 是 **tap 触发**的 popup tip（移动端无 hover），热区 **44×44**；「搜」显式提交、「复位」清回默认；计数区追加**仅收窄维度**的行（复用 `051` 的 `.gateline` 结构与措辞体例）。→ verify: `*.rules.spec.ts`（Small，logic-only）—— 🚨 **mobile 侧 `rg` 扫不到任何参与默认值计算的算式**（`FR-011` / Guardrail 6 的机器判据）+ 三态到「显不显示计数」的映射是穷举 `Record`（漏 enum 成员即编译红）+ **每视角各自持有条件状态**（`FR-015` —— 切视角不带走上一个视角的值，条件值进 query key 即天然隔离）

  🚨 **`FR-015` 的第二处歧义由 user 于 2026-08-13 裁定：切视角时各视角的条件「各自留存」**（不是切走即清）。⇒ 状态是 `Record<视角, 已提交条件>`，**生效参数恒等于当前视角那一份**。代价说清楚：某视角有覆盖时切进去会换 query key ⇒ 该 key 首次要重新请求，`047`「切 Tab 不重新请求」在**有覆盖时**不再成立（无覆盖时逐字不变，参数恒 `undefined`）。🚫 另一条读法「留住值但不重发请求」被否 —— 那正是 T010 裁定否掉的「控件与数据不匹配且无法解释」，只是换了个触发路径。

  🚨 **`placeholderData: keepPreviousData` 是结构必需，不是体验糖**：换 key 那一拍若 `data` 变 `undefined` ⇒ `intent` 变 `null` ⇒ `resolveLegTab` 当场退回「全腿」⇒ 参数跟着换成全腿的 ⇒ 数据回来后又切回去，**两个 key 之间无限来回**。留着它，解析出的视角在换 key 期间保持稳定。<br>📌 **2026-08-13 由 T013 反例探针实测坐实，且比原推演更硬**：这一圈全是**同步的 `setState`，跑赢了网络** —— 任何响应落地之前就撞到 React 更新深度上限，整块屏被 error boundary 接住（React error #185「Maximum update depth exceeded」，摘掉该项后 e2e **6 条红**）。原注写的「数据回来后又切回去」暗示它会自行收敛，**不会**。

  🚨 **参数与视角的同步只能走 effect**：解析视角要 `intent`，而 `intent` 来自响应本身 ⇒ 参数必然滞后一拍。且「选完水位意图变、Tab 自动让位」那条路径**没有回调可挂**（`resolveLegTab` 自己变的），只有 effect 跟得上；跟不上就是控件显示 A 的值而表按 B 的条件召回。

  🚨 **每视角的控件行集是客户端常量 + 一条兜底**：建仓无「行权价」行（`FR-007`）、全腿无「价差」行（`FR-010`）是 UI 取舍（服务端对三视角一律接受这些覆盖），故加**兜底**——服务端下发了非 `null` 默认值的维度**强制出现**。藏起一个正在生效的条件 = 表被一条看不见的判据切过，而屏幕上无从解释。

  🚨 **成对维度半空归零 MUST 改回表单本身**（DTE 段 / 活性）：契约里一端为空即整维 `null`，而**活性在语义上必须如此**（OR 的任一支放到不限，整个维度就恒成立）。只在提交时悄悄归零的话，框里留着 `365` 而生效的是「不限」。

  🚨 **空态第三支**（spec Edge Case「条件收紧到候选为空」）：入口是**复位**而不是「去别的视角看」——空是用户自己切出来的，换视角帮不上忙。判据取服务端三态回执（`state !== 'default'`，**放宽也算**），不靠客户端记忆；三个视角都可能撞上，故排在既有两支之前。

  📌 **价差控件走百分数显示**（`35` 而非 `0.35`）：契约是无量纲比例，换算单点在 `ratioToPercent` / `percentToRatio` 两个函数。它**不产生新的判据值**（不是「自算默认值」），与定标裁剪同属量纲/显示层。徽标数同理取服务端回执而非客户端记忆。

  🚨 **`FR-011` 的机器判据落守门脚本不变量 #8** —— `check-optionsdesk-rule-constants.ts` 的**扫描面首次伸到客户端**（`apps/mobile/src/optionsdesk/`）：词表（服务端默认值解析函数 / 四个阈值常量名）+ 算式形状（`spot` 直接参与乘除），两侧探针齐备。🔬 **反例探针实证**：注入 `spot * 1.05` ⇒ 退出码 **1** 并点名文件；移除 ⇒ **0**。⚠️ 限制写进脚本头：它拦的是「照抄那份判据」这一最可能形态，**不拦所有自算**（先把 spot 赋个别名再乘就能绕开）——刻意绕开的人不是这条要防的对象。📌 Small 档禁磁盘 I/O ⇒ 源码扫描归 `scripts/checks/`，同 #5/#6/#7 的处置。

  ⚠️ **既有 warning 未修但被我推大了**：`UnderlyingDetailScreen` 的 `max-lines-per-function` 本就超（168 > 150），本次 JSX 增量推到 **183** —— mention 不改（拆屏是独立重构，per Surgical Edits）。本次**新引入**的 `complexity 16` 已消：把「够不够格开抽屉」的判定记忆化（它进 sticky section header，滚动期间每帧被读）。

  ⚠️ **UI 层本 task 零自动化覆盖**（按仓内测试分层：vitest = logic-only）——抽屉的滑入、`Modal` 盖不盖得住 Tab 栏、输入法弹起后按钮还在不在，**全部归 T013**。mockup 那轮「六项探针全绿、看图才发现」撞过三次，这里同理：本 task 的绿只说明判据对。

  ✅ verify: `nx test mobile` **102 文件 / 1500 用例绿**（本批 +41：37 条 `leg-criteria.rules.spec.ts` + 4 条空态第三支）· `nx run mobile:runtime-smoke` **175 绿**（改了共享 hook 与详情屏 ⇒ 跑全套非单 spec）· `nx typecheck mobile`（含 e2e tsconfig）/ `nx lint mobile` **0 error** · `nx test @nvy/checks` **224 绿**（本批 +7）· 五条守门脚本全过（`check-optionsdesk-rule-constants` 八不变量 / `check-test-size` / `check-repo-layout` / `check-api-property-nullable` / `check-contract-smoke-drift`）。

- [X] T013 [Mobile-E2E] **hermetic e2e**（US3 全部 AS, `FR-014`, `SC-008`）：Playwright Expo Web，`route.fulfill` 拦端点。→ verify: 进入视图控件已填默认值 / 改值不点搜结果不变 / 点搜按新值 / 点复位回默认且计数消失 / 离开再进回默认（`FR-014` 不持久化）/ 🚨 **mock 是契约镜像不是调用序**（按请求参数无条件作答，禁按测试编排标志分支）+ 跑**全套** `runtime-smoke` 非单 spec

  🔬 **本 task 最大的产出不是那 9 条绿，是一条反例探针**：摘掉 T012 的 `placeholderData: keepPreviousData` 后 **6 条红**，且形态是**整块屏被 error boundary 接住**（React error #185「Maximum update depth exceeded」）—— 那一圈 setState 全是同步的，**跑赢了网络**，任何响应落地之前就撞到更新深度上限。⇒ T012 注释里「数据回来后又切回去」那个暗示它会自行收敛的说法已订正（两处：`use-leg-table.ts` 与本文件 T012 段）。

  🚨 **mock 是契约镜像不是调用序**（本 task 的硬纪律）：handler 是 `(请求参数, canonical 腿册) → 响应` 的**纯函数** —— 六维判据、每维的**边际计数**（把这一维换回默认值能多看几条）在 mock 里**真的算一遍**，不是按测试编排摆好两份答案。🚫 反面写法（`callCount === 0 ? 默认表 : 收窄表`）在本文件所有断言下**照样全绿**，而客户端一旦多发一次请求（加个 `invalidateQueries`）就当场碎且 typecheck 拦不住（032 FU-1 同款）。

  🚨 **`FR-014` 那条如果只验「重进回默认值」就是平凡绿** —— 仓内 e2e 纪律是深链 `page.goto`（`goBack` 被嵌套 Stack 重映射），而深链 = 整页重载，**重载什么都会清**。⇒ 补了一条**结构判据**：提交后直接扫 `localStorage` + `sessionStorage`，用户值与维度名**均零命中**。落 storage 的实现会在这一条当场红，而重进那条照样绿。

  ⚠️ **一条起草时写错的断言，被真实缓存行为纠正**：原写「点复位 ⇒ 最后一个请求是无参数的」，实测复位后**根本不发请求** —— 无参数那把 key 开屏就取过、仍在 `staleTime` 内 ⇒ 直接命中缓存。改成「**全程带参数的请求有且只有用户那一维的那一条**」：既守住了 `FR-011`「默认值 MUST NOT 回传」，又不对缓存命中与否作过度承诺。

  📌 **Expo Web 验不到、如实标注不凑断言的三项**：① 抽屉是否**真盖住底部 Tab 栏**（web 上 Modal 层级由 DOM 决定，与 native 的 tab content 容器约束不是一回事）② 输入法弹起后「搜」还在不在屏内（web 无软键盘）③ ⓘ 热区 44×44（量得到盒子量不到手指）——三项归真机验收。本文件对 ⓘ 只验 tap 开 / 再 tap 关。

  ✅ verify: `nx run mobile:runtime-smoke` **184 绿**（本批 +9，跑全套非单 spec）· 🔬 反例探针 **6 红**（摘 `keepPreviousData`）· `nx test mobile` 102 文件 / 1500 绿 · `nx typecheck mobile`（含 e2e tsconfig）/ `nx lint mobile` **0 error** · `check-test-size` / `check-e2e-seed-auth-mock` 均过。

- [ ] T014 [Contract-Smoke] **契约冒烟扩到新字段**（Constitution §V）：`apps/mobile/e2e/contract-smoke/` 用生成的 `@nvy/api-client` 打 testcontainers 真 server。→ verify: 条件参数序列化正确 + 默认值字段解封 + 计数三态字段解封 + `nx run mobile:contract-smoke` 绿

---

## Phase 7: 覆盖收口与标定

- [ ] T015 [Server] **IT 全量 state branch 扫描**（`FR-001`, `FR-010`, `FR-033`, plan Testing Invariants）：`optionsdesk-052.retrieval.it.spec.ts` 补齐前面各 task 未覆盖的分支，使 spec 的 **24 条 `state_branches` 逐条有 `it()`**。→ verify: 逐条 grep 交叉核对（**不靠通读**，per `sdd-authoring.md` 反模式）—— 24/24 命中 + `SC-005` **差集断言**（「旧候选集 ∩ 过持仓量条件的腿 = 新候选集」，差集里零条是别的原因；T004 期订正，原「逐条相同」与 `FR-008` 互斥） + **相对价差条件只作用于两个意图视角**（`FR-010`，全腿不受其约束）+ 🚫 **`045` 的锚派生与意图矩阵零改动**（`FR-033` 的否定式断言 —— `anchor.rules.ts` / `intent-matrix.rules.ts` 的 `git diff` 零命中）+ `nx test server` 全绿

- [ ] T016 [Gate] **七项标定 + 写回 spec**（`SC-011`, plan `D-CALIB-1`）：用 dev 全部 12 条链，沿 `050` T017 的直方图找谷底 / 衰减终点做法，标定：成色兜底比例 X · 流动性档界（**相对与绝对价差两个口径都要评**）· 活跃标绝对下限 · 分层降级阈值 · 费率打平带宽 · 召回候选上限 K · 是否设单笔权利金下限。→ verify: 七项数字与**推导过程**写回 spec § Assumptions；代码内**零处**未标定的占位常量（`rg` 扫 `TODO|占位|placeholder` 零命中）；🚫 若某项分布无明显断点则**记为「不设该条件」**而非拍一个数

---

## Dependencies & 执行顺序

```text
T001 (port) ──┬─> T003 ─> T004 ─> T005        [Phase 2 · 同改 leg-recall.rules.ts，串行]
T002 (粗排)  ─┘
                T006 ─> T007 ─> T008           [Phase 3 · 同改 leg-rank.rules.ts，串行]
                T009 [P]                        [Phase 4 · 改 leg-derive.rules.ts，可与 Phase 3 并行]
                T010 ─> T011 ─> T012 ─> T013
                                     └────────> T014
                T015 ─> T016                    [收口，需前面全绿]
```

- **T009 是本片唯一的 `[P]`** —— 它改 `leg-derive.rules.ts`，与 Phase 3 的 `leg-rank.rules.ts` 不同文件且无依赖。
- T003/T004/T005 同改一个文件 ⇒ **不可并行**。T006/T007/T008 同理。
- T011 之后**禁止**再往 PR push 新 commit 前遗漏 regen —— `api-client:generate` 无 `dependsOn`，单跑它是拿 stale `openapi.json`。

## Clear 检查点批次

| 批次 | Task | 批次后建议 `/clear` |
| --- | --- | --- |
| 1 | T001 · T002 | ✅ 层骨架落定，后续按层推进 |
| 2 | T003 · T004 · T005 | ✅ 召回层完成，US1 可独立验 |
| 3 | T006 · T007 · T008 | ✅ 精排完成，US2 可独立验 |
| 4 | T009 · T010 | ✅ |
| 5 | T011 · T012 | ✅ 契约与 mobile 落定 |
| 6 | T013 · T014 | ✅ |
| 7 | T015 · T016 | — |

🚨 **批次 ≠ commit 合并** —— 每 task 仍各自 atomic commit（Constitution §III）。

## Acceptance Scenario 覆盖矩阵（19 条 → task，逐条 1:1）

| US | AS | Task |
| --- | --- | --- |
| US1 | 1 每腿行权价 ≤ 成色上界 | T003 |
| US1 | 2 恰等于上界仍在候选 | T003 |
| US1 | 3 稀疏网格由比例项二次收窄 | T003 |
| US1 | 4 建仓视角行为不变 | T003 / T015（`SC-005`） |
| US1 | 5 全腿视角深度实值仍在 | T008 |
| US2 | 1 厚腿排在薄腿前 | T007 |
| US2 | 2 档内按费率降序 | T007 |
| US2 | 3 打平带内长者优先 | T007 |
| US2 | 4 候选少于阈值不分档 | T007 |
| US2 | 5 全腿深度实值末段但未移出 | T008 |
| US3 | 1 首屏控件已填默认值 | T010 / T012 / T013 |
| US3 | 2 改值不提交结果不变 | T013 |
| US3 | 3 提交后按新值且显计数 | T010 / T013 |
| US3 | 4 复位回默认且计数消失 | T012 / T013 |
| US3 | 5 离开再进回默认 | T013 |
| US3 | 6 放宽后活跃标重算 | T010 |
| US4 | 1 标分布覆盖多到期日 | T009 |
| US4 | 2 死到期日不发标 | T009 |
| US4 | 3 无候选到期日不产生空分组 | T009 |

## state_branch 覆盖矩阵（24 条 → task）

| # | 分支要点 | Task |
| --- | --- | --- |
| 1 | 收租 · 高于成色上界不进 | T003 |
| 2 | 收租 · 恰等于上界进 | T003 |
| 3 | 收租 · 稀疏网格比例项接管 | T003 |
| 4 | 建仓 · 有效成本不过不进 | T015 |
| 5 | 建仓 · K 高于 spot 但成本仍低则进 | T015 |
| 6 | 全腿 · 不因成色被排除 | T008 |
| 7 | 任一视角 · OI=0 且无成交不进 | T004 |
| 8 | 任一视角 · OI=0 但有成交进 | T004 |
| 9 | 任一视角 · 权利金低于下限不进 | T015 |
| 10 | 意图视角 · 价差超上界不进意图视角 | T015 |
| 11 | 全腿 · 不因价差被排除 | T015 |
| 12 | 未覆盖任何条件 → 按默认召回、不显计数 | T010 |
| 13 | 收窄某维度 → 该维度显计数 | T010 |
| 14 | 放宽某维度 → 候选变大、活跃标重算 | T010 |
| 15 | 「复位」→ 全部回默认并重召回 | T012 / T013 |
| 16 | 离开再进 → 回默认（不持久化） | T013 |
| 17 | 改值未点搜 → 结果不变 | T013 |
| 18 | 候选超 K → 截到 K 且可观测 | T005 |
| 19 | 候选少于降级阈值 → 不分档 | T007 |
| 20 | 同到期日 top N 且量过线 → 发标 | T009 |
| 21 | 同到期日 top N 但量不过线 → 不发标 | T009 |
| 22 | 某到期日无候选 → 不产生空分组 | T009 |
| 23 | 全腿 · 深度实值保留但排末段 | T008 |
| 24 | 意图/水位变化 → 成员集不变，仅标与序变 | T010 |

## Edge Case 覆盖（8 条 → task）

| Edge Case | Task |
| --- | --- |
| 成色上界解不出（链上无 ≥ spot 的档） | T003 |
| spot 缺失 → 沿用「链未就绪」不猜默认值 | T010 |
| 条件放宽到超出数据范围 → 计数为 0 且不显示 | T010 |
| 条件收紧到候选为空 → 空态区别于「本来就没有」+ 给复位入口 | T012 / T013 |
| 候选数恰等于降级阈值 → 不降级 | T007 |
| 同到期日内 OI 与成交全等 → 稳定决胜不随机 | T009 |
| 候选超 K → 截且可观测 | T005 |
| greeks 缺失腿照常进候选 | T015 |

## SC 覆盖（11 条 → task）

| SC | Task |
| --- | --- |
| SC-001 收租零条高于成色上界 | T003 |
| SC-002 KBR 不再出现三位数年化实值腿 | T015 |
| SC-003 新精排前 N 流动性不劣于旧 | T007 |
| SC-004 活跃标覆盖多到期日且不落死到期日 | T009 |
| SC-005 建仓候选集的变化全部且仅由持仓量条件解释（差集断言） | T015 |
| SC-006 被排除的腿 100% 可在全腿视角找到 | T008 |
| SC-007 客户端零处自算默认值 | T012 |
| SC-008 改值/提交/复位三条各有断言 | T013 |
| SC-009 召回判据单测不依赖真库 | T001 |
| SC-010 五层各有独立入口与测试；顺序错误可捕获 | T002 / T015 |
| SC-011 全部待标定量由实测产出，零处拍数 | T016 |

## 判据全表覆盖矩阵（spec § 视图 × 五层 逐行 → task）

> 🚨 **本矩阵是 `/speckit-analyze` C5 补的**。判据全表是本片独有的承载层（049/050/051 都没有），
> 其余四张矩阵（AS / state_branch / Edge Case / SC）**结构上够不到它** —— C1（六维度未枚举）与
> C3（`rate` 口径未登记）两条发现都是从这个缺口漏出来的。

### 召回层

| 行 | 全腿 | 建仓 | 收租 | Task |
| --- | --- | --- | --- | --- |
| 行权价上界 | 不限 | 不限 | 成色条件 | T003 · T010（默认值） |
| 行权价下界 | 不限 | 不限 | 不限 | T010（默认值） |
| DTE 段 | 不限 | `[1,49]` | `[30,365]` | T010（默认值）· T015（成员断言） |
| 权利金下限 | 有 | 有 | 有 | T004（否定式：常量不改）· T010 |
| 持仓量下限（新） | 有 | 有 | 有 | T004 · T010 · T016（标定） |
| 相对价差上界 | 不设 | 有 | 有 | T015 · T010 |
| 单笔权利金下限 ⏳ | 待定 | 待定 | 待定 | T016（裁定是否设） |
| 通用硬门槛（认沽 / 标准 / 未到期） | 一律 | 一律 | 一律 | T015 |
| 视角专属硬门槛（有效成本） | — | 有 | — | T015 |

### 其余四层

| 行 | Task |
| --- | --- |
| 粗排 no-op（三视角） | T002 |
| 特征加工 · 通用特征集 | T006 |
| 特征加工 · `rate` 按视角取口径 | **故意零覆盖**（`050` 已 ship，本片零改动，见下表） |
| 特征加工 · 成色特征（新，全腿用） | T006 |
| 精排 · 全腿（费率降序 + 成色沉底） | T008 |
| 精排 · 建仓 / 收租（分层） | T007 |
| 精排降级（候选少于阈值不分档） | T007 · T016（阈值标定） |
| 活跃标（同到期日 + 绝对线） | T009 · T016（绝对线标定） |
| 表达层 | **故意零覆盖**（归 `053`） |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 事项 | 为什么故意不覆盖 |
| --- | --- |
| 粗排层的合并 / 去重行为 | 本片是**恒等函数**，无输入可合并。ADR-0064 sunset #1（多路召回落地）才是它的触发条件 |
| 表达层的档位口径 / 截断 N / 列改版 | 归 `053`，本片零改动（`FR-034`） |
| 特征加工层的 `rate` 按视角取口径（建仓周化 / 收租与全腿年化） | `050` 已 ship 且本片**零改动**。判据全表列它是为了让该层的完整形态可读，不是本片的实现义务 |
| 检索 port 的第二个实现 | 本片单实现。ADR-0064 sunset #3（规模突破阈值）才触发 |
| 真机验收 | 本片 mobile 增量零新视觉形态（复用 `049`/`051` 定稿），无占屏比变化。⚠️ 若 T012 期发现需要新版式 → **停下补 mockup**（plan Gate 0.1 的绊线） |

## MVP

**Phase 1 + Phase 2（T001–T005）** —— 交付「收租视角不再被公式退化产物占满」这一条，独立可验、独立有价值。它是本片存在的理由（US1），其余是在它之上的质量提升。

## 单 PR（Constitution §V）

本片带一处 mobile 改动 ⇒ server impl + IT + `export-openapi` + regen + mobile 消费 + 两层验证**全部同 PR 原子 merge**。
