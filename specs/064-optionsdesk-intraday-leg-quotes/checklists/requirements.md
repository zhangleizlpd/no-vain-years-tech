# Specification Quality Checklist: 美股期权腿盘中实时报价

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 2026-08-19 clarify 会话 4 问全答，marker 已清零
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

## 本仓附加门（非模板项）

- [x] frontmatter 8 必填字段齐 + `state_branches` ≥ 1 —— `npx tsx scripts/check-spec-frontmatters.ts` 绿（63 file(s) ✓）
- [x] 正文无裸下划线标识符（prettier 会把 `_…_` 当强调语法静默改坏字段名）—— 正则扫描零命中
- [x] 与需求源 plan 的偏离已逐条记录并经 user 拍板（见下 Notes）

## Notes

**三处与 p2 plan 原文的偏离，均已代码实证 + user 确认：**

1. **覆盖字段收窄**（plan §3.1 列 14 项 → spec FR-002 收到 7 项 + 链级 2 项）。实证：`leg-retrieval.port.ts` 的 `LegChainRow` 只承载买卖价、买卖挂单量、Δ、隐含波动率、成交量；其它希腊值 / 最新价 / 昨收价 / 净持仓量在 optionsdesk 内零引用；成交额是 `get-legs.usecase.ts` 由成交量与买价算出的派生量，随之自动实时（FR-003）。
2. **游客面 opt-out 改为「预埋开关、默认关」**（plan §3.5 → spec FR-015/FR-016）。实证：guest-proxy 的 9 条 `proxy_pass` 中 6 条直通外部行情源、3 条是写入口，**无一条读本系统的链**；`optionsdesk.controller.ts` 类级挂鉴权守卫且无公开豁免 ⇒ plan 假设的「游客读库内快照」路径不存在。2026-08-19 user 拍板取 fail-closed 预埋版。
3. **单批上限超限降级为 P3 user story**（plan §6 硬点 2）。理由：现有 13 只美股锚候选范围最大 285，全在单次上限内 ⇒ 今天零触发，是前瞻性正确性约束而非交付项。

**一条 pre-existing 状况，已在 Assumptions 记录、本片不处理**：访客直连外部行情源已在消耗同一配额桶 —— plan §3.5 担心的「配额暴露在公网请求量下」在本 feature 之前就成立，缓解它是另一件事。
