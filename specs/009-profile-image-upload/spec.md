---
feature_id: 009-profile-image-upload
modules: [account]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-30'
updated_at: '2026-08-16'
migration_refs: [20260816_0035_rename_profile_image_url_to_object_key]
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: full
web_compat_notes: 'web 上传路径（`<input type=file>` 选图 + JS 裁剪 + client 直传 OSS）可 Playwright e2e（凭证端点 + OSS PUT 在测试边界 mock）；native `expo-image-picker` 选图路径为设备专属（无 web 等价、不可 web e2e），但 web/app 共享的「要凭证 → 直传 → 落库 → profile 显示」核心层 web 已覆盖。架构基线 = ADR-0045。'
agent_friction_observed: false
state_branches:
  - 'request-credential: authed 用户发起换图 → 后端签发 scope 到本账号 key 前缀 / content-type / size / 短时效的一次性上传凭证（凭证原语 STS vs signed-PUT vs PostObject 留 plan）；缺 / 失效 token → 401；超限 → 429'
  - 'pick-divergence: 选图层 web/app 分叉（per ADR-0045）—— app=`expo-image-picker`（相册 / 相机 + 原生裁剪，`aspect` 仅 Android、iOS 裁剪恒方形）；web=`<input type=file accept=image/*>`（无相机 / 无原生裁剪）+ JS 裁剪（如 `react-easy-crop`）；头像 1:1、背景图宽幅；web 不显示「拍照」、权限请求 native-only、cancel 不可靠不挂 UI'
  - 'direct-upload: 选图 → client resize/compress → 直传 OSS（web/app 统一）→ 用 object key 通知后端；后端不代理图片字节'
  - 'confirm-persist: 后端校验 object key 属本账号 key 前缀 + content-type / size → 落 `avatarObjectKey` / `backgroundObjectKey`（存 objectKey 而非绝对 URL，覆盖旧值）；GET me 回读时由展示域现拼完整 URL，对外字段名仍是 `avatarUrl` / `backgroundImageUrl`'
  - 'display: profile hero（002 `Hero`/`AvatarPlaceholder`，现 onAvatarPress/onBackgroundPress 接 noop）+ 007 资料卡头像 / 主页背景图行经 OSS public-read URL 显示真实图（翻 noop / 占位为 active）；缩略图走 OSS 原生 IMG 派生'
  - 'view-fullscreen: action sheet「查看头像 / 背景图」→ 全屏查看当前原图'
  - 'failure: 凭证签发 / 直传 / 网络失败 → 友好错误提示，profile 不脏写（落库仅在直传成功 + 后端校验通过后）'
  - 'unauthed: 未登录访问换图入口 / 凭证端点 → AuthGate / authed 守卫拦截（既有机制，本 feature 不重立）'
---

# Feature Specification: Profile Image Upload（头像 + 主页背景图 上传 / 更换 / 显示 / 查看大图 — Aliyun OSS client 直传）

> ⚠️ **[FULL-STACK FEATURE (2026-05-30)]**
> Server + Mobile + Contract 三层。架构基线 = **[ADR-0045 对象存储 + 图片上传](../../docs/adr/0045-object-storage-image-upload.md)**：对象存储 = Aliyun OSS、**client 直传**（后端签发短时凭证，不代理字节）、**public-read** 访问、缩略图走 OSS 原生 IMG。选图层 **web/app 分叉**、上传层 **统一**（ADR-0045 §2/§5）。本 spec 锁 WHAT；ADR-0045 Open Questions（凭证原语 / 自定义域名·ICP 备案·CDN / bucket 布局·key 命名 / 裁剪库选型 / bounded context 落点）留 plan.md 收敛。**实现接续 007**（其头像 / 背景图占位行已在 main，本 feature 翻 active + 复用 002 profile hero 钩子）。微信 / 第三方绑定不在本 spec。

**Feature Branch**: `009-profile-image-upload`
**Created**: 2026-05-30
**Status**: Draft
**Module**: `account`（profile 资产 = account 域；上传凭证签发倾向 account 自签 per ADR-0045 Open Q6，最终 bounded context 落点 / 是否引入 security 平台 infra 留 plan 按 [server-bounded-context-catalog](../../docs/conventions/server-bounded-context-catalog.md) 决）
**Input**:

