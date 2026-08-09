# Specification Quality Checklist: Marketdata 重要度分级同步（T0/T2 二级）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — 例外说明见 Notes
- [x] Focused on user value and business needs（保用户可见集最鲜 = 自选行情新鲜度的直接体验）
- [x] Written for non-technical stakeholders（行为契约 + Given/When/Then；架构术语均锚到 ADR-0048 复审记录已定稿决策）
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain（0 个散标——3 个 open question 按 mono 先例集中列 `## Clarifications` 待跑区，待 `/speckit-clarify` 闭合，见 Notes）
- [x] Requirements are testable and unambiguous（FR-S01~S10 均有对应 IT 断言面）
- [x] Success criteria are measurable（SC-S01~S06：重算/消费序/截断保底/治理/回归/端到端六门）
- [x] Success criteria are technology-agnostic — 例外说明见 Notes
- [x] All acceptance scenarios are defined（3 user story × 3-5 scenario）
- [x] Edge cases are identified（8 条，含并集空/多引用/退市黑名单/读失败降级/并发漂移）
- [x] Scope is clearly bounded（Out-of-Scope 6 项，各自锚 seam / ADR-0048 trigger）
- [x] Dependencies and assumptions identified（前置依赖 013/016/017；Assumptions 5 条）

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows（重算 → tier 序消费 → 治理回归，US1+US2 即 MVP）
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — 例外说明见 Notes

## Notes

- **「无实现细节」的刻意例外**（016/017 先例）：本 feature 的输入是已定稿的 [ADR-0048 复审记录](../../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md) + [规划文档](../../../docs/private/plans/2026-06/06-04-marketdata-tiering-feature-planning.md)——Q7-B 直查机制、`syncTier` 列、`CROSS-CONTEXT-READ` 注释探针**就是被验收的决策本身**，且拒绝项（Q7-A 投影/计数器/第二 producer 升级论）需留痕防回潮，故 spec 显式引用这些锚点而非抽象化；查询写法 / 排序 SQL / 重算类名归 plan。
- **3 个 open question 不散标、集中待跑区**（per mono SDD 先例——specify 不 littering `[NEEDS CLARIFICATION]`，merge-sensitive 点列 `## Clarifications` 待跑区）：① 重算触发时点形态；② 新加自选生效时点；③ T0 失败重试优先 V1 与否。三者均不影响 FR 的可测试性表述（FR-S01/S03/S04 的行为契约在三种触发形态下语义一致），但影响 plan 的结构决策 → clarify 是 plan 前硬卡点。
