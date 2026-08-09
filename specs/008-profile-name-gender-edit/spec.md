---
feature_id: 008-profile-name-gender-edit
modules: [account]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-30'
updated_at: '2026-05-30'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: full
web_compat_notes: '承接 007 —— 把账号与安全「资料卡」的「昵称」「性别」从 disabled 占位翻为可编辑，并对换「个人简介」与「性别」位置。昵称编辑纯 mobile（复用 002 PATCH /me displayName，不改 server）；性别引入唯一一处 server 改动 —— Account 加 gender 字段 + authed 更新端点（与 007 bio / 002 displayName 同范式，无对象存储）。两屏 + 资料卡均走 Playwright Expo Web e2e（昵称编辑保存全链 / 性别点选即存返回 / 资料卡新顺序 + 行 active），绿后维持 full。'
agent_friction_observed: false
state_branches:
  - 'profile-card-order: 资料卡行顺序重排 —— 头像 / 昵称 / 性别 / 个人简介 / 主页背景图（对换 007 的「个人简介」与「性别」位置）；头像 / 主页背景图仍 disabled 占位'
  - 'name-row-active: 「昵称」行从 disabled 翻为 active —— 右侧展示真实 displayName，点击 push「设置昵称」编辑屏'
  - 'name-edit: 进「设置昵称」屏 → 单行输入预填当前 displayName、右侧「×」清空、实时字数 N/32；点「保存」→ 既有 PATCH /accounts/me {displayName} 持久化（≤32 码点、沿用 002 校验口径）→ 返回账号与安全页；非法（空 / 超 32 / 控制字符）客户端先行拦截 + server 400'
  - 'gender-row-active: 「性别」行从 disabled 翻为 active —— 右侧展示当前 gender 中文标签（未设为空 / 占位），点击 push「设置性别」屏'
  - 'gender-edit: 进「设置性别」屏 → 4 行选项（男 / 女 / 非二元 / 保密）、当前 gender 行右侧对勾（brand 色）；点任一选项 → 即持久化 gender（authed 更新端点）+ 自动返回账号与安全页（无「保存」按钮）；GET me 回读 gender'
  - 'gender-server: Account 加可空 gender 字段（enum MALE / FEMALE / NON_BINARY / PRIVATE）；authed 更新端点接受合法 enum 持久化、非法值 400、缺 token 401；GET /me 响应含 gender（未设 null）'
  - 'placeholder-rows: 头像 / 主页背景图行仍 disabled 占位（编辑 / 上传能力非本 feature，留 ADR-0045 独立 spec）；被点击无导航 / 无 crash'
  - 'unauthed: 未登录访问账号与安全页或两编辑屏 → AuthGate 第一层拦截回登录（既有机制，本 feature 不重立）'
---

# Feature Specification: 资料编辑（昵称修改 + 性别设置 + 资料卡行重排）

> ⚠️ **[CLIENT PARADIGM (2026-05-30)]**
> 承接 007 的 mobile 为主页面级增量（类 1 标准 UI，[sdd.md](../../docs/conventions/sdd.md)）。**唯一一处 server 改动** = 为「性别」给 Account 加 `gender` 字段 + authed 更新端点（与 007 `bio` / 002 `displayName` PATCH 同范式，**无对象存储 / 无文件上传**）。「昵称」编辑纯 mobile —— 复用 002 已具的 `PATCH /accounts/me {displayName}`，**不改 server**。视觉精确值（px / hex / 阴影）留 mockup（用户提供 2 张参考图 + Claude Design HTML preview baseline）回填 plan.md UI 段；复用 007 已落地的 app-local list-card primitives（`apps/mobile/src/settings/primitives.tsx`）+ bio-edit / DisplayNameInput 范式，**不进 `~/ui` 重设计 design-token**。头像 / 主页背景图上传能力**不在本 feature** —— 留 ADR-0045 独立 spec。

**Feature Branch**: `008-profile-name-gender-edit`
**Created**: 2026-05-30
**Status**: Draft
**Module**: `account`（账号与安全资料卡的昵称 / 性别编辑；昵称复用 002 写路径，性别新增 account profile `gender` 字段编辑；无跨 context）
**Input**:

- 把 007 ship 的账号与安全「资料卡」中 disabled 的「昵称」「性别」行翻为可编辑，并对换「个人简介」与「性别」位置。
- 「昵称」→ 设置昵称编辑屏（复用 002 displayName PATCH，无 server 改动）。
- 「性别」→ 设置性别选择屏（新增 Account `gender` 字段 + authed 更新端点）；点选即存、自动返回。
- 头像 / 主页背景图保持占位（上传留 ADR-0045 独立 spec）。

## Context

- **承接 007（资料卡现状）**：007 资料卡 5 行 = 头像 / 昵称 / 个人简介 / 性别 / 主页背景图。其中「个人简介」已 active（bio 编辑），「昵称」展示真实 `displayName` 但 disabled，头像 / 性别 / 主页背景图为 disabled 占位。本 feature 把「昵称」「性别」翻 active 并对换「个人简介」「性别」位置。

- **资料卡新顺序**：头像 / **昵称** / **性别** / **个人简介** / 主页背景图（对换 007 的个人简介 ↔ 性别）。

- **昵称编辑（无 server 改动）**：「昵称」行 active → push「设置昵称」屏（标题「设置昵称」+ 返回 + 右上「保存」）；单行输入预填当前 `displayName` + 右侧「×」清空按钮 + 实时字数 `N/32`；校验**沿用 002 `displayName` 现有口径**（≤32 Unicode 码点、trim、拒控制字符、允许 emoji）；点「保存」经既有 `PATCH /accounts/me {displayName}`（002）持久化 → 返回账号与安全页。复用 007 bio-edit / 既有 onboarding DisplayNameInput 范式（RHF + zodResolver）。

- **性别设置（唯一 server 改动）**：Account 加可空 `gender` 字段（enum `MALE` / `FEMALE` / `NON_BINARY` / `PRIVATE`，对应中文 男 / 女 / 非二元 / 保密）；新增 authed 更新端点（与 007 `bio` / 002 `displayName` PATCH 同范式：anemic Prisma row、rate-limited、无对象存储）+ GET `/me` 响应扩 `gender`。「性别」行 active → push「设置性别」屏（标题「设置性别」+ 返回，**无保存按钮**）；白色卡片 4 行（男 / 女 / 非二元 / 保密），当前 gender 行右侧对勾（app brand 色）；**点任一选项即持久化 gender + 自动返回**（tap-to-select 即存，无显式保存）。GET me 回读 gender，资料卡「性别」行展示当前中文标签。`gender` 属 account context 核心字段（直改 account 表 row → account 模块），无跨 context。

- **横切复用（不重立）**：AuthGate 第一层鉴权 / `useAuthStore` / `apps/mobile/src/settings/primitives.tsx`（`Card`/`Row`/`Divider`）/ `~/theme` tokens / 既有 GET·PATCH `/accounts/me`（002）/ 007 bio-edit slice（`bio-edit-form.schema` / `use-bio-edit-form`）/ RHF+zodResolver 表单范式（login Golden Sample）均已就位，本 spec 引用 / 扩展、不重新建立、不重设计。

- **与后续 spec 的边界**：头像 / 主页背景图上传留 ADR-0045 独立 spec（对象存储 = Aliyun OSS）；本 feature 头像 / 主页背景图行仅占位。

## Clarifications

### Session 2026-05-30（手测后增量）

- Q: 「昵称」编辑的字数上限？ → A: **32**，沿用 002 displayName 现有后端口径（≤32 Unicode 码点），不改 002；客户端计数 `N/32`（参考图的 20 不采用，保持与既有后端一致）。
- Q: 「性别」取值与存储？ → A: **4 值 enum 可空** —— `男/女/非二元/保密` → `MALE/FEMALE/NON_BINARY/PRIVATE`，未设为 null；GET me 回读、资料卡显当前中文标签。
- Q: 「性别」选择的保存交互？ → A: **点选即存 + 自动返回**（参考图无保存按钮），与「昵称」屏有显式「保存」按钮不同。
- Q: 资料卡行顺序？ → A: **对换「个人简介」与「性别」** → 头像/昵称/性别/个人简介/主页背景图。
- Q: 头像 / 主页背景图编辑？ → A: **否**，仍占位（上传留 ADR-0045 独立 spec，本 feature 不引入对象存储 / image-picker）。

## User Scenarios & Testing _(mandatory)_

> 「性别设置」含 [Server]（gender 字段 + 更新端点）+ [Mobile]（选择屏）+ [Contract]（GET·PATCH /me 扩 gender）；「昵称编辑」「资料卡重排」为 [Mobile] 层（昵称写路径复用 002）。验证：Playwright Expo Web e2e + server Testcontainers IT（gender 持久化 / 校验 / 反枚举沿用既有 authed 守卫）+ vitest（纯逻辑）。

