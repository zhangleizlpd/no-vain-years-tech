---
feature_id: 052-optionsdesk-retrieval-layering
spec_ref: ./spec.md
plan_ref: ./plan.md
status: pending
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
12. **建仓视角顺手「优化」**（`FR-007`）—— 它没坏。`SC-005` 要求本片前后候选集**逐条相同**，任何改动都会红。

---

## Phase 1: 检索 port + 层骨架（阻塞其余全部）🎯

- [ ] T001 [Server] **检索 port 接口 + Prisma adapter + 假实现**（`FR-031`, `FR-032`, plan `D-PORT-1`）：新建 `leg-retrieval.port.ts`（入参 = 视角 + 已解析的检索条件 + 候选上限；出参 = 候选集）与 `leg-retrieval.adapter.ts`（`PrismaService` 直查 + `// CROSS-CONTEXT-READ` 注释）；测试用假实现同文件簇。`get-legs.usecase.ts` 改注入 port。→ verify: `leg-retrieval.port.spec.ts`（Small）—— 接口签名内 `rg` 扫 `Prisma|sql|cursor|offset|limit` **零命中**（`FR-031` 的机器判据）+ 假实现可在**不起容器**下驱动召回判据（`SC-009`）+ `nx lint server` 绿 + `check-server-moat.ts` 0 违规

- [ ] T002 [Server] **粗排层恒等入口 + 五层边界断言**（`FR-001`, `FR-004`, plan `D-LAYER-1`）：新建 `leg-coarse.rules.ts` 导出恒等入口（吃候选集吐候选池）；`get-legs.usecase.ts` 串进调用链。→ verify: `leg-coarse.rules.spec.ts`（Small）—— 恒等性断言（入 == 出，含空集）+ **函数体零判据**（`rg` 扫该文件内 `if|filter|sort|>=|<=` 零命中，Guardrail 5 的机器判据）+ 五层各自入口有独立单测文件

---

## Phase 2: 召回层判据（US1 —— 缺陷修复，MVP）

- [ ] T003 [Server] **成色条件（收租视角）**（`FR-005`, `FR-006`, `FR-007`, plan `D-RECALL-1`）：`leg-recall.rules.ts` 新增纯函数，上界 = `min{行权价 ≥ spot}` **∧** `spot × (1+X)` 取严，闭区间；**只接进收租视角**。X 先用占位常量，标定在 T016。→ verify: `leg-recall.rules.spec.ts`（Small）—— 高于上界不进 / **恰等于上界进**（闭区间边界）/ 稀疏网格下由比例项接管 / 链上无「≥ spot」的档时退化为仅比例项 / **全腿与建仓视角不受该条件影响**（Guardrail 8）

- [ ] T004 [Server] **持仓量条件（三视角一律）**（`FR-008`, `FR-009`, plan `D-RECALL-1`）：`leg-recall.rules.ts` 新增 `OI ≥ 下限` **或** 当日有成交。下限先用占位常量，标定在 T016。→ verify: 同文件 Small —— `OI=0` 且无成交**不进** / **`OI=0` 但有成交进**（免死条款，Guardrail 1）/ 三视角行为一致 / 成交为 null 与成交为 0 区分对待 / 🚫 **权利金门槛的两个常量逐字未变**（`FR-009` 的否定式断言 —— `git diff` 该常量零命中；起草期曾怀疑它误伤，逐段核后被数据否定）

- [ ] T005 [Server] **召回层候选上限 K + 触及可观测**（`FR-027`, `FR-028`, plan `D-K-1`）：port 入参接 K；触及时产出可被 SQL / 响应读到的状态，**MUST NOT 只落 log**。K 先用占位常量，标定在 T016。→ verify: Small + IT —— 候选数 < K 不截 / = K 不截 / > K 截到 K 且状态可读 / **K 与表达层的 N 是两个独立参数**（`rg` 扫二者未共用常量）

---

## Phase 3: 特征加工 + 精排（US2 —— 排序按可成交性）

