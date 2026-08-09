---
feature_id: 007-account-security-refactor
modules: [account]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-30'
updated_at: '2026-05-30'
migration_refs: ['20260530_1505_add_bio_to_account']
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: full
web_compat_notes: '页面重构纯 mobile（复用 006 已 ship 的 account-security route + ~/settings/primitives + maskPhone + 既有 auth store）；新增「个人简介」编辑引入唯一一处 server 改动 —— Account 加 bio 字段 + authed 更新端点（与 002 displayName PATCH 同范式，无对象存储）。账号与安全页 + 简介编辑页均走 Playwright Expo Web e2e（页面行集 / 导航 / 脱敏 / 简介编辑保存全链），绿后维持 full。'
agent_friction_observed: false
state_branches:
  - 'render-shell: 已登录用户进「账号与安全」页 → 渲染三段卡片（资料卡 → 身份/绑定卡 → 安全卡）；route /(app)/settings/account-security 与标题文案不变（沿用 006 IA）'
  - 'profile-card: 资料卡 5 行（头像/昵称/性别/个人简介/主页背景图）；「昵称」行右侧显示真实 displayName（既有 auth store / 002 GET me）但 disabled 不可编辑；「个人简介」行 active → push 简介编辑页；头像/性别/主页背景图为 disabled 占位（编辑能力非本 feature）；设计稿「二维码名片」行不渲染'
  - 'bio-edit: 进简介编辑页 → textarea 预填当前 bio、占位提示「介绍自己的投资经验、风格或领域」、实时字数 N/120、示例提示「例如：美股研究员/新股专家/量化交易员」；点「保存」→ authed 更新端点持久化 bio（≤120、可清空）→ 返回账号与安全页；GET me 回读 bio'
  - 'identity-card: 身份/绑定卡 4 行（手机号/邮箱/微信/google）全 disabled 占位；「手机号」行复用 maskPhone 脱敏（完整号不外露）；邮箱/微信/google 为预留占位（无绑定/解绑逻辑、不导航）—— 微信绑定能力留后续 spec'
  - 'security-card: 安全区两段保留现状行为不回归 —— 安全卡仅「登录管理」行（active → 设备列表 005）；「注销账号」独立卡片（active 红色 destructive、居中、无 chevron，同「退出登录」风格 → 短信验证码注销 004）'
  - 'removed-rows: 旧页「实名认证」「第三方账号绑定」generic 行删除 + 「安全小知识」占位行去除；设计稿「二维码名片」行不引入'
  - 'placeholder-tap: 任一 disabled 占位行（头像/性别/主页背景图/邮箱/微信/google）被点击 → 无导航 / 无 crash（不跳未建 route）'
  - 'unauthed: 未登录访问 /(app)/settings/account-security 或简介编辑页 → AuthGate 第一层拦截回登录（既有机制，本 feature 不重立）'
---

# Feature Specification: Account Security Page Refactor（账号与安全页级重构 — 图式资料 + 绑定 + 安全三段组合页 + 个人简介编辑）

> ⚠️ **[CLIENT PARADIGM (2026-05-30)]**
> 以 mobile 为主的页面级重构（类 1 标准 UI，[sdd.md](../../docs/conventions/sdd.md)）。**唯一一处 server 改动** = 为「个人简介」编辑给 Account 加 `bio` 字段 + authed 更新端点（与 002 `displayName` PATCH 同范式，**无对象存储 / 无文件上传**）。视觉精确值（px / hex / 阴影 / 动画）留 PHASE 2 mockup 回填 plan.md UI 段；占位 UI 4 边界：复用 006 已落地的 app-local list-card primitives（`apps/mobile/src/settings/primitives.tsx`），**不进 `~/ui`**、**不重设计 design-token**。头像 / 主页背景图 **上传能力不在本 feature** —— 留独立 spec（对象存储 = Aliyun OSS，web/app 选图分叉、presigned 直传统一，详见 Out of Scope）；微信绑定能力亦留后续 spec。

**Feature Branch**: `007-account-security-refactor`
**Created**: 2026-05-30
**Status**: Draft
**Module**: `account`（client account 功能域页面重构 + account profile `bio` 字段编辑；无跨 context、无 auth/security 服务端改动）
**Input**:

