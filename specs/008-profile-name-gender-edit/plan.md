---
feature_id: 008-profile-name-gender-edit
spec_ref: ./spec.md
status: planned
created_at: '2026-05-30'
updated_at: '2026-05-30'
adr_refs: ['0024', '0030', '0032', '0035', '0043']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 008-profile-name-gender-edit（资料编辑 —— 昵称修改 + 性别设置 + 资料卡行重排）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `008-profile-name-gender-edit`

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per 004/006/007 先例）。
> 承接 007（账号与安全图式三段页已 ship）。**以 mobile 两编辑屏 + 资料卡重排为主 + 唯一一处 server 改动**（account profile `gender` 字段编辑，与 007 `bio` / 002 `displayName` PATCH 同范式、**无对象存储 / 无文件上传**）。昵称编辑**纯 mobile**，复用 002 已具的 `PATCH /accounts/me {displayName}`，**0 server 改动**。头像 / 主页背景图上传留 ADR-0045 独立 spec（本 plan 不含）。

## Summary _(mandatory)_

把 007 ship 的账号与安全「资料卡」中 disabled 的「昵称」「性别」翻为可编辑，并**对换「个人简介」与「性别」位置** → 新行顺序 = 头像 / **昵称** / **性别** / **个人简介** / 主页背景图。

1. **昵称编辑（0 server 改动）**：「昵称」行 active → push `name-edit` 屏（标题「设置昵称」+ 返回 + 右上「保存」）；单行输入预填 `displayName` + 右侧「×」清空 + 实时 `N/32`；**复用 002 `PATCH /accounts/me {displayName}`** + **复用 `~/auth` 已导出的 `displayNameSchema`**（1–32 码点、trim、拒控制字符、不可空）。RHF + zodResolver（Golden Sample = login，镜像 007 `use-bio-edit-form`）。
2. **性别设置（唯一 server 改动）**：Account 加可空 `gender` 字段（4 枚举 `MALE/FEMALE/NON_BINARY/PRIVATE`，存为 `String?` + TS `Gender` enum，**与 `status` 既有范式一致、无 native Prisma enum**）+ 新 `PATCH /accounts/me/gender` 端点（`update-gender.usecase.ts`，account ctx，anemic row，校验入 `account.rules.ts#normalizeGender`，限 4 枚举或 null 清空）+ GET `/me` 响应扩 `gender` → api-client regen → mobile `gender-edit` 屏（**4 行点选即存 + 自动返回，无保存按钮**，非 RHF —— 详 D6）。
3. **资料卡重排 + 翻 active**：`account-security/index.tsx` 资料卡 5 行重排 + 昵称/性别翻 active（push 各自编辑屏 + 右侧展示当前值），头像 / 主页背景图仍 disabled 占位。

**关键集成 / 回归点**：007 的 e2e `apps/mobile/e2e/account-security-refactor.spec.ts` **硬断言**了旧资料卡行顺序（L89 `['头像','昵称','个人简介','性别','主页背景图']`）+ 性别为 disabled 占位（L193-198 `tap({ force: true })` 验无导航）。本 feature 改行序 + 翻 active → **必须同步更新该 e2e**（新行序 + 昵称/性别 active + 删占位断言），否则 007 e2e 红（D5 gate）。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | 说明 | trace FR |
|---|---|---|---|---|---|
| **EP1**（既有，扩展响应）| GET | `/api/v1/accounts/me` | bearer | 复用 002/007 端点；`AccountProfileResponse` **新增 `gender: Gender \| null`**（`get-account-profile.usecase` select gender）| FR-S06, FR-C05 |
| **EP2**（新增）| PATCH | `/api/v1/accounts/me/gender` | bearer | body `{ gender: 'MALE'\|'FEMALE'\|'NON_BINARY'\|'PRIVATE' \| null }` → 200 返更新后 profile（含 gender）；非法枚举 → 400；null 清空 gender；`update-gender.usecase.ts`（account ctx）| FR-S01, FR-S02, FR-S03, FR-S05 |
| **EP0**（既有，复用，**0 改**）| PATCH | `/api/v1/accounts/me` | bearer | 002 `{ displayName }`；**昵称编辑直接复用**（`useAccountProfileControllerUpdateDisplayName`）— 本 feature **不改 server** | FR-C04 |

