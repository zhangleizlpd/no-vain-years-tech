---
feature_id: 002-account-profile
spec_ref: ./spec.md
status: drafted
created_at: "2026-05-20"
updated_at: "2026-05-20"
adr_refs: ["0017", "0020", "0024", "0025"]
orchestrator_compat: ">=0.1.0"
context7_verified: []
---

# Implementation Plan: A-002 Account Profile (GetProfile + UpdateDisplayName + mobile bootstrap)

**Spec**: [`spec.md`](./spec.md) | **Branch**: `002-account-profile` | **Sub-plan**: [`../../docs/private/plans/2026-05/05-21-orchestrator-poc-a002.md`](../../docs/private/plans/2026-05/05-21-orchestrator-poc-a002.md)

## Summary *(mandatory)*

A-002 = 2 endpoints (`GET /api/v1/accounts/me` returning profile + `PATCH /api/v1/accounts/me` for displayName update) extending the existing `account` NestJS module from 001-phone-sms-auth, plus **mobile bootstrap** (apps/mobile Expo workspace + 5 packages: `@nvy/auth` / `@nvy/ui` / `@nvy/design-tokens` / `@nvy/types` / `@nvy/api-client`) with the profile screen at `apps/mobile/app/(app)/(tabs)/profile.tsx`. **Mobile follows 「分级重写」 (per sub-plan D4 v2)**: `@nvy/auth` business flow rewritten; `@nvy/design-tokens` direct copy from legacy app (forbid claude-design redesign); `@nvy/ui` component-level reuse from legacy where possible. End-to-end verified via server e2e (Vitest+Testcontainers) + Playwright Expo Web (D12).

## Orchestrator Config *(mandatory)*

