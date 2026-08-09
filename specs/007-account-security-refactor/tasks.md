---
feature_id: 007-account-security-refactor
spec_ref: ./spec.md
plan_ref: ./plan.md
status: done
created_at: '2026-05-30'
---

# Tasks: 007-account-security-refactor（账号与安全页级重构 + 个人简介 bio 编辑）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `007-account-security-refactor`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Foundational / Polish 不带
- 层 = `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]`（本 feature 含 server bio 字段 + 端点 + api-client regen + mobile 重构/编辑页）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：server = Testcontainers IT 红→绿（`nx test server` cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；mobile 纯逻辑（bio 校验若抽 rules）= vitest helper-level；屏/编辑页/重构 = typecheck/lint + **Playwright Expo Web e2e**（= 每 US Independent Test 验收，per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004/006 + orchestrator 暂不用）
- **无 Setup phase**（无新依赖安装；RHF+zod 既有）
- Metro 相对 import **extensionless**（ESLint 已拦，per memory `metro_web_cannot_resolve_js_extension_imports`）

## Path Conventions

- server：`apps/server/src/account/`（**扁平平铺**，无 domain/application/infra 子目录，per ADR-0043）；schema `apps/server/prisma/schema.prisma`；IT `*.it.spec.ts`
- 契约：`apps/server/openapi.json`（`nx run server:export-openapi`）→ `packages/api-client`（`nx affected -t generate`）
- mobile 屏：`apps/mobile/app/(app)/settings/account-security/`（Expo Router，复用 006 落地）
- mobile app-local：`~/settings/primitives`（Card/Row/Divider，复用 006）/ `~/format/phone`（maskPhone，复用 006）
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + zustand-persist `nvy-auth`；mock API `_support/api-mock.ts` `mockJson`，仿 `settings-shell.spec.ts`）

---

## Phase 1: Foundational — server bio 字段 + 端点 + 契约（阻塞 US2 mobile）

- [X] T001 [Server] `apps/server/prisma/schema.prisma` Account 加 `bio String? @map("bio") @db.VarChar(120)`（可空，`@map` 对齐既有 `displayName @map("display_name")`）→ `nx run server:prisma-migrate`（dev，纯加可空列 = 安全 expand 无 contract 阶段，per ADR-0035）+ `prisma generate`
- [X] T002 [Server] bio 更新端点（先红后绿 IT）：`apps/server/src/account/update-bio.usecase.ts`（镜像 `update-display-name.usecase.ts`，直注 `PrismaService` → `account.update({where:{id},data:{bio}})`，anemic row，**零-class**）+ `update-bio.request.ts`（`UpdateBioRequest`，**注意非 `@IsNotEmpty`** —— 允许清空）+ `account.rules.ts` 加 bio 校验纯函数（≤120 code points、trim、拒控制字符、允许 emoji、允许空，镜像 displayName 口径但上限 120）+ controller `PATCH /api/v1/accounts/me/bio`（bearer，复用既有 authed 守卫 + per-account 限流）。IT（`*.it.spec.ts`）覆盖 spec `bio-edit` 分支 + SC-002：合法 bio→200+持久化、超 120→400、控制字符→400、空串→清空 200、缺 token→401。**禁 lifecycle mock**（复用既有守卫，无新 Guard）
- [X] T003 [Server] GET /me 扩 bio（IT 红→绿）：`get-account-profile.usecase.ts` select `bio` + `account-profile.response.ts` `AccountProfileResponse` 加 `@ApiProperty bio: string | null`（nullable）；IT 断言已设 bio 账号 GET /me 回读 bio、未设为 null（FR-S06）
- [X] T004 [Contract] `nx run server:export-openapi`（产 `apps/server/openapi.json` 含 EP1 扩字段 + EP2）→ `pnpm nx affected -t generate --base=origin/main`（`packages/api-client` regen）→ 确认 mobile 可 import typed bio hook（`useAccountProfileControllerUpdateBioForMe` 类）（Constitution V，server+regen+mobile 同 PR）

## Phase 2: User Story 1 — 三卡片重构 + 删冗余行（P1）🎯 MVP

**Independent Test**（spec US1）：seed authed → 进 `/(app)/settings/account-security` → 行集 = {资料: 头像/昵称/个人简介/性别/主页背景图, 绑定: 手机号/邮箱/微信/google, 安全卡: 登录管理, 注销账号独立卡片}；实名认证/第三方账号绑定/二维码名片/安全小知识不在 DOM。

- [X] T005 [US1] [Mobile] 重构 `apps/mobile/app/(app)/settings/account-security/index.tsx` 为 3 张 `Card`（复用 `~/settings/primitives`，不抽新组件）：① 资料卡（头像 disabled / 昵称 `value`=store `displayName` disabled / 个人简介 active `onPress`→`router.push('.../account-security/bio-edit')` / 性别 disabled / 主页背景图 disabled；**删二维码**）② 身份/绑定卡（手机号 `value`=`maskPhone(phone)` disabled / 邮箱 / 微信 / google，全 disabled）③ 安全卡（仅登录管理 active→`login-management`）+ 注销账号独立卡片（destructive `showChevron={false}` `align="center"`→`delete-account`，同「退出登录」风格）；**删旧「实名认证」「第三方账号绑定」行 + 不渲染「安全小知识」**；头部加 `// PHASE 1 PLACEHOLDER — business flow validated; visuals pending mockup.`（占位行部分）。**本 task 含 US2/US4/US5 行结构（同文件）**
- [X] T006 [US1] [Mobile-E2E] `apps/mobile/e2e/account-security-refactor.spec.ts` US1 段（seed authed）：进账号与安全 → 断言渲染 3 卡片、资料卡含且仅含 头像/昵称/个人简介/性别/主页背景图 5 行、且「实名认证」「第三方账号绑定」「二维码名片」**不在 DOM**
- [X] T007 [US1] [Mobile-E2E] **更新 006 回归**（plan D5）：`apps/mobile/e2e/settings-shell.spec.ts` US2 段旧断言（手机号/实名/第三方/登录管理/注销账号 扁平行）→ 改为新三卡片行集断言（重构改了它断言的 account-security 页，不改则 006 e2e 红）