- 重构 `apps/mobile/app/(app)/settings/account-security/index.tsx`（006 ship 的身份/安全行列表页）为参考设计稿（富途「牛牛账号」资料页样式）的三段卡片组合页：**资料卡 + 身份/绑定卡 + 安全卡**。
- 删除旧页「实名认证」「第三方账号绑定」generic 行；设计稿「二维码名片」行不引入。
- 资料卡「个人简介」行 active → 新增简介编辑页（textarea + 字数 N/120 + 保存）；保存写入 Account 新增 `bio` 字段。
- 预留「微信」「google」为占位行（不实现绑定）；头像 / 主页背景图行为占位（上传能力另起独立 spec，对象存储用 Aliyun OSS）。

## Context

- **页面身份不变（沿用 006 IA）**：入口路由 `/(app)/settings/account-security` 与页面标题文案「账号与安全」保持不变 —— 设计稿原页名为「牛牛账号」，本 feature 仅借其布局样式，**不改页名 / 不改路由 / 不动设置壳入口文案**（避免回归 006 settings-shell e2e 断言）。

- **三段卡片自上而下**：
  1. **资料卡**：头像 / 昵称 / 个人简介 / 性别 / 主页背景图。
     - 「昵称」行右侧展示真实 `displayName`（既有 `useAuthStore` / 002 GET me），**disabled 不可编辑**（昵称编辑非本 feature）。
     - 「个人简介」行 **active** → push 简介编辑页（本 feature 新增能力）。
     - 头像 / 性别 / 主页背景图为 disabled 占位（编辑 / 上传能力非本 feature）。
     - **「二维码名片」行不渲染**。
  2. **身份/绑定卡**（**本期全占位、无绑定/解绑能力**）：手机号（复用 006 `maskPhone` 脱敏，完整号不外露）/ 邮箱（占位）/ 微信（**预留占位**）/ google（**预留占位**）。微信/google 为后续绑定 feature 的预留挂载点，本 feature disabled 不导航。
  3. **安全区**（保留现状功能、**不回归**）：**安全卡**仅「登录管理」（active → 设备列表，005 已 ship）；「注销账号」**独立卡片**（active 红色 destructive、居中、无 chevron，同设置首页「退出登录」风格 → 短信验证码注销发起，004 已 ship）。

- **个人简介编辑（唯一 server 改动）**：参考设计稿「个人简介」页 —— 顶部「个人简介」标题 + 返回 + 右上「保存」；中部 textarea（占位提示「介绍自己的投资经验、风格或领域」、右下实时字数 `N/120`）；下方示例提示「例如：美股研究员/新股专家/量化交易员」。保存把 `bio`（≤120 字符、可清空）持久化到 Account 新增 `bio` 字段，经 authed 更新端点（与 002 `displayName` PATCH 同范式：anemic Prisma row、rate-limited、无对象存储）。GET me 回读 bio。**bio 属 account context 核心字段**（Q1：直改 account 表 row → account 模块），无跨 context。

- **删除项**：旧页「实名认证」「第三方账号绑定」generic 行 → 删除（后者由身份/绑定卡的 per-provider 占位行取代）；设计稿「二维码名片」行 → 不引入。

- **横切复用（不重立）**：AuthGate 第一层鉴权 / `useAuthStore`（读 `displayName` / `phone`）/ `apps/mobile/src/settings/primitives.tsx`（`Card`/`Row`/`Divider`）/ `apps/mobile/src/format/phone.ts`（`maskPhone`）/ `~/theme` tokens / settings native Stack header / 既有 GET·PATCH `/accounts/me`（002）/ RHF+zodResolver 表单范式（login Golden Sample）均已就位，本 spec 引用 / 扩展、不重新建立、不重设计。

- **与后续 spec 的边界**：
  - **微信/google 绑定/解绑** 全部留后续绑定 spec（端口桩接策略）；本 feature 仅渲染占位行。
  - **头像 / 主页背景图上传** 留独立 spec：对象存储 = **Aliyun OSS**（server 已在阿里云、同区低延迟、OSS PostObject/签名策略）；web/app **选图层分叉**（app=`expo-image-picker` 相册/相机 + 原生裁剪；web=`<input type=file>` + JS 裁剪如 `react-easy-crop`）、**上传层统一**（presigned URL 直传对象存储 → 回调通知，不经后端代理字节）。本 feature 头像/背景图行仅占位。

