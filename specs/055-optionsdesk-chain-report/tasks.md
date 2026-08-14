---
feature_id: 055-optionsdesk-chain-report
spec_ref: ./spec.md
plan_ref: ./plan.md
status: in-progress
created_at: '2026-08-14'
updated_at: '2026-08-14'
---

# Tasks: 标的链分析报表

## Format

`- [ ] T0NN [层级] **标题**（FR / SC / plan 决策锚）：做什么。→ verify: 怎么验`

层级 = `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]` / `[Verify]`。
状态语义：`- [ ]` pending · `- [X]` done（由 `/speckit-implement` 走完六步闭环后翻）。

测试**不单列 task** —— 每个 task 内走红→绿→typecheck/lint→`[X]`→stage→commit（Constitution §II + `implement-task-closure`）。
verify 里的 **Small / IT / e2e** 是测试 size（`docs/conventions/testing.md` 的二维分类学），决定后缀与要不要起容器。

## 🚨 `state_branches` 的落层裁定（先读这条，否则会去补不可能的测试）

24 条分支按**谁有能力判**分三层，🚫 别在错的层上补测试：

| 落层                      | 分支                                                             | 为什么只能在这层                                                                    |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **服务端 IT**（真 PG）    | 1 · 2(数据面) · 4 · 7 · 8 · 9 · 10 · 11 · 12 · 13 · 19 · 20 · 21 | 它们是**数据形态**决定的：格值成员集、三计数、插值可不可得、时点归属、锚状态        |
| **mobile hermetic e2e**   | 2(呈现面) · 3 · 4 · 5 · 6 · 7 · 8 · 14 · 15 · 18 · 22 · 23 · 24  | 它们是**呈现与路由**决定的：淡出、不着色、降级屏、入口可达性、下钻落点              |
| 🚨 **真机（web 验不到）** | **16 · 17**                                                      | 横滑 clamp 的几何与「长按 vs 横滑」的手势归属 —— Expo Web 下 `Pan` 需走原始指针事件 |

⚠️ 另有**三类**在任何自动化层都验不到，归 T021 真机目视：一屏可见的**真机几何**（web 185 vs 真机 161dp，差约 13%）、**色阶档在真机屏上的可分辨性**、手势竞争的**手感**。

## Path Conventions

| 面            | 路径                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Server 纯函数 | `apps/server/src/optionsdesk/chain-report.rules.ts`                                               |
| Server 编排   | `apps/server/src/optionsdesk/get-chain-report.usecase.ts`                                         |
| Server 契约   | `apps/server/src/optionsdesk/optionsdesk.{controller,dto,module}.ts`                              |
| Server IT     | `apps/server/src/optionsdesk/optionsdesk-055.chain-report.it.spec.ts`                             |
| Mobile 纯函数 | `apps/mobile/src/optionsdesk/chain-report-scale.rules.ts`                                         |
| Mobile 屏     | `apps/mobile/src/optionsdesk/chain-report-*.tsx` + `use-chain-report.ts` + `chain-report-copy.ts` |
| Mobile 路由   | `apps/mobile/app/(app)/optionsdesk/chain-report/[symbol].tsx`                                     |
| E2E           | `apps/mobile/e2e/optionsdesk-chain-report.spec.ts`                                                |
| 契约冒烟      | `apps/mobile/e2e/contract-smoke/optionsdesk-chain-report.contract.ts`                             |

## 🚨 Impl Guardrails（每条都是盲写会踩、且**踩了不会红**）

1. 🚨 **`candidateCap` MUST 传 `legs.length`** —— 沿用 `RECALL_CANDIDATE_CAP`(3000) 等于给报表塞进 `FR-005` 明令不能有的截断。今天最大链 825 条碰不到 ⇒ 真出问题时网格照常渲染、数字照常有，只是少一批腿（plan `D-RECALL-1`）。
2. 🚨 **骨架 MUST NOT 从三视角 `recallCandidates` 的 `candidates` 取** —— 那个集合是「至少进一个视角」，过了权利金却被**活性门槛**挡下的腿不在其中（实测 `us:ACN` 差 **38 条**），而两种取法**都渲染得出一张完整网格**。<br>✅ **落法已定（T001 实装）**：骨架走**另一次**召回调用 —— 全腿视角 + `livenessMin` 显式覆盖为 `null`（plan `D-RECALL-1`）。🚫 **MUST NOT 改写成在报表侧重判一遍权利金**：`passesPremiumMin(` 在 `leg-recall.rules.ts` 之外是 `check-optionsdesk-rule-constants` 不变量 #7 的硬拦（成员判定单点，052 FR-003）。
3. 🚨 **三计数的求值顺序不可换** —— 在骨架全域上数「被活性挡下」会与「行下界外」重复计 **865 条**（实测全池）。三个数照样都出得来，只是**加不回全量**。求和恒等式 MUST 有断言。
4. 🚨 **色阶档界形态按每种格值各自定** —— 四种套同一种切法时，全腿年化 / 活跃度的最淡档吞掉 **96.8% / 99.2%** 的格（色阶只剩一档在用），而**图照样画得出来**。
5. 🚨 **「口径不适用」判据 MUST 语义化**（`当前格值 = 全腿年化 ∧ 该行价外档下界 < 0`），🚫 MUST NOT 写 `rowIndex === 0` —— 行下界一改就静默错位，而**照样渲染得出一张表**。
6. 🚨 **格态 MUST 随格值重算，MUST NOT 缓存成格的静态属性**（实测全网格填充率 建仓 6.3% / 收租 13.6% / 全腿 41.6%）。
7. 🚨 **列级淡出不能只靠灰底** —— `--nvy-surface-sunken` 与纯白只差约 4% 亮度，40×32 的格子上与「无合约」读起来一样（**本片 mockup 第 2 轮实撞**，六项探测全绿也照不到）。主信号 MUST 是列头「段外」chip。
8. 🚨 **十字线与横滑靠「是否先长按」区分**，🚫 MUST NOT 依据触点坐标分流（`FR-030`，与选约表横滑同一条纪律）。
9. 🚨 **曲线与网格 MUST 同一坐标原点** —— 网格 track 从「首列冻结宽之后」起，曲线若从帧边距起画，第 n 点就不在第 n 列上（**上一轮 mockup 实撞**，六项探测**完全失明**，只有对着 `FR-020` 看图才抓得到）。
10. 🚨 **nullable 小数字段的 `@ApiProperty` 必须显式 `type: 'string'`** —— 否则 orval 误生 objectmap（012 实证）。
11. 🚨 **跨 ctx 读点必须带 `// CROSS-CONTEXT-READ:` 注释** —— `check-server-moat` 探针硬拦；且本片跨 ctx 读**只有 IV 一处**，MUST 复用 046 不新开（plan `D-CTX-1`）。
12. 🚨 **余量判定 MUST 用真机那组读数** —— 049 实测 web 185 vs 真机 161dp，用 web 那组会误判一屏余量。
13. 🚨 **判「无合约」的腿数 MUST 数在整条链上，🚫 MUST NOT 数在骨架上**（T002 实装期新增）—— 骨架已把低于权利金门槛的腿排除（`FR-005`），拿骨架计数会让「有腿但全部太便宜」的格渲染成「该位置无合约」，即 US2 反对的「给出错误信息而不是缺失信息」，而**两种数法都渲染得出一张完整网格**。
14. 🚨 **「次优」的判据是腿数，🚫 不是取值互异**（T002 实装期新增）—— 两条腿读数相等时次优 = 那个相等的值，写成「第二个不同的值」会让它变 `null`，读起来与 `FR-028` 的「格内只有一条腿」**完全同形**，而那两件事的含义相反。

---

## Phase 1: 服务端纯函数层（阻塞其余全部）🎯

- [X] T001 [Server] **价外档分箱 + 行列骨架**（`FR-001`–`FR-003`, `FR-005`, plan `D-AGG-1`）：新建 `chain-report.rules.ts`。价外档等距 10%、下界价内 10%（`FR-002`，🚫 不按分位）；列 = 链上**实际到期日**不分箱（`FR-003`）；骨架走**全腿视角 + `livenessMin` 覆盖为「不限」**的召回调用（`FR-005`，plan `D-RECALL-1` 2026-08-14 订正 —— 原文的 `passesPremiumMin` 直调被守门不变量 #7 硬拦）。每行同时产出**价外档区间与对应行权价区间**（`FR-027` 读数面板要，也是 mobile 侧「口径不适用」语义判据的输入，Guardrail 5）。<br>📌 **行集 8 档由 mockup `ROW_LABELS` 定案**：价内 0-10 一档 + 价外七档，**顶档 `>60%` 开口吸收**——🚫 极深价外腿 MUST NOT 掉出网格，掉出去的腿既不在图上又不在三个互斥计数里，`SC-006` 的求和恒等式会静默对不上账。→ verify: Small —— 档界边界值（恰 0% / 恰 −10% / 恰 10%）落档断言 + 行下界外单独可数 + 🚨 **骨架 ≠ 候选集**的对照断言（构造一条「过权利金但活性不过」的腿，断言它**在骨架内**，Guardrail 2）<br>✅ **已完成**（`chain-report.rules.ts` + `chain-report.rules.spec.ts`，17 断言绿）。🔬 **反例探针已跑**：把骨架改成取三视角 `candidates` 且沿用 `RECALL_CANDIDATE_CAP` ⇒ 「骨架 ≠ 候选集」/「不设上限」/「不排序不截断」**三条当场红**，判别力坐实。`leg-recall.rules.ts` / `leg-derive.rules.ts` `git diff` 零行（`FR-045`）；`check-optionsdesk-rule-constants` 绿。

