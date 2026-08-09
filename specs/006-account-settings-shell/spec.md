---
feature_id: 006-account-settings-shell
modules: [account, auth]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-29'
updated_at: '2026-05-29'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: stub
web_compat_notes: '纯 mobile feature、无 server 改动（壳是导航容器，复用已 ship 端点）。Expo Web export 路径将由本 feature 的 Playwright e2e（settings 导航 + 退出登录全链）首次冒烟 —— 绿后 web_compat 升 full。无新增 server 端点（退出登录复用 003 #196 logout-all）。'
agent_friction_observed: false
state_branches:
  - 'enter-settings: 已登录用户在「我的」页点 ⚙️ → push /(app)/settings；route 在 (tabs) 之外 → 底 tab bar 自动隐藏；返回「我的」→ 底 tab 恢复'
  - 'nav-account-security: settings 首页点「账号与安全」→ push 二级页；其余分组行（通用/通知/隐私/关于/切换账号）disabled 不导航'
  - 'logout-confirm: 点「退出登录」→ 确认对话（Web window.confirm / native Alert.alert）→ 确认 → logout-all（撤所有 refresh token）→ 清本地会话 → AuthGate 观察 isAuthenticated 翻转 → 回登录页'
  - 'logout-server-fail: logout-all server 调用失败 → wrapper finally 仍无条件清本地会话 → 用户仍被登出并回登录页（残留 server 记录自过期）'
  - 'disabled-placeholder: 账号与安全页「登录管理」/「注销账号」行本 feature 为 disabled 占位（视觉灰置 + 不可点 + 不导航到未建 route）；后续 device-management(amend 005) / account-deletion settings 入口(amend 004) feature 各自把对应行翻为真实 push'
  - 'phone-masked: 账号与安全页「手机号」行展示脱敏号（+86 1XX****XXXX），本 feature disabled（手机号详情/换绑页为独立未来 feature）；完整号码不出现在任何屏幕'
  - 'unauthed: 未登录访问 /(app)/settings/* → AuthGate 第一层拦截回登录（既有机制，本 feature 不重立）'
---

# Feature Specification: Account Settings Shell（设置 / 账号与安全 导航壳 — A→B→C 链的 B）

> ⚠️ **[CLIENT PARADIGM (2026-05-29)]**
> 纯 mobile feature（**无 server 改动**）。按 Strangler-Fig port 范式实现：复用皮（`~/theme` + `~/ui`）、port 旧 app 设置屏结构、import remap 到 mono（[ADR-0030](../../docs/adr/0030-package-decomposition.md) 包 5→2 内联）。类 1 标准 UI（[sdd.md](../../docs/conventions/sdd.md)）—— 本 spec 产出业务流 + 占位结构，视觉精确值（px / hex / 阴影 / 动画）留 PHASE 2 mockup 回填 plan.md UI 段。占位 UI 4 边界：新增 list-card primitives 落 app-local `apps/mobile/src/settings/`，**不进 `~/ui`**。

**Feature Branch**: `006-account-settings-shell`
**Created**: 2026-05-29
**Status**: Draft（clean-room mode-1a：源 `002-account-profile` spec 内部 A→B→C 链定义 + 旧 app `apps/native/app/(app)/settings/` 设置屏结构净室提取；旧栈 anchor 0 残留；spec-merge 约束留 `/speckit-clarify` 收敛）
**Module**: `account` + `auth`（client 导航壳，聚合账号与安全入口；退出登录复用 `auth` 的 logout-all。无 server 端点）
**Input**:

