---
adr_id: ADR-NNNN
status: Proposed
applies_to: [<scope>]
sunset_trigger: |
  - <触发条件 1: 何时本 ADR 应被 Deprecated / Superseded>
  - <触发条件 2>
---

# ADR-NNNN: <短句决策标题>

* Status: Proposed | Accepted | Deprecated | Superseded | Reserved (YYYY-MM-DD)
* Deciders: <github handle>
* Tags: <类目1> / <类目2> / <类目3>
* Supersedes: <ADR-MMMM link>(可选)

<!--
ADR Governance (per adr-governance preset / mono ADR-0031):

frontmatter 4 字段强制 (lefthook adr-frontmatter-check 会拒非法 commit):
  - adr_id:        与文件名 NNNN 一致 (e.g. ADR-0042 ↔ docs/adr/0042-*.md)
  - status:        Proposed | Accepted | Deprecated | Superseded | Reserved
  - applies_to:    list,值域 {apps/<name>, packages/<name>, infrastructure,
                   security, mono-wide}
  - sunset_trigger: multiline string (≥ 10 chars),列触发本 ADR 重审条件

frontmatter 之外的 list-style 元数据 (Deciders / Tags / Supersedes) 是
human-readable 二次表达,可选。schema 不强制。
-->

## Context

<!--
描述驱动本决策的 force:现状 / 痛点 / 约束 / 触发事件。
引用其他 ADR / spec / memory 用 markdown link。
-->

## Decision

<!--
具体决策内容。
对方案选型 — 给比较表;对配置 — 给完整字面值;对流程 — 给步骤列表。
sub-sections 可按需:
  ### 1. <decision aspect 1>
  ### 2. <decision aspect 2>
-->

## Consequences

<!--
本决策一旦 ship 的影响:
  - 哪些 PR 触发 (e.g. "PR-N 实装")
  - 哪些 existing 行为变化
  - 哪些下游 ADR / spec 联动 amend
-->

## Trade-offs

<!--
显式列出不选其他方案的代价 + 本方案的已知短板。
形式:"成本/短板 — 接受理由"
-->

## Open Questions

<!--
当前未决但不阻塞 status: Accepted 的问题。后续 amend 时回填。
-->

## References

<!--
- 关联 PR / Issue
- 关联 ADR (markdown link 形式)
- 关联 memory 观察 ID (per claude-mem)
- 关联 spec / plan
- 外部文档 URL
-->
