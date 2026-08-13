---
feature_id: 052-optionsdesk-retrieval-layering
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-12'
updated_at: '2026-08-12'
adr_refs: ['0064', '0043', '0032', '0053', '0062']
context7_verified: []
---

# Implementation Plan: 选约检索分层落地 + 三视角逐层判据重梳（P3）

## Summary

把 `050` 已 ship 的「召回 + 打标 + 精排」按 [ADR-0064](../../docs/adr/0064-optionsdesk-retrieval-layering.md) 切成显式五层，并在此结构上重梳三视角的逐层判据 —— 修掉收租视角被深度实值占满的缺陷（新增成色条件）、补上权利金门槛结构上抓不到的死腿（新增持仓量条件）、把精排从单键费率降序改为**离散化主键上的 lexicographic**（流动性档 → 档内费率 → 期限决胜）、把活跃标的分组维度从候选集改为到期日。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

> 本片零新依赖。分层排序、检索 port、特征注册表全部用已有的 TS 类型系统 + 纯函数实现，不引框架。

## Constitution Check _(mandatory gate)_

- [x] **Passed** —— 逐条：**§I** SDD 全流程（specify → clarify 在起草前的对焦中完成 → plan；本片 UI 增量仅一条计数行，复用 `051` 已定稿的 `.gateline` 结构，**不触发 mockup 卡点**——见 Gate 0.1 说明）；**§II** 每 task 红→绿→typecheck/lint→`[X]`→commit；**§III** task 拆为 30min–2h 独立 commit；**§IV** 不新增 bounded context，跨 ctx 仍只读直查 + `CROSS-CONTEXT-READ` 注释；**§V** 带一处 mobile 改动 ⇒ 单 PR + `export-openapi` + regen + 两层验证。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 三视角逐层判据由 `optionsdesk-052.retrieval.it.spec.ts` 覆盖（Testcontainers 真 PG），spec 的 24 条 `state_branches` 每条一个 `it()`。
- [x] **Mobile / Web**: 本片 mobile 增量 = 检索条件控件的系统默认值回填 + 「搜」/「复位」+ 被收窄维度的计数行。走 Playwright Expo Web hermetic e2e。<br>📌 **不走 mockup 卡点的理由**：新增的计数行**逐字复用 `051` 已定稿的 `.gateline` 结构与措辞体例**（第 3 条追加，非新形态）；检索条件控件复用 `049` 已定稿的筛选行形态，只是把「清除」换成「搜 / 复位」。⇒ 零新视觉形态，Constitution §I 的 mockup 卡点针对的是**新 UI 形态**，本片没有。⚠️ 若 impl 期发现「四个可调维度怎么摆」需要新版式（`053` 的 `049` 遗留问题），**停下补 mockup**，不临场发挥。
- [x] **Evidence**（2026-08-13 回填）：⚠️ **上面那条「不走 mockup 卡点」的理由 impl 期被证伪，绊线触发、已走 `/mockup-gen 052` 回补**。逐条核后三处对不上：维度数 **1 → 6**（`049`/`053` 的筛选行只容行权价一个维度）· 生效方式 **实时防抖 → 显式「搜」**（`FR-012` 反转）· 排名基准 **不进 → 进**（`FR-026` 反转 `053` 起草时的 `FR-009`）。⇒ 产出 `design/052-criteria-sheet.dc.html`（**六帧** A1–A6）+ `052-criteria-inline.dc.html`（选型对照）+ `claude-design-prompt.md` + `handoff.md`；**方案 A（bottom-sheet 抽屉）经 user 选定**。渲染验证走仓内 Playwright 无头，六项探测全 0；0 新增 token。<br>📌 mockup review 连带改了**契约**（不只是文案）：`openInterestMin` → `livenessMin`（一个维度两个值，`OI ≥ x` 或 `Vol ≥ y`），详见 `tasks.md` 的「T010 / T011 修订」段。<br>📌 **Server 侧 Evidence**：`optionsdesk-052.retrieval.it.spec.ts` 现 9 个 `it()`（T005 三条 + T008 三条 + T010 三条），24 条 `state_branches` 的收口仍归 T015。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A —— 零新第三方包**（见 Dependencies 表）。