## Clarifications

### Session 2026-05-30（spec 初稿）

- Q: 重构后的页面是否包含 profile 资料行（头像/昵称/性别/个人简介/主页背景图）？ → A: **是，做图式组合页**（资料行 + 身份绑定行 + 安全行同页；二维码名片去掉）。
- Q: 现有「登录管理 / 注销账号 / 安全小知识」三行怎么处理？ → A: **保留在本页下方另起卡片**（安全卡），现有功能不回归。
- Q: 页面仍叫「账号与安全」还是改叫「牛牛账号」？ → A: **仍叫「账号与安全」**，路由 / 标题 / 设置壳入口文案不变。

### Session 2026-05-30（补充：资料行编辑能力）

- Q: 「个人简介」编辑（带保存）放本 feature 还是独立 spec？ → A: **并入 007** —— 个人简介行从占位翻为 active → 编辑页；server 加 `bio` 字段 + authed 更新端点（轻量、与 displayName 同范式、无对象存储）。
- Q: 「头像 / 主页背景图」上传放哪？ → A: **独立 spec**（重量级：100% greenfield 对象存储 + image picker + 裁剪/压缩 + web/app 分叉）；007 里头像/背景图行保持占位，与 002 CL-003「头像推迟 M2+ 因牵涉对象存储」一致。
- Q: 头像/背景图上传的对象存储目标？ → A: **Aliyun OSS**（中国部署语境硬决策；R2/S3 海外链路有风险）。决策为后续独立 spec 预置，本 feature 不引入任何存储设施。
- Q: 「昵称」是否本 feature 可编辑？ → A: **否**，昵称行仅展示真实值（disabled）；昵称编辑（已有 002 PATCH 后端但无 mobile 编辑屏）非本 feature 范围。

## User Scenarios & Testing _(mandatory)_

> 页面重构为 [Mobile] 层；「个人简介编辑」含 [Server]（bio 字段 + 更新端点）+ [Mobile]（编辑屏）+ [Contract]（GET·PATCH /me 扩 bio）。验证：Playwright Expo Web e2e（页面行集 / 导航 / 脱敏 / 简介编辑保存全链）+ server Testcontainers IT（bio 持久化 / 校验 / 反枚举沿用既有 authed 守卫）+ vitest（纯逻辑），per mono 测试分层。

### User Story 1 — [Mobile] 账号与安全页重构为三段组合页，删除冗余行（Priority: P1）

已登录用户进入「账号与安全」页，看到自上而下：资料卡（头像/昵称/个人简介/性别/主页背景图）、身份/绑定卡（手机号/邮箱/微信/google）、安全卡（登录管理）、注销账号独立卡片（居中红色）。旧页「实名认证」「第三方账号绑定」「安全小知识」与设计稿「二维码名片」不出现。

**Why this priority**: 本 feature 的结构基座 —— 把旧扁平列表页重构为组合页 IA 并清掉冗余行；个人简介编辑 / 后续微信绑定 / 头像上传都挂在此结构下。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进 `/(app)/settings/account-security` → 断言渲染 3 张卡片、行集精确、且「实名认证」「第三方账号绑定」「二维码名片」不在 DOM。

**Acceptance Scenarios**:

1. **Given** 已登录用户从设置首页点「账号与安全」，**When** 进入二级页，**Then** push 进 `/(app)/settings/account-security`（route / 标题不变、底 tab 仍隐藏），渲染资料卡 / 身份绑定卡 / 安全卡三段，顺序固定
2. **Given** 账号与安全页渲染完成，**When** 检视行集，**Then** 「实名认证」「第三方账号绑定」「二维码名片」均不出现；资料卡含且仅含 头像/昵称/个人简介/性别/主页背景图 5 行
3. **Given** 账号与安全页，**When** 与 006 settings-shell e2e 既有断言对比，**Then** 入口路由 + 标题「账号与安全」未变（设置首页 → 账号与安全导航链不回归）

---

