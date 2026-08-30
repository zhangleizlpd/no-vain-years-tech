# Specification Quality Checklist: 清链与行军选档 — 凸包净链、φ+形状行军、逐档可解释

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-30
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

- 判据公式（凸包 / 垂距 / 行军延伸条件）与分层归属（特征加工层 / 精排层 / 表达层）为 ADR-0068 已裁决的领域规则与结构决策，非本 spec 引入的实现细节；`*.rules.ts` / `layeredRanker` / `relativeSpread` 等锚点为既有代码事实引用
- clarify（Session 2026-08-30，3 问 + mockup review 期第 4 问）已裁决回写：④ scope 收窄为收租视角（行军 = 收租长腿机制，建仓零改动 FR-019，报价护栏例外全域；ADR-0068 决策 5 同日勘误）；① 13 类四家族枚举定稿进 FR-015 表；② 全梯剔空归「整梯无可成交」（判决枚举维持三态）；③ θ=自身年化模式 server 配置项 only、UI 不暴露。tick 非常数 / 未知时共线阈值的取法为 plan 阶段技术决策（spec 层锁「零自由参数」）
- φ / β / γ / `OI_MIN` 标定值属 impl 期产物（同 068 惯例），SC-007 只锁「带实测锚点留档」