📌 但本片按 owner 要求做了**通用设计模式核查**（2026-08-12，WebSearch），结论落 `D-RANK-1` / `D-LAYER-1` / `D-FEAT-1`：

| 核查项 | 结论 |
| --- | --- |
| 「分层排序」有没有业界名字 | ✅ **有** —— **lexicographic ordering**（主键排序、次键决胜）。另一候选「帕累托前沿」对应 **skyline approach (dominance)**。两者是业界并列的两条无权重多目标路径 ⇒ 本片方案**不是自创** |
| 多级检索的工程范式 | ✅ 漏斗：candidate generation → light ranker → heavy ranker → re-ranking；**多个 candidate generator 各产子集、合并成单一候选池后统一打分** ⇒ 佐证 ADR-0064 的粗排层槽位形状 |
| 可插拔排序器 | ✅ 各级 ranker 是独立组件、按候选量级递增复杂度；接口以「候选集 → 有序候选集」为界 |
| 「每特征恰好一处」怎么强制 | ✅ 业界用 **declarative feature registry**（特征在一处声明名/类型/归属，计算与消费都从注册表取）。本仓已有轻量版，本片把它做成**编译期强制**（见 `D-FEAT-1`） |

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。optionsdesk ctx 自 `045` 起在 mono 内建立，无 meta-repo 迁入史。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / sunset trigger | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| **ADR-0064** | sunset #1「多路召回落地 → 粗排层由 no-op 转实体」 | **accepted-as-is，未命中** | 本片仍是单路召回，粗排层只落位置与接口，无输入可处理 |
| **ADR-0064** | sunset #2「精排换加权评分或 LLM → 重审不变量 ②」 | **accepted-as-is，未命中** | 本片精排仍是确定性规则（lexicographic），只读特征集 |
| **ADR-0064** | sunset #3「规模突破阈值 → 特征迁检索层 / port 需第二实现」 | **accepted-as-is，未命中** | 特征仍全在应用层纯函数（不变量 ③ 满足）；port 单实现 |
| **ADR-0043** | §4 Port 三分法 | **escalated-to-ADR-0064** | 本片立的检索 port 属第四类（跨 ctx 只读查询），ADR-0064 决策 4 已追加该类处置。**本片是它的首个实施** |
| **ADR-0053** | sunset #2「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`」 | **accepted-as-is，未命中** | 本片派生仍全落 `optionsdesk/*.rules.ts`，不 import `marketdata/*.rules.ts`。ESLint `boundaries` 是机器绊线 |

## Architecture Notes

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

- **NO LIFECYCLE MOCKING**：本片不新增 lifecycle 组件；若检索条件校验落 `ValidationPipe`，其测试必须走 DI 容器。
- **MANDATORY INTEGRATION**：`Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()`，之外的「测试」视同未测试。
- **EXHAUSTIVE BRANCHING**：spec `state_branches` **24 条**，每条在 IT 里有对应 `it()`。100% 路径覆盖。<br>⚠️ **2026-08-13 T015 收口期订正**：其中 3 条（复位 / 离开再进 / 改值未点搜）是**纯客户端行为**，服务端 IT 结构上够不到 ⇒ 该 invariant 按「**每条有一个 `it()`，落在够得到它的那一层**」执行（那 3 条落 `apps/mobile/e2e/`，per tasks.md 的分配矩阵）。逐条交叉核对表在 tasks.md T015 段。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**：文件平铺 `apps/server/src/optionsdesk/`，**NEVER** 生成 `domain/` / `application/` / `infrastructure/` / `web/`。**五层是逻辑分层不是目录分层** —— 每层一个（或几个）平铺文件，MUST NOT 为分层建子目录。
> - **Anemic Data & Zero-Class**：数据 = 裸 Prisma row，**NEVER** Domain Class / Entity Mapper。
> - **No Repositories**：自有表直注 `PrismaService`；**本片的检索 port 是 ADR-0043 §4 三分法的第四类例外**（跨 ctx 只读查询），由 ADR-0064 决策 4 追加，MUST NOT 据此为自有表也造 port。
> - **The Moat**：跨 ctx 读 MUST 带 `// CROSS-CONTEXT-READ: <数据范围 + 只读>`（`check-server-moat.ts` 机器强制）；跨 ctx 写永远禁。