- [X] T002 [Server] **格聚合 + 格态判定 + 最优/次优**（`FR-006`–`FR-008`, `FR-016`, `FR-016a`, `FR-027`, `FR-028`, plan `D-AGG-1` / `D-STATE-1`）：每格取最优（年化 / 活跃度 `max`，建仓成色 `min`）+ 腿数 + **次优**；格态三值（有值 / 被门槛挡下 / 无合约），其中「被门槛挡下」**归并**权利金门槛与「当前视角不召回」两类成因（`FR-016a` 格级那半）。→ verify: Small —— 🚨 **格内仅 1 条腿时次优显式为 `null`**（`state_branch` 14，🚫 不复述最优）+ 均值 vs 最优的对照（`FR-006` 取最优不取均值）+ 三态各自可判 + 🚨 **格态随格值变**：同一格在两种格值下判出不同态的断言（`state_branch` 2 数据面，Guardrail 6）<br>📌 **实装期补一类归并成因**：`FR-016a` 原列两类，实际有**第三类** —— 腿在召回集内、但该口径**算不出值**（`computeLegRates` 在 `DTE ≤ 0` 或 `K − P ≤ 0` 时返 `null`，而 0DTE 腿在全腿视角是进得来的）。归 `gated` 而非 `absent`：合约确实存在，报「无合约」是错误信息；而 `FR-016a` 🚫 明令不为它单开第四种格级色码 ⇒ 三态之内只有这一个落点，不构成歧义。<br>✅ **已完成**（13 断言，累计 30 绿）。🔬 **反例探针跑了三处**：建仓成色方向踩反 / `chainLegCount` 忽略掉（空值恒判 `absent`）/ 次优写成「第二个不同的值」⇒ 对应 **7 条当场红**。新增 Guardrail 13 · 14。

- [X] T003 [Server] **三互斥计数 + 求和恒等式**（`FR-034`, `SC-006`, `state_branch` 9, plan `D-AGG-1`）：按**骨架语义顺序**求值——全量 → 权利金挡下 → 骨架 → 行下界外 → 行内 → 活性挡下 → 有值。每个计数带自己的分母。→ verify: Small —— 🚨 **求和恒等式**：三计数 + 有值 ≡ 该链全量（实测锚 `252 + 261 + 38 + 274 = 825`，⚠️ 这是 **`us:ACN` 单链**样本；`SC-006` 里那组 `952 + 1485 + 120 + 974 = 3531` 是**全池 12 链**，两组都对但口径不同，别拿一组去对另一组）+ 🔬 **反例探针**：把「活性挡下」改成在骨架全域上数，该断言**必须当场红**（Guardrail 3 —— 不红就说明断言没有判别力）<br>✅ **已完成**（7 断言，累计 37 绿）。<br>🚨 **探针实测推翻了本行原本的验收设计，必须读**：实装用逐级 `continue`（每条腿只落一个桶）⇒ **求和恒等式对该形态是结构性恒真**。把 ③ 与 ② 的判定**对调**后跑，恒等式**照样绿**，红的只有**归属**断言（「深价内 ∧ 无人碰过」的腿该计入 ② 而非 ③，实测 865 条正是这一类）。<br>⇒ 恒等式是**防未来重写**的回归网（谁改成四个独立 `filter().length` 就会破），**不是**本实现的主判据；主判据 MUST 是归属断言。**T007 的 IT 同此纪律**——只复现恒等式会得到一个恒绿的假证据。

- [X] T004 [Server] **ATM IV 线性插值 + 断点**（`FR-020`–`FR-024`, `state_branch` 12/13, plan `D-AGG-1`）：跨 spot 两侧相邻 strike 线性插值（`FR-022`）；缺任一侧 ⇒ 返 `null`（`FR-023` 曲线断开）。🚫 MUST NOT 回落最近档。⚠️ `iv` 列**已是百分数**原样存（`schema.prisma` 注释明写），🚫 不再 ×100。→ verify: Small —— 插值 vs「取最近档」的对照（`FR-022` 判据来源：中位差可忽略但**最大差 17.21 点**，而典型波动率仅 20–40 点）+ 单侧缺失 → `null` + 🚨 **greeks 缺失只影响曲线**：同一批数据下四种格值照常算出（`state_branch` 13）<br>✅ **已完成**（9 断言，累计 46 绿）。🔬 **反例探针**：把实现整个换成 `FR-022` 明令禁止的「取最近档」⇒ **5 条当场红**，含 `FR-023`「只有一侧有档 MUST 断点、不得回落」那条。<br>📌 两处实装期定的边界：① **行权价恰落在现价上 ⇒ 直接返回该腿 iv**（插值的精确解，非「回落最近档」；顺带守住除零）；② **`iv` 为 `null` 的腿整条不参与**，跳过它取更外侧那一档 —— 它不是「两侧之一」。<br>🚨 **给 T005 的接线缺口（本 task 查出）**：`LegChainRow` 上**没有 `iv` 字段**（只有 `delta` / `greeksComplete`）⇒ 曲线取不到数。MUST 在 T005/T006 给 port 补 `readonly iv: number \| null`（沿 `delta` 的 `number` 先例，`FR-031` 存储词表不受影响），🚫 别为它另开第二条读链路（plan `D-CTX-1`）。

## Phase 2: 服务端编排 + 契约

- [X] T005 [Server] **`get-chain-report.usecase.ts` 编排**（`FR-005`, `FR-010`, `FR-011`, `FR-012`, `FR-013`, `FR-014`, `FR-031`, `FR-033`, plan `D-API-2` / `D-RECALL-1` / `D-CTX-1`）—— 🚨 四种格值的**口径同源**落在本 task：建仓成色走 `computeEffectiveCostVsWPct`（`FR-011`）、两种年化走 `computeLegRates`（`FR-012`）、活跃度走 `activityVolume`（`FR-013`），三者**全部复用 `leg-derive.rules.ts` 既有导出，🚫 MUST NOT 另算一份**：走 `leg-retrieval.port` 取链 → `chainReportSkeleton(ctx, legs)` 拿骨架（T001 已实装，内部是全腿视角 + 活性覆盖那一次召回）→ `recallCandidates(ctx, ['all','build','rent'], legs, **legs.length**, null)` 拿三视角归属（**第二次**调用，与骨架那次口径不同，🚫 别合并）→ 四种格值**一次求值**（`D-API-2`，🚫 不拆四次）→ 聚合。链级 IV 分位**复用 046 的 `UnderlyingIvReadout` 四态**（`FR-031`），跨 ctx 读点带 `// CROSS-CONTEXT-READ:`（Guardrail 11）。三个业务日时点各自下发（`FR-033`），活跃度时点跟 `oiAsOf`（`FR-014`）。→ verify: Small（假 port 驱动）—— 🚨 **一条断言钉死「不设上限」**：构造 > `RECALL_CANDIDATE_CAP` 条腿，断言零条被切（Guardrail 1，🚫 没有这条断言那条纪律就没有机器兜底）+ 四种格值同一骨架（行列集合逐格相等，`SC-002` 的服务端一半）+ IV 四态各自返回（`state_branch` 18）+ 🚫 `git diff` 核实 `leg-recall.rules.ts` / `leg-derive.rules.ts` **零行**（`FR-045`）<br>✅ **已完成**（19 断言）。🔬 **反例探针三处**：沿用 `RECALL_CANDIDATE_CAP` / 格分母数在骨架上 / 平值 IV 拿骨架插值 ⇒ **各自对应的 3 条当场红**。<br><br>🚨 **本 task 实装期补了一处 port 扩展（plan / tasks 都没预见）**：`retrieveCandidates` **结构上给不回全量腿** —— 候选集的成员判据是「至少进一个视角」，而报表两处都要被挡下的腿（骨架含被活性挡下的；格态要分「无合约」与「有腿但太便宜」）。⇒ 给 `LegRetrievalPort` **加第二个方法 `retrieveChain(query)`** 返回整条链（+ `LegChainRow.iv`，T004 查出的曲线缺口一并补上）。<br>📌 **不是第二条读链路**（plan `D-CTX-1`）：同一个 port、同一个实现、同一批查询，adapter 内抽出 `loadChain` 给两个方法共用 ⇒「候选集与整条链读的是同一批行」成结构保证。`retrieveCandidates` **签名与行为一字未动** ⇒ `SC-008` 结构性成立，另有 `get-legs.usecase.spec`（全套 4220 绿）+ `optionsdesk-053.query.it.spec`（真 PG 16 绿）双重实证。<br>⚠️ **踩到一处 mock 工厂**：`get-legs.usecase.spec` 的 snapshot 工厂少 `iv` ⇒ adapter 取值时炸 ⇒ 被 use case 的降级 `try/catch` 兜成 `read_failed` + 空表（一屏「正常的空」，完全不像少了一列）。已补。<br><br>📌 **另外三处实装期决定**：① IV 分位走**注入 `GetUnderlyingDetailUseCase`** 并调 `execute()` —— 锚 / IV 四态 / 最近已收盘交易日一次拿全，且 404 行为直接继承，字面满足 `D-CTX-1`「复用 046 已有读点不新开」；② 新增 `CHAIN_REPORT_METRIC_TAB`（格值 → 召回视角）**只住服务端**，列上下发 `inRecallBand: Record<格值, boolean>` 一个字段同时服务 `FR-009` 两条范围框与 `FR-009a` 整列淡出 ⇒ 客户端不做这个映射（两处各写一份会出现「格有值但整列淡出」，而两边都渲染得出来）；③ 新增一条**前提守卫**断言：全腿视角的系统默认值**只有权利金与活性两维非空** —— 骨架覆盖法（T001）与「进得了全腿 ⇔ 过了两道一律门槛」（本 task）都吃这条，将来给全腿加第七维而不回来改，骨架会**静默变小**。<br><br>🚨 **留给 T006 的两项**（本 task 蓄意不做）：spec `Key Entities` ② 列出的**月度标**与**是否跨财报**。前者要把 `get-legs.usecase` 的私有 `readMonthlyExpiries` 提成共享 helper（🚫 别复制一份查询）；后者**判据未定**，见 T006 的开放问题登记。

