---
feature_id: 002-account-profile
spec_ref: ./spec.md
plan_ref: ./plan.md
status: completed
created_at: "2026-05-20"
updated_at: "2026-05-25"
orchestrator_compat: ">=0.1.0"
---

# Tasks: A-002 Account Profile (GetProfile + UpdateDisplayName + Mobile Bootstrap)

> 40 tasks covering Mobile bootstrap (apps/mobile + 5 packages) + Server use cases + API Contracts + E2E.
>
> Trace map: 12 US × 30 FR × 2 EP × 17 SC.
> All `parallel: false` (per Ralph-loop traceability default; orchestrator serial execution PoC).
> Each task targets 30min-2h independent commit (Constitution III).

## Setup — Mobile workspace + 5 packages bootstrap

- [X] T001 Initialize apps/mobile Expo workspace (package.json + app.json + metro.config + babel.config + tsconfig + project.json)
  <!-- task-meta: {"id":"T001","workspace":"mobile-app","deps":[],"trace_us":["US5"],"trace_fr":["FR-013"],"kind":"config","verify_kind":"typecheck","files":[{"path":"apps/mobile/package.json","op":"create"},{"path":"apps/mobile/app.json","op":"create"},{"path":"apps/mobile/metro.config.js","op":"create"},{"path":"apps/mobile/babel.config.js","op":"create"},{"path":"apps/mobile/tsconfig.json","op":"create"},{"path":"apps/mobile/project.json","op":"create"}],"parallel":false} -->

- [X] T002 Bootstrap packages/types — @prisma/client re-export skeleton (per D11)
  <!-- task-meta: {"id":"T002","workspace":"pkg-types","deps":[],"trace_us":["GLOBAL"],"trace_fr":["FR-001"],"kind":"config","verify_kind":"typecheck","files":[{"path":"packages/types/package.json","op":"create"},{"path":"packages/types/project.json","op":"create"},{"path":"packages/types/tsconfig.json","op":"create"},{"path":"packages/types/src/index.ts","op":"create"}],"parallel":false} -->

- [X] T003 Bootstrap packages/design-tokens — workspace shell (D4 v2 forbid claude-design redesign)
  <!-- task-meta: {"id":"T003","workspace":"pkg-design-tokens","deps":[],"trace_us":["US5"],"trace_fr":["FR-018"],"kind":"config","verify_kind":"typecheck","files":[{"path":"packages/design-tokens/package.json","op":"create"},{"path":"packages/design-tokens/project.json","op":"create"},{"path":"packages/design-tokens/tsconfig.json","op":"create"},{"path":"packages/design-tokens/src/index.ts","op":"create"}],"parallel":false} -->

- [X] T004 Bootstrap packages/ui — workspace shell (D4 v2 reuse legacy)
  <!-- task-meta: {"id":"T004","workspace":"pkg-ui","deps":["T003"],"trace_us":["US5"],"trace_fr":["FR-018"],"kind":"config","verify_kind":"typecheck","files":[{"path":"packages/ui/package.json","op":"create"},{"path":"packages/ui/project.json","op":"create"},{"path":"packages/ui/tsconfig.json","op":"create"},{"path":"packages/ui/src/index.ts","op":"create"}],"parallel":false} -->

- [X] T005 Bootstrap packages/auth — workspace shell + dependencies (zustand v5 + expo-secure-store)
  <!-- task-meta: {"id":"T005","workspace":"pkg-auth","deps":["T002"],"trace_us":["US5","US12"],"trace_fr":["FR-002","FR-004"],"kind":"config","verify_kind":"typecheck","files":[{"path":"packages/auth/package.json","op":"create"},{"path":"packages/auth/project.json","op":"create"},{"path":"packages/auth/tsconfig.json","op":"create"},{"path":"packages/auth/src/index.ts","op":"create"}],"parallel":false} -->

