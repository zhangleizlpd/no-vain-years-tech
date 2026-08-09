---
feature_id: 010-wechat-account-binding
modules: [account, auth, security]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-30'
updated_at: '2026-05-31'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: stub
web_compat_notes: '解绑流（短信验证码）完全真实、web 全链可测（复用 004 delete-account SMS 范式，无需微信）。绑定流的「唤起微信授权」经 port 抽象：Phase 1 = stub adapter（确定性假 openid，web Playwright 全链覆盖 bind→显示解绑）；Phase 2 = 真实 native 微信 SDK（设备专属，无 web 等价）。production web 端微信绑定（扫码 / H5 OAuth）不在本 spec —— web 仅用 stub 覆盖 e2e，真实绑定目标为 native app。'
agent_friction_observed: false
state_branches:
  - 'bind-stub(P1): 未绑定用户点 007 微信行「绑定」→ 经微信授权 port（Phase 1 = stub 返回确定性假 openid）→ 调 bind 端点创建 账号↔openid 绑定 → 行翻「解绑」'
  - 'bind-conflict: 目标 openid 已绑**他**账号 → 拒 + 明确提示「该微信已绑定其他账号」（不泄露他账号信息）；已绑**本**账号 → 幂等无副作用'
  - 'unbind-confirm: 已绑定用户点「解绑」→ 确认对话（图三「确定要解除微信绑定?」取消/确定，web `window.confirm` / native `Alert.alert`，复用 006 logout 范式）→ 确定 → push 解绑验证页'
  - 'unbind-send-code: 解绑验证页（图四改造）→ 发码：已绑微信的 ACTIVE 账号请求 → 生成一次性 6 位码单向哈希入库 1 条 AccountSmsCode（purpose=UNBIND_WECHAT、10min、usedAt 空）→ 下发短信到账号手机号；不改绑定、不发事件（复用 004 send-deletion-code 范式）'
  - 'unbind-verify(P1): 输手机验证码（非密码，复用 SmsInput + RHF+zodResolver delete-account 范式）→ 提交 → 单原子事务标记码已用 + 删绑定 → 成功返回、行翻「绑定」；码失败 4 分支折叠字节级一致 401（反枚举，复用 004）；并发恰一次'
  - 'bind-real(P2): 真实 native 微信 SDK（expo config plugin + custom dev client + 开放平台 AppID）`sendAuthRequest` → 授权 code → 服务端用 AppID/AppSecret 调微信 API 换 openid/unionid → 接入 bind port（替换 stub）；设备专属'
  - 'no-backfill: 绑定成功 MUST NOT 改账号 displayName / 头像（绑定只建 账号↔openid 关系；头像归 008、昵称归 onboarding/002）'
  - 'unauthed: 未登录访问绑定 / 解绑入口或端点 → AuthGate / authed 守卫拦截（既有机制，不重立）'
---

# Feature Specification: WeChat Account Binding（微信账号绑定 / 解绑 — 端口桩接 + 短信验证码解绑，两阶段）

> ⚠️ **[FULL-STACK · PHASED (2026-05-30)]**
> Server + Mobile + Contract 三层；**两阶段**（用户拍板「桩 vs 真 SDK」分期）：
> **Phase 1** = 完整 bind + unbind 全链（server 绑定生命周期 + 冲突/反枚举 + 解绑短信流 + mobile 入口/确认框/解绑验证页）走**微信授权 port 桩接**（唤起返回确定性假 openid）—— web Playwright **全链可测**、可独立交付。
> **Phase 2** = 把**真实 native 微信 SDK**（开放平台注册 + config plugin + custom dev client + 服务端 code↔openid 交换）接入同一 port，替换 stub —— **设备专属**、无 web e2e。
> 本 spec 是**账号绑定**（已登录账号关联微信），**不是「微信登录」**（微信作登录方式另议）。范围**仅微信**（google 保持 007 占位）。**实现排在 007 之后**（翻 007 微信占位行）。

**Feature Branch**: `010-wechat-account-binding`
**Created**: 2026-05-30
**Status**: Draft
**Module**: `account` + `auth` + `security`（绑定关系 = account 数据；bind/unbind 编排 = auth；UNBIND_WECHAT 短信码 crypto/store = security。最终各 use case bounded context 落点留 plan 按 [server-bounded-context-catalog](../../docs/conventions/server-bounded-context-catalog.md) + 两段式委托 [ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) §3a 决）
**Input**:

