---
feature_id: 077-optionsdesk-rent-window-budget
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-09-07'
updated_at: '2026-09-07'
---

# Tasks: 077-optionsdesk-rent-window-budget（收租候选窗由「码数预算」决定）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)

**病根一句话**：068 用两段式替换 064 矩形窗时**只替换了正常日那一支**，零 Δ 面（新锚首日）的 `bootstrapWindowFor` 至今返回 064 那个 `[0.7×spot, 1.05×spot]` 矩形 —— 它的行权价**下界与收租判据毫无关系**，把美股 159 条 / 港股 30 条完全合格的腿挡在外面，且挡掉不产生任何可观测信号。⇒ **本片不是新设计，是把 068 的替换做完。**

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §小节; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract-Smoke]` / `[Mobile]` / `[Mobile-E2E]` / `[Docs]` / `[Gate]` / `[Ops]`。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途                                              | 路径                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 新纯函数落点 + 建仓比例表注释改写                 | `apps/server/src/optionsdesk/leg-window.rules.ts`（+ 同名 spec）                                                        |
| 复用的两个「全仓唯一落点」                        | `apps/server/src/optionsdesk/leg-recall.rules.ts`（`resolveCeilingAxis` `:460` · `QUALITY_CEILING_SPOT_RATIO` `:150`）  |
| bootstrap 支按 intent 分叉 + 服务端记录           | `apps/server/src/optionsdesk/leg-retrieval.adapter.ts`（`:483-489` 分支 · `:494` 窗口日志 · `:497-503` 超限守卫）        |
| 预算上限来源（只消费不重定义）                    | `apps/server/src/marketdata/option-snapshot.port.ts:95` `OPTION_SNAPSHOT_MAX_CONTRACT_CODES`                            |
| 计数出参（port）                                  | `apps/server/src/optionsdesk/leg-retrieval.port.ts`（`LegRetrievalResult` `:266-284`）                                  |
| 计数出参（测试替身，编译器逼出）                  | `apps/server/src/optionsdesk/fake-leg-retrieval.adapter.ts:88` 附近                                                     |
| 计数上行 + 空态取 0                               | `apps/server/src/optionsdesk/get-legs.usecase.ts`（`LegTableView` `:426-434` · 空态 `:593-598` · 装配 `:660`）          |
| 契约字段 + swagger 说明                           | `apps/server/src/optionsdesk/optionsdesk.dto.ts`（`candidateCapDropped` `:2359` / `:2609` 同位）→ `apps/server/openapi.json` → `packages/api-client` |
| Server IT（改既有，加臂 + **翻一条绊线**）        | `apps/server/test/integration/optionsdesk-068.two-stage.it.spec.ts`（`T006 ①` `:554-573` · `⑤` `:648-666`）             |
| 「没塞进 `gateCounts`」的机器判据（保持绿）       | `apps/server/test/integration/optionsdesk-051.gate-counts.it.spec.ts:363`                                               |
| golden JSON 基线（手写镜像，typecheck 逼不出）    | `apps/server/test/integration/optionsdesk-064.baseline.json`（3 处）· `optionsdesk-070.baseline.json`（4 处）           |
| contract-smoke 顶层闭合键集（手写镜像）           | `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts:441-487`                                       |
| mobile 计数行 + 文案                              | `apps/mobile/src/optionsdesk/leg-picker.rules.ts`（`legCandidateCapLine` `:408-412` 为样板）· `optionsdesk-copy.ts:297-303` |
| mobile 屏接线                                     | `apps/mobile/src/optionsdesk/underlying-detail-screen.tsx`（`:463` 计数区 · `:666` props · `:871` `LegGateLine`）        |
| mobile mock 工厂（**9 个 e2e spec + 1 个单测夹具**，均标 `LegTableResponse` ⇒ typecheck 逼出）| `apps/mobile/e2e/optionsdesk-{march-audit,intraday-tiers,offline-ladder,chain-report,detail-thermometer,chain-leg-picker,query-pushdown,criteria-sheet,leg-display}.spec.ts` + `apps/mobile/src/optionsdesk/leg-picker.rules.spec.ts`（实时 grep 判据：`rg -l candidateCapDropped apps/mobile` —— 那是同族顶层字段）|
| 071 SC-004 supersede 注记                         | `specs/071-optionsdesk-hk-realtime-recall/spec.md:143`                                                                  |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **`resolveCeilingAxis` MUST 调、MUST NOT 内联 `Decimal.min(spot, w)`** —— `axis = min(spot, W)` 的 `min` 全仓恰好一处（`leg-recall.rules.ts:460`），是 067 SC-003 的机器判据。
2. **`QUALITY_CEILING_SPOT_RATIO` MUST 引用、MUST NOT 写 `1.03`** —— `check-optionsdesk-rule-constants.ts` 不变量 #9 的 `INLINE_COEFFICIENT_RE`（`.times(new Prisma.Decimal('…'))`）**扫描面不设豁免**，写字面量当场红。正确形态：`axis.times(QUALITY_CEILING_SPOT_RATIO.plus(1))`。
3. **窗口只取成色上界的比例项，MUST NOT 取完整上界**（plan §语义过滤）—— 结构项 `min{K ≥ axis}` 要先知道链上有哪些档，而窗的作用正是决定去问哪些档。比例项是完整上界的**超集**，方向安全。
4. **建仓支一字不动**（`FR-009` / `SC-004`）—— 建仓无行权价上界（`leg-recall.rules.ts:636` `strikeMax: null`），没有可用于语义过滤的上界；实测最大 324 < 399，无需处置。
5. **`window_over_cap` 守卫保留**（`leg-retrieval.adapter.ts:497-503`）—— 建仓仍需要它；收租侧它变成构造上不可达的兜底。🚫 **MUST NOT 因为「收租用不到了」删掉**。
6. **`STRIKE_ENVELOPE_FLOOR_SPOT_RATIO_BY_MARKET` 保留**（建仓仍消费）—— 只改注释，🚫 不删常量、不改取值（`FR-011`）；改完确认不变量 #9 仍绿。
7. **裁剪计数 MUST NOT 进 `gateCounts`**（spec Q2 📌 ②）—— 走 `LegTableResponse` 顶层字段。`optionsdesk-051.gate-counts.it.spec.ts:363` 的 `toEqual` 是机器判据，塞进去当场红。
8. **mobile 那条计数为 0 时整条不渲染** —— 仿 `legCandidateCapLine`，🚫 MUST NOT 塞进 `legGateCountLines()`（那两条恒渲染，而本计数实测恒为 0）。
9. **文案不带「· 仍在全腿视角」**（spec Q2 📌 ①）—— bootstrap 场景下离线路径必返 null，全腿视角恒「未就绪」，那半句是空承诺。
10. **新增 public 字段必 grep 三类手写镜像**（#379）—— 本片已查实：contract-smoke 顶层闭合键集 + 两份 golden JSON 基线**都逼不出 typecheck**，`nx affected` 绿不代表它们绿；mobile 那 10 处则**逼得出**（都标了 `LegTableResponse`），但要跑 `mobile:typecheck` 而非 `test`。🚨 **数量一律实时 grep 别抄本表**（本表的「9 + 1」是 2026-09-07 analyze 期数的）。
11. **注释出处**（comment-provenance）—— 涉及供应方单批上限语义的注释一律 `EVIDENCE:` 指向 `option-snapshot.port.ts:95` 或 spec 取证节，🚫 禁裸断言。
12. **MUST NOT 改「何时判定为零 Δ 面」**（spec Assumptions 4 / Out of Scope 4）—— 本片只改「判定**之后**用哪个窗」。判定单点是 `leg-retrieval.adapter.ts:465-467` 的 `previousSpot === null`，🚫 一字不动。改了它本片射程就从「零 Δ 面那一支」漏到正常日，而那要等 T002-③ 或 068 臂① 才红，不是当场可见。

## Tasks

- [X] T001 [Server] **新纯函数 `rentBootstrapBudgetWindow` 落 `leg-window.rules.ts` + 建仓比例表注释改写**（FR-001, FR-002, FR-004, FR-005, FR-008, FR-010, FR-011; plan §落点与分叉 / §预算裁剪; state_branches 1/2/3/4; US1/US2/US3）：新增导出

  ```ts
  export interface RentBootstrapWindowSelection {
    /** 入窗的行权价键（`Prisma.Decimal.toString()`，与 Δ 带支的 `windowKs` 同款键形态）。 */
    readonly strikes: ReadonlySet<string>;
    /** 被**预算**裁掉的合约码条数 —— `FR-007` 屏上计数的唯一数据源。未裁剪恒 0。 */
    readonly trimmed: number;
  }
  export function rentBootstrapBudgetWindow(input: {
    readonly strikes: readonly Prisma.Decimal[]; // 一个合约一项，同档重复出现
    readonly spot: Prisma.Decimal;
    readonly w: Prisma.Decimal;
    readonly budget: number;
  }): RentBootstrapWindowSelection;
  ```

  算法（`O(n + m log m)`，n = 合约数、m = 相异档数，注释里写明）：① `axis = resolveCeilingAxis(spot, w)`、`ceiling = axis.times(QUALITY_CEILING_SPOT_RATIO.plus(1))`，滤掉 `K > ceiling`（**无下界**，`FR-003` 的构造面）② 按 `K` 分组计合约数 ③ 档按 `|K − axis|` 升序、**同距取 `K` 较小者**（plan §预算裁剪 2 的裁决：更深虚 = 收租更保守；上游 `findMany` 无 `orderBy`，不定次级键 `FR-008` 不成立）④ 逐档累加，`used + 该档码数 > budget` 即停 ⑤ `trimmed = 过滤后总码数 − 已纳入码数`。🚨 **被上界滤掉的 MUST NOT 计入 `trimmed`** —— 那是判据挡的，不是预算裁的，混在一起屏上那个数就没法解释。同一文件的 `STRIKE_ENVELOPE_FLOOR_SPOT_RATIO_BY_MARKET` 文档注释改写：`## 🚨 已知缺陷` 段补一句「**077 起收租不再消费本表**（零 Δ 面收租改走 `rentBootstrapBudgetWindow`，无行权价下界 ⇒ 该支的『下界高过上界 ⇒ 恒空』由构造消失）；本表自此**只服务建仓**，两个取值**未随 077 重新标定**（`FR-011`）。#308 的根治项（上界 W 派生形态）**仍开着** —— 美股建仓侧同形态未修」，🚫 常量与取值不动 → verify: `pnpm nx test server apps/server/src/optionsdesk/leg-window.rules.spec.ts` 九臂先红 → 绿：① K 任意低都进（下界已消失）、`K > axis×1.03` 不进 ② `W ≥ spot` ⇒ axis 退化为 spot，与退化前逐值相同（branch 4）③ 码数 ≤ budget ⇒ `trimmed = 0` 且 `strikes` 含全部过滤后档（branch 1）④ 码数 > budget ⇒ 按档距升序纳入、跨边界那档**整档不纳入**、`trimmed` 对得上（branch 2 + Edge「某档跨边界」）⑤ **恰好等于** budget ⇒ 不裁（闭区间 Edge）⑥ 同一 K 的三个到期日**同进同出**（`FR-001` 末句）⑦ 跨档等距并列（axis=100、K=98/102 各 1 码、budget=1）⇒ 取 98（`FR-008` 残余项）⑧ 上界之下一档都没有 ⇒ `strikes` 空 ∧ `trimmed = 0`（branch 3 + Edge，🚨 **不是**「被裁 N 条」）⑨ 输入数组打乱顺序两次求解逐值相同（`FR-008`）；`pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0（不变量 #9 的内联系数扫描 + 撞值扫描仍绿）；定向变异（**逐条钉一条 branch / 判据**，`SC-006`，六条全部留档）：a. 内联系数改写成 `.times(new Prisma.Decimal('1.03'))` → 守卫脚本红（Guardrail 2）· b. 去掉同距次级键 → ⑦ 红（`FR-008` 残余项 / EC5）· c. `used + 该档码数 > budget` 改成 `>=` → ⑤ 红（branch 1 + Edge「恰好等于上限」）· d. `resolveCeilingAxis(spot, w)` 换成裸 `spot` → ② 红（branch 4 轴退化）· e. 把**被上界滤掉的**也计进 `trimmed` → ⑧ 红（branch 3：「本就没有」MUST NOT 报成「被裁 N 条」）· f. 裁剪单位改回按合约码 → ⑥ 红（branch 2 的裁剪半）

