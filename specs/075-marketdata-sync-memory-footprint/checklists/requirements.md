# Specification Quality Checklist: 采集轮次内存足迹治本

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-05
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

- **clarify 已跑（2026-09-05，4 问）**，结论落在 spec 的 `## Clarifications`。其中两个答案推翻了 specify 阶段的默认：
  1. 港股 **不加错开**（取 0，只落逐市场可配的能力）—— 原默认是「两市对称适用」。改判理由：港股那一侧从未被采样覆盖，给它拍一个数等于把「没观测到」伪装成「量过了」。
  2. **整片现在就合**，美股用有出处的兜底值 30 分钟 —— 原默认是等 09-08 曲线。连带代价已写进 Assumptions：「改动前基线」不可得，内存类验收判据因此改为**绝对水位**（SC-007 / SC-008），且批 2 拿那轮曲线反推内存上限时会系统性偏小。
- **规范性动词已收敛（2026-09-05）**：MUST 从 52 处降到 20 处（≈0.11/行，仓内常态 0.18–0.19）。判据 = 「违反了会不会静默出错」：Edge Cases / `state_branches` / Acceptance Scenario / Assumptions 一律陈述句；MUST 只留在 FR 主干与四条真红线（FR-005 全域退化 / FR-015 别改触发时刻 / FR-016 失败传播 / FR-018+FR-020 上界与归属）。低于常态的差额来自 FR-006…FR-012 那组 —— 它们是「判据语义一条不改」的逐条落点，规范性由 FR-013 一条承载，本身写成陈述句。
- SC-003 里的 74.8 MB 来自复盘实测，不是估算；SC-008 的 200 MB 是**保守边界不是标定值**（取事故当晚崩溃点 80 MB 的 2.5 倍）。口径与射程见 spec Assumptions。
