---
feature_id: 071-optionsdesk-wide-spread-opportunity
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-31'
updated_at: '2026-08-31'
---

# Tasks: 071-optionsdesk-wide-spread-opportunity（宽价差机会标 — 收租点差闸的机会逃生舱）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 P5 补片；收口 issue #298）
**Branch**: `071-optionsdesk-wide-spread-opportunity`
**病根一句话**：`rel > 0.35` 被一刀切出意图 Tab，而实测那批腿里有 78 条「砸 bid 也达 good 档」的真机会（`us:PCG` 39.4% / OI 301），它们同时缺席离线与实时两档的 fwd 阶梯，救回 5 个推荐档且零回归。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环；新测试必须证明「能红」（定向变异留档）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Contract-Smoke]` / `[Gate]` / `[Docs]`。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 档界查表单点下沉（改） | `apps/server/src/optionsdesk/leg-tier.rules.ts`（+ 同名 spec） |
| φ 改委派（改，行为零变化） | `apps/server/src/optionsdesk/leg-march.rules.ts`（+ 同名 spec） |
| 机会支谓词 + 维度第二支 + 候选带标（改） | `apps/server/src/optionsdesk/leg-recall.rules.ts`（+ 同名 spec） |
| 标透传（改） | `apps/server/src/optionsdesk/get-legs.usecase.ts`（+ 同名 spec） |
| DTO 腿级布尔（改） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| 契约产物（regen） | `apps/server/openapi.json` / `packages/api-client/**` |
| mobile 行内微标 | `apps/mobile/src/optionsdesk/leg-row.rules.ts` / `leg-row.tsx` / `leg-picker-copy.ts` / `optionsdesk-copy.ts` |
| Server IT（**新建**） | `apps/server/test/integration/optionsdesk-071.wide-spread.it.spec.ts` |
| 契约冒烟（**新建**） | `apps/mobile/e2e/contract-smoke/071-wide-spread.contract.ts` |
| 结构闸（改：词表加一项，零新常量） | `scripts/checks/check-optionsdesk-rule-constants.ts` |
| ADR 回写（§决策 3 + §7 + 后果） | `docs/adr/0068-realtime-narrow-recall-two-stage.md` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **机会支只作用收租**（FR-003）——`failsCriterion` / `failedCriteria` 必须拿到 `tab`；靠调用方守约 = 建仓静默捡漏，而建仓表照样渲染得出来。
2. **标的判据取系统默认值下的主支**（FR-006, plan §D4）——写成「实际被 `effective` 挡下」时，用户把上界拉到「不限」标就会消失，而那条腿还是同一条腿。
3. **档界是引用不是新数**（FR-002）——`WIDE_SPREAD_OPPORTUNITY_FLOOR` MUST 由 `tierFloor('annualized','good')` 派生；🚫 写 `new Prisma.Decimal('0.15')` 会当场撞 `check-optionsdesk-rule-constants` 的档界子串扫描。
4. **🚫 MUST NOT 复用 `optionsdeskConfig.marchPhiTier`**（plan §D2）——召回成员集随环境变量变，等于「候选为什么少了」要去查 env。
5. **费率恒经 `computeLegRates` 单点**——🚫 机会支内 MUST NOT 手写 `P/(K−P)`（ADR-0064 不变量 ③）。
6. **fwd 管道零改动**（FR-008）——🚫 不加审计类目、不加豁免；13 类枚举是前后端严格一致的契约面。

## Tasks

### Phase 1 · 判据（server 纯函数）

- [X] T001 [Server] **档界查表下沉单点**（FR-002, plan §D2; SC-001）：`leg-tier.rules.ts` 新增 `tierFloor(basis, tier)`（未知档抛错，语义承 `resolveMarchPhi` 原行为）；`leg-march.rules.ts` 的 `resolveMarchPhi` 改为一行委派 → verify: `pnpm nx test server --testPathPattern=leg-tier.rules.spec` + `leg-march.rules.spec` 全绿且 φ 逐值不变；定向变异（把 `annualized` 写成 `weekly`）必红

- [X] T002 [Server] **机会支谓词**（FR-002 / FR-004, plan §D3; state_branches 1/3; US1）：`leg-recall.rules.ts` 加 `WIDE_SPREAD_OPPORTUNITY_TIER` / `WIDE_SPREAD_OPPORTUNITY_FLOOR` / `isWideSpreadOpportunity(leg)`；`bid` 缺失 / 费率无定义 ⇒ false → verify: 同名 spec 新增四臂（达档 / 不达档 / 无 bid / `K−bid ≤ 0`）先红后绿；变异（`>=` 改 `>`）在恰等于档界的腿上必红

- [X] T003 [Server] **维度第二支 + tab 限定**（FR-001 / FR-003, plan §D1; state_branches 1/2/4; US1/US3）：`failsCriterion` / `failedCriteria` 加 `tab` 入参；`relativeSpreadMax` 分支改 `!passes(主支) && !(tab==='rent' && 机会支)`；两个调用点同步 → verify: 同名 spec —— 收租达档腿进候选、建仓同形态腿仍出局、全腿视角逐值不变；变异（去掉 tab 判定）在建仓臂必红

- [X] T004 [Server] **候选带标（同源产出）**（FR-005 / FR-006 / FR-007, plan §D4; state_branches 8; US1）：`RecallCandidate` 加 `wideSpreadOpportunity`，由 `evaluateLeg` 同一趟求值产出，判据取**系统默认值下**主支不过 ∧ 机会支成立；确认放行腿不再计入 `excludedByLiquidity` → verify: 同名 spec —— 标为真 / 标为假 / 用户把上界覆盖成 `null` 时标不变 / 流动性计数减少；变异（改读 `effective`）在覆盖臂必红

### Phase 2 · 读路径与契约

- [X] T005 [Server] **标透传到行视图**（FR-005, plan §D4; US1）：`get-legs.usecase.ts` 的 `deriveLegs` 逐腿透传 `wideSpreadOpportunity` 到 `LegRowView`，零重算 → verify: `get-legs.usecase.spec.ts` 加达档宽价差 fixture（`G-WIDE-OPP`）断言进收租 Tab 且标为真；既有 `G-WIDE`（不达档）断言逐字保留仍绿

- [X] T006 [Contract] **DTO + openapi + api-client**（FR-005, plan §D6）：`LegResponse` 加 `wideSpreadOpportunity: boolean`（`@ApiProperty` 显式 `type: 'boolean'`）；`node dist/main.js` 正路导出 openapi；`packages/api-client` regen → verify: `pnpm nx run server:export-openapi` 后 `git diff` 只含该字段；api-client 类型含新字段；typecheck 绿

- [X] T007 [Gate] **结构闸词表**（SC-001, plan §D6）：`check-optionsdesk-rule-constants.ts` 的 `MEMBERSHIP_PREDICATE_RE` 加 `isWideSpreadOpportunity`；确认 `RECALL_THRESHOLD_COUNT` 维持 4 → verify: `pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` 绿；把谓词调用抄进 `get-legs.usecase.ts` 必红（定向变异后回滚）

### Phase 3 · 呈现

- [X] T008 [Mobile] **行内微标**（FR-010 / FR-011, plan §D7; US1）：`LegStickyBadge` 加 `'wide'`（`border-tag-teal`）、`optionsdesk-copy.ts` 加 `wideSpreadBadge: '宽'`、`leg-row.rules.ts` 加 `legRowWideSpread`、`leg-row.tsx` 复用既有 badge 载体渲染 → verify: `pnpm nx test mobile --testPathPattern=leg-row.rules.spec` + `leg-picker-copy.spec`（描边不撞 fit / brand / quote 红绿；safelist 含新 class）；变异（判据改读 `relativeSpread` 自推）在 rules spec 必红

### Phase 4 · 集成与验收

- [ ] T009 [Server-IT] **state_branches 穷举**（US1/US2/US3; state_branches 1–9）：新建 `optionsdesk-071.wide-spread.it.spec.ts`，真 DI + Testcontainers，9 条分支各一 `it()`（含建仓排除、全腿不触发、交叉报价、离线/实时同判据、覆盖上界后标不变） → verify: `pnpm nx test server --testPathPattern=optionsdesk-071` 全绿

- [ ] T010 [Contract-Smoke] **契约冒烟**（FR-005 / SC-005）：新建 `071-wide-spread.contract.ts`，断言收租响应带标行同时给得出 `bid` / `ask` / `relativeSpread` → verify: 契约冒烟套件绿

- [X] T011 [Server] **SC-003 回放留档**（SC-003 / SC-004）：用 local-only 取证脚本对 `2026-08-28` 全量复跑，确认候选 852 → 930、推荐 70 → 75、零丢失 → verify: 数字回写 spec §标定实测；与本文 spec 表逐值一致

- [ ] T012 [Docs] **ADR-0068 amend + issue 收口**（plan §D6）：§决策 3 加机会支一条（判据 / 档界引用 / 收租限定 / 两档一律）、§7 修订表加行、§后果补 P5；issue #298 四条待办勾掉并注明落点 → verify: 交叉引用可达；`docs/` 相关链接无死链

- [ ] T013 [Gate] **全量回归 + PR**：`pnpm nx affected -t typecheck test lint` → verify: 全绿；PR body 走模板、`Closes #298`
