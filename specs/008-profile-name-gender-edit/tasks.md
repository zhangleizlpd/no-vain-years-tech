---
feature_id: 008-profile-name-gender-edit
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-30'
---

# Tasks: 008-profile-name-gender-edit（资料编辑 —— 昵称修改 + 性别设置 + 资料卡行重排）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `008-profile-name-gender-edit`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Foundational / Polish 不带
- 层 = `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]`（本 feature 含 server gender 字段 + 端点 + api-client regen + mobile 两编辑屏 + 资料卡重排）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：server = Testcontainers IT + 单元 spec 红→绿（`nx test server` cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；mobile 纯逻辑（`normalizeGender` / form hook）= vitest helper-level；屏/编辑页/重排 = typecheck/lint + **Playwright Expo Web e2e**（= 每 US Independent Test 验收，per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004/006/007 + orchestrator 暂不用）
- **无 Setup phase**（无新依赖安装；RHF+zod / 既有 throttler / 既有 authed 守卫均就位）
- Metro 相对 import **extensionless**（ESLint 已拦，per memory `metro_web_cannot_resolve_js_extension_imports`）

## Path Conventions

- server：`apps/server/src/account/`（**扁平平铺**，无 domain/application/infra 子目录，per ADR-0043）；schema `apps/server/prisma/schema.prisma`；IT `*.it.spec.ts`
- 契约：`apps/server/openapi.json`（`nx run server:export-openapi`）→ `packages/api-client`（`nx affected -t generate`）
- mobile 屏：`apps/mobile/app/(app)/settings/account-security/`（Expo Router，复用 006/007 落地）
- mobile app-local：`~/settings/primitives`（Card/Row/Divider，复用 006）/ `~/settings/gender.ts`（本 feature 新）/ `~/auth` `displayNameSchema`（复用）/ `~/core/api/use-me`（复用）/ `~/auth/store`（昵称同步）
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + zustand-persist `nvy-auth`；mock API `_support/api-mock.ts` `mockJson`，仿 `account-security-refactor.spec.ts`）

---

## Phase 1: Foundational — server gender 字段 + 端点 + 契约 + 标签映射（阻塞 US1 / US3 mobile）