```json orchestrator_config
{
  "workspaces": [
    {
      "id": "server-app",
      "nx_project": "server",
      "cwd": "apps/server",
      "lang": "typescript",
      "module_path": "src/auth",
      "verify_commands": {
        "build": "pnpm nx build server",
        "test": "pnpm nx test server --watch=false",
        "lint": "pnpm nx lint server",
        "typecheck": "pnpm nx run server:typecheck"
      },
      "graphify_scope": "apps/server/src/auth/**/*"
    },
    {
      "id": "mobile-app",
      "nx_project": "mobile",
      "cwd": "apps/mobile",
      "lang": "typescript",
      "feature_path": "app/(app)/(tabs)/profile.tsx",
      "verify_commands": {
        "build": "pnpm nx build mobile",
        "test": "pnpm nx test mobile --watch=false",
        "lint": "pnpm nx lint mobile",
        "typecheck": "pnpm nx run mobile:typecheck",
        "e2e": "pnpm -C apps/mobile playwright test"
      },
      "graphify_scope": "apps/mobile/app/**/*"
    },
    {
      "id": "pkg-auth",
      "nx_project": "auth",
      "cwd": "packages/auth",
      "lang": "typescript",
      "verify_commands": {
        "build": "pnpm nx build auth",
        "test": "pnpm nx test auth --watch=false",
        "lint": "pnpm nx lint auth",
        "typecheck": "pnpm nx run auth:typecheck"
      },
      "graphify_scope": "packages/auth/src/**/*"
    },
    {
      "id": "pkg-ui",
      "nx_project": "ui",
      "cwd": "packages/ui",
      "lang": "typescript",
      "verify_commands": {
        "build": "pnpm nx build ui",
        "test": "pnpm nx test ui --watch=false",
        "lint": "pnpm nx lint ui",
        "typecheck": "pnpm nx run ui:typecheck"
      },
      "graphify_scope": "packages/ui/src/**/*"
    },
    {
      "id": "pkg-design-tokens",
      "nx_project": "design-tokens",
      "cwd": "packages/design-tokens",
      "lang": "typescript",
      "verify_commands": {
        "build": "pnpm nx build design-tokens",
        "lint": "pnpm nx lint design-tokens",
        "typecheck": "pnpm nx run design-tokens:typecheck"
      },
      "graphify_scope": "packages/design-tokens/src/**/*"
    },
    {
      "id": "pkg-types",
      "nx_project": "types",
      "cwd": "packages/types",
      "lang": "typescript",
      "verify_commands": {
        "build": "pnpm nx build types",
        "lint": "pnpm nx lint types",
        "typecheck": "pnpm nx run types:typecheck"
      },
      "graphify_scope": "packages/types/src/**/*"
    },
    {
      "id": "pkg-api-client",
      "nx_project": "api-client",
      "cwd": "packages/api-client",
      "lang": "typescript",
      "verify_commands": {
        "build": "pnpm nx build api-client",
        "generate": "pnpm nx run api-client:generate",
        "lint": "pnpm nx lint api-client",
        "typecheck": "pnpm nx run api-client:typecheck"
      },
      "graphify_scope": "packages/api-client/src/**/*"
    }
  ],
  "module_boundaries": {
    "_note": "HISTORICAL — superseded by ADR-0030 (5→2 packages). packages/{auth,ui,design-tokens} were inlined into apps/mobile/src/{auth,ui,theme} post-PR-3. The pkg-auth / pkg-ui / pkg-design-tokens entries below describe the as-built A-002 ship, not the current mono shape.",
    "server-app": {
      "modules": ["account"],
      "allowed_imports": ["@nestjs/*", "libs/db", "@nvy/types", "@prisma/client"],
      "forbidden_imports": ["apps/mobile/**/*", "packages/auth/**/*", "packages/ui/**/*", "packages/design-tokens/**/*"]
    },
    "mobile-app": {
      "modules": ["account"],
      "allowed_imports": ["@nvy/auth", "@nvy/ui", "@nvy/design-tokens", "@nvy/types", "@nvy/api-client", "expo-*", "react-native", "react", "zustand"],
      "forbidden_imports": ["apps/server/**/*", "@nestjs/*", "@prisma/client"]
    },
    "pkg-auth": {
      "modules": ["account"],
      "allowed_imports": ["zustand", "expo-secure-store", "@nvy/types", "@nvy/api-client"],
      "forbidden_imports": ["apps/**/*", "@nestjs/*", "@prisma/client", "packages/ui/**/*", "packages/design-tokens/**/*"]
    },
    "pkg-ui": {
      "modules": [],
      "allowed_imports": ["react", "react-native", "nativewind", "@nvy/design-tokens"],
      "forbidden_imports": ["apps/**/*", "@nestjs/*", "@prisma/client", "@nvy/auth", "@nvy/api-client", "@nvy/types"]
    },
    "pkg-design-tokens": {
      "modules": [],
      "allowed_imports": [],
      "forbidden_imports": ["apps/**/*", "packages/**/*"]
    },
    "pkg-types": {
      "modules": [],
      "allowed_imports": ["@prisma/client"],
      "forbidden_imports": ["apps/**/*", "@nestjs/*", "packages/ui/**/*", "packages/design-tokens/**/*", "packages/auth/**/*", "packages/api-client/**/*"]
    },
    "pkg-api-client": {
      "modules": [],
      "allowed_imports": ["@nvy/types"],
      "forbidden_imports": ["apps/**/*", "@nestjs/*", "@prisma/client", "packages/auth/**/*", "packages/ui/**/*", "packages/design-tokens/**/*"]
    }
  },
  "sandbox": {
    "cwd_template": "/tmp/orchestrator-{feature_id}-{task_id}",
    "cleanup_on_success": true,
    "cleanup_on_failure": false
  },
  "tech_constraints": {
    "versions": [
      { "lib": "@nestjs/core", "version": "^11.0.0" },
      { "lib": "@nestjs/swagger", "version": "^11.0.0" },
      { "lib": "@prisma/client", "version": "^7.0.0" },
      { "lib": "zustand", "version": "^5.0.0" },
      { "lib": "nativewind", "version": "^4.0.0" },
      { "lib": "expo", "version": "^54.0.0" },
      { "lib": "@hey-api/openapi-ts", "version": "^0.60.0" },
      { "lib": "@playwright/test", "version": "^1.48.0" }
    ],
    "perf_budget": [
      { "metric": "GET /api/v1/accounts/me P95 (controller to 200)", "target": "< 100ms", "trace_sc": ["SC-001"] },
      { "metric": "PATCH /api/v1/accounts/me P95 (incl DB write)", "target": "< 150ms", "trace_sc": ["SC-002"] }
    ],
    "scale": { "users": 100, "rps": 10 }
  }
}
```