- 前端有一条**正交后端 16 use case 迁移**的 client UI 拆分链 A→B→C，定义在 `002-account-profile` spec 内部：A=002「我的」页（⚙️ 已 `router.push('/(app)/settings')` 占位、目标 route 未建、靠 Expo Router 容错不 crash）；**B=本 feature**（settings 导航壳）；C=注销/解封屏（cancel-deletion + FROZEN modal 已随 004 ship，注销发起屏延后）。
- 003（登出 #196）/ 004（注销发起屏 #198）/ 005（登录设备管理屏 #201）三个 feature 的 client 入口都已 **server-ready**、都延后挂这个壳。本 feature = 补这条链的 B，**解锁 002 ⚙️ 入口**，并以 disabled 占位预留 004/005 的激活点。
- port 源：旧 app `~/Documents/projects/no-vain-years/no-vain-years-app/apps/native/app/(app)/settings/{index,account-security/index}.tsx` + `components/settings/primitives.tsx`（`Card`/`Row`/`Divider`），import remap `@nvy/auth`→`~/auth`、`@nvy/design-tokens`→`~/theme`。

## Context

- **路由落点（per 002 CL-006）**：settings stack 落 `apps/mobile/app/(app)/settings/*`，在 `(app)/(tabs)/` **之外** —— Expo Router 默认在 `(tabs)` 之外的 stack 自动隐藏底 tab bar；返回「我的」页后底 tab 恢复。这是结构性路由决策（非手动 hide/show flag）。

- **入口拓扑**：A→B 入口 = 「我的 → ⚙️ → 设置」；A→C 入口经 B 中转（账号与安全 → 注销账号）。本 feature 把 002 的 `router.push('/(app)/settings')` 占位（强转 `as Parameters<...>`，目标 route 未建）落成真实 route。

- **退出登录复用 logout-all（003 #196 已 ship）**：`apps/mobile/src/auth/logout-all.ts` 的 `logoutAll(): Promise<void>` 已实现 —— 调 server logout-all 端点撤销该账号所有 refresh token，**无论 server 成功与否，`finally` 无条件清本地会话**；**该 wrapper 不导航**，由 AuthGate 观察 `isAuthenticated` 翻转后路由回登录。本 feature 仅加可见的「退出登录」按钮 + 确认交互调用它（003 spec 明示「可见登出控件随 settings shell 落地」）。

- **Web 确认对话陷阱（必 port）**：`react-native-web` 的 `Alert.alert` fallback 到单按钮 `window.alert`，`buttons` 数组被完全忽略 → `onPress` 永不 fire（用户点「退出登录」看着「没反应」）。Web 必须显式走 `window.confirm` 拿 yes/no；Native（iOS/Android）走 `Alert.alert`。此 Platform 分支是 load-bearing。

- **disabled 占位的两类**：
  - **本 feature 永久不做**（各自独立未来 feature）：通用 / 通知 / 隐私与权限 / 关于 / 切换账号 / 手机号详情换绑 / 实名认证 / 第三方账号绑定 / 安全小知识 / 法务页脚 —— 法务页脚**直接省略**（不渲染，避免 dangling route），其余渲染为视觉灰置不可点行。
  - **后续 feature 激活点**：登录管理（device-management，amend 005）/ 注销账号（account-deletion settings 入口，amend 004）—— 本 feature 渲染为 disabled 占位行，对应 feature ship 时把该行从 disabled 翻为真实 `router.push`（一行 flip = 集成点）。

- **横切复用（不重立）**：AuthGate 第一层鉴权（`!authed → /(auth)/login`）/ `useAuthStore`（读 `phone` / `displayName` / `clearSession`）/ `~/ui`（`Button` / `SafeAreaView` 等）/ `~/theme` tokens 均已就位；本 spec 引用，不重新建立。

- **新增制品**：app-local list-card primitives（`Card` / `Row` / `Divider`，落 `apps/mobile/src/settings/primitives.tsx`，**不进 `~/ui`** per 占位 UI 4 边界）+ 纯逻辑 util `maskPhone`（`apps/mobile/src/format/phone.ts`，脱敏手机号，logic → vitest）。

## Clarifications

### Session 2026-05-29

