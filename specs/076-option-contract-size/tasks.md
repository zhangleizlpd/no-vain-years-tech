---
feature_id: 076-option-contract-size
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-09-06'
updated_at: '2026-09-06'
---

# Tasks: 076-option-contract-size（期权合约股数落库 —— 单笔权利金与成交额按每张合约的真实股数算）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)

**病根一句话**：读端把「一张合约 = 100 股」当市场常量，而港股每张合约的正股股数逐标的不同 —— 22 只有链港股锚里 21 只在 150 到 2000 股之间，屏上「单笔权利金」偏小 1.5 到 20 倍，且每一行都同样错，没有一处会红。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）；新测试必须证明「能红」（定向变异留档；rebase 后重做）。
- 层级：`[Server]` / `[Server-IT]` / `[Contract-Smoke]` / `[Docs]` / `[Gate]` / `[Ops]`。**本片无 `[Mobile]` / `[Contract]`** —— 契约形状零变化、前端零代码（plan §D5 / §D6 已逐项核过），这是结论不是遗漏。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途                                          | 路径                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| schema 加列 + FR-028 注释改写                 | `apps/server/prisma/schema.prisma`（`OptionContract`，`:1102-1139`）                                              |
| migration（**新建**，expand-only）            | `apps/server/prisma/migrations/<yyyymmdd_hhmm>_add_option_contract_contract_size/migration.sql`                   |
| 链发现 port（加字段 + 注释改写）              | `apps/server/src/marketdata/option-chain.port.ts`                                                                 |
| 链发现 adapter（取值单点）                    | `apps/server/src/marketdata/futu-option-chain.adapter.ts`（+ 同名 spec）                                          |
| 链发现真夹具（**新建**，原始信封）            | `apps/server/src/marketdata/__fixtures__/hk-option-chain-09988-<date>.json`                                       |
| 写路径：insert 带值 + 对账回填                | `apps/server/src/marketdata/sync-option-contract.usecase.ts`（+ 同名 spec）                                       |
| 快照 port / adapter / usecase（只比不写）     | `apps/server/src/marketdata/option-snapshot.port.ts` · `futu-option-snapshot.adapter.ts` · `sync-option-snapshot.usecase.ts`（+ 各同名 spec） |
| 读端 port / adapter                           | `apps/server/src/optionsdesk/leg-retrieval.port.ts` · `leg-retrieval.adapter.ts`                                  |
| 派生纯函数 + 常量退役                         | `apps/server/src/optionsdesk/leg-derive.rules.ts`（+ 同名 spec）                                                  |
| 派生调用点                                    | `apps/server/src/optionsdesk/get-legs.usecase.ts`（`:840` / `:859`）                                              |
| 契约说明                                      | `apps/server/src/optionsdesk/optionsdesk.dto.ts`（`:1474` / `:1613`）→ `apps/server/openapi.json` → `packages/api-client` |
| Server IT（改既有，加臂）                     | `apps/server/test/integration/marketdata-option-withdrawal.it.spec.ts` · `optionsdesk-052.retrieval.it.spec.ts` |
| 契约冒烟（改既有，加臂）                      | `apps/mobile/e2e/contract-smoke/071-hk-realtime.contract.ts`（既有两市同码夹具）                                  |
| 047 FR-028 superseded 注记                    | `specs/047-*/spec.md:312`                                                                                         |
| 取证留档（local-only，已落）                  | `docs/private/evidence/hk-option-contract-lot-size-2026-09-06.*`                                                  |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **MUST NOT 把链发现的 `createMany(skipDuplicates)` 改成逐行 upsert**（plan §D3）—— `:60` 注释实测每晚多付约 2.5 万条写；既有行的回填 / 更新只落在 `reconcileListingState` 的对账步。
2. **回填 / 更新 MUST 只在 `gap.ok` 分支**（FR-007）—— 挪到 gap 判定之前，一次链抖动会把整票写成空。T003 有专臂钉这条。
3. **非标合约恒 null，MUST NOT 信供应方给非标的数**（FR-002）—— PoC-A 实测 APTV1 报 100。
4. **只取期权合约行的 `lot_size`，MUST NOT 取正股行**（FR-003）—— 正股行同名字段是板手数，美股正股为 1。快照端点有正股行，链端点没有。
5. **读端 null MUST NOT 回落 100 或任何常量**（FR-009 / Q2）—— 回落就是把错数再显示一天，且 IT 抓不到「为什么不是 null」。
6. **快照轮 MUST NOT 写股数**（FR-008 / Q3）—— 写手只有链发现一处，两个写手必漂移。
7. **改完 `schema.prisma` 必 `prisma generate`，包括改了又撤回**（migration-rules §0）；已合 main 的 migration 不可改（§1）。
8. **契约形状零变化；regen 前必 `nx run server:export-openapi`**（plan §D6）—— 漏了 orval 拿旧 json 静默 regen，`git status` 干净、CI 全绿。
9. **美股逐值零变化是数据保证不是结构保证**（FR-010）—— 100 自此来自供应方，必须有一条「股数 100 夹具与改前基线逐值相同」的断言。
10. **注释出处**（comment-provenance）—— 涉及供应方字段语义的注释一律 `EVIDENCE:` 指向 spec「取证」节或 fixture，🚫 禁裸断言。

