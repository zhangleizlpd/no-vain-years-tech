---
feature_id: 004-account-deletion
spec_ref: ./spec.md
plan_ref: ./plan.md
status: done
created_at: '2026-05-29'
amends: '#198 (server US1-9 + cancel-deletion 屏); p4 子 plan B3'
---

# Tasks (client amend): 004-account-deletion — US10 注销发起屏（A→B→C 链的 B3）

**Spec**: [`spec.md`](./spec.md) § US10 / FR-C01 / FR-C02 / SC-C01 | **Plan**: [`plan.md`](./plan.md) § Client UI Plan | **Branch**: `004-account-deletion-client`

> server US1-9 + cancel-deletion 屏 + FROZEN modal（`tasks.md`，#198）已 ship 不动；本文 = 注销发起屏（delete-account）收口。**纯 mobile，无 server 改**（deletion 端点已就位，Orval 已生成且桶已导出）。

## Format

`- [ ] TD0NN [P?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- 层 = `[Mobile]` / `[Mobile-E2E]`（**纯 mobile**，无 `[Server]` / `[Contract]` —— deletion 5 端点 #198 已 ship，无 server 改、无 regen）
- **TDD（强制）**：纯逻辑（`deleteAccountErrorToast`）+ RHF 状态机（`use-delete-account-form`，renderHook）内联绑 **vitest**（红→绿→typecheck/lint→`[X]`→commit，6 步闭环）；presentational 屏 = typecheck/lint + **Playwright Expo Web e2e**（= US10 Independent Test 验收）
- 无 task-meta JSON（手动模式，per p3 §3）
- **drift guard 注意**：lefthook `tasks-md-drift` 可能只 glob `tasks.md` → 本 `tasks-client.md` 的 `[X]` flip 靠**手动纪律**自守（每 task 同 commit stage 本文件）
- port 源：旧 app `~/Documents/projects/no-vain-years/no-vain-years-app/apps/native/.../delete-account.tsx`；**复用皮重写肉**（视觉 port，state→RHF mirror `use-cancel-deletion-form`）；import remap `@nvy/auth`→`~/auth`、`@nvy/design-tokens`→`~/theme`/className；相对 import extensionless

## Path Conventions

- 屏 route 文件：`apps/mobile/app/(app)/settings/account-security/delete-account.tsx`（presentational 子件 inline）
- app-local 制品：`apps/mobile/src/auth/`（`delete-account.ts` wrapper + `deletion-errors.ts` + `use-delete-account-form.ts` + `delete-account-form.schema.ts`）
- e2e：`apps/mobile/e2e/`（seed-authed via `addInitScript`；mock API `_support/api-mock.ts` `mockJson`，仿 `settings-shell.spec.ts` US3）

---

## Phase 1: Foundational（纯逻辑 + wrapper + 表单 hook）

- [x] TD01 [P] [Mobile] **重写** `deleteAccountErrorToast` → `apps/mobile/src/auth/deletion-errors.ts`（旧 app `delete-account-errors.ts`，for mono `AxiosError`：duck-type `isAxiosError` + `response.status` + `response.data.code`）+ `deletion-errors.spec.ts`（**vitest，先红后绿**）：401 `INVALID_DELETION_CODE`→「验证码错误」/ 429→「操作太频繁，请稍后再试」/ 400→格式（防御）/ ≥500+无 response+`TypeError`→「网络错误，请重试」/ 其余→「发生未知错误」。**一步 toast**（mirror `cancel-deletion-errors`，非 kind+copy）。禁 import `@nvy/api-client` 旧栈错误类型
- [x] TD02 [Mobile] wrapper `apps/mobile/src/auth/delete-account.ts`：`useRequestDeletionCode()` 包 Orval `useAccountDeletionControllerSendDeletionCodeForMe`（void，不导航）+ `useDeleteAccount()` 包 `useAccountDeletionControllerSubmitDeletionForMe`（`{data:{code}}`；**`onSuccess`→`useAuthStore.getState().clearSession()`**，mirror `logout-all`，不导航）。presentational hook 无单测
- [x] TD03 [Mobile] `apps/mobile/src/auth/delete-account-form.schema.ts`（zod `{ code: z.string().regex(/^\d{6}$/) }`）+ `use-delete-account-form.ts`（**RHF mirror `use-cancel-deletion-form`**：form `{code}` + local `confirm1`/`confirm2`/`cooldown`（副作用态，铁律 2）；`bothChecked=confirm1&&confirm2`；`requestSms` gated `bothChecked && cooldown===0` → `useRequestDeletionCode().mutateAsync()` → 启 cooldown + phase=sms_sent；`submit=form.handleSubmit` → `useDeleteAccount().mutateAsync({data:{code}})` → phase=success；`isSubmitting` 单源铁律 3；err→clearError）+ `use-delete-account-form.spec.ts`（**vitest renderHook**，mirror cancel form spec：happy-dom + mock 2 mutation hook；断言 未双勾选 `canSendCode=false` / 双勾选后可发 / 发码进 sms_sent / 提交 success / 码错 error）

## Phase 2: User Story 10 — 注销发起屏（P2）🎯

**Independent Test**（spec US10）：seed authed → 设置 → 账号与安全 → 注销账号 → 屏渲染（≥2 行风险提示）→ 未勾选发码按钮禁用 → 双勾选 → 发码（mock `POST /api/v1/accounts/me/deletion-codes` 204）→ 输 6 位码 → 确认注销（mock `POST /api/v1/accounts/me/deletion` 204）→ 本地会话清空 + 落 `/login`；mock 401 → 统一错误提示。

- [x] TD04 [Mobile] `apps/mobile/app/(app)/settings/account-security/delete-account.tsx`（port 旧 app 视觉，state→`use-delete-account-form`）：3 段（① RISK WarningBlock ≥2 行风险 + 可撤销/不可逆 tag ② CONFIRM 2× CheckboxRow ③ VERIFY SendCodeRow + `~/ui SmsInput`(Controller 包 code) ）+ `~/ui ErrorRow`(text) + SubmitButton（busy=isSubmitting）；inline 子件 token remap（`@nvy/design-tokens`→className/`~/theme`）；成功 `useEffect(state==='success' → router.replace('/(auth)/login'))`（+ wrapper 已 clearSession）。依赖 TD01+TD02+TD03。FR-C01/C02
- [x] TD05 [Mobile] `apps/mobile/app/(app)/settings/account-security/index.tsx`「注销账号」行：006 disabled destructive 占位 → **enabled** + `onPress`→`router.push('/(app)/settings/account-security/delete-account')`（去 006 T006 标的 `// B3 ... 激活` 注释；destructive Row 无 chevron 保留）。FR-C01 集成点
- [x] TD06 [Mobile-E2E] `apps/mobile/e2e/delete-account.spec.ts`（seed authed via `addInitScript`；mock via `_support/api-mock.ts` `mockJson`，仿 settings-shell US3）：① 进屏（经 account-security「注销账号」行）→ 断言 ≥2 行风险提示可见、发码按钮 disabled（未勾选）② 勾选双确认 → 发码按钮 enabled → 点发码（mock `me/deletion-codes` 204）→ 输码态 ③ 输 6 位码 → 确认注销（mock `me/deletion` 204）→ 断言 localStorage 会话清 + 落 `/login` ④ mock `me/deletion` 401 `INVALID_DELETION_CODE` → 统一错误提示「验证码错误」、留屏。locator 优先 `getByRole`/accessibilityLabel。SC-C01