### User Story 2 — [Server + Mobile] 个人简介编辑与保存（Priority: P1）

用户点资料卡「个人简介」行 → 进编辑页 → 在 textarea 写简介（实时字数 N/120）→ 点「保存」→ 简介持久化、返回账号与安全页；再次进入编辑页预填上次内容。

**Why this priority**: 本 feature 唯一带后端写入的真实能力（其余为占位 / 重构）；用户可表达投资身份，是组合页的首个 active 资料行。

**Independent Test**:

- Server（Testcontainers PG）：authed PATCH 带 `bio="美股研究员"` → 断言 200、Account.bio 持久化、GET me 回读 bio；带超 120 字符 / 含控制字符 → 400 校验错误；带空串 → 清空 bio（200）；缺/失效 token → 401（沿用 002 authed 守卫）。
- Mobile（Playwright Expo Web）：seed 已登录态 → 进账号与安全页 → 点「个人简介」→ 断言进编辑页、textarea 预填当前 bio、字数计数随输入更新；输入 → 点「保存」→ mock PATCH 200 → 断言返回账号与安全页；超 120 字符时「保存」禁用 / 报错。

**Acceptance Scenarios**:

1. **Given** 已登录用户在账号与安全页，**When** 点资料卡「个人简介」行，**Then** push 进简介编辑页，textarea 预填当前 `bio`（无则空 + 占位提示「介绍自己的投资经验、风格或领域」），右下显示 `N/120`，下方示例提示「例如：美股研究员/新股专家/量化交易员」
2. **Given** 在编辑页输入简介文本，**When** 字符数变化，**Then** `N/120` 实时更新；达 120 上限后不可继续输入（或「保存」禁用 + 提示）
3. **Given** 输入合法简介（≤120），**When** 点「保存」，**Then** 经 authed 端点持久化 `bio`、返回账号与安全页；再次进编辑页预填该值
4. **Given** 已有 bio，**When** 清空内容并保存，**Then** `bio` 置空（允许清空），保存成功
5. **Given** 简介为超 120 字符 / 含控制字符，**When** 提交，**Then** 服务端 400 校验错误（客户端先行拦截上限）；账号 bio 不变
6. **Given** 缺 / 失效 access token，**When** 调更新端点，**Then** 401（沿用 002 authed 守卫，不暴露额外状态）

---

### User Story 3 — [Mobile] 身份/绑定卡：手机号脱敏 + 微信/google 预留占位（Priority: P1）

身份/绑定卡：手机号行展示脱敏号（完整号不外露），邮箱 / 微信 / google 行为占位预留；微信/google 是后续绑定能力的挂载点，本期点击无反应。

**Why this priority**: 身份/绑定卡是后续微信绑定 feature 的预留挂载页，IA 一次成型；手机号脱敏是隐私基线。

**Independent Test**: Playwright Expo Web；seed 已登录态（store `phone=+8613900139000`）→ 进账号与安全页 → 断言手机号行脱敏（含 `139****9000`、不含完整号）、邮箱/微信/google 为 disabled 占位、点击微信/google 无导航无 crash。

**Acceptance Scenarios**:

1. **Given** store 中 `phone=+8613900139000`，**When** 身份/绑定卡渲染，**Then** 「手机号」行展示脱敏 `+86 139****9000`（复用 `maskPhone`），完整号码不出现；该行 disabled 不导航
2. **Given** 身份/绑定卡，**When** 渲染「邮箱」「微信」「google」行，**Then** 三者为 disabled 占位（视觉灰置、不可点、不导航到未建 route）
3. **Given** 「微信」/「google」占位行，**When** 用户点击，**Then** 无任何导航、无 crash

---

### User Story 4 — [Mobile] 资料卡占位行 + 昵称真实值展示（Priority: P2）

资料卡的头像 / 性别 / 主页背景图为占位行，昵称行右侧显示真实昵称（displayName）但不可编辑。

**Why this priority**: 资料卡是组合页视觉主体；除个人简介外其余资料行本期为占位（编辑 / 上传留后续 feature），昵称真实值复用既有 store、零新依赖。

