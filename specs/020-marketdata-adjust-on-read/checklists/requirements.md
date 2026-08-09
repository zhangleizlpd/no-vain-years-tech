# Specification Quality Checklist: Marketdata 复权存储模型切换（只存 none + 累积因子，读时换算）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-05
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

- 设计输入已锁定三决策（累积 backward 单真相 / 回填后 DELETE 清退 / SDD 020 流程），spec 不留 [NEEDS CLARIFICATION] 标记。
- **clarify 已闭合**（Session 2026-06-05 4Q，决议回填 SC-A02/FR-A02/FR-A05/Key Entities）：① 对拍判据 = 相对误差阈值（ε plan probe 实测回填）；② factor_forward 直接 drop；③ adjustTypes/reAdjustLookbackDays 列保留语义收窄；④ 锚定延迟窗口期 forward 最终一致照常服务。
- **唯一遗留到 plan 的事项**：DELETE 清退分批大小与执行时点（运维 runbook 细节，不影响行为契约）+ SC-A02 ε 数值（plan 内 probe task）。
- 「Content Quality / 实现细节」按 mono 既有 spec 体例判定：019 同款保留 marketdata 领域机制语义（口径/因子/锚定），不下沉到文件/类名层（HOW 在设计 doc 与 plan）。
