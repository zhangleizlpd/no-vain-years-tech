# Specification Analysis Report — 008-profile-name-gender-edit

**Date**: 2026-05-30 | **Artifacts**: spec.md / plan.md / tasks.md / constitution.md
**Scope**: cross-artifact consistency (read-only) before `/speckit-implement`

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| **F1** | Coverage gap | LOW | spec FR-S05（限流 429）/ tasks T003 IT 清单 | T003 加 `@Throttle({'me-patch':{10,60_000}})` 装饰器，但 IT 验收清单只列「持久化/400/清空/401」，未列 **429**。沿用既有共享 `me-patch` bucket（002/007 已覆盖），新 route 复用同桶 | T003 IT 清单显式声明「限流复用既有 `me-patch` bucket，不新测 429」**或**补一条 429 断言；二选一以免 implement 时漏判 FR-S05 覆盖 |
| **F2** | Underspecification (错误态 UX) | LOW | spec US1 / Edge Cases / plan D6 / tasks T010-T011 | 性别屏 **tap-to-select 无保存按钮**：PATCH 失败（网络/429/400）时须**留在本屏 + 显错、不自动返回**。plan D6/T010（`genderEditErrorToast` + success-only back）已含此逻辑，但 spec `## Edge Cases` 仅列「快速重复点同选项→幂等」，未列「点选后端失败」分支 | implement 时确保 T011 仅 `phase==='success'` 才 `router.back()`、error 留屏 + toast（已在 T010/T011 设计内）；spec Edge Cases 可选补「性别点选 PATCH 失败 → 留屏显错不返回」一行（非阻塞）|
| **F3** | Inconsistency (phase↔US 编号顺序) | LOW | tasks Phase 2/3/4 标题 vs spec US 优先级 | tasks 物理顺序 = Phase 2「US2 昵称」→ Phase 3「US1 性别」→ Phase 4「US3 重排」（**按依赖排序**：US1 待契约 T005、两屏须先于 US3 导航）。spec 把 US1 列首（唯一后端写入）。**US 标签与 spec 内容一一对应、无互换**（区别于 007 F1 的真 drift），仅 phase 序号 ≠ US 序号 | 无需改 —— 依赖排序已在 `## Dependencies` 显式说明；保留现状。implement 按 task ID（T001→T015）顺序走即可 |

## Coverage Summary（高信号摘要，全 20 需求均 ≥1 task）

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-S01（Account gender 可空字段 / anemic row）| ✅ | T001 | schema expand 可空列 |
| FR-S02（authed 更新端点持久化）| ✅ | T003 | `update-gender.usecase` + controller |
| FR-S03（4 枚举或 null 校验 / 非法 400）| ✅ | T002, T003 | `normalizeGender` 纯函数 + IT 400 |
| FR-S04（缺/失效 token → 401）| ✅ | T003 | 复用既有 authed 守卫，IT 401 |
| FR-S05（限流 429）| ⚠️ 弱 | T003 | 见 F1（复用 `me-patch` bucket，IT 未显式列 429）|
| FR-S06（GET /me 含 gender + 契约 regen）| ✅ | T004, T005 | IT 回读 + api-client regen |
| FR-C01（行序 头像/昵称/性别/个人简介/主页背景图）| ✅ | T013, T014 | 个人简介↔性别对换 |
| FR-C02（昵称行翻 active）| ✅ | T013 | push name-edit |
| FR-C03（设置昵称屏 RHF + N/32 + ×清空）| ✅ | T007, T008 | 复用 displayNameSchema |
| FR-C04（保存调 002 PATCH /me）| ✅ | T007, T008 | 0 server 改动 |
| FR-C05（性别行翻 active + 中文标签）| ✅ | T013, T006 | value=genderLabel(useMe gender)|
| FR-C06（设置性别屏 4 行 + 对勾 + 点选即存）| ✅ | T010, T011 | 非 RHF tap-to-select |
| FR-C07（gender 中文标签映射共用）| ✅ | T006 | `~/settings/gender.ts` 单源 |
| FR-C08（头像/背景图 disabled + 无对象存储）| ✅ | T013, T015 | grep 无 image-picker |
| FR-C09（两屏复用 _layout/primitives，不进 ~/ui）| ✅ | T008, T011 | 局部对勾行不抽 ~/ui |
| SC-001（性别全链 持久化/400/清空/401/回读/预选）| ✅ | T003, T004, T012 | server IT + mobile e2e |
| SC-002（昵称 1–32 保存全链 / 超限拦截）| ✅ | T009 | 复用 002 IT，不重测 server |
| SC-003（行序逐行断言）| ✅ | T014 | 含 007 回归 |
| SC-004（昵称/性别/简介 active、头像/背景图 disabled 占位）| ✅ | T014 | tap force 无导航 |
| SC-005（server 改动仅 gender + 昵称 0 server）| ✅ | T015 | diff + 依赖 grep |