**Independent Test**: Playwright Expo Web；seed 已登录态（store `displayName=小明`）→ 进账号与安全页 → 断言昵称行右侧展示「小明」且 disabled、头像/性别/主页背景图行为 disabled 占位、点击任一占位行无导航无 crash。

**Acceptance Scenarios**:

1. **Given** store 中 `displayName=小明`，**When** 资料卡渲染，**Then** 「昵称」行右侧展示真实值「小明」（disabled，不导航 —— 昵称编辑非本 feature）
2. **Given** 资料卡，**When** 渲染 头像/性别/主页背景图 行，**Then** 三者为 disabled 占位（裸 `Text` label，不可点、不导航）
3. **Given** 任一资料卡占位行（头像/性别/主页背景图），**When** 用户点击，**Then** 无任何导航、无 crash

---

### User Story 5 — [Mobile] 安全区现有功能不回归（Priority: P1）

账号与安全页底部安全区：安全卡仅「登录管理」行；「注销账号」为独立卡片（居中红色 destructive、无 chevron，同设置首页「退出登录」风格）。登录管理与注销账号的导航行为与重构前一致。

**Why this priority**: 重构把现有行迁入新卡片结构，登录管理（005）/ 注销账号（004）是已 ship 的活功能，**绝不能在重构中回归** —— refactor 安全网。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进账号与安全页 → 点「登录管理」断言进设备列表 route、返回点「注销账号」断言进短信验证码注销发起页。

**Acceptance Scenarios**:

1. **Given** 安全卡渲染，**When** 点「登录管理」，**Then** push 进设备列表页（005 行为不变）
2. **Given** 注销账号独立卡片渲染（居中红色 destructive），**When** 点「注销账号」，**Then** push 进短信验证码注销发起页（004 行为不变）

### Edge Cases

- 未登录直接访问 `/(app)/settings/account-security` 或简介编辑页 → AuthGate 第一层拦截回登录（既有机制，不重立）。
- 简介编辑：内容含前后空白 → trim 后计长 / 保存；纯空白等价清空；emoji 计 1 字符（Unicode code point，沿用 002 displayName 计长口径）。
- 简介编辑：保存中重复快速点「保存」→ in-flight 期间忽略二次触发（isSubmitting 单源），不重复提交。
- store `displayName` 为 null/空（002 onboarding gate 后理论必填）→ 昵称行右值 fallback 空/占位符，不 crash。
- store `phone` 为 null/越界 → 手机号行 `maskPhone` 既有 fallback（006 `未绑定`），不 crash。
- 任一 disabled 占位行（头像/性别/主页背景图/邮箱/微信/google）被点击 → 无导航 / 无 crash。
- 「二维码名片」「实名认证」「第三方账号绑定」均不得在 DOM 出现（删除回归断言）。

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: Account 模型 MUST 新增可空 `bio` 字段（≤120 字符），承载个人简介；anemic Prisma row + `@map`（snake_case 在 schema 解决）、null 穿透为真相、不引入 POJO Entity Mapper（per ADR-0043 范式）。
- **FR-S02**: authed 更新端点 MUST 接受可选 `bio` 并持久化到当前账号（沿用 / 扩展 002 `PATCH /accounts/me` authed 守卫；端点切分 vs 扩 displayName DTO 由 plan 决）；成功返既有 profile 响应（含回读 `bio`）。
- **FR-S03**: `bio` 校验 — MUST 限 ≤120 Unicode code points（trim 后计长，与 002 displayName 计长口径一致）、拒控制字符、允许 emoji、**允许空串 / null（清空 bio）**；越界 / 非法 MUST 返 400 校验错误。
- **FR-S04**: 鉴权门槛 — 缺 / 失效 access token MUST 折叠为 401（沿用 002 authed 守卫，不因 bio 新增暴露额外状态）。
- **FR-S05**: 限流 — bio 更新 MUST 复用既有 per-account profile 更新限流（沿用 002 `10/60s per-account` 或等价配置）；超限 429 + `Retry-After`。
- **FR-S06**: GET `/accounts/me` 响应 MUST 含 `bio`（无则 null）；契约经 `@nestjs/swagger` 派生 OpenAPI、`packages/api-client` 重新 gen 同步 typed（per api-contract 约定）。

### Client Functional Requirements