### User Story 1 — [Server + Mobile] 性别设置（Priority: P1）

用户点资料卡「性别」行 → 进设置性别屏 → 4 选项（男/女/非二元/保密）、当前值打勾 → 点任一选项 → 即保存、自动返回账号与安全页；资料卡「性别」行展示所选中文标签；再次进入预选当前值。

**Why this priority**: 本 feature 唯一带后端写入的新能力（新 Account 字段 + 端点）；点选即存是与昵称编辑不同的交互范式。

**Independent Test**:

- Server（Testcontainers PG）：authed PATCH 带 `gender="MALE"` → 200、Account.gender 持久化、GET me 回读 gender；带非法值（非 4 枚举之一）→ 400；带 null/清空 → 清空 gender（200）；缺 / 失效 token → 401（沿用 002 authed 守卫）。
- Mobile（Playwright Expo Web）：seed 已登录态 → 进账号与安全页 → 点「性别」→ 断言进设置性别屏、4 选项可见、当前值打勾；点「女」→ mock PATCH 200 → 断言自动返回账号与安全页、「性别」行右侧显「女」。

**Acceptance Scenarios**:

1. **Given** 已登录用户在账号与安全页，**When** 点资料卡「性别」行，**Then** push 进设置性别屏，渲染 4 行（男/女/非二元/保密），当前 `gender` 对应行右侧打勾（未设则无勾）
2. **Given** 在设置性别屏，**When** 点任一选项（如「女」），**Then** 经 authed 端点持久化 `gender=FEMALE`、**自动返回**账号与安全页（无显式保存按钮），资料卡「性别」行右侧展示「女」
3. **Given** 已设 gender，**When** 再次进设置性别屏，**Then** 该值对应行预先打勾
4. **Given** 缺 / 失效 access token，**When** 调更新端点，**Then** 401（沿用 002 authed 守卫）
5. **Given** 非法 gender 值（非 4 枚举），**When** 提交，**Then** 服务端 400 校验错误（客户端只发 4 枚举，属纵深防御）

---

### User Story 2 — [Mobile] 昵称编辑（Priority: P1）

用户点资料卡「昵称」行 → 进设置昵称屏 → 预填当前昵称、可清空、实时字数 N/32 → 点「保存」→ 昵称持久化（002 端点）、返回账号与安全页；资料卡「昵称」行展示新值。

**Why this priority**: 把 007 仅展示的昵称翻为可编辑，复用 002 已具后端 + 007 bio-edit 范式，零 server 改动。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进账号与安全页 → 点「昵称」→ 断言进设置昵称屏、输入预填当前 displayName、字数计数随输入更新；改输入 → 点「保存」→ mock PATCH /me 200 → 断言返回账号与安全页；超 32 字符时「保存」禁用 / 拦截。

**Acceptance Scenarios**:

1. **Given** 已登录用户在账号与安全页，**When** 点资料卡「昵称」行，**Then** push 进设置昵称屏，单行输入预填当前 `displayName`，右侧「×」清空按钮，右上「保存」，实时字数 `N/32`
2. **Given** 在设置昵称屏输入文本，**When** 字符数变化，**Then** `N/32` 实时更新；超 32 码点「保存」禁用 + 客户端拦截
3. **Given** 输入合法昵称（1–32 码点），**When** 点「保存」，**Then** 经既有 `PATCH /accounts/me {displayName}`（002）持久化、返回账号与安全页；资料卡「昵称」行展示新值
4. **Given** 输入为空 / 仅空白 / 超 32 / 含控制字符，**When** 提交，**Then** 客户端先行拦截（沿用 002 校验口径，与既有 onboarding 一致）；服务端 400 兜底
5. **Given** 点「×」清空输入，**When** 输入为空，**Then** 「保存」禁用（昵称不可为空，沿用 002 `@IsNotEmpty`）

---

### User Story 3 — [Mobile] 资料卡行重排 + 昵称/性别行翻 active（Priority: P1）

资料卡行顺序对换「个人简介」与「性别」（→ 头像/昵称/性别/个人简介/主页背景图）；「昵称」「性别」从 disabled 翻为 active 入口并展示当前值；头像/主页背景图仍占位。