## API Contracts *(mandatory)*

```json api_contracts
{
  "endpoints": [
    {
      "id": "EP1",
      "method": "GET",
      "path": "/api/v1/accounts/me",
      "auth": "bearer",
      "request": null,
      "response_schema_ref": "E1",
      "trace_fr": ["FR-001", "FR-002", "FR-009"]
    },
    {
      "id": "EP2",
      "method": "PATCH",
      "path": "/api/v1/accounts/me",
      "auth": "bearer",
      "request": {
        "type": "object",
        "properties": {
          "displayName": { "type": "string", "maxLength": 32 }
        },
        "required": ["displayName"]
      },
      "response_schema_ref": "E1",
      "trace_fr": ["FR-003", "FR-004", "FR-005"]
    }
  ]
}
```

## Constitution Check *(mandatory)*

```json constitution_check
{
  "passed": true,
  "violations": []
}
```

**Verification trace (against `.specify/memory/constitution.md`)**:

| 原则 | 状态 | 备注 |
|---|---|---|
| I. SDD (NON-NEGOTIABLE) | ✅ | spec.md ✅ → plan.md (this) → tasks.md → analyze → implement；clarify 跳 (D9：spec.md 已含 CL-001..009 完整 clarification 段，新 spec 重写时已 carry over)；analyze 必走 (D9) |
| II. Test-First TDD (NON-NEGOTIABLE) | ✅ | implement 阶段 orchestrator 每 task 走红→绿→typecheck/lint→tasks.md `[X]`→stage→commit 6 步闭环 |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 拆分原则；每 task 独立 commit + tasks.md `[X]` 翻转 |
| IV. Module Boundary 显式 + ESLint 强制 | ✅ | 7 workspaces 各 module_boundaries 已定义 (server-app + mobile-app + 5 packages)；`eslint-plugin-boundaries` 已 mono W2.3 装；4 类规则继承 001 |
| V. 类型同步链 Nx-driven | ✅ | server `@nestjs/swagger` 装饰器 → `nx run server:export-openapi` 产 openapi.json → `nx run api-client:generate` (D11 + @hey-api/openapi-ts) → `apps/mobile` 消费；server + mobile + api-client **同 PR**（per Constitution V） |

## Architecture Notes *(mandatory)*

> Each bullet = orchestrator inject 进 implement task temp-prompt.md 的硬约束。

**Server side**:

- **Co-locate 在既有 `apps/server/src/auth/` 模块内**（per 2026-05-20 user 决策，dry-run 揭示 001 实际 ship at `src/auth/` flat 而非 `modules/account/`；A-002 与 001 reality 一致，PoC 阶段不 refactor）。新增 use case 与既有 `phone-sms-auth` 平级：`apps/server/src/auth/application/get-account-profile.usecase.ts` + `update-display-name.usecase.ts`；新增 controller `apps/server/src/auth/web/account-profile.controller.ts`；新增 JwtAuthGuard `apps/server/src/auth/web/jwt-auth.guard.ts`。Spec frontmatter `modules: ["account"]` 保留作 **business module 命名**，T006 ESLint boundary 把 "account" 业务概念 → `src/auth/` 文件系统路径映射。
- **DisplayName VO** at `apps/server/src/auth/domain/display-name.vo.ts`，mirror 既有 `Phone` VO pattern（class 名 `Phone`，位于 `phone.vo.ts`；constructor 私有 + static factory + getter + immutable value 模式）：constructor validate FR-005 全规则（长度 [1, 32] Unicode 码点 / 字符集 / 禁字符）；违反抛 `IllegalArgumentException("INVALID_DISPLAY_NAME: ...")`，由 ProblemDetail filter 映射 400。
- **Account aggregate** 扩展（既有 `account.aggregate.ts`）：加 `displayName: DisplayName | null` field + `changeDisplayName(DisplayName, Instant)` method，经 T012 新建的 `AccountStateMachine.changeDisplayName` facade 调用（**`AccountStateMachine` 之前不存在**；模式沿用现有 `markLoggedIn` aggregate-method — 时间戳 + 状态校验）。
- **Prisma migration**：加 `display_name VARCHAR NULL` column 到 `account` table（expand-only，FR-007 auto-create 默认 null，无 backfill）；migration name `add_display_name_nullable`，落 `apps/server/prisma/migrations/`。
- **JwtAuthFilter status check** (FR-009)：验签后查 DB 验 `Account.status == ACTIVE`；非 ACTIVE → 401 ProblemDetail（与 token 过期一致路径，反枚举吞）。复用 001 既有 filter pattern。
- **限流配置**（FR-008）：`me-get` 60s 60 次 / `me-patch` 60s 10 次；超限 → 429 + Retry-After。**实现路径**：复用 001 既有 `@nestjs/throttler` `ThrottlerModule.forRootAsync` 配置（见 `auth.module.ts` line ~57，Redis storage via `ThrottlerStorageRedisService`），在 `throttlers: []` 数组内**新增** `me-get` / `me-patch` 两条 named throttler 配置；controller 用 `@Throttle({ 'me-get': { ... } })` 装饰器绑定；getTracker 用 `<accountId>` (来自 JWT claim)。**不**新建独立 `RateLimitService` 类。
- **ProblemDetail filter** (FR-010)：所有错误响应走 RFC 9457，复用 `apps/server/src/auth/infrastructure/problem-detail.filter.ts` from 001。
- **OpenAPI exposure** (FR-012)：controller + DTO 装饰器自动派生；`nx run server:export-openapi` 产 `apps/server/openapi.json`，供下游 api-client regenerate。
- **Server e2e**（D3 ②）：`apps/server/test/integration/accounts.us1-002.e2e.spec.ts` + `us2-002.e2e.spec.ts`，复用 001 Vitest + Testcontainers pattern，覆盖 US1-4 (server)。