- [X] T002 [Server-IT] **adapter bootstrap 支按 intent 分叉 + 服务端记录 + 翻 068 一条绊线**（FR-003, FR-006, FR-007 ①, FR-009, FR-010; plan §落点与分叉; state_branches 2/5/6/7/8/9; US1/US3）：`leg-retrieval.adapter.ts:483-489` 的 `surface.kind === 'bootstrap'` 分支按 `intent` 分叉 —— `intent === 'rent'` 走 `rentBootstrapBudgetWindow({ strikes: inSegment.map((c) => c.strikePrice), spot: basis.spot, w, budget: OPTION_SNAPSHOT_MAX_CONTRACT_CODES })`，再 `inSegment.filter((c) => selection.strikes.has(c.strikePrice.toString()))`（与 Δ 带支 `:491-492` 的 `ks` 用法同形）；`else` 分支**原样调 `bootstrapWindowFor`，一字不动**。`intent` 的类型是 `LegIntentTab = Exclude<LegTab, 'all'>`（`leg-recall.rules.ts:249`）⇒ 二分叉穷尽，全腿视角在 `:267-272` 就已分流到收盘档、走不到这里。`:494` 的 window-size 日志在裁剪发生时补 `trimmed=` 与裁剪前码数（`FR-007` ① 的「标的、意图、裁剪前后码数」；标的与意图该行已有），🚫 未裁剪时不改原行形态（避免既有 `shape=bootstrap` 断言误伤）。🚨 **翻绊线**：`optionsdesk-068.two-stage.it.spec.ts:554-573` 臂① 现断言 `contractCodes` **5 码**（矩形 `[0.7,1.05]×100` 罩住 K=80/88/92/96/104），077 后该臂走收租支 —— axis = `min(spot 100, W 120)` = 100、上界 `100×1.03 = 103` ⇒ **K=104 出局、4 码**；把断言与臂内注释一起翻，**同一 commit message 写明翻它的理由**（076 T001 / 071 FR-017 先例）。新增六臂：① 建仓 bootstrap 仍是矩形 5 码 —— 🚨 需**另铺 `dte ≤ 49` 的腿**（`BUILD_RECALL_DTE = [1,49]`，既有 `LEGS` 全是 `dte: 60` ⇒ 建仓 `inSegment` 为空，照抄夹具会得到一条平凡绿）（branch 7）② `hk` 锚收租 bootstrap 走同一函数、同一形态（branch 9，`FR-010`）③ 正常日 Δ 面（`snapshots: true`）收租候选**逐值零变化**（branch 6，`FR-006`；与改前基线对拍）④ 全腿视角仍零外呼、与离线逐值相同（branch 8）⑤ 预算裁剪真发生时**仍呈实时档**、`realtimeDegrade === null`、日志含 `trimmed=`（branch 2；夹具铺 > 399 码且全部落在上界之下）⑥ **语义过滤后零码 ⇒ 空态而非错误 / 降级**（branch 3 / US3-AS1）：`seedChain({ v: '90' })` ⇒ `W = 0.8 × 90 = 72`、`axis = min(spot 100, 72) = 72`、上界 `72 × 1.03 = 74.16` **低于最低行权价 80** ⇒ 零码；断言 `readPort.calls` 长度 **0**（零外呼）∧ `chain.realtimeDegrade === null` ∧ `chain.priceKind === 'realtime'` ∧ 候选集为空 ∧ 结果**非 `null`**（「有链无候选」是既有非错误形态，不是失败）。🚨 **本臂是 branch 3 唯一的响应形态断言** —— T001-⑧ 只证纯函数吐空集，证不了响应长什么样→ verify: `pnpm nx test server apps/server/test/integration/optionsdesk-068.two-stage.it.spec.ts` 先红（臂① 5→4）→ 翻臂 + 五新臂全绿，既有臂②/②b/③/⑤/⑥/⑦/⑧ 零变化；`pnpm nx run server:typecheck` 绿；定向变异（`SC-006`，三条全部留档）：a. 把建仓也接到新函数 → 臂① 红（branch 7）· b. 收租支改回 `bootstrapWindowFor` → **翻后的 068 臂①** 红（branch 5；原稿「去掉 intent 分叉」与 a 打在同一条臂上，已换）· c. 把新函数也接到 Δ 带 `else` 分支 → 臂③ 红（branch 6）

