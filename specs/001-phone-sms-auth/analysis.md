# /speckit-analyze: Phone SMS Auth Cross-Artifact Consistency Report

**Date**: 2026-05-17 | **Artifacts**: `spec.md` v1 (W2.1) + `plan.md` v1 (W2.2) + `tasks.md` v1 (W2.3) + `constitution.md` v1.0.0
**Purpose**: 跑 `/speckit-analyze` per SDD 流程，扫 spec / plan / tasks / constitution 4 artifact 一致性，输出 finding 表给 user 决策是否 proceed to `/speckit-implement` (W2.4)。

## Summary

**整体**：4 artifact 高度一致；3 处 minor finding（无 blocker），1 处 W2 决策 trace warning。**建议 proceed 到 W2.4 implement**（pending user review gate approval）。

| 维度 | 状态 |
|---|---|
| Spec → Plan 覆盖 | ✅ 12 FR-S + 6 SC-S 全映射 |
| Plan → Tasks 覆盖 | ✅ 7 R0 决策 + 4 层结构 + Constitution gate 全拆 task |
| Constitution → Plan/Tasks alignment | ✅ 5 原则全 trace；W2 不涉及的（V 类型链）显式标 |
| Tasks 内部一致性 | ✅ 42 tasks 编号连续；US/Phase/Story label 全；依赖图清晰 |
| Stop 信号定义 | ✅ 4 类（spec 歧义 / 新 dep / destructive op / 跨 PR scope） |

## Finding Table

### Coverage Checks

| # | Spec / Plan / Constitution element | tasks.md task mapping | 状态 |
|---|---|---|---|
| C1 | FR-S01 Phone E.164 校验 | T007 Phone VO + T023 controller DTO @Matches | ✅ |
| C2 | FR-S02 SMS code Redis TTL 300s | T008 SmsCode VO + T019 SmsCodeRedisRepository | ✅ |
| C3 | FR-S03 Aliyun SMS Template A | T020 MockSmsGateway（W3 替 Aliyun per plan R0.3） | ✅ defer 明示 |
| C4 | FR-S04 `/sms-codes` 无 purpose 字段 | T023 controller DTO + T015 RequestSmsCodeUseCase | ✅ |
| C5 | FR-S05 unified endpoint 自动判 login/register | T022 PhoneSmsAuthUseCase ACTIVE + T030 未注册路径 | ✅ |
| C6 | FR-S06 timing defense ≤50ms | T037 dummy bcrypt timing equalize + T034 测试 | ✅ |
| C7 | FR-S07 rate limit 4 条 | **defer W3** per plan R0.2；tasks 无对应 task；T042 polish 加 ruleset 时不含 throttler check | ⚠️ defer 明示 |
| C8 | FR-S08 并发同号唯一性 | T024 transaction race test + T030 unique constraint fallback | ✅ |
| C9 | FR-S09 JWT 15min + refresh 30day | T009 JwtTokenService + T022 sign tokens | ✅ |
| C10 | FR-S10 RFC 9457 ProblemDetail | T006 ProblemDetailFilter | ✅ |
| C11 | FR-S11 outbox event | T012 AccountCreatedEvent + T029 EventPublicationPrismaPublisher + T030 transaction publish + T041 placeholder subscriber | ✅ |
| C12 | FR-S12 路由命名 sms-codes + phone-sms-auth | T023 controllers | ✅ |
| C13 | SC-S01 100 个 phone 并发 0 错误 | T028 e2e（不显式 100 并发，是 W3 load test）| ⚠️ 减裁 — load test defer W3 |
| C14 | SC-S02 ACTIVE/未注册混合并发 | T024 + T028 部分 cover；100 并发 W3 | ⚠️ 减裁 — load test defer W3 |
| C15 | SC-S03 反枚举字节级一致 + ≤50ms | T035 e2e + T037 timing impl | ✅ |
| C16 | SC-S04 限流准确性 | defer W3 同 C7 | ⚠️ defer 明示 |
| C17 | SC-S05 OpenAPI sms-codes 无 purpose | T023 controller decorators；export-openapi defer W4 per plan V 注释 | ⚠️ defer 明示 |
| C18 | SC-S06 旧 endpoint 0 leak | N/A — mono 从零写无 legacy；spec FR-S12 已 amend | ✅ N/A |
| C19 | Constitution I SDD | tasks 全在 SDD 6 步 phase 内 | ✅ |
| C20 | Constitution II TDD | 每 implement task 绑 Test task RED；T013-T017 / T025-T028 / T032-T035 显式 | ✅ |
| C21 | Constitution III Atomic | 42 tasks 都 30min-2h；每 task 1 commit | ✅ |
| C22 | Constitution IV Module Boundary | T002 装 eslint-plugin-boundaries + T040 V2 验收 | ✅ |
| C23 | Constitution V Type Chain | plan 显式 W2 不涉及；tasks 无对应 task | ✅ defer W4 明示 |