- [X] T001 [Server] `apps/server/prisma/schema.prisma` Account 加 `gender String? @map("gender") @db.VarChar(16)`（可空，存英文 enum 字符串，**镜像既有 `status String @db.VarChar(16)` —— 不引入 native Prisma `enum`**，plan D2）→ `nx run server:prisma-migrate`（dev，纯加可空列 = 安全 expand 无 contract 阶段，per ADR-0035）+ `prisma generate`
- [X] T002 [P] [Server] `apps/server/src/account/account.rules.ts` 加 `export enum Gender { MALE/FEMALE/NON_BINARY/PRIVATE }`（镜像 `AccountStatus`）+ `normalizeGender(raw: string | null): Gender | null` 纯函数（null/空串→null 清空、合法 4 枚举之一→返回、其余抛 `INVALID_GENDER`，**零-class**，plan D2）→ `account.rules.spec.ts` 红→绿（4 枚举各通过 / null + 空串 → null / 非法值抛 INVALID_GENDER）
- [X] T003 [Server] gender 更新端点（先红后绿 IT）：`apps/server/src/account/update-gender.usecase.ts`（镜像 `update-bio.usecase.ts`：直注 `PrismaService` → findUnique → phone-null 视 not-found → `normalizeGender` 抛 `BadRequestException('INVALID_GENDER')` → `isActive` 纵深防御 → `account.update({where:{id},data:{gender}})`，anemic row 返回，**零-class**）+ `update-gender.request.ts`（`UpdateGenderRequest`：`@ApiProperty({enum:Gender,nullable:true})` + `@IsOptional() @IsEnum(Gender)` 的 `gender: Gender | null`）+ controller `account-profile.controller.ts` 注入 `UpdateGenderUseCase` + `@Patch('me/gender')`（镜像 `@Patch('me/bio')` 的 `@SkipThrottle` + `@Throttle({'me-patch':{10,60_000}})` + `@ApiResponse` 200/400/401/429）。`update-gender.usecase.spec.ts`（单元 mock prisma：4 枚举持久化 / 非法抛 / null 清空 / not-found / not-active）+ `*.it.spec.ts` Testcontainers 覆盖 spec `gender-server` 分支 + SC-001：合法 gender→200+持久化、非法值→400、null→清空 200、缺 token→401。**限流（FR-S05）复用既有共享 `me-patch` bucket（10/60s per-account，002/007 已覆盖 429 路径），本端口不重测 429**，仅声明 `@Throttle` 装饰器在位（analyze F1）。**禁 lifecycle mock**（复用既有 authed 守卫，无新 Guard）
- [X] T004 [Server] GET /me 扩 gender（IT 红→绿）：`get-account-profile.usecase.ts` select `gender`（扩 `*Result` 接口）+ `account-profile.response.ts` `AccountProfileResponse` 加 `@ApiProperty({enum:Gender,nullable:true}) gender: Gender | null` + controller 各 `return {...}`（getProfile / updateDisplayName / updateBio / updateGender）补 `gender: result.gender`；IT 断言已设 gender 账号 GET /me 回读、未设为 null（FR-S06）
- [X] T005 [Contract] `nx run server:export-openapi`（产 `apps/server/openapi.json` 含 EP1 扩字段 + EP2）→ `pnpm nx affected -t generate --base=origin/main`（`packages/api-client` regen）→ 确认 mobile 可 import typed `Gender` + `useAccountProfileControllerUpdateGender` 类 hook（Constitution V，server+regen+mobile 同 PR）
- [X] T006 [P] [Mobile] `apps/mobile/src/settings/gender.ts`：`GENDER_OPTIONS`（有序 `['MALE','FEMALE','NON_BINARY','PRIVATE']`）+ `GENDER_LABELS`（`MALE→男 / FEMALE→女 / NON_BINARY→非二元 / PRIVATE→保密`）+ `genderLabel(g: string | null): string`（null→''）；`Gender` 类型从 `@nvy/api-client` 取（依赖 T005 regen）。资料卡行 + 性别屏共用单一真相源（FR-C07，plan D8）

## Phase 2: User Story 2 — 昵称编辑（P1）

**Independent Test**（spec US2，纯 mobile 复用 002）：seed authed → 点资料卡「昵称」→ 进设置昵称屏、预填当前 displayName、`N/32` 实时；改输入点「保存」→ mock `PATCH /me {displayName}` 200 → 返回账号与安全页、资料卡显新值；超 32 / 空 → 「保存」禁用。

- [X] T007 [P] [US2] [Mobile] `apps/mobile/src/settings/use-name-edit-form.ts`（镜像 `use-bio-edit-form.ts`）：`useForm` resolver = `z.object({ displayName: displayNameSchema })`（**复用 `~/auth` 导出的 `displayNameSchema`**，1–32 / NotEmpty / 拒控制字符，plan D7）；mutation 用 `useAccountProfileControllerUpdateDisplayName`（002，**0 server 改动**）；success → invalidate `/me` + **同步 `useAuthStore` 的 `displayName`**（资料卡昵称读 store，必须刷新，plan D7/D11）+ `setPhase('success')`；`nameEditErrorToast`（400/429/network/unknown 映射，镜像 bio）。`use-name-edit-form.spec.ts` vitest 红→绿（submit 成功路径 / 错误映射 / store 同步调用）
- [X] T008 [US2] [Mobile] `apps/mobile/app/(app)/settings/account-security/name-edit.tsx`（镜像 `bio-edit.tsx` 骨架）：`useMe()` 预填 → `<Controller>` 包单行 `TextInput`（预填 displayName、右侧「×」清空、`N/32` 实时、超 32 标 text-err）→ 右上「保存」`saveDisabled = !formState.isValid || submitting`（`isSubmitting` 单源，铁律 3）→ success `useEffect` `router.back()`；标题「设置昵称」。`_layout.tsx` 注册 `<Stack.Screen name="name-edit" options={{ title: '设置昵称' }} />`。**RHF 4 铁律**（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）
- [X] T009 [US2] [Mobile-E2E] `apps/mobile/e2e/profile-name-gender-edit.spec.ts` US2 段（seed authed + mock GET /me 含 displayName + mock `PATCH /me`）：点「昵称」→ 进设置昵称屏（`getByRole` 收窄避叠屏双命中，per memory `playwright_expo_stacked_screen_locator_collision`）、输入预填当前值、字数随输入更新 → 改输入点「保存」→ mock 200 → 返回账号与安全 + 资料卡昵称显新值；输入超 32 → 「保存」disabled

