# Specification Quality Checklist: 交易日历数据源韧性改造

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-16
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

> 注：spec「背景」段保留了具体 vendor host / HTTP 状态码 / robots.txt —— 这些是**事故取证事实**（WHY 的证据链），非实现选型。候选源的具体 endpoint / 适配方式一律未写入，留 plan 阶段。

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — **2 项已于 2026-07-16 收敛**（见 spec `## Clarifications`）
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified（成功但空 / 成功但不合理 / 全链失败 / per-market 独立 / 长假误报 / app 挂掉 / 看守循环信任）
- [x] Scope is clearly bounded（Out of Scope 明列回补、首夜回填、表结构、gate、付费源）
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## state_branches 覆盖（ADR-0040 门禁）

- [x] ≥1 条（实际 17 条），穷举真值表分支：主源成功/异常/空/不合理、全链失败、per-market 独立、降级同构、幂等、L2 静态命中、**静态源超覆盖区间须判失败**（防静态层自身成为第二个毒饵）、us 仅 L1 不阻塞、告警触发/不触发、app 挂掉、看守三分支（不健康告警 / 健康+非交易日放行 / 健康+交易日告警）

## Notes

- **2026-07-16 澄清收敛**（user 拍板，见 spec `## Clarifications`）：
  1. **fallback = 2 层**：L1 活源 + L2 静态离线（离线生成入仓、年更）；**否决**运行时官方文档解析层（官方无 API/CSV/ICS + 与 L2 同源 + 版式脆弱）。
  2. **健康信号 = 填充成功心跳（liveness）**；**否决** `max(date)` 陈旧（长假须放宽到 >10 天 → 与 SC-003「24h 内告警」直接冲突 + 需人工维护长假白名单）。
  3. **us 无需 L2 覆盖**（附带 scope 缩减）——prod 实证无 `{us}`-only 维度、gate 取 OR ⇒ us 日历不阻塞任何同步。
- 澄清过程中新识别一条风险并已入 state_branches：**静态层自身可能成为第二个静默毒饵**（年更未跟上 → 问次年日期 → 返空 → 被当成「无交易日」）→ 明确要求超覆盖区间必须判失败。
