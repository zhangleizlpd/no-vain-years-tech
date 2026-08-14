# Specification Quality Checklist: 检索条件抽屉版式重构

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-14
**Updated**: 2026-08-14（`/speckit-clarify` 一轮 6 问 6 答后复跑）
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — **两处已在 clarify 关闭**（`FR-013` / `FR-032`）
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

### clarify 一轮 6 问 6 答（2026-08-14）

| #   | 问题                                         | 定案                                                                       |
| --- | -------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | OI / Vol 的 AND 要不要真做                   | 不做，规则位只做只读的「满足任一」说明（`FR-032`）                         |
| 2   | 单值行「右边界齐」vs「单位贴数字」           | 一律齐右边界，`%` 距 93px 知情接受（`FR-013`）                             |
| 3   | **三视角行集怎么定**（owner clarify 期新提） | 一律 5 行 + 建仓行权价带硬门槛口径提示（`FR-012` / `FR-016`）              |
| 4   | sheet 占屏比的验收门槛                       | 相对判据（不劣于改版前）+ 硬上限 + 结构判据，🚫 不用绝对百分比（`FR-015`） |
| 5   | OI / Vol 分组标签叫什么                      | 「活跃度」，沿用 `countLabels.livenessMin`，零新词（`FR-034`）             |
| 6   | 区间行要不要拆 `≥` / `≤`                     | 不拆（`FR-035`）                                                           |

### 第 3 问带来的 scope 变化（clarify 期新增，brief 里没有）

行集统一**推翻 `052` 两条带 FR 编号的裁定**（`FR-007` 建仓无行权价行 / `FR-010` 全腿无价差行），并使 `FR-040` 的「`leg-criteria.rules.ts` 零行 diff」松绑一处（`ROWS_BY_TAB`）。三项支撑逐条实证：

1. 被藏两行的默认值**都是 `null`**，且这是**结构保证**（`criteriaRowsFor` 的「有值必可见」分支使 `ROWS_BY_TAB` 只可能藏住不生效的维度）
2. `applyOverride` 遍历全部六维、**无 per-视角白名单** ⇒ 服务端零改动
3. 全腿逃生口（`051` 那个入口）默认不受影响，用户手动设了也由 `052` 边际计数报出 ⇒ 非静默

⇒ 落成 `FR-016`–`FR-019` + `SC-013`–`SC-015`，其中 **`SC-013` 要求「已证明它会红」**——这是本片最危险的一条（新露出的行若意外带非空默认值，候选集会静默变少且不会红）。

### 起草期 + clarify 期核出的实证订正（相对 owner 的输入 brief）

1. **行形态枚举不完整** —— brief 漏了全腿 4 行 7 框。已由第 3 问的行集统一整体消解。
2. **A′ ③ 在全腿视角无定义** —— 全腿无价差行 ⇒ 权利金没有配对者。同上消解。
3. **`~/ui` 键盘有两个 consumer** —— `alert/value-input-sheet.tsx` 是原产地；扩展必须是加法（`FR-023` / `SC-006`）。
4. **术语两处不一致** —— ① 「活性」是 `livenessMin` 的第三个叫法（已定「活跃度」）② owner 口语的「接货」与实装标签 `COPY.tabs.build` = 「建仓视角」不一致（spec 全文统一到实装用词，见 `FR-034`）。

### 转 plan 前的一条未决（不阻断，但 plan MUST 裁定）

**mockup 与实装形态已不再逐帧对应** —— clarify 改了行集（三视角统一 5 行 + 建仓多一个 ⓘ），而 `053` 的 A′ 四帧画的是改版前的行集。plan 阶段 MUST 在「补渲一帧」与「写进 handoff 当已知偏离」之间裁定，🚫 MUST NOT 默认「沿用四帧即可」。已登记在 § Assumptions。

### 覆盖自查（逐条 grep，非通读）

- FR: 001–005 / 010–019 / 020–024 / 030–035 / 040–045 / 050 —— 各段内编号连续，无跳号
- SC: 001–017 —— 连续
- `state_branches`: 14 条
- User Story: 5 条（US5 为 clarify 期新增，承接行集统一）
- Edge Cases: 8 条，均带 `(covers FR-xxx)` 回指
- `[NEEDS CLARIFICATION]`: **0**