## Phase 3: User Story 1 — 性别设置（P1）

**Independent Test**（spec US1；server IT 见 T003/T004）：seed authed → 点资料卡「性别」→ 进设置性别屏、4 选项可见、当前值打勾 → 点「女」→ mock `PATCH /me/gender` 200 → 自动返回账号与安全页（无保存按钮）、资料卡「性别」行显「女」；再次进屏预选「女」。

- [X] T010 [P] [US1] [Mobile] `apps/mobile/src/settings/use-gender-edit.ts`（**非 RHF**，plan D6）：`useAccountProfileControllerUpdateGender` mutation + `useMe()` 读当前 gender 预选 + `select(g: Gender)` → `mutateAsync({ data:{ gender:g } })` → invalidate `/me` → `setPhase('success')`；in-flight 行 disabled 防重复点（幂等：同值再存 200，spec Edge Case）；`genderEditErrorToast`（镜像 bio 错误映射）。`use-gender-edit.spec.ts` vitest 红→绿（select 成功 / 错误映射 / in-flight 锁）
- [X] T011 [US1] [Mobile] `apps/mobile/app/(app)/settings/account-security/gender-edit.tsx`：标题「设置性别」+ 返回，**无右上保存按钮**；`useMe()` 就绪后渲染 `Card`（复用 `~/settings/primitives` `Card`/`Divider`）内 4 选项行（`GENDER_OPTIONS` map，左对齐 `GENDER_LABELS[g]` 文字 + 当前 gender 行右侧 **brand-500 对勾** —— 对勾行**就地自建**不改 `primitives.tsx`/不抽 `~/ui`，plan D10）；点行 → `select(g)`；**仅 `phase==='success'` 时 `useEffect` `router.back()`；PATCH 失败（网络/429/400）→ 留在本屏 + 渲染 `genderEditErrorToast`、不返回**（tap-to-select 无保存按钮的错误态，analyze F2）；hook 不导航。`_layout.tsx` 注册 `<Stack.Screen name="gender-edit" options={{ title: '设置性别' }} />`
- [X] T012 [US1] [Mobile-E2E] `profile-name-gender-edit.spec.ts` US1 段（seed authed + mock GET /me 含 gender + mock `PATCH /me/gender`）：点「性别」→ 进设置性别屏、4 行（男/女/非二元/保密）可见、当前值行打勾（`getByRole` scope 避叠屏）；点「女」→ mock 200 → **自动返回**账号与安全（无 save 按钮交互）+ 资料卡「性别」行显「女」；mock GET /me 返 FEMALE 再进屏 → 「女」行预先打勾

## Phase 4: User Story 3 — 资料卡行重排 + 昵称/性别翻 active（P1）🎯 结构基座

**Independent Test**（spec US3）：seed authed → 进账号与安全 → 资料卡行序 = 头像/昵称/性别/个人简介/主页背景图（个人简介↔性别已对换）；昵称/性别/个人简介 active，头像/主页背景图 disabled 占位点击无导航无 crash。