- 头像 + 主页背景图的 **上传 / 更换 + 接入 profile 显示 + 查看大图** 三段闭环（用户已定范围：两者都做）。
- 入口：002 profile hero（`apps/mobile/app/(app)/(tabs)/profile.tsx` 的 `Hero` / `AvatarPlaceholder`，现 `onAvatarPress` / `onBackgroundPress` 接 `noop`、`accessibilityHint="点击更换"`）；及 007 账号与安全页资料卡的「头像」「主页背景图」行（007 为占位，本 feature 翻 active）。
- Account 现有 profile 字段 = accountId/phone/displayName/bio/gender/status/createdAt（`AccountProfileResponse`，bio/gender 由 007/008-name-gender 已加，已在 main），但无 avatar / background 字段；本 feature 在其上新增 `avatarUrl` + `backgroundImageUrl`。

## Context

- **架构遵 ADR-0045（不重述）**：对象存储 Aliyun OSS；client 直传（要凭证 → 直传 → 通知，后端不代理字节）；public-read + referer 防盗链；OSS 原生 IMG 派生缩略图；选图层 web/app 分叉、上传层统一。具体凭证原语 / 备案·CDN / bucket 布局留 plan。

- **三段闭环**：
  1. **更换**：入口 action sheet（参考设计图二「更换背景图 / 查看背景图 / 取消」；头像同形）→ 选图（web/app 分叉）→ 裁剪（头像 1:1 / 背景宽幅）→ client resize/compress → 直传 OSS → 通知后端落库。
  2. **显示**：落库后 profile hero（翻 002 `Hero` 的 noop）+ 007 资料卡头像 / 背景图行经 OSS public-read URL 显示真实图；列表小图 / 详情大图同一原图经 OSS IMG 不同尺寸派生。
  3. **查看大图**：action sheet「查看」→ 全屏查看当前头像 / 背景图原图。

- **选图层 web/app 分叉（ADR-0045 §5）**：
  - **app**：`expo-image-picker`（相册 + 相机 + 原生裁剪）；`aspect` 仅 Android 生效、iOS 裁剪恒方形（头像 1:1 白嫖、背景宽幅 iOS 不在 picker 内强裁，由显示端 framing 或独立裁剪兜）。
  - **web**：`<input type=file accept=image/*>`（无相机、无原生裁剪）+ JS 裁剪（如 `react-easy-crop`，可自由设 aspect）。web 不显示「拍照」、权限请求方法 native-only no-op、cancel 不可靠 → 不挂 UI 等 cancel 回调；选图须真实用户手势内触发。

- **上传层统一（ADR-0045 §2）**：选图 → client resize/compress（native `expo-image-manipulator` / web canvas）→ 向后端要一次性凭证 → 直传 OSS → 用 object key 通知后端 → 后端校验 + 落 URL。两端同一「要签名 → 直传 → 通知」流。

- **横切复用（不重立）**：002 profile hero 结构（仅翻 `onAvatarPress` / `onBackgroundPress` 的 noop，不重设计 hero 布局）；007 资料卡头像 / 背景图占位行（翻 active）；authed 守卫 + GET·PATCH `/accounts/me`（002）；既有 throttler 限流；anemic Prisma row + `@map`（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）。

- **依赖与顺序**：依赖 **ADR-0045**（架构基线，已在 main）+ **007**（头像 / 背景图占位行，已在 main `apps/mobile/app/(app)/settings/account-security/index.tsx`，本 feature 翻 active）+ **002**（profile hero noop 钩子，已在 main `profile.tsx`）。三依赖均已落 main，本 feature 直接基于 main 实现、独立 review。

## Clarifications

### Session 2026-05-30