- **契约同步链（Constitution V，本批 active 非 vacuous）**：EP1 响应扩字段 + EP2 新端点 → `nx run server:export-openapi` → `packages/api-client` regen（`pnpm nx affected -t generate`）→ mobile 消费 typed hook（`useAccountProfileControllerUpdateGender` 类）。**server impl + api-client regen + mobile 消费同 PR**。
- **限流**：EP2 复用既有 per-account profile 更新限流（沿用 002/007 `me-patch` `10/60s per-account` throttler bucket，FR-S05）；超限 429 + `Retry-After`。
- **昵称编辑无新契约**：复用 002 EP0 + 既有 `UpdateDisplayNameRequest` DTO；server 端 0 改动（SC-005）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（2026-05-30 手测后 5 问收敛，记入 spec `## Clarifications`）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | server gender：Testcontainers IT 红绿（持久化 / 4 枚举校验 / 非法 400 / null 清空 / 缺 token 401 / 限流，cwd=apps/server `nx test server`，per memory `testcontainers_spec_run_via_nx_cwd`）；mobile：Playwright Expo Web e2e（昵称保存全链 / 性别点选即存返回 / 资料卡新序 + 行 active）；`normalizeGender` 纯函数 → vitest（`account.rules.spec.ts` 扩）；`use-name-edit-form` 逻辑 → vitest（镜像 `use-bio-edit-form.spec.ts`）。presentational 行无单测（typecheck/lint + e2e） |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks 按此拆；server + api-client regen + mobile **同 PR**（Constitution V），分多 commit |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅ | `gender` = **account ctx 核心字段**（直改 account 表 row → account 模块，无跨 context）；`update-gender.usecase.ts` 直注 `PrismaService`、读写自己 ctx 表、**无 Moat 跨界**；数据 = 贫血 Prisma row（`gender` 加 `@map`，存 `String?` 非 native enum，与 `status` 一致），校验入 `account.rules.ts#normalizeGender` 纯函数（**零-class**，无 VO/Entity Mapper，per ADR-0043） |
| V. 类型同步链 Nx-driven | ✅（active） | EP1 响应扩 + EP2 新端点 → openapi 变 → api-client regen → mobile 消费，**同 PR**（昵称编辑复用 002 既有 typed hook，无契约变更） |

## Architecture Notes _(mandatory)_

### Server（account ctx，gender 字段 + 端点）

