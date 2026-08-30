---
feature_id: 068-optionsdesk-two-stage-recall
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-30'
updated_at: '2026-08-30'
---

# Tasks: 068-optionsdesk-two-stage-recall（实时窄召回两段式重建 — 窗即召回第一段）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0068`](../../docs/adr/0068-realtime-narrow-recall-two-stage.md)（本片 = 其 P2 实施载体）
**Branch**: `068-optionsdesk-two-stage-recall`
**病根一句话**：064 实时档承袭离线宽视野形态（收盘基线 + 报价覆盖），与「窄视野执行」定位冲突且携带四个结构缺口——重建为「规则先定码（K-梯形窗），再问实时价（同一判据入口）」。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Contract-Smoke]` / `[Gate]`。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**（062 实撞纪律沿用）。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| axis 单点抽取（改） | `apps/server/src/optionsdesk/leg-recall.rules.ts`（+ 同名 spec） |
| Δ 面→K-梯形窗判据（**新建**） | `apps/server/src/optionsdesk/leg-delta-surface.rules.ts`（+ 同名 spec） |
| 窗规则重定位（改：bootstrap 降格 + 绊线退役） | `apps/server/src/optionsdesk/leg-window.rules.ts`（+ 同名 spec） |
| 实时路径重建（改：窄路径 + 三级基准 + 退役） | `apps/server/src/optionsdesk/leg-retrieval.adapter.ts` |
| 腿行类型（改：`bandStatus`） | `apps/server/src/optionsdesk/leg-retrieval.port.ts` |
| DTO（改：`bandStatus` 下发；两处 `realtimeDegrade` 同源块） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| mobile 呈现 | `apps/mobile/src/optionsdesk/leg-row.{tsx,rules.ts}` / `leg-tier-bar.rules.ts` / `optionsdesk-copy.ts` |
| Server IT（**新建** + 改 064 实时腿用例） | `apps/server/test/integration/optionsdesk-068.two-stage.it.spec.ts` + `optionsdesk-064.overlay.it.spec.ts` |
| 契约冒烟（新增用例） | `apps/mobile/e2e/contract-smoke/068-two-stage-recall.contract.ts` |
| 常量守卫（改：#2/#3 指向 + 新常量入表） | `scripts/checks/check-optionsdesk-rule-constants.ts` |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **离线零改动是结构性的**（plan D1）—— 实时走独立方法 `loadRealtimeNarrowChain`，🚫 禁在 `loadChainWithWindow` 里加实时分支；离线 IT + golden 基线**逐字符不变**，🚫 禁重新生成基线充数。
2. **窗判据单点在 rules 文件**（plan D2）—— 🚫 禁在 adapter 手写包络 / min；全仓 `Decimal.min(spot, w)` 仍**恰好一处**（`resolveCeilingAxis`，067 SC-003 判据承接）。
3. **昨日 `underlyingSpot` 只用于 moneyness 折算**（plan D3）—— 🚫 禁当今日窗基准；今日 spot 唯一来源 = 三级基准链，补发成功值同刻同值喂 recall context（无第二 spot 真相源、无 TTL 缓存）。
4. **降级值域零扩张**（plan D1/D3；Q2 裁决）—— 第三级复用 `window_basis_stale`；🚫 禁新 enum 值 / 新错误态；`optionsdesk.dto.ts` 两处 `realtimeDegrade` 同源描述块改一处必改两处。
5. **`bandStatus` 是呈现语义**（plan D5）—— 判腿**之后**打标，🚫 禁进 `recallCandidates` 成员判定；port 窗零泄漏（`check-optionsdesk-rule-constants` #5 会红）。
6. **退役 = 物理删除**（plan D1）—— 🚫 禁注释屏蔽留尸；`window-granularity.rules.ts` 撞名（046 时序图）与 K 窗无关勿动；#274 的 hardcode `'us'` 缺陷🚫 不顺手修。

## Tasks

- [X] T001 [Server] **axis 单点抽取 `resolveCeilingAxis`**（FR-003; plan §D2; state_branches 3 前置; US1）：`leg-recall.rules.ts` 把 `resolveQualityCeiling` 函数体内 `Prisma.Decimal.min(spot, w)` 抽为导出纯函数 `resolveCeilingAxis(spot, w)`，`resolveQualityCeiling` 改为消费之；`leg-recall.rules.spec.ts` **先红后绿**两臂：① `resolveCeilingAxis` 三分支（spot </=/> w）逐值 ② `resolveQualityCeiling` 对 067 既有六臂逐值不变（重构等价性）→ verify: 先红（新函数不存在 tsc 红）→ 实现 → `pnpm exec nx test server -- --project unit` 绿；`rg -n "Decimal\.min" apps/server/src/` 仍仅 `leg-recall.rules.ts` 一处；067 既有 72 用例零值变化

- [X] T002 [Server] **Δ 面→K-梯形窗纯函数**（FR-002, FR-003, FR-004 判 bootstrap 信号; plan §D2; state_branches 1/2/3; US1）：**新建** `leg-delta-surface.rules.ts`——入参（昨日面行 `{strike, expiryDate, delta}[]` / 昨日 `underlyingSpot` / 今日 spot / 意图 Δ 带 / pad / 意图 DTE 段过滤后的到期日集 / 收租 axis 帽），出参 `{ windowKs, expiries, bandPrediction }`；机制：逐到期日在昨日面找 Δ 落带 K 区间 → moneyness 折算 → 段内包络 + pad → 乘今日 spot → 「任一到期日落带即进窗」∩ 收租帽（经 T001 `resolveCeilingAxis`）→ 进窗 K 附段内全部到期日。Δ 带界 × 2（建仓/收租）与 pad 用**占位常量**（标定在 T010）。同名 spec **先红后绿**七臂：① 任一到期日落带即进窗 ② 进窗 K 附段内全部到期日（含预测带外者，阶梯不断链）③ 收租帽经 axis 单点取交（spot>W 域收紧）④ 建仓视角无帽 ⑤ 部分缺失：缺失 (K,expiry) 不参与包络且不整体失败 ⑥ 整面零 Δ 读数 ⇒ 返回 bootstrap 信号（显式判别值非异常）⑦ DTE 重叠区 [30,49] 同一 K 可进两视角窗互不影响 → verify: 七臂先红（文件不存在）→ 实现 → unit 绿；🚫 函数体内 `rg` 扫不到 `0\.7|1\.05|Decimal\.min`（包络由 Δ 带派生非矩形，帽经单点）

- [X] T003 [P] [Server] **窗规则重定位 + 常量守卫同步**（FR-004, FR-013 over_cap 保险丝沿用; plan §D2/§D8; state_branches 2; US1/US3）：`leg-window.rules.ts` 的 `legWindowFor` 改名 `bootstrapWindowFor`（0.7/1.05 两常量注释改注 bootstrap 专用；文件头教义改写：「实时档窗即召回第一段；『窗非 filter』教义存续范围 = bootstrap 首日」）；**物理删除** `windowTripwire` + `withinWindow` 的实时消费面（真正删除随 T006 退役 adapter 侧调用后收口，本 task 先删 rules 侧导出与 spec）；`check-optionsdesk-rule-constants.ts` 同步：不变量 #2/#3 指向新窗规则文件、`leg-delta-surface` 的 Δ 带界 × 2 + pad + bootstrap 两比例入守卫表、#5/#7 确认不误伤 → verify: 改动文件 spec 先红后绿；`pnpm exec tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0；tsc 报出的 adapter 侧引用红 = T006 工作清单，本 task 不顺手修