- **FR-C01**: 账号与安全页 MUST 渲染三段卡片，自上而下 **资料卡 → 身份/绑定卡 → 安全卡**（复用 `~/settings/primitives`）。
- **FR-C02**: 资料卡 MUST 含且仅含 5 行（头像 / 昵称 / 个人简介 / 性别 / 主页背景图）。「昵称」行 MUST 右侧展示真实 `displayName` 且 disabled（昵称编辑非本 feature）；「个人简介」行 MUST active → push 简介编辑页；头像 / 性别 / 主页背景图 MUST 为 disabled 占位。
- **FR-C03**: 资料卡 MUST NOT 渲染「二维码名片」行。
- **FR-C04**: 简介编辑页 MUST 含：返回 + 标题「个人简介」+ 右上「保存」；textarea（占位提示「介绍自己的投资经验、风格或领域」、预填当前 bio）；实时字数 `N/120`；示例提示「例如：美股研究员/新股专家/量化交易员」。MUST 用 RHF + zodResolver（Golden Sample = login，`<Controller>`、isSubmitting 单源、错误 + a11y 一体）。
- **FR-C05**: 简介编辑 MUST 客户端先行拦截 >120 字符（禁继续输入或禁用「保存」+ 提示）；「保存」MUST 调 authed 更新端点持久化 bio，成功返回账号与安全页；支持清空保存。
- **FR-C06**: 身份/绑定卡 MUST 含 4 行（手机号 / 邮箱 / 微信 / google），全 disabled 占位、不导航；「手机号」行 MUST 复用 `maskPhone` 脱敏，完整号码 MUST NOT 出现在任何字段。
- **FR-C07**: 微信 / google 行 MUST 为预留占位（无绑定/解绑逻辑、点击无导航无 crash）—— 绑定能力留后续 feature。
- **FR-C08**: 安全区 MUST 分两段，保留重构前行为不回归：**安全卡**仅「登录管理」行（active → 设备列表 005）；「注销账号」MUST 为**独立卡片**（active 红色 destructive、居中、无 chevron，同设置首页「退出登录」风格 → 短信验证码注销发起 004）。MUST NOT 渲染「安全小知识」行。
- **FR-C09**: 旧页「实名认证」「第三方账号绑定」generic 行 MUST 删除（DOM 不出现）。
- **FR-C10**: 页面入口路由 `/(app)/settings/account-security` 与 native Stack header 标题「账号与安全」MUST 不变（不回归 006 settings-shell 导航 e2e）。
- **FR-C11**: 任一 disabled 占位行被点击 MUST 无导航、无 crash。
- **FR-C12**: 占位行实现 MUST 遵循类 1 占位 UI 4 边界 —— 原生 RN component、裸 `Text`、不做精确视觉决策、不抽新组件进 `~/ui`、不重设计 design-token；page 头部 MUST 保留 / 加 `PHASE 1 PLACEHOLDER` banner 注释（简介编辑页为 active 功能页，非占位，遵 mobile-impl-playbook RHF 铁律）。
- **FR-C13**: 本 feature 头像 / 主页背景图 MUST NOT 实现上传 / 更换能力（仅占位）；MUST NOT 引入任何对象存储 / 文件上传 / image-picker 依赖（留独立 spec）。

### Key Entities