- [X] T003 [Server] **裁剪计数上行：port → usecase → 顶层契约字段 + golden 基线补键**（FR-007 ② server 半; plan §契约与前端; state_branches 2; US2）：`LegRetrievalResult` 加 `readonly batchCapTrimmed: number`（`leg-retrieval.port.ts:266-284`，doc 注释照 `memberCount` 体例写明「未裁剪恒 0」+ 🚨「它蓄意**不进** `gateCounts`：那两个数答『判据挡下了什么』，本数答『供应方一次只让问这么多』—— 两者处置完全不同，见 `get-legs.usecase.ts:428-433` 同款裁决」）；三个构造点补值（编译器逼出）：`leg-retrieval.adapter.ts:308` 收盘档路径取 `0`、`:614` 实时窄路径取 T002 算出的值、`fake-leg-retrieval.adapter.ts:88` 附近取 `0`。`get-legs.usecase.ts`：`LegTableView` 加同名字段（紧挨 `candidateCapDropped` `:434`，doc 注释指回 port）、空态 `:593-598` 取 `0`（注释沿用「它是计数不是『未知』」）、装配 `:660` 取 `retrieval.batchCapTrimmed`。`optionsdesk.dto.ts`：`LegTableResponse` 在 `candidateCapDropped`（`:2359`）旁加 `batchCapTrimmed!: number` + `@ApiProperty` 说明（「本轮候选码数超供应方单批上限，被按行权价档裁掉多少条 —— 这些腿本轮**未去问实时价**。未裁剪恒 0。EVIDENCE: 上限取值单点 `option-snapshot.port.ts:95`」）、`:2609` 同位补映射。🚨 **两类手写镜像 typecheck 逼不出，必须手补**：`optionsdesk-064.baseline.json`（3 处 `candidateCapDropped` 同位）· `optionsdesk-070.baseline.json`（4 处）各补 `"batchCapTrimmed": 0` → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-064.overlay.it.spec.ts apps/server/test/integration/optionsdesk-070.offline-ladder.it.spec.ts` 先红（golden 串多一键）→ 补键后绿，且 diff **只有新键这一行**（出现任何**值**变化即违 `SC-004`/`SC-005`，停下）；`pnpm nx test server apps/server/test/integration/optionsdesk-051.gate-counts.it.spec.ts` **保持绿**（`:363` 的 `toEqual` = Guardrail 7 的机器判据）；`pnpm nx run server:typecheck` 绿；定向变异：把字段塞进 `LegGateCounts` → 051 那一臂红（留档）

- [ ] T004 [Contract-Smoke] **openapi export + api-client regen + 顶层闭合键集**（FR-007 ② 契约半; plan §契约与前端; US2）：`pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`（🚨 漏了 export 直接 regen 会拿旧 json 静默生成，`git status` 干净、CI 全绿）。`apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts:441-487` 的顶层闭合键集按字典序在 `basis` 与 `candidateCapDropped` 之间插 `'batchCapTrimmed'`，上方补一行注释（「077 FR-007：预算裁剪计数 —— 与 `candidateCapDropped` 同族的**保险丝**，不是门槛计数」）；同文件 `:495` 的 `gateCounts` 键集**保持两键不动**（它是 Guardrail 7 的第二道机器判据）。加一条冒烟臂：收盘档路径下 `table.batchCapTrimmed === 0` 且键在册 → verify: `git diff packages/api-client apps/server/openapi.json` 只含新字段与其说明（出现无关类型 diff 即停）；`MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm nx run mobile:contract-smoke` 先红（键集封闭断言多一键）→ 补键后绿；定向变异：从键集里去掉该键 → 冒烟红（留档）

- [ ] T005 [Mobile] **裁剪计数行（保险丝款）+ 文案 + 屏接线**（FR-007 ② mobile 半; plan §契约与前端; state_branches 2; US2）：`leg-picker.rules.ts` 仿 `legCandidateCapLine`（`:408-412`）新增 `legBatchCapLine(table: Pick<LegTableResponse, 'batchCapTrimmed'> | null): LegGateCountLine | null` —— `table === null || table.batchCapTrimmed <= 0` ⇒ `null`（**整条不渲染**，Guardrail 8）；否则 `{ key: 'batch_cap', text: COPY.batchCapTrimmed(n), goTab: null, count: n }`。`LegGateCountLine['key']` 联合类型加 `'batch_cap'`（testID 自动派生成 `optionsdesk-detail-leg-gate-batch_cap`）。🚫 **MUST NOT 塞进 `legGateCountLines()` 的返回数组**，🚫 **MUST NOT 进 `legGateCountsQuiet()` 的判据**（那函数答「两个门槛数皆 0 要不要降权」，本行不为 0 才出现，进去会让降权逻辑自相矛盾）。`optionsdesk-copy.ts`（`:297-303` 同族位置）加 `batchCapTrimmed`（签名 `(n: number) => string`，产出「超单批上限，N 条未取实时」，N 即入参），**无 note 后缀**（Guardrail 9）。`underlying-detail-screen.tsx`：`:463` 计数区多传一个 prop（形态照 `truncation` / `candidateCap`），`LegGateLine`（`:871`）**零改动**复用。🚨 **位置由 mockup 钉死**（`design/handoff.md`）：渲染在 **gates 区块内**、`criteria.map` 与 `truncation` **之后**，🚫 **MUST NOT 像 `candidateCap` 那样在区块外另起一块** —— `FR-007` ② 要的是「同一版面区块」，另起一块就是另一款 → verify: `pnpm nx test mobile apps/mobile/src/optionsdesk/leg-picker.rules.spec.ts` 四臂先红 → 绿：① `batchCapTrimmed: 0` ⇒ `null` ② `> 0` ⇒ `count` / `text` / `goTab: null` 对得上 ③ `table === null` ⇒ `null` ④ 该行**不出现**在 `legGateCountLines()` 返回数组里（钉 Guardrail 8，`toHaveLength(2)`）；`pnpm nx test mobile` 全绿；🚨 `pnpm nx run mobile:typecheck` 绿 —— **e2e spec 不在 vitest 跑法里**，9 个 e2e mock 工厂 + `leg-picker.rules.spec.ts` 夹具补 `batchCapTrimmed: 0` 这件事只有 typecheck 逼得出来（它们都标了 `LegTableResponse` 返回类型，必填字段一加就红）；`pnpm nx run mobile:e2e -- optionsdesk-leg-display` 加一臂（mock 播 `batchCapTrimmed: 7` ⇒ 该 testID 出现且文案含 7；播 0 ⇒ 该 testID **不存在**）先红 → 绿；定向变异：`<= 0` 改成 `< 0` → ① 与 e2e 「播 0 不存在」臂红（留档）

- [ ] T006 [P] [Docs] **071 SC-004 supersede 注记 + 「候选恒空是正确答案」判据落档**（FR-012, FR-013; plan §Complexity Tracking）：`specs/071-optionsdesk-hk-realtime-recall/spec.md:143` 的 SC-004 末尾加一句「📌 2026-09 **superseded by 077**：美股收租候选集**会变** —— 077 去掉零 Δ 面收租窗的行权价下界，2026-09-07 实测放回 159 条本就合格却被窗挡住的腿，那正是 077 要修的缺陷。SC-004 的其余面（建仓 / 全腿 / 正常日 Δ 面）**仍然成立**，由 077 `SC-004` / `SC-005` 接管钉住」，🚫 不改 071 其余文字。`specs/077-*/spec.md` 的 `## 取证` §3 之后补一小节「### §8 『候选恒空是正确答案』的判据与识别方法（`FR-013`）」：写清 ① 判据 —— 在**完全不设窗、只按收租判据筛**的口径下可用腿仍为 0 ⇒ 空态正确 ② 识别方法 —— 该口径下的复算脚本形态与 2026-09-07 的结论（美股 19 只 + 港股 3 只属此类，估值远低于市价 ⇒ 愿买价之下不存在还能收租的认沽）③ 🚨 与「窗把腿关在外面」的区分点（后者在不设窗口径下可用腿 > 0，2026-09-07 有 5 只美股锚属此类，本片修的正是它们）→ verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；`rg -n "superseded by 077" specs/071-optionsdesk-hk-realtime-recall/spec.md` 命中 1；`npx prettier --check specs/077-optionsdesk-rent-window-budget/spec.md specs/071-optionsdesk-hk-realtime-recall/spec.md` 绿（🚨 正文里带下划线的标识符必须包 backtick，否则 prettier 静默改坏）