- [X] T004 [P] [Server-IT] **三级基准链 `resolveWindowBasis`**（FR-006, FR-013 补发至多 1; plan §D3; state_branches 4/5/6; US2）：`leg-retrieval.adapter.ts` 的 `resolveWindow` 升级为 `resolveWindowBasis`：① `anchor.intradayPrice` 且 `isIntradayFresh`（90s 单点沿用）⇒ 直接用 ② 陈旧/缺失 ⇒ `getSnapshots({underlyingSymbol, contractCodes: []})` 补发一次只取标的行 ③ 补发失败/无行 ⇒ 返回 null（上游标 `window_basis_stale` 零再外呼回落）。IT（新文件 `optionsdesk-068.two-stage.it.spec.ts` 起 describe，Testcontainers 真 DI + fake snapshot port）**先红后绿**三臂：① 基准新鲜 ⇒ 零补发（fake port 调用计数 = 主批 1 次）② 陈旧 ⇒ 补发一次成功即以实时值定窗（计数 = 2）③ 补发抛错 ⇒ 回落收盘档 + `realtimeDegrade: 'window_basis_stale'`，且总外呼计数不再增长 → verify: 三臂先红 → 绿；🚫 全文件 `rg` 无新 enum 值（Guardrail 4）

- [X] T005 [Server-IT] **实时窄路径主装配 `loadRealtimeNarrowChain`**（FR-001, FR-002, FR-005, FR-008, FR-009 server 侧, FR-010, FR-013; plan §D1/§D4/§D5; state_branches 1/9/11/12/13; US1/US2/US3-AS4）：adapter 新建独立方法：闸（原样）→ #286 guard（原样）→ 视角判定 → `resolveWindowBasis`（T004）→ Δ 面批读（`optionDailySnapshot` 最近一期含 `delta`/`underlyingSpot`，零外呼）→ `leg-delta-surface` 定窗（T002）→ `window_over_cap` 保险丝（399 原样）→ 一次批取 → 组链（报价七值+Δ+iv 取实时行；OI/`oiAsOf` 取库内最近期；DTE 按今日；`priceKind` 逐行 realtime；spot/`quoteAsOf` 取批内标的行）→ `recallCandidates`（入口零改动）→ 判腿后按同批实时 Δ 打 `bandStatus`（port 的 `LegChainRow` 增 `'in'|'out'|null`，离线恒 null）；定窗后把**窗码数落观测日志**（沿 064 降级 log tag 体例，FR-013 可观测——不动契约面）。IT **先红后绿**六臂：① 主路：外呼码集 = 窗产物、候选经同一判据入口产出、外呼计数恒 1（+基准新鲜零补发）② 带标：带内落带腿 `bandStatus:'in'`、进窗 K 段内预测带外腿 `'out'` 且**在响应中**（不删）③ 规则内无腿 ⇒ 既有「有链无候选」空态形态非错误 ④ 两意图视角两次请求 ⇒ 两个不同 `quoteAsOf`（fake port 按调用递增时刻制造判别性）且互不影响 ⑤ 实时批部分缺行 ⇒ `partial_miss` 语义原样（缺失腿不进候选、行级 `priceKind` 承载）⑥ 带 override 的实时窄检索（US3-AS4，analyze G1）：strikeMax 放宽 ⇒ 候选按覆盖出现、三态相对默认判定、`memberCount` 无覆盖口径语义原样 → verify: 六臂先红 → 绿；窗码数观测断言（logger spy 读出窗码数，analyze G2）；`rg -n 'recallCandidates\(' apps/server/src/optionsdesk/` 调用方 = 离线/实时/进程内三处共用同一入口（FR-005 实证）；离线路径此时未动（T006 收口）