### Consistency Findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | spec FR-S03 提"Aliyun SMS Template A 真实验证码"；plan R0.3 defer Aliyun 到 W3，W2 用 MockSmsGateway | ⚠️ Low | tasks T020 显式 MockSmsGateway + 标记"W2 占位，W3 替 Aliyun"；W3 阶段 spec 段 FR-S03 实施时 verify Template A code path |
| F2 | spec FR-S07 提 4 条限流规则；plan R0.2 defer 到 W3；tasks 无 task；CI W2.4 完不会跑 throttler test | ⚠️ Low | analysis 显式 C7 + C16 defer；W3 spec 再 amend FR-S07 timing；W2 implement 期间不阻塞 |
| F3 | spec SC-S01/SC-S02 100 个 phone 并发 load test；tasks 只做 unit + e2e（非 load test 100 并发） | ⚠️ Low | C13 + C14 defer W3 load test；W2 e2e 仅基本 happy path；W3+ 加 100-concurrent load test job |
| F4 | spec FR-S11 outbox subscriber 行为（"AccountCreatedEvent 处理"）未在 spec 描述具体消费方 | ⚠️ Low → spec drift 风险 | tasks T041 polish 加 subscriber **placeholder**（cron scan + mark as published），真实消费方（search-index / welcome SMS 等）作 W3+ 后续 use case 范围 |
| F5 | tasks T002 装 eslint-plugin-boundaries + 配 4 类规则；mono 当前未装 ESLint 9 flat config（W1.4 仅 `apps/server/eslint.config.mjs` 存在 但 minimal） | ℹ️ Info | T002 description 已含"装 ESLint 9 + @nx/eslint + plugin-boundaries 全套"；implement 阶段第 1 commit 即装 |
| F6 | Constitution Quality Gate 4 required checks；T042 计划 polish 阶段加 lint + test → 5+1+1 = 6 required checks | ℹ️ Info | T042 显式 amend ruleset；如 W2 implement 阶段 PR 频繁，可考虑 implement 第一 PR 后立即加 ruleset 而非 polish 才加（避免 implement PR 不被 lint/test 拦） |
| F7 | tasks T030 PhoneSmsAuthUseCase 在 ACTIVE + 未注册 + FROZEN/ANONYMIZED 三路径 amend；US 之间共享文件冲突 | ⚠️ Medium → 协作风险 | solo dev 串行 US1→US2→US3 顺序 OK；明示 US 之间 tasks **不可并行**（虽 [P] 标 — 仅 within US 内 [P] 适用）；implement 阶段不能 parallel US |
| F8 | T024 + T028 + T031 + T038 都做 e2e smoke；Testcontainers 启动开销大 | ℹ️ Info | implement 阶段评估是否 share Testcontainers fixture（per US 还是 per spec）；可加 polish task `T0XX: e2e fixture 共享化` 但 W2 阶段不必 |

### Drift Risk Assessment

| 区域 | Drift 风险 | 应对 |
|---|---|---|
| FR-S03 → impl Aliyun SMS | High @ W3 | W3 spec amend + 同步 plan R0.3 implement |
| FR-S07 → impl rate limit | High @ W3 | W3 spec amend + 加 throttler task batch |
| FR-S11 → outbox subscriber | Medium @ W3+ | spec 加 subscriber 行为段（welcome SMS / search-index 何时谁负责） |
| Constitution IV → 实际 module 边界 | Low | T040 V2 报告写完后定期 lint 跑（CI 自动） |

### Stop / Surface Signal Coverage

| 情况 | tasks.md Stop 列表覆盖 | 备注 |
|---|---|---|
| spec 歧义（如 timing defense 具体 ms 阈值） | ✅ | implement 时撞 → 停 + 问 user |
| 新增 npm dep（如 outbox 改 BullMQ） | ✅ | 含 |
| destructive op（rm -rf / drop table） | ✅ | 含 |
| 跨 PR scope（ruleset / mono-level config） | ✅ | T042 amend ruleset 是计划内 |
| **新发现**：跨 US 共享文件冲突（PhoneSmsAuthUseCase 三 US amend） | ❌ 未明示 | **建议加 stop 规则**：跨 US amend 同文件 → solo dev 串行强制；implement 时检测 |

## Recommendations

### MUST 修（implement 前）

无（所有 finding 都 Low / Info / Medium with mitigation）。

### SHOULD 考虑（implement 前 user 评估）

1. **F6 T042 提前**：W2.4 implement 第 1 个 PR ship 后立即 amend ruleset 加 lint + test required check（而非 polish 才加）— 避免 implement 中段 PR 漏过 lint/test 把关
2. **F7 跨 US 串行规则**：solo dev implement 阶段强制 US1 → US2 → US3 顺序；写在 tasks.md "Implementation Strategy" 段 + analysis 段一致

### MAY 考虑（W3+ 改进）

3. **F8 e2e fixture 共享化**：4 个 e2e task 都启 Testcontainers，可加 `apps/server/test/integration/setup.ts` 共享 PG + Redis container；W2 不必，W3 加 use case 时一起做

## Verdict

**Status**: 4 artifact 一致性 **PASS** — 可 proceed to `/speckit-implement` (W2.4)

**Pending user review gate decision**:
- ✅ Approve → W2.4 启动，T001 第 1 task 装 vitest 起
- ⚠️ Approve with amend → 按 user 指示先 amend spec/plan/tasks 任一 → re-run analyze
- ❌ Reject → 留 PR，user 标具体反对点，amend 后重 review

**implement 期间提醒**:
- 每 task 走 6 步闭环（per task-closure preset hard rule）
- 每 task 1 commit；多 task 不混 commit（per Constitution III）
- 4 类 Stop 信号触发 → 停 + 问 user（per tasks.md Stop 列表）
- context7 grounding @nestjs/jwt + cockatiel 已 plan 阶段做；impl 阶段 task 用到具体 API 再 ground（per context7-injection IMPLEMENT phase directive）

---

**Analyze Version**: 1.0.0 | **Reviewed Artifacts**: spec v1 + plan v1.0.0 + tasks v1.0.0 + constitution v1.0.0 | **Findings**: 8 (6 Low/Info + 1 Medium with mitigation + 1 Recommendation)