- 微信账号绑定/解绑（来自设计图 1-4）：未绑定行「绑定」→ 唤起微信授权（图二 允许/拒绝）→ 允许 → 绑定；已绑定行「解绑」→ 确认对话（图三）→ 解绑验证页（图四，**输手机验证码非密码**）→ 解绑。
- 微信行入口 = 007 已 ship 的占位行（本 feature 翻 active，按绑定状态显示「绑定」/「解绑」）。
- 微信绑定/解绑均为 greenfield（仓内 0 微信/OAuth 设施；`Credential.type` / `RefreshToken.loginMethod` 仅有 `WECHAT` 字面量无实现）；解绑短信复用既有 `AccountSmsCode`（purpose 物理隔离）+ 004 delete-account SMS 范式。

## Context

- **两阶段（端口桩接）**：bind 流的「微信授权」步抽象为 **port**（解析出 openid 的能力）。Phase 1 提供 **stub adapter**（确定性假 openid，不调真微信）—— 让 bind→server 落绑定→mobile 显示「解绑」全链在 web Playwright 可测、可先交付。Phase 2 提供 **real adapter**（native `expo` 微信 SDK 唤起 → 授权 code → 服务端 AppID/AppSecret 调微信 API 换 openid/unionid），替换 stub、设备验证。port 形状/落点（client 唤起 + server 交换的边界）留 plan。

- **解绑 = 短信验证码（复用 004，非密码）**：图四原「牛牛账号登录密码」输入 → 改为**手机验证码**。复用既有 `AccountSmsCode`（新增 `purpose=UNBIND_WECHAT`、物理隔离）+ 004 的 send-code / verify+act 两端点范式 + 单向哈希 + 恰一次事务 + 反枚举字节级一致 401 + `SmsInput` UI + RHF+zodResolver（delete-account 范式）。解绑两段式：发码（authed，不改状态）→ 验码+删绑定（authed，原子）。

- **绑定冲突规则**：一 openid ↔ **至多一账号**（openid 全局唯一）。绑定时目标 openid 已绑**他**账号 → 拒 + 明确提示（不泄露他账号信息）；已绑**本**账号 → 幂等无副作用。解绑后可重绑。账号恒有手机号（002 注册必填）故解绑后账号仍可登录、解绑总安全。

- **不回填（用户已定）**：绑定成功只建 账号↔微信 openid/unionid 关系，**不改** profile 的 displayName / 头像（头像归 008、昵称归 onboarding/002）—— 绑定 ≠ 改资料。

- **web 边界（诚实标注）**：解绑流（短信）完全真实、web 可测。绑定流的微信唤起在 web 上无 native 等价 —— Phase 1 web 用 stub 覆盖 e2e；**production web 端真实微信绑定（扫码 / H5 OAuth）不在本 spec**，真实绑定目标为 native app（iOS/Android）。

- **横切复用（不重立）**：007 微信占位行（翻 active）；004 delete-account 的 SMS 全套（`AccountSmsCode` + send/verify 范式 + `SmsInput` + `deletion-code.store` 范式）；006 确认对话范式（web `window.confirm` / native `Alert.alert`）；authed 守卫；throttler 限流；anemic Prisma row + `@map`。

- **依赖与顺序**：依赖 **007**（微信占位行）；复用 **004**（SMS 范式）/ **002**（账号 profile）。**实现排在 007 之后**；PR 栈在 007 之上（007 先合，本 feature rebase 到 main）。**独立于 008**（无图片/对象存储）。

## Clarifications

### Session 2026-05-30

- Q: 009 内部 1/2 阶段怎么划？ → A: **按「桩 vs 真 SDK」分** —— Phase 1 = 完整 bind+unbind 全链走 port 桩接（web 全测）；Phase 2 = 真实 native 微信 SDK 接入 port（设备验证）。
- Q: 绑定成功后微信昵称/头像是否回填 profile？ → A: **不回填**（只建 账号↔openid 关系）。
- 已定边界（informed default，未反对）：本 spec = 绑定/解绑（非微信登录）；范围仅微信（google 保持占位）；一 openid↔至多一账号（冲突拒）；解绑用短信验证码（复用 004）。

## User Scenarios & Testing _(mandatory)_

> Server 走 Testcontainers IT（绑定创建/冲突 / 发码 / 验码删绑定 / 反枚举 / 限流 / 并发恰一次）；Mobile 走 Playwright Expo Web e2e（**Phase 1 stub**：bind→显示解绑 全链；unbind 短信全链）+ vitest（纯逻辑）。**Phase 2** 真实微信唤起为设备/手动验证（无 web e2e，标注覆盖缺口）。Contract 经 swagger → api-client regen。