- [X] T006 [Server] **controller + DTO + swagger**（`FR-040`, plan `D-API-1` / `D-BAND-1`）：新增 `GET v1/optionsdesk/underlyings/:symbol/chain-report`，落既有 `@Controller('v1/optionsdesk')`。DTO **四段齐全**，逐段对应 spec `Key Entities` 的四项：<br>① **每格** = 值 / 腿数 / 次优 / 格态<br>② **每列** = 到期日 / DTE / 月度标 / 财报标 / 各视角召回段覆盖 / 该列 ATM IV<br>🚨 **前四项里有两项还没落**（T005 蓄意留下）：**月度标** MUST 把 `get-legs.usecase` 的私有 `readMonthlyExpiries` 提成共享 helper 后复用，🚫 不复制第二份查询。**财报标判据未定** —— 见下方开放问题。<br>📌 「各视角召回段覆盖」已由 T005 落成 `inRecallBand: Record<格值, boolean>`（一个字段同时服务 `FR-009` 与 `FR-009a`），DTO 原样映射即可。<br>③ **每行** = 价外档区间 + 对应行权价区间<br>④ 🚨 **链级读数** = IV 分位与其状态 · **现价 `spot`** · 三个业务日时点 · 三个互斥计数 —— **这一段最容易漏**（它不属于任何一个格 / 列 / 行，而页头要显示现价与三时点、页脚要显示三计数）。<br>🚫 **DTO 不含 `band`**（色阶住 client，plan `D-BAND-1`）。→ verify: IT —— 端点 200 + 响应形状 + 🚨 **四段逐段断言存在**（尤其 `spot` 非空，`Key Entities` 第四项的机器兜底）+ 🚨 nullable 小数字段 `@ApiProperty` 显式 `type: 'string'`（Guardrail 10）+ `rg 'band' apps/server/src/optionsdesk/optionsdesk.dto.ts` 在本片新增段**零命中** + `check-api-property-nullable` 过<br>✅ **已完成**（分两个 commit：T006a 月度标共享 helper / T006b controller + DTO + swagger）。端点 `GET v1/optionsdesk/underlyings/:symbol/chain-report`，**零查询参数**（报表不排序不截断无可调条件，加「只要某种格值」的参数等于把 `SC-002` 的「切换不发请求」交回调用方自觉）。<br>📌 **「零 `band` 字段」改成比 grep 更强的断言**：`JSON.stringify(响应)` 不含 `"band"` / `"bands"` 独立键名 —— 裸 `rg 'band'` 会被 `inRecallBand`（召回段覆盖，不是色阶档）误伤，而它大小写恰好躲过；靠大小写巧合成立的判据不算判据。<br>📌 **格值读数的量纲随格值变**（建仓成色百分数 / 两种年化小数比例 / 活跃度张数）⇒ 一律定标 **6 位**，量纲写在所属网格的 swagger 描述上。<br>⚠️ **踩到一次守门撞值**：`otmCeiling` 的 swagger 示例串 `'0.2000'` 含子串 `0.20` = 权利金绝对下限的字面量 ⇒ `check-optionsdesk-rule-constants` 判成阈值外溢（那道守门**认值不认名**，示例串也在扫描面内）。撞的是示例不是语义 ⇒ 改示例（整类改用「价外 30–40%」那一档），🚫 不放宽守门。

- [X] T007 [Server] **IT：服务端侧 state branch 全覆盖**（`state_branch` 1/2/4/7/8/9/10/11/12/13/19/20/21, `SC-002`, `SC-006`）：新建 `optionsdesk-055.chain-report.it.spec.ts`（Testcontainers 真 PG）。覆盖落层裁定表「服务端 IT」那 13 条。⚠️ **13 条分支单 task 可能超 Constitution §III 的 2h 上限**（053 T005 覆盖 12 条有先例）—— 真超时按分支组拆两个 commit，🚫 但**不拆成两个 task**（拆了会让「13 条全覆盖」这个验收面散在两处）。→ verify: IT —— 单列链（`state_branch` 10）/ 单行链（11）/ 零非空格（4）/ 无快照（7）/ 全被挡下（8）/ spot 缺失（20）/ 锚 excluded（21）各自一个 `it()` + 🚨 **三计数在真数据上的复现 MUST 验「归属」而非只验恒等式**（9）—— T003 探针实证恒等式对现实现**结构性恒真**，只断言它等于拿到一个恒绿的假证据；真判据 = 找出「深价内 ∧ 无人碰过」的腿并断言它计入 ② 不计入 ③ + `oiAsOf ≠ quoteAsOf` 时活跃度时点跟前者（19）<br>✅ **已完成**（16 个 `it()`，13 条服务端分支 + `SC-002` / `SC-006` / IV 四态 / 未建锚 404）。单文件未超 2h，🚫 未拆 commit。<br>🔬 **反例探针两处，各自被对应断言逮住**：① 三计数的 ②③ 判定**对调** ⇒ **只有归属断言红，恒等式照样绿** —— T003 那条发现在 IT 层如实复现，专门种的 `L-H`（深价内 ∧ 无人碰过）就是它的靶子；② 列轴改回取骨架 ⇒ `state_branch` 8 当场红。<br><br>🚨 **本 task 造 fixture 时推翻了 T005 的一处读法**：`state_branch` 8 与 mockup「降级五态」第二帧要求「全被权利金挡下」时**整张网格照常渲染、每格呈斜线 + 三计数**（原话：否则「全是斜线」看起来像坏了）。而 T005 把**列轴取自骨架** ⇒ 那种链骨架为空 ⇒ 零列 ⇒ 什么都渲染不出来。<br>⇒ 列轴改取**整条链上实际存在的到期日**（`FR-001` 原文即「列为链上**实际存在的**到期日」）。📌 与 `FR-005` 不冲突：那条管的是**哪些腿算总体**（不按视角期限段裁、不套条数截断），不是列轴取谁；格的「无合约 vs 有腿但太便宜」同样要整条链才分得出（Guardrail 13 已立）。已补两条 Small 断言 + 一条 IT 断言。

- [X] T008 [Contract] **`export-openapi` + api-client regen**（Constitution §V）：`nx run server:export-openapi` + `nx affected -t generate`。→ verify: `openapi.json` 新增 schema 逐项比对（**本片是纯增量，MUST 无删除项**）+ `nx run-many -t build,lint -p server api-client` 绿 + `check-contract-smoke-drift` 过<br>✅ **已完成**。**纯增量实测：7 schema + 1 path，删除项 0**（`ChainReport{Response,GridsResponse,CellResponse,ColumnResponse,RowResponse,GateCountsResponse,BandCoverageResponse}` + `/api/v1/optionsdesk/underlyings/{symbol}/chain-report`；比对脚本按 schema/path 键集做集合差，🚫 不靠肉眼读 diff）。<br>📌 **两处生成结果逐个核过，都没退化**：① nullable 标量落成 `string \| null` / `number \| null`，**不是** orval 的 `{ [k]: unknown } \| null`（Guardrail 10 / 012 实证的那个坑）；② 二维网格落成 `ChainReportCellResponse[][]` —— `getSchemaPath` + `@ApiExtraModels` 那条路子在 orval 侧成立。<br>⚠️ **`check-contract-smoke-drift` 是 echo-only 告警而非阻断**：它提示 optionsdesk 的三个既有 contract-smoke spec 未随本 PR 更新。本片对 `retrieveCandidates` 零改动 ⇒ 那三个 spec 的断言面不受影响；055 自己的契约冒烟归 **T019**，🚫 不在这里提前补。<br>📌 `nx typecheck mobile` 顺带跑绿 —— api-client 是纯增量，消费方结构上不会坏，但这条是 B3 起手的前置基线。

## Phase 3: Mobile 呈现层（US1 主体）

- [X] T009 [Mobile] **`chain-report-scale.rules.ts` 色阶 + 口径不适用**（`FR-019`–`FR-019c`, `SC-012`, `SC-013`, `state_branch` 5, plan `D-BAND-1` / `D-SCALE-1`）：四种格值**各自形态**的档界常量（占位，取值归 T020）+ 判档纯函数 + 「口径不适用」**语义**判据。🚫 单向色阶（`FR-019`）、🚫 缺失态不用第二色相（`FR-018`）。→ verify: Small —— 🚨 `SC-012`「任一档不吞过半的非空格」落成断言（🔬 **反例探针**：把四种格值都换成线性等距，断言必须红 —— 实测最淡档会到 96.8% / 99.2%，Guardrail 4）+ 🚨 **口径不适用按语义判**：构造一个行下界为 0% 的行集，断言豁免行**随之改变**（Guardrail 5，🚫 写死下标的实现过不了这条）<br>✅ **已完成**（`chain-report-scale.rules.ts` + `.spec.ts`，28 断言绿；mobile 全套 1559 绿 / lint 0 error / typecheck 绿）。形态定案 **linear / quantile / quantile / log**，四组取值全部标 `🚧 PLACEHOLDER(T020)`（4 处可 grep，T020 的「占位标记扫零命中」用它）。`check-optionsdesk-rule-constants`（`D-BAND-1` 点名的 mobile 那一臂）+ `check-test-size` 均绿。<br>🔬 **反例探针跑了三处，各自被对应断言逮住**：① 四种档界全换成线性等距 ⇒ `SC-012` 在**收租 / 全腿 / 活跃度**三条当场红（建仓仍绿是**预期** —— 它本就是 linear 形态，探针对它无效不是漏网）；② 判据换成写死当前行轴取值（与写死 `rowIndex` 同类）⇒ 语义那两条红；③ 建仓成色方向踩反 ⇒「越低越好」那条红。<br>📌 **实装期三处决定**：① `form`（`linear` / `quantile` / `log`）落成**字段**而非注释 —— T020 按各自形态取数，形态是 `FR-019b` 的可执行部分；② 判档返回 `ChainReportBand \| null`（非有限值判不了档就不判，🚫 不编一个档出来），并加**三出口**的 `chainReportCellShade`（`band` / `inapplicable` / `unscaled`）—— 让 T011 / T012 不各自组合一遍，Guardrail 5 只留一个落点；③ 行下界**解析不出来时也算「不适用」**（fail-closed：宁可少上一格颜色，也不给一行由内在价值撑起来的假梯度）。键面 `ChainReportMetric = keyof ChainReportGridsResponse` ⇒ server 改网格键名这里 typecheck 红。<br>🚨 **`SC-012` 的样本是合成的，T020 MUST 替换**：验它需要一个分布，而真分布归 T020。合成样本的形态参数逐条取自 `FR-019b` 实测，并落了两条**保真度断言**钉住形状（收租线性最淡档 52.5% vs 实测 52.4%；活跃度 99.0% vs 实测 99.2%）。⚠️ **全腿年化那条是假设不是实测** —— 96.8% 是**含价内行**测出来的，而 `FR-019c` 已把该行移出色阶，排除之后本片没有实测值，样本偏度（`u^3`）属推定。<br>🔧 **T011 起手订正一处（同分支后续 commit）**：建仓成色的值域**跨零**，起手写成 `[-50, 0]` 是错的 —— 建仓视角的硬门槛是「有效成本 `K − bid` **< spot**」而非「< W」⇒ 上界 = `(spot − W) / W`（mockup 的 ACN = **+28%**，格值实测正是 `+27 / +21 / +3`）。压在负半轴的档界会让**整片建仓格塌进最淡档**，而网格照样画得出来。已改样本值域为 `[-60, +28]`、占位档界为 `[-42, -25, -7, 10]`（占比 8.4 / 23.2 / 36.8 / 23.2 / 8.4）。