- **Account（既有，扩展）**：本 feature 新增可空 `bio`（个人简介，≤120 字符）。复用既有 `displayName`（昵称行展示）、`phone`（手机号脱敏源）。无新增表、无对象存储。
- **AuthStore（既有）**：读 `displayName` / `phone`。bio 不必进 store（编辑页经端点读写、随 GET me 回读）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 账号与安全页行集精确 = {资料卡: 头像/昵称/个人简介/性别/主页背景图（5 行）, 身份绑定卡: 手机号/邮箱/微信/google（4 行）, 安全卡: 登录管理（1 行）, 注销账号独立卡片（居中红色 1 行）}；「实名认证」「第三方账号绑定」「二维码名片」「安全小知识」**0 出现**（Playwright Expo Web 逐行断言）。
- **SC-002**: 个人简介编辑 —— authed 用户写 ≤120 字符简介并保存 → 200、Account.bio 持久化、GET me 回读 bio、再次进编辑页预填；超 120 / 控制字符 → 400；空串 → 清空成功（200）；缺 token → 401（server Testcontainers IT + mobile Playwright 保存全链）。
- **SC-003**: 「昵称」行展示 store `displayName` 真实值且不可编辑；「手机号」行展示脱敏值且完整号码不出现在任何屏幕字段（seed `phone=+8613900139000` → 含 `139****9000`、不含 `13900139000`）。
- **SC-004**: 安全卡「登录管理」→ 设备列表、「注销账号」→ 短信验证码注销发起 两条导航不回归（005 + 004 既有 e2e 入口断言仍绿）；入口路由 + 标题「账号与安全」未变（006 settings-shell 导航 e2e 仍绿）。
- **SC-005**: 全部 disabled 占位行（头像/性别/主页背景图 + 邮箱/微信/google）点击 → 无导航、无 crash（Playwright 断言 URL 不变、无 page error）。
- **SC-006**: server 改动严格限于 account profile `bio` —— PR 不含对象存储 / 文件上传 / image-picker 依赖、不含 Prisma 除 `bio` 外的 schema 改动、不含跨 context import（CI / review 断言）；头像 / 背景图上传 0 实现。

## Assumptions

- 设计参考图原页名「牛牛账号」，本 feature 仅借资料 + 绑定行布局，页面仍命名 / 路由「账号与安全」（per Clarifications）。
- 资料卡仅「个人简介」本 feature 可编辑；昵称展示真实值但编辑（已有 002 PATCH 后端、缺 mobile 编辑屏）非本范围；头像 / 性别 / 主页背景图为占位。
- `bio` 计长 / 校验口径沿用 002 `displayName`（Unicode code point、trim、拒控制字符、允许 emoji），仅上限不同（120 vs 32）且允许空。
- bio 更新端点切分（扩 `PATCH /me` DTO 加可选 bio vs 新 `PATCH /me/bio` 子端点）为 plan 决策；二者均 account context、authed、rate-limited。
- 手机号脱敏复用 006 `maskPhone`、列表卡 primitives 复用 006 `apps/mobile/src/settings/primitives.tsx`，不在本 feature 重定义 / 不抽新组件进 `~/ui`。
- 视觉精确值留 PHASE 2 mockup 回填 plan.md UI 段；本 spec 仅锁业务结构 + 行集 + 状态 + bio 编辑契约。
- 头像 / 背景图上传的 web/app 分叉范式 + Aliyun OSS presigned 直传已调研留痕（见 Out of Scope），为后续独立 spec 预置，本 feature 不实现。

## Out of Scope

- **头像 / 主页背景图 上传 / 更换能力** —— 留独立 spec，架构基线见 **[ADR-0045 对象存储 + 图片上传](../../docs/adr/0045-object-storage-image-upload.md)**（本 feature 不实现）：对象存储 = **Aliyun OSS**（中国部署同区）；上传架构 = **client 直传**（后端签发短时凭证 → 直传 OSS → 回调通知，不经后端代理字节）；访问模型 = **public-read**；缩略图走 OSS 原生 IMG；**选图层 web/app 分叉**（app=`expo-image-picker` + 原生裁剪，`aspect` 仅 Android、iOS 裁剪恒方形；web=`<input type=file>` + JS 裁剪如 `react-easy-crop`），**上传层统一**；上传前客户端 resize/compress。凭证原语 / 备案·CDN / bucket 布局 / 防滥用为 ADR-0045 Open Questions，留该 spec 收敛。
- **微信 / google / 邮箱 / QQ / Apple / 小米 等任何第三方绑定 / 解绑能力** —— 留后续绑定 spec（端口桩接策略）。本 feature 仅渲染微信/google 占位行（邮箱占位、QQ/Apple/小米不渲染）。
- **昵称（displayName）的 mobile 编辑屏** —— 后端已具（002），mobile 编辑非本 feature；昵称行仅展示。
- **头像 / 性别 / 主页背景图 的编辑能力** —— 仅占位展示（性别选择、头像/背景图上传均非本范围）。
- **二维码名片** 功能。
- 微信绑定成功后**昵称 / 头像回填 profile** 的决策 —— 归后续绑定 spec。