- [ ] T006 [Server] **特征注册表编译期强制 + 成色特征**（`FR-025`, plan `D-FEAT-1`）：`leg-rank.rules.ts` 的特征集类型改为按键穷举的映射；新增成色特征（供全腿排序用）。→ verify: `leg-rank.rules.spec.ts`（Small）—— 归一化到 `[0,1]` + 全等 / 缺失 / 单条候选三种边界 + 🚨 **先证明它会红**：临时加一个特征键但不实现 ⇒ `nx typecheck server` 变红，删回后归绿（这是 ADR-0064 不变量 ③ 从纪律变机器拦的实证）

- [ ] T007 [Server] **精排换 lexicographic（分层 + 降级）**（`FR-017`, `FR-018`, `FR-019`, `FR-021`, `FR-022`, plan `D-RANK-1`）：ranker 改为「流动性档（离散）→ 档内折算费率降序 → 费率打平带内长期优先」；候选数 < 阈值时不分档。档界 / 带宽 / 阈值先用占位常量，标定在 T016。→ verify: 同文件 Small —— 厚腿排在薄腿前 / 档内按费率降序 / 打平带内长者优先 / **降级边界取严格小于** / 🚨 **ranker 函数体内 `rg` 扫不到腿的原始字段名**（`FR-022` 的机器判据）

- [ ] T008 [Server] **全腿视角成色沉底（不砍腿）**（`FR-006`, `FR-020`, plan `D-RANK-1`）：全腿保持费率降序，成色特征参与使深度实值排末段。→ verify: IT —— 深度实值腿**仍在候选集内**（`SC-006` 的一半）+ 排在末段 + 🚨 **被意图视角任一条件排除的腿 100% 可在全腿视角找到**（`SC-006` 全量，`051` 入口的回归防线）

---

## Phase 4: 活跃标（US4）

- [ ] T009 [P] [Server] **活跃标改同到期日分组 + 绝对量下限**（`FR-023`, `FR-024`, plan `D-MARK-1`）：`leg-derive.rules.ts` 的 `markActivity` 分组维度由候选集改为到期日，发标需同时满足「组内 top N」与「绝对量过线」。下限先用占位常量，标定在 T016。→ verify: `leg-derive.rules.spec.ts`（Small）—— 标分布覆盖多个到期日 / **整体量低的到期日即使有组内第一也不发标**（Guardrail 4）/ 某到期日无候选不产生空分组不除零 / **同分决胜稳定**（同一输入两次调用结果逐字相同，Guardrail 9）

---

## Phase 5: 检索条件的默认值与覆盖（US3）

- [ ] T010 [Server] **系统默认值计算下发 + 用户覆盖 + 三态计数**（`FR-002`, `FR-003`, `FR-011`–`FR-016`, `FR-026`, `FR-029`, `FR-030`, plan `D-CRIT-1`）：`get-legs.usecase.ts` 解出每视角每条件的系统默认值并下发；请求带条件时以请求值召回；每维度产出三态（未覆盖 / 覆盖且放宽 / 覆盖且收窄），**仅收窄态出计数**。→ verify: IT —— 无请求条件时按默认值召回 / 带条件时按请求值 / 🚨 **排名基准 = 当前条件下的召回集**（放宽条件后活跃标重算，Guardrail 10）/ 放宽维度**不出**计数（Guardrail 7）/ 水位变化时召回成员集逐条不变（`FR-016`）/ 🚫 **全仓只有一个 filter 概念**（`FR-003` 的机器判据 —— `rg` 扫服务端与客户端均**不存在**「排名之后再筛一次」的第二条路径）

- [ ] T011 [Contract] **DTO + OpenAPI + api-client regen**（`FR-011`, `FR-029`, plan §V）：`optionsdesk.dto.ts` 加「本次生效条件值」「系统默认值」「每维度三态与计数」三组字段；nullable string 字段的 `@ApiProperty` 显式 `type: 'string'`；跑 `nx run server:export-openapi` + `nx affected -t generate`，修因新 required 字段编译红的手写 mock 工厂。→ verify: `openapi.json` diff 只增不删 + `nx affected -t build` 绿 + **手写 mock 工厂逐处补齐**（`050` 那次是 7 处）

---

## Phase 6: Mobile 增量 + 两层验证