- Q: 范围 = 头像 + 背景图都做，还是只其一？ → A: **都做**（一个 spec 覆盖两资产，共享上传基建，仅裁剪比例不同）。
- Q: 是否含「上传结果接入 profile 显示」+「查看大图」？ → A: **都做**（上传 → 002 profile hero 显示真实图 + action sheet 含「查看大图」），形成可见闭环。
- Q（架构，已在 ADR-0045 定）：对象存储 = Aliyun OSS、client 直传、public-read、OSS IMG 派生 —— 本 spec 直接遵循，细节（凭证原语 / 备案·CDN / bucket 布局 / 裁剪库）留 plan。

## User Scenarios & Testing _(mandatory)_

> Server 层走 Testcontainers IT（凭证签发 / 落库 / 校验 / 限流 / 反枚举沿用既有 authed 守卫）；Mobile **web 上传路径**走 Playwright Expo Web e2e（凭证端点 + OSS PUT 在测试边界 mock）；**native `expo-image-picker` 选图路径**为设备 / 手动验证（无 web 等价）。Contract 经 swagger → api-client regen。

### User Story 1 — [Server] 上传凭证签发（Priority: P1）

已登录用户发起换图，后端签发一次性、scope 受限、短时效的上传凭证，使 client 可直传 OSS 而后端不接触图片字节。

**Why this priority**: 直传架构的入口与安全闸 —— 凭证把上传范围锁死在本账号 key 前缀 / content-type / size / 时效内，是「不代理字节仍安全」的承重点。

**Independent Test**: Testcontainers；authed 请求换头像凭证 → 断言返回 scope 到本账号 avatar key 前缀 + content-type 白名单 + size 上限 + 短时效的凭证；缺 / 失效 token → 401；同账号高频请求 → 429 + `Retry-After`。

**Acceptance Scenarios**:

1. **Given** ACTIVE 账号 + 有效 token，**When** 请求头像 / 背景图上传凭证，**Then** 返回一次性凭证，scope 限定本账号 key 前缀、允许的 content-type（图片）、size 上限、短时效
2. **Given** 缺 / 失效 access token，**When** 请求凭证，**Then** 401（沿用既有 authed 守卫，不暴露额外状态）
3. **Given** 同账号短时高频请求凭证，**When** 超限，**Then** 429 + `Retry-After`（复用 throttler，限流在加载账号前消费）

---

### User Story 2 — [Server + Contract] 确认落库 + GET me 扩字段（Priority: P1）

client 直传 OSS 成功后通知后端，后端校验对象归属与类型后把图片 URL 落到当前账号；GET me 回读头像 / 背景图 URL。

**Why this priority**: 把「已上传的对象」与「账号 profile」绑定的闭环落点；无此步上传无持久效果。

**Independent Test**: Testcontainers；authed 提交合法 object key（属本账号前缀、content-type / size 合规）→ 断言 200、`avatarUrl` / `backgroundImageUrl` 持久化、GET me 回读；提交不属本账号前缀 / 非法 key → 拒（4xx，不落库、不越权改他人）；缺 token → 401。

**Acceptance Scenarios**:

1. **Given** 直传成功的合法 object key，**When** 提交确认，**Then** 200、对应 URL 落当前账号（覆盖旧值）、GET me 回读新 URL
2. **Given** object key 不属本账号 key 前缀 / 类型非法 / 越权指向他人，**When** 提交，**Then** 拒（4xx），不落库、不改他人账号
3. **Given** GET `/accounts/me`，**When** 账号已设头像 / 背景图，**Then** 响应含 `avatarUrl` / `backgroundImageUrl`（未设为 null）；契约经 OpenAPI 派生、api-client 同步 typed
4. **Given** 缺 / 失效 token，**When** 提交确认或 GET me，**Then** 401

---

### User Story 3 — [Mobile] 更换头像 / 背景图（web/app 分叉选图 → 裁剪 → 直传 → 落库）（Priority: P1）

用户点头像 / 背景图 → action sheet「更换」→ 选图（app 相册 / 相机，web 文件）→ 裁剪（头像 1:1 / 背景宽幅）→ 上传 → 成功后显示真实图。

**Why this priority**: 用户面核心动作；web/app 分叉 + 上传统一的主路径。

**Independent Test**:

- web（Playwright Expo Web）：点头像 → action sheet → 「更换」→ 触发 `<input type=file>`（注入测试图）→ 裁剪 → mock 凭证端点 + mock OSS PUT → mock 确认端点 200 → 断言 profile hero 显示真实图（非 emoji）。
- native（设备 / 手动）：相册选图 + 原生裁剪 → 上传 → 显示（无 web e2e，标注覆盖缺口）。

**Acceptance Scenarios**:

1. **Given** 已登录用户在 profile hero 或 007 资料卡，**When** 点头像 / 背景图 → action sheet「更换」，**Then**（app）弹相册 / 相机选择 +（web）弹文件选择；选图后进裁剪（头像 1:1、背景宽幅）
2. **Given** 已选并裁剪图片，**When** 确认上传，**Then** client 先 resize/compress → 要凭证 → 直传 OSS → 通知后端 → 成功后 profile hero + 007 资料卡显示真实图（缩略图经 OSS IMG 派生）
3. **Given** web 平台，**When** 打开换图，**Then** 不显示「拍照」选项（native-only）；cancel 不挂起 UI
4. **Given** 上传过程，**When** 进行中，**Then** 有进度 / 忙态视觉；重复触发被忽略（busy 单源）

---

### User Story 4 — [Mobile] profile 显示真实头像 / 背景图（翻 002 占位）（Priority: P1）

上传成功后，002 profile hero 的头像 / 背景图从 emoji / 占位翻为真实图；007 资料卡对应行右侧亦显示缩略图。

**Why this priority**: 让上传有可见效果 —— 翻 002 hero 与 007 资料卡的占位为真实展示，是闭环的「果」。

**Independent Test**: Playwright Expo Web；seed 账号 `avatarUrl` / `backgroundImageUrl` 已设 → 进 profile → 断言 hero 渲染真实图（非 👤 emoji / 非占位背景）；进 007 账号与安全页 → 断言资料卡头像 / 背景图行显示缩略图。

**Acceptance Scenarios**:

1. **Given** 账号已设 `avatarUrl`，**When** profile hero 渲染，**Then** 显示真实头像（替代 emoji fallback），经 OSS public-read URL（缩略尺寸 OSS IMG 派生）
2. **Given** 账号已设 `backgroundImageUrl`，**When** profile hero 渲染，**Then** 显示真实背景图（替代占位）
3. **Given** 账号未设头像 / 背景图（null），**When** 渲染，**Then** 回落到既有 emoji / 占位（002 行为不回归）
4. **Given** 007 账号与安全页资料卡，**When** 渲染头像 / 背景图行，**Then** 右侧显示当前图缩略（未设则占位）

---

### User Story 5 — [Mobile] 查看大图（Priority: P2）

用户经 action sheet「查看头像 / 背景图」全屏查看当前原图。

**Why this priority**: 设计图二含「查看背景图」；查看是低频但完整体验的一环，P2 因不阻塞上传 / 显示主闭环。

**Independent Test**: Playwright Expo Web；seed 已设图 → 点头像 / 背景图 → action sheet「查看」→ 断言进入全屏查看、展示原图；返回回到原页。

**Acceptance Scenarios**:

1. **Given** 账号已设头像 / 背景图，**When** action sheet 点「查看」，**Then** 全屏展示当前原图
2. **Given** 全屏查看，**When** 返回 / 关闭，**Then** 回到原页
3. **Given** 账号未设图，**When** action sheet 呈现，**Then** 「查看」对空图的处理合理（置灰 / 不提供 / 展示占位，由 plan 定）

### Edge Cases

