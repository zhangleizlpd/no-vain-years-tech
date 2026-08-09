---
feature_id: [###-feature-name]
modules: [<module>]
owners: ["@<github-handle>"]
status: draft
created_at: [YYYY-MM-DD]
updated_at: [YYYY-MM-DD]
spec_kit_version: ">=0.8.5,<0.10.0"
orchestrator_compat: ">=0.2.0"

# --- v2 fields (mono-orchestrator-ready 0.2.0, post-A-002 retro) ---

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
# 当 stub | untested 时 web_compat_notes 必填,说明缺什么 / 哪条路径未测.
web_compat: na
# web_compat_notes: "Expo Web export 仅冒烟 login flow,onboarding+我的页未测"

# AI agent 协作摩擦观察 (per ADR-0024 amend + docs/conventions/ai-friction-catalog.md).
# 当 true 时 agent_friction_notes 必填,引 catalog 模式 ID + 一句话现象.
agent_friction_observed: false
# agent_friction_notes: "TS-Bundler-Mismatch — .js 后缀强加在 packages/auth 反 Metro"

# 性能预算 (per ADR-0039 SSOT). 实测靠 nightly perf IT;每个 user-facing endpoint 1 条.
# perf_budgets:
#   - endpoint: "POST /api/v1/phone-sms-auth"
#     p95_ms: 200
#     p99_ms: 500
#     timing_defense:       # 仅反枚举类 endpoint 填 (per ADR-0023 类场景)
#       diff_p95_ms: 50

# 状态机分支穷举 (per 测试基建 2.0 / ADR-0040 multi-layer test gate).
# 用于强制 /speckit-tasks 生成 exhaustive integration test 任务 + 防 PR #79 类
# "Auth/Guard/Filter 漏 cold-boot 分支" cascade bug。如当前 spec 含复杂
# 状态流转 (Auth / Guard / Interceptor / 路由 / 权限),必须列出所有逻辑路径;
# 不含 (e.g. 纯 CRUD 单实体 endpoint) 时可省。
# **必列分支类型** (若适用;只列 WHAT/路径,不写 HOW 机制 — 机制归 plan Impl Guardrails):
#   · 并发/竞态: "N 并发→恰一成功" 等竞态裁决路径
#   · 反枚举字节级等价: "不存在 / 跨账号 / 未授权 → 同响应"
#   · 安全/PII 边界: 作为 FR/SC (加密存 / 掩码返回 / 时序一致)
# 0.2.2 阶段 optional;0.3.0 起 required (per master plan P3 sub-plan).
# state_branches:
#   - "isAuth:true, onboarded:true -> allowed (200)"
#   - "isAuth:true, onboarded:false -> redirect /onboarding (302)"
#   - "isAuth:false -> throw UnauthorizedException (401)"

# --- end v2 fields ---

# contracts (optional — fill when API surface stabilizes; orchestrator uses
# the sha256 checksum to detect server ↔ api-client ↔ mobile drift):
# contracts:
#   - path: "packages/api-client/src/<file>.interface.ts"
#     checksum: "sha256-..."
---

# Feature Specification: [FEATURE NAME]

<!--
Frontmatter contract (parsed by scripts/orchestrator/parsers/spec.ts):
- feature_id: NNN-slug, must equal directory name + git branch + PR slug
- modules: business-naming.md domain values; use [cross-cutting] only for
  platform-wide refactors
- owners: GitHub handles, prefix @, CODEOWNERS-compatible
- status: draft → clarified → planned → tasks-ready → implementing → implemented
         → superseded → archived

Body is PROSE-ONLY (no HTML-comment metadata). The orchestrator extracts what it
needs straight from prose — keep these shapes exact:
- User Story:          ### User Story <n> — <title> (Priority: P<n>)
- Functional Req:      - **FR-NNN**: <text>   (prose carries no priority → orchestrator defaults 'should')
- Success Criterion:   - **SC-NNN**: <text>
The data model lives in schema.prisma (SoT) and the API surface in @nestjs/swagger
decorators → OpenAPI (code-first SoT), NOT here — spec.md is prose requirements only.

If the user-journey-mermaid preset is installed, a "## User Journey Diagram"
section is prepended above this file. Do not duplicate it here.
-->

## Clarifications

<!-- pending: run /speckit-clarify to populate (prose Q→A bullets under a ### Session heading). -->

## User Scenarios & Testing

### User Story 1 — [story title] (Priority: P1)

**Why this priority**: [why this story comes first]

**Acceptance Scenarios**:

1. **Given** [precondition], **When** [action], **Then** [expected outcome]
2. **Given** [precondition], **When** [action], **Then** [expected outcome]

### User Story 2 — [story title] (Priority: P2)

**Why this priority**: [why this story comes second]

**Acceptance Scenarios**:

1. **Given** [precondition], **When** [action], **Then** [expected outcome]

### Edge Cases

<!--
Edge cases attach to their parent FR via inline natural language:
  "(covers FR-001)" or "(covers FR-002, FR-003)"
Orchestrator parser uses fuzzy regex to extract these references — no per-row
marker needed.
-->

- [edge case description] (covers FR-XXX)
- [edge case description] (covers FR-XXX, FR-YYY)

## Requirements

### Functional Requirements

<!--
One bullet per requirement, prose only: `- **FR-NNN**: <text>`. Tasks trace back
to these ids in their task-title prose (e.g. `(FR-001, US1)`). Prose carries no
priority. The data model lives in schema.prisma, not here.
-->

- **FR-001**: System MUST [requirement]
- **FR-002**: System MUST [requirement]
- **FR-003**: [global / infra requirement]

## Success Criteria

<!--
One bullet per criterion, prose only: `- **SC-NNN**: <text>`. Tasks may trace to
these ids in their task-title prose (e.g. perf-IT tasks).
-->

- **SC-001**: [measurable success criterion — include the metric + target value]
- **SC-002**: [measurable success criterion]

## Assumptions

- [assumption 1 — what this spec relies on from other features / external systems]
- [assumption 2]