---

## D-LAYER-1 · 五层怎么落在扁平模块里（`FR-001`）

**五层是逻辑边界，不是目录**。落法：每层一个平铺文件 + 一个显式入口函数，层间只经入口调用。

| 层 | 载体 | 入口职责 |
| --- | --- | --- |
| 召回 | `leg-recall.rules.ts`（已有，本片扩） + 检索 port | 吃「视角 + 检索条件 + 候选上限」，吐候选集 |
| 粗排 | `leg-coarse.rules.ts`（新，**no-op**） | 吃多路候选，吐合并去重后的单一候选池。**当前恒等函数** |
| 特征加工 | `leg-rank.rules.ts` 的 `computeRankingFeatures`（已有，本片扩） **+ `leg-derive.rules.ts` 的 `markActivity`**（活跃标也是特征，见下） | 吃候选集，吐特征集 |
| 精排 | `leg-rank.rules.ts` 的 ranker（已有，本片换实现） | 吃特征集，吐有序候选集 |
| 表达 | DTO + mobile（本片只动计数那一处） | — |

**层外但本片要改的三个文件**（它们不属于任何一层，是编排与契约）：`get-legs.usecase.ts`（五层的编排入口）· `leg-retrieval.port.ts` + `.adapter.ts`（本片新建，召回层的数据来源）· `optionsdesk.dto.ts`（契约）。

🚨 **`markActivity` 属于特征加工层，不是独立的一层** —— 它产出的 `isTopRanked` 是 13 项排序特征之一。把它当成「打标」而误置于精排之后，精排就没有该特征可用（`get-legs.usecase.ts` 现有注释已警告过一次，本片改的是它的**分组维度**不是位置）。

🚨 **粗排层为什么现在就建一个恒等函数**：业界范式是「多个 candidate generator 各产子集 → 合并成单一候选池 → 统一打分」。今天单路召回没有合并可做，但**留出这个接缝的成本是一个恒等函数**，而不留的成本是将来多路召回时要把调用链拆开重接。ADR-0064 sunset #1 是它的触发条件。
🚫 **MUST NOT 在恒等函数里塞任何判据** —— 它一旦有逻辑就变成第二个打分点（ADR-0064 决策 1 的禁令）。

**层边界的机器判据**（`FR-001` 的可验证形态）：每层入口有独立单测；`rg` 扫「精排函数体内出现原始腿字段」零命中。

---

## D-PORT-1 · 检索 port 的形状（`FR-031` / `FR-032`）

**存在理由是「跨 ctx 只读的显式接缝 + 可 mock」，不是换存储引擎**（ADR-0064 决策 4 逐字）。

- **入参**：视角 · 检索条件（已解析的值，非原始查询串）· 候选上限 K
- **出参**：候选集（裸行 + 已判定的视角归属）
- 🚫 **接口 MUST NOT 出现**：SQL 片段 / 游标 / 分页 token / `LIMIT OFFSET` 语义 / 任何 Prisma 类型。漏进去等于换实现时接口照样重写，接缝白留。
- **实现**：`PrismaService` 直查 + `CROSS-CONTEXT-READ` 注释（`check-server-moat.ts` 机器强制）。
- **直接收益**（`SC-009` 的可验证形态）：召回判据的单测注入假 port，**不起容器**。

---

## D-CRIT-1 · 检索条件：系统默认值下发 + 用户覆盖（`FR-002` / `FR-011`–`FR-016`）

**契约形状**：响应 MUST 同时带「本次生效的条件值」与「系统默认值」两组。

