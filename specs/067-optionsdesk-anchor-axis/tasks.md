---
feature_id: 067-optionsdesk-anchor-axis
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-29'
updated_at: '2026-08-29'
---

# Tasks: 067-optionsdesk-anchor-axis（收租成色上界换轴 — axis = min(spot, W)）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 P1 实施载体）+ [`ADR-0064`](../../docs/adr/0064-optionsdesk-retrieval-layering.md)（不变量 ③「每特征恰好一处」= D1/D2 单点设计的依据）
**Branch**: `067-optionsdesk-anchor-axis`
**病根一句话**：收租成色上界按纯 spot 锚定，回答的是「离现价多远」；而接货意愿由愿买价 W 定义 —— spot 显著高于 W 时，默认候选装进「按高于愿买价接货」的腿。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Server-IT]` / `[Gate]`。本片**无** mobile / contract shape 面（FR-008 值变形不变，`api-client` 零 regen）。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**（062 实撞纪律沿用）。

## Path Conventions

| 用途                               | 路径                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| 召回判据（改：context + 换轴单点） | `apps/server/src/optionsdesk/leg-recall.rules.ts`（+ 同名 spec）      |
| Prisma 检索 adapter（改：供 W）    | `apps/server/src/optionsdesk/leg-retrieval.adapter.ts`                |
| 假 adapter（改：夹具供 w）         | `apps/server/src/optionsdesk/fake-leg-retrieval.adapter.ts`           |
| 链报表 usecase（改：供 W）         | `apps/server/src/optionsdesk/get-chain-report.usecase.ts`             |
| W 派生单点（**只读复用，零改动**） | `apps/server/src/optionsdesk/anchor.rules.ts`（`computeW`）+ `anchor-cascade.ts`（`resolveEffectiveAnchorValues`） |
| Server IT（改 + 新增用例）         | `apps/server/test/integration/optionsdesk-064.overlay.it.spec.ts`     |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **`w` 必填不可选**（plan D1）—— 可选 + 缺省回退 spot = 静默旧轴，测试全绿 prod 错轴。tsc 编译红就是本片的构造点清单，逐个补而不是给默认值。
2. **W 派生零第二份**（FR-002）—— 三个供给点全走 `resolveEffectiveAnchorValues` + `computeW`；任何一处手写 `vManual ?? v` 或 `× 0.8` 即违规。
3. **adapter 的 anchor 读是 intra-ctx** —— 🚫 MUST NOT 挂 `// CROSS-CONTEXT-READ:`（假注释会污染 `check-server-moat` 审计链，064 resolveWindow 处有同款先例注释可对照）。
4. **既有 064 golden 基线 MUST 逐字符不变** —— 夹具 us:PEP 是 spot < W 域（V=150 ⇒ W=120 > spot=100），基线漂移 = 换轴改了不该改的域。🚫 MUST NOT 重新生成基线充数。
5. **build/全腿零变化按结构性验**（FR-003）—— 断言「同一批腿、W 取极端值（远低于/远高于 spot），build 与全腿候选逐值相同」，不要只测「intent 授权区内没变」。

## Tasks

- [X] T001 [Server] **rules 层换轴核心**（FR-001, FR-002, FR-003, FR-004, FR-007; plan §D1; state_branches 1/2/5/6/7/9; US1/US3）：`RecallContext` 增必填 `w: Prisma.Decimal`；`resolveQualityCeiling` 签名改 `(spot, w, legs)`、函数内部 `axis = Decimal.min(spot, w)`，结构项与比例项全部按 axis；`recallCandidates` 内 `resolveQualityCeiling(context.spot, context.w, legs)`；`leg-recall.rules.spec.ts` 全部 context 构造点补 `w` 并**先红后绿**新增六臂：① spot < W ⇒ ceiling 与旧轴逐值同 ② spot = W ⇒ 等值不分叉 ③ spot > W ⇒ 结构项 = min{K ≥ W} 且比例项 = W×1.03 取严 ④ axis 高于全部行权价 ⇒ 退化仅比例项（axis 版）⑤ FR-003 锚点：同批腿下 `w` 取 spot×10 与 spot×0.1 两极值，build 与全腿候选逐值相同 ⑥ 用户覆盖 strikeMax 原样生效、三态相对新默认（恰等于新默认 ⇒ `default`）→ verify: 六臂先红（对旧实现）→ 实现 → `pnpm exec nx test server -- --project unit` 绿；tsc 报出的其余构造点即 T002/T003 工作清单，本 task 不顺手修