- [X] T010 [Mobile] **取数 hook + 屏骨架 + 页头**（`FR-031`, `FR-033`, `FR-040`, `FR-041`, `state_branch` 18/22, plan `D-UI-1` / `D-UI-3`）：新建路由 `chain-report/[symbol].tsx` 落 optionsdesk 二级页栈（合规 guard 自动继承，`SC-009`，🚫 不另写判定）；`use-chain-report.ts` 取数；页头 = IV 分位四态 + 三时点各自成句（`FR-033`，🚫 不合并成一个「数据截至」）+ 锚 excluded 标记。→ verify: Small（logic-only）—— 四态各自的文案分支 + 🚫 **禁回落 0** 的断言（`state_branch` 18）+ `nx typecheck mobile` 绿<br>✅ **已完成**（`chain-report-copy.{ts,spec.ts}` 17 断言 + `optionsdesk-routes.spec.ts` 补 2 条；mobile 全套 **1578 绿** / lint 0 error / typecheck 绿）。落地 5 个文件：路由 `app/(app)/optionsdesk/chain-report/[symbol].tsx`（薄）· `chain-report-screen.tsx`（容器 + 页头）· `use-chain-report.ts` · `chain-report-copy.ts`（合成层）· `OPTIONSDESK_COPY.chainReport`（字串）。<br>🔬 **反例探针两处**：① 页头层给分位兜 `?? 0` ⇒ 「禁回落 0」三条 + 「解析不出退分位不可算」当场红；② 三时点「顺手」去重 ⇒ 「同日仍三条」与「缺失仍三条」当场红。<br>📌 **实装期四处决定**：① Path Conventions 的 `chain-report-copy.ts` 落成**映射层**而非第二份字串源 —— 字串仍进 `OPTIONSDESK_COPY.chainReport`（体例同 047 `leg-picker-copy.ts`，copy 单源不分叉）；② **IVP 显示口径继承 046 的整数位**，mockup 画的 `58.4` 一位小数**蓄意没照抄** —— `FR-031` 明令复用既有读数、🚫 不新造，两屏同一个数显示位数不同才是真 drift；③ `_layout.tsx` **不加条目**：`MarketsRouteGuard` 包的是整个 `Stack` ⇒ 新路由自动继承（`SC-009` 结构性成立），而 `headerLeft` 由屏内设（web 硬刷新回落到**该标的详情**，报表入口就在那儿，比回落雷达 tab 准）；④ 页头三时点用 `MM-DD` 短日期（`FR-041` 版面预算），🚫 **本屏不碰本地时钟** —— 三个业务日全由 server 下发。<br>⚠️ **本 task 只落 loading / 取数失败两个最小分支**，五种降级态归 T017；网格 / 切换 / 曲线的空位在 `chain-report-screen.tsx` 里逐个注了归属 task。

- [X] T011 [Mobile] **网格 + 冻结列 + 横滑 + 段外列淡出**（`FR-004`, `FR-007`, `FR-009`, `FR-009a`, `state_branch` 3, plan `D-UI-2`）：复用 ADR-0063 范式（单 Pan 驱动 shared value + counter-translate 冻结列 + clamp + `withDecay` + 指示条），🚫 **MUST NOT 另立第二套**（`FR-004`）。召回段范围框**恒显两段**、重叠列两框并存（`FR-009`）；段外列整列淡出 —— 🚨 **主信号是列头「段外」chip**，灰底只是辅（Guardrail 7）。格内腿数角标恒可见且**与格值同色**（`FR-007`，只靠字号分主次）。→ verify: Small —— 淡出与「被门槛挡下」两种编码**不同码**的断言（`FR-009a`）+ 单到期日链时指示条整条不渲染（`state_branch` 10 的呈现面）+ 🚫 段外列**仍参与列数**的断言（淡出不是裁剪）<br>✅ **已完成**（`chain-report-grid.rules.{ts,spec.ts}` 19 断言 + `chain-report-grid.tsx` + 屏级横滑接线；chain-report 四个 spec 累计 **64 绿**，mobile 全套 **1597 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针两处**：① 段外不单独编码、落回格级「被挡下」⇒ `FR-009a` 那两条当场红；② 指示条恒渲染 ⇒ `state_branch` 10 的「单列不溢出」与「首帧宽 0」两条当场红。<br>📌 **实装期六处决定**：① 横滑**整套复用 049**（`useLegColumnPan` / `clampLegColumnTx` / `LegColumnPane` / `LegColumnScrollbar`），只给指示条**加两个可选 prop**（`stickyWidth` / `testID`）—— 参数化而不是复制第二份（`FR-004`；那个文件头本来就写着「宽度走 prop、不写死成模块常量」）；② **RN 无 CSS 斜纹** ⇒「被门槛挡下」改成格内字形 `╱` + `surface-alt` 底，两条都不是色相（守住 `FR-018`），真机可分辨性归 T021；③ **RN 无 per-side `borderStyle`** ⇒「口径不适用」不画虚线下边界，保留 mockup 另两道冗余信号（**格内有数字** + 行标 `†`），且 `†` 与「不着色」**共用同一个判据**（两处各判一次必错开，那时行标打了记号而格照样着色）；④ 范围框图例**只给段名、🚫 不复述 DTE 天数** —— 那两个区间是 server 召回常量，抄到客户端就是第二份阈值（052 FR-011 守门扫的正是这个）；⑤ mockup 的 `--nvy-secondary` 在 RN 侧**无对应 token** ⇒ 收租段范围框取既有 `tag-teal`（`FR-043` 不为本片新增 token）；⑥ 指示条「渲不渲染」要 JS 侧宽度，而 clamp 要 worklet 侧宽度 ⇒ 屏级同时持 `SharedValue` 与 `useState`，**两者同源自一次 `onLayout`**（不是两个数据源）。<br>⚠️ **「段外列仍参与列数」这条在单测层是结构性的**（`map` 保长，写不出会红的实现）—— 真牙齿在 **T018 e2e 数屏上列数** 与 **T013 的 `SC-005`「点数 ≡ 列数」**，本条只钉住意图。

- [X] T012 [Mobile] **四种格值切换 + 格态渲染 + 页脚三计数**（`FR-010`, `FR-016`–`FR-018`, `FR-034`, `SC-002`, `SC-003`, `state_branch` 2/9/19, plan `D-STATE-1`）：四选一 seg；切换 MUST 保持**行列位置逐格不变**而**格态随之重算**（`FR-010` ⚠️ 两者不是一回事）。三态视觉可分且**不依赖图例**（`FR-017`）。页脚三个互斥计数**各带分母**（`FR-034`）。活跃度格值的时点跟 `oiAsOf`（`FR-014`）。→ verify: Small —— 切换前后行列集合逐格相等而格态集合**不等**的对照断言（`SC-002`，Guardrail 6）+ 三计数与有值相加 = 全量（`SC-006` 的客户端一半）<br>✅ **已完成**（`chain-report-metric-tabs.tsx` + 页脚 / 读法行接线；网格与页头两个 spec 各补一段，chain-report 四个 spec 累计 **73 绿**，mobile 全套 **1606 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针三处**：① 网格骨架改成从 `cells` 取维度（而非行列轴）⇒ 「维度与行列轴恒等」当场红；② 求和恒等式不成立也照印 ⇒ 「对不上账整句不显示」当场红；③ 活跃度时点改用区块级 `asOf` ⇒ `FR-014` 那条当场红。<br>📌 **实装期四处决定**：① 逐格呈现收敛到**一个纯函数入口** `chainReportGridView(metric, rows, columnViews, cells)` —— 组件与单测走同一份，`SC-002` 断言验的才是屏上真渲染的那份（原先组件自己在 JSX 里逐格算，测不到）；② 骨架维度**取自行列轴而非 `cells`**，`cells` 缺格按「无合约」兜（契约异常不该让网格错位或崩）；③ 求和恒等式那句在**对不上账时整句不显示** —— 三个计数照常各自显示，少的只是总结句，🚫 不用界面替错数背书；④ 四选一沿 049 `leg-picker-tabs` 的**双重编码**（底色 + 底部短横条）：`react-native-web` 不认 `accessibilityState`，e2e 只能靠样式自比较断选中态。<br>⚠️ **`FR-017`「三态不依赖图例可分」在单测层只到「不同码」**（容器 class 两两不同 + 格内标记有无）—— 真机可分辨性归 **T021**，e2e 数码归 T018。