### User Story 1 — [Server] 绑定创建 + 冲突规则（Phase 1，Priority: P1）

已登录用户经微信授权（Phase 1 = stub 解析出 openid）创建 账号↔微信 绑定；目标 openid 已绑他账号则拒。

**Why this priority**: 绑定能力的服务端落点与唯一性闸；冲突规则是数据完整性核心。

**Independent Test**: Testcontainers；authed + stub openid `wx_test_1` → 调 bind → 断言 201、绑定关系落库（accountId↔openid、boundAt）、账号 profile（displayName/头像）**不变**；同 openid 再绑**他**账号 → 拒（明确错误码，不泄露他账号）；同 openid 再绑**本**账号 → 幂等无副作用；缺 token → 401。

**Acceptance Scenarios**:

1. **Given** ACTIVE 账号 + 有效 token + 未绑微信，**When** 经授权 port 拿到 openid 调 bind，**Then** 201、创建绑定（account↔openid，记 boundAt、可选 unionid）；账号 displayName/头像不变
2. **Given** openid 已绑**他**账号，**When** 本账号绑同 openid，**Then** 拒（明确错误「该微信已绑定其他账号」，不泄露他账号身份）
3. **Given** openid 已绑**本**账号，**When** 重复绑，**Then** 幂等（无重复绑定、无副作用）
4. **Given** 缺/失效 token，**When** 调 bind，**Then** 401

---

### User Story 2 — [Server] 解绑发码 + 验码解绑（Phase 1，Priority: P1）

已绑微信用户发起解绑：系统下发短信验证码到账号手机号；验码通过则原子删除绑定关系。

**Why this priority**: 解绑的身份校验闸（短信码证明手机持有），防会话被盗后任意解绑；复用 004 范式的安全保证。

**Independent Test**: Testcontainers；已绑微信 ACTIVE 账号 authed 发码 → 断言 204、DB 落 1 条 active `UNBIND_WECHAT` 码（哈希入库、10min、usedAt 空）、绑定不变、无事件；持有效码提交 → 单事务标记码已用 + 删绑定、返成功；码失败 4 分支（未找/哈希/过期/已用）字节级一致 401；并发同码提交恰 1 次成功；未绑微信发码 → 反枚举折叠响应。

**Acceptance Scenarios**:

1. **Given** 已绑微信 + ACTIVE + authed，**When** 请求解绑发码，**Then** 204、落 1 条 active UNBIND_WECHAT 码（单向哈希、10min）、下发短信到账号手机号、绑定不变、无事件
2. **Given** 持有效 UNBIND_WECHAT 码 + 正确码值 + 已绑微信，**When** 提交验码解绑，**Then** 单原子事务标记码已用 + 删绑定关系，返成功；账号其他状态不变
3. **Given** 码失败 4 分支（未找/哈希不符/过期/已用），**When** 提交，**Then** 字节级一致 401（反枚举，复用 004）；请求体 code 缺失/非 `\d{6}` → 400 校验错误
4. **Given** 同一解绑码并发提交，**When** 多请求，**Then** 恰 1 次解绑成功（其余安全失败）；不双删、不重复发事件
5. **Given** 未绑微信/账号异常发码，**When** 请求，**Then** 反枚举折叠响应（不暴露绑定/账号状态）；per-account 1/60s 限流，超限 429

---

### User Story 3 — [Mobile] 绑定入口（007 微信行翻 active，Phase 1 stub）（Priority: P1）

007 账号与安全页微信行按绑定状态显示「绑定」/「解绑」；未绑定点「绑定」→ 唤起微信授权（Phase 1 = stub）→ 绑定成功 → 行翻「解绑」。

**Why this priority**: 把 007 微信占位翻 active 的用户入口；bind 主路径。

**Independent Test**: Playwright Expo Web（Phase 1 stub）；seed 未绑微信 → 进 007 账号与安全页 → 断言微信行显示「绑定」→ 点击 → stub 授权 → mock bind 201 → 断言行翻「解绑」。

**Acceptance Scenarios**:

1. **Given** 未绑微信账号，**When** 账号与安全页渲染，**Then** 微信行显示「绑定」（007 占位翻 active）
2. **Given** 点「绑定」，**When**（Phase 1）经 stub 授权 port 拿到假授权，**Then** 调 bind 端点 → 成功 → 行翻「解绑」
3. **Given** openid 已绑他号，**When** 绑定，**Then** 明确提示「该微信已绑定其他账号」、行保持「绑定」
4. **Given** 授权/网络失败，**When** 绑定中断，**Then** 友好提示、状态不脏写