**Mobile side (per D4 v2 「分级重写」)**:

- **`@nvy/types`** (D11)：`packages/types/src/index.ts` re-export from `@prisma/client`（Account / DisplayName / account_status_enum 等）；无 runtime Zod，无 codegen。
- **`@nvy/api-client`**：`@hey-api/openapi-ts` 从 `apps/server/openapi.json` 生成 typed client；`apps/server` openapi.json 由本 PR server 段先产出，再触发 api-client regenerate（nx affected 链）。
- **`@nvy/auth`**：zustand v5 store + `expo-secure-store` persist (`accountId / accessToken / refreshToken / displayName`) + token refresh middleware；**业务流代码重写**适配新 NestJS API（POST /accounts/phone-sms-auth + GET /me）。架构骨架沿用既有移动端 auth 包，但 zustand v4 → v5 + new endpoint adapter。
- **`@nvy/design-tokens`**：**直搬不重写**既有 design-tokens 集（cp 整目录 + 调整 package.json 改名）。**禁止用 claude-design 重新设计 token，禁止新生成 design-tokens 文件**（per memory `feedback_design_tokens_reuse_not_redesign`）。
- **`@nvy/ui`**：组件层**尽量重用**既有 UI 库；只有适配新 NestJS API / zustand v5 时改造，**不为重写而重写**。NativeWind v4 + Tailwind 配色直搬。
- **`apps/mobile/` Expo workspace init**：`apps/mobile/{package.json, app.json, metro.config.js, babel.config.js, tsconfig.json, project.json}`；route structure 沿用既有 Expo 布局 含 `(auth)/login.tsx` + `(app)/_layout.tsx` + `(app)/onboarding.tsx` + `(app)/(tabs)/{_layout, index, search, pkm, profile}.tsx` + `(app)/settings/` 等（占位 page 沿用，hooks / 状态管理重写适配新 API）。
- **Profile screen** (`apps/mobile/app/(app)/(tabs)/profile.tsx`)：4-tab 底 bar (首页 / 搜索 / 外脑 / 我的) + sticky slide tabs (笔记 / 图谱 / 知识库) + 顶 nav 三 entry (≡ disabled / 🔍 disabled / ⚙️ → `/(app)/settings`)。占位 UI 4 边界（无 hex / px / 自定义动画 / packages/ui 新抽组件）。
- **AuthGate 第三态目标**（FR-014）：`/(app)/` → `/(app)/(tabs)/profile`；决策函数 `auth-gate-decision.ts` 同步更新。
- **Playwright Expo Web** (D12)：`apps/mobile/playwright.config.ts` + `apps/mobile/e2e/profile.spec.ts`；测试 GetProfile + UpdateDisplayName 端到端路径，`page.screenshot()` 自动截屏到 `apps/mobile/playwright-report/screenshots/`。`@nvy/auth` `expo-secure-store` 在 web 走 localStorage fallback（per D12）。