- 客户端首屏用系统默认值填控件；用户改值 → 点「搜」→ 值进请求；「复位」→ 请求不带条件，服务端回默认值。
- 🚫 **客户端 MUST NOT 计算任何默认值**（`FR-011`）——它们依赖 spot（每天变）。机械判据：mobile 侧 `rg` 扫不到 spot 参与的算式。
- **每视角各自持有条件状态**（`FR-015`）：条件值天然进 query key ⇒ 切视角就是换 key，不需要手写隔离。
- **不持久化**（`FR-014`）：状态只活在屏级 state，MUST NOT 落 storage。

🚨 **计数只显示用户收窄过的维度**（`FR-029`）：判据是「用户值 ≠ 系统默认值 **且** 更严」。⇒ 响应里每个维度要能分辨这三态：未覆盖 / 覆盖且放宽 / 覆盖且收窄。**放宽也不显示计数**（放宽不产生排除）。

---

## D-RECALL-1 · 三视角判据（`FR-005`–`FR-010`）

**成色条件（收租，新）**：`K ≤ min{行权价 ≥ spot}` **∧** `K ≤ spot × (1+X)`，取严，闭区间。

- 🚨 **两条都要**：第一条是结构判据（不超过 spot 之上一档），第二条是稀疏网格的兜底。实测某链的「最近一档」是 `+6.5%`，但网格若为 `37.5 → 45` 则「最近一档」就是 `+19.8%` —— 单靠第一条挡不住。
- 🚫 **MUST NOT 只用有效成本 `K − bid < spot` 代替** —— 它更松：`K` 高于 spot 两档但权利金厚时仍能过，而 spec 要的是成色。

**持仓量条件（三视角，新）**：`OI ≥ 下限` **或** 当日有成交。

- 🚨 **「或有成交」是免死条款，MUST NOT 省略** —— 实测 1014 条 OI=0 的腿里有 34 条当日在交易（新挂档）。写成纯 `OI ≥ 下限` 会砍掉它们，且**不会红**。

**建仓视角零**专属**判据改动**（`FR-007` / `SC-005`）：IT 断言本片前后候选集的变化**全部且仅**由持仓量条件（`FR-008`，三视角一律）解释 —— 「旧候选集 ∩ 过持仓量条件的腿 = 新候选集」。<br>📌 **2026-08-12 订正**：原写「逐条相同」，与 `FR-008` 互斥（实测撞面 87/236 条建仓候选），裁定见 spec `SC-005`。

---

## D-RANK-1 · 精排 = 离散化主键上的 lexicographic（`FR-017`–`FR-022`）

**业界名字**：lexicographic ordering —— 按主键排序、次键决胜。本片的三级键：

```text
流动性档（离散） → 折算费率（连续，降序） → 期限（连续，长者优先，仅在费率打平带内）
```

🚨 **主键必须先离散化**，这是让 lexicographic 可用的关键一步：纯 lexicographic 用**连续**流动性值做主键，会让 `OI 501` 无条件压过 `OI 500`——无论费率差多少。分档把「流动性」粗化成几个等价类，档内才轮到费率说话。

- **档界**：⏳ 待标定（`D-CALIB-1`）。⚠️ 相对价差 `(ask−bid)/bid` 对长期腿有**系统性偏袒**（分母 bid 更大），标定时 MUST 同时评估绝对价差口径。
- **降级**（`FR-019`）：候选数 < 阈值时不分档。理由：薄链上档内没有足够多腿可比收益，分档会退化成「按流动性排」。边界取**严格小于才降级**。
- **全腿视角**（`FR-020`）：保持费率降序，新增**成色排序特征**令深度实值沉底。🚫 **MUST NOT 通过移出候选实现** —— 那会破坏 `051` 的入口（`SC-006` 是这条的回归防线）。
- 🚫 **加权评分否决**（`FR-021`）：权重无可校准数据。业界的另一条无权重路径是 skyline（dominance），已在 ADR-0064 候选表记为「更优雅但前沿内仍需第二个序」而未采纳。