- [ ] T007 [Gate] **SC 收口 + 全量门 + PR**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007; US1/US2/US3）：spec 加「SC 收口」表（SC → 证据落点 → 形态，写判据形态不写 task 号）：SC-001 = T002 臂① 的差集面（131 只锚的逐只对拍由 T008 部署后承接，写明）· SC-002 = T001 臂③④⑤（**由定义论证**，断言不依赖任何标的数据）· SC-003 = T001 臂①⑧（① 非空 ⇒ 候选非空）+ 臂③④（候选 ≤ 预算）· SC-004 = T002 臂①④ + T003 两份 golden 基线 diff 判据 · SC-005 = T002 臂③ + 070 基线 · SC-006 = 各 task 变异留档 · SC-007 = T001 臂⑧ + T008 SQL；补 `state_branches` 覆盖说明；spec `status → implementing`、`updated_at` bump → verify: `git fetch origin && pnpm nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` exit 0（🚨 跑门前必 `git fetch`）；gate 脚本全 0：`check-optionsdesk-rule-constants` / `check-server-moat` / `check-test-size` / `check-time-semantics` / `check-identifier-boundary` / `check-repo-layout` / `check-api-property-nullable`；`gh-bot pr create` 按 `pr-creation-protocol.md` + `gh-bot pr merge --auto --squash --delete-branch`（纯读路径、零 DB 变更、可回滚，不属「不可逆」例外）；开完 PR 立刻切回 `main-base`