- **Schema（expand，per ADR-0035）**：`apps/server/prisma/schema.prisma` Account 加 `gender String? @map("gender") @db.VarChar(16)`（可空；存英文 enum 字符串，**镜像既有 `status String @db.VarChar(16)` 范式 —— 不引入 native Prisma `enum`**，保持贫血 row + TS enum 真相源一致）。`migrate dev` 产 migration（纯加可空列 = 安全 expand，无 contract 阶段）。
- **`Gender` TS enum + `normalizeGender`（`account.rules.ts` 扩，纯函数）**：镜像 `AccountStatus` enum 定义 `export enum Gender { MALE='MALE', FEMALE='FEMALE', NON_BINARY='NON_BINARY', PRIVATE='PRIVATE' }`；`normalizeGender(raw: string | null): Gender | null` —— null / 空串归一为 null（清空），合法 4 枚举之一返回该值，**其余抛 `INVALID_GENDER`**（由 use case 映 400）。**不**新建 VO / Entity class（零-class，per ADR-0043 §2）。
- **`update-gender.usecase.ts`（新，account ctx 扁平平铺）**：镜像 `update-bio.usecase.ts` 结构 —— 直注 `PrismaService`，`findUnique` → phone-null 视 not-found → `normalizeGender` 抛 `BadRequestException('INVALID_GENDER')` → `isActive` 纵深防御 → `prisma.account.update({ where:{id}, data:{ gender } })`，anemic row 返回（含 `gender`）。**不**新建 Repository / Entity Mapper / VO class。
- **DTO `UpdateGenderRequest`（`update-gender.request.ts`）**：`@ApiProperty({ enum: Gender, nullable: true })` + `@IsOptional() @IsEnum(Gender)` 的 `gender: Gender | null`（class-validator 先挡明显非法枚举，精确归一 / 清空交 `normalizeGender`）。
- **Controller**：`account-profile.controller.ts` 注入 `UpdateGenderUseCase` + 加 `@Patch('me/gender')`（镜像 `@Patch('me/bio')` 的 `@SkipThrottle` + `@Throttle({ 'me-patch': {10,60_000} })` + `@ApiResponse` 200/400/401/429 套装）。
- **GET /me 扩字段**：`get-account-profile.usecase.ts` select `gender`（扩 `*Result` 接口）；`AccountProfileResponse` 加 `@ApiProperty({ enum: Gender, nullable: true }) gender: Gender | null`；controller 各 `return {...}`（getProfile / updateDisplayName / updateBio / updateGender）补 `gender: result.gender`。
- **测试**：`update-gender.usecase.spec.ts`（单元，mock prisma：4 枚举持久化 / 非法抛 / null 清空 / not-found / not-active）+ `*.it.spec.ts` Testcontainers（`nx test server` cwd=apps/server）覆盖 spec `state_branches` 的 gender-server 分支 + SC-001（持久化 / 非法 400 / 清空 200 / 缺 token 401 / GET 回读）。`normalizeGender` 进 `account.rules.spec.ts`。**禁** lifecycle mock（无新 Guard/Filter，复用既有 authed 守卫）。

### Mobile（资料卡重排 + 昵称屏 + 性别屏）

- **资料卡重排** `apps/mobile/app/(app)/settings/account-security/index.tsx`：资料卡 5 行**重排** = 头像（disabled）/ **昵称**（active，`value`=store `displayName`，`onPress`→ push `name-edit`）/ **性别**（active，`value`=`genderLabel(gender)`，`onPress`→ push `gender-edit`）/ **个人简介**（active，007 既有，→ `bio-edit`）/ 主页背景图（disabled）。**个人简介 ↔ 性别对换位置**（FR-C01）。`gender` 不入 store → 资料卡的「性别」当前值随 `useMe()` 的 `profile.gender` 读（昵称仍读 store `displayName`，与 007 一致）。身份/绑定卡 + 安全卡 + 注销卡片**不动**（007 现状）。
- **昵称编辑屏**（新 route `account-security/name-edit.tsx`）：标题「设置昵称」+ 返回 + 右上「保存」；镜像 007 `bio-edit.tsx` 骨架（`useMe()` 预填 → `<Controller>` 包单行 `TextInput` → 实时 `N/32` → 右上「保存」`isSubmitting` 单源 → success `router.back()`）。
  - **复用 `~/auth` 导出的 `displayNameSchema`**（1–32 码点、trim、拒控制字符、**不可空**）；**新 `use-name-edit-form.ts`**（镜像 `use-bio-edit-form.ts`，差异：mutation 用 `useAccountProfileControllerUpdateDisplayName`、schema 用 `{ displayName: displayNameSchema }`、success invalidate `/me` + **同步更新 `useAuthStore` 的 `displayName`**（资料卡昵称读 store，必须刷新））。
  - 右侧「×」清空（输入非空时显示）；空 / 仅空白 → schema invalid → 「保存」disabled（不可空，FR-C04）。
  - **字数上限 = 32**（spec clarification 锁定，沿用 002；**mockup 的 `N/12` 不采用** —— code is truth，mockup drift 不算 bug，per docs-organization §设计取舍 / D9）。