## Phase 4: 曲线与十字线（US3）

- [X] T013 [Mobile] **IV 期限结构曲线**（`FR-020`–`FR-023`, `SC-005`, `state_branch` 12, plan `D-UI-3`）：`react-native-svg`（**已装**，🚫 不引新库）。点数 ≡ 列数且逐列对齐；横轴按**列序等距**（`FR-021`，🚫 不按天数等距）；插值不可得的点断开（`FR-023`）。🚨 **曲线原点 MUST 与网格 track 同源**（Guardrail 9）。→ verify: Small —— 🚨 `SC-005`「点数与列数**恒等**」落成断言 + 第 n 点的 x ≡ 第 n 列中心（🔬 **反例探针**：把曲线原点改回帧边距，断言必须红 —— 这正是上一轮 mockup 实撞、六项探测全绿也没抓到的那个）+ 断点不以任何形式填充<br>✅ **已完成**（`chain-report-curve.rules.{ts,spec.ts}` 11 断言 + `chain-report-curve.tsx`；mobile 全套 **1617 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针两处**：① 给 x 加回「帧边距」偏移 ⇒ 「第 n 点 ≡ 第 n 列中心」当场红；② 断点不切段（跨断点连线）⇒ 「断点把连线切成两段」当场红。<br>📌 **实装期三处决定**：① **Guardrail 9 落成结构性保证而不是两处对齐** —— 曲线与网格列区挂在**同一个** `LegColumnPane` 位移下，曲线的 x 空间**就是** track 局部坐标（`0` = 首列左缘）⇒ 横滑时两者同进同退，且「原点不同源」这个 bug 在结构上写不出来；断言那条蓄意**不调** `chainReportColumnCenterX` 算期望值（调了就会跟着偏移一起绿），直接用列宽写死；② **断点 = 连线切段**，不是只把 y 置空 —— 只置空仍连成一条，屏幕上看不出区别，而那正是「读到一条连续的期限结构、其中一段是编的」；③ y 轴按**本链自身**取值域拉伸（曲线答的是「这条链的期限结构长什么样」不是跨链比大小），取值全相同时落中线、🚫 不除零。<br>⚠️ **`FR-024`「greeks 缺失只影响曲线」的另一半在服务端**（T004 / T007 已覆盖）；客户端这侧只保证断点不传染 —— 一个点定不出来时其余点与四种格值照常。

- [X] T014 [Mobile] **十字线手势 + 读数面板**（`FR-025`, `FR-026`, `FR-027`, `FR-028`, `FR-029`, `FR-030`, `SC-004`, `state_branch` 14/15/17, plan `D-UI-2`）：长按进入 / 拖动移动 / 松手退出；竖线**同时**落在网格某列与曲线某点（`FR-026`）。读数面板给到期日 · DTE · 价外档与行权价区间 · 腿数 · 最优 · **次优**（`FR-027`）。🚨 与横滑靠「**是否先长按**」区分（Guardrail 8）。→ verify: Small —— 次优为 `null` 时显式呈「无」而非复述最优（`state_branch` 14）+ 拖到空格时给出**为空的原因**（真无合约 / 被门槛挡下，`state_branch` 15，🚫 不停留在上一格）+ ⚠️ **手势归属归 T021 真机**（e2e 验不到，落层裁定表）<br>✅ **已完成**（`chain-report-crosshair.rules.{ts,spec.ts}` 13 断言 + `chain-report-readout.tsx` + 网格 / 曲线 / 屏三处接线；chain-report 六个 spec 累计 **97 绿**，mobile 全套 **1630 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针三处**：① 次优为空时复述最优 ⇒ `FR-028` 那条当场红；② 空格不给原因 ⇒ 「三种空原因两两不同」当场红；③ 命中忽略横滑位移 ⇒ 「触点 x → 列序（含横滑位移）」当场红。<br>📌 **实装期四处决定**：① **`FR-030` 落成 RNGH 的 `Gesture.Pan().activateAfterLongPress(300)` + `Gesture.Exclusive(十字线, 横滑)`** —— 判据是**时间**不是坐标，「按住够久」这件事在 API 层就表达完了，命中函数里因此**一行坐标分流都没有**；② **触点 → 行列要两个偏移**：x 减「外边距 + 冻结列 + `tx`」，y 减「网格体首行顶缘」，后者由**两级 `onLayout` 实测**（曲线高度 / 列头行高都会变，凑常量会整体错一行且线照样画得出来）；外边距取 `spacing.md` 而**不是**写死 16（与屏上的 `px-md` 同源）；③ **`FR-026` 的两半都落地**：竖线画在**列区之内**（与列同位移、与曲线同原点）+ 曲线上该点加粗 —— 只画竖线的话「落在曲线某点」在图上看不见；④ **十字线激活时读法行与恒等式让位给读数面板**（mockup 帧 ⑤ 即如此）—— `FR-041` 一屏预算下多出来的那块高度必须从别处让，🚫 不让网格纵向滚。<br>⚠️ **手势竞争的真实手感只有真机能判**（Expo Web 下 `Pan` 走原始指针事件）⇒ `state_branch` 17 归 **T021**；e2e 只验状态面。

## Phase 5: 入口与下钻（US4）

- [X] T015 [Mobile] **详情屏入口行**（`FR-035`–`FR-037a`, `state_branch` 6）：入口落 046 三块**之后**、选约区块**之前**（`FR-035`）；🚫 不进吸顶区（`FR-036`）；措辞 🚫 不与温度计入口重复（`FR-037`，046 已占用「全景」）；🚨 **未建锚时整行不出现且报表不可达（含深链）**（`FR-037a`）。→ verify: Small + e2e 前置 —— 入口位置断言 + 🚨 未建锚时深链**被拦**（`state_branch` 6，🚫 MUST NOT 做成「缺一角的报表」）<br>✅ **已完成**（`chain-report-entry.rules.{ts,spec.ts}` 15 断言 + 详情屏入口行 + 报表屏深链闸；chain-report 六个 spec 累计 **112 绿**，mobile 全套 **1644 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针三处**：① 入口改成 fail-open（`unknown` 也给）⇒ 「不知道也不出现」+ 两条不对称断言当场红；② 深链闸改成 fail-closed（`unknown` 也拦）⇒ 「不知道不拦」+ 同两条红；③ `entryTitle` 改成「全景 ›」⇒ `FR-037` 两条红。<br>📌 **实装期三处决定**：① **`FR-037a` 的两半合成一份判据** `chainReportAnchorPresence`（三值 `present / absent / unknown`）—— 入口与深链闸各判一次必漂移，而漂移出来的两种形态恰是 `FR-037a` 明禁的（入口通往进不去的屏 / 深链直达缺一角的报表）；② 🚨 **两处在 `unknown` 上蓄意不对称**：入口 **fail-closed**（不确定就不给，给了会在取数落定后闪掉），深链 **fail-open**（只有确知无锚才拦，否则把读故障说成「你还没建锚」，用户会跑去建一个已经有了的锚）—— 专门一条断言钉住「两个判据至少一处答案相反」，谁把它们「对齐成一致」都会红；③ 拦下时的建锚引导**文案复用 046 那一份**（`OPTIONSDESK_COPY.underlyingDetail.noAnchor`），🚫 不在 `chainReport` 段另写同义串；同时 `isError` 那支改成 `isError && !blocked` —— 未建锚是预期分支，叠一句「加载失败」会诱使用户去点重试，而重试一百次也还是 404。<br>⚠️ **入口「位置」那半在 Small 层验不到**（`ListHeaderComponent` vs `renderSectionHeader` 是渲染树的事，而 Small 禁磁盘 I/O ⇒ 也不能靠读源码断言）⇒ `FR-035` / `FR-036` 的真牙齿在 **T018 e2e**（入口在三块之后、选约之前、且**随页滚走**）。本 task 落的是它的前置：`testID` + 措辞守门 + 可见性判据。<br>📌 **判据 MUST 在组件顶部算，不能塞进 JSX 分支**：详情屏那个 `page === 'no_anchor' ? 引导 : 表` 三元已把 `page` 收窄成 `'ready'`，在 else 分支里再问一次「是不是 no_anchor」是恒假的（tsc TS2367 当场红，但读起来像做了判定）。