- Q: 本计划内延后到 B2/B3 的两行（「登录管理」/「注销账号」）在 B1 壳里怎么呈现？ → A: **B1 即渲染为 disabled 占位**（视觉灰置不可点），B2(device-management amend 005) / B3(account-deletion settings 入口 amend 004) ship 时把对应行从 disabled 翻为真实 `router.push`（单行 flip = 集成点）。IA 在 B1 一次成型，后续 feature 改动最小。（见 FR-C09）
- 验证（codebase grep，非 user 问答）：`maskPhone` 规范格式 = `<国码> <前3位>****<后4位>`（如 `+86 139****9000`，中段星号 ≥ 4）；`null`/空/越界/国码不在白名单 → `未绑定`（authed 用户注册必填 phone，该 fallback 为安全兜底，per 002「`Account.phone` 注册即必填」）。
- 验证（codebase grep）：settings stack 用 Expo Router **native Stack header**（`headerShown: true` + title「设置」/「账号与安全」+ 系统返回键），非自定义 in-page header；底 tab bar 因落 `(tabs)` 之外自动隐藏（per 002 CL-006）。

## User Scenarios & Testing _(mandatory)_

> 纯 mobile feature（无 server 改动）。所有 user story 为 [Mobile] 层；验证走 Playwright Expo Web e2e（导航 / 渲染 / 登出全链）+ vitest（`maskPhone` 纯逻辑），per mono 测试分层。

### User Story 1 — [Mobile] 从「我的」页进入设置壳，底 tab 自动隐藏（Priority: P1）

已登录用户在「我的」页点右上角 ⚙️ → 进入「设置」首页，看到分组卡片列表；进入后底部 tab bar 隐藏（沉浸专注），点返回回到「我的」页、底 tab 恢复。

**Why this priority**: A→B 链的解锁动作 —— 把 002 的 ⚙️ 占位落成真实导航，是本 feature 单一最高价值；所有其他设置入口都挂在此壳下。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进「我的」页 → 点 ⚙️ → 断言 URL 进 `/(app)/settings`、settings 首页卡片渲染、底 tab bar 不可见 → 点返回 → 断言回「我的」页、底 tab bar 恢复。

**Acceptance Scenarios**:

1. **Given** 已登录用户在「我的」页，**When** 点右上角 ⚙️，**Then** 进入 `/(app)/settings` 设置首页，渲染分组卡片（账号与安全 / 通用·通知·隐私·关于 / 切换账号·退出登录），底部 tab bar 不可见
2. **Given** 在设置首页，**When** 点系统返回 / 返回手势，**Then** 回到「我的」页，底部 tab bar 恢复可见
3. **Given** 002 profile 页的 ⚙️ 按钮，**When** 本 feature ship 后点击，**Then** 进入真实 settings 页面（不再依赖 Expo Router 对未建 route 的容错）

---

### User Story 2 — [Mobile] 账号与安全二级页导航 + 手机号脱敏展示（Priority: P1）

用户在设置首页点「账号与安全」→ 进入二级页，看到账号相关入口列表（手机号脱敏值、登录管理、注销账号等）；脱敏号展示但完整号码不外露。

**Why this priority**: 账号与安全是壳下唯一真实分组，也是 004/005 延后入口的挂载页；手机号脱敏是隐私基线。

**Independent Test**: Playwright Expo Web；seed 已登录态（store `phone=+8613900139000`）→ 进设置首页 → 点「账号与安全」→ 断言 URL 进 `/(app)/settings/account-security`、手机号行展示脱敏值（`+86 139****9000` 类）且不含完整号、登录管理 / 注销账号行渲染为 disabled 占位。

**Acceptance Scenarios**:

1. **Given** 在设置首页，**When** 点「账号与安全」，**Then** push 进 `/(app)/settings/account-security` 二级页（底 tab 仍隐藏），渲染分组行
2. **Given** store 中 `phone=+8613900139000`，**When** 账号与安全页渲染，**Then** 「手机号」行展示脱敏 `+86 139****9000`，完整号码不出现在任何字段；该行本 feature disabled（不导航）
3. **Given** 账号与安全页，**When** 渲染「登录管理」「注销账号」行，**Then** 二者为 disabled 占位（视觉灰置、不可点、不导航）