**可解释性**（`050` 不变量 #10 的延续）：用户要能从屏幕反推排序理由 ⇒ 流动性档 MUST 在表达层可见（归 `053`，本片只保证服务端下发得出档位）。

---

## D-FEAT-1 · 特征注册表做成编译期强制（`FR-025`）

业界用 declarative feature registry 强制「每特征恰好一处」。本仓已有轻量版（特征键常量 + 单一计算函数），本片把它**从纪律升级为机器拦**：

- 特征集类型 MUST 为**按键穷举**的映射（`Record<FeatureKey, …>`）⇒ **加了键但没算 = 编译红**。
- 特征的计算 MUST 只出现在那一个函数内 ⇒ `rg` 扫「特征名出现在计算函数之外的赋值位置」零命中。
- 🚫 精排器 MUST NOT 读原始腿（ADR-0064 不变量 ②）：ranker 签名只吃特征集，机械判据是 ranker 函数体内 `rg` 扫不到腿的原始字段名。

**本片新增的特征**：成色（供全腿视角排序用）。加它时上面三条自动生效。

---

## D-MARK-1 · 活跃标改同到期日 + 绝对线（`FR-023` / `FR-024`）

- 分组维度：候选集 → **到期日**。
- 发标判据：同到期日内排名进前 N（相对）**且** 绝对量过线（绝对），**两条都要**。
- 🚨 **只用相对判据会在死到期日误报** —— 实测某到期日整体 OI 合计仅 23，其 top-1 只有 `OI=4`。
- **空分组**：某到期日无候选 ⇒ 不参与评比，MUST NOT 产生空分组或除零。
- **同分决胜** MUST 稳定（次级判据确定），MUST NOT 随机 —— 否则两次请求顺序不同而数据未变。

---

## D-K-1 · 召回层候选上限（`FR-027` / `FR-028`）

- K 是**给下游限流**的，不是用户可见条数。ADR-0064 不变量 ① 要求 `K ≫ N`，本片只落 K，N 归 `053`。
- 触及 K 时 MUST 可被观测（不依赖读日志）—— 与 `047` 的「降级留痕必须是 SQL 可读的行状态」同源纪律。
- ⏳ K 的取值待标定（`D-CALIB-1`）。当前最大链全量 758 行 ⇒ K 取值应显著高于它，否则今天就在截。

---

## D-CALIB-1 · 标定清单与方法（`SC-011`）

沿 `050` T017 的做法：**dev 全部 12 条链 / 直方图找谷底或衰减终点 / 过程写回 spec**。

| 待标定量 | 方法 | 判据 |
| --- | --- | --- |
| 成色兜底比例 `X` | 12 条链的「spot 之上最近一档相对 spot 的距离」分布 | 取能覆盖绝大多数链的正常网格、又挡住稀疏异常的分位 |
| 流动性档界 | OI 分位 + 价差（**相对与绝对两个口径都要评**）直方图 | 档间要有可辨识的分布断点，非等分 |
| 活跃标绝对线 | 各到期日 OI 合计与最大单腿 OI 的分布 | 能把「整体死掉的到期日」判出去 |
| 分层降级阈值 | 12 条链各视角候选数分布 | 低于它时档内腿数不足以比较 |
| 费率「打平」带宽 | 同 K 不同到期日的年化差分布 | 带内差异应小到不影响决策 |
| 召回候选上限 K | 12 条链全量腿数 | 显著高于当前最大值，作限流保险丝而非常态路径 |
| 是否设单笔权利金下限 | 单笔权利金分布 vs 每笔固定成本 | 若分布无明显低端聚集则**不设**（宁可不加条件） |

🚫 **全部 MUST NOT 拍数**；标定过程 MUST 写回 spec（`SC-011`）。

---

## D-TEST · 验证分层

### D-TEST-0 · Server IT（`optionsdesk-052.retrieval.it.spec.ts`，Testcontainers 真 PG）

