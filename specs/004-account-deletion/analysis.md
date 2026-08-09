---
feature_id: 004-account-deletion
spec_ref: ./spec.md
plan_ref: ./plan.md
tasks_ref: ./tasks.md
status: analyzed
created_at: '2026-05-26'
---

# Specification Analysis Report: 004-account-deletion

跨 `spec.md` / `plan.md` / `tasks.md` / `constitution.md` 一致性扫描（read-only，per `/speckit-analyze`；mono 产出写盘 per p3 偏离）。**作者单会话顺序产出 spec→clarify→plan→tasks，覆盖度高**；以下为高信号发现。

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| C1 | Coverage | **MEDIUM** | spec FR-S21 · tasks T007/T008/T017 | FR-S21 `503 SMS_SEND_FAILED`（eligible 发码路径短信失败）**无专 task**，且 grep 实证 mono 001 `request-sms-code` 无既有 SMS-failure→503 映射 → **非 reuse**，是新行为 | implement 时加小步：定义 `SmsSendFailedException`→503 `SMS_SEND_FAILED`（ProblemDetail 映射），并入 T008/T017 sendCode 调用的 catch；或显式 descope FR-S21（接受 generic 500，spec 标注）。建议补进 T007 或新增 T007b |
| I1 | Inconsistency | **MEDIUM** | spec Key Entities/state_branches vs plan/tasks 落位表 | 事件类型命名漂移：spec 用 PascalCase `AccountDeletionRequestedEvent` / `…Cancelled` / `…Anonymized`；plan/tasks 用 kebab `account.deletion-requested` 等；mono 既有 convention（grep 实证）= `auth.account.created`（`<producer-ctx>.<aggregate>.<action>`） | implement 时统一 **wire eventType 串**为既有 kebab 范式（delete/cancel 由 auth 编排 → `auth.account.deletion-requested` / `auth.account.deletion-cancelled`；anonymize 由 account 产 → `account.account.anonymized` 或定前缀规则）；spec PascalCase 留作概念名。T012/T021/T027 落地时钉死 |
| U1 | Underspecification | LOW | tasks T022 | CancelDeletion 编排中 `phone→accountId 解析 + 5-class 折叠 + phone-class dummy pad + 条件 commit` 交互密，T022 单行描述 | implement 注意顺序：inspect(phone) 取 accountId（NOT_FOUND 也走 pad+401）→ 预生成 token → tx 内条件 commit + markUsed + persist + publish；non-blocking |
| G1 | Coverage (by design) | LOW | spec FR-C01/FR-C02 · US10 · SC-C01 | delete-account 发起屏 + 错误展示 + 屏流程 SC **无 task** | **非缺口** —— 2026-05-26 clarify 定延后 settings shell feature（spec 已标 DEFERRED）；无需动作 |
| D1 | Alignment | LOW | plan D3 vs catalog anticipated `freeze-account` | D3 token 撤销取 R2-sync（扩 `revokeAllForAccount` 收 tx），偏离 catalog 预设的 `freeze-account` R3-async | catalog anticipated 行是**预测非 MUST**（非 constitution 违反）；plan 已 reasoned（spec 要 sync 原子 + 消费方 out-of-scope）+ gate-flagged；T036 catalog 更新时记差异即可。**已在 gate review 暴露给 user** |
| R1 | Coverage (reuse) | LOW | spec FR-S19 · controllers | FR-S19 RFC 9457 ProblemDetail 无专 task | 可接受 —— 001 全局 filter 复用，controller task（T009/T014/T018/T023）隐含；无需专 task |

## Coverage Summary（Server FR → tasks）

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-S01 发送注销码 | ✅ | T008/T009/T010 | |
| FR-S02 发码鉴权状态门槛(INVALID_CREDENTIALS) | ✅ | T008/T010 | |
| FR-S03 提交码冻结 | ✅ | T011/T013/T015 | |
| FR-S04 冻结原子性 | ✅ | T013/T015 | |
| FR-S05 删除码反枚举(INVALID_DELETION_CODE) | ✅ | T013/T016 | |
| FR-S06 冻结并发恰一 | ✅ | T011/T016 | affected-count（D2） |
| FR-S07 发撤销码 public 反枚举 | ✅ | T017/T019 | |
| FR-S08 撤销码 phone 校验 422 + hash 限流 key | ✅ | T018 | |
| FR-S09 提交撤销码解冻 | ✅ | T020/T022/T024 | |
| FR-S10 解冻原子性 | ✅ | T022/T024 | |
| FR-S11 撤销反枚举(INVALID_CREDENTIALS) | ✅ | T022/T025 | |
| FR-S12 撤销并发恰一 | ✅ | T020/T025 | affected-count（D2） |
| FR-S13 匿名化 scheduler | ✅ | T028/T029 | |
| FR-S14 匿名化变更集 | ✅ | T026/T029 | sms 不删（D6） |
| FR-S15 匿名化隔离幂等 | ✅ | T026/T028/T029 | |
| FR-S16 撤销⟷匿名化互斥 | ✅ | T020/T026/T030 | 谓词互斥（D2） |
| FR-S17 验证码存储 HMAC + purpose 隔离 | ✅ | T005/T006 | DB account_sms_code（D1） |
| FR-S18 限流 8 桶 | ✅ | T009/T014/T018/T023/T031 | |
| FR-S19 RFC 9457 ProblemDetail | ⚠️ reuse | （001 filter） | R1，隐含 |
| FR-S20 跨 ctx 事件 + 边界 + catalog | ✅ | T012/T021/T027/T036/T037 | |
| FR-S21 SMS 网关失败 503 | ❌ **gap** | （T007 仅扩 gateway） | **C1 MEDIUM** |
| FR-C01/C02 注销屏 + 错误 | 🔵 deferred | — | G1，clarify 延后 |
| FR-C03 FROZEN modal | ✅ | T034 | |
| FR-C04 撤销屏 | ✅ | T033 | |
| FR-C05 撤销错误展示 | ✅ | T033 | |