---

### User Story 3 — [Mobile] 退出登录（Priority: P1）

用户在设置首页点「退出登录」→ 弹确认 → 确认后撤销所有会话并清本地登录态 → 回到登录页。

**Why this priority**: 003 #196 logout-all 的可见入口落地点（server 已 ship、就等这个按钮）；用户安全自助的核心动作。

**Independent Test**: Playwright Expo Web；seed 已登录态 → 进设置首页 → 点「退出登录」→（Web）`window.confirm` 确认 → mock `POST /accounts/logout-all` 204 → 断言本地会话清除 + 落到 `/(auth)/login`；另测 mock logout-all 500 → 仍落到登录页（本地已登出）。

**Acceptance Scenarios**:

1. **Given** 已登录用户在设置首页，**When** 点「退出登录」并在确认对话点「确定」，**Then** 调用 logout-all 撤销所有 refresh token、清本地会话，用户被带回登录页
2. **Given** 确认对话已弹出，**When** 点「取消」，**Then** 关闭对话、保持登录态、停留在设置首页
3. **Given** 点「退出登录」并确认，**When** server logout-all 调用失败，**Then** 用户**仍**被登出（本地会话无条件清除）并回登录页（残留 server 记录自过期）
4. **Given** Web 平台，**When** 点「退出登录」，**Then** 确认走 `window.confirm`（非被忽略的 `Alert.alert` 单按钮 fallback），确认后登出生效

### Edge Cases

- 未登录直接访问 `/(app)/settings/*` → AuthGate 第一层拦截回登录（既有机制，不重立）。
- 重复快速点「退出登录」→ in-flight 期间忽略二次触发（busy 态），不重复发起。
- disabled 占位行被点击 → 无任何导航 / 无 crash（不跳未建 route）。
- 账号与安全页「登录管理」/「注销账号」在对应后续 feature 未 ship 前保持 disabled；ship 后翻为真实 push（向前兼容设计点）。

## Requirements _(mandatory)_

> 纯 client 层，编号沿 002/004 双层约定的 client 段 `FR-C` 前缀（本 feature 无 server 层 FR-S）。

### Functional Requirements

