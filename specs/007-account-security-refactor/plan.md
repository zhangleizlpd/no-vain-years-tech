---
feature_id: 007-account-security-refactor
spec_ref: ./spec.md
status: implemented
created_at: '2026-05-30'
updated_at: '2026-05-30'
adr_refs: ['0024', '0030', '0032', '0035', '0043']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 007-account-security-refactor（账号与安全页级重构 + 个人简介 bio 编辑）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `007-account-security-refactor`

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per 004/006 先例）。
> **以 mobile 页面重构为主 + 唯一一处 server 改动**（account profile `bio` 字段编辑，与 002 `displayName` PATCH 同范式、无对象存储）。头像/背景图上传留 008、微信绑定留 009（本 plan 不含）。

## Summary _(mandatory)_

把 006 ship 的 `account-security/index.tsx`（扁平身份/安全行列表）重构成**图式三段组合页**：①**资料卡**（头像/昵称/个人简介/性别/主页背景图 —— 昵称右侧显示真实 `displayName` 但 disabled、个人简介行 active→编辑页、其余 disabled 占位、**不渲染二维码名片**）②**身份/绑定卡**（手机号脱敏/邮箱/微信/google，全 disabled 占位）③**安全卡**（仅登录管理）+ **注销账号独立卡片**（居中红色 destructive、同「退出登录」风格，保留 005/004 现状不回归）。删除旧页「实名认证」「第三方账号绑定」generic 行 + 不渲染「安全小知识」。

**唯一 server 改动 = 个人简介 bio 编辑**：Account 加可空 `bio`（≤120）+ 新 `PATCH /accounts/me/bio` 端点（`update-bio.usecase.ts`，account ctx，anemic row，校验镜像 002 displayName 口径但 ≤120 且允许清空）+ GET `/me` 响应扩 `bio` → api-client regen → mobile 简介编辑页（RHF+zodResolver，textarea + `N/120` + 保存）。

**关键集成/回归点**：本页是 006 `settings-shell.spec.ts` US2 断言的 account-security 页 —— 重构行集后**必须同步更新该 e2e 断言**（旧断言手机号/实名/第三方/登录管理/注销账号 → 新断言三卡片行集），否则 006 e2e 红。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | 说明 | trace FR |
|---|---|---|---|---|---|
| **EP1**（既有，扩展响应）| GET | `/api/v1/accounts/me` | bearer | 复用 002 端点；`AccountProfileResponse` **新增 `bio: string \| null`**（get-account-profile.usecase select bio）| FR-S06, FR-C02 |
| **EP2**（新增）| PATCH | `/api/v1/accounts/me/bio` | bearer | body `{ bio: string }`（≤120 code points、trim、拒控制字符、允许 emoji、**允许空串/清空**）→ 200 返更新后 profile（含 bio）；`update-bio.usecase.ts`（account ctx）| FR-S01, FR-S02, FR-S03, FR-S05 |

- **契约同步链（Constitution V，本批 active 非 vacuous）**：EP1 响应扩字段 + EP2 新端点 → `nx run server:export-openapi` → `packages/api-client` regen（`pnpm nx affected -t generate`）→ mobile 消费 typed hook（`useAccountProfileControllerUpdateBioForMe` 类）。**server impl + api-client regen + mobile 消费同 PR**。
- 限流：EP2 复用既有 per-account profile 更新限流（沿用 002 `displayName` 的 `10/60s per-account` 或等价 throttler 配置，FR-S05）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（2 轮 AskUserQuestion 收敛，记入 spec `## Clarifications`）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | server bio：Testcontainers IT 红绿（持久化/校验/清空/反枚举/限流，cwd=apps/server `nx test server`）；mobile：Playwright Expo Web e2e（三卡片行集 + 简介编辑保存全链 + disabled 占位不导航）；`bio` 校验纯函数 → vitest helper-level（若抽 rules）。presentational 行无单测（typecheck/lint + e2e） |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks 按此拆；server + api-client regen + mobile **同 PR**（Constitution V），分多 commit |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅ | `bio` = **account ctx 核心字段**（直改 account 表 row → account 模块，无跨 context）；`update-bio.usecase.ts` 直注 `PrismaService`、读写自己 ctx 表、**无 Moat 跨界**；数据 = 贫血 Prisma row（`bio` 加 `@map`），校验入 `account.rules.ts` 纯函数（**零-class**，无 VO/Entity Mapper，per ADR-0043） |
| V. 类型同步链 Nx-driven | ✅（active） | EP1 响应扩 + EP2 新端点 → openapi 变 → api-client regen → mobile 消费，**同 PR**（与 006 的 vacuous 不同，本批真有 contract 变更） |

## Architecture Notes _(mandatory)_

### Server（account ctx，bio 字段 + 端点）

