---
feature_id: 006-account-settings-shell
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-29'
---

# Tasks: 006-account-settings-shell（设置 / 账号与安全 导航壳 — A→B→C 链的 B）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `006-account-settings-shell`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Foundational / Polish 不带
- 层 = `[Mobile]` / `[Mobile-E2E]`（**纯 mobile feature**，无 `[Server]` / `[Contract]` —— 无 server 改、无新端点、无 api-client regen，per plan）
- **TDD（强制）**：纯逻辑（`maskPhone`）内联绑 **vitest** 单测（红→绿→typecheck/lint→`[X]`→commit，6 步闭环，per `.claude/rules/implement-task-closure.md`）；presentational primitives / 屏 = typecheck/lint + **Playwright Expo Web e2e**（= 每 US 的 Independent Test 验收，per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（手动模式，per p3 §3）
- **无 Setup phase**（零依赖安装）；token 已实证不缺（plan D2 resolved，className 原样解析）
- port 源：旧 app `~/Documents/projects/no-vain-years/no-vain-years-app/apps/native/`；import remap `@nvy/auth`→`~/auth`、`@nvy/design-tokens`→`~/theme`；相对 import **extensionless**（Metro web 陷阱，ESLint 已拦）

## Path Conventions

- 屏：`apps/mobile/app/(app)/settings/`（Expo Router，落 `(tabs)` 之外 → 底 tab 自动隐藏，per 002 CL-006）
- app-local 制品：`apps/mobile/src/settings/`（primitives，**不进 `~/ui`**）/ `apps/mobile/src/format/`（maskPhone）
- e2e：`apps/mobile/e2e/`（seed-authed 走 `page.addInitScript` + localStorage zustand-persist key，仿 `profile.spec.ts`；mock API 用 `_support/api-mock.ts` `mockJson`）

---

## Phase 1: Foundational（阻塞所有 US — 复用基件）

- [X] T001 [P] [Mobile] port `maskPhone` 到 `apps/mobile/src/format/phone.ts`（旧 app `lib/format/phone.ts`：国码白名单 longest-prefix `['+852','+886','+86','+44','+81','+82','+1','+7']` → `<国码> <前3>****<后4>`，中段星号 ≥4；`null`/空/越界/国码不匹配/非数字 → `未绑定`）+ `phone.spec.ts`（**vitest，先红后绿**）：`+8613900139000`→`+86 139****9000` / `+86138...` 不误切 `+861`（longest-prefix）/ `null`/`''`→`未绑定` / 短号（<7 位）→`未绑定` / 非数字→`未绑定` / 中段 ≥4 星。锚定 plan D6
- [X] T002 [P] [Mobile] port list-card primitives 到 `apps/mobile/src/settings/primitives.tsx`（旧 app `components/settings/primitives.tsx`：`Card` 圆角卡片容器 / `Row`（props `label`/`value?`/`disabled?`/`destructive?`/`showChevron?`/`align?`/`busy?`/`onPress?`）/ `Divider`）—— `@nvy/design-tokens`→`~/theme`，className 原样（plan D2 已证 `surface-sunken`/`accent`/`ink`/`line` 全在 mono `~/theme` + `tailwind.config.ts colors:tokens.colors`）。**app-local，不进 `~/ui`**（占位 UI 4 边界）。presentational 无单测，靠 typecheck/lint + 下游 e2e

## Phase 2: User Story 1 — 进入设置壳 + 底 tab 隐藏（P1）🎯 MVP

**Independent Test**（spec US1）：seed authed → profile 点 ⚙️ → URL 进 `/(app)/settings`、卡片渲染、**底 tab bar 不可见** → 系统返回 → 回 profile、底 tab 恢复；002 ⚙️ 进真实页（不依赖 Expo Router 容错）。

- [X] T003 [US1] [Mobile] `apps/mobile/app/(app)/settings/_layout.tsx`（port 旧 app：`<Stack screenOptions headerShown>`，`index` title「设置」，`account-security` `headerShown:false`（嵌套自带 header）；**删 `legal` Stack.Screen**）+ `apps/mobile/app/(app)/settings/index.tsx`（port：ScrollView + 3 Card —— ① 账号与安全 Row→`router.push('/(app)/settings/account-security')` ② 通用/通知/隐私/关于 disabled ③ 切换账号 disabled + 退出登录 destructive busy→`confirmLogout`；**删法务页脚**；`@nvy/auth`→`~/auth`(`logoutAll`)；`confirmLogout` Platform 分支（Web `window.confirm` / native `Alert.alert`）**原样保留**（RN-Web Alert 单按钮 fallback 陷阱，load-bearing）；登出后 `logoutAll()` + 显式 `router.replace('/(auth)/login')` 双保险，plan D3）。**含 US3 登出 handler（同文件）**
- [X] T004 [US1] [Mobile] `apps/mobile/app/(app)/(tabs)/profile.tsx` 去 ⚙️ 的 `router.push('/(app)/settings' as Parameters<...>)` 强转（route 已建，FR-C02）+ 全仓 grep 确认无残留 `as Parameters<typeof router.push>` 占位强转
- [X] T005 [US1] [Mobile-E2E] `apps/mobile/e2e/settings-shell.spec.ts` US1 段（seed authed via `addInitScript`）：profile 点 ⚙️（`getByRole`/accessibilityLabel）→ 断言进 `/(app)/settings`、设置卡片渲染（账号与安全 / 退出登录 可见）、**底 tab bar 不可见** → 系统返回 → 回 profile、底 tab 恢复。locator 优先 `getByRole`/`exact`，警惕中文子串撞