- **性别设置屏**（新 route `account-security/gender-edit.tsx`）：标题「设置性别」+ 返回，**无右上保存按钮**；白卡 4 行（男 / 女 / 非二元 / 保密，左对齐文字）+ 当前 gender 行右侧 **brand-500 对勾**；**点任一行即调 EP2 持久化 + 自动 `router.back()`**（tap-to-select 即存，FR-C06）。
  - **非 RHF**（D6）：无文本输入 / 无表单校验 —— 是「点选触发 mutation」。新轻量 `use-gender-edit.ts` hook：`useAccountProfileControllerUpdateGender` mutation + `useMe()` 读当前值预选 + 点选 `mutateAsync({ data:{ gender } })` → invalidate `/me` → success `router.back()`；in-flight 行 disabled 防重复点（幂等：同值再存 200，spec Edge Case）。
  - **选择行 UI 局部自建**（D10）：`~/settings/primitives` 的 `Row` 是 chevron 语义，无对勾。性别屏的「选项行 + brand-500 对勾」是单用 presentational → **就地 build 在 `gender-edit.tsx`**（复用 `Card`/`Divider` + `~/theme` brand 色 token），**不抽进 `~/ui` / 不改 `primitives.tsx`**（占位/单用组件落点纪律 + design-token 复用）。
- **gender 标签映射**（新 `apps/mobile/src/settings/gender.ts`）：`GENDER_OPTIONS`（有序 `['MALE','FEMALE','NON_BINARY','PRIVATE']`）+ `GENDER_LABELS`（`MALE→男 / FEMALE→女 / NON_BINARY→非二元 / PRIVATE→保密`）+ `genderLabel(g: string | null): string`（null → '' / 占位）。**资料卡行 + 性别屏共用同一映射**（FR-C07，单一真相源）。`Gender` 类型从 regen 的 `@nvy/api-client` 取。
- **Stack 注册**：`account-security/_layout.tsx` 加 `<Stack.Screen name="name-edit" options={{ title: '设置昵称' }} />` + `<Stack.Screen name="gender-edit" options={{ title: '设置性别' }} />`（镜像既有 `bio-edit`）。
- **视觉映射**（mockup baseline，per `design/资料编辑.html` + `ProfileEditScreens.jsx`）：参考图橙色 accent（保存 / 对勾 / 返回）**一律映射 app brand-500 `#2456E5`，0 新 token**；list-card 复用 `~/settings/primitives` 视觉（surface + rounded-md 12 + line-soft 边框、行高 52、分隔线左缩进）；文字三级 ink / ink-muted / ink-subtle，超限走 text-err。
- **Metro `.js` 陷阱**：新文件相对 import **extensionless**（ESLint 已机械拦，per memory）。

### 测试与回归（关键）

- **更新 007 e2e**（regression must-fix，D5）：`apps/mobile/e2e/account-security-refactor.spec.ts` —
  - L89 资料卡行顺序断言 `['头像','昵称','个人简介','性别','主页背景图']` → **改 `['头像','昵称','性别','个人简介','主页背景图']`**（对换）。
  - L183/L193-198 US4「昵称 / 性别 disabled 占位」断言 → 性别**已 active**：从「`tap({ force:true })` 验无导航」改为「`tap()` → 进设置性别屏」；昵称同理（从 disabled 展示翻 active 入口）。头像 / 主页背景图仍 disabled 占位断言保留。
  - 不改则 007 e2e 红。
- **新 e2e**（`apps/mobile/e2e/profile-name-gender-edit.spec.ts`，seed authed + mock `/me`(含 gender) + mock PATCH，per 007 范式）：
  - US1 性别：点「性别」→ 进设置性别屏 → 4 选项可见 + 当前值打勾 → 点「女」→ mock PATCH 200 → **自动返回**账号与安全 + 资料卡「性别」行显「女」；再次进屏预选「女」。
  - US2 昵称：点「昵称」→ 进设置昵称屏 → 预填 + 计数随输入更新 → 改输入点「保存」→ mock PATCH 200 → 返回 + 资料卡显新值；超 32 / 空 → 「保存」disabled。
  - US3 重排：资料卡逐行断言新序 + 昵称/性别/个人简介 active、头像/主页背景图 disabled 占位点击无导航无 crash。
  - **Stack 叠屏 locator 陷阱**（per memory `playwright_expo_stacked_screen_locator_collision`）：底层 profile 屏仍挂 DOM → 用 `getByRole` 收窄 + scope 到目标屏；disabled 占位行 tap 用 `force:true`。