- [X] T006 Update ESLint config — register module boundaries for 5 new packages + mobile-app (per plan.module_boundaries); map business module "account" → src/auth/ filesystem path
  <!-- task-meta: {"id":"T006","workspace":"server-app","deps":["T001","T002","T003","T004","T005"],"trace_us":["GLOBAL"],"trace_fr":["FR-001"],"trace_sc":["SC-007"],"kind":"config","verify_kind":"lint","files":[{"path":"eslint.config.mjs","op":"modify"}],"parallel":false} -->

## Server — Prisma + Domain layer

- [X] T007 Prisma migration `add_display_name_nullable` — add nullable display_name column to account table
  <!-- task-meta: {"id":"T007","workspace":"server-app","deps":[],"trace_us":["US2"],"trace_fr":["FR-007"],"kind":"migration","verify_kind":"build","files":[{"path":"apps/server/prisma/schema.prisma","op":"modify"}],"parallel":false} -->

- [X] T008 Implement DisplayName VO (domain layer, FR-005 validation rules)
  <!-- task-meta: {"id":"T008","workspace":"server-app","deps":[],"trace_us":["US2"],"trace_fr":["FR-005"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/domain/display-name.vo.ts","op":"create"}],"parallel":false} -->

- [X] T009 DisplayName VO unit test — covers FR-005 + Edge Cases (ships RED first)
  <!-- task-meta: {"id":"T009","workspace":"server-app","deps":["T008"],"trace_us":["US2"],"trace_fr":["FR-005"],"trace_sc":["SC-006"],"kind":"test-unit","verify_kind":"test","files":[{"path":"apps/server/src/auth/domain/display-name.vo.spec.ts","op":"create"}],"parallel":false,"tdd_red_expected":true} -->

- [X] T010 Extend Account aggregate — add displayName field + changeDisplayName(DisplayName, Instant) method
  <!-- task-meta: {"id":"T010","workspace":"server-app","deps":["T008"],"trace_us":["US2"],"trace_fr":["FR-007"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/domain/account.aggregate.ts","op":"modify"}],"parallel":false} -->

- [X] T011 Account aggregate changeDisplayName unit test (ships RED first)
  <!-- task-meta: {"id":"T011","workspace":"server-app","deps":["T010"],"trace_us":["US2"],"trace_fr":["FR-007"],"kind":"test-unit","verify_kind":"test","files":[{"path":"apps/server/src/auth/domain/account.aggregate.spec.ts","op":"modify"}],"parallel":false,"tdd_red_expected":true} -->

- [X] T012 Create AccountStateMachine facade — changeDisplayName method (new file, mirrors existing markLoggedIn aggregate-method pattern)
  <!-- task-meta: {"id":"T012","workspace":"server-app","deps":["T010"],"trace_us":["US2"],"trace_fr":["FR-007"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/domain/account-state-machine.ts","op":"create"}],"parallel":false} -->

## Server — Application + Infrastructure

- [X] T013 Extend Account repository — read/write displayName field
  <!-- task-meta: {"id":"T013","workspace":"server-app","deps":["T007","T010"],"trace_us":["US1","US2","US3"],"trace_fr":["FR-001","FR-003"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/infrastructure/account.prisma.repository.ts","op":"modify"}],"parallel":false} -->

- [X] T014 Implement GetAccountProfileUseCase
  <!-- task-meta: {"id":"T014","workspace":"server-app","deps":["T013"],"trace_us":["US1","US3"],"trace_fr":["FR-001"],"trace_ep":["EP1"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/application/get-account-profile.usecase.ts","op":"create"}],"parallel":false} -->

- [X] T015 GetAccountProfileUseCase unit test (ships RED first)
  <!-- task-meta: {"id":"T015","workspace":"server-app","deps":["T014"],"trace_us":["US1","US3"],"trace_fr":["FR-001"],"kind":"test-unit","verify_kind":"test","files":[{"path":"apps/server/src/auth/application/get-account-profile.usecase.spec.ts","op":"create"}],"parallel":false,"tdd_red_expected":true} -->

- [X] T016 Implement UpdateDisplayNameUseCase
  <!-- task-meta: {"id":"T016","workspace":"server-app","deps":["T012","T013"],"trace_us":["US2"],"trace_fr":["FR-003","FR-005"],"trace_ep":["EP2"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/application/update-display-name.usecase.ts","op":"create"}],"parallel":false} -->

- [X] T017 UpdateDisplayNameUseCase unit test (ships RED first)
  <!-- task-meta: {"id":"T017","workspace":"server-app","deps":["T016"],"trace_us":["US2"],"trace_fr":["FR-003","FR-005"],"kind":"test-unit","verify_kind":"test","files":[{"path":"apps/server/src/auth/application/update-display-name.usecase.spec.ts","op":"create"}],"parallel":false,"tdd_red_expected":true} -->

## Server — Web layer

- [X] T018 Implement GET /api/v1/accounts/me Controller + Response DTO + OpenAPI decorators
  <!-- task-meta: {"id":"T018","workspace":"server-app","deps":["T014"],"trace_us":["US1","US3"],"trace_fr":["FR-001","FR-002","FR-010","FR-012"],"trace_ep":["EP1"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/web/account-profile.controller.ts","op":"create"},{"path":"apps/server/src/auth/web/dto/account-profile.response.ts","op":"create"}],"parallel":false} -->

- [X] T019 Implement PATCH /api/v1/accounts/me endpoint + Request DTO + validation
  <!-- task-meta: {"id":"T019","workspace":"server-app","deps":["T016","T018"],"trace_us":["US2"],"trace_fr":["FR-003","FR-004","FR-010"],"trace_ep":["EP2"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/web/account-profile.controller.ts","op":"modify"},{"path":"apps/server/src/auth/web/dto/update-display-name.request.ts","op":"create"}],"parallel":false} -->

- [X] T020 Create JwtAuthGuard — JWT validation + FR-009 ACTIVE status check (non-ACTIVE returns 401); used by /me endpoints
  <!-- task-meta: {"id":"T020","workspace":"server-app","deps":["T013"],"trace_us":["US4"],"trace_fr":["FR-002","FR-009","FR-028"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/web/jwt-auth.guard.ts","op":"create"}],"parallel":false} -->

- [X] T021 Implement rate limit for /me endpoints (FR-008 — me-get 60s 60, me-patch 60s 10)
  <!-- task-meta: {"id":"T021","workspace":"server-app","deps":["T018","T019"],"trace_us":["US1","US2","US3"],"trace_fr":["FR-008"],"trace_sc":["SC-004"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/server/src/auth/web/account-profile.controller.ts","op":"modify"}],"parallel":false} -->

## Server — E2E (Vitest + Testcontainers)

- [X] T022 US1 e2e — 新用户首登 GET /me 返 displayName=null
  <!-- task-meta: {"id":"T022","workspace":"server-app","deps":["T018","T020","T021"],"trace_us":["US1"],"trace_fr":["FR-001","FR-002","FR-007"],"trace_ep":["EP1"],"trace_sc":["SC-001","SC-003"],"kind":"test-e2e","verify_kind":"test","files":[{"path":"apps/server/test/integration/accounts.us1-002.e2e.spec.ts","op":"create"}],"parallel":false} -->

- [X] T023 US2 e2e — PATCH displayName 成功路径 + Edge Cases 全部覆盖
  <!-- task-meta: {"id":"T023","workspace":"server-app","deps":["T019","T021"],"trace_us":["US2"],"trace_fr":["FR-003","FR-005","FR-008"],"trace_ep":["EP2"],"trace_sc":["SC-002","SC-006"],"kind":"test-e2e","verify_kind":"test","files":[{"path":"apps/server/test/integration/accounts.us2-002.e2e.spec.ts","op":"create"}],"parallel":false} -->

- [X] T024 US3 e2e — 老用户回访 GET /me 返已存 displayName
  <!-- task-meta: {"id":"T024","workspace":"server-app","deps":["T018"],"trace_us":["US3"],"trace_fr":["FR-001"],"trace_ep":["EP1"],"kind":"test-e2e","verify_kind":"test","files":[{"path":"apps/server/test/integration/accounts.us3-002.e2e.spec.ts","op":"create"}],"parallel":false} -->

- [X] T025 US4 e2e — FROZEN / ANONYMIZED 账号持有 token → 401 (反枚举吞)
  <!-- task-meta: {"id":"T025","workspace":"server-app","deps":["T020"],"trace_us":["US4"],"trace_fr":["FR-002","FR-009"],"trace_sc":["SC-005"],"kind":"test-e2e","verify_kind":"test","files":[{"path":"apps/server/test/integration/accounts.us4-002.e2e.spec.ts","op":"create"}],"parallel":false} -->

## API Client — server openapi.json → api-client regenerate

- [X] T026 Add server:export-openapi nx target — produce apps/server/openapi.json
  <!-- task-meta: {"id":"T026","workspace":"server-app","deps":["T018","T019"],"trace_us":["GLOBAL"],"trace_fr":["FR-012"],"trace_ep":["EP1","EP2"],"kind":"gen","verify_kind":"build","files":[{"path":"apps/server/project.json","op":"modify"},{"path":"apps/server/openapi.json","op":"modify"}],"parallel":false} -->

- [X] T027 Regenerate packages/api-client (@hey-api/openapi-ts from openapi.json)
  <!-- task-meta: {"id":"T027","workspace":"pkg-api-client","deps":["T026"],"trace_us":["GLOBAL"],"trace_fr":["FR-012"],"trace_ep":["EP1","EP2"],"kind":"gen","verify_kind":"generate","files":[{"path":"packages/api-client/src/gen/index.ts","op":"create"}],"parallel":false} -->

## Mobile — packages content

- [X] T028 packages/types — populate Account / DisplayName / account_status_enum re-exports
  <!-- task-meta: {"id":"T028","workspace":"pkg-types","deps":["T002","T007"],"trace_us":["GLOBAL"],"trace_fr":["FR-001"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"packages/types/src/index.ts","op":"modify"}],"parallel":false} -->

- [X] T029 packages/design-tokens — direct copy tokens 自既有 design-tokens 集 (NO redesign, per memory)
  <!-- task-meta: {"id":"T029","workspace":"pkg-design-tokens","deps":["T003"],"trace_us":["US5"],"trace_fr":["FR-018"],"kind":"impl","verify_kind":"build","files":[{"path":"packages/design-tokens/src/colors.ts","op":"create"},{"path":"packages/design-tokens/src/spacing.ts","op":"create"},{"path":"packages/design-tokens/src/typography.ts","op":"create"}],"parallel":false} -->

- [X] T030 packages/ui — migrate components from legacy app (Button / Spinner / SafeAreaView etc, reuse not rewrite)
  <!-- task-meta: {"id":"T030","workspace":"pkg-ui","deps":["T004","T029"],"trace_us":["US5","US7","US9"],"trace_fr":["FR-018","FR-020","FR-027"],"kind":"impl","verify_kind":"build","files":[{"path":"packages/ui/src/Button.tsx","op":"create"},{"path":"packages/ui/src/Spinner.tsx","op":"create"},{"path":"packages/ui/src/SafeAreaView.tsx","op":"create"}],"parallel":false} -->

- [X] T031 packages/auth — zustand v5 store + secure-store persistence + token refresh middleware + `loadProfile()` action (business flow rewrite per D4 v2)
  <!-- task-meta: {"id":"T031","workspace":"pkg-auth","deps":["T005","T027","T028"],"trace_us":["US5","US12"],"trace_fr":["FR-014","FR-016"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"packages/auth/src/store.ts","op":"create"},{"path":"packages/auth/src/token-refresh.ts","op":"create"},{"path":"pnpm-lock.yaml","op":"modify"},{"path":"specs/002-account-profile/tasks.md","op":"modify"}],"parallel":false} -->

- [X] T032 packages/auth unit tests — store + token refresh (Vitest, ships RED first)
  <!-- task-meta: {"id":"T032","workspace":"pkg-auth","deps":["T031"],"trace_us":["US5","US12"],"trace_fr":["FR-014"],"kind":"test-unit","verify_kind":"test","files":[{"path":"packages/auth/src/store.spec.ts","op":"create"},{"path":"packages/auth/src/token-refresh.spec.ts","op":"create"},{"path":"packages/auth/project.json","op":"modify"},{"path":"packages/auth/vitest.config.ts","op":"modify"},{"path":"specs/002-account-profile/tasks.md","op":"modify"}],"parallel":false,"tdd_red_expected":true} -->

## Mobile — apps/mobile screens & routes

- [X] T033 Clone Expo Router route structure from legacy app — (auth)/ + (app)/ + (app)/(tabs)/ + (app)/onboarding skeletons (occupant pages, no business logic)
  <!-- task-meta: {"id":"T033","workspace":"mobile-app","deps":["T001","T030","T031"],"trace_us":["US5","US6","US7"],"trace_fr":["FR-013","FR-015","FR-024"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/mobile/app/_layout.tsx","op":"create"},{"path":"apps/mobile/app/index.tsx","op":"create"},{"path":"apps/mobile/app/(auth)/_layout.tsx","op":"create"},{"path":"apps/mobile/app/(auth)/login.tsx","op":"create"},{"path":"apps/mobile/app/(app)/_layout.tsx","op":"create"},{"path":"apps/mobile/app/(app)/onboarding.tsx","op":"create"},{"path":"apps/mobile/app/(app)/(tabs)/_layout.tsx","op":"create"},{"path":"apps/mobile/app/(app)/(tabs)/index.tsx","op":"create"},{"path":"apps/mobile/app/(app)/(tabs)/search.tsx","op":"create"},{"path":"apps/mobile/app/(app)/(tabs)/pkm.tsx","op":"create"}],"parallel":false} -->

- [X] T034 AuthGate decision update — 3rd state target /(app)/(tabs)/profile (FR-014)
  <!-- task-meta: {"id":"T034","workspace":"mobile-app","deps":["T033"],"trace_us":["US5","US6","US12"],"trace_fr":["FR-014","FR-016"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/mobile/app/_layout.tsx","op":"modify"},{"path":"apps/mobile/lib/auth-gate-decision.ts","op":"create"},{"path":"packages/auth/src/index.ts","op":"modify"}],"parallel":false} -->

- [X] T035 Implement profile screen — hero (avatar + bg + username + follow placeholder) + 3 slide tabs + 顶 nav 3 entries
  <!-- task-meta: {"id":"T035","workspace":"mobile-app","deps":["T033","T034"],"trace_us":["US5"],"trace_fr":["FR-016","FR-017","FR-018","FR-019","FR-027"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/mobile/app/(app)/(tabs)/profile.tsx","op":"create"},{"path":"apps/mobile/tailwind.config.ts","op":"create"},{"path":"apps/mobile/global.css","op":"create"},{"path":"apps/mobile/nativewind-env.d.ts","op":"create"},{"path":"apps/mobile/app/_layout.tsx","op":"modify"}],"parallel":false} -->

- [X] T036 Implement sticky slide tabs state machine + scroll behavior (FR-020 + FR-030 + CL-005 sticky tabs)
  <!-- task-meta: {"id":"T036","workspace":"mobile-app","deps":["T035"],"trace_us":["US5","US8","US9"],"trace_fr":["FR-017","FR-020","FR-021","FR-030"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/mobile/app/(app)/(tabs)/profile.tsx","op":"modify"}],"parallel":false} -->

- [X] T037 Implement bottom tab bar 4-item (首页/搜索/外脑/我的) — Expo Router Tabs default options
  <!-- task-meta: {"id":"T037","workspace":"mobile-app","deps":["T033","T030"],"trace_us":["US7"],"trace_fr":["FR-013","FR-024"],"kind":"impl","verify_kind":"typecheck","files":[{"path":"apps/mobile/app/(app)/(tabs)/_layout.tsx","op":"modify"}],"parallel":false} -->

- [X] T038 Vitest + RTL unit tests — profile screen / auth gate / sticky tabs / bottom tab bar (ships RED first)
  <!-- task-meta: {"id":"T038","workspace":"mobile-app","deps":["T035","T034","T037"],"trace_us":["US5","US6","US7","US8","US9","US12"],"trace_fr":["FR-016","FR-020","FR-021"],"trace_sc":["SC-008","SC-009","SC-010","SC-014","SC-015"],"kind":"test-unit","verify_kind":"test","files":[{"path":"apps/mobile/vitest.config.ts","op":"create"},{"path":"apps/mobile/lib/auth-gate-decision.spec.ts","op":"create"}],"parallel":false,"tdd_red_expected":true,"scope_note":"profile screen / sticky tabs / bottom tab bar component tests deferred to T040 Playwright (Expo Web) — RN→DOM stack would require react-native-web + reanimated/svg shims, duplicating T040 coverage."} -->

## E2E — Playwright + Expo Web (D12)

- [X] T039 Set up Playwright config (apps/mobile/playwright.config.ts) + Expo Web export pipeline
  <!-- task-meta: {"id":"T039","workspace":"mobile-app","deps":["T001","T035"],"trace_us":["GLOBAL"],"trace_fr":["FR-013"],"kind":"config","verify_kind":"typecheck","files":[{"path":"apps/mobile/playwright.config.ts","op":"create"},{"path":"apps/mobile/project.json","op":"modify"}],"parallel":false} -->

- [X] T040 Playwright e2e — GetProfile + UpdateDisplayName flow (Web target) + auto screenshots via page.screenshot()
  <!-- task-meta: {"id":"T040","workspace":"mobile-app","deps":["T022","T023","T035","T036","T037","T039"],"trace_us":["US5","US7","US8","US9","US11"],"trace_fr":["FR-016","FR-017","FR-018","FR-024"],"trace_sc":["SC-008","SC-013","SC-016","SC-017"],"kind":"test-e2e","verify_kind":"e2e","files":[{"path":"apps/mobile/e2e/profile.spec.ts","op":"create"},{"path":"packages/auth/src/store.ts","op":"modify"},{"path":"packages/auth/tsconfig.json","op":"modify"},{"path":"packages/design-tokens/package.json","op":"modify"},{"path":"apps/mobile/package.json","op":"modify"}],"parallel":false,"scope_note":"GetProfile flow covered for US5/US7/US8/US9/US11 via pre-seeded localStorage (zustand-persist key nvy-auth). US6/US10/US12 covered upstream (US6 vitest auth-gate, US10 covered by US5 a11y assertions, US12 by AuthGate unit logic). UpdateDisplayName client UI does not exist in mono (deferred alongside 001-US5 client migration); server PATCH endpoint covered E2E by T023. Runtime verify deferred — Expo Web boot surfaced cascading pnpm peer-dep gaps (T001 bootstrap orphans: react-native-web, react-native-css-interop, @babel/runtime, expo-modules-core, @react-navigation/{native,bottom-tabs,stack,elements,core,routers}, react-native-is-edge-to-edge, @react-native/{normalize-colors,assets-registry}, nanoid, use-latest-callback; further peers (fbjs/...) still pending). All deps now in apps/mobile/package.json. Resolution: bulk-install remaining peers OR set pnpm publicHoistPattern next session, then `pnpm nx run mobile:e2e --skip-nx-cache`."} -->

---

## Mobile — Onboarding 表单切片（account-migration p3, 2026-05-25）

> mobile-only port（[Server]/[Contract] 已在批 A ship — server PATCH `/me` + api-client `useAccountProfileControllerUpdateDisplayName` 已生成）。从 legacy app 净室 port：皮肤复用、引擎重写为 RHF + zodResolver + Orval。对标 login 切片（#193）。manual 模式，无 task-meta JSON（per p3 §3）。每 task 走闭环 6 步（RED→GREEN→typecheck/lint→`[X]`→commit）。测试分层：logic→vitest、UI render/a11y→Playwright Web（per memory `reference_mono_mobile_test_layering`）。

- [X] T041 [Mobile] `src/auth/onboarding-form.schema.ts` — `displayNameSchema`（zod，trim + [1,32] Unicode 码点 + 禁控制/零宽/行分隔，镜像 server FR-005）→ RED: `onboarding-form.schema.spec.ts` 8-case 表驱动（空/仅空白/控制字符/零宽/33超长/32 CJK/emoji-only/混合合法）。verify: `nx test mobile --skip-nx-cache` 该 spec 绿（FR-031 / SC-018）
- [X] T042 [Mobile] `src/auth/update-display-name.ts` — 包 Orval `useAccountProfileControllerUpdateDisplayName`，onSuccess→`useAuthStore.setDisplayName`，不导航（镜像 `phone-sms-auth.ts`）→ RED: `update-display-name.spec.ts`（onSuccess 写 store + 不调 router）。verify: spec 绿（FR-032）
- [X] T043 [Mobile] `src/auth/use-onboarding-form.ts` — RHF（`useForm` + zodResolver 接 T041）+ `onboardingErrorToast`（duck-type AxiosError，复用 login 判别逻辑、文案不同）+ 状态机 idle→submitting→success|error → RED: `use-onboarding-form.spec.ts`（合法提交调 mutation / 非法 disabled / 错误映射 / input change 清错）。verify: spec 绿（FR-033 / FR-034）
- [X] T044 [Mobile] `src/ui/DisplayNameInput.tsx` + barrel export — 字符计数 + focus/error 边框 + a11y label/hint（裸 `TextInput` + NativeWind，复用 `~/theme`）。verify: `nx typecheck mobile` + `nx lint mobile` 绿（FR-036）
- [X] T045 [Mobile] `app/(app)/onboarding.tsx` 真实表单（替换占位）— `<Controller>` 绑 DisplayNameInput + Button + ErrorRow + SuccessOverlay；Android 硬件返回 noop（FR-035）；`src/auth/index.ts` 导出新符号。verify: typecheck + lint 绿；删除 `// PHASE 1 PLACEHOLDER` banner（US13 / FR-035 / FR-036）
- [X] T046 [Mobile] `e2e/onboarding.spec.ts` — Playwright Web happy path：新用户 displayName=null → 落 onboarding → 输入提交 → redirect 进 `(tabs)/profile`；复用 `e2e/_support/api-mock.ts` mock PATCH `/me`。verify: `nx run mobile:e2e --skip-nx-cache` 绿（SC-019）

---

## Dependency overview (DAG roots)

**Truly leaf tasks (no deps)**: T001 / T002 / T003 / T007 / T008

**Major join points**:
- T013 (Account repo extend) joins T007 (migration) + T010 (aggregate)
- T018 (GET controller) joins T014 (use case) + T013 (repo)
- T021 (rate limit) joins T018 + T019 (both controllers)
- T026 (openapi export) joins T018 + T019
- T027 (api-client regen) depends T026
- T031 (auth store) joins T005 (bootstrap) + T027 (api-client gen) + T028 (types)
- T033 (mobile route clone) joins T001 (workspace) + T030 (ui) + T031 (auth)
- T035 (profile screen) joins T033 + T034 (auth gate)
- T040 (e2e final gate) joins all server e2e (T022-T023) + mobile screen tasks (T035-T037) + Playwright config (T039)

## Implementation strategy

**MVP slice = US1 + US2 + US4 server side**:
- T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021 → T022 → T023 → T025
- Skip T024 (US3 = old user revisit, covered by US1 with seeded data)
- This shipping bar = pure server PoC w/o mobile bootstrap

**Full PoC slice (per D3 v2)**: All 40 tasks, e2e via Playwright Web target.

**Per-task closure (6-step per Constitution + sdd.md)**:
1. RED: write test (typecheck pass + test RED)
2. GREEN: write impl (test GREEN)
3. typecheck + lint pass
4. tasks.md `- [ ]` → `- [X]`
5. git stage impl + test + tasks.md
6. git commit (Conventional Commits)

**Orchestrator drives strict serial** (`parallel: false` everywhere per Ralph-loop traceability). When orchestrator halts: log to `.specify/implement-halts.log`, then retry or hand back to user per halt-handler policy.