## Tasks

- [X] T001 [Server] **schema 加列 + expand-only migration + FR-028 注释改写**（FR-013 落库半, plan §D1; state_branches —; US1/US2）：`OptionContract` 在 `isStandard` 之后加 `contractSize Int? @map("contract_size")`，列注释三句（标准 = 供应方 `lot_size` 每张股数、非标恒 null 并注 PoC-A 出处、已到期不回填）；`schema.prisma:1102-1105` 那段「MUST NOT 存合约乘数」改写为「非标 MUST NOT 存（理由原文保留）；标准合约存 `contract_size`，见 076」。migration 用 `pnpm db:migrate "add option contract contract size"`（ADR-0035 wrapper 自动 timestamp）生成后只保留一行 `ALTER TABLE … ADD COLUMN "contract_size" INTEGER`，注释体例照 `20260903_2057_add_option_contract_withdrawn_at`（病根 / 语义 / 为什么不回填 / 不建索引）；🚫 migration 不回填。`prisma generate`。spec frontmatter 加 `migration_refs: ['<migration 名>']`（073 先例）。🚨 **翻绊线**：`optionsdesk-047.schema.it.spec.ts:88-115` 用穷举列集钉死本表（标题原文「也无合约乘数列 (FR-028 反向断言)」），列集补 `contract_size`、标题改为「无「是否已到期」列；`contract_size` 在册（076 FR-013 supersede FR-028）」并改写臂内注释，同一 commit message 写明翻它的理由（071 FR-017 先例）→ verify: `pnpm nx test server apps/server/test/integration/optionsdesk-047.schema.it.spec.ts` 加列后先红（列集多一列）→ 翻臂后绿（Testcontainers 真跑 migrate）；`pnpm tsx scripts/checks/check-server-moat.ts` exit 0（无新表，`MODEL_OWNERSHIP` 不动）；`pnpm tsx scripts/check-spec-frontmatters.ts` 绿；lefthook `migration-naming-check` 过

- [X] T002 [Server] **链发现取值单点：port 加字段 + adapter 映射 + 真夹具**（FR-001, FR-002, FR-003, FR-004, FR-005, FR-014; plan §D2; state_branches 1/2/3/4; US1/US3）：`OptionContractStatic` 加 `contractSize: number | null`，`option-chain.port.ts:58` 注释改为「含标准合约的股数；非标恒 null」；`futu-option-chain.adapter.ts` 行映射加 `contractSize = isStandard ? positiveIntOrNull(raw.lot_size) : null`（`positiveIntOrNull` 走 `numToString` 判带外缺失再校 `Number.isInteger(n) && n > 0`），标准合约取到 null 时打一条 warn **日志**带 code（FR-005 的「写日志」= adapter logger，不进采集轮记录）、本行照常返回。**真夹具**：用 specify 期同一条只读管道（prod app 容器内打 shim `/option-chain?code=HK.09988`，一个 30 天窗）落 `__fixtures__/hk-option-chain-09988-<date>.json`，原始信封逐字不加工 + `_provenance` 块（同 00700 夹具体例；🚫 只记端点路径 / 日期 / 窗口 / 码数，不记主机 / 容器名，落盘后跑 `pnpm tsx scripts/checks/check-identifier-boundary.ts`）—— 选 09988 是因为它同时给出 500 股与混入的 `US.ALB` 行（PoC-B 实测 72 行），一份夹具钉两条 branch。同名 spec **先红后绿**五臂：① 00700 夹具 ⇒ 132 行全 100 ② 09988 夹具 ⇒ 返回集全 500 且不含任何 `US.` 前缀行（FR-004 由 `dropForeignMarketRows` 结构承接，本臂钉「混入行不出现」）③ `option_standard_type = NON_STANDARD` ∧ `lot_size 100` ⇒ null ④ 标准 ∧ `lot_size` 缺失 / `'N/A'` / `5.5` 三形态 ⇒ null + warn 各一次 ⑤ 美股合成行 `lot_size 100` ⇒ 100。编译器逼出的替身 / 夹具（`option-snapshot-remediation.it.spec.ts` / `sync-option-contract.usecase.spec.ts` 等构造 `OptionContractStatic` 处）一并补 `contractSize`，🚫 不把字段做成可选 → verify: `pnpm nx test server apps/server/src/marketdata/futu-option-chain.adapter.spec.ts` 五臂先红 → 绿；`pnpm nx run server:typecheck` 绿；定向变异：非标也落值 → ③ 红；跳过整数校验 → ④ 红（留档）