- [X] T006 [Server-IT] **回落面 + overlay 机器退役 + 离线零回归收口**（FR-001 退役, FR-004 bootstrap, FR-007, FR-011, FR-013 over_cap 回归网, FR-014; plan §D1/§D6; state_branches 2/7/8/10; US2/US3）：**物理删除** `overlayRealtimeQuotes` / `applyRealtimeBatch` / `loadRealtimeBaselineChain` / `reportWindowDrift`（含 T003 遗留的 tsc 红收口）；`loadChainWithWindow` 摘除 overlay 插点后成为离线唯一路径；实时入口按 `query.realtime` 分派到窄路径；bootstrap：无昨日 Δ 面（新锚零快照期 / 整面零读数）⇒ `bootstrapWindowFor` 矩形宽取走同一管道；全腿视角/防御性多视角 ⇒ 离线产物 + 既有 `priceKind` 口径。IT **先红后绿**五臂：① 新锚（零快照期）bootstrap 宽窗召回成功且窗形状为矩形 ② 未支持市场 ⇒ 零外呼回落 + `source_unavailable`（#286 语义回归网）③ 实时关态/闸 closed ⇒ 与重建前离线响应**逐值相同** ④ 实时开态 + 全腿视角 ⇒ 零外呼、响应与离线逐值相同、`priceKind: 'eod_close'` ⑤ 窗码数 > `OPTION_SNAPSHOT_MAX_CONTRACT_CODES` ⇒ 零外呼回落收盘档 + `window_over_cap`（fake port 调用计数 = 0 证零外呼；重建后 Edge 5 回归网，analyze G3）→ verify: 五臂先红 → 绿；**064 IT 离线腿用例 + golden 基线逐字符不变**（Guardrail 1），064 实时腿用例按新范式重写（旧 overlay 断言随机器退役删除，逐条在 commit message 列名）；`rg -n 'overlayRealtimeQuotes|applyRealtimeBatch|loadRealtimeBaselineChain|windowTripwire|reportWindowDrift' apps/server/` 零命中（Guardrail 6）

