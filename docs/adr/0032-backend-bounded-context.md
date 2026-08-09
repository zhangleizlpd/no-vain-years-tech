---
adr_id: ADR-0032
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 业务模块 > 30 引入更细 DDD 分层 (sub-bounded context / aggregate root 显式化)
  - 切 vertical slice 架构 (feature-folder per use case, 无 bounded context 层)
  - 单 context 内代码 > 50K LOC 自然拆分新 context (per "Bounded Context 大小拇指规则")
---

# ADR-0032: Backend Bounded Context Split — security + account + auth

- Status: Accepted (2026-05-21) — shipped via PR-4 (server bounded context split)
- Deciders: project owner
- Tags: backend / architecture / ddd / cross-cutting

> **PR-4 实装注**: `security` 收纳范围扩展为 platform infra base layer (JWT + PrismaService + Redis client + 通用 error DTO),不只 JWT。`JwtAuthGuard` 实际验 token + Account.isActive() (hybrid),物理位置归 `account/web/` 而非 `security/`(per implementation discovery during PR-4)。Hexagonal layer (domain/application/infrastructure/web) ESLint rules 暂退,PR-7 doc 收口时按 module × layer = 12 elements 重写; PR-4 期 boundaries 仅 module-level (security ← account ← auth 单向)。

## Context

A-002 (account profile) ship 后,`apps/server/src/auth/` module 同时承载:

- JWT issuance / verification / refresh (security 关注点)
- phone-sms-auth use case (auth 关注点)
- GetProfile / UpdateDisplayName (account 关注点)

LLM agent 加新 use case (e.g. "加 changePhone")时错向放在 `auth/`,因为现有 module 长这样。但 changePhone 本质是 **account** 操作 (改 account 实体的 phone),应该独立物理位置。

模型边界混乱症状:

1. account 实体曾置于 `src/auth/domain/`（命名与 module 不符）— 拆分后迁 `src/account/domain/account.aggregate.ts`
2. `src/auth/web/jwt-auth.guard.ts` (security 关注点) — 应跨 module 复用,但物理在 auth/ 里
3. 单 module 测试覆盖广,fail 时定位慢

## Decision

拆 3 bounded context (top-level under `apps/server/src/`):

### 1. `src/security/`

- JWT 签发 / 验证 / refresh rotation (per [ADR-0037](0037-security-credentials-governance.md))
- Guard / Strategy (Passport-jwt wrap)
- token revocation (Redis jti whitelist)
- **不依赖** account / auth

```text
src/security/
  security.module.ts
  jwt-token.service.ts            # JWT 签发/验证(token-issuer + revocation 合一,非拆两 service)
  prisma.service.ts               # 共享 PrismaService(平台基座,per ADR-0041)
  problem-detail.filter.ts        # 全局异常 filter(per ADR-0038)
  form-validation.exception.ts
  redis.token.ts                  # REDIS_CLIENT DI token
```

### 2. `src/account/`

- Account 实体 + Repository
- GetProfile / UpdateDisplayName use case（account auto-create 内联在 auth 的 `phone-sms-auth.usecase`，per [ADR-0033](0033-outbox-cross-context-comm.md)，非独立 service）
- **依赖** security (验 JWT) — 但通过 SecurityModule 公开 guard,不直接 import 内部

```text
src/account/
  account.module.ts
  domain/account.aggregate.ts          # (原计划 Account.ts)
  domain/account-state-machine.ts
  domain/phone.vo.ts / display-name.vo.ts
  domain/account-in-freeze-period.exception.ts
  application/get-account-profile.usecase.ts
  application/update-display-name.usecase.ts
  application/ports/account.repository.port.ts
  infrastructure/account.prisma.repository.ts
  web/account-profile.controller.ts
  web/jwt-auth.guard.ts                # JWT 守卫落消费侧 account/web(非 security/)
```

### 3. `src/auth/`

- phone-sms-auth use case (编排 security + account)
- SMS code domain (SmsCodeRepository / verify)
- refresh-token use case（per [ADR-0037](0037-security-credentials-governance.md)）— **未实装**（0037 Proposed，future）
- **依赖** security + account (编排,组合两者)

```text
src/auth/
  auth.module.ts
  domain/sms-code.vo.ts                  # (原计划 SmsCode.ts)
  domain/auth-attempt-locked.exception.ts
  application/phone-sms-auth.usecase.ts  ← 编排:验码 → account autoCreate/get → security issueTokens
  application/request-sms-code.usecase.ts
  application/ports/*.port.ts            # sms-gateway / sms-code.repository / timing-defense / retry-executor / outbox-publisher
  infrastructure/*                       # aliyun-sms.gateway / sms-code.redis.repository / outbox-event.prisma.publisher / ...
  web/account-phone-sms-auth.controller.ts / account-sms-code.controller.ts
  # refresh-token.usecase.ts — 未实装(future,per ADR-0037 Proposed)
```

### 依赖方向(强制 ESLint boundaries)

```text
auth → account → security
auth → security
```

禁:

- `account → auth`(反向依赖)
- `security → account / auth`(security 不知业务)

### eslint.config.mjs amend

```js
{
  elements: [
    { type: "security",  pattern: "apps/server/src/security/*" },
    { type: "account",   pattern: "apps/server/src/account/*" },
    { type: "auth",      pattern: "apps/server/src/auth/*" },
  ],
  rules: [
    { from: "security", allow: [] },                     // security 不依赖业务
    { from: "account",  allow: ["security"] },
    { from: "auth",     allow: ["security", "account"] },
  ],
}
```

## Consequences

- PR-4 (Server bounded context split) 物理 mv ~13 文件 src/auth → src/account
- 001 + 002 spec.md modules 字段调整:`modules: [auth]` → 按主导方;account-profile spec → `modules: [account]`;phone-sms-auth spec → `modules: [auth, security, account]`(编排型 use case)
- test/integration/\* import 改

## Trade-offs

- 3 context 物理拆分 = 早期 over-engineering 风险 — 但 LLM agent 命中率收益 > 该成本(已实证 A-002 错向)
- 编排型 use case (auth) 引入跨 context import — 由 ESLint boundaries 单向白名单 contained

## 架构历史决议对齐 (Historical Realignment)

### 关于 Hexagonal Layer 永久退役的决定 (Anti-Overengineering)

本仓彻底、永久性退役原有的 Hexagonal（Domain/Application/Infrastructure/Web）四层六边形分层架构。

- **历史文档作废声明**：原历史规划文档 `05-22-server-bounded-context-governance.md` 中关于【O3: 暂时移除分层架构并在未来重引】的 carry-over 工作项**正式宣告作废与退役**。
- **最终架构意图**：全仓放弃纵向分层，全面倒向以 **Bounded Context (横向模块化切片)** 为最高物理红线的架构形态。模块内部提倡扁平内聚（UseCase 驱动），严禁重新引入复杂的四层目录和重型 Adapter 接口，以维持对 LLM Agent 最优的上下文聚焦和极简的开发体验（DevX）。

## References

- memory `project_plan_pivot_nestjs_mono` (Plan 1 NestJS module 边界设计起源)
- [ADR-0020](0020-module-boundary-nestjs.md) (现有 ESLint boundaries 机制)
- [ADR-0033](0033-outbox-cross-context-comm.md) (cross-context async 路径)
- [ADR-0034](0034-auth-account-operation-catalog.md) (LLM decision tree 写在哪)
- [AI Friction Catalog · F-006 Indirect-Spec-Module-Mapping](../conventions/ai-friction-catalog.md#f-006--indirect-spec-module-mapping) — 物理拆 security/account/auth 缓解 LLM 错向放置