## Constitution Alignment

✅ **无违反**。

- **I SDD**：spec → clarify（2026-05-30 5 问）→ plan → tasks → analyze（本）顺序合规，未跳步。
- **II TDD**：server T002（rules 单元）/ T003（usecase 单元 + Testcontainers IT，先红后绿）；mobile 逻辑（T007/T010 form hook）= vitest；屏/重排 = Playwright e2e（per mono 分层 logic=vitest·UI=Playwright）；无 lifecycle mock（复用既有 authed 守卫，无新 Guard）。
- **III Atomic**：15 task 30min-2h；server + api-client regen + mobile 同 PR。
- **IV Module Boundary**：gender = account ctx 单一核心字段，无 Moat 跨界，anemic Prisma row（String `@map`，镜像 status）+ 零-class（`normalizeGender` 纯函数，ADR-0043）。
- **V 类型同步链**：T005 openapi + api-client regen 与 server/mobile 同 PR（active —— EP1 扩字段 + EP2 新端点，非 vacuous）。

## Unmapped Tasks

无。15 task 全可溯源到 FR/SC（T001-T014）或 Verify（T015）/ Foundational 共享（T006）。

## Metrics

- Total Requirements: **20**（6 FR-S + 9 FR-C + 5 SC）
- Total Tasks: **15**
- Coverage: **100%**（全需求 ≥1 task；FR-S05 弱覆盖见 F1）
- Ambiguity Count: 0（视觉精确值留 mockup 回填，业务结构无歧义）
- Duplication Count: 0
- Critical Issues: 0（HIGH ×0 / LOW ×3）

## Next Actions

- **0 CRITICAL / 0 HIGH** → **不阻塞 `/speckit-implement`**。
- F1/F2/F3 均 LOW，可 implement 时顺手带（F1 在 T003 写 IT 时一句话声明、F2 在 T011 success-only back 时落实、F3 无需改）。
- ⚠️ **操作前置（非 spec finding）**：当前在 `main` 分支 —— `check-prerequisites.sh` 因分支名 gate 报错，且 commit 前必须切到 `008-profile-name-gender-edit` 分支（spec/plan/tasks/analysis 4 件 + design/ untracked 文件会随 checkout 干净迁移）。

## 操作建议

修复均为 tasks.md 内机械微调（F1 一句话 / F2 一行 edit）或无需改（F3），无需回 spec / plan 重做。亦可直接进 implement、在对应 task 闭环时落实 F1/F2。

## Resolution (2026-05-30)

- **F1** ✅ T003 IT 清单显式声明「限流复用既有共享 `me-patch` bucket（002/007 已覆盖 429），本端口不重测 429，仅声明 `@Throttle` 装饰器在位」。
- **F2** ✅ T011 显式写明「仅 `phase==='success'` 才 `router.back()`；PATCH 失败留屏 + `genderEditErrorToast` 不返回」。
- **F3** ✅ 无需改（依赖排序已在 `## Dependencies` 说明，US 标签与 spec 一一对应无 drift）。

→ 008 现 **implement-ready**（0 残留阻塞 finding）。