- [ ] T012 [Mobile] **控件默认值回填 + 「搜」/「复位」+ 收窄维度计数行**（`FR-012`, `FR-013`, `FR-015`, `FR-029`, plan `D-CRIT-1`）：检索条件控件用服务端下发的默认值填充；「搜」显式提交、「复位」清回默认；计数区追加**仅收窄维度**的行（复用 `051` 的 `.gateline` 结构与措辞体例）。→ verify: `*.rules.spec.ts`（Small，logic-only）—— 🚨 **mobile 侧 `rg` 扫不到任何参与默认值计算的算式**（`FR-011` / Guardrail 6 的机器判据）+ 三态到「显不显示计数」的映射是穷举 `Record`（漏 enum 成员即编译红）+ **每视角各自持有条件状态**（`FR-015` —— 切视角不带走上一个视角的值，条件值进 query key 即天然隔离）

- [ ] T013 [Mobile-E2E] **hermetic e2e**（US3 全部 AS, `FR-014`, `SC-008`）：Playwright Expo Web，`route.fulfill` 拦端点。→ verify: 进入视图控件已填默认值 / 改值不点搜结果不变 / 点搜按新值 / 点复位回默认且计数消失 / 离开再进回默认（`FR-014` 不持久化）/ 🚨 **mock 是契约镜像不是调用序**（按请求参数无条件作答，禁按测试编排标志分支）+ 跑**全套** `runtime-smoke` 非单 spec

- [ ] T014 [Contract-Smoke] **契约冒烟扩到新字段**（Constitution §V）：`apps/mobile/e2e/contract-smoke/` 用生成的 `@nvy/api-client` 打 testcontainers 真 server。→ verify: 条件参数序列化正确 + 默认值字段解封 + 计数三态字段解封 + `nx run mobile:contract-smoke` 绿

---

## Phase 7: 覆盖收口与标定

- [ ] T015 [Server] **IT 全量 state branch 扫描**（`FR-001`, `FR-010`, `FR-033`, plan Testing Invariants）：`optionsdesk-052.retrieval.it.spec.ts` 补齐前面各 task 未覆盖的分支，使 spec 的 **24 条 `state_branches` 逐条有 `it()`**。→ verify: 逐条 grep 交叉核对（**不靠通读**，per `sdd-authoring.md` 反模式）—— 24/24 命中 + `SC-005` 建仓候选集本片前后逐条相同 + **相对价差条件只作用于两个意图视角**（`FR-010`，全腿不受其约束）+ 🚫 **`045` 的锚派生与意图矩阵零改动**（`FR-033` 的否定式断言 —— `anchor.rules.ts` / `intent-matrix.rules.ts` 的 `git diff` 零命中）+ `nx test server` 全绿

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
| SC-005 建仓候选集本片前后逐条相同 | T015 |
| SC-006 被排除的腿 100% 可在全腿视角找到 | T008 |
| SC-007 客户端零处自算默认值 | T012 |
| SC-008 改值/提交/复位三条各有断言 | T013 |
| SC-009 召回判据单测不依赖真库 | T001 |
| SC-010 五层各有独立入口与测试；顺序错误可捕获 | T002 / T015 |
| SC-011 全部待标定量由实测产出，零处拍数 | T016 |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 事项 | 为什么故意不覆盖 |
| --- | --- |
| 粗排层的合并 / 去重行为 | 本片是**恒等函数**，无输入可合并。ADR-0064 sunset #1（多路召回落地）才是它的触发条件 |
| 表达层的档位口径 / 截断 N / 列改版 | 归 `053`，本片零改动（`FR-034`） |
| 检索 port 的第二个实现 | 本片单实现。ADR-0064 sunset #3（规模突破阈值）才触发 |
| 真机验收 | 本片 mobile 增量零新视觉形态（复用 `049`/`051` 定稿），无占屏比变化。⚠️ 若 T012 期发现需要新版式 → **停下补 mockup**（plan Gate 0.1 的绊线） |

## MVP

**Phase 1 + Phase 2（T001–T005）** —— 交付「收租视角不再被公式退化产物占满」这一条，独立可验、独立有价值。它是本片存在的理由（US1），其余是在它之上的质量提升。

## 单 PR（Constitution §V）

本片带一处 mobile 改动 ⇒ server impl + IT + `export-openapi` + regen + mobile 消费 + 两层验证**全部同 PR 原子 merge**。