**Why this priority**: 结构基座 —— US1/US2 的入口行在此翻 active；顺序对换是用户明确诉求。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进账号与安全页 → 断言资料卡行顺序 = 头像/昵称/性别/个人简介/主页背景图；「昵称」「性别」「个人简介」enabled，头像/主页背景图 disabled。

**Acceptance Scenarios**:

1. **Given** 已登录用户进账号与安全页，**When** 资料卡渲染，**Then** 行顺序 = 头像 / 昵称 / 性别 / 个人简介 / 主页背景图（个人简介与性别已对换）
2. **Given** 资料卡，**When** 检视行状态，**Then** 「昵称」「性别」「个人简介」为 active（可点导航），头像 / 主页背景图为 disabled 占位
3. **Given** 头像 / 主页背景图占位行，**When** 点击，**Then** 无导航、无 crash

### Edge Cases

- 未登录访问账号与安全页或两编辑屏 → AuthGate 第一层拦截回登录（既有机制，不重立）。
- 昵称编辑：内容含前后空白 → trim 后计长 / 保存；emoji 计 1 码点（沿用 002 口径）；空 / 仅空白 → 拦截（昵称不可空）。
- 性别：`gender` 为 null（未设）→ 资料卡「性别」行右值为空 / 占位符，设置性别屏无勾，不 crash。
- 性别：快速重复点同一选项 → 幂等（同值再存 200），不重复导航。
- 任一 disabled 占位行（头像 / 主页背景图）被点击 → 无导航 / 无 crash。

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: Account 模型 MUST 新增可空 `gender` 字段，取值域 = `MALE` / `FEMALE` / `NON_BINARY` / `PRIVATE`（未设为 null）；anemic Prisma row + `@map`（snake_case 在 schema 解决）、null 穿透为真相、不引入 POJO Entity Mapper（per ADR-0043 范式）。
- **FR-S02**: authed 更新端点 MUST 接受 `gender`（4 枚举之一或 null 清空）并持久化到当前账号；成功返既有 profile 响应（含回读 `gender`）。端点切分（新子端点 vs 扩 displayName DTO）由 plan 决，与 007 bio 同范式。
- **FR-S03**: `gender` 校验 — MUST 限 4 枚举值之一或 null；非法值 MUST 返 400 校验错误。
- **FR-S04**: 鉴权门槛 — 缺 / 失效 access token MUST 折叠为 401（沿用 002 authed 守卫，不因 gender 新增暴露额外状态）。
- **FR-S05**: 限流 — gender 更新 MUST 复用既有 per-account profile 更新限流（沿用 002 / 007 `10/60s per-account` 或等价配置）；超限 429 + `Retry-After`。
- **FR-S06**: GET `/accounts/me` 响应 MUST 含 `gender`（未设 null）；契约经 `@nestjs/swagger` 派生 OpenAPI、`packages/api-client` 重新 gen 同步 typed（per api-contract 约定）。

### Client Functional Requirements

- **FR-C01**: 资料卡行顺序 MUST = 头像 / 昵称 / 性别 / 个人简介 / 主页背景图（对换 007 的个人简介 ↔ 性别）。
- **FR-C02**: 「昵称」行 MUST 翻为 active —— 右侧展示真实 `displayName`，点击 push 设置昵称屏。
- **FR-C03**: 设置昵称屏 MUST 含：返回 + 标题「设置昵称」+ 右上「保存」；单行输入（预填当前 displayName、右侧「×」清空）；实时字数 `N/32`。MUST 用 RHF + zodResolver（Golden Sample = login，`<Controller>`、isSubmitting 单源、错误 + a11y 一体）；校验沿用 002 displayName 口径（1–32 码点、trim、拒控制字符、允许 emoji、**不可空**）。
- **FR-C04**: 设置昵称屏「保存」MUST 调既有 `PATCH /accounts/me {displayName}`（002，**不改 server**）；客户端先行拦截非法（空 / 超 32 / 控制字符）；成功返回账号与安全页并刷新昵称展示。
- **FR-C05**: 「性别」行 MUST 翻为 active —— 右侧展示当前 `gender` 中文标签（未设为空 / 占位），点击 push 设置性别屏。
- **FR-C06**: 设置性别屏 MUST 含：返回 + 标题「设置性别」；**无保存按钮**；4 行（男 / 女 / 非二元 / 保密），当前 gender 对应行右侧对勾（复用 app brand 色 token）。MUST 点任一选项即调 authed 更新端点持久化 gender + 自动返回账号与安全页（tap-to-select 即存）。
- **FR-C07**: gender 中文标签映射 MUST 为 `MALE`→男 / `FEMALE`→女 / `NON_BINARY`→非二元 / `PRIVATE`→保密；资料卡行与设置性别屏共用同一映射。
- **FR-C08**: 头像 / 主页背景图行 MUST 维持 disabled 占位（编辑 / 上传非本 feature）；点击 MUST 无导航、无 crash。MUST NOT 引入任何对象存储 / 文件上传 / image-picker 依赖。
- **FR-C09**: 两编辑屏 MUST 复用 007 `account-security/_layout.tsx` Stack 注册 + `~/settings/primitives` + `~/theme` tokens，MUST NOT 抽新组件进 `~/ui` / 重设计 design-token（类 1 占位 UI 边界 + design-token 复用纪律）。

