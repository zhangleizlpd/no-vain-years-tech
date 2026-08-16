# Specification Quality Checklist: 研报归档 —— 同标的多版本与元数据回声

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-16
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

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### 本轮写作中做出的两个判断（未打 [NEEDS CLARIFICATION]，已落 Assumptions，若不认可需在 clarify 阶段推翻）

1. ~~**研报日期相同时的最新判定** —— 取后投递的那一份（版本号更大者）~~ —— **2026-08-16 第二轮澄清整条作废**：服务端不再判定「最新」，规则退化为「版本号最大者即最新」，`latest` / `currentLatestReportDate` 两个回显字段与判定查询一并删除（FR-005 / FR-007 / SC-002 随之删除）。理由：版本号在建行时取 `MAX+1`，新投递恒为该线最大 ⇒ 回显「你是最新」是一句恒真的废话；而按研报日期排序建立在**投递方单方声明、零校验**的值上，本身不成立。
2. ~~回显标的名称排除在本片之外~~ —— **2026-08-16 已由用户决定纳入**。落定为 FR-012～FR-018 + FR-028/FR-029 边界 + SC-008（含盲区声明）。跨上下文读取的三档取舍已选定：实时只读直查（Q7-B），依据是同形态先例（预警上下文读同一份行情标的目录，per ADR-0052）+ 无摊销对象（判据同 ADR-0048 复审记录）。
3. **名称回显存在已知盲区且必须显式告知** —— 两地上市的同一家公司在目录中名称相同，回显对「选错市场」这一类错**不可区分**。SC-008 已把该盲区写进验收条款本身，避免回显被当成「投对了」的证据。

### 术语说明

「幂等」「内容指纹」「版本线」三词在本 spec 中作为业务概念使用（均承自 057 spec 已确立的词汇），不视为实现细节泄漏。