- [ ] T002 [P] [Server-IT] **Prisma adapter 供 W + 双域 IT**（FR-002, FR-005, FR-006, FR-008; plan §D2/§D3; state_branches 3/4/8; US1/US2/US3）：`retrieveCandidates` 新增 anchor 点查（select `resolveEffectiveAnchorValues` 所需列，intra-ctx 禁跨 ctx 注释）→ `computeW(effective.v)` 供 context；`memberCount` 二次判定共用同一 context。IT（`optionsdesk-064.overlay.it.spec.ts` 新 describe）**先红后绿**四臂：① 低 V 锚（W < spot）：`criteriaByTab.rent` 默认 `strikeMax` ≤ W×1.03（FR-008 值反映新轴）、落在 (W×1.03, spot×1.03] 的腿不在候选且计入 strikeMax 边际计数 ② spot > 1.143V 锚：rent 默认候选为空、出参结构为既有「有链无候选」形态非错误（FR-005）③ 实时开态（overlay respond 实时批）：axis = min(实时 spot, W)（branch 8，用实时 spot 与库内 spot 拉开制造判别性）④ 覆盖 strikeMax 放宽 ⇒ 候选按覆盖出现（US2-AS2）⑤ 改 `v_manual` 后重新检索 ⇒ rent 默认上界随新 W 变化（Edge 2「无缓存滞留」防退化：将来有人加缓存这臂会红）→ verify: 五臂先红 → 绿；🚨 既有 49 用例 + golden 基线**逐字符不变**（Guardrail 4，US3 回归网）

- [ ] T003 [P] [Server] **其余构造点供 W + 全仓扫尾**（FR-002, FR-006, FR-007; plan §D2/§D4; US3）：`GetChainReportUseCase` 进程内召回 context 补 `w = computeW(detail.anchor.effective.v)`（零新查询）；`fake-leg-retrieval.adapter` 夹具面显式供 `w`；以 tsc 编译红为清单扫平其余全部 `RecallContext` 构造点（含各 spec 夹具与 mock 工厂，全仓 `rg` 复核零遗漏）→ verify: `pnpm exec nx affected -t typecheck test --base=origin/main` 绿；chain-report 既有 spec 零值变化（夹具属 spot < W 域）；`rg -n "0\.8" apps/server/src/optionsdesk/ --glob '!*.spec.ts'` 仍仅 `anchor.rules.ts` 一处（Guardrail 2）；`rg -n 'resolveQualityCeiling' apps/server/src/` 调用方清单核对 = 仅 rent 默认值链路（把 Assumption「其余读端不消费成色上界」变实证）

- [ ] T004 [Gate] **SC 收口：dev 全量对比留档 + 单点判据 + PR 门**（SC-001, SC-002, SC-003, SC-004; plan §D5; US1/US2/US3）：scratchpad tsx 脚本对全部 us 锚计算旧轴/新轴 `qualityCeiling` 与 rent 默认候选数，分布对照表（spot<W 逐值不变 / spot>W 收紧条数 / spot>1.143V 候选 0 计数）落 spec 新段「标定实测（SC-001/SC-002）」并核对与 ADR-0068 证据面吻合；SC-003 两条 `rg` 单点输出（0.8 一处 / min(spot,w) 一处）留档同段；spec frontmatter `status → implemented` + `updated_at` bump → verify: 对比表落盘且分布吻合；`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` exit 0 + gate-checks 相关脚本（server-moat / test-size / optionsdesk-rule-constants / time-semantics / identifier-boundary）全 0

## 依赖与并行

```text
T001 ──┬─→ T002 [P]（不同文件，互不依赖）──┬─→ T004
       └─→ T003 [P] ───────────────────────┘
```

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| branch | 落点 |
| --- | --- |
| 1 spot<W 逐值同 | T001-① + T002 golden 不变 |
| 2 spot=W 等值 | T001-② |
| 3 spot>W 收紧+计数 | T001-③ + T002-① |
| 4 spot>1.143V 空态 | T002-② |
| 5 build 零变化 | T001-⑤ |
| 6 全腿零变化 | T001-⑤ |
| 7 覆盖不触碰+三态 | T001-⑥ + T002-④ |
| 8 实时同轴 | T002-③ |
| 9 结构项退化 | T001-④ |

蓄意零覆盖（防下轮 analyze 误报缺口）：Edge 3「W 恒可派生」= 结构性事实，无代码路径，写侧 EC-3（拒 V ≤ 0）已守，不设 task。