- [ ] T003 [Server-IT] **写路径：insert 带值 + 对账步回填 / 更新 + notice**（FR-006, FR-007; plan §D3; state_branches 5/6/12; US2）：`contractRow()` 加 `contractSize: c.contractSize`；`:275-276` 收集处把 `discoveredCodes: Set<string>` 换成 `sizeByCode: Map<string, number | null>`（🚫 别叫 `discovered`，那是既有的到期日集合 `:275`，撞名），`reconcileListingState` 入参同步（软下架 / 复采两条 `updateMany` 改取 `[...sizeByCode.keys()]`，逻辑零变化）；新增第三步：`findMany` 该标的 `expiryDate ≥ businessDate ∧ withdrawnAt IS NULL` 的 `{ code, contractSize }`，内存对比，按**新值分组**（含 null 组）各一条 `updateMany({ where: { code: { in } }, data: { contractSize } })`；变更 > 0 ⇒ `findings.push({ kind: 'notice', step: 'option_contract_size', detail: { symbol, filled, changed } })`（`filled` = null → 值，`changed` = 值 → 另一值，分开记）。同名单测加臂（`contractRow` 带值 / finding 形状）；`marketdata-option-withdrawal.it.spec.ts` 的「链发现对账」describe 加五臂：① 库内 null、本轮 500 ⇒ 回填 500 + `filled` 计数 ② 库内 500、本轮 1000 ⇒ 更新 + `changed` 计数 ③ gap 不 ok ⇒ 股数不变、无 finding ④ 已到期夹具经一轮对账仍 null ⑤ 库内有值、本轮判非标（null）⇒ 回写 null → verify: `pnpm nx test server apps/server/test/integration/marketdata-option-withdrawal.it.spec.ts` 五臂先红 → 绿，既有 8 臂零变化；定向变异：删第三步 → ① 红；把第三步挪到 gap 判定之前 → ③ 红（两条留档）

- [X] T004 [Server-IT] **快照轮只比不写：port 加字段 + adapter 映射 + 不一致留痕**（FR-008; plan §D4; state_branches 7; US2）：`OptionSnapshotRow` 加 `contractSize: number | null`；`futu-option-snapshot.adapter.ts` 行映射对 `option_type ≠ 'N/A'` 的行取 `lot_size`（同 T002 的正整数校验），正股行恒 null；编译器逼出的替身（`option-snapshot-remediation.it.spec.ts` / `sync-option-oi-settle.usecase.spec.ts` / `option-snapshot-guard.rules.spec.ts` / `option-anomaly.rules.spec.ts` 等构造 `OptionSnapshotRow` 处）一并补 `contractSize`；`sync-option-snapshot.usecase.ts` 的 `WorkingContract` 多 select `contractSize`，批循环里 `contract.isStandard ∧ contract.contractSize !== null ∧ row.contractSize !== null ∧ 不等` ⇒ 计数 + 样本（逐票前 N 条，N = 具名常量 `CONTRACT_SIZE_MISMATCH_SAMPLES`），批循环结束 count > 0 ⇒ 一条 `notice` finding（`step: 'option_contract_size_mismatch'`，`detail: { symbol, mismatched, samples }`；`SyncRunFinding` 值域无 warn，🚫 不新开 kind）；🚫 不写库、不影响该行入库。adapter 同名 spec 加两臂（既有 00700 快照夹具：132 张期权行 ⇒ 100、标的行 ⇒ null）；usecase 同名 spec + withdrawal IT 各加一臂（库内 500、快照行 1000 ⇒ notice 一条、库值仍 500、该行照常入库）→ verify: `pnpm nx test server apps/server/src/marketdata/futu-option-snapshot.adapter.spec.ts` + `sync-option-snapshot.usecase.spec.ts` + withdrawal IT 绿；定向变异：不一致时顺手 `update` 库值 → IT 臂红（留档）

