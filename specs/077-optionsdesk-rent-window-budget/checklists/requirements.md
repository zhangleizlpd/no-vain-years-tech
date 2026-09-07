# Specification Quality Checklist: 收租候选窗由「码数预算」决定

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

本片的取证密度高于常见 spec，是刻意的：三个缺陷全部由 2026-09-07 的 prod 实测确立，且其中一个
（「候选恒空」）经实测发现**大部分不是缺陷**。取证段保留了基面口径与射程边界，避免后续把
单次拍照的数字当全称结论用。

✅ **2026-09-07 clarify 已完成（3 问 3 答）**，初稿标记的两处待裁决均已解决，且另发现一处更前置的问题：

1. ~~「离锚定轴距离」的度量方式（绝对差 / 相对比）~~ → **该问题不成立**：同一标的内锚定轴是常量，两种度量相差一个正常数因子，排序完全等价。初稿把它当成需要裁决的选择是错的，已在 Assumptions 修正。
2. ~~并列距离撞在裁剪边界上的处置~~ → 由 Q3 裁决（以行权价档为原子单位）**从构造上消除**，不需要另编次级排序键。
3. **新发现并裁决**：语义过滤与 Δ 带的关系（叠加 vs 取代）—— 这是三问里影响最大的一条，直接把本片射程从「两条候选面路径」收窄为「只改零 Δ 面」，并修正了初稿一处把正确行为写成缺陷的过度断言。

📌 clarify 期另有两组实测补入 spec：① 语义过滤 ① 的结果集**比现行窗口更小**（131 只锚无一超预算 399）⇒ 超上限缺陷光靠 ① 即消除；② 全部 7 只「正常日空集」锚在不设窗时合格腿仍为 0 ⇒ 该支无缺陷可修。
