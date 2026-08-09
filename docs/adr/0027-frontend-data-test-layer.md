---
adr_id: ADR-0027
status: Accepted
applies_to: [apps/mobile, packages/api-client]
sunset_trigger: |
  - 全栈 RSC (Expo Router Server Actions 成熟) 让 react-query 边缘化
  - Orval 维护停滞 / kubb / openapi-fetch 在 RN+Web 双端命中率显著超越
  - Maestro 不再支持 Expo SDK 或 Plan 4 binary 分发选其他 E2E 框架 (Detox / Appium)
---

# ADR-0027: Frontend Data + Test Layer — Orval + TanStack Query + Zustand + Maestro

- Status: Accepted (2026-05-21) — packages/api-client Orval swap shipped via PR-5b; mobile consumer wiring (QueryClient mount + axios mutator interceptor + Zustand vs RQ 职责分工 + useAuthStore → useQuery refactor) shipped via PR-5c; Maestro lock to Plan 4 unchanged (binary 分发 prerequisite)
- Deciders: project owner
- Tags: frontend / data / test / cross-cutting

> **PR-5b 实装注**: orval 8.11.0,config `mode: tags-split / client: react-query / httpClient: axios / output: src/generated/`。生成 per-tag service files (accounts/accounts.ts + app/app.ts) 含 raw queryFn (`accountProfileControllerGetProfile`) + react-query hooks (`useAccountProfileControllerGetProfile` + mutation 等) + models。Consumer `packages/auth/src/store.ts` 现 raw function 调用 axios-compat (AxiosResponse.data 解构同 hey-api shape),无需 fix。删 `@hey-api/openapi-ts` devDep + 旧 `src/{gen,generated}/` 输出 (close Issue #68 of @hey-api `.js` 后缀 Metro problem)。custom axios mutator (x-trace-id req header + ProblemDetail interceptor 联 ADR-0036/0038) defer 到 PR-5c。

## Context

A-002 (account profile + mobile bootstrap, PR #65) ship 中暴露 3 类前端数据层 / 测试层缺陷:

1. **`@hey-api/openapi-ts` `.js` 后缀冲突 Metro** (Issue #68) — 生成代码内部 `import './schemas.js'`,Metro `resolver.sourceExts: ['ts','tsx','js']` 但 ESM relative `.js` 后缀在 Metro 不解 → Web 端跑 simulator 卡 module not found
2. **react-query 已用但散乱** — `useAuthStore.loadProfile` 用 `await client.GET('/me')` 而非 `useQuery`,失去缓存 / refetch / error boundary 一体化
3. **E2E test 缺** — 仅 vitest 组件测,无 RN 真机/模拟器 E2E,A-002 PR review 全靠手动 expo start 跑

## Decision

### Data Layer

| 选                                                                   | 替                  | 理由                                                                                           |
| -------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| **Orval** (mode: tags-split, client: react-query, httpClient: axios) | @hey-api/openapi-ts | Orval 输出 `.ts` 无 `.js` 后缀污染,Metro+Vite 双端兼容;原生 react-query hooks 输出,无需手 wrap |
| **TanStack Query v5** mount on `_layout.tsx`                         | (无现有方案)        | 全应用统一 cache / refetch / 全局 error handler                                                |
| **Zustand v4** (仅本地 ephemeral state)                              | useAuthStore 现状   | 远端数据全走 react-query;Zustand 只承担 UI 临时态 (modal open / form draft)                    |

### Test Layer

| 选                                        | 时机                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Maestro** lock to Plan 4                | binary 分发开始时 (TestFlight / Play Store)                                                   |
| **testID 现起强制** in 占位 UI + final UI | 现在起,所有交互元素 (Pressable / TextInput / Button) 必须 testID="<feature>.<element>.<verb>" |
| 不引 Detox                                | RN binary 测试 binary 分发前不需要                                                            |

## Consequences

- PR-5 (Orval migration) 一次性切换,迁移成本 ~2 天 (codegen 配 + 调 react-query / Zustand 职责划分 + 全 hook 重 wire)
- 关闭 Issue #68 (无 `.js` 后缀问题)
- testID convention 落 [`../conventions/maestro-testid.md`](../conventions/maestro-testid.md) (PR-7)
- Plan 4 (binary 分发) 开始时 Maestro flow 写得快 (testID 就位时)
- **2026-06-02 — 「testID 现起强制」relax 为 Plan 4 deferred**：上文 Decision 表「现在起所有交互元素必须 testID」+ PR-review 人工检查在 003-011 实践中 0 adoption（全仓仅 `error-boundary.*` 2 个、golden-sample 屏 0 个、无机械强制）。真 forcing function = Plan 4 写 Maestro flow 时按 `state_branches` 逐分支补 testID（缺漏卡 flow），非提前回填。convention `maestro-testid.md` 已 reframe 为**休眠 forward spec**；命名体例 `<feature>.<element>.<verb>` 不变

## Trade-offs

- Orval 重 codegen 输出量更大 (per tag 拆文件) — 可接受;`packages/api-client/src/generated/` 直接提交(无 `.gitignore` 忽略),codegen 产物随仓版本化
- react-query global error boundary 与现 Error Boundary 双层 — 需 ADR-0038 (Error Handling) 一致性

## References

- PR #65 (A-002) ship 过程踩坑
- GitHub Issue #68 (@hey-api `.js` 后缀 Metro)
- [ADR-0038](0038-error-handling-ux-contract.md) (前后端错误模型联动)