- [X] T016 [Mobile] **下钻预填 + 业务日不一致提示**（`FR-038`, `FR-039`, `FR-039a`, `SC-010`, `state_branch` 23/24）：点有值的格 → 落该标的选约区块，预填该格的期限区间与行权价区间（`FR-038`）；「全腿」/「活跃度」格值下落**全腿视角**（`FR-039`）；点空格 🚫 不跳转。业务日不一致时显式告知两个时点，**复用选约侧已有比对，🚫 零新增契约字段**（`FR-039a`）。→ verify: Small —— 落点视角断言（`FR-039` 的两条理由：口径同源 + 不静默落空）+ 空格不跳转 + 业务日不一致时两个时点各自可见（`state_branch` 24）<br>✅ **已完成**（`chain-report-drilldown.rules.{ts,spec.ts}` 28 断言 + 路由模板常量 + 报表侧轻点手势 + 详情屏三段接线；mobile 全套 **1673 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针五处**：① 预填以**空表单**为底 ⇒ 「其余三维逐字保留默认值」+「顶档留默认」当场红；② 去掉格态判定（空格也返参数）⇒ 三条「MUST NOT 跳转」红；③ 视角认不出来时兜 `'all'` ⇒ 「整个预填作废」两条红；④ 去掉网格体越界守卫 ⇒ 「横滑之后行标列仍判得出来」红（**只红这一条** —— 另两条被负下标兜住了，见下方 📌）；⑤ 命中改用十字线那套**钳边界**的函数 ⇒ 五条越界断言全红。<br>🚨 **最危险的一条（本 task 实装期发现）**：预填表单 MUST 以**系统默认值**为底，🚫 MUST NOT 以空表单为底 —— `CriteriaForm` 里空串的契约含义是**「覆盖为不限」**而不是「不动这一维」，拿空表单当底会把权利金 / 活性 / 价差三维一起放开，选约表里于是多出报表那一格根本没数进去的腿，**而表照常渲染、条数看着还更「丰富」**（`SC-010` 当场破，界面上零异常）。⇒ 提交时机也随之定死：**必须等该视角的默认值到手**，故落成两个 effect（先落位视角、再压条件），🚫 顺序不可换。<br>🚨 **第二处同类**：顶档的**空下界**是「这一行不设界」，🚫 不等于「这个视角放弃它自己的界」⇒ 空串一律**留默认**，覆盖成「不限」同样会放进报表之外的腿。<br>📌 **实装期五处决定**：① **点哪一格与十字线读哪一格共用同两个换算**，但**越界策略蓄意相反** —— 十字线钳到边界格（滑出去时读数停在边界比闪空好读、且无后果），跳转必须返 `null`（钳过去就是「点在曲线 / 列头上跳进了第一行的格」，而那一跳**看起来完全正常**）；新加的 `chainReportCellHitAt` 与十字线共用同一套几何常量，只是界外分家。② **冻结列那一刀只能用屏幕坐标切**：横滑后 `localX − TRACK_LEFT − tx` 在行标列上照样是正数（`tx` 负值），拿 track 坐标判「在不在列区里」恒为真 —— 探针 ④ 实证这半条是**唯一**载荷，纵向那半条被 `rowIndex < 0` 兜住，已按「每行都要挣自己的位置」删掉。③ **轻点排在 `Gesture.Exclusive` 最后**：前两者一个要按住够久、一个要移动够远，都不会被一次轻点激活。④ **带 query 参数下钻走动态段模板**（`OPTIONSDESK_UNDERLYING_PATHNAME`），🚫 不拿已编码好的路径串当 `pathname` —— `%3A` 会被再编一次成 `us%253AACN`，解出来是个查不到的标的，**而屏照样渲染**（只是变成无锚引导）。⑤ **预填由路由层解析**（同 `onPanorama` 的分工）：屏拿到的是一个已判过的 `prefill`，「视角认不出来就整个作废」这条判据只有一处。<br>📌 **`FR-038` 的「落到选约区块」落成一次实测滚动**：`ListHeaderComponent` 的高度由 `onLayout` 实测，两块都离开 `loading` 之后滚到它的下边缘（早滚会停在半空 —— 046 三块的高度随内容落定而变）。预填了却停在锚卡上，用户看不到它。<br>⚠️ **一处已知的口径缝，蓄意不修**：行的行权价下界在报表里是**开区间**、而检索条件是闭区间 ⇒ 恰好落在下界上的腿会同时出现在相邻两行的下钻里。方向是**多一条**不是少一条（缺失比多出更难发现），且真实行权价极少正好等于 `spot × (1 + 档界)` 这个浮点数 ⇒ 不为它加契约字段（`FR-039a` 的「零新增契约字段」同向）。

## Phase 6: 降级态与两层验证

- [X] T017 [Mobile] **五种降级态**（`spec §Edge Cases`, `§Assumptions`, `state_branch` 4/7/8/20）：链未就绪 / 全被门槛挡下（+ 三计数）/ spot 缺失 / 加载 / 取数失败。🚫 **不做骨架网格**（列数加载前未知，骨架必然跳变）；🚨 **页头 IV 分位按自己的四态独立降级，不被网格失败波及**。🚨 某格值下零非空格时**骨架与行列标签照常渲染**（`state_branch` 4，🚫 不呈空白页或错误页）。→ verify: Small —— 五态各自一个分支断言 + 「链未就绪」与「全被门槛挡下」**可分辨**（`state_branch` 7）+ IV 块与网格的降级**互不波及**的对照断言<br>✅ **已完成**（`chain-report-page.rules.{ts,spec.ts}` 22 断言 + 屏侧四处槽位改接合成结果；mobile 全套 **1695 绿** / lint 0 error / typecheck 绿）。<br>🔬 **反例探针四处**：① 「全被门槛挡下」不画网格 ⇒ 「网格照常渲染」当场红；② 页头跟着网格失败一起藏 ⇒ 「读故障时页头照常」红；③ `isAllGated` 去掉 `total > 0` ⇒ 「一条腿都没有不说全被挡下」红；④ 把「链未就绪」塌进 `all_gated` ⇒ 「链未就绪 ⇒ chain_not_ready」+「两者不是同一个页态」两条红。<br>📌 **实装期四处决定**：① **六态**（五降级 + 常态）收敛到**一个合成函数** `composeChainReport` —— 屏内不再逐个 `isPending` / `isError` 分支，那样「未就绪」与「全被挡下」很容易塌进同一支，而两者的处置完全相反（等就有 vs 等也没有）；② 🚨 **`all_gated` 是降级态里唯一一个网格照画的** —— 说明句压在网格**下方**（mockup 帧 ⑦ 第二格如此），只留一句话的话用户看不到「哪一档哪一列有腿被挡」，而三个计数还挂在页脚上、读起来像界面坏了；③ **`header` 只看「响应到没到手」，与 `page` 无关** —— IV 分位来自另一条读链路（046 那份读端，`FR-031`），网格挂了它明明读得到；④ **只有读故障给重试**：未就绪与无现价是**事实**不是故障，给重试按钮是空承诺。<br>📌 **`state_branch` 4 落成结构性质而不是一条分支**：合成函数的入参里**根本没有「当前格值」**（只有取数态 + 链级三字段）⇒ 想按格值分页态得先改签名。断言直接扫 `Object.keys` 钉住这个形状。<br>⚠️ **顺带清一处本次改动产生的 orphan**：`OPTIONSDESK_COPY.chainReport.loadFailed`（'链分析加载失败'）在改接合成结果后无消费方，且与新增的 `degraded.readFailed.title`（'链数据读取失败'）同义 ⇒ 删，🚫 不留两份同义串。

- [X] T018 [Mobile-E2E] **hermetic e2e**（`state_branch` 2/3/4/5/6/7/8/14/15/18/22/23/24, `SC-002`–`SC-004`, `SC-009`, `SC-013`）：新建 `optionsdesk-chain-report.spec.ts`（Playwright Expo Web，`route.fulfill` 拦端点）。🚨 **mock 是契约镜像不是调用序** —— handler 按 symbol 无条件作答，禁按测试编排标志分支（053 T010 同一条纪律）。⚠️ 同 T007，13 条分支单 task 可能超 2h：真超时按分支组拆 commit，🚫 不拆 task。→ verify: 跑**全套** `nx run mobile:runtime-smoke`（改了共享路由 ⇒ blast radius 是整套）+ 合规开关关闭时深链不可达（`SC-009`）+ 未建锚时入口不出现（`state_branch` 6）+ 切换四种格值时**屏上位置逐格不变**（`SC-002`）<br>✅ **已完成**（`optionsdesk-chain-report.spec.ts` **14 个 test** 覆盖 12 条分支 + `markets-feature-gate.spec.ts` 追一条报表深链覆盖第 13 条）。**全套 runtime-smoke 214 passed**（基线 200 + 本片 14）· `nx run mobile:e2e-public` **4 passed**（深链从 10 条涨到 11 条）· 单 task 未超 2h，🚫 未拆 commit。<br>📌 **`SC-009`（`state_branch` 22）按既有纪律写进 `markets-feature-gate.spec.ts` 而不是本片 spec** —— 那个文件由 `playwright.markets-off.config.ts` 的 `testMatch` 锁死、主套件反向 `testIgnore`。写在 055 自己的 e2e 里 = 在 **ON** bundle 下跑，永远验不到 OFF 且不会红。文件头「面数 8 但深链 N 条」那句同步改成 11，并补一句「新增栈内路由必须在这里追一条」。<br>📌 **`SC-002` 的断言落成「位置集合 vs 格态集合」两半**：从屏上真 DOM 抓所有 `chain-report-cell-<行>-<列>-<码>`，切四种格值后**位置集合逐格相等**、而**格态集合必须变过**。只断言前一半会让「格态被缓存成格的静态属性」全绿通过（那正是 Guardrail 6）。<br>📌 **`FR-036`「不进吸顶区」的判据是滚动后的相对位置**，不是「入口在区块头之上」—— 吸顶的东西一开始也在上面。落法：滚一屏后断言**选约区块头仍可见而入口已滚走**。<br>🔬 **实装期撞到一处 fixture 口径**：收租格值下首列在召回段之外 ⇒ 那一列的空格码是 `out_of_band` 而非 `void`，「点空格不跳转」的靶子必须取**段内**那一列的空格。这条恰好反证了「段外（列级）与无合约（格级）不同码」是真的落地了。<br>✅ **十字线在 Expo Web 下驱得动**（此前存疑）：`mouse.down` → 等过 300ms 长按阈值 → 多次 `move` 能激活 `activateAfterLongPress` 的 Pan，读数面板与竖线都断言到了。⚠️ 但**只验状态面** —— 手势竞争的真实归属与手感仍归 T021（`state_branch` 16/17）。