## Phase 3: Polish & Verify

- [x] TD07 [Verify] 全量验收：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（含 `runtime-smoke`）+ `delete-account.spec.ts` 全段绿 + grep 断言：无 `@nvy/auth`/`@nvy/design-tokens` 残留 import、无 `.js` 扩展相对 import、无裸 `axios`/`fetch` 业务直调。spec/plan/tasks frontmatter `status` → `implemented`/`done`。**catalog 无需改**（无 server / 无新 operation）

---

## Dependencies & Story Completion Order

```text
Phase 1 Foundational
  TD01 (deletion-errors ∥)
  TD02 (delete-account wrapper)
  TD03 (use-delete-account-form, RHF) ←── TD02
        │
        ▼
Phase 2 US10
  TD04 (delete-account 屏) ←── TD01 + TD02 + TD03
  TD05 (account-security 注销行 flip)
  TD06 (e2e) ←── TD04 + TD05
        │
        ▼
Phase 3  TD07 (verify)
```

- **并行机会**：TD01 ∥ TD02（不同文件）。
- **集成点**：TD05 一行 flip（006 disabled→真 push）= A→B3 链打通、p4 全链闭合。
- **关键 E2E** = TD06（US10 全程）—— 注销发起对用户可见的最高价值断言。

## Implementation Strategy

1. **Foundational**：TD01（错误映射 vitest）∥ TD02（wrapper）→ TD03（RHF 表单 hook + renderHook vitest）。
2. **US10 屏**：TD04 屏（port 视觉 + RHF）→ TD05 flip → TD06 e2e。
3. Phase 3 全量 gate 后单 PR ship（纯 mobile）。
4. **p4 graduation**：B3 ship 后 A→B→C 链全闭（002 ⚙️ → settings → 账号与安全 → 登录管理[B2] + 注销账号[B3]）。

预估 7 task（3 foundational + 2 US10 屏 + 1 e2e + 1 verify）；纯 mobile、无 server/contract/新依赖。复杂度低于 B2（无 server 改、无独立组件文件、无 cache-read 详情）。
