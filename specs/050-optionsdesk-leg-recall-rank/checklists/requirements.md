# Specification Quality Checklist: 选约引擎 server 三层重构 —— 召回 / 打标 / 精排

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-11
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

- [ ] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

> 本文件是 **specify 阶段**的质量自查，不是 `/speckit-analyze` 的覆盖矩阵。条数一律实时 grep，不抄本文。

### 唯一未过项：5 条 FR 无 Acceptance Scenario 承接（**判为可接受，理由如下**）

| FR                                        | 缺 AS 的性质                                        | 验证手段（不是靠 AS）                                                                                               |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| FR-024 处理顺序恒为「排名 → 筛选 → 截断」 | 本片**不实装**筛选与截断（归 P3），无可观测的行为差 | 骨架顺序的判据落 plan / tasks 的结构断言；Edge Cases 段已单列该陷阱（「先筛再排名」照样能跑、数字照样有，只是全错） |
| FR-026 MUST NOT 引入加权评分              | **负向约束**，没有能产出 AS 的正向行为              | 代码层「排序器只读特征集」（FR-020 / US4-AS5）已从结构上堵死；实现期靠 CR + 单主键断言                              |
| FR-028 成员集合变化 MUST 在 PR body flag  | **流程要求**，不是系统行为                          | PR body 本身即证据；`pr-creation-protocol.md` 的 CI regex 只扫部署 gate，这条要人工把关                             |
| FR-029 045 锚派生与意图矩阵零改动         | **负向约束**                                        | `git diff` 对 `anchor.rules.ts` / `intent-matrix.rules.ts` 零命中                                                   |
| FR-019b 特征集 MUST NOT 下发              | **负向约束**（clarify 新增）                        | OpenAPI 契约面零特征字段（`grep` 生成的 schema 零命中）                                                             |

### 三处刻意留白（**不是缺口，别在下一轮 analyze 当缺陷补 task**）

1. **两道门槛的阈值不在 spec 里钉死**（FR-007）—— 主 plan 未决 #2 明写「阈值实测定」。spec 只要求「MUST 有该门槛 + 阈值 MUST 单点可配」，两条都可测（SC-009）。数值在 impl 期用真实链数据标定。
2. **相对价差与权利金门槛的口径写在 Assumptions 而非 FR** —— 它们是**可被推翻的默认**（业内通行口径），不是需求本身。若 clarify 阶段推翻，改 Assumptions 不改 FR。
3. **US4 的排序主键只写「折算费率降序」不写 basis** —— 周化率与年化率差一个常数因子，降序结果逐行相同（FR-021 的 📌）。写 basis 会让人误以为换 basis 就换了顺序。

### Clarify 轮（2026-08-11，5 问用满配额）已改变的判定

| 原判定                                             | clarify 后                                                                                   | 影响面                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 「特征集字段齐全」是未量化形容词（本表原列为可测） | 收敛成 **13 项具名清单** + 三条归一化边界（FR-019 / 019a）                                   | 上文「刻意留白」第 2 条**不再适用于特征集**，只对两道门槛阈值仍成立 |
| 排序在哪一端未定                                   | 收回 server，下发三份有序合约代码列表（FR-021a）                                             | **推翻 047 D-API-1 / D-SOT-4**；契约多三个顶层数组                  |
| FR-008 只说「下发滤除腿数」                        | 按门槛分**两个数**（FR-008 / SC-003）                                                        | 契约形状定死，P3 拆请求时不用改                                     |
| 月度到期日判据「依赖已有交易日历」（笼统）         | 明确为跨 ctx 直查 `marketdata.trading_day`，判「第三个周五，非交易日取前一交易日」（FR-015） | 新增一处跨上下文只读，需 `CROSS-CONTEXT-READ` 注释（机器强制）      |

### 术语口径

本 spec 大量使用领域词（`bid` / `ask` / `spot` / `K` / DTE / Δ / 有效成本 / 折算费率）。它们是**业务概念不是实现细节** —— 该系统的唯一用户是 owner 本人，去掉这些词反而让需求不可判定。此为本仓既有体例（对照 045 / 047 / 049）。