- **Verify**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `runtime-smoke` + `generate` 契约链）+ server IT 绿 + web e2e 绿。本地跑 runtime-smoke 前先杀 `:3000` 父进程（per memory `nx_serve_respawns_3000_poisons_seed_e2e`）。

## Open Decisions Resolved（plan→tasks gate review — ⚠️ 标注项请 review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** gender 端点形态 | 扩 `PATCH /me` 加可选 gender vs 新子端点 | **新 `PATCH /accounts/me/gender`** + `update-gender.usecase.ts`（operation-per-use-case，镜像 update-bio，**0 改 002/007 写路径**最小 blast radius；性别屏仅编辑 gender，专端点语义清晰）。GET /me 仅扩**读**字段 | ⚠️ resolved |
| **D2** gender 存储与校验 | native Prisma enum vs String + TS enum | **`String? @db.VarChar(16) @map("gender")` + TS `Gender` enum**（镜像既有 `status` 范式，**不引入 native Prisma `enum`** —— 保持贫血 row + TS 真相源一致，迁移更安全）；校验 = `normalizeGender` 纯函数（4 枚举或 null 清空，非法抛 400） | ⚠️ resolved |
| **D3** 两编辑屏 route | — | `account-security/name-edit.tsx`（title 设置昵称）+ `account-security/gender-edit.tsx`（title 设置性别），就近落 account-security stack，`_layout` 各注册 `Stack.Screen`（镜像 007 bio-edit）| resolved |
| **D4** 昵称写路径 | 新端点 vs 复用 002 | **复用 002 `PATCH /accounts/me {displayName}`**（`useAccountProfileControllerUpdateDisplayName`，**0 server 改动**，SC-005）| resolved |
| **D5** 007 e2e 回归 | — | **必改** `account-security-refactor.spec.ts`：行序对换断言 + 昵称/性别从 disabled 占位翻 active 入口（重构改了它断言的页面）| ⚠️ resolved |
| **D6** 性别保存交互 | RHF 表单 vs tap-to-select | **tap-to-select 即存 + 自动返回，无保存按钮**（参考图无 save）；性别屏**非 RHF**（无文本输入 / 无表单校验）→ 轻量 `use-gender-edit.ts`（mutation + invalidate /me + back-on-success + in-flight 防重点）。**与昵称屏（RHF + 显式保存）刻意不同** | ⚠️ resolved |
| **D7** 昵称屏 schema | 新 schema vs 复用 | **复用 `~/auth` 已导出 `displayNameSchema`**（1–32 / NotEmpty / 拒控制字符）；新 `use-name-edit-form.ts` 镜像 `use-bio-edit-form.ts`（差异：displayName hook + 成功同步 `useAuthStore.displayName`，因资料卡昵称读 store）| resolved |
| **D8** gender 标签映射落点 | 行内字面量 vs 共享模块 | **新 `~/settings/gender.ts`**（`GENDER_OPTIONS` 有序 + `GENDER_LABELS` zh + `genderLabel()`）；资料卡行 + 性别屏共用（FR-C07 单一真相源），`Gender` 类型从 regen 的 `@nvy/api-client` 取 | resolved |
| **D9** 昵称字数上限 | mockup `N/12` vs spec `N/32` | **32**（spec clarification 锁定沿用 002；mockup 的 12 / 参考图的 20 均不采用 —— code is truth，mockup drift 留痕不同步）| resolved |
| **D10** 性别选择行 UI | 扩 `Row` primitive vs 局部自建 | **就地 build 在 `gender-edit.tsx`**（`Row` 是 chevron 语义无对勾；选项行 + brand-500 对勾是单用 presentational）；复用 `Card`/`Divider` + `~/theme` token，**不改 `primitives.tsx` / 不抽 `~/ui`** | resolved |
| **D11** gender 是否入 store | store vs GET /me | **不入 store**（资料卡「性别」行随 `useMe()` 的 `profile.gender` 读、性别屏读写经 EP1/EP2）；昵称因资料卡读 store 才需同步 store（D7）| resolved |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：1 个可空列（String，镜像 status）+ 1 个 CRUD 端点（镜像 update-bio）+ 资料卡重排（改既有页）+ 1 个 RHF 编辑屏（复用 displayNameSchema + 002 hook）+ 1 个 tap-to-select 编辑屏（非 RHF）+ 1 个标签映射模块。无跨 context、无对象存储、无新 runtime 依赖。复杂度低（与 007 同量级；昵称屏比 007 bio 屏更省 —— server 0 改、schema 复用）。