- [ ] T008 [Ops] **新锚首日真机取证（合并后勾，带触发条件而非固定日期）**（SC-001 的真数面, SC-007; state_branches 5; US1/US3）：🚨 **零 Δ 面无法按需构造** —— 近 30 天 prod 1447 个「标的×session」整面零 Δ **0 次**，该支只在**新锚首日**走（spec 取证 §6）。⇒ 触发条件 = **部署后第一只新建锚的当天**，在其收租视角走一次真机 / 模拟器，留档三项：① 候选腿数 > 0（若该锚属「不设窗也为 0」那一类则如实记空态，并按 T006 §8 的判据归类，**不算失败**）② 窗口日志 `shape=bootstrap` 且 `codes=` 不超 399 ③ 裁剪计数行按预期**不出现**（实测恒不触发）。另跑两条 prod 只读 SQL：① 全部锚在收租口径下「按判据合格」与「进候选」的差集为空或每条可归因（SC-001）② 2026-09-07 记为「不设窗时可用腿为 0」的 22 只锚候选仍为空（SC-007）→ verify: 三项留档 + 两条 SQL 输出回填本行与 spec「SC 收口」表；🚨 **开 task 时同步建 issue**，写明触发条件（非到期日）+ 兜底复查点「合并后第 30 天仍未触发则主动建一只测试锚验」（071 T010 纪律）；spec `status → implemented`