- [X] T005 [Server-IT] **读端：合约行带出股数，两处派生改入参，常量退役**（FR-009, FR-010, FR-011, FR-013 注释半; plan §D5; state_branches 8/9/10/11; US1）：`leg-retrieval.adapter.ts:72` `ChainContractRow` 的 `Pick` 加 `contractSize`，`:404` / `:733` 两处 `select` 多带 `contractSize: true`，`toLegRows` 在 `expirationCycle` 旁带出；`leg-retrieval.port.ts` `LegChainRow` 加 `readonly contractSize: number | null`；`leg-derive.rules.ts` 两个函数改签名 `computeTurnover(volume, premium, contractSize)` / `computeContractPremium(bid, contractSize)`，`contractSize === null ⇒ null`，删 `US_OPTION_CONTRACT_MULTIPLIER` 与 `:37-42` 注释改写（合约属性、随链发现落库、非标 null，`EVIDENCE:` 指 spec 取证 §1）；同名 spec 删 `:377` 那条常量断言（本片 orphan），加三臂（500 / 100 / null ⇒ null）；`get-legs.usecase.ts:840` / `:859` 改传 `row.contractSize`，`:838-839` 注释改「合约行自带股数」。`optionsdesk-052.retrieval.it.spec.ts` 加三臂：① 港股夹具股数 500 ⇒ `contractPremium = bid × 500`、`turnover = volume × bid × 500` ② 夹具股数 null ⇒ 两列 null、其余列在、`state = available` ③ 美股夹具股数 100 ⇒ 两列与改前基线逐值相同（基线值写死在断言里，不从函数算）；`optionsdesk-071.hk-realtime.it.spec.ts` 加一臂：实时窄路径 `answered` 行携带夹具 `contractSize`（钉 plan §D5「骨架展开自动携带」这句结构论断）；编译器逼出的替身（`fake-leg-retrieval.adapter.ts` / `optionsdesk-064.overlay.it.spec.ts` / `leg-retrieval.port.spec.ts` / `get-chain-report.usecase.spec.ts` 等构造 `LegChainRow` 处）一并补 `contractSize` → verify: `pnpm nx test server apps/server/src/optionsdesk/leg-derive.rules.spec.ts` + `apps/server/test/integration/optionsdesk-052.retrieval.it.spec.ts` + `apps/server/test/integration/optionsdesk-071.hk-realtime.it.spec.ts` 先红 → 绿，052 既有 17 臂零变化；`pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0；`rg -n "US_OPTION_CONTRACT_MULTIPLIER" apps/ packages/` 零命中；定向变异：null 回落 100 → ② 红；500 改 100 → ① 红（两条留档）

- [X] T006 [Contract-Smoke] **契约说明 + regen + 港股冒烟臂**（FR-012; SC-006; plan §D6; state_branches 8; US1）：`optionsdesk.dto.ts:1474` 与 `:1613` 说明改为「× 该合约的股数（合约主数据，港股逐标的不同；股数未落库 / 非标 ⇒ null）」，类型不动；`pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`；`071-hk-realtime.contract.ts` 两市同码夹具的 `seed()` 裸 SQL `INSERT INTO marketdata.option_contract (…)`（`:330-337`，显式列名）列表加 `contract_size`，hk 播 500、us 播 100，加两臂断言 `contractPremium / bid` 分别为 500 / 100；`optionsdesk-chain-leg-picker.contract.ts:606-640` 既有不变量 `contractPremium × volume === turnover` 原样保留（任何股数下恒成立）→ verify: `git diff packages/api-client apps/server/openapi.json` 只含说明文字行（出现类型 / 必填 diff 即违 FR-012，停下）；`MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm nx run mobile:contract-smoke` 绿；定向变异：hk 夹具股数改 100 → 冒烟臂红（留档）

- [X] T007 [P] [Docs] **047 FR-028 superseded 注记**（FR-013 文档半; plan §Gate 0.4）：`specs/047-*/spec.md:312` FR-028 末尾加一句「📌 2026-09 superseded by 076 FR-013：标准合约存 `contract_size`，非标仍 null；MUST NOT 做乘数感知计算这一半对非标仍成立」，🚫 不改 047 其余文字 → verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；`rg -n "superseded by 076" specs/047-*/spec.md` 命中 1

- [ ] T008 [Gate] **SC 收口 + 全量门 + PR**（SC-001, SC-002, SC-004, SC-005, SC-006, SC-007; FR-014 落档; US1/US2/US3）：spec 加「SC 收口」表（SC → 证据落点 → 形态，蓄意写判据形态不写 task 号）：SC-001 = T005 ① 臂 + T006 冒烟臂（22 只锚的逐只对拍在 T009 部署后核对里以 SQL 承接，写明）· SC-002 = T005 ③ 臂 · SC-004 = T002 ③ + T003 ⑤ 臂 · SC-005 = 各 task 变异留档 · SC-006 = T006 diff 判据 · SC-007 = T003 finding 臂；`state_branches` 覆盖说明（13 条里 12 条有断言，第 13 条蓄意零覆盖及理由）；spec `status → implementing`、`updated_at` bump → verify: `git fetch origin && pnpm nx affected -t lint typecheck test build --base=origin/main --skip-nx-cache` exit 0（🚨 跑门前必 `git fetch`）；gate 脚本全 0：`check-server-moat` / `check-test-size` / `check-optionsdesk-rule-constants` / `check-time-semantics` / `check-identifier-boundary` / `check-repo-layout` / `check-api-property-nullable`；`gh-bot pr create` 按 `pr-creation-protocol.md` + `gh-bot pr merge --auto --squash --delete-branch`（expand-only nullable 列，可回滚，不属「DB 不可逆」例外）；开完 PR 立刻切回 `main-base`

- [ ] T009 [Ops] **部署后 prod 核对（合并后勾，带到期日）**（FR-015; SC-001 的 22 只逐只对拍, SC-003; state_branches 11; US1/US2）：部署后第一轮**成功**链发现之后（港股主轮 16:20 HKT / 美股夜轮），prod 只读 SQL 两条：① 未到期 ∧ 标准 ∧ `withdrawn_at IS NULL` ∧ `contract_size IS NULL` 计数 = 0 ② 22 只有链港股锚各取一张未到期标准合约的 `contract_size`，逐只等于 spec 取证 §1 的分布表（150 / 200 / 400 / 500 / 1000 / 2000）；顺带核 `sync_run` findings 里首轮 `option_contract_size` 的 `filled` 量级；结果回填本行 + spec 「SC 收口」表 → verify: 两条 SQL 输出留档回填；🚨 **开 task 时同步建 issue 并写明到期日 = 部署后第 2 个港股交易日**，逾期未勾在 issue 记阻塞原因（071 T010 纪律）；spec `status → implemented`

## 依赖与并行

```text
T001（schema+migration）→ T002（链发现取值）→ T003（写路径回填）→ T004（快照只比）→ T005（读端）→ T006（契约+冒烟）→ T008（门+PR）→ T009（部署后）
                                                                                      T007 [P]（047 注记）──────────┘
