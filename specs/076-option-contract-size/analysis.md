# Specification Analysis Report: 076-option-contract-size

**Date**: 2026-09-06 ｜ **Artifacts**: `spec.md` / `plan.md` / `tasks.md` ｜ **Constitution**: v1.4.0

**扫描层**（起手先列，差集写明）：FR（15）· SC（7）· `state_branches`（13）· Edge Cases（8）· **Acceptance Scenarios（10）** · plan §D1–D8 · tasks 引用的文件路径与既有测试臂数。全部逐条 grep 交叉核对，非通读。未扫：spec「取证」节的数字（那是证据不是需求）。

## Findings

| ID  | Category         | Severity | Location(s)                                                                 | Summary                                                                                                                                                                                                                          | Recommendation                                                                                                                                                                                                                    |
| --- | ---------------- | -------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Inconsistency    | **HIGH** | tasks T001 verify; `optionsdesk-047.schema.it.spec.ts:88-115`               | 既有 IT 用**穷举列集**钉死 `option_contract` 的列（标题原文「也无合约乘数列 (FR-028 反向断言)」）。T001 加 `contract_size` 后该臂必红，而 T001 的 verify 写的是「该 IT 绿」—— 这是一条刻意设的绊线，tasks 没有翻它的动作 | T001 增加：翻该臂 —— 列集加 `contract_size`，标题改为「无「是否已到期」列；`contract_size` 在册（076 FR-013 supersede FR-028）」，🚨 同一 commit message 写明翻绊线的理由（071 FR-017 先例）                                       |
| I2  | Inconsistency    | **HIGH** | spec FR-008 / `state_branches` 7；plan §D4；tasks T004                       | 三处都写「warn finding」，但 `SyncRunFinding` 的 kind 值域是 `failure / reject / skip / interrupt / notice / unjudged`（`sync-run.recorder.ts:20-83`），**没有 `warn`**。照写会 typecheck 红，或诱导新开一个 kind 动 recorder 与消费方 | 统一改为 `kind: 'notice'`，`step: 'option_contract_size_mismatch'`，`detail: { symbol, mismatched, samples }`；spec FR-008 与 branch 7 的「warn」改为「留痕（notice）」，语义不变（非失败、不改判、不计数）                    |
| I3  | Inconsistency    | MEDIUM   | tasks T003；`sync-option-contract.usecase.ts:275`                           | T003 把新 Map 命名为 `discovered`，与既有 `discovered: Set<string>`（到期日集合，喂 `gapCheckExpiryDates`）撞名                                                                                                                | 新 Map 命名 `sizeByCode: Map<string, number \| null>`；既有 `discovered` / `discoveredCodes` 只把后者换成 `sizeByCode.keys()`                                                                                                   |
| U1  | Underspecified   | MEDIUM   | tasks T002 / T004 / T005                                                    | 三个 port 类型加**必填**字段 `contractSize` 会让所有构造这些行的测试替身编译红：`option-snapshot-remediation.it.spec.ts`、`fake-leg-retrieval.adapter.ts`、`optionsdesk-064.overlay.it.spec.ts`、`leg-retrieval.port.spec.ts`、`get-chain-report.usecase.spec.ts`、`sync-option-oi-settle.usecase.spec.ts`、`option-snapshot-guard.rules.spec.ts`、`option-anomaly.rules.spec.ts` 等（grep `isStandard:` / `expirationCycle` 命中）。typecheck 会逼出，但 tasks 未列，估时会漏 | 三条 task 各加一句「编译器逼出的替身 / 夹具一并补 `contractSize`（默认 null 或 100，按臂语义），不改判据」；🚫 不把字段做成可选去躲编译错误                                                                                     |
| C1  | Constitution §III | MEDIUM  | tasks T003 / T005                                                           | 两条 task 各含多文件改动 + 5 / 3 条 IT 臂 + 变异留档，估时 2–3h，超「30min–2h 可独立 commit」上限；071 T006a（7 臂）当时由 analyze 裁成单独批次而非拆 task                                                                        | 二选一：① 保持单 task，但在「Clear 检查点批次」里让 T003、T005 各自单独成批（071 先例）② 拆 T003a（`contractRow` + Map + 单测）/ T003b（对账第三步 + IT 五臂），T005a（类型 + 派生 + 单测 + 调用点）/ T005b（052 IT 三臂）。建议 ①，改动最小 |
| I4  | Inconsistency    | LOW      | plan §Gate 0.1 vs tasks D8 / T005                                            | plan 写读路径由 `optionsdesk-052.retrieval.it.spec.ts` **与** `optionsdesk-071.hk-realtime.it.spec.ts` 加臂承载；tasks 只用 052                                                                                                  | plan Gate 0.1 删去 071 那一处（052 已覆盖港股夹具），或 T005 加一臂到 071 IT（实时窄路径 `answered` 行携带 `contractSize`）—— 建议后者，它顺带钉住 plan §D5「实时路径自动携带」这句结构论断                                     |
| I5  | Inconsistency    | LOW      | tasks T006 tag vs `state_branches` 矩阵第 8 行                               | 矩阵把 branch 8 落到「T005-① + T006 冒烟臂」，但 T006 的 tag 行没有 `state_branches 8`                                                                                                                                            | T006 tag 补 `state_branches 8`                                                                                                                                                                                                    |
| U2  | Underspecified   | LOW      | tasks T006；`071-hk-realtime.contract.ts:330-337`                            | 契约冒烟的合约是**裸 SQL INSERT 显式列名**播种；T006 写「播 `contractSize 500`」但没指出要改那条 INSERT 的列表                                                                                                                    | T006 明写：`seed()` 的 `INSERT INTO marketdata.option_contract (…)` 加 `contract_size` 列，hk 500 / us 100                                                                                                                       |
| U3  | Underspecified   | LOW      | tasks T004「≤ 既有样本上限」                                                 | 快照 usecase 的样本封顶是逐 code 一条（`sampleByCode`，`:758`），没有独立的上限常量                                                                                                                                             | T004 明写样本形态：逐票取前 N 条 `code: 库值≠快照值`（N 取一个具名常量，如 `CONTRACT_SIZE_MISMATCH_SAMPLES = 5`），别引用不存在的「既有上限」                                                                                    |
| U4  | Underspecified   | LOW      | tasks T002 真夹具                                                            | 夹具从 prod shim 拉，`_provenance` 块若照抄 PoC 脚本会带 shim URL（RFC1918，第一层可公开）与容器名；仓面向公开，`check-identifier-boundary.ts` 会扫                                                                             | T002 明写 `_provenance` 只记「prod shim `/option-chain`、日期、窗口、码数」，不记 host / 容器名；落盘后跑 `pnpm tsx scripts/checks/check-identifier-boundary.ts`                                                                |
| A1  | Ambiguity        | LOW      | spec FR-005「留痕」 vs FR-006「留 notice 记录」 vs FR-008「留 warn」          | 同一个词「留痕」在三条 FR 里指两种机制（adapter 日志 warn vs 采集轮 finding）                                                                                                                                                    | FR-005 改为「记空并写日志（adapter 层无采集轮上下文，不进 findings）」；FR-008 随 I2 改为 notice。三条各指明机制                                                                                                                 |