## 依赖与并行

```text
T001（纯函数）→ T002（adapter 分叉 + 翻绊线）→ T003（计数上行 + 契约 + 基线）→ T004（regen + 键集）→ T005（mobile）→ T007（门 + PR）→ T008（部署后）
                                                                                  T006 [P]（文档）────────────┘
```

- **T001 → T002**：adapter 分叉依赖纯函数已在。
- **T002 → T003**：`batchCapTrimmed` 的值由 T002 算出，T003 只负责把它送上去；拆两个 commit 是因为 T002 是**行为**改动（含翻绊线）、T003 是**契约**改动，混在一起 review 时分不清哪个 diff 对应哪条 FR。
- **T003 → T004**：openapi 必须在 DTO 落地之后导出。
- **T004 → T005**：mobile 消费的是 regen 出来的 `LegTableResponse` 类型。
- **T006 与任何 task 并行**（只改两份 spec 文本）。
- **T008 在 PR 合并、部署后、且撞上新锚首日时执行**（不阻塞合并）。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序**（071 实撞过错位一次）。

| #   | branch                              | 落点                                       |
| --- | ----------------------------------- | ------------------------------------------ |
| 1   | 收租 ∧ ≤ 上限 ⇒ 全进无裁剪          | T001-③                                     |
| 2   | 收租 ∧ > 上限 ⇒ 档为原子裁 + 上屏   | T001-④⑤⑥ + T002-⑤ + T003 计数链 + T005-② |
| 3   | 收租 ∧ 语义过滤后为空 ⇒ 空态        | T001-⑧（纯函数吐空集）+ **T002-⑥**（响应是空态而非错误 / 降级）|
| 4   | 收租 ∧ 锚定轴退化 ⇒ 逐值相同        | T001-②                                     |
| 5   | 收租 ∧ 零 Δ 面 ⇒ 同一套预算窗       | T002 翻后的臂① + T008 真机                 |
| 6   | 收租 ∧ 非零 Δ 面 ⇒ 逐值零变化       | T002-③ + 070 golden 基线                   |
| 7   | 建仓 ∧ 任意面 ⇒ 逐值零变化          | T002-① + 064/070 golden 基线               |
| 8   | 全腿 ∧ 任意面 ⇒ 逐值零变化          | T002-④ + 064/070 golden 基线               |
| 9   | 两市同一套窗口形态                  | T002-②                                     |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC                                | 落点                                              | 形态                              |
| --------------------------------- | ------------------------------------------------- | --------------------------------- |
| SC-001 合格腿与候选集差集为空     | T002-臂①（翻后）+ **T008 SQL ①**                  | 自动断言 + 部署后 SQL             |
| SC-002 码数恒不超上限             | T001-③④⑤                                          | 自动断言（**由定义论证**，不依赖标的数据） |
| SC-003 两条性质各有一条断言       | T001-①⑧（非空）+ T001-③④（≤ 预算）                | 自动断言                          |
| SC-004 建仓 / 全腿逐值相同零例外  | T002-①④ + T003 两份 golden 基线 diff 判据         | 自动断言 + golden 对拍            |
| SC-005 正常日 Δ 面逐值相同零例外  | T002-③ + `optionsdesk-070.baseline.json`          | 自动断言 + golden 对拍            |
| SC-006 每条 branch 能被变异证红   | **逐条**：b1=T001-c · b2=T001-f + T005 · b3=T001-e · b4=T001-d · b5=T002-b · b6=T002-c · b7=T002-a · **b8 / b9 见下方「结构性无可变异面」** | 7 条定向变异 + 2 条写明理由的零变异 |
| SC-007 「不设窗也为 0」的锚仍空   | T001-⑧ + **T008 SQL ②**                           | 自动断言 + 部署后 SQL             |