- [X] T019 [Contract-Smoke] **契约冒烟**（Constitution §V）：`apps/mobile/e2e/contract-smoke/optionsdesk-chain-report.contract.ts` —— 用生成的 `@nvy/api-client` 打 testcontainers 真 server。→ verify: 端点往返 + 四种格值同一骨架 + 三计数字段解封 + nullable 小数字段运行时类型是 string 而非 orval objectmap + 🚫 响应内**无 `band` 字段**（`D-BAND-1` 的契约面核实）。📌 本地跑前先空出 `:3000`，停的是 `nx serve server` 那层看门进程<br>✅ **已完成**（`optionsdesk-chain-report.contract.ts` + 在 `run.ts` 注册；`RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke` **23/23 passed**，其中 055 那条自己 8 组断言）。专属 ticker `us:NVYG` / `us:NVYH`（避开 045 `NVYX` · 046 `NVYQ..T` · 047 `NVYL/NVYP/NVYN` 与 hermetic 的 `us:ACN`）。<br>🚨 **首轮全绿之后把 `> 0` 全部改成逐条钉死**（本 task 最有价值的一步）：fixture 为三条排除路径**各种一条**腿，八条腿的归属是一一对应的 ⇒ 期望值写成 `{total 8, 权利金 1, 行下界外 1, 无活动 1, 有值 5}` + 分母链 `{骨架 7, 行内 6}`。`> 0` 分不出「那条腿走对了路」与「另外七条里有一条误落进来」，**而两种情况下三个数都印得出来**。<br>🚨 **ATM IV 那条同样从区间断言收成精确值**：现价 100 恰在 K=105(iv 25) 与 K=95(iv 35) 正中 ⇒ 线性插值的精确解是 **30**，而 `FR-022` 明禁的「取最近档」会给 25 或 35 —— 写成「落在 25–35 之间」对它**恒真**。落法是整条列轴一次 `deepEqual`：`[[10,null],[45,30],[120,null]]`，同时钉住断点、插值、列序与列数。<br>📌 **五条只有端到端才验得到的靶心**：① nullable 小数运行时是 `string` 而非 orval objectmap（Guardrail 10 / 012；typecheck 只看类型、hermetic fixture 本来就是字符串）；② 响应内无色阶档字段，判据按**独立键名** `/"bands?":/` 扫并配一条 `inRecallBand` 仍在的**正向控制**（裸 `includes('band')` 会被它误伤，靠大小写巧合成立的判据不算判据）；③ 四张网格维度逐格相等**而格态集合必须变过**；④ 三计数归属如上；⑤ 报表的 `iv` 与详情端点的 `iv` 直接 `deepEqual` + 键集恰好五个（`FR-031` 复用 046 那一份、且 vendor 的 IVR 不得上屏）。<br>⚠️ **本地跑法**：`RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke`（env 缺省即整套 exit 0 跳过 —— 「测试全绿」对它覆盖的契约**不构成证据**）。

## Phase 7: 标定与真机验收

- [X] T020 [Gate] **色阶档界跨多业务日标定**（`FR-019a`, `FR-019b`, `SC-012`, plan `D-BAND-1`）：四种格值各自标一套，产出物 = T009 那个文件里的常量取值。🚨 **样本窗口 MUST 跨多个业务日** —— `FR-019a` 要的是跨业务日恒定，而本片实测只有单日（2026-08-11 全池 12 链），答不了「单日分位标出来的数换一天漂不漂」。🚫 **不得先拍一个数**。⚠️ 动手第一件事**先确认数据面没被 mock 污染**（052 T016 撞过：12 只票共用同一个 spot；本片 054 之后 mock 写入会拒库，但仍要确认）。→ verify: 四组数与**推导过程**写回 spec § 标定实测 + 占位标记扫零命中 + `SC-012` 在**每一个**标定日上都成立（不是只在标定那天）<br>✅ **已完成**（spec 新增 `## 标定实测` 一整节；`CHAIN_REPORT_BAND_SCALES` 四组取值落地；`🚧 PLACEHOLDER(T020)` 扫**零命中**；mobile 全套 **1695 绿** / lint 0 error / typecheck 绿）。<br>📐 **窗口 = 4 个业务日**（`2026-08-10/11/12/13`，每日 12 链）。**污染自检四天全部 12/12 spot 去重 ⇒ 非 mock**。<br>📐 **口径同源**：一次性脚本调**服务端那份真代码**（`loadChain` 的过滤与 dedupe 逐字照抄 · `recallCandidates` · `computeEffectiveCostVsWPct` / `computeLegRates` / `activityVolume` · `classifyOtmBand` + `aggregateCell`），🚫 不在 SQL 里重推任何判据 —— 重推一份就是标在一个屏上不存在的分布上。取到的是**格值样本**（每格最优值）不是腿级值；全腿年化**排除价内行**（`FR-019c`）。<br>🚨 **本轮唯一的口径改动：活跃度形态从 `log` 改成 `quantile`，理由是实测证伪而不是口味** —— 等比切点 `11/112/1180/12464` 让中间那档吃到 **50.4%**，`08-11` 与 `08-12` 两天破 `SC-012`（另两天 48.8 / 46.9% 擦线过）。「幂律 ⇒ 对数」只保证切点跨越量级、不保证每档人数均衡，而 `FR-019b` 的可验判据要的正是后者。📌 不触碰 `FR-019a`：形态只描述四个常量**当初怎么切出来的**，运行期它们是固定值。<br>📐 **四组定案**（逐日最大档 / 上限 50%）：建仓 `linear` `-20/-3/14/31`（39.4·36.8·**43.5**·36.4）· 收租 `quantile` `0.065/0.12/0.20/0.30`（21.3·**27.4**·22.4·25.0）· 全腿 `quantile` `0.035/0.065/0.115/0.21`（21.8·**22.0**·21.4·21.7）· 活跃度 `quantile` `45/215/535/1150`（21.0·21.6·20.7·**22.2**）。**`SC-012` 在每一个标定日上都成立**，不是只在汇总上成立。<br>🔬 **反例探针（四种全套线性等距，4 日汇总）**：建仓 39.2% ✅ 仍成立（它本就是 linear，探针对它无效是预期）· 收租 **50.9%** 🚫 · 全腿 **95.1%** 🚫 · 活跃度 **99.2%** 🚫。⚠️ 起草期记的 `7.0/52.4/96.8/99.2` 是**单日且含价内行**的数，与本组口径不同，spec 已注明以新表为准。<br>🚨 **T009 留的「合成样本 MUST 替换」已兑现**：`SAMPLES` 换成本次实测的**百分位梯**（每格值 100 点）。**端点必须取真 min/max**（`i/(N-1)` 而非 `(i+0.5)/N`）—— 切掉两条尾巴后收租那条反例探针从 50.9% 掉到 **49%**，**探针失去判别力而测试照样全绿**，本 task 实撞并当场订正。<br>⚠️ **顺带修一处被档界耦合的旧断言**：`chain-report-grid.rules.spec.ts` 的「角标同色」用 `0.05` 取值验 band 2，那是占位档界下的落档；标定后 `0.05` 落第 1 档 ⇒ 改用 `0.10`。该条验的是**上色**不是落档，但它必须挑一个确定落档的值，已就地注明「档界一改这里要跟着挪」。<br>📌 **标定脚本 local-only 不入库**：它是一次性取数（依赖 dev 库那 4 天的快照），入库会变成一个没有属主、跑不动也没人删的脚本。可复现性靠 spec § 标定实测 把方法、过滤条件、三种切法与验收面**逐条写死**。⚠️ 中途一度把它放进 `apps/mobile/runtime-debug/`（gitignored）—— **那里仍在 `nx typecheck mobile` 的扫描面内**，当场把 server 源码拖进 mobile 的 tsc 里炸出 40+ 错。gitignored ≠ 在构建视野之外。

- [ ] T021 [Verify] **真机验收**（`SC-001`, `SC-003`, `state_branch` 16/17）：Mate50 dev-client。① **一屏可见 / 零纵向滚动**（`SC-001`，🚨 用真机读数不用 web 那组，Guardrail 12）—— 🚨 **本条本轮风险升高，必测不得跳**：spec 把页脚从 2 计数改成**3 计数 + 一行 hint**（约 +16px），而一屏余量至今**只在 web 上验过**（mockup overflow = 0）。真机窄约 13% ⇒ 那 16px 可能正好吃掉余量。越线时按 `FR-041` 的顺序**先压曲线、再压页头**，🚫 网格不得纵向滚；② **横滑到最右端**末列完整露出、不越界不回弹（`state_branch` 16）；③ **长按 vs 横滑的手势归属**与手感（`state_branch` 17）；④ **色阶五档在真机屏上可分辨**（`SC-003`）；⑤ 段外列淡出与「被门槛挡下」在真机上**不查图例可分**（Guardrail 7 的真机复核）。→ verify: 逐条读数写回 spec § 真机验收。🚨 **这是开 PR 前的最后一道闸**，撞到 FAIL 即停下修，MUST NOT 记为「已知问题」往下走

---

## Dependencies & 执行顺序

```text
T001 → T002 → T003 → T004        （纯函数层，T001 的行列骨架是其余三个的输入）
                  ↓
T005 → T006 → T007 → T008        （编排 → 契约 → IT → regen）
                  ↓
T009 ─┐                          （色阶纯函数，可与 T010 并行）
T010 ─┴→ T011 → T012             （屏骨架 → 网格 → 切换与页脚）
                  ↓
T013 → T014                      （曲线 → 十字线；十字线要曲线的点位）
                  ↓
T015 → T016                      （入口 → 下钻）
                  ↓
T017 → T018 → T019               （降级态 → e2e → 契约冒烟）
                  ↓
T020 → T021                      （标定 → 真机验收，PR 前最后一闸）
```

- **T008 是 mobile 全部 task 的硬前置**（没有生成的 client 就没有类型）。
- **T009 与 T010 可并行**（不同文件、无依赖）。
- **T020 刻意排在 T018 之后**：e2e 用占位档界就能验结构与状态，标定值只影响颜色深浅；反过来先标定会让 e2e 的期望值随标定结果反复改。

## Clear 检查点批次

per Constitution §III（每 2-3 个强关联 task，硬上限 5）：

| 批次 | tasks     | 说明                         |
| ---- | --------- | ---------------------------- |
| B1   | T001–T004 | 服务端纯函数层（同一文件簇） |
| B2   | T005–T008 | 编排 + 契约 + regen          |
| B3   | T009–T012 | mobile 呈现主体              |
| B4   | T013–T014 | 曲线 + 十字线                |
| B5   | T015–T017 | 入口 / 下钻 / 降级态         |
| B6   | T018–T019 | 两层验证                     |
| B7   | T020–T021 | 标定 + 真机                  |

## `state_branches` 覆盖矩阵（**24** 条 → task，实时 grep 得出）