- 未登录访问换图入口 / 凭证端点 → AuthGate / authed 守卫拦截（既有机制，不重立）。
- 直传 OSS 失败 / 网络中断 / 凭证过期 → 友好错误提示，profile **不脏写**（落库仅在直传成功 + 后端确认校验通过后）。
- 选图后取消裁剪 / 取消上传 → 不发起、不改 profile；web cancel 不可靠 → 不依赖 cancel 回调挂 UI。
- 超大图 / 非图片类型 / 超 size 上限 → client 先行拦截（content-type / size），后端二次校验拒（凭证 scope + 确认校验）。
- 提交的 object key 不属本账号 key 前缀 → 后端拒（防越权写他人头像）。
- 账号 `avatarUrl` / `backgroundImageUrl` 为 null → profile 回落 002 emoji / 占位（不 crash、不回归）。
- iOS picker 裁剪恒方形 → 背景图宽幅在 iOS 不在 picker 内强裁（显示端 framing 或独立裁剪兜，plan 定）。

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: Account 模型 MUST 新增可空 `avatarUrl` + `backgroundImageUrl`（存 OSS public-read URL；anemic Prisma row + `@map`，null 穿透为真相，per ADR-0043）。
- **FR-S02**: 上传凭证签发端点（authed）MUST 签发**一次性、短时效**凭证，scope 限定到**本账号 key 前缀 + 允许的图片 content-type + size 上限**（凭证原语 STS vs signed-PUT vs PostObject 留 plan）；client 凭此直传 OSS，后端 MUST NOT 代理图片字节（per ADR-0045 §2）。
- **FR-S03**: 确认 / 持久化端点（authed）MUST 校验提交的 object key **属本账号 key 前缀** + content-type / size 合规，通过则把 URL 落当前账号对应字段（覆盖旧值）；MUST NOT 因 key 越权指向他人而改他人账号。
- **FR-S04**: GET `/accounts/me` 响应 MUST 含 `avatarUrl` + `backgroundImageUrl`（未设为 null）；契约经 `@nestjs/swagger` 派生 OpenAPI、`packages/api-client` 重新 gen 同步 typed（per api-contract 约定）。
- **FR-S05**: 鉴权门槛 — 凭证签发 / 确认 / GET me 缺 / 失效 token MUST 折叠为 401（沿用既有 authed 守卫，不暴露额外状态）。
- **FR-S06**: 限流 — 凭证签发 + 确认 MUST 复用既有 `@nestjs/throttler` per-account 限流；超限 429 + `Retry-After`；限流在加载账号之前消费。
- **FR-S07**: 访问模型 — 图片 bucket public-read（per ADR-0045 §3）+ referer 防盗链兜底；写仅经 §FR-S02 签名上传（公开可读 ≠ 公开可写）。
- **FR-S08**: 旧资产处置 — 更新 URL 字段为覆盖语义；旧 OSS object 的清理（是否异步删 / 留存）留 plan（默认不阻塞主流程）。

### Client Functional Requirements

- **FR-C01**: 头像 / 背景图入口（002 profile hero 头像·背景图 + 007 资料卡头像·背景图行）点击 MUST 弹 action sheet：「更换」/「查看」/「取消」（参考设计图二）。
- **FR-C02**: 选图层 MUST web/app 分叉（per ADR-0045 §5）—— app=`expo-image-picker`（相册 + 相机 + 原生裁剪）；web=`<input type=file accept=image/*>` + JS 裁剪；头像 1:1、背景宽幅。web MUST NOT 显示「拍照」、MUST NOT 依赖权限请求（native-only）/ cancel 回调挂 UI。
- **FR-C03**: 上传层 MUST web/app 统一 —— 选图 → client resize/compress → 要一次性凭证 → 直传 OSS → 用 object key 通知后端确认。上传中 MUST 有忙态 / 进度，重复触发忽略（busy 单源）。
- **FR-C04**: 上传成功后 MUST 把真实图接入显示：002 profile hero 头像 / 背景图从 emoji / 占位翻为真实图（仅翻 `onAvatarPress` / `onBackgroundPress` 的 noop + 渲染源，**不重设计 hero 布局**）；007 资料卡对应行显示缩略图；缩略尺寸经 OSS IMG 派生。
- **FR-C05**: 「查看大图」MUST 全屏展示当前头像 / 背景图原图；未设图时的处理（置灰 / 占位）由 plan 定。
- **FR-C06**: 账号 `avatarUrl` / `backgroundImageUrl` 为 null 时 MUST 回落 002 既有 emoji / 占位（002 行为不回归）。
- **FR-C07**: 失败处理 — 凭证 / 直传 / 网络失败 MUST 友好提示且 profile **不脏写**（仅直传成功 + 后端确认后才显示新图）。
- **FR-C08**: client MUST 先行拦截非图片类型 / 超 size（content-type / size），与后端二次校验互为兜底。