### Key Entities

- **Account（既有，扩展）**：本 feature 新增可空 `gender`（enum `MALE`/`FEMALE`/`NON_BINARY`/`PRIVATE`）。复用既有 `displayName`（昵称编辑写路径 002）。无新增表、无对象存储。
- **AuthStore（既有）**：读 `displayName`。gender 不必进 store（编辑屏经端点读写、随 GET me 回读）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 性别设置 —— authed 用户在设置性别屏点选 → 200、Account.gender 持久化、GET me 回读 gender、资料卡「性别」行显对应中文标签、再次进屏预选；非法值 → 400；清空 → null（200）；缺 token → 401（server Testcontainers IT + mobile Playwright 点选即存全链）。
- **SC-002**: 昵称编辑 —— authed 用户改昵称（1–32 码点）保存 → 经 002 PATCH 200、回读、资料卡显新值；超 32 / 空 → 客户端拦截 + server 400（mobile Playwright 保存全链；server 复用 002 既有 IT，不重测）。
- **SC-003**: 资料卡行顺序 = 头像/昵称/性别/个人简介/主页背景图（个人简介与性别已对换，Playwright 逐行断言）。
- **SC-004**: 「昵称」「性别」「个人简介」active（可导航），头像 / 主页背景图 disabled 占位点击无导航无 crash（Playwright 断言）。
- **SC-005**: server 改动严格限于 account profile `gender` —— PR 不含对象存储 / 文件上传 / image-picker 依赖、不含 Prisma 除 `gender` 外的 schema 改动、不含跨 context import（CI / review 断言）；昵称编辑 0 server 改动（复用 002）。

## Assumptions

- `gender` 计长 / 校验 = 严格 4 枚举值之一或 null（不接受自由文本）；中文标签仅前端展示映射，存储用英文 enum。
- 昵称编辑复用 002 `displayName` 后端（≤32 码点、`@IsNotEmpty` 不可空）；本 feature 不改 002 写路径 / 校验。
- gender 更新端点切分（扩 `PATCH /me` DTO 加可选 gender vs 新 `PATCH /me/gender` 子端点）为 plan 决策；二者均 account context、authed、rate-limited（与 007 bio D1 同型决策）。
- 资料卡 primitives 复用 007 `apps/mobile/src/settings/primitives.tsx`（含 `Row` 的 `value` 展示 + `align` + `showChevron`），不在本 feature 重定义 / 不抽新组件进 `~/ui`。
- 设置性别选择列表（4 行 + 对勾）是新 UI pattern → 走 Claude Design mockup（用户已备参考图 + prompt）；设置昵称屏镜像既有 bio-edit / DisplayNameInput 范式。
- 视觉精确值留 mockup 回填 plan.md UI 段；本 spec 仅锁业务结构 + 行集 / 顺序 + 状态 + gender 编辑契约。

## Out of Scope

- **头像 / 主页背景图 上传 / 更换能力** —— 留独立 spec，架构基线见 [ADR-0045 对象存储 + 图片上传](../../docs/adr/0045-object-storage-image-upload.md)（本 feature 不实现，不引入任何存储设施 / image-picker）。
- **昵称校验口径变更** —— 沿用 002（≤32 码点、不可空）；不改后端、不引入 20 上限（参考图的 20 不采用）。
- **gender 之外的 profile 字段**（生日 / 地区 / 签名等）—— 非本 feature。
- **gender 用于个性化 / 推荐 / 展示给他人** —— 仅本人资料编辑 + 回读，下游消费非本 feature。