```

- **T001 → T002 → T003 顺序**：port 字段依赖 schema 生成物；对账步依赖 adapter 已带值。
- **T004 可在 T003 之后单独成 commit**：它只读 `contractSize`，不依赖回填逻辑；但 IT 夹具要 T001 的列。
- **T005 依赖 T001（列）不依赖 T003 / T004**：读端只吃库里现成的值，夹具直接播；放在 T004 之后只是为了单向推进。
- **T006 依赖 T005**（契约说明与派生值一起变）。
- **T007 与任何 task 并行**（只改 047 spec 一句）。
- **T009 在 PR 合并、部署后执行**（部署后验收，不阻塞合并）。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序**（071 实撞过错位一次）。

| #   | branch                             | 落点                                              |
| --- | ---------------------------------- | ------------------------------------------------- |
| 1   | 标准合约落供应方值                 | T002-①②⑤ + T003 `contractRow` 单测                |
| 2   | 非标 → null                        | T002-③                                            |
| 3   | 缺值 / 哨兵 / 非整数 → null + 留痕 | T002-④                                            |
| 4   | 跨市场混入行不参与                 | T002-②                                            |
| 5   | 既有未到期行回填 / 更新 + notice   | T003-①②                                           |
| 6   | 链不干净不更新                     | T003-③                                            |
| 7   | 快照不一致只留痕不写               | T004                                              |
| 8   | 读端有值 ⇒ 按股数算                | T005-① + T006 冒烟臂                              |
| 9   | 读端 null ⇒ 两个数 null            | T005-② + leg-derive 纯函数臂                      |
| 10  | 美股逐值零变化                     | T005-③ + 047 契约冒烟既有不变量                   |
| 11  | 首轮回填前 null                    | 与 9 同一断言面（夹具即「未回填」形态）+ T009 实证 |
| 12  | 已到期不回填                       | T003-④                                            |
| 13  | 无链锚零影响                       | **蓄意零覆盖** —— 无合约行 ⇒ 无写无读，结构性不可达 |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC                                | 落点                                                    | 形态                          |
| --------------------------------- | ------------------------------------------------------- | ----------------------------- |
| SC-001 22 只港股锚逐只对拍        | T005-①（夹具 500）+ T006 冒烟臂 + **T009 SQL ②（22 只真数）** | 自动断言 + 部署后 SQL         |
| SC-002 美股逐值零变化             | T005-③                                                  | 自动断言（基线值写死）        |
| SC-003 未到期标准合约空值 = 0     | T009 SQL ①                                              | **部署后验收，带到期日 + issue** |
| SC-004 非标为空 100%              | T002-③ + T003-⑤                                         | 自动断言                      |
| SC-005 每条 branch 有断言且能红   | T002 / T003 / T004 / T005 / T006 变异留档               | 变异留档                      |
| SC-006 契约零形状差异             | T006 `git diff` 判据                                    | 机器判据                      |
| SC-007 变更事件可查               | T003-①② finding 臂                                      | 自动断言                      |

## Edge Case 覆盖预检

| EC                          | 落点 / 判决                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| EC1 同标的两套系列并存      | T002-③（非标判据沿用）+ T003 按合约逐张更新（不按标的）；港股调整后代码形态**未验证**，夹具覆盖 |
| EC2 跨市场混入行            | T002-②（真夹具含 `US.ALB` 行）                                              |
| EC3 正股行不是合约行        | T004 adapter 臂（标的行 ⇒ null）；链端点无正股行（fixture 132 行全合约）    |
| EC4 供应方字段形态          | T002-④（缺失 / `'N/A'` / `5.5`）                                            |
| EC5 已到期永久为空          | T003-④                                                                      |
| EC6 股数变更后的历史快照    | **蓄意零覆盖** —— 读端现算、历史行不回算是 spec 写明的取舍，无判据可断       |
| EC7 首轮回填窗口            | T005-② + T009                                                               |
| EC8 无链锚                  | **蓄意零覆盖**（同 branch 13）                                              |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层）

| AS                              | 落点                                         |
| ------------------------------- | -------------------------------------------- |
| US1-AS1 09988 按 500 算         | T005-① + T006 冒烟臂 + T009 SQL ②            |
| US1-AS2 00700 逐值相同          | T002-①（100）+ T005-③ 同形断言（100 夹具）    |
| US1-AS3 美股逐值相同            | T005-③                                       |
| US1-AS4 未落库 ⇒ 两列空、页面正常 | T005-②                                       |
| US2-AS1 500 → 1000 更新 + 记录  | T003-②                                       |
| US2-AS2 部署前行首轮回填        | T003-① + T009 SQL ①                          |
| US2-AS3 链不干净不变            | T003-③                                       |
| US2-AS4 快照不一致留痕不写      | T004                                         |
| US3-AS1 非标报 100 ⇒ 空         | T002-③                                       |
| US3-AS2 缺值 ⇒ 空 + 留痕、同批照常 | T002-④                                       |

蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：

- **branch 13 / EC8 无链锚**：结构性不可达，不造夹具。
- **EC6 历史快照口径不连续**：spec 写明的取舍，不是判据。
- **无 `[Mobile]` task**：`formatContractPremium` 对 null 已走 `COPY.noValue`（`leg-row.rules.ts:127-131`），零代码。
- **SC-003 无 CI 断言**：只能在 prod 首轮链发现后验，部署后验收（T009）。

## Implementation Strategy

MVP = **T001 → T002 → T003 → T005**（列 + 取值 + 回填 + 读端：到这里 22 只港股锚的单笔权利金已经对了）。T004 是资本调整期的运行期信号，T006 是契约面收口，T007 并行，T008 门，T009 合并后验。

Clear 检查点批次：`T001-T002` / `T003` / `T004` / `T005` / `T006-T008` / `T009`（每批次后停顿提醒 `/clear`，per Constitution §III；T003 / T005 各含 5 / 3 条 IT 臂 + 变异，analyze C1 裁为单独成批，同 071 T006a 先例）。
