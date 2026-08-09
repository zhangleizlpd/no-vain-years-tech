# Specification Quality Checklist: Marketdata 调度体系重构（PG 调度真相层 + BullMQ 执行层）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — 例外说明见 Notes
- [x] Focused on user value and business needs（调度可靠性 = prod 敢开同步的前置）
- [x] Written for non-technical stakeholders（行为契约 + Given/When/Then；架构术语均锚到 ADR-0049 已定稿决策）
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain（0 个——架构/语义/风险决策已全部在 ADR-0049 + 设计文档 §H 定稿，spec 仅转译为可验收行为）
- [x] Requirements are testable and unambiguous（FR-S01~S19 均有对应 IT 断言面）
- [x] Success criteria are measurable（SC-S01~S09：IT 覆盖清单 + prod 灰度 1-2 周观察指标 + grep 零残留）
- [x] Success criteria are technology-agnostic — 例外说明见 Notes
- [x] All acceptance scenarios are defined（7 user story × 3-6 scenario）
- [x] Edge cases are identified（12 条，含 H6 风险表全部 4 项）
- [x] Scope is clearly bounded（Out-of-Scope 6 项，各自锚 ADR-0049 sunset trigger / seam）
- [x] Dependencies and assumptions identified（前置依赖 016；Assumptions 8 条）

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows（基础设施 → 真相层 → 执行单元 → tick → 编排 → CLI → 灰度/清退，与 §H4 7 片对齐）
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — 例外说明见 Notes

## Notes

- **「无实现细节」的刻意例外**：本 feature 的输入是已 Accepted 的 [ADR-0049](../../../docs/adr/0049-marketdata-scheduler-bullmq-hybrid.md)——架构选型（PG 真相层 / 裸 bullmq / 条件 UPDATE / FlowProducer）**就是被验收的决策本身**，且拒绝项需留痕防回潮，故 spec 按 016 先例显式引用这些锚点而非抽象化；类名 / 文件切分 / SQL 细节仍归 plan。与 spec-template「technology-agnostic」的张力已在 spec 顶部 ARCHITECTURE PARADIGM banner 声明。
- 0 个 [NEEDS CLARIFICATION]：所有歧义维度（misfire 语义 / 依赖边模式 / 锁去留 / 任务粒度 / tick 频率 / Redis policy）在设计文档 §H2 12 决策中已闭合。
- **clarify 2026-06-04 补扫出 3 个 ADR/设计文档未覆盖的行为缺口并闭合**（见 spec `## Clarifications`）：① nextFireAt NULL/重物化生命周期；② CLI worker 拓扑（永不自起 + --timeout）；③ tick won 后入队前崩溃窗口（显式接受）。