## Coverage Summary

| Requirement | Has Task? | Task IDs                    | Notes                                  |
| ----------- | --------- | --------------------------- | -------------------------------------- |
| FR-001      | ✅        | T002, T003                  |                                        |
| FR-002      | ✅        | T002                        |                                        |
| FR-003      | ✅        | T002, T004                  |                                        |
| FR-004      | ✅        | T002                        | 结构承接 + 真夹具臂                    |
| FR-005      | ✅        | T002                        | 见 A1                                  |
| FR-006      | ✅        | T003                        |                                        |
| FR-007      | ✅        | T003                        |                                        |
| FR-008      | ✅        | T004                        | 见 I2                                  |
| FR-009      | ✅        | T005                        |                                        |
| FR-010      | ✅        | T005                        |                                        |
| FR-011      | ✅        | T005                        |                                        |
| FR-012      | ✅        | T006                        |                                        |
| FR-013      | ✅        | T001, T005, T007            | 三处注释 + 047 注记                    |
| FR-014      | ✅        | T002（夹具）, T008（落档）  |                                        |
| FR-015      | ✅        | T009                        | 部署后                                 |
| SC-001      | ✅        | T005, T006, T009            |                                        |
| SC-002      | ✅        | T005                        |                                        |
| SC-003      | ✅        | T009                        | 部署后验收，蓄意无 CI 断言             |
| SC-004      | ✅        | T002, T003                  |                                        |
| SC-005      | ✅        | T002–T006 变异留档          |                                        |
| SC-006      | ✅        | T006                        |                                        |
| SC-007      | ✅        | T003                        |                                        |

`state_branches` 13/13 有落点（第 13 条蓄意零覆盖，理由已写）；Edge Cases 8/8；Acceptance Scenarios 10/10。

**Constitution Alignment Issues**：无 CRITICAL。§III 粒度见 C1（MEDIUM）；§II TDD 每条 task 有先红后绿 + 变异；§IV 零新表 / 零新 port / 既有 `CROSS-CONTEXT-READ` 直查多带一列；§V 单 PR，契约形状零变化。

**Unmapped Tasks**：无（T007 → FR-013；T008 → FR-014 / SC 收口）。

**Metrics**：Requirements 22（FR 15 + SC 7）· Tasks 9 · Coverage 100% · Ambiguity 1 · Duplication 0 · Critical 0 · High 2 · Medium 3 · Low 6。

## Next Actions

HIGH 两条（I1 绊线未翻、I2 `warn` 不在 kind 值域）不修会在 T001 / T004 当场红，建议 implement 前先改 tasks + spec 措辞；MEDIUM 三条建议一并改（I3 改名、U1 补一句、C1 选 ①）。LOW 六条可随 impl 顺手改。改完不需要重跑 plan。

## 订正记录（2026-09-06）

11 条全部已按建议改入 spec / plan / tasks：I1（T001 翻绊线 + plan Guardrail）· I2（三处 warn → notice，spec FR-008 / branch 7 / plan §D4 / T004）· I3（`sizeByCode`）· U1（plan Guardrail + T002 / T004 / T005 各一句）· C1（Clear 批次改六批）· I4（T005 加 071 IT 臂）· I5（T006 tag）· U2（T006 INSERT 列）· U3（具名常量）· U4（T002 provenance 纪律）· A1（FR-005 / FR-008 各指明机制）。