**Cross-cutting**:

- **Server → api-client → mobile 同步链**（Constitution V）：本 PR server openapi.json 产出 → api-client regenerate → mobile 消费，**同 1 PR**；nx affected 自动传导。
- **API path prefix**：server controller 加 `@Controller({ path: 'api/v1/accounts', version: '1' })`；mobile api-client `baseURL` 配 `/api/v1`。
- **反枚举不变性**（SC-003）：grep `displayName` **不** 命中 `PhoneSmsAuthResponse` / `LoginResponse`；displayName 仅在 `/me` 响应流出。
- **测试覆盖**：server unit + integration + e2e；mobile unit + Playwright web e2e；trace_us / trace_fr / trace_sc 一一对应。

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：mobile bootstrap 引入 4 个全新 packages（auth / ui / design-tokens / types）+ 1 个全新 app (mobile)，工作量大但不违反 Constitution，是 PoC scope 第一个 use case 自然 carry 母 plan § 2.6 mobile per-feature 同步原则的隐含 bootstrap 工作（per sub-plan D4 v2）。

---

## Phase 2 准备（/speckit-tasks 输入要点）

接下来 `/speckit-tasks` 应基于本 plan 拆 tasks.md，建议层级：

- `[Setup]` — apps/mobile Expo workspace init / 5 packages bootstrap (auth/ui/design-tokens/types/api-client) / Nx project.json 配置 / module boundaries lint rule update / Playwright setup
- `[Migration]` — Prisma `add_display_name_nullable` migration
- `[Domain]` — DisplayName VO + Account aggregate `changeDisplayName` 扩展 + 单测 (server)
- `[Application]` — GetAccountProfileUseCase + UpdateDisplayNameUseCase + ports + 单测 (server)
- `[Infrastructure]` — Account repository extend (read/write displayName) + 单测 (server)
- `[Web]` — `GET /me` + `PATCH /me` Controller + DTO + class-validator decorators + Swagger decorators + 单测 (server)
- `[Server-E2E]` — `accounts.us*-002*.e2e.spec.ts` 覆盖 US1-4 (server)
- `[Types]` — `packages/types/src/index.ts` re-export `@prisma/client` types
- `[ApiClient]` — `apps/server` openapi.json 产出 + `packages/api-client` @hey-api/openapi-ts regenerate
- `[Auth]` — `packages/auth/` zustand v5 store + secure-store + token refresh + new endpoint adapter
- `[DesignTokens]` — `packages/design-tokens/` direct copy from legacy app (NO redesign)
- `[Ui]` — `packages/ui/` reuse from legacy app (rewrite only when necessary)
- `[Mobile]` — `apps/mobile/` Expo workspace + route structure clone + AuthGate update + profile screen + 占位 4 tab + 顶 nav + sticky slide tabs + 单测
- `[Mobile-E2E]` — `apps/mobile/e2e/profile.spec.ts` Playwright + screenshots covering US5-12 (client)
- `[Verify]` — nx affected --target=test,lint,build,typecheck 全绿 + e2e 通过 + 截图归档

每 task 30min-2h + 独立 commit + tasks.md `[X]` flip（per Constitution III + /implement 6 步闭环）。

预估 task 数：35-50 个（含 5 packages bootstrap + mobile workspace + 12 US / 30 FR 实装 + e2e）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-20 | **Spec ID-namespace**: US1-12 / FR-001..030 / CL-001..009 / SC-001..017 (per spec.md schema-compat merge)

<!-- BEGIN auto-generated: performance-budget (from spec.md frontmatter; do not edit) -->

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| `GET /api/v1/accounts/me` | 50 | 100 |
| `PATCH /api/v1/accounts/me` | 100 | 200 |

_Edit `perf_budgets:` in spec.md frontmatter to change. Regenerate this block with `pnpm tsx scripts/orchestrator/plan-compiler.ts <spec-dir>`._

<!-- END auto-generated: performance-budget -->