## Phase 3: User Story 2 — 账号与安全导航 + 手机号脱敏 + disabled 占位（P1）

**Independent Test**（spec US2）：seed authed（store `phone=+8613900139000`）→ 进设置 → 点账号与安全 → URL 进二级页、手机号行显 `+86 139****9000`（无完整号）、登录管理/注销账号行 disabled 不导航。

- [X] T006 [US2] [Mobile] `apps/mobile/app/(app)/settings/account-security/_layout.tsx`（port：`<Stack>`，`index` title「账号与安全」；**只留 index Stack.Screen**，phone/delete-account/login-management 不建）+ `apps/mobile/app/(app)/settings/account-security/index.tsx`（port：ScrollView + 3 Card —— ① 手机号 Row value=`maskPhone(phone)`（`~/format/phone`）**disabled** + 实名认证 disabled + 第三方账号绑定 disabled ② **登录管理 Row disabled 占位**（加注释 `// B2 (device-management amend 005) 激活：去 disabled + onPress → push login-management`）③ 注销账号 Row destructive **disabled 占位**（加注释 `// B3 (account-deletion settings 入口 amend 004) 激活`）+ 安全小知识 disabled；`@nvy/auth`→`~/auth`(`useAuthStore` 读 `phone`)）
- [X] T007 [US2] [Mobile-E2E] `settings-shell.spec.ts` US2 段：seed authed（`phone=+8613900139000`）→ 设置 → 点账号与安全 → 断言进 `/(app)/settings/account-security`、手机号行文本含 `139****9000` 且 **不含 `13900139000` 完整号**、登录管理 & 注销账号行 `disabled`（点击不改变 URL）

## Phase 4: User Story 3 — 退出登录（P1）

**Independent Test**（spec US3）：seed authed → 设置 → 退出登录 →（web）`window.confirm` 确认 → mock `POST /accounts/logout-all` 204 → 会话清、落 `/(auth)/login`；mock 500 → 仍登出落登录页；取消 → 留页保持登录。

> 登出 UI + handler 已在 T003（`settings/index.tsx`，同文件）落地；本 phase = 其独立 e2e 验收。

- [X] T008 [US3] [Mobile-E2E] `settings-shell.spec.ts` US3 段（mock `_support/api-mock.ts` `mockJson` logout-all）：① 点退出登录 →（web 覆写 `window.confirm`→true）→ mock `POST /api/v1/accounts/logout-all` 204 → 断言 localStorage 会话清 + 落 `/(auth)/login` ② mock logout-all 500 → 仍落登录页（本地登出）③ `window.confirm`→false（取消）→ 留设置页、保持登录态

## Phase 5: Polish & Verify（跨 cutting）

- [X] T009 [Mobile] 全量验收：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**含 `runtime-smoke`** —— mobile web export 路径靠它 + e2e 抓，per ADR-0040）+ `settings-shell.spec.ts` 全 3 US 段绿 + grep 确认无 `@nvy/auth`/`@nvy/design-tokens` 残留 import、无 `.js` 扩展相对 import、无 `as Parameters<...>` 残留强转

---

## Dependencies & Story Completion Order

```text
Phase 1 Foundational (T001 maskPhone ∥ T002 primitives)
        │
        ├─► US1 (T003 shell+_layout+index ∥后 T004 ⚙️解锁 → T005 e2e)   🎯 MVP — 解锁 002 ⚙️
        │       │ (T003 settings/index 同时落 US3 登出 handler)
        │       ▼
        ├─► US2 (T006 account-security → T007 e2e)   依赖 T002 primitives + T001 maskPhone
        │
        └─► US3 (T008 logout e2e)   依赖 T003（登出 handler 已在其中）
                        │
                        ▼
              Phase 5 Verify (T009)
```

- **US1 = MVP**：壳骨架 + ⚙️ 解锁，独立可交付（即便 US2/US3 未做，⚙️ 进设置首页 + 登出已通）。
- **US2/US3 互不依赖**：US2 依赖 foundational（primitives+maskPhone）；US3 e2e 依赖 T003。
- **并行机会**：T001 ∥ T002（不同文件）；US2（T006）可与 US3 e2e（T008）并行（T003 完成后）。

## Implementation Strategy

1. **MVP first**：Phase 1 + US1（T001-T005）→ ⚙️ 进真实设置壳 + 登出可用 = 解锁 002、闭合 A→B 链最小价值。
2. 增量补 US2（账号与安全二级页 + 脱敏 + 延后激活占位）+ US3 登出 e2e。
3. Phase 5 全量 gate（含 runtime-smoke + e2e）后单 PR ship。
4. **后续**：B2(device-management amend 005) / B3(account-deletion settings 入口 amend 004) 各自把 account-security index 的 disabled 占位行 flip 为真实 push（T006 注释已标激活点）。

预估 9 task（2 foundational + 3 US1 + 2 US2 + 1 US3 + 1 verify）；纯 mobile、无 server/contract/新依赖。