---

### User Story 4 — [Mobile] 解绑流（确认对话 + 短信验证码页，Phase 1）（Priority: P1）

已绑微信点「解绑」→ 确认对话（图三）→ 确定 → 解绑验证页（图四，输手机验证码）→ 解绑成功、行翻「绑定」。

**Why this priority**: 解绑主路径；把图四的密码输入改造为短信验证码（用户明确要求）。

**Independent Test**: Playwright Expo Web；seed 已绑微信 → 进账号与安全页 → 微信行显示「解绑」→ 点击 → 确认对话「确定要解除微信绑定?」→ 确定 → 进解绑验证页 → 发码（mock 204）→ 输码 → 提交（mock 解绑成功）→ 断言返回、行翻「绑定」；确认对话点「取消」→ 留原页、仍绑定。

**Acceptance Scenarios**:

1. **Given** 已绑微信账号，**When** 账号与安全页渲染，**Then** 微信行显示「解绑」
2. **Given** 点「解绑」，**When** 弹确认对话「确定要解除微信绑定?」（web `window.confirm` / native `Alert.alert`），**Then** 点「确定」→ push 解绑验证页；点「取消」→ 留原页、仍绑定
3. **Given** 解绑验证页（标题「账号解绑」+「您正在申请解除微信绑定，需验证以下身份」），**When** 渲染，**Then** 展示**手机验证码输入**（非密码，复用 `SmsInput`）+ 发码按钮 + 解绑提交按钮
4. **Given** 发码 + 输正确码，**When** 提交解绑，**Then** 成功返回账号与安全页、微信行翻「绑定」
5. **Given** 码错/格式错，**When** 提交，**Then** 错误提示（401「验证码错误」/ 400 格式），仍绑定

---

### User Story 5 — [Phase 2] 真实 native 微信 SDK 接入 port（Priority: P2）

把真实 native 微信授权（expo config plugin + custom dev client + 开放平台 AppID + 服务端 code↔openid 交换）接入 bind port，替换 Phase 1 stub。

**Why this priority**: 让绑定在真机上对接真实微信；P2 因 Phase 1 已交付完整可测功能，真实 SDK 为后置真机层。

**Independent Test**: 设备/手动 —— 真机点「绑定」→ 唤起微信 App → 允许 → 服务端换 openid → 绑定成功（无 web e2e；覆盖缺口标注）。

**Acceptance Scenarios**:

1. **Given** 真机 + 已装微信 + 开放平台已注册 AppID，**When** 点「绑定」，**Then** 唤起微信 App 授权（图二「富途牛牛 申请使用 你的昵称、头像」允许/拒绝）
2. **Given** 用户点「允许」，**When** 微信回授权 code，**Then** 客户端送服务端 → 服务端 AppID/AppSecret 调微信 API 换 openid/unionid → 接入 bind 流（同 Phase 1 落库/冲突规则）
3. **Given** 用户点「拒绝」/ 未装微信，**When** 唤起失败，**Then** 友好提示、不绑定

### Edge Cases