## Edge Case 覆盖预检

| EC                          | 落点 / 判决                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| EC1 锚定轴退化逐值相同      | T001-②（`resolveCeilingAxis` 承接，本片零特判）                          |
| EC2 上界之下一档都没有      | T001-⑧（`strikes` 空 ∧ `trimmed = 0`）+ T002-⑥（零外呼 ∧ 非降级）       |
| EC3 恰好等于单批上限        | T001-⑤（闭区间，`used + count > budget` 才停）                           |
| EC4 某档跨在预算边界上      | T001-④（整档不纳入，预算蓄意用不满）                                     |
| EC5 跨档等距并列            | T001-⑦（`FR-008` 的**残余项** —— 档为原子只消掉同档内并列，跨档等距仍需次级键） |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层）

| AS                                    | 落点                                     |
| ------------------------------------- | ---------------------------------------- |
| US1-AS1 低估值锚零 Δ 面合格腿全进候选 | T001-① + T002 翻后的臂① + T008           |
| US1-AS2 零 Δ 面与正常 Δ 面同源不少腿  | T002-③（正常日零变化）+ T001-①（零 Δ 面无下界）|
| US1-AS3 超上限时保留离轴最近的一批    | T001-④                                   |
| US2-AS1 大链锚码数不超上限且呈实时档  | T001-③④ + T002-⑤                         |
| US2-AS2 被裁后仍呈实时档不整表降级    | T002-⑤（`realtimeDegrade === null`）     |
| US3-AS1 真无合格腿 ⇒ 空而非凑         | T001-⑧ + **T002-⑥**（「而非错误或降级」那一半）+ T008 SQL ② |
| US3-AS2 空态能看到哪道判据筛掉的      | **蓄意零覆盖** —— 门槛统计是 051 既有能力，本片零改动（`gateCounts` 一字不动，T003 变异臂反向钉住） |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **US3-AS2**：051 既有能力，本片不动它；`optionsdesk-051.gate-counts.it.spec.ts` 保持绿即是覆盖。
- **零 Δ 面的真实触发**：结构上无法按需构造（近 30 天 prod 0 次），自动化只能落夹具层，真机证据挂 T008。
- **预算裁剪的真实触发**：今日数据恒不触发（收租窗最大 293 < 399），屏上那条计数**没有自然触发场景** ⇒ e2e 靠 mock 播值验（T005），T008 只验它**不出现**。
- 🚨 **branch 8 / 9 结构性无可变异面**（`SC-006` 的两条例外，写明而非遗漏）：
  - **b8 全腿逐值零变化** —— 全腿视角在 `retrieveCandidates`（`leg-retrieval.adapter.ts:267-272`）就被 `soleIntentView` 分流到收盘档，**结构上到不了 bootstrap 分支** ⇒ 没有承载本片改动的代码面可变异。正向覆盖由 T002-④ + 064/070 golden 基线承接。
  - **b9 两市同一套形态** —— 新函数**不吃 `market` 入参**（`LegIntentTab` 之外无第二个分叉维度），两市差异无处可落 ⇒ 由签名结构保证。要制造反例只能**新增**一个 market 参数，那是加代码不是改代码，证不出既有判据会红。正向覆盖由 T002-② 的 hk 臂承接。

## Implementation Strategy

MVP = **T001 → T002**（到这里 159 + 30 条静默缺腿已经回到候选集，5 只美股锚的假空态已消）。T003–T005 是「裁剪这件事可见」那一半的收口，T006 并行，T007 门，T008 撞上新锚首日再验。

Clear 检查点批次：`T001` / `T002` / `T003-T004` / `T005-T006` / `T007` / `T008`（每批次后停顿提醒 `/clear`，per Constitution §III；T001 九臂、T002 翻绊线 + 五新臂，各自单独成批）。