### Key Entities

- **Account（既有，扩展）**：新增可空 `avatarUrl` + `backgroundImageUrl`（OSS public-read URL）。复用既有 `displayName`（hero 展示）/ `phone`。
- **OSS Object（外部，非 DB 实体）**：图片二进制存 Aliyun OSS，key 含本账号 scope 前缀；URL 落 Account 字段。缩略图为同一 object 经 OSS IMG 即时派生（不入库多份）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 上传凭证签发 —— authed 请求 → 返回 scope 到本账号 key 前缀 + content-type 白名单 + size 上限 + 短时效的一次性凭证；缺 token → 401；超限 → 429（Testcontainers IT 逐字段断言）。
- **SC-002**: 确认落库 —— 合法 object key 提交 → 200、`avatarUrl` / `backgroundImageUrl` 持久化、GET me 回读；不属本账号前缀 / 非法 key → 拒（4xx，不落库、不越权）；缺 token → 401。
- **SC-003**: web 换图全链 —— Playwright Expo Web：点头像 / 背景图 → action sheet「更换」→ `<input type=file>` 注入测试图 → 裁剪 → mock 凭证 + mock OSS PUT + mock 确认 200 → profile hero 显示真实图（非 emoji）。
- **SC-004**: 显示接入 —— seed `avatarUrl` / `backgroundImageUrl` → profile hero 渲染真实图、007 资料卡显示缩略；null 时回落 002 emoji / 占位（不回归）。
- **SC-005**: 查看大图 —— action sheet「查看」→ 全屏展示当前原图、可返回。
- **SC-006**: native 选图路径覆盖缺口已显式标注 —— `expo-image-picker` 相册 / 相机 / 原生裁剪为设备 / 手动验证（无 web e2e），spec / plan 明记此覆盖边界（不假装 web e2e 覆盖了 native picker）。
- **SC-007**: 架构断言 —— 后端 0 代理图片字节（上传走 client 直传 OSS）；图片读经 OSS public-read URL（per ADR-0045，CI / review 断言无后端图片代理路径）。

## Assumptions

- 架构（OSS / 直传 / public-read / OSS IMG / web·app 分叉）遵 ADR-0045，本 spec 不重新决策；凭证原语 / 备案·CDN / bucket 布局 / 裁剪库为 plan 决策。
- 002 profile hero 的 `onAvatarPress` / `onBackgroundPress` 当前接 `noop`、已留 `accessibilityHint="点击更换"`；本 feature 翻这两个 noop + 渲染源，不重设计 hero 布局（占位 UI 4 边界沿用）。
- 007 已 ship 头像 / 背景图占位行（已在 main）；本 feature 翻为 active。
- 头像 1:1、背景图宽幅；iOS picker 裁剪恒方形的限制由显示端 framing 或独立裁剪兜（plan 定），不阻塞本 spec。
- 视觉精确值（hero 尺寸 / 圆角 / action sheet 样式 / 查看大图转场）留 mockup 回填 plan.md UI 段。

## Out of Scope

- **微信 / google / QQ / Apple / 小米 等第三方绑定** —— 另起 spec。
- **个人简介 bio 编辑（007 已含）/ 昵称编辑 / 性别编辑** —— 非本 feature。
- **删除 / 恢复默认头像 · 背景图** —— 设计图二 action sheet 仅「更换 / 查看 / 取消」，无删除项；恢复默认非本期。
- **视频 / 其他 blob / 断点续传 / 分片上传** —— 本 feature 仅 profile 小图片。
- **ADR-0045 Open Questions 的实现细节决策**（凭证原语 STS/signed-PUT/PostObject、自定义域名 + ICP 备案 + CDN、bucket 布局 / key 命名、具体裁剪 / 压缩库选型、上传凭证签发 use case 的 account vs security bounded context 落点、旧 object 清理策略）—— 留 plan.md。
- **profile 资料其余行**（性别 / 二维码名片等）—— 非本 feature。