- [ ] T007 [Contract] **DTO `bandStatus` 下发 + api-client regen**（FR-009, FR-012; plan §D5/§D7; state_branches 13; US1）：`optionsdesk.dto.ts` 腿行 DTO 增 `bandStatus`（nullable 枚举 `'in'|'out'`，`@ApiProperty` 显式 type + enum + nullable——nullable 必显式 `type` 防 orval objectmap 坑）；两处 `realtimeDegrade` 同源描述块**逐字复核零改动**（值域未扩张的机器证据）；`nx run server:export-openapi` → api-client regen → mobile types 就位 → verify: swagger metadata 单测（controllers-only module 体例）先红后绿；`git diff packages/api-client` 仅 `bandStatus` 增量、`realtimeDegrade` 枚举零 diff；`pnpm exec nx affected -t typecheck --base=origin/main` 绿

- [ ] T008 [Mobile] **band 呈现 + 降级/口径文案复核**（FR-009, FR-010, FR-012, FR-014 口径标注; plan §D7; state_branches 12/13; US1/US2）：`leg-row.rules.ts` 增 band 判据纯函数（从契约 `bandStatus` 来，🚫 客户端反推）+ `leg-row.tsx` 带外横档灰阶弱化 + 「带外」角标（沿「收」角标体例）；`leg-tier-bar.rules.ts` 复核 `window_basis_stale` 文案与 Q2 裁决语义吻合（预期零新文案，不吻合则只改文案值不动值域）；全腿视角实时开态口径标注走既有 `priceKind` 文案链复核。vitest：band 判据纯函数先红后绿；Playwright hermetic e2e（`apps/mobile/e2e/`，mockJson 挡网络）：带内/带外行渲染判别 + 降级横幅 + 空态文案三断言 → verify: `pnpm exec nx test mobile` 绿 + e2e 绿（新文件首跑 `--skip-nx-cache`）；🚫 `~/ui` 不写 vitest 组件 render 测（分层纪律）

