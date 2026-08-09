# Specification Analysis Report: 005-device-management

> `/speckit-analyze` 跨 `spec.md` / `plan.md` / `tasks.md` / `constitution.md` 一致性扫描（read-only 分析，本文件为报告留痕，per mono 约定）。生成于 2026-05-26（analyze→implement gate 前）。

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| C1 | Inconsistency | **MEDIUM** | plan.md（Cross-cutting）+ tasks T006 | list-devices 注入 `RefreshTokenService` 标 `// CROSS-CONTEXT-READ`，但既有约定（`refresh-token.usecase.ts` 注入 `RefreshTokenService` 即用 `// CROSS-CONTEXT-SYNC`，含只读）；`// CROSS-CONTEXT-READ` 仅用于 `prisma.<otherTable>` **直读**逃生口（`check-server-moat.ts` Check 1，Q7-B）。本 feature 经 security **服务方法**读，不直碰表 → 标 READ 是 convention drift（探针虽不报错——Check 1 只扫直查表，但 CR/catalog 口径不一） | list/find 注入注释改 `// CROSS-CONTEXT-SYNC`；revoke 的 tx 写本就 SYNC ✓ |
| R1 | Ambiguity（待定→**RESOLVED**） | LOW | plan D3 / tasks T004 | `DeviceRevokedEvent` event-type `auth.device.revoked` 标「待 analyze 确认」 | **确认采用 `auth.device.revoked`**：producer=`auth`（tx holder + 编排发起，沿 `delete-account`→`auth.account.deletion-requested` 范式）；aggregate=`device`（沿旧 Java `DeviceRevokedEvent` 域语言；首个非 `account` aggregate，但符 `<producer-ctx>.<aggregate>.<action>` 结构）。移除「待确认」措辞 |
| G1 | Coverage Gap | LOW | spec SC-S09 / tasks | SC-S09（list P95≤150 / revoke P95≤120）标「env-gated perf IT」但无对应 task。004 先例：**无**独立 latency perf-IT（仅 security 50ms timing-diff 折进 US IT） | 二选一（建议 a）：(a) 沿 004，SC-S09 视作 frontmatter `perf_budgets` 声明预算（非独立 IT），spec 删「env-gated perf IT」措辞；(b) 加 1 个 `RUN_PERF_IT` env-gated perf task |
| L1 | Underspecification | LOW | spec FR-S01/S02 vs plan/tasks | 分页 envelope 字段 `totalElements`/`totalPages` 在 plan API contract + T006 DTO，spec FR 仅写「分页」未显列 | 可接受：response shape 真相源 = server swagger→Orval；无需改 spec |
| L2 | Task sizing | LOW | tasks T003 | T003 扩 3 方法（list+find+revokeOne）+ Testcontainers 测，接近 2h 上限 | 实施时若超 2h 可拆 list / (find+revoke) 两 commit；不强制（与 004 T002/T003 同量级） |

## Coverage Summary（Server FR → tasks）

| FR | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-S01 list 分页 | ✅ | T003,T006,T007,T008 | |
| FR-S02 item shape | ✅ | T006,T008 | |
| FR-S03 isCurrent(x-device-id) | ✅ | T006,T008 | |
| FR-S04 location + 无 raw IP | ✅ | T002,T006,T008 | |
| FR-S05 仅本账号 | ✅ | T003,T008 | |
| FR-S06 revoke affected-count | ✅ | T003,T009,T011 | |
| FR-S07 自撤 409 | ✅ | T005,T009,T010,T011 | |
| FR-S08 反枚举 404 | ✅ | T005,T009,T011,T012 | |
| FR-S09 幂等 | ✅ | T009,T011,T012 | |
| FR-S10 事件同 tx | ✅ | T004,T009,T011 | |
| FR-S11 原子 | ✅ | T009,T011 | |
| FR-S12 缺 x-device-id 401 | ✅ | T009,T010 | |
| FR-S13 限流 4 桶 | ✅ | T007,T010,T013 | |
| FR-S14 采集补强 | ✅ | T014 | |

**SC**：SC-S01→T008 / SC-S02→T008 / SC-S03→T011 / SC-S04→T011 / SC-S05→T012 / SC-S06→T012 / SC-S07→T011,T012 / SC-S08→T013 / **SC-S09→（无 IT，见 G1）** / SC-S10→T014。

## Constitution Alignment

无 MUST 违反。

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD | ✅ | specify→clarify→plan→tasks→analyze（本）→implement |
| II. TDD | ✅ | 每 impl task 内联 unit + 每 US `[Server-IT]`（Testcontainers）|
| III. Atomic 30min-2h | ✅ | T003 偏大（L2，可拆）；余适中 |
| IV. Module Boundary | ✅ | auth→security 单向；auth 零 `tx.refreshToken.*`（经 security 服务）；`IpGeoService` platform infra（ADR-0041 免 R2/R3）。**C1 是注释口径，非边界违反** |
| V. 类型同步链 | ✅ | T015 openapi→Orval（本批无 mobile 消费）|

## Unmapped Tasks

T001（setup）/ T015（contract）/ T016（catalog+frontmatter）/ T017（verify）—— 均为 setup/process/polish，非 FR 映射但必需，非问题。

## Metrics

- Total Server FR: **14** · Server SC: **10**
- Total tasks: **17**
- FR Coverage: **14/14 = 100%**
- SC Coverage: **9/10 = 90%**（SC-S09 perf 为声明预算，per 004 先例无独立 IT）
- Ambiguity: **1**（R1 event 命名，已 RESOLVED）
- Duplication: **0**
- Critical Issues: **0**

## Next Actions

- **无 CRITICAL / HIGH** → 可进 `/speckit-implement`。
- 建议 implement 前先落 **C1**（注释口径 SYNC）+ **R1**（确认 event 名、去「待确认」）+ **G1**（建议沿 004：spec 去「env-gated perf IT」措辞）—— 3 处均为 plan/tasks/spec 文字微调，不改架构。
- L1/L2 不阻塞。

## Resolution（2026-05-26，analyze→implement gate）

User 批准（选项 a）→ 3 处 remediation 已落：

- **C1 ✅**：plan.md（Cross-cutting）+ tasks T006 注入注释 `// CROSS-CONTEXT-READ` → `// CROSS-CONTEXT-SYNC`（与 `refresh-token.usecase.ts` 注入 `RefreshTokenService` 同款；auth 不直碰 `prisma.refreshToken` 故无 READ 逃生口）；tasks T017 verify 口径同步更新。
- **R1 ✅**：plan D3 + Bounded Context note + tasks T004 去「待 analyze 确认」→ 确认采用 `auth.device.revoked`。
- **G1 ✅**（选项 a，沿 004）：spec SC-S09 删「env-gated perf IT」→ 改「frontmatter perf_budgets 为 SoT，PoC 不逐 feature load-test，不设独立 perf IT task」。
- L1/L2 不动（不阻塞）。

→ gate 通过，可进 `/speckit-implement`。
