---
adr_id: ADR-0030
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - 加入第二个 frontend consumer (admin-web / VSCode extension / desktop-electron) → 抽回 packages/{auth,ui,theme}
  - 设计系统稳定到独立 publish (NPM org @nvy/design-tokens 对外开源) → 抽回 packages/design-tokens
  - apps/mobile 拆 expo-router app + mobile-native (RN binary) 双 app → 共享层抽回 package
---

# ADR-0030: Package Decomposition — 5 包减 2 (apps/mobile/src/{auth,ui,theme,core}/)

- Status: Accepted
- Deciders: project owner
- Tags: repo / architecture / cross-cutting

## Context

A-002 ship 前 packages 树:

```text
packages/
  api-client/      (跨 mobile + server-types 共享,真共享)
  types/           (跨 mobile + server-types 共享,真共享)
  auth/            (仅 mobile consume)        ← over-engineered
  ui/              (仅 mobile consume)        ← over-engineered
  design-tokens/   (仅 mobile consume)        ← over-engineered
```

`@nvy/auth` / `@nvy/ui` / `@nvy/design-tokens` 设计意图是"将来可被 admin-web 复用",但:

- 实际只有 1 个 consumer (`apps/mobile`)
- 单 consumer 的包带来 nx project + workspace dep wire + import path indirection 心智成本
- PR #65/#66/#67 ship 中,3 个包反复因 pnpm strict / `.js` 后缀 / metro 解析失败 (per [ADR-0028](0028-monorepo-pnpm-policy.md) / [ADR-0029](0029-ts-module-resolution-policy.md))

YAGNI 判断:**1 consumer + < 2 月项目历史 = 应该内联**。第二个 consumer 出现时再抽回 (sunset trigger)。

## Decision

### 物理动作 (PR-3)

| 操作           | 路径                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `git mv`       | `packages/auth/src/*` → `apps/mobile/src/auth/*`                                          |
| `git mv`       | `packages/ui/src/*` → `apps/mobile/src/ui/*`                                              |
| `git mv`       | `packages/design-tokens/src/*` → `apps/mobile/src/theme/*`                                |
| 删             | `packages/{auth,ui,design-tokens}/` 整目录 (含 project.json)                              |
| 新建           | `apps/mobile/src/core/` (基础设施层 — api client / i18n / telemetry — per amend)          |
| amend          | `apps/mobile/tsconfig.json`: 删 `@nvy/{auth,ui,design-tokens}*` paths,加 `~/*: ["src/*"]` |
| amend          | `apps/mobile/tailwind.config.ts`: content path 加 `./src/**/*.{ts,tsx}`                   |
| amend          | `eslint.config.mjs`: 删 `pkg-auth` / `pkg-ui` / `pkg-design-tokens` depConstraints 段     |
| import rewrite | `@nvy/auth` → `~/auth`,`@nvy/ui` → `~/ui`,`@nvy/design-tokens` → `~/theme`                |

### apps/mobile/src/ 顶层目录(amend)

```text
apps/mobile/src/
  auth/        从 packages/auth/src/ 内联
  ui/          从 packages/ui/src/ 内联
  theme/       从 packages/design-tokens/src/ 内联 (语义化重命名)
  core/        新建 — 基础设施层:api client / i18n / telemetry / problem guards (per ADR-0036/0038)
```

### 保留 packages/

```text
packages/
  api-client/   跨 mobile + server-types 共享,真共享 (Orval 生成 per ADR-0027)
  types/        跨 mobile + server-types 共享,真共享
```

### spec 002 plan.md `module_boundaries` 段 mark historical

`002-account-profile/plan.md` 中描述 `@nvy/auth` 边界的段落加 `> **HISTORICAL** (ADR-0030 已删 packages,内联到 apps/mobile/src/auth/)` 注记。

## Consequences

- **mobile 单 app 心智集中**:所有前端代码在 `apps/mobile/src/`,无跨 package navigation
- **api-client / types 保留双 consumer 价值**:server / mobile 都用,真跨 package
- **eslint boundaries 简化**:删 3 个 depConstraints 段,boundaries 文件 -40 行
- **未来 admin-web 加入**:1 consumer → 2 consumer 时,抽回 `packages/auth` (sunset trigger 1)

## Trade-offs

- mobile 包大 ~30%(物理代码 LOC) — UI lib 内联可接受
- design-tokens → theme 改名:语义化(theme = 视觉系统),与 Tailwind / NativeWind 生态术语一致

## References

- PR #65/#66/#67 (A-002 ship,3 包反复踩坑)
- [ADR-0028](0028-monorepo-pnpm-policy.md) (shamefully-hoist 部分缘起)
- [ADR-0029](0029-ts-module-resolution-policy.md) (TS resolution 部分缘起)
- memory `feedback_design_tokens_reuse_not_redesign` (theme 内 token 不重新设计)