| #   | 分支摘要                      | task                      | #   | 分支摘要                | task                      |
| --- | ----------------------------- | ------------------------- | --- | ----------------------- | ------------------------- |
| 1   | 四种格值任一 → 网格渲染       | T007 · T018               | 13  | greeks 缺失只影响曲线   | T004 · T007               |
| 2   | 切换格值 → 位置不变、格态重算 | T002 · T007 · T012 · T018 | 14  | 格内 1 条腿 → 次优为无  | T002 · T014 · T018        |
| 3   | 段外列整列淡出                | T011 · T018               | 15  | 十字线拖到空格 → 给原因 | T014 · T018               |
| 4   | 某格值零非空格                | T007 · T017 · T018        | 16  | 横滑到最右端 clamp      | 🚨 T021（真机）           |
| 5   | 全腿年化 × 价内行不着色       | T009 · T018               | 17  | 长按 vs 横滑归属        | 🚨 T021（真机）           |
| 6   | 未建锚 → 入口不出现、不可达   | T015 · T018               | 18  | IV 分位四态             | T005 · T007 · T010 · T018 |
| 7   | 链无快照 → 未就绪             | T007 · T017 · T018        | 19  | 活跃度时点跟 oiAsOf     | T005 · T007 · T012        |
| 8   | 全被门槛挡下                  | T007 · T017 · T018        | 20  | spot 缺失 → 行轴不成立  | T007 · T017               |
| 9   | 三计数互斥且求和 = 全量       | T003 · T007 · T012        | 21  | 锚 excluded → 带标记    | T007 · T018               |
| 10  | 单列网格                      | T007 · T011               | 22  | 合规开关关闭 → 不可达   | T010 · T018               |
| 11  | 单行网格                      | T007                      | 23  | 点有值格 → 下钻预填     | T016 · T018               |
| 12  | ATM IV 插值不可得 → 断点      | T004 · T007 · T013        | 24  | 下钻后业务日不一致      | T016 · T018               |

## Acceptance Scenario 覆盖矩阵（**15** 条 → task）

> 🚨 这一层是 `sdd-authoring.md` 点名的**系统性盲区** —— 三张矩阵（`state_branches` / Edge Case / SC）的值域都够不到写在 `## User Scenarios` 里的 AS，046 实证「US1-AS1 被两轮 analyze 全漏且零告警」。故单列。

| US  | AS  | 摘要                                   | task        |
| --- | --- | -------------------------------------- | ----------- |
| 1   | 1   | 打开报表全部落首屏、无需纵向滚动       | T021        |
| 1   | 2   | 切「建仓成色」→ 位置逐格不变、读数重算 | T012 · T018 |
| 1   | 3   | 格内多腿 → 同时给最优与腿数            | T002 · T012 |
| 1   | 4   | 列超一屏 → 横滑、首列冻结、末列露出    | T011 · T021 |
| 2   | 1   | 无合约的格呈「无合约」态               | T002 · T012 |
| 2   | 2   | 全低于门槛的格呈**第三态**、视觉可分   | T012 · T018 |
| 2   | 3   | 页脚三计数各自可见、各带分母、不合并   | T012 · T018 |
| 3   | 1   | 曲线点数 = 列数且逐列对齐              | T013        |
| 3   | 2   | 长按拖动 → 十字线 + 读数面板含次优     | T014 · T021 |
| 3   | 3   | 未长按直接拖 → 走列位移                | 🚨 T021     |
| 3   | 4   | 定不出 ATM IV → 该点断开、不填充       | T004 · T013 |
| 3   | 5   | IV 分位四态都渲染页头这一块            | T010 · T018 |
| 4   | 1   | 详情屏入口可见、措辞不与温度计重复     | T015 · T018 |
| 4   | 2   | 点有值格 → 落选约区块、条件已预填      | T016 · T018 |
| 4   | 3   | 点空格 → 不跳转                        | T016 · T018 |

## Edge Case 覆盖（**11** 条 → task）

| Edge Case          | task        | Edge Case            | task        |
| ------------------ | ----------- | -------------------- | ----------- |
| 未建锚 ⇒ 不可达    | T015 · T018 | 十字线拖到空格       | T014        |
| 链从无快照         | T017        | 锚 excluded ⇒ 带标记 | T007 · T018 |
| 只有一个到期日     | T007 · T011 | 合规开关关闭         | T010 · T018 |
| 只有一个价外档非空 | T007        | 某格值零非空格       | T007 · T017 |
| spot 缺失          | T007 · T017 | 召回段外的列整列淡出 | T011        |
| 某格内只有一条腿   | T002 · T014 |                      |             |

## SC 覆盖（**13** 条 → task）

| SC     | task               | SC     | task               | SC     | task        |
| ------ | ------------------ | ------ | ------------------ | ------ | ----------- |
| SC-001 | 🚨 T021            | SC-006 | T003 · T012        | SC-011 | T010 · T018 |
| SC-002 | T005 · T012 · T018 | SC-007 | T008（依赖零新增） | SC-012 | T009 · T020 |
| SC-003 | T012 · 🚨 T021     | SC-008 | T005 · T007        | SC-013 | T009 · T018 |
| SC-004 | T014               | SC-009 | T010 · T018        |        |             |
| SC-005 | T013               | SC-010 | T016 · T019        |        |             |

## FR 覆盖（**52** 条，实时 grep 得出）

> 🚨 **逐个 id 列出，🚫 不写成 `FR-010`–`FR-015` 这种区间** —— 区间里的中间 id 从不以字面量出现，下一轮 `/speckit-analyze` 的零命中扫描会把它们全报成缺口（本轮自审实撞 4 条：`FR-011` / `FR-012` / `FR-013` / `FR-029`）。

| task   | FR                                                                      |
| ------ | ----------------------------------------------------------------------- |
| T001   | `FR-001` `FR-002` `FR-003` `FR-005`                                     |
| T002   | `FR-006` `FR-007` `FR-008` `FR-016` `FR-016a` `FR-027` `FR-028`         |
| T003   | `FR-034`                                                                |
| T004   | `FR-020` `FR-021` `FR-022` `FR-023` `FR-024`                            |
| T005   | `FR-005` `FR-010` `FR-011` `FR-012` `FR-013` `FR-014` `FR-031` `FR-033` |
| T006   | `FR-040`                                                                |
| T009   | `FR-018` `FR-019` `FR-019a` `FR-019b` `FR-019c`                         |
| T010   | `FR-031` `FR-033` `FR-040` `FR-041`                                     |
| T011   | `FR-004` `FR-007` `FR-009` `FR-009a`                                    |
| T012   | `FR-010` `FR-014` `FR-016` `FR-017` `FR-018` `FR-034`                   |
| T013   | `FR-020` `FR-021` `FR-022` `FR-023`                                     |
| T014   | `FR-025` `FR-026` `FR-027` `FR-028` `FR-029` `FR-030`                   |
| T015   | `FR-035` `FR-036` `FR-037` `FR-037a`                                    |
| T016   | `FR-038` `FR-039` `FR-039a`                                             |
| T021   | `FR-041`                                                                |
| 零覆盖 | `FR-015` `FR-032` `FR-042` `FR-043` `FR-044` `FR-045`（见下方登记）     |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 条目                                           | 为什么没有独立 task                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FR-015`（🚫 禁单一年化格值）                  | **NEGATIVE 约束**，由「提供四种格值」（T012）的存在**结构性**满足；额外补一个「断言不存在单一年化模式」的测试是恒真装饰 |
| `FR-032`（🚫 禁市场级 regime N/X）             | 同上，**靠不实现来满足**。已在 mockup `§显式未画` 登记                                                                  |
| `FR-042` / `SC-007`（零新第三方依赖）          | 由 T008 的 `pnpm-lock.yaml` **零 diff** 核实，不单列 task                                                               |
| `FR-043`（设计令牌取自既有体系）               | 由 mockup 阶段的「0 新增 token，46 / 50 个 `var(--nvy-*)` 全部解析」实测承担，impl 期由 lint 承担                       |
| `FR-044` / `FR-045`（锚派生 / 召回判据零改动） | 由 T005 与 T008 的 **`git diff` 零行断言**核实（照 053 T005 的做法），不单列 task                                       |
| `FR-036`（入口不进吸顶区）                     | 由 T015 的位置断言顺带覆盖（它与 `FR-035` 是同一处版式的两个侧面）                                                      |
| spec `Key Entities` ② 的**「是否跨财报」**     | **本片不呈现**（2026-08-14 与 user 定）。三条理由：① mockup 已定案，列头**未画**它；② **零 FR** 要求它（`Key Entities` 是唯一出处）；③ 列头多一个 chip 要吃掉 `FR-041` 的一屏高度预算，而那条余量本轮因页脚改三计数 +16px 已经变紧、`T021` 标了「必测不得跳」。<br>📌 另有一条实装侧理由：047 的 `earningsMarksByExpiry` 吃**标的级意图**来解 legFamily，而报表同屏呈现四种格值、没有单一意图 ⇒ 复用它必须先给报表硬造一个意图，与 `D-STATE-1`「格态跟当前格值走」冲突。<br>🚨 **再触发线**：若某轮把它加回呈现面，MUST 先定「按哪个口径判跨财报」，🚫 不要顺手套 047 那套三态标。 |

## MVP

**US1（P1）= T001–T012**。到此用户已经能回答「该挂哪段期限 / 价外让到多深」—— 即使曲线、十字线、下钻都没做。US3 的曲线（T013–T014）是**解毒剂**、US4 的下钻（T015–T016）是**接执行**，都建立在网格之上。

## 单 PR（Constitution §V）

跨端 feature ⇒ server impl + IT + `export-openapi` + api-client regen + mobile 消费 + 两层验证**全部同一个 PR 原子 merge**。代价（整体 revert，不保留 server 独立回滚）已在 Constitution v1.3.0 接受。

⚠️ **T021 之后才开 PR** —— 真机验收是开 PR 前的最后一道闸，不是事后补。
