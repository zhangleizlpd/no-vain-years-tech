# Specification Analysis Report — 007-account-security-refactor

**Date**: 2026-05-30 | **Artifacts**: spec.md / plan.md / tasks.md / constitution.md
**Scope**: cross-artifact consistency (read-only) before `/speckit-implement`

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| **F1** | Inconsistency (ID drift) | **HIGH** | tasks.md Phase 3/4 标题 + T008/T009/T010 + Phase 1 标题 + Phase 4 Independent Test | tasks 的 **US2/US3 标签与 spec 互换**：spec US2=「个人简介编辑」、US3=「身份/绑定卡」；tasks Phase 3 标 `US2 身份卡脱敏`、Phase 4 标 `US3 个人简介编辑`（T008 `[US2]`=身份卡、T009/T010 `[US3]`=bio）。Phase 1 标题「阻塞 US3 mobile」应为 US2；Phase 4 Independent Test「spec US2/server + US3/mobile」措辞混淆 | 把 tasks 身份卡 phase/任务改标 **US3**、bio phase/任务改标 **US2**；Phase 1 标题改「阻塞 US2 mobile」；Phase 4 Independent Test 文案理顺。保 task ID/顺序不变，仅纠 US 标签 |
| **F2** | Inconsistency (count) | LOW | plan.md 末 ID-namespace「SC-001..005」 | spec 有 **SC-001..SC-006**（6 条，SC-006=server 改动限于 bio），plan footer 写 ..005 漏 1 | plan footer 改 `SC-001..006` |
| **F3** | Coverage gap | LOW | spec FR-C13 / SC-006（MUST NOT 引入对象存储/图片上传依赖）| 无显式校验 task —— T013 grep 仅查「实名认证/第三方/二维码」残留，未断言「0 图片上传依赖」 | T013 加一条：grep 确认未引入 `expo-image-picker`/对象存储/上传依赖（或显式声明由 build/typecheck 兜底）|

## Coverage Summary（高信号摘要，全 25 需求均 ≥1 task）

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-S01..S06（bio 字段/端点/校验/auth/限流/GET me）| ✅ | T001-T003 | server，IT 红绿 |
| FR-C01..C03（三卡片/资料卡/删二维码）| ✅ | T005, T006 | |
| FR-C04..C05（简介编辑页/＞120 拦截）| ✅ | T009, T010 | **spec US2** —— tasks 误标 US3（见 F1）|
| FR-C06..C07（身份卡脱敏/微信google 占位）| ✅ | T005, T008 | **spec US3** —— tasks 误标 US2（见 F1）|
| FR-C08..C09（安全卡不回归/删实名第三方）| ✅ | T005, T012, T006 | |
| FR-C10..C12（路由标题不变/disabled 不导航/类1 banner）| ✅ | T005, T007, T008, T011 | |
| FR-C13（无图片上传依赖）| ⚠️ 弱 | T013（grep 未含）| 见 F3 |
| SC-001..005 | ✅ | T006/T002-3/T008/T011/T007/T012 | |
| SC-006（server 改动限 bio）| ⚠️ 弱 | T013（部分）| 见 F3 |

## Constitution Alignment

✅ **无违反**。
- I SDD：spec→clarify(2 轮)→plan→tasks→analyze(本) 顺序合规，未跳步。
- II TDD：server T002/T003 显式「先红后绿 IT」；mobile UI 走 Playwright e2e（per mono 分层 logic=vitest·UI=Playwright），无 lifecycle mock（复用既有 authed 守卫无新 Guard）。
- III Atomic：13 task 30min-2h；server+regen+mobile 同 PR。
- IV Module Boundary：bio = account ctx 单一，无 Moat 跨界，anemic row + 零-class（ADR-0043）。
- V 类型同步链：T004 openapi+api-client regen 与 server/mobile 同 PR（active，非 vacuous）。

## Unmapped Tasks

无。13 task 全可溯源到 FR/SC 或 Verify/Foundational。

## Metrics

- Total Requirements: **25**（19 FR + 6 SC）
- Total Tasks: **13**
- Coverage: **100%**（全需求 ≥1 task；FR-C13 / SC-006 弱覆盖）
- Ambiguity Count: 0
- Duplication Count: 0
- Critical Issues: 0（HIGH ×1 / LOW ×2）

## Next Actions

- **无 CRITICAL** → 不阻塞 implement，但 **F1（HIGH，US 标签互换）建议 implement 前先纠**（否则 `[X]` flip / tasks-md-drift / implement 溯源会按错 US 对账）。
- F2/F3（LOW）可顺手修，亦可 implement 时带。
- 修复均为 tasks.md / plan.md footer 机械编辑，无需回 spec / plan 重做。

## Resolution (2026-05-30)

全部 3 findings 已修（同 `/speckit-analyze` 后批）：

- **F1** ✅ tasks.md 身份卡 phase/任务改标 **US3**（Phase 3 / T008）、个人简介 phase/任务改标 **US2**（Phase 4 / T009 / T010）；Phase 1 标题改「阻塞 US2 mobile」；Dependencies / MVP 的 US 引用同步；与 spec US 编号对齐。
- **F2** ✅ plan.md footer 改 `SC-001..006`。
- **F3** ✅ T013 加「未引入 `expo-image-picker` / 对象存储 / 图片上传依赖」grep 断言（FR-C13/SC-006）。

→ 007 现 **implement-ready**（0 残留 finding）。