## Performance Budget

- EP2 `PATCH /me/gender`：镜像 002/007 profile PATCH 预算（p95 100ms / p99 200ms，单行 update）。
- EP1 GET /me：扩字段不改既有预算（002 frontmatter）。
- mobile 资料卡重排 / 两编辑屏为本地渲染 + 单次 GET/PATCH，无额外网络预算项。

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（server + api-client regen + mobile 同 PR，per Constitution V；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Server]` schema：Account 加 `gender String?` 列 + `migrate dev`（expand 可空列）→ prisma generate
- `[Server]` `Gender` enum + `normalizeGender` 入 `account.rules.ts` → `account.rules.spec.ts` 红绿（4 枚举 / null 清空 / 非法抛）
- `[Server]` `update-gender.usecase.ts` + `UpdateGenderRequest` DTO + controller `@Patch('me/gender')` → `*.usecase.spec.ts` + Testcontainers IT 先红后绿（持久化 / 400 / 401 / 清空 / 限流）
- `[Server]` GET /me 扩 gender：`get-account-profile.usecase` select + `AccountProfileResponse` 加字段 + controller 各 return 补 gender → IT 断言回读
- `[Contract]` `nx run server:export-openapi` + `nx affected -t generate`（api-client regen）→ mobile 拿到 typed `Gender` + `useAccountProfileControllerUpdateGender`
- `[Mobile]` `~/settings/gender.ts`（GENDER_OPTIONS + GENDER_LABELS + genderLabel）
- `[Mobile]` 资料卡重排 `account-security/index.tsx`（5 行新序 + 昵称/性别翻 active + 性别 value 读 useMe gender）
- `[Mobile]` 昵称屏 `name-edit.tsx` + `use-name-edit-form.ts`（复用 displayNameSchema + 002 hook + 同步 store）+ `_layout` 注册 → `use-name-edit-form.spec.ts`
- `[Mobile]` 性别屏 `gender-edit.tsx` + `use-gender-edit.ts`（tap-to-select 即存 + back）+ `_layout` 注册
- `[Mobile-E2E]` 更新 007 `account-security-refactor.spec.ts`（行序 + active）+ 新 `profile-name-gender-edit.spec.ts`（US1-3）
- `[Verify]`：`nx affected -t lint typecheck test build runtime-smoke generate` 全绿 + server IT + web e2e

预估 task 数：~11-14（server gender 4-5 + contract 1 + mobile 4-5 + e2e 2 + verify）。主要风险 = 007 e2e 回归（D5 必改）+ 昵称成功后 store 同步（D7，否则资料卡昵称不刷新）+ gender 性别屏 Stack 叠屏 locator 双命中（memory 陷阱）+ contract regen 同步链（Constitution V active）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-30 | **ID-namespace**: US1-3 / FR-S01..S06 / FR-C01..C09 / SC-001..005
