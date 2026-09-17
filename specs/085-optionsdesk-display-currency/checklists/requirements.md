# Specification Quality Checklist: 交易账户展示币种切换

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-16
**Updated**: 2026-09-17
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

16 项全部通过。

结构与最近两个 feature（083 / 084）对齐：含 `### Key Entities`（业务概念散文，非数据库 schema）
与 `### Measurable Outcomes`（SC 条目挂在此 H3 下），Clarifications 走 `### Session YYYY-MM-DD`。

### 两条需要下游知道的判据

1. **FR-004 是防御性约束，不是实发风险**。持仓列表恒按单一市场页签呈现，服务端查询本身
   也按单市场过滤（`list-broker-positions.usecase.ts:250`）⇒ 同屏各行必然同币种，折算是
   等比例缩放，「按原币种排序、按折算币种显示」的错位在本 feature 范围内**结构上不可能发生**。
   保留该条是为了将来出现跨市场汇总视图时有正确判据 —— 下游不必为它设计专门的回归测试场景。
2. **「不设原币种档」依赖同一个前提**。单市场下「选 HKD」与「选原币种」显示结果逐字相同，
   故三档即可。若将来引入跨市场视图，这条要重新评估。

### 校验结论

spec 已就绪。mockup 五帧见 `design/`（local-only），其渲染验证与版本闸结论以
`design/handoff.md` 为准。下一步 `/speckit-plan`。

### 2026-09-17 复核（spec 修订后重跑）

spec 新增 `Session 2026-09-17`，把展示币种改为**按市场页签各自独立**（原「已切过则切页签不改」
作废），连带改了 FR-005 / FR-011 / SC-005 / US2-AS5 / AS6 / Key Entities。

对着修订后的正文重跑上述 16 项，**结论不变**：该修订只换了同一状态的作用域粒度
（单格 → 每页签一格），未新增含糊表述、未引入不可测的验收点；FR-005 与 SC-005 仍各自可机器化
（落点见 `plan.md` D7 的三臂 e2e）。

上文「两条需要下游知道的判据」不受影响 —— 两条都只依赖「单屏恒单一市场」这个前提，
与页签之间是否联动无关。

位置更新：plan 已完成，当前下一步是 `/speckit-tasks`（上文「下一步 `/speckit-plan`」是 clarify
当时的位置记录，保留不改）。