- **Schema（expand，per ADR-0035）**：`apps/server/prisma/schema.prisma` Account 加 `bio String? @map("bio") @db.VarChar(120)`（可空；`@map` 对齐既有 `displayName @map("display_name")` 范式）。migrate dev 产 migration（纯加可空列 = 安全 expand，无 contract 阶段）。
- **`update-bio.usecase.ts`（新，account ctx 扁平平铺）**：镜像 `update-display-name.usecase.ts` 结构 —— 直注 `PrismaService`，`prisma.account.update({ where:{id}, data:{ bio } })`，anemic row 返回。**不**新建 Repository / Entity Mapper / VO class。
- **校验（`account.rules.ts` 纯函数 + DTO）**：`bio` ≤120 Unicode code points（trim 后计长，与 002 `displayName` 计长口径一致）、拒控制字符（沿用 `author_invisible_chars` deny-list 范式 / 既有 displayName 校验）、允许 emoji、**允许空串 / null（清空）**。DTO `UpdateBioRequest`（`@MaxLength` 按 code-point 或自定义 validator；**注意非 `@IsNotEmpty`** —— 允许清空，与 `UpdateDisplayNameRequest` 的 NotEmpty 区别）。越界/非法 → 400；缺 token → 401（沿用既有 authed 守卫）。
- **GET /me 扩字段**：`get-account-profile.usecase.ts` select `bio`；`AccountProfileResponse` 加 `@ApiProperty bio: string \| null`（nullable）。
- **测试**：`*.it.spec.ts` Testcontainers（`nx test server` cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）覆盖 spec `state_branches` 的 bio-edit 分支 + SC-002（持久化/超 120/控制字符/清空/缺 token）。**禁** lifecycle mock（无新 Guard/Filter，复用既有 authed 守卫）。

### Mobile（页面重构 + 简介编辑页）

- **页面重构** `apps/mobile/app/(app)/settings/account-security/index.tsx`：3 张 `Card`（复用 `~/settings/primitives` Card/Row/Divider，**不进 `~/ui`、不抽新组件**）：
  - 资料卡：头像 / 昵称（`value`=store `displayName`，disabled）/ 个人简介（active，`onPress`→ push 编辑页）/ 性别 / 主页背景图（占位 disabled）。**删** 二维码名片。
  - 身份/绑定卡：手机号（`value`=`maskPhone(phone)`，disabled）/ 邮箱 / 微信 / google（占位 disabled）。
  - 安全卡：仅 登录管理（active→`login-management`）。注销账号 拆为**独立卡片**（destructive、`showChevron={false}`、`align="center"`，同设置首页「退出登录」风格 → `delete-account`）。**不渲染** 安全小知识 —— **行为不回归**（005/004）。
  - **删** 旧「实名认证」「第三方账号绑定」行。头部保留/加 `// PHASE 1 PLACEHOLDER — business flow validated; visuals pending mockup.` banner（占位行部分）。
- **简介编辑页**（新 route `apps/mobile/app/(app)/settings/account-security/bio-edit.tsx`）：标题「个人简介」+ 返回 + 右上「保存」；`TextInput` multiline（占位提示「介绍自己的投资经验、风格或领域」、预填当前 bio）；实时 `N/120`；示例提示「例如：美股研究员/新股专家/量化交易员」。
  - **RHF + zodResolver 4 铁律**（Golden Sample=login，per mobile-impl-playbook）：`<Controller>` 包 TextInput（**非 register**）；表单态（bio 文本）≠ 副作用态；`isSubmitting` 单源驱动「保存」忙态；client 先行拦截 >120（zod schema `z.string().max(120)` + 计数 UI）。
  - 数据：进页 GET `/me` 取当前 bio 预填；保存调 EP2 Orval hook → 成功 invalidate `/me`（或更新 store）→ `router.back()`。Strangler-Fig：Orval 函数式 hook（非 class），复用 `~/theme`+`~/ui`。
  - `bio-edit` route 在 `account-security/_layout.tsx` 注册 `Stack.Screen`（title「个人简介」）。
- **昵称只读**：昵称行展示 store `displayName`，本 feature **不可编辑**（昵称 mobile 编辑屏非本 feature；002 PATCH 后端虽具）。
- **Metro `.js` 陷阱**：新文件相对 import **extensionless**（ESLint 已机械拦，per memory）。

### 测试与回归（关键）

