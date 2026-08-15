# Specification Quality Checklist: 研报库 guest 投递入口

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-15
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

**验证轮次**：1 轮通过（0 个 [NEEDS CLARIFICATION]）。

**刻意做的词汇替换**（保持 spec 层为 WHAT）：

| 实现词               | spec 里的说法        |
| -------------------- | -------------------- |
| OSS / 阿里云 bucket  | 归档存储             |
| nginx / guest-proxy  | 投递通道             |
| sha256               | 内容指纹             |
| PENDING / COMMITTED  | 未完成 / 已完成记录  |
| Bearer token / guard | 凭证 / 身份校验      |
| HTTP 状态码          | 「可区分的拒绝理由」 |

**保留的领域词**（属业务词汇非实现细节）：`market:code`（[business-naming.md](../../../docs/conventions/business-naming.md) 的标的逻辑键）、PDF（投递物的业务事实）、40G（真实容量约束）。

**三处未由本清单覆盖、但已在 spec 内显式记录的判断**：

1. 单份上限 16MB 与单投递方配额 8GB 均为**未经用户确认的可配置默认值**，已列入 Assumptions。配额值若要改，改配置不改结构。
2. `state_branches` **21 条**（本清单初版写 17 条，`/speckit-clarify` 三问后增至 21 —— 数字以 spec frontmatter 实时 grep 为准，本行仅作留痕）。其中「对象存储可达性不确定」一条来自既有实证（存储服务欠费返 403 曾让系统对上传成功的用户说谎，见 `apps/server/src/account/object-exists.probe.ts` 的三分法注释）—— 这条不是推演出来的分支。
3. FR-013（通道层独立只放行投递动作）刻意与 FR-012（服务端不提供读取）**重复覆盖同一件事**。这是有意的纵深：服务端「没实现」是一种会被未来某个 PR 悄悄打破的状态，通道层「显式拒绝」不会。
