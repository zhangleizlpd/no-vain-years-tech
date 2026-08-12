---
feature_id: 051-optionsdesk-leg-display-semantics
spec_ref: ./spec.md
plan_ref: ./plan.md
status: in-progress
created_at: '2026-08-12'
updated_at: '2026-08-12'
---

# Tasks: 051-optionsdesk-leg-display-semantics（选约表显示口径跟进 — P2）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Mockup**: [`design/`](./design/)（local-only）
**Branch**: `051-optionsdesk-leg-display-semantics`
**主 plan**: `docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有，范畴权威在其 §2.3）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。📌 **本片零 `[P]`** —— 唯一的候选 T005/T006 经 analyze 判定同改一个文件（F3）
- 层级：`[Server]`（use case 增量）· `[Server-IT]`（Medium，Testcontainers）· `[Contract]`（DTO + OpenAPI + api-client regen）· `[Mobile]`（rules 纯函数 / tsx）· `[Mobile-E2E]`（Playwright hermetic）· `[Contract-Smoke]`（生成客户端打真 server）· `[Docs]`
- **层级 → size 映射**（`docs/conventions/testing.md`）：`[Mobile]` 的 verify 落 **Small** `*.spec.ts`（**logic-only，禁 vitest 渲染组件**）· `[Mobile-E2E]` = `apps/mobile/e2e/*.spec.ts`（Playwright）· `[Server-IT]` = **Medium** `*.it.spec.ts`
- **测试不独立成 task**（per `sdd.md`），绑在每个实现 task 的 `verify:` 里；**IT / e2e / contract-smoke 例外**（跨多文件、单独成 task）
- 每 task = 30min–2h 单 commit 单元；`- [ ]` pending / `- [X]` done
- 🚨 **FR / SC / plan 决策的引用一律写全**（`FR-014a` 而非 `FR-014a/b`）—— 缩写会让「逐条 grep 交叉核对」这个判据**自己失效**（`050` 首轮踩过，11 条 FR 静默漏扫）

## Path Conventions

| 面 | 路径 |
| --- | --- |
| server 增量 | `apps/server/src/optionsdesk/get-legs.usecase.ts` + `optionsdesk.dto.ts` + `leg-recall.rules.ts`（**仅暴露已有派生**，零判据改动）；扁平，零**新** rules 文件 |
| server IT | `apps/server/test/integration/optionsdesk-051.*.it.spec.ts` |
| 契约 | `optionsdesk.dto.ts` → `apps/server/openapi.json` → `packages/api-client/src/` |
| mobile 判定 | `apps/mobile/src/optionsdesk/leg-picker.rules.ts` · `leg-picker-copy.ts` · `leg-row.rules.ts` |
| mobile 呈现 | `leg-row.tsx` · `leg-table-header.tsx` · `leg-picker-tabs.tsx` · `underlying-detail-screen.tsx` |
| mobile 屏级 | `use-leg-table.ts` · `underlying-detail.rules.ts` |
| 文案 | `optionsdesk-copy.ts` |
| e2e | `apps/mobile/e2e/optionsdesk-leg-display.spec.ts` |
| contract smoke | `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts` |
| schema / migration | **零改动** |

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **`标量 ≠ build + rent`**（`FR-006a`）——`[30,49]` 是 `050` **刻意保留**的重叠区，一条落其中且被流动性挡下的腿在标量记 1 次、两个分视角数各记 1 次 ⇒ 恒有 `标量 ≤ build + rent`。写 `toBe(build + rent)` 会在重叠区红，而**红的是测试不是代码**，很容易被改成「修代码去凑等号」——那会把 `050` 花力气保住的重叠语义拆掉。
2. **`filterLegsByTab` 退役而非并存**（plan D-ORDER）——留着它就留了一条绕过 `tabOrder` 的旁路，走那条路**渲染结果完全正常**，只是顺序错。
3. **取序函数签名 MUST NOT 含比较器 / 排序键**（`FR-002`）——这是「排序不在客户端」的**结构保证**而非事后约定。想在客户端排就必须先改签名，那一步 review 看得见。
4. **四个档位函数改签名后调用点全改**（plan D-TIER）——漏一处会让那一列还在读 legacy 标量，切视角时它不变色而**别的列变了**，看起来像数据错乱不像漏改。
5. **greeks 缺失行费率照算**（`FR-013`）——server 的 `rateOf` 只吃 `premium`，greeks 不参与；null 的是**档位**不是费率。🚨 mockup 首版把这画错过，别照着错的实现。
6. **就地说明移出常驻区是 `SC-009` 的前提**（plan D-GATES）——只加不移会让常驻区**上升**，直接违反。
7. **计数降权靠去色不靠压对比度**（`FR-008`）——计数是真数据（只是为 0），不是占位符。mockup 阶段踩过：`text-subtle` 掉到 2.85:1，那是「看不清」不是「不抢眼」。
8. **空态与计数是同一个设计**（`FR-009`）——拆成两个 task 各做各的必然对不齐（一个说「被挡了 20 条」另一个说「没有符合条件的腿」）。
9. **表宽与列集零改动**（`SC-011`）——为放标改列宽会触发 `049` 的横滑几何回归（ADR-0063 方案 E）。
10. **hermetic mock 的 `tabOrder` 与 `gateCounts` MUST 从数据派生**（plan Testing Invariant 2）——写死数组会与被 mock 的服务端不变量当场矛盾；`gateCounts` 拍脑袋填会让 `SC-012` 的不等式判据失去意义。
11. **regen 后先 `rg` 捞全部手写 mock 工厂**（`feedback_new_export_grep_mock_factories`）——新字段 required，`050` 靠 typecheck 一层层剥花了三轮 ~90s。一次性 `rg 'excludedFromIntentTabs' apps/mobile` 捞全（含 `e2e/`）。
12. **文案复核 MUST 人工逐条过**（`SC-008`）——文案断言自指（`expect(text).toBe(COPY.x)`，改成什么都绿），测试对这一层**结构性无效**。

---

## Phase 1: 服务端计数增量 + 契约（阻塞 mobile 的空态分支）🎯

- [X] T001 [Server] **`excludedFromIntentTabsByTab` 拆计数**（FR-006a, plan D-GATES-2, D-TEST-0）：在 `get-legs.usecase.ts` 内按意图视角分别统计「期限段合格但被流动性门槛挡下」的条数。**复用召回层已算出的视角成员**（`intentTabsByTerm` 的输出），🚫 MUST NOT 新建 rules 文件、MUST NOT 复制一份判据。既有标量 `excludedFromIntentTabs` **保持不变**（契约只加不删）。
      📌 **impl 期定案**（2026-08-12）：`intentTabsByTerm` 是私有函数，且流动性挡下时 `recallTabs` 返 `['all']` ⇒ 期限段信息已被抹掉 ⇒ 只改 usecase 就只能重写一遍判据（本条自禁，且撞 `check-optionsdesk-rule-constants.ts` 的阈值单点）。⇒ `leg-recall.rules.ts` 新增导出 `intentTabsExcludedByLiquidity(ctx, leg): LegIntentTab[]`（`passesLiquidityGate ? [] : intentTabsByTerm(...)`，**零判据改动**），标量与两个分视角数在 usecase 内**同一次求值**上累加 ⇒ `标量 ≤ build + rent` 由结构保证而非测试守。布尔版 `isExcludedFromIntentTabsByLiquidity` 随之**退役**（本次改动产生的 orphan，且留着即留一条问同一问题的旁路），其 spec 改指数组版。→ verify: `optionsdesk-051.gate-counts.it.spec.ts`（Medium，Testcontainers 真 PG）红→绿 —— ① 建仓数与实际被挡的建仓候选**逐条相等** ② 收租数同 ③ 🚨 **重叠区不变量取不等式**：构造一条 `DTE ∈ [30,49]` 且过有效成本、被流动性挡下的腿，断言 `标量 ≤ build + rent` 且**该腿使两个分视角数各 +1 而标量只 +1**；**先证明 `toBe(build + rent)` 会红**再改成不等式
- [X] T002 [Contract] **DTO 加字段 + OpenAPI + api-client regen**（FR-006a, FR-023, plan §V）：`optionsdesk.dto.ts` 的 `LegGateCountsResponse` 加 `excludedFromIntentTabsByTab: { build, rent }`（`@ApiProperty` 齐全）→ `nx run server:export-openapi` → `packages/api-client` regen → verify: `openapi.json` 结构 diff **零删除零改名零改值**（只新增叶子）；变异验证「删掉新字段的一处 description」→ 脚本 exit≠0 且逐条点名；🚨 **regen 前先 `rg 'excludedFromIntentTabs\|LegGateCounts' apps/mobile` 一次性捞全手写 mock 工厂**（含 `e2e/`），逐处补齐后再跑 typecheck，别逐层剥；🚨 **FR-023 的机械判据**（2026-08-12 impl 期订正 —— 原判据「任何第三个 server 文件出现即越界」自相矛盾：它既够不着 plan `D-TEST-0` **强制新建**的 server IT，也让 T001 无法在不复制判据的前提下实现）：作用域取 **`apps/server/src/` 下的非 spec 文件**，允许集 = `get-legs.usecase.ts` + `optionsdesk.dto.ts` + `leg-recall.rules.ts`（后者**仅暴露已有派生**，零判据改动，见 T001）。命令 `git diff --name-only origin/main -- 'apps/server/src' | rg -v '\.spec\.ts$'`，出现第四个文件即越界；判据本身仍是 FR-023 的原话「**零判据改动**」，文件清单只是它的机械代理。
      🚨 **基线取 `origin/main` 而非 `main`**（impl 期实测踩中）：本地 `main` 停在 `#21`，而 `050` 是 `#23` ⇒ 用 `main` 当基线会把 `050` 改过的 `leg-mark` / `leg-rank` / `leg-tab` / `earnings-mark` 四个文件**误报成 051 越界**。这条探针自己会说谎，先排除假阳性再下结论

## Phase 2: 顺序与成员（US1，阻塞 e2e）

- [X] T003 [Mobile] **按 `tabOrder` 取序 + `filterLegsByTab` 退役**（FR-001, FR-002, FR-003, FR-004, plan D-ORDER, D-TEST-1）：`leg-picker.rules.ts` 新增取序纯函数（建 `Map<code, leg>` 一次 → 按 `tabOrder[tab]` 映射，`O(n+m)`），🚨 **签名 MUST NOT 含任何比较器 / 排序键入参**；`filterLegsByTab` **整条删除**（含其 `leg.tabs.includes` 判据）→ verify: Small 单测红→绿 —— ① 渲染序与 `tabOrder` **逐行相同** ② `tabOrder` 有而 `legs[]` 定位不到的 code **跳过且不崩** ③ 三视角来回切顺序不变 ④ 空列表返空数组而非 null；机械判据 `rg '\.sort\(' apps/mobile/src/optionsdesk/ -g '!*.spec.*'` **零命中**，且 🚨 **先证明它会红**（故意加一次 `legs.sort(...)`，扫描必须报出该行，改回后归零）
- [X] T004 [Mobile] **屏级接线 + 既有行为回归**（📌 接线本身随 T003 一同落地以保 typecheck 绿；本 task 实际交付 = 两条否定式约束的兑现 + 全套 e2e 回归）（FR-001, FR-005, FR-021, FR-022, plan D-ORDER）：`use-leg-table.ts` / `underlying-detail.rules.ts` 的 sections 改由有序列表构建；空视角仍返 `data: []` 而非零 section（FR-005 沿用既有约定）→ verify: `nx run mobile:test` 绿；既有 `optionsdesk-chain-leg-picker.spec.ts` e2e 不红（若红 → 逐条判「该红 / 不该红」，🚫 MUST NOT 批量改绿）；🚨 **两条否定式约束在此兑现** —— **FR-021**：三视角的**成员集合**与本片开工前逐条相同（本片只改顺序与呈现，不改「哪条腿出现在哪」）；**FR-022**：链未就绪 / 读取失败两个既有显式状态的行为一字不变（`legBlockState` 的分支与文案均未动）

## Phase 3: 档位与费率口径（US4）

> 🚨 **T005 与 T006 不可并行**（2026-08-12 analyze F3）：两者都要改 `underlying-detail-screen.tsx` 的 props 调用点，且两处**相邻**（`LegTableHeader` 与 `LegRow` 前后脚）。并行的冲突表现是 merge 冲突或静默覆盖，**不是编译错误**。

- [X] T005 [Mobile] **四个档位函数改吃档位值**（FR-015, FR-016, plan D-TIER, D-TEST-1）：`leg-picker-copy.ts` 的 `legBidTone` / `legRowToneClass` / 动作文案 / 费率副标四处，签名由「吃 `leg`」改为「吃 `tier: LegTier | null`」；`leg-row.tsx` 取一次 `leg.tierByTab[tab]` 传下去（**同源，四处不会 drift**）；⚠️ `LegRow` 现役 props **没有 `tab`**，需在 `underlying-detail-screen.tsx` 的调用点补传→ verify: Small 单测覆盖四档 + `null` 缺省态；机械判据 `rg 'leg\.tier\b' apps/mobile/src/optionsdesk/ -g '!*.spec.*'` **零命中**（契约保留该字段是「只加不删」的要求，不是让客户端继续用）
- [X] T006 [Mobile] **费率口径取自 `basisByTab` + 列头即口径**（FR-017, FR-017a, FR-018, plan D-BASIS, D-TEST-1）：删 `RATE_SUB_BY_TAB` 硬编码；新增 `rateHeaderFor(basisByTab, tab)` 返回 `{ main, sub }`（`weekly` → 周化 + 折年参照；`annualized` → 年化 + 无副标）；`leg-table-header.tsx` 列头**直接是口径本身**，🚫 不套「费率」这层通用标题；⚠️ `basisByTab` 来自 `legTable.table`，需在 `underlying-detail-screen.tsx` 的 `LegTableHeader` 调用点改传 → verify: Small 单测含 `Record<LegBasis, …>` 穷举 **+ 运行时未知取值兜底**（server 可能先于客户端上线新取值，类型层骗不了运行时）；12 列表头内容自然宽 ≤ 列宽（mockup 阶段实测原两行结构在 56px 下撑破）

## Phase 4: 两个标 + 徽标退役（US3）

- [X] T007 [Mobile] **钉住列加两个标 + 撤口径徽标**（FR-011, FR-011a, FR-013, FR-014, FR-014a, FR-014b, FR-019a, plan D-MARK）：`leg-row.tsx` 钉住列 line1 加「贴合」两字描边标（`isRecommended`）、line2 加「月」描边标（`isMonthlyChain`，**贴到期日**）；删 `showsBasisBadge` / `BASIS_BADGE` / `BASIS_BADGE_BORDER` 三个符号及其 orphan。🚨 措辞 **MUST** 读作「贴合当前意图」，🚫 MUST NOT 用 success/绿系（会读成「建议买入」）；两个标 **MUST 同载体、以视觉权重区分**，🚫 MUST NOT 让其中一个退化成纯几何符号 → verify: `rg 'showsBasisBadge\|BASIS_BADGE'` 零命中；typecheck + lint 绿；表宽 `716` 与 `LEG_TABLE_COLUMNS` 逐项**未变**（SC-011）

## Phase 5: 计数与空态（US2）

- [X] T008 [Mobile] **就地说明移出常驻区 + 计数区落 `LegBlockNotice`**（FR-006, FR-007, FR-007a, FR-010, FR-010a, FR-012, plan D-GATES, D-TEST-1）：把既有 notices 从 `LegPickerTabs`（**在常驻区内**）搬到 `renderSectionFooter`；计数区两条**语义不对称**（权利金「三个视角都看不到」纯文字无入口 / 流动性「仍在全腿视角」可点 → `setTab('all')`）；为 P3 第二对计数留位 → verify: Small 单测覆盖两条措辞的判别性；`LegPickerTabs` 的 `notices` prop **已退役**（`rg` 零命中）
- [X] T009 [Mobile] **空态按该视角自己的排除数分支 + 计数为 0 降权**（FR-008, FR-009, plan D-GATES, D-GATES-2, D-TEST-1）：空态文案取 `excludedFromIntentTabsByTab[tab]`（🚫 **MUST NOT 用全表标量**）；两数皆 0 时计数区降权，🚨 靠**去掉主色 + 缩字号**，MUST NOT 压低对比度 → verify: Small 单测 —— ① 该视角排除数 > 0 → 指向门槛 + 带入口 ② 为 0 → 指向「该期限段确实没有」+ 无入口 ③ 🚨 **`SC-013` 交叉验证**：构造「建仓排除数 0、收租排除数 > 0」的数据，断言**建仓空态仍指向「确实没有」**——这条正是取 B 要买的东西，不验等于没买

## Phase 6: 文案复核与验证收口

- [X] T010 [Mobile] **047 时代文案逐条复核**（FR-019, FR-019b, FR-019c, FR-020, plan D-COPY）：订正 `rentDepthUnionNote`（现文案「水位未选 → 展示全部 Δ 档」描述的是 047 召回行为；`050` 后 Δ 与水位**结构性地不在收租召回入参里** ⇒ 成员集合一条不变，差别只在零推荐标）；全量过一遍 `optionsdesk-copy.ts` 里描述判定逻辑的文案 → verify: 🚨 **人工逐条过**（测试对这一层结构性无效），复核结论与「共查 N 条、订正 M 条」写进 commit message；🚨 **若发现第三处**（spec Assumptions 已预留该分支）→ 按同一判据处置**并回写 spec 的 Assumptions 与 `FR-019`**，不许只在 commit message 里提一句就过
- [X] T011 [Mobile-E2E] **hermetic UI e2e 新建**（SC-001, SC-003, SC-005, SC-006, SC-013, plan D-TEST-2）：`apps/mobile/e2e/optionsdesk-leg-display.spec.ts` —— 三视角口径差异（同一条腿两处档位不同）· 顺序与 mock 的 `tabOrder` 逐行相同 · 流动性计数点击后落全腿视角 · 两种空态文案互不相同 · 推荐标处处同值 → verify: `nx run mobile:e2e` 绿；🚨 mock 的 `tabOrder` 与 `gateCounts` **从数据派生**（Guardrail 10）
- [ ] T012 [Contract-Smoke] **契约冒烟扩到七个字段**（`050` plan §V 推给本片的义务, plan D-TEST-3）：扩 `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts` —— P1 六个字段 + 本片的 per-view 计数，在**生成客户端 + 真 server**下验形状与一致性（`tabOrder[t]` 元素集合 == `{code | t ∈ leg.tabs}` · `tierByTab` 非成员恒 null · `basisByTab` 取值域 · 计数不等式）→ verify: `nx run mobile:contract-smoke` 绿。📌 这六个字段迄今只被 server IT 与手写 mock 验过，「生成客户端 + 真 server」这条缝**从未合过**
- [ ] T013 [Docs] **真机验收 + 回填主 plan**（SC-009, SC-010, plan D-TEST-4）：Mate50 dev-client 实测常驻区高度（**预期下降**，因就地说明已移出）与 730 行量级的切视角 / 滚动流畅度；回填主 plan 的 P2 行 ✅ + §2.3 逐条打勾 + P2 退出标准 → verify: 常驻区高度 **严格不高于**开工前基线（网页端读数仅参考，`049` 实测 web 185 vs 真机 161dp 差 13%）；主 plan 已更新

---

## Dependencies & 执行顺序

```text
T001 → T002 ─┐
             ├→ T009（空态需要 per-view 计数）
T003 → T004 ─┴→ T011（e2e 需要顺序与成员就位）
T005 → T006（**串行** —— 同改 underlying-detail-screen.tsx 的相邻调用点，analyze F3）
T007 → T011
T008 → T009 → T011
T010（独立，随时可做）
T011 → T012 → T013
```

- **T001/T002 排最前**：它们阻塞 T009 的空态分支，且契约改动越早落地，mobile 侧的 mock 工厂返工越少。
- **T005 / T006 串行**：初版标了 `[P]`，analyze 时发现两者都改 `underlying-detail-screen.tsx` 的 props 调用点（`LegRow` 补 `tab` / `LegTableHeader` 改 `basisByTab`），且两处相邻 ⇒ **本片无可并行的 task**。
- **T010 独立**：文案复核不依赖任何实现。

## Clear 检查点批次

1. **批次 A**：T001 – T002（server + 契约）
2. **批次 B**：T003 – T004（顺序与成员）
3. **批次 C**：T005 – T007（档位 / 口径 / 标）
4. **批次 D**：T008 – T009（计数与空态）
5. **批次 E**：T010 – T013（文案 + 三层验证 + 收口）

## Acceptance Scenario 覆盖矩阵（21 条 → task，逐条 1:1）

| US | # | 场景 | 归属 task |
| --- | --- | --- | --- |
| US1 | 1 | 渲染顺序与下发列表逐行相同 | T003 · T011 |
| US1 | 2 | 不在列表内的腿不出现（不重算成员） | T003 |
| US1 | 3 | 来回切视角顺序不变 | T003 · T011 |
| US1 | 4 | 空视角仍可进入并显空态 | T004 |
| US2 | 1 | 权利金计数呈现 + 措辞表达「三视角都看不到」 | T008 |
| US2 | 2 | 流动性计数呈现 + 可点切全腿 | T008 · T011 |
| US2 | 3 | 权利金计数**不提供入口** | T008 |
| US2 | 4 | 两数皆 0 → 降权 | T009 |
| US2 | 5 | 空 + 排除数 > 0 → 指向门槛 | T009 · T011 |
| US2 | 6 | 空 + 排除数 0 → 指向「确实没有」 | T009 · T011 |
| US3 | 1 | 推荐标处处同值 | T007 · T011 |
| US3 | 2 | 收租意图下建仓视角的标按收租档带 + 就地说明 | T007 · T008 |
| US3 | 3 | 待定 / 不开新仓 → 全表零推荐标 | T007 |
| US3 | 4 | greeks 缺失恒无标但照常在表内 | T007 |
| US3 | 5 | 月度到期日下全部腿带标（不自行推断） | T007 |
| US4 | 1 | 同一腿两视角档位不同 | T005 · T011 |
| US4 | 2 | 不判档显缺省态，不回落 | T005 |
| US4 | 3 | 费率口径取自服务端映射 | T006 |
| US4 | 4 | 未知口径取值 → 缺省态不崩 | T006 |
| US5 | 1 | 未选水位的就地说明如实描述 | T010 |
| US5 | 2 | 全腿视角口径徽标**已不存在** | T007 · T010 |

## state_branch 覆盖矩阵（24 条 → task）

| # | 分支 | 归属 task |
| --- | --- | --- |
| 1–2 | 在 / 不在有序列表 → 渲染 / 不渲染 | T003 |
| 3 | 有序列表为空 → 可进入 + 空态区分两因 | T004 · T009 |
| 4–5 | 两视角档位不同 / 不判档缺省 | T005 |
| 6 | 推荐标处处同值 | T007 |
| 7 | 收租意图 + 建仓视角 → 按收租档带 + 说明 | T007 · T008 |
| 8 | 待定 / 不开新仓 → 零推荐标 | T007 |
| 9 | greeks 缺失 → 恒无标但照常在表 | T007 |
| 10–11 | 月度 / 非月度到期日 | T007 |
| 12–13 | 两个门槛计数各自的措辞语义 | T008 |
| 14 | 两数皆 0 → 降权 | T009 |
| 15–16 | 费率口径取自服务端 / 未知取值兜底 | T006 |
| 17 | 读失败 / 链未就绪 → 沿用既有两状态 | T004（回归，本片 MUST NOT 改其行为） |
| 18 | 水位未选 → 收租成员集合不变 | T010 |
| 19 | 流动性计数可点 / 权利金计数无入口 | T008 |
| 20 | 带标却不属于任何意图视角 → 照实显示零区分 | T007 |
| 21 | 全腿视角无口径徽标 | T007 |
| 22–23 | 空态按**该视角自己的**排除数分支 | T009 |
| 24 | 重叠区腿：标量 ≤ build + rent | **T001** |

## Edge Case 覆盖（7 条 → task）

| # | Edge Case | 归属 task |
| --- | --- | --- |
| 1 | 带推荐标却不属于任何意图视角 | T007 |
| 2 | 有序列表有 code 而腿本体无（或反之） | T003 |
| 3 | 两计数一 0 一非 0 → 只呈现非零那条的说明 | T009 |
| 4 | 看表过程中意图变化 → 标全变而集合与顺序不动 | T011 |
| 5 | 三视角同时为空 | T004 · T009 |
| 6 | 月度日遇非交易日前移 | **故意零 task**（见下） |
| 7 | 730 行量级的逐行渲染成本 | T013 |

## SC 覆盖（13 条 → task）

| SC | 归属 task |
| --- | --- |
| SC-001 顺序逐行相同 | T003 · T011 |
| SC-002 客户端排序调用零命中 | **T003**（含「先证明它会红」） |
| SC-003 计数显示值与下发值逐次相等 | T008 · T011 |
| SC-004 两种空表文案互不相同 | T009 · T011 |
| SC-005 推荐标处处同值 | T007 · T011 |
| SC-006 至少 1 条腿两视角档位不同 | T005 · T011 |
| SC-007 greeks 缺失腿可见且无标 | T007 |
| SC-008 文案逐条复核 | **T010**（人工，测试无效） |
| SC-009 常驻区高度严格不高于基线 | **T013**（真机） |
| SC-010 730 行流畅度不劣于 | **T013**（真机） |
| SC-011 表宽与列集零改动 | T007 |
| SC-012 per-view 计数逐次相等 + 重叠区不等式 | **T001** |
| SC-013 交叉视角空态不受另一视角影响 | **T009** |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

- **Edge Case #6「月度到期日遇非交易日被前移」** —— 该情形对客户端**不构成分支**：客户端只消费服务端下发的 `isMonthlyChain`，前移与否已在服务端解析完毕。写进 Edge Case 是为了**记录它不该有客户端分支**，正是 `FR-014` 禁止客户端按「是不是周五」推断的理由。⇒ 不派生 task、不派生测试。

## MVP

**T001 – T004**（server 计数 + 契约 + 顺序与成员）。到此为止表已经是**可信的**（顺序正确、空视角可进入），其余四块是可读性。
🚨 但 **`US2` 不可从 MVP 剥离到最后** —— P1 用「腿会消失」换候选集干净，计数是这笔交易的唯一对价；只上 MVP 而不上 `US2`，等于让「腿消失」这件事在产品里裸奔一段时间。

## 单 PR（Constitution §V）

本片是**跨端 feature**（server 计数增量 + 契约 + mobile 消费）⇒ 单 PR 原子 merge，同 PR 内含 `export-openapi` + api-client regen + **两层验证**（`[Mobile-E2E]` T011 + `[Contract-Smoke]` T012）。