- **更新 006 e2e**（regression must-fix）：`apps/mobile/e2e/settings-shell.spec.ts` US2 现断言旧 account-security 行（手机号/实名/第三方/登录管理/注销账号）→ **改断言新三卡片行集**（资料/绑定/安全）+ 「实名认证」「第三方账号绑定」「二维码名片」不在 DOM。否则 006 e2e 红。
- **新 e2e**（`apps/mobile/e2e/account-security-refactor.spec.ts` 或扩 settings-shell）：US1 行集 + 删除行；US2 手机号脱敏 + 微信/google 占位不导航；US3 简介编辑（点个人简介→编辑页→输入→计数→mock PATCH 200→back）；US4 资料占位昵称真实值；US5 安全卡导航不回归（登录管理/注销账号 push）。seed authed + mock `/me`（含 bio）per 006 范式。
- **Verify**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `runtime-smoke` + `generate` 契约链）+ server IT 绿 + web e2e 绿。

## Open Decisions Resolved（plan→tasks gate review — ⚠️ 标注项请 review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** bio 端点形态 | 扩 `PATCH /me` 加可选 bio vs 新子端点 | **新 `PATCH /accounts/me/bio`** + `update-bio.usecase.ts`（operation-per-use-case，镜像 update-display-name，**0 改 002 写路径**最小 blast radius；个人简介页仅编辑 bio，专端点语义清晰）。GET /me 仅扩**读**字段 | ⚠️ resolved |
| **D2** bio 列与校验 | — | `VarChar(120)` 可空 `@map("bio")`；≤120 code points + trim + 拒控制字符 + 允许 emoji + **允许清空**（镜像 002 displayName 口径，仅上限 32→120 + 去 NotEmpty）| ⚠️ resolved |
| **D3** 简介编辑页 route | profile-edit vs account-security 子页 | **`account-security/bio-edit.tsx`**（入口在账号与安全资料卡，就近落 account-security stack；注册 Stack.Screen title「个人简介」）| resolved |
| **D4** 昵称来源 | store vs GET /me | 昵称行 `value` = store `displayName`（只读展示，editor 不做）；bio 预填走 GET /me（含新 bio 字段）| resolved |
| **D5** 006 e2e 回归 | — | **必改** `settings-shell.spec.ts` US2 account-security 断言为新三卡片行集（重构改了它断言的页面）| ⚠️ resolved |
| **D6** 占位行落点 | `~/ui` vs app-local | 复用 006 `~/settings/primitives`（app-local），**不抽新组件进 `~/ui`**、不重设计 token（占位 UI 4 边界 + memory `design_tokens_reuse_not_redesign`）| resolved |
| **D7** 保存后刷新 | — | 保存成功 invalidate `/me`（RQ）→ 资料卡昵称/未来 bio 展示一致 → `router.back()` | resolved |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：1 个可空列 + 1 个 CRUD 端点（镜像既有 displayName）+ 1 页重构（复用既有 primitives）+ 1 个 RHF 编辑页。无跨 context、无对象存储、无新依赖。复杂度低（略高于 006 纯壳，因含 1 server 字段 + contract regen）。

## Performance Budget

- EP2 `PATCH /me/bio`：镜像 002 displayName PATCH 预算（p95 100ms / p99 200ms，单行 update）。
- EP1 GET /me：扩字段不改既有预算（002 frontmatter）。
- mobile 页面重构 / 编辑页为本地渲染 + 单次 GET/PATCH，无额外网络预算项。

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（server + api-client regen + mobile 同 PR，per Constitution V；每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip）：

- `[Server]` schema：Account 加 `bio` 列 + migrate（expand 可空列）→ prisma generate
- `[Server]` `update-bio.usecase.ts` + `UpdateBioRequest` DTO + controller 路由（`PATCH /me/bio`）+ `account.rules.ts` bio 校验纯函数 → **先红**（IT）后绿
- `[Server]` GET /me 扩 bio：`get-account-profile.usecase` select + `AccountProfileResponse` 加字段 → IT 断言回读
- `[Contract]` `nx run server:export-openapi` + `nx affected -t generate`（api-client regen）→ mobile 拿到 typed bio hook
- `[Mobile]` 页面重构 `account-security/index.tsx`（三卡片 + 删行 + 占位 + maskPhone + 昵称 store 值 + PHASE 1 banner）
- `[Mobile]` 简介编辑页 `account-security/bio-edit.tsx` + `_layout` 注册（RHF+zodResolver，textarea + N/120 + 保存，消费 bio hook）
- `[Mobile-E2E]` 更新 `settings-shell.spec.ts` 旧断言 + 新 `account-security-refactor` e2e（US1-5）
- `[Verify]`：`nx affected -t lint typecheck test build runtime-smoke generate` 全绿 + server IT + web e2e

预估 task 数：~8-11（server bio 3-4 + contract 1 + mobile 2-3 + e2e 2 + verify）。主要风险 = 006 e2e 回归（D5 必改）+ bio 校验「允许清空」与 displayName NotEmpty 的区别（D2）+ contract regen 同步链（Constitution V active）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-30 | **ID-namespace**: US1-5 / FR-S01..S06 / FR-C01..C13 / SC-001..006
