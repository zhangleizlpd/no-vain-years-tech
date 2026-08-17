# Specification Quality Checklist: 锚首建冷启动补数

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-17
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

两轮验证，第一轮抓到两项并已修复：

1. **实现细节泄漏** —— Edge Cases 里原写「投递机制为至少一次语义」，那是机制词。改为「同一次建锚触发出两次补数」，只描述可观察现象。
2. **范围边界缺失** —— 标的隐含波动率被剔出冷启动（批准后核实：它可事后回填、非永久缺口）这件事在 spec 内**一字未提**，读者与后续 `/speckit-tasks` 无从知道那是**故意**不做的。已补 `## Out of Scope` 段显式排除四项。

保留的两处「看起来技术、实为业务」的表述，判定为不违反：

- SC-006 引用「既有的期权快照完整性核对」—— 那是系统既有的一项能力（不是某个技术栈），验收要靠它，不写就无法验证。
- Key Entities 里点明「供应方只提供当下的一份期权快照」—— 这不是实现选择而是**外部世界的事实约束**，是整片形状的来源，属于 Assumptions 层，必须留在 spec 内。

**Clarify 轮（2026-08-17）后的更新** —— 4 问全部整合，其中一条**反转了 specify 阶段的默认**：

- 留痕形态原默认「纯日志、不新增状态字段」，clarify 定为**新建一张轻量的冷启动运行记录表**。理由：跳过类结局没有数据行可当痕，而日志会滚掉且随进程一起消失；044 的日历心跳表正是为同一形态的静默降级而建。Assumptions 里那条已**替换**（不是追加），无残留矛盾表述。
- 另三条为增量：批量建锚合流、失败有限次退避重试（配额耗尽不消耗重试次数）、日线复用常规回看窗。
- 连带新增 FR-012a / FR-019a-c / FR-026-028、SC-009 / SC-010、3 条 `state_branches`。

**同日追加两轮约束（user 补充）后的再更新**：

- **合流机制整体移除**（FR-019c 反转为「MUST NOT 实现合流」，原 SC-009 删除、后两条 SC 上移）。判据：当前建锚入口是 by-ticker 单只接口，批量路径不存在；且「起手复判 + 非敏感档跑全量工作集」已顺带给出等价效果。将来真有批量，收敛做在消息形态上。
- **幂等维度前瞻**：新增 FR-015a / FR-016a / FR-026a —— 行情幂等键取「标的 + 交易日」、复判判据取标的而非锚、运行记录身份取锚而非标的。三条今天与「按锚判」等价、零成本，锚一旦按用户区分就不再等价。配套换掉一条**不可测**的 `state_branches`（`ticker @unique` 使「两只锚同标的」今天插不进库），改为两条今天就能测且证伪力等价的。
- 最终计数：FR 35 条 / SC 10 条 / `state_branches` 24 条。