SC（SC-S01..S15 / SC-C01..C04）：除 SC-C01（注销屏，G1 deferred）外，全部由对应 `[Server-IT]`（T010/T015/T016/T019/T024/T025/T029/T030/T031）+ client（T033-T035）+ T037（SC-S15 moat/boundary）覆盖。

## Constitution Alignment

**无违反。** 5 原则逐条核对：

- **I. SDD**：spec→clarify→plan→tasks 完整，analyze（本）后 analyze→implement 人工卡点 ✅
- **II. Test-First TDD**：每 impl task 内联绑 unit + IT 单列 `[Server-IT]`（红→绿→`[X]`→commit）✅
- **III. Atomic 30min-2h + 独立 commit**：T001-T037 颗粒合规，三位一体同 PR ✅
- **IV. Module Boundary（扁平/贫血/护城河/单向）**：`auth→account→security` 单向；delete/cancel auth 持 tx 委托（forward）；anonymize account→security（forward）不调 auth（D6 避反向）；跨 ctx 注释 + `check-server-moat.ts`（T037）✅
- **V. 类型同步链 Nx-driven**：Contract T032（openapi→Orval）+ server/contract/mobile 同 PR ✅

## Unmapped Tasks

**无。** 全部 task 映射到 FR/US 或属 Setup（T001）/ Foundational（T002-T007）/ Contract（T032）/ Polish（T036-T037）。

## Metrics

- Total Server FR: 21（FR-S01..S21）· Client FR: 5（FR-C01..C05，2 deferred by design）
- Total SC: 19（SC-S01..S15 + SC-C01..C04）
- Total Tasks: 37（T001-T037）
- Coverage（Server FR ≥1 task）: 20/21 实装 + 1 reuse(FR-S19) ；**1 gap(FR-S21 C1)**
- Coverage（Client FR）: 3/3 in-scope（2 deferred 非缺口）
- Ambiguity Count: 0（spec 无 vague-adjective placeholder / 无 TODO/???）
- Duplication Count: 0
- **Critical: 0 · High: 0 · Medium: 2（C1/I1）· Low: 4**

## Next Actions

无 CRITICAL/HIGH → **可进 `/speckit-implement`**，但建议先处理 2 个 MEDIUM（均小、可在 implement 起手时收口，非阻塞）：

1. **C1（FR-S21 503）**：implement 起手决定 —— 加 `SmsSendFailedException`→503 映射（补进 T007 / 新增 task），或 descope FR-S21 接受 generic 500（spec 标注）。
2. **I1（事件命名）**：implement 落 T012/T021/T027 时钉死 wire eventType kebab 串（follow `auth.account.created` 范式），spec PascalCase 留概念名。

D1（R2-sync vs catalog R3）已在 plan→tasks gate 暴露给 user，T036 记差异即可。G1/R1/U1 无需动作。

## Resolution（2026-05-26，analyze→implement gate）

- **C1 → 已结算（加）**：user 拍板加 503（旧 Java 有 + spec 已列 + cheap）→ 新增 **T007b**（`sms-send-failed.exception.ts` 503 `SMS_SEND_FAILED` + T008/T017 eligible 发码 catch 转换）。
- **I1 → 已结算（钉死）**：wire eventType 按 mono `auth.account.created` 范式 `<producer-ctx>.<aggregate>.<action>` 钉死 —— `auth.account.deletion-requested`（T012）/ `auth.account.deletion-cancelled`（T021）/ `account.account.anonymized`（T027）；spec PascalCase 留概念名。
- 其余（D1/G1/R1/U1）无需动作。tasks 现 **38 task**（T001-T037 + T007b）。