24 条 `state_branches` 逐条 `it()`。重点断言：成色条件的三条边界（高于 / 恰等 / 稀疏网格兜底）· 死腿的免死条款（OI=0 但有成交仍进）· **建仓候选集的变化全部且仅由持仓量条件解释**（`SC-005` 差集断言）· **被排除的腿在全腿视角可达**（`SC-006`，`051` 回归防线）· 排名基准随检索条件变化（`FR-026`）· 分层与降级的边界。

### D-TEST-1 · vitest Small（纯 rules，不起容器）

成色 / 死腿 / 分层 / 活跃标分组的纯函数；**注入假 port** 验召回判据（`SC-009`）。

### D-TEST-2 · Mobile hermetic e2e（Playwright Web）

系统默认值回填 · 改值不提交结果不变 · 「搜」生效 · 「复位」回默认 · 收窄维度才显计数。

### D-TEST-3 · Contract smoke（跨端片义务）

生成的 `@nvy/api-client` 打 testcontainers 真 server，验条件参数序列化 + 默认值字段解封 + 计数字段。

### D-TEST-4 · 标定（`D-CALIB-1`）

单独 task，产出写回 spec。

---

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **持仓量条件写成纯 `OI ≥ 下限`**（漏「或有成交」）—— 砍掉 34 条正在交易的新挂档。
2. **成色只用有效成本代替** —— 它更松，挡不住 spot 之上两档的厚权利金腿。
3. **精排主键用连续流动性值**（不离散化）—— `OI 501` 无条件压 `OI 500`，费率完全失声。
4. **活跃标只用相对判据** —— 死到期日里发标（实测该到期日 OI 合计仅 23）。
5. **在粗排的恒等函数里塞判据** —— 它一旦有逻辑就成了第二个打分点。
6. **客户端算默认值** —— 依赖 spot，必与服务端漂移且两边都算得出数。
7. **计数对「放宽」也显示** —— 放宽不产生排除，显示出来是噪音。
8. **全腿视角用成色条件砍腿** —— 破坏 `051` 已交付的入口。
9. **为五层建目录** —— 违反 ADR-0043 扁平模块。
10. **活跃标同分随机决胜** —— 数据没变而两次请求顺序不同。

## Task 分解（**草图；编号与顺序以 `tasks.md` 为准**）

| # | 层 | 内容 |
| --- | --- | --- |
| 1 | `[Server]` | 检索 port 接口 + Prisma 实现 + 假实现（供单测） |
| 2 | `[Server]` | 召回层扩条件：成色（收租）+ 持仓量（三视角）+ 候选上限 K |
| 3 | `[Server]` | 粗排层恒等入口 + 层边界断言 |
| 4 | `[Server]` | 特征注册表编译期强制 + 新增成色特征 |
| 5 | `[Server]` | 精排换 lexicographic（分层 + 降级）+ 全腿成色沉底 |
| 6 | `[Server]` | 活跃标改同到期日 + 绝对线 |
| 7 | `[Server]` | 检索条件的系统默认值下发 + 用户覆盖 + 三态计数 |
| 8 | `[Server]` | IT：24 条 state branch 全覆盖 |
| 9 | `[Contract]` | `export-openapi` + regen + 修手写 mock 工厂 |
| 10 | `[Mobile]` | 控件默认值回填 + 「搜」/「复位」+ 收窄维度计数行 |
| 11 | `[Mobile-E2E]` | hermetic e2e |
| 12 | `[Contract-Smoke]` | 契约冒烟扩到新参数与新字段 |
| 13 | `[Gate]` | 标定七项 + 写回 spec |

## Out of Scope（本片明确不做）

| 事项 | 去向 |
| --- | --- |
| 列改版 / 表达层截断 N / 每视角独立请求 / 预热 | `053` |
| 标的链分析报表 | `054` |
| 加权评分 · 重排层 · 多路召回实体化 · 特征下沉检索层 · 换存储 | 不做（理由见 ADR-0064） |
| `045` 锚派生与意图矩阵 · 046 版式 · `049` 横滑范式 | 不动 |
| 跨标的聚合视图（`048`） | 冻结 |

## Complexity Tracking

> 无 Constitution 违反，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| N/A | N/A | N/A |