- 未登录访问绑定/解绑入口或端点 → AuthGate / authed 守卫拦截（既有机制，不重立）。
- 解绑发码：未绑微信账号请求 → 反枚举折叠（不暴露绑定状态）。
- 解绑验证页重复快速点「解绑」提交 → in-flight 忽略二次（isSubmitting 单源），不重复提交。
- 绑定中断（授权失败/网络/超时）→ 状态不脏写、可重试。
- openid 已绑他号 → 拒且不泄露他账号任何信息（错误文案统一）。
- 解绑后账号仍有手机号可登录（解绑不影响账号存活）。
- Phase 1 stub 与 Phase 2 real adapter 切换 → bind 端点契约不变（port 边界稳定），仅 adapter 实现替换。
- web 平台（production）点「绑定」→ 无 native 微信 → 入口处理（隐藏/降级提示）留 plan；web e2e 仅走 stub。

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 绑定关系存储 — MUST 新增 账号↔微信身份 绑定（accountId + provider=WECHAT + openid + 可选 unionid + boundAt）；**openid 全局唯一**（一 openid ↔ 至多一账号）；存储形态（新表 vs `Credential.type` 扩展）留 plan；anemic Prisma row + `@map`（ADR-0043）。
- **FR-S02**: 绑定创建（authed）— 经微信授权 port 解析 openid（Phase 1 stub / Phase 2 real）→ 创建绑定。openid 已绑**他**账号 MUST 拒（明确错误 `WECHAT_ALREADY_BOUND_OTHER`、不泄露他账号）；已绑**本**账号（同 openid）MUST 幂等（创建/幂等同返 **201**，O7）；**本账号已绑微信但请求绑不同 openid** MUST 拒（独立错误 `WECHAT_ACCOUNT_ALREADY_BOUND`「请先解绑」，R2 — 不静默替换身份；happy-path UI 不可达，纯服务端纵深防御）。MUST NOT 改账号 displayName/头像。
- **FR-S03**: 解绑发码（authed）— 已绑微信 ACTIVE 账号请求 MUST 生成一次性 6 位码，单向哈希写 1 条 `AccountSmsCode`（`purpose=UNBIND_WECHAT`、`expiresAt`=now+10min、`usedAt` 空），明文仅进短信、下发到账号手机号；MUST NOT 改绑定、MUST NOT 发事件（复用 004 send-deletion-code 范式）。未绑/账号异常 MUST 反枚举折叠（不暴露状态）。
- **FR-S04**: 验码解绑（authed）— 持 active UNBIND_WECHAT 码 + 正确码值 + 已绑微信 MUST 单原子事务：标记码已用 → 删绑定关系。码失败 4 分支 MUST 折叠字节级一致 401；请求体 code 缺/非 `\d{6}` → 400（与凭据路径区分）；并发同码 MUST 恰 1 次成功。
- **FR-S05**: 鉴权门槛 — bind/发码/验码解绑/状态查询 缺/失效 token MUST 折叠 401（沿用既有 authed 守卫，不暴露额外状态）。
- **FR-S06**: 限流 — 解绑发码 `per-account 1/60s + per-IP`；bind/验码解绑 `per-account N/60s + per-IP`（复用 throttler）；超限 429 + `Retry-After`；限流在加载账号前消费。
- **FR-S07**: 绑定状态契约 — GET `/accounts/me`（或绑定状态端点）MUST 返回微信 bound/unbound（可选脱敏微信昵称仅展示用）；契约经 `@nestjs/swagger` 派生 OpenAPI、`packages/api-client` regen 同步 typed。
- **FR-S08**: 验证码存储 — UNBIND_WECHAT 码 MUST 单向哈希存储（沿用 001/004 sms-code 范式，ADR-0023）；`purpose` 物理隔离（按 purpose+active 谓词查询，跨 purpose MUST NOT 命中）。
- **FR-S09 [Phase 2]**: 真实微信授权 adapter — native 授权 code MUST 由服务端用 AppID/AppSecret 调微信 API 换 openid/unionid，接入 FR-S02 port（替换 stub）；AppSecret 等凭证治理 per [ADR-0037](../../docs/adr/0037-security-credentials-governance.md)。

### Client Functional Requirements

- **FR-C01**: 007 微信行 MUST 翻 active，按绑定状态显示「绑定」（未绑）/「解绑」（已绑）。
- **FR-C02**: 绑定入口 — 点「绑定」MUST 经微信授权 port 唤起授权（Phase 1 = stub 确定性假授权，web 可测；Phase 2 = native expo 微信 SDK `sendAuthRequest`）→ 成功 → 调 bind 端点 → 行翻「解绑」。openid 已绑他号 → 明确提示「该微信已绑定其他账号」、行保持「绑定」。
- **FR-C03**: 解绑确认 — 点「解绑」MUST 弹确认对话「确定要解除微信绑定?」（取消/确定；web `window.confirm` / native `Alert.alert`，复用 006 logout 范式）；确定 → push 解绑验证页；取消 → 留原页、仍绑定。
- **FR-C04**: 解绑验证页（图四改造）— MUST 标题「账号解绑」+ 副文「您正在申请解除微信绑定，需验证以下身份」+ **手机验证码输入**（非密码，复用 `SmsInput`）+ 发码 + 解绑提交；MUST 用 RHF + zodResolver（delete-account 范式：`<Controller>`、isSubmitting 单源、错误+a11y 一体、`SMS_CODE_REGEX`）。
- **FR-C05**: 解绑结果 — 验码成功 MUST 返回账号与安全页、微信行翻「绑定」；码错/格式错 MUST 提示（401 验证码错误 / 400 格式），仍绑定。
- **FR-C06**: 失败处理 — 绑定授权/网络失败 MUST 友好提示且状态不脏写（仅服务端确认后才翻行状态）。
- **FR-C07 [Phase 2]**: 真实微信唤起 — MUST 接入 expo 微信 SDK（config plugin + custom dev client），替换 port stub；web production 端无 native 微信唤起，入口处理（隐藏/降级）留 plan；web e2e 仅走 stub。

