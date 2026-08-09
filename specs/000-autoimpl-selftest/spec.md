---
feature_id: 000-autoimpl-selftest
modules: [selftest]
owners: ['@zhangleizlpd']
status: archived
created_at: '2026-06-13'
updated_at: '2026-06-13'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: na
agent_friction_observed: false
state_branches:
  - 'self-test fixture：无真实状态机，仅供 /sdd-auto-impl --dry-run 驱动器编排验证（done-loop / 干净上下文 handoff / stop-signal 协议）'
---

# Spec: 000-autoimpl-selftest（🧪 THROWAWAY 自测 fixture）

> 🧪 **这不是真 feature。** 仅供 `/sdd-auto-impl --dry-run` 验证「主 agent 驱动子 agent」编排控制流。所有 task 只写 `sandbox/`（gitignored 丢弃），零碰真实 app 代码。`status: archived` 让 lifecycle 工具忽略。

## User Scenarios & Testing

- 作为驱动器自测，跑完后应证明：① 子 agent done 的结构化结果能被主 agent 解析并推进；② 后续 task 的子 agent 在**干净上下文**里靠读前序产出文件（而非对话记忆）正确衔接；③ 遇 spec 歧义的子 agent **停下上报 blocked** 而非瞎猜。

## Functional Requirements

- **FR-001**：提供 `echo(s)` 纯函数，原样返回入参字符串。
- **FR-002**：提供 `greet(name)` 纯函数，基于 FR-001 的 `echo` 拼出问候语 `hi <echo(name)>`。
- **FR-003**：提供金额格式化函数 `formatAmount(n)`。
  - ⚠️ **本 FR 故意 under-specified**：未规定小数精度（2 位？4 位？跟随输入？）与负数 / null 处理——用来触发子 agent 的 spec-歧义 stop signal。

## Success Criteria

- **SC-001**：`echo('nvy') === 'nvy'`。
- **SC-002**：`greet('x') === 'hi x'`。
- **SC-003**：`formatAmount` 行为符合 spec —— **但 spec 未定精度，故无法判定**（预期子 agent 在此停下问 user）。