## Phase 3: User Story 3 — 身份卡脱敏 + 微信/google 占位（P1）

**Independent Test**（spec US3）：seed authed（`phone=+8613900139000`）→ 进账号与安全 → 手机号行显 `+86 139****9000`（无完整号）、邮箱/微信/google disabled 不导航。

- [X] T008 [US3] [Mobile-E2E] `account-security-refactor.spec.ts` US3 段：手机号行文本含 `139****9000` 且**不含 `13900139000`**；邮箱/微信/google 行 `disabled`，点击微信/google URL 不变、无 page error（FR-C05/C06/C07）

## Phase 4: User Story 2 — 个人简介编辑（P1）

**Independent Test**（spec US2 个人简介编辑；server IT 见 T002/T003）：点个人简介 → 编辑页预填当前 bio、`N/120` 实时、保存→mock PATCH 200→返回；超 120 拦截；server IT 见 T002/T003。

- [X] T009 [US2] [Mobile] `apps/mobile/app/(app)/settings/account-security/bio-edit.tsx`（标题「个人简介」+ 返回 + 右上「保存」；`TextInput` multiline 占位「介绍自己的投资经验、风格或领域」预填当前 bio；实时 `N/120`；示例「例如：美股研究员/新股专家/量化交易员」）+ `account-security/_layout.tsx` 注册 `Stack.Screen`（title「个人简介」）。**RHF + zodResolver 4 铁律**（`<Controller>` 包 TextInput 非 register / 表单态≠副作用态 / `isSubmitting` 单源 / 错误+a11y）；zod `z.string().max(120)` + 计数 UI 先行拦截；进页 GET /me 取 bio 预填、保存调 EP2 typed hook → 成功 invalidate `/me` → `router.back()`（plan D7）。Orval 函数式 hook（非 class）
- [X] T010 [US2] [Mobile-E2E] `account-security-refactor.spec.ts` US2 段：点个人简介 → 进 bio-edit、textarea 预填（mock GET /me 含 bio）、输入字数计数更新 → 点保存（mock `PATCH /me/bio` 200）→ 返回账号与安全页；输入超 120 → 保存禁用/拦截

## Phase 5: User Story 4 — 资料占位 + 昵称真实值（P2）

**Independent Test**（spec US4）：seed authed（`displayName=小明`）→ 昵称行显「小明」disabled、头像/性别/背景图 disabled 占位不导航。

- [X] T011 [US4] [Mobile-E2E] `account-security-refactor.spec.ts` US4 段：昵称行右侧含真实 `displayName`（seed 小明）且 disabled；头像/性别/主页背景图行 disabled，点击 URL 不变无 crash

## Phase 6: User Story 5 — 安全卡现有功能不回归（P1）

**Independent Test**（spec US5）：seed authed → 点登录管理→设备列表、注销账号（独立居中卡片）→短信注销发起。

- [X] T012 [US5] [Mobile-E2E] `account-security-refactor.spec.ts` US5 段：点登录管理 → push 设备列表 route（005 不回归）；返回点注销账号（独立居中 destructive 卡片）→ push 短信验证码注销发起页（004 不回归）

## Phase 7: Polish & Verify

- [X] T013 [Verify] `pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `runtime-smoke` mobile web export + `generate` 契约链）+ server bio IT 绿（`nx test server`）+ web e2e 全绿（新 account-security-refactor + 改后 settings-shell）；全仓 grep 确认无「实名认证/第三方账号绑定/二维码名片」残留引用 + 未引入 `expo-image-picker` / 对象存储 / 图片上传依赖（FR-C13/SC-006，由 build/typecheck 兜底）

---

## Dependencies & 完成顺序

1. **Phase 1（T001-T004）= 阻塞前置**：bio 字段 + 端点 + 契约 regen，US2 mobile 编辑页（T009）依赖 T004 的 typed hook。
2. **Phase 2（T005）= mobile 重构基座**：US3/US4/US5 的 e2e（T008/T011/T012）断言此 task 产出的页面；US2 的个人简介 active 入口（push bio-edit）也在 T005，目标页 T009。
3. **T007（006 回归）** 必须与 T005 同 PR（重构即破坏 006 旧断言）。
4. **T013 Verify** 最后跑全 affected。

**并行机会**：T001-T003（server）与 T005（mobile 重构）跨栈可并行（不同 workspace）；e2e 任务（T006/T008/T011/T012）共用一个 spec 文件、按 US 分段，建议同一开发顺序追加。

## MVP 范围

**最小可交付** = Phase 1（server bio）+ Phase 2（US1 三卡片重构 + 删行 + 006 回归）+ Phase 4（US2 bio 编辑）。US3/US4/US5 为同页 e2e 断言增量，随 T005 产出即可验。

**预估**：13 tasks（server 3 + contract 1 + mobile 重构 1 + bio 编辑 1 + e2e 5 + verify 1）。主风险 = 006 e2e 回归（T007）+ bio「允许清空」vs displayName NotEmpty（T002）+ 契约 regen 同步链（T004）。