### Key Entities

- **WechatBinding（新增）**：账号↔微信身份绑定 —— accountId + provider=WECHAT + openid（全局唯一）+ 可选 unionid + boundAt。一 openid ↔ 至多一账号。存储形态（新表 vs `Credential.type` 扩展）留 plan。
- **AccountSmsCode（既有，扩展 purpose）**：新增 `purpose=UNBIND_WECHAT`（物理隔离，单向哈希，10min TTL，恰一次）。
- **Account（既有）**：绑定/解绑 MUST NOT 改其 displayName/头像（不回填）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 绑定创建 — authed + stub openid → 201、绑定落库（account↔openid、boundAt）、profile 不变；openid 已绑他号 → 拒（不泄露）；已绑本号 → 幂等；缺 token → 401（Testcontainers IT 逐字段）。
- **SC-002**: 解绑发码 — 已绑微信 authed → 204、落 1 条 active UNBIND_WECHAT 码（哈希入库、10min、usedAt 空）、短信发出、绑定不变、无事件；未绑/异常 → 反枚举折叠；超限 429。
- **SC-003**: 验码解绑 — 持有效码提交 → 删绑定（单事务）；码 4 类失败字节级一致 401；并发同码恰 1 次成功（乐观锁/affected-count）。
- **SC-004**: 绑定入口（Phase 1 web）— Playwright：未绑→显示「绑定」→ stub 授权 → mock bind 201 → 行翻「解绑」；已绑→显示「解绑」→ 确认对话 → 解绑验证页 → 发码+输码 → mock 解绑 → 行翻「绑定」。
- **SC-005**: 解绑验证页 — 展示手机验证码输入（非密码）、复用 `SmsInput` + RHF；标题/副文符图四改造文案。
- **SC-006**: 不回填 — 绑定/解绑前后账号 displayName/头像不变（IT + e2e 断言）。
- **SC-007**: 覆盖边界标注 — Phase 2 真实 native 微信唤起为设备/手动验证（无 web e2e），spec/plan 明记；web production 微信绑定（扫码/H5）out of scope，不假装覆盖。
- **SC-008**: 反枚举 — 解绑发码/验码失败响应与「鉴权失败」字节级一致；绑定冲突错误不泄露他账号身份。

## Assumptions

- 本 spec = 微信**绑定/解绑**（已登录账号关联微信），非「微信登录」；范围仅微信，google 保持 007 占位。
- 一 openid ↔ 至多一账号（冲突拒）；解绑后可重绑；账号恒有手机号（002 必填）故解绑总安全。
- 解绑复用 004 delete-account 的 SMS 全套（`AccountSmsCode` purpose 隔离 + send/verify 两段 + 单向哈希 + 恰一次 + 反枚举 + `SmsInput` + RHF 范式），仅 purpose=UNBIND_WECHAT + 文案不同。
- bind port 边界（client 唤起 + server code↔openid 交换的切分）、绑定存储形态（新表 vs Credential 扩展）、各 use case bounded context 落点、web production 绑定入口降级 —— 均 plan 决策。
- Phase 2 真实微信需开放平台注册 AppID/AppSecret + 应用签名报备 + custom dev client（产品侧前置，非本 spec 代码范围）。
- 视觉精确值（确认对话 / 解绑页 / 微信行样式）留 mockup 回填 plan.md UI 段。

## Out of Scope

- **「微信登录」**（微信作为登录方式 / 注册）—— 本 spec 仅绑定/解绑既有账号。
- **google / QQ / Apple / 小米 等其他第三方绑定** —— google 保持 007 占位；其余另议。
- **绑定回填 profile**（微信昵称/头像 → displayName/头像）—— 用户已定不回填。
- **production web 端真实微信绑定（扫码 / H5 OAuth）** —— 真实绑定目标为 native app；web 仅 stub 覆盖 e2e。
- **Phase 2 的开放平台注册 / AppSecret 报备 / custom dev client 搭建** 等产品/运维前置 —— 非本 spec 代码交付物（plan 列依赖）。
- **plan 级决策**：bind port 切分、绑定存储形态、bounded context 落点、unionid 是否必存、web 绑定入口降级策略、旧绑定审计/事件。