- **FR-C01**: 系统 MUST 在 `apps/mobile/app/(app)/settings/*`（`(tabs)` 之外）提供 settings 导航栈（Expo Router native Stack header：title「设置」/「账号与安全」+ 系统返回键）；进入任一 settings 页时底部 tab bar 不可见，经系统返回键回「我的」页后恢复（per 002 CL-006）。
- **FR-C02**: 「我的」页 ⚙️ MUST 导航到真实 settings 首页（落成 002 占位 `router.push('/(app)/settings')` 的目标）。
- **FR-C03**: settings 首页 MUST 渲染分组卡片：①「账号与安全」（真实可点 → push 二级页）②「通用」/「通知」/「隐私与权限」/「关于」（disabled 占位）③「切换账号」（disabled）+「退出登录」（destructive，可点）。法务页脚 MUST NOT 渲染（独立未来 feature，避免 dangling route）。
- **FR-C04**: 账号与安全页 MUST 渲染：①「手机号」（展示 `maskPhone` 脱敏值，本 feature disabled）/「实名认证」/「第三方账号绑定」（disabled 占位）②「登录管理」（disabled 占位，device-management feature 激活）③「注销账号」（destructive，disabled 占位，account-deletion settings 入口 feature 激活）/「安全小知识」（disabled）。
- **FR-C05**: 「退出登录」MUST 先弹确认对话（Web 走 `window.confirm`、Native 走 `Alert.alert`），用户确认后 MUST 调用既有 `logoutAll()` wrapper；取消则保持登录态。
- **FR-C06**: 退出登录后用户 MUST 被带回登录页且本地会话已清除；server logout-all 调用失败时 MUST 仍完成本地登出（复用 wrapper 的 `finally` 无条件清会话语义）。
- **FR-C07**: 手机号 MUST 以脱敏格式（`<国码> <前3位>****<后4位>`，中段星号 ≥ 4，如 `+86 139****9000`）展示；号码缺失/不可解析时显示 `未绑定`；完整号码 MUST NOT 出现在任何屏幕字段。
- **FR-C08**: disabled 占位行 MUST 视觉灰置、不可交互、点击不触发导航或崩溃，MUST NOT 导航到尚未建立的 route。
- **FR-C09**: 「登录管理」「注销账号」行 MUST 设计为后续 feature 的激活点 —— device-management（amend 005）/ account-deletion settings 入口（amend 004）ship 时把对应行从 disabled 翻为真实 `router.push`（单行 flip 集成）。
- **FR-C10**: settings / account-security 路由 MUST 受 AuthGate 第一层鉴权保护（未登录 → 回登录）；本 feature 复用既有机制，不重立鉴权逻辑。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户从「我的」页 2 次点击内到达「账号与安全」页（⚙️ → 账号与安全）。
- **SC-002**: 进入任一 settings 页时底部 tab bar 不可见；返回「我的」页后 100% 恢复可见。
- **SC-003**: 退出登录后用户 100% 落到登录页且本地会话已清除（再次冷启不自动进 app）—— 含 server 失败场景。
- **SC-004**: 所有范围外 / 占位入口（通用·通知·隐私·关于·切换账号·手机号·实名·第三方·登录管理·注销账号·安全小知识）点击 0 导航错误 / 0 崩溃。
- **SC-005**: 手机号 100% 脱敏展示，完整 11 位号码不出现在任何屏幕。
- **SC-006**: 002 profile 页 ⚙️ 点击进入真实 settings 页面（不再依赖 Expo Router 对未建 route 的容错）。

## Assumptions

- AuthGate 第一层鉴权（`!authed → /(auth)/login`）已存在，settings 路由继承保护，本 feature 不重立（per 002 FR-028）。
- `logoutAll()` wrapper（003 #196）已 ship，本 feature 仅加可见入口 + 确认交互。
- `useAuthStore` 已暴露 `phone` / `clearSession`，本 feature 读 `phone` 渲染脱敏行、登出经 wrapper 调 `clearSession`。
- `maskPhone`（`apps/mobile/src/format/phone.ts`）+ list-card primitives（`Card`/`Row`/`Divider`，`apps/mobile/src/settings/primitives.tsx`）为本 feature 新增；primitives 因占位 UI 4 边界保持 app-local，不进 `~/ui`。
- 视觉精确值（间距 / 色值 / 阴影 / 动画）走类 1 mockup 阶段回填 plan.md UI 段；本 spec 仅业务流 + 占位结构（旧 app 设置屏已是成熟视觉，port 时复用 `~/theme` token，不重设计）。
- 手机号详情/换绑、实名、第三方绑定、通用/通知/隐私/关于、安全小知识、法务页脚 均为独立未来 feature，本 feature 不含。

## Out of Scope

- 任何 server 改动（壳是导航容器，复用已 ship 端点）。
- 登录设备管理屏本体（device-management，amend 005，本 feature 仅留 disabled 占位激活点）。
- 注销账号发起屏本体（account-deletion settings 入口，amend 004，本 feature 仅留 disabled 占位激活点）。
- 手机号详情/换绑页、实名认证、第三方账号绑定、通用/通知/隐私与权限/关于详情页、安全小知识、法务页脚（《个人信息收集与使用清单》/《第三方共享清单》）—— 各自独立未来 feature。
- 类 1 阶段 2 mockup 的视觉精确还原（本 feature 占位结构 + 业务流；mockup 回填 plan UI 段后落地）。