- [ ] T009 [P] [Contract-Smoke] **契约冒烟**（FR-012, FR-005 契约面; plan §D7; US1/US3）：`apps/mobile/e2e/contract-smoke/068-two-stage-recall.contract.ts`——生成的 `@nvy/api-client` 打 testcontainers 真 server（mock provider 档）：① 收盘档请求腿行 `bandStatus === null`（离线恒 null 的契约证据）② 实时开态请求在 mock 档走 `gate_unknown` 回落（064 T012 既有语义回归）且响应形状含 `bandStatus` 字段 ③ 专属 ticker + 末尾自清理 → verify: `MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm exec nx run mobile:contract-smoke` 绿（红绿时序：断言先落——旧契约无 `bandStatus` ⇒ `undefined` 对 `=== null` 断言红，T007 regen 后转绿）

- [ ] T010 [Gate] **标定定稿 + SC 收口 + PR 门**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006; plan §D8; US1/US2/US3）：scratchpad tsx 标定回放（067 T004 体例不入仓）：取库内相邻两期，T-1 日 Δ 面对全量 us 锚生成窗、对照 T 日收盘全量召回真候选——**漏腿数 = 0 为 pad 定稿判据**（SC-002），窗码数分布 max ≤ 180（SC-001），Δ 带界按「带下限 = 权利金地板可行域下沿」实测定稿；占位常量替换为定稿值（`check-optionsdesk-rule-constants` 守卫表同步）；对照表 + SC-004 三条 `rg` 单点输出（`Decimal\.min` 一处 / `0\.8` 一处 / 成员判定入口三调用方）落 spec 新段「标定实测（SC-001/SC-002）」；SC-005 各降级态判别性由 T004/T005/T006 IT 臂清单留档；SC-006 p95 以窗码数结构性论证留档（蓄意不设自动 perf 门）；spec frontmatter `status → implemented` + `updated_at` bump → verify: 对比表落盘且分布吻合；`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` exit 0 + gate-checks 相关脚本（server-moat / test-size / optionsdesk-rule-constants / time-semantics / identifier-boundary）全 0

## 依赖与并行

```text
T001 ──→ T002 ──→ T003 [P]（判据层文件簇）
T004 [P]（adapter 基准链，无判据层依赖，可与 T001-T003 并行）
T002+T003+T004 ──→ T005 ──→ T006 ──→ T007 ──┬─→ T008 ──┐
                                            └─→ T009 [P]┴─→ T010
```

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

| branch | 落点 |
| --- | --- |
| 1 两段式主路 | T002-①② + T005-① |
| 2 bootstrap 宽窗 | T002-⑥ + T006-① |
| 3 收租窗帽同单点 | T001 + T002-③④ |
| 4 基准新鲜 | T004-① |
| 5 补发成功 | T004-② |
| 6 补发失败回落 | T004-③ |
| 7 未支持市场 guard | T006-② |
| 8 关态/休市离线原样 | T006-③ + 064 golden 不变 |
| 9 两视角两时刻 | T005-④ |
| 10 全腿回落 | T006-④ |
| 11 判腿同一入口 | T005-① + rg 调用方清单 |
| 12 规则内无腿空态 | T005-③ + T008 文案 |
| 13 带内标/带外横档 | T005-② + T007 + T008 |
| US3-AS4 覆盖零改动（AS 层） | T005-⑥（analyze G1 补） |
| Edge 5 over_cap（重建后） | T006-⑤（analyze G3 补） |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：
- **SC-006 p95** —— 不设自动 perf 门；由窗码数 ≤ 180（vs 矩形 381）结构性论证 + T010 留档说明。
- **Edge「v_manual 盘中改」** —— W 帽经 `resolveW` 现查现算 + `resolveCeilingAxis` 单点，067 Edge 2 IT 臂已守同一机制，蓄意不重设。
- **spec branch 9 的「跨视角一致性只判业务日」** —— 现行读端每请求单视角、无跨视角聚合断言点，T005-④ 验两时刻判别性即覆盖其可观测面。