- [X] T013 [US3] [Mobile] 重排 `apps/mobile/app/(app)/settings/account-security/index.tsx` 资料卡 5 行新序 = 头像（disabled）/ **昵称**（active，`value`=store `displayName`，`onPress`→`router.push('.../account-security/name-edit')`）/ **性别**（active，`value`=`genderLabel(profile.gender)` 读 `useMe()`，`onPress`→`router.push('.../account-security/gender-edit')`）/ **个人简介**（active，007 既有→`bio-edit`）/ 主页背景图（disabled）；**个人简介↔性别对换**（FR-C01）。身份/绑定卡 + 安全卡 + 注销卡片**不动**（007 现状）；头部 PHASE 1 banner 保留（占位行部分）
- [X] T014 [US3] [Mobile-E2E] **更新 007 回归（plan D5）** + 新增 US3 段：`apps/mobile/e2e/account-security-refactor.spec.ts` —— ① 行序断言（L89 附近）`['头像','昵称','个人简介','性别','主页背景图']` → 改 `['头像','昵称','性别','个人简介','主页背景图']`；② US4 段（L183/L193-198）「昵称/性别 disabled 占位」→ 性别已 active：从 `tap({force:true})` 验无导航改为 `tap()` → 进设置性别屏；昵称同理翻 active 入口；头像/主页背景图仍 disabled 占位断言保留。+ `profile-name-gender-edit.spec.ts` US3 段：逐行断言新序 + 昵称/性别/个人简介 active、头像/主页背景图 disabled 占位 `tap({force:true})` URL 不变无 crash

## Phase 5: Polish & Verify

- [X] T015 [Verify] `pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `runtime-smoke` mobile web export + `generate` 契约链；本地跑前先杀 `:3000` 父进程 per memory `nx_serve_respawns_3000_poisons_seed_e2e`）+ server gender IT 绿（`nx test server` cwd=apps/server）+ web e2e 全绿（新 profile-name-gender-edit + 改后 account-security-refactor）；全仓 grep 确认未引入 `expo-image-picker` / 对象存储 / 图片上传依赖 + server diff 仅 `gender`（无对象存储 / 无 schema 其他改动 / 无跨 context import，SC-005）+ 昵称编辑 0 server 改动

---

## Dependencies & 完成顺序

1. **Phase 1（T001-T006）= 阻塞前置**：gender 字段 + 端点 + 契约 regen（T005）+ 标签映射（T006）。US1 mobile（T010-T012）依赖 T005 的 typed `useAccountProfileControllerUpdateGender` + T006 `genderLabel`；US3（T013）的「性别」value 依赖 T006。
2. **Phase 2 US2（T007-T009）= 纯 mobile 复用 002**：不依赖 Phase 1 server（昵称走既有 002 端点）；但 `name-edit.tsx`（T008）是 T013/T014 的导航目标，须先于 US3 e2e。
3. **Phase 3 US1（T010-T012）**：依赖 T005 + T006；`gender-edit.tsx`（T011）是 T013/T014 的导航目标。
4. **Phase 4 US3（T013-T014）= 结构基座收口**：把昵称/性别行 wire 到 T008/T011 两屏 → 须在两屏存在后；T014 含 **007 e2e 回归必改**（重排即破坏 007 旧断言，不改则 007 e2e 红）。
5. **T015 Verify** 最后跑全 affected。

**并行机会**：T002 / T006（rules、label map）与各自前序不冲突可 `[P]`；T007（name form hook）与 T010（gender hook）跨 US 不同文件可并行；server（T001-T004）与 mobile US2（T007-T009，复用 002 无 server 依赖）跨栈可并行。e2e 任务（T009/T012/T014）部分共用 spec 文件，按 US 分段顺序追加。

## MVP 范围

**最小可交付** = Phase 1（server gender + 契约 + label）+ Phase 3（US1 性别设置屏，唯一带后端写入的新能力）+ Phase 4（US3 资料卡重排 + 007 回归）。US2 昵称编辑为并行 P1（复用 002，0 server 改动），可同批或紧随。

**预估**：15 tasks（server gender 4 + contract 1 + label 1 + US2 mobile 3 + US1 mobile 3 + US3 mobile 2 + verify 1）。主风险 = 007 e2e 回归（T014 必改）+ 昵称成功后 store 同步（T007，否则资料卡昵称不刷新）+ 性别屏 Stack 叠屏 locator 双命中（T012，getByRole 收窄）+ 契约 regen 同步链（T005，Constitution V active）。
