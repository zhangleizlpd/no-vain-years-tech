---
feature_id: 003-tokens
modules: [auth, security, account]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-25'
updated_at: '2026-05-25'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
perf_budgets:
  - endpoint: 'POST /api/v1/accounts/refresh-token'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'POST /api/v1/accounts/logout-all'
    p95_ms: 80
    p99_ms: 150
web_compat: stub
web_compat_notes: 'Client 段（2026-05-25 clarify 定）= api-client 透明续期拦截器 + `X-Device-Id` 头注入 + logout-all wrapper 逻辑;无可见 UI（登出按钮随 settings shell 独立 spec）。device 名称/类型 header 延后 005。Web export 路径冒烟随 client 段落地时补。'
agent_friction_observed: false
state_branches:
  - 'login persists active refresh-token record: deviceId from X-Device-Id or server fallback, expiresAt=now+30d, ipAddress=scrub(private→null), revokedAt=null'
  - 'refresh rotation: presented active record → old revoked + new active inserted (deviceId/deviceName/deviceType/loginMethod inherited, ipAddress updated to current)'
  - 'refresh failure folds to byte-identical 401 INVALID_CREDENTIALS (not-found / expired / revoked / forged / account-missing / account-not-eligible / lost-rotation-race)'
  - 'refresh request body missing or blank token → 400 validation (distinct from the 401 credential path)'
  - 'concurrent rotation of same token: affected-count guard → exactly 1 succeeds, others 401, no duplicate active record'
  - 'logout-all: all account active records revoked incl. caller device, idempotent 204 for revoked-count 0/1/N, other accounts + already-revoked rows untouched'
  - 'same-device re-login: new active record coexists with prior active records (no revoke, no dedup)'
  - 'rate limit exceeded (refresh per-IP/per-token-hash, logout-all per-account/per-IP) → 429 + Retry-After'
---

# Feature Specification: Token Session Lifecycle（refresh-token 持久化 + 轮换 + 全端登出）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-25)]**
> 本 feature 按 **Flat + Anemic + Moat** 范式实现（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）+ bounded context 边界（[ADR-0032](../../docs/adr/0032-backend-bounded-context.md)）。spec 只描述业务行为，不含实现技术词。

**Feature Branch**: `003-tokens`
**Created**: 2026-05-25
**Status**: Draft（mode-1a 抽取重写：旧 meta spec `specs/auth/{refresh-token,logout-all}/` + 旧 Java UseCase + 旧 IT 三源净室提取）
**Module**: `auth`（编排：refresh / logout-all 端点）+ `security`（token 基础设施：持久化 / 轮换 / 撤销）
**Input**:

- 认证签发**短时 access token** + **长时 refresh token**，让客户端无需反复输入短信码即可保持登录，并支持「全端登出」。
- **现状缺口**：登录目前只**生成并返回** refresh token 字符串，**从不持久化**任何记录（`apps/server/src/security/jwt-token.service.ts` 注释明示「Refresh token 持久化…在后续 use case 引入」）。因此当前无任何记录可轮换 / 可撤销。**本 feature 即引入完整 refresh-token 服务端生命周期**：签发即持久化 → 单次使用轮换 → 全部撤销。
- 用户决策（2026-05-25）：**全生命周期 + 完整 device 元数据**——签发持久化要写入已 ship 的登录流，记录含 device 标识 / 名称 / 类型 / IP / 登录方式，为 `005-device-management` 铺底。

## Context

- **反枚举不变性**：refresh 的所有失败分支字节级一致（统一 401 `INVALID_CREDENTIALS`），不暴露 token 是「不存在 / 已过期 / 已撤销 / 伪造」中的哪一种。
- **横切复用（不重立）**：限流（`@nestjs/throttler` + Redis storage）/ RFC 9457 ProblemDetail 全局错误映射 / access token 签发 均已随 `001` ship；本 spec 引用，不重新建立。
- **bounded context**（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)，已登记 `refresh-token = auth, R2 → security.rotate-refresh-token`）：`auth` 编排 user-facing 端点（refresh / logout-all），`security` 持有 refresh-token 记录的持久化 / 轮换 / 撤销操作；auth → security 轮换为 **R2 CROSS-CONTEXT-SYNC**（轮换失败必须回滚整个请求）。
- **数据模型已就位**：`RefreshToken` 记录表已 db-pull（`apps/server/prisma/schema.prisma`），含本 spec 所需全部字段；本 feature 不新增表、不改表结构（除非 clarify 暴露缺字段）。

## Clarifications

### Session 2026-05-25

- Q: FR-C04 device 标识 — mono mobile 本批次发送 device header 的范围？ → A: **最小接线 `X-Device-Id`** — mono mobile 本批次发送稳定 `X-Device-Id`（首次生成并本地持久化）；`deviceName`/`deviceType` header 延后到 `005-device-management`；server 始终接受可选 header + 缺失时回退生成 `deviceId`
- Q: FR-C05/US8 登出控件 — 003 是否落用户可见的「登出」按钮？ → A: **仅拦截器 + wrapper 逻辑** — 003 client 段 = api-client 透明续期拦截器（Contract + 逻辑）+ logout-all wrapper 逻辑；**不**落可见登出按钮，可见控件随设置外壳（settings shell，独立 spec）落地
- Q: 同 device 重复登录 — 同 `deviceId` 再次登录时如何处理旧 active 记录？ → A: **多条共存** — 不撤旧、不去重，允许同 device 多条 active 记录（靠 logout-all / 自然过期清理）；per-device-single-active 需要时随 `005` 引入

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 签发即持久化（Priority: P1）

用户成功通过手机短信认证（既有登录流）后，系统除了返回 access + refresh token，还**落一条 refresh-token 记录**：记录 refresh token 的单向哈希（原始 token 永不入库）、所属账号、过期时刻（签发起 30 天）、device 标识（客户端提供的稳定标识；缺失时服务端生成回退标识）、可选 device 名称、粗粒度 device 类型（默认 unknown）、来源 IP（私网 / 回环地址落为空）、登录方式（默认手机短信）。

**Why this priority**: 是 US2（轮换）/ US5（全端登出）的**前置基座**——没有持久化记录就无可轮换 / 可撤销之物。所有后续行为依赖本故事。

**Independent Test**: Testcontainers PG + Redis；新号经手机短信认证成功 → 断言 DB 新增 1 条 refresh-token 记录，`tokenHash` 非空且 = 返回 refresh token 的哈希、`accountId` = 该账号、`revokedAt` 为空（active）、`expiresAt` ≈ now + 30d、`deviceId` 非空、`loginMethod` = 手机短信。

**Acceptance Scenarios**:

1. **Given** 未注册号经手机短信认证 auto-create 成功，**When** 签发完成，**Then** DB 落 1 条 active refresh-token 记录（`tokenHash` 单向哈希、`revokedAt=null`、`expiresAt` 30 天后、`deviceId` 非空）；返回给客户端的 refresh token 原文**不入库**
2. **Given** 客户端请求未携带 device 标识，**When** 签发，**Then** 服务端生成回退 device 标识写入 `deviceId`（非空约束满足），`deviceName` 为空、`deviceType=unknown`
3. **Given** 客户端来源 IP 为私网 / 回环（如 `127.0.0.1`），**When** 签发，**Then** `ipAddress` 落为空（不记录私网地址）；公网 IP 则如实记录
4. **Given** 同一账号在两台 device 分别登录，**When** 各自签发，**Then** DB 有 2 条独立 active 记录（`deviceId` 不同），互不影响

---

### User Story 2 — [Server] Refresh 轮换（Priority: P1）

客户端持 refresh token 调用刷新：系统哈希后查找**仍 active**（未撤销且未过期）的记录，确认所属账号处于可登录状态，然后在**单个原子事务**内：签发新的短时 access token（15 分钟）+ 新 refresh token（自 now 起 30 天新窗口）、**撤销**所呈递的旧记录、**插入**新记录。新记录**继承**父记录的 device 标识 / 名称 / 类型 / 登录方式（「哪台 device、用哪种方式登录」的血缘沿链路存活），**仅 IP 更新**为当前请求 IP（「最近一次刷新位置」）。

**Why this priority**: 主路径——客户端凭此保持登录不掉线。轮换是 refresh token 的核心用途。

**Independent Test**: Testcontainers；预置 1 条 active 记录（已知 device 元数据）→ 持对应 refresh token 调 refresh → 断言 200 + 新 access + 新 refresh；DB 旧记录 `revokedAt` 已置、新记录 active 且 `deviceId/deviceName/deviceType/loginMethod` 继承自旧、`ipAddress` = 本次请求 IP、`expiresAt` ≈ now + 30d。

**Acceptance Scenarios**:

1. **Given** 1 条 active 记录 + 账号 ACTIVE，**When** 持对应 refresh token 调 refresh，**Then** 返回 200 + 新 access（15min）+ 新 refresh（30d）；旧记录被撤销、新记录 active 且 device 血缘继承、IP 更新为当前
2. **Given** 刚轮换过的（已撤销）refresh token，**When** 再次呈递（重放），**Then** 命中已撤销记录 → 统一 401 `INVALID_CREDENTIALS`（单次使用，无宽限）
3. **Given** 轮换签发新 token 过程中任一步失败，**When** 事务回滚，**Then** 旧记录**保持 active**、无新记录插入（原子性：要么旧撤销+新插入全成，要么全不变）
4. **Given** 刷新成功，**When** 检查此前已发出的 access token，**Then** 旧 access token **仍有效**直到其自身 15 分钟过期（无状态，刷新不主动失效旧 access）

---

### User Story 3 — [Server] Refresh 反枚举（Priority: P1）

刷新的所有失败原因对客户端表现为**单一、字节级一致**的 401 `INVALID_CREDENTIALS`，系统绝不透露失败属于哪一类（token 不存在 / 已过期 / 已撤销 / 伪造 / 账号缺失 / 账号不可登录 / 输给并发轮换竞态）。

**Why this priority**: 安全不变性——防止攻击者借差异化响应枚举有效 token 或账号状态。与 `001` 登录的反枚举立场一致。

**Independent Test**: Testcontainers；构造 7 类失败场景各发一次 refresh → 断言响应 body / status / `code` 字节级一致（均 401 `INVALID_CREDENTIALS` ProblemDetail）。

**Acceptance Scenarios**:

1. **Given** 库中不存在的 refresh token，**When** 调 refresh，**Then** 401 `INVALID_CREDENTIALS`
2. **Given** 已过期记录对应的 token，**When** 调 refresh，**Then** 401 `INVALID_CREDENTIALS`（与「不存在」字节级一致）
3. **Given** 已撤销记录对应的 token，**When** 调 refresh，**Then** 401 `INVALID_CREDENTIALS`（同上一致）
4. **Given** 记录存在但所属账号非可登录态（FROZEN / ANONYMIZED），**When** 调 refresh，**Then** 401 `INVALID_CREDENTIALS`（同上一致）
5. **Given** 请求体缺失 / 空白 refresh token，**When** 调 refresh，**Then** 400 校验错误（与凭据失败路径**区分**——这是请求格式问题，非凭据问题）

---

### User Story 4 — [Server] Refresh 并发轮换安全（Priority: P1）

同一 refresh token 被并发呈递多次（客户端重试 / 竞态）时，**恰有一次**轮换成功，其余识别为竞态失败并安全终止——绝不产生重复的 active 记录。

**Why this priority**: 数据完整性 + 安全——重复 active 记录会让一个被「用掉」的 token 仍可用，破坏单次使用语义。

**Independent Test**: Testcontainers；预置 1 条 active 记录 → 10 个并发请求持同一 refresh token 调 refresh → 断言**恰 1 个**返回 200、其余返回 401 `INVALID_CREDENTIALS`；DB 最终 active 记录数 = 1。另：100 个并发请求各持**不同** active token 轮换 → 断言 0 错误（无锁争用导致的伪失败）。

**Acceptance Scenarios**:

1. **Given** 1 条 active 记录，**When** 10 并发持同一 token 调 refresh，**Then** 恰 1 成功 + 9 个 401；DB active 记录 = 1
2. **Given** 100 条各不同 active 记录，**When** 100 并发各持自己的 token 调 refresh，**Then** 全部成功、0 错误（独立 token 互不阻塞）

---

### User Story 5 — [Server] 全端登出（LogoutAll，Priority: P1）

已认证用户请求全端登出：系统撤销该账号**全部 active** refresh-token 记录（**包括当前 device 自己的记录**）。幂等——无论撤销了 0 / 1 / 多条都返回成功（204 无内容，空 body），可安全重试；已撤销记录与其他账号记录不受影响。

**Why this priority**: 主路径——用户「退出登录」「在所有设备登出」的安全诉求；账号可疑活动时一键清场。

**Independent Test**: Testcontainers；预置账号 A 3 条 active + 1 条已撤销 + 账号 B 2 条 active → 持 A 的有效 access token 调 logout-all → 断言 204 空 body；DB 中 A 的 3 条 active 全部 `revokedAt` 已置、A 的原已撤销记录时间戳**不变**、B 的 2 条**不受影响**。

**Acceptance Scenarios**:

1. **Given** 账号有 N 条 active 记录，**When** 调 logout-all，**Then** 204 空 body；该账号全部 active 记录被撤销
2. **Given** 账号当前 0 条 active 记录（已全撤销），**When** 调 logout-all，**Then** 仍 204（幂等，可重试）
3. **Given** 账号有已撤销记录 + 其他账号有 active 记录，**When** 调 logout-all，**Then** 已撤销记录时间戳不变、其他账号记录不受影响
4. **Given** logout-all 后此前发出的 access token 尚未过期，**When** 用旧 access token 调业务接口，**Then** 在其 ≤15min 过期前**仍可用**；过期后下次刷新因记录全撤销而失败（踢出在 access 过期时生效）

---

### User Story 6 — [Server] 限流（Priority: P2）

refresh 与 logout-all 各自受限流保护；超限返回 429 + `Retry-After`。

**Why this priority**: 防爆刷 / 撞库 / 拒绝服务；P2 因主功能（US1-US5）不依赖它即可演示，但上线必需。

**Independent Test**: Testcontainers + Redis；对 refresh 同一 token 在 60s 内连发 > 5 次 → 第 6 次起 429 + `Retry-After`；对 logout-all 同一账号 60s 内连发 > 5 次 → 第 6 次起 429。

**Acceptance Scenarios**:

1. **Given** 同一 refresh token，**When** 60s 内第 6 次调 refresh，**Then** 429 + `Retry-After`（per-token 5/60s）
2. **Given** 同一来源 IP，**When** 60s 内第 101 次调 refresh，**Then** 429（per-IP 100/60s）
3. **Given** 同一账号，**When** 60s 内第 6 次调 logout-all，**Then** 429 + `Retry-After`（per-account 5/60s）
4. **Given** 同一来源 IP，**When** 60s 内第 51 次调 logout-all，**Then** 429（per-IP 50/60s）

---

### User Story 7 — [Client] 透明续期（Priority: P1）

客户端的认证请求遇到 401 时，**单飞（single-flight）一次刷新调用**并**仅重试一次**原请求（防循环：刷新端点本身豁免重试；带重试标记防二次进入）。刷新失败则清空本地会话并将用户路由到登录页。

**Why this priority**: 主路径——让 access token 15 分钟过期对用户**无感**，是「保持登录」体验的核心。

**Independent Test**: 单测（logic-level，per mono 测试分层）：mock 一个返回 401 的业务请求 + mock 刷新成功 → 断言刷新被调用**恰 1 次**（并发 401 共享同一刷新 in-flight）+ 原请求被重试**恰 1 次**且携带新 access token；再 mock 刷新失败 → 断言本地会话被清 + 路由到登录。

**Acceptance Scenarios**:

1. **Given** 持过期 access token 的业务请求返回 401，**When** 拦截器处理，**Then** 触发一次刷新 → 拿新 access token → 用新 token 重试原请求一次 → 原请求成功
2. **Given** 多个并发业务请求同时 401，**When** 拦截器处理，**Then** 刷新只发起**一次**（single-flight），所有等待请求复用同一刷新结果后各自重试一次
3. **Given** 刷新调用本身返回 401，**When** 拦截器处理，**Then** **不**对刷新端点再触发刷新（豁免），原 401 透传 → 清本地会话 → 路由登录
4. **Given** 重试后的原请求仍 401，**When** 拦截器处理，**Then** **不**再二次刷新 / 重试（重试标记拦截），透传失败

---

### User Story 8 — [Client] 全端登出 wrapper 逻辑（Priority: P2）

「登出」语义触发全端登出：客户端 wrapper 调 logout-all，并在 `finally` 路径**无条件清空本地会话**（即便服务端调用失败——残留记录会自行过期），随后路由到登录页。

**Why this priority**: P2——logout-all wrapper 逻辑本批次落地（供后续 settings shell 的登出按钮调用）；**用户可见的登出按钮随设置外壳独立 spec 落地**（per Clarifications），本 feature 不含可见控件。旧 app 的「退出登录」按钮即调 logout-all（无独立单 device 登出）。

**Independent Test**: 单测（logic-level）：mock logout-all 成功 → 断言本地会话被清 + 路由登录；mock logout-all 失败（网络 / 5xx）→ 断言本地会话**仍被清**（finally 无条件）+ 路由登录。

**Acceptance Scenarios**:

1. **Given** 已登录用户点「登出」，**When** logout-all 成功，**Then** 本地会话清空 + 路由登录页
2. **Given** logout-all 服务端失败，**When** 处理，**Then** 本地会话**仍清空**（finally）+ 路由登录（不阻塞用户登出）

---

### Edge Cases

#### Server Edge Cases

- **同一 device 重复登录**：同 `deviceId` 再次登录 → 落**新** active 记录（不复用 / 不去重 / **不撤旧**，多条共存，per Clarifications）；旧记录留待自然过期或被 logout-all 撤销；per-device-single-active 随 `005` 评估
- **refresh token 格式畸形**（非预期长度 / 字符集）：仍按统一流程哈希查找 → 必然 miss → 401 `INVALID_CREDENTIALS`；**绝不**因格式区分错误（不暴露「格式错」）
- **过期与撤销同时成立**：折叠为同一 inactive 判定 → 401（不区分）
- **logout-all 时账号已被硬删除**（M3+ 场景，token 仍有效）：撤销影响 0 条 → 仍 204
- **logout-all 时账号 FROZEN / ANONYMIZED 但持有未过期 access token**：允许（撤销是对所有状态都合法的清理动作；本操作不加载账号状态门槛）
- **refresh 时账号在记录签发后被冻结**：账号不可登录 → 401 `INVALID_CREDENTIALS`（反枚举一致路径）

#### Client Edge Cases

- **刷新 in-flight 期间又来新 401**：复用同一刷新 promise（single-flight），不重复发起
- **本地无 refresh token 却收到 401**：直接清会话 + 路由登录（无可刷新之物，不空发刷新）
- **device 标识本地缺失**（首次启动 / 清缓存）：客户端生成并本地持久化一个稳定 device 标识，经 `X-Device-Id` 头发送（生成 / 存储细节 plan 决）

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 签发持久化 — 任一成功认证（既有手机短信登录流）签发 token 时，MUST 落 1 条 refresh-token 记录：`tokenHash`（refresh token 单向哈希，**原文永不入库**）/ `accountId` / `expiresAt`（签发起 30 天）/ `deviceId`（非空）/ `deviceName`（可空）/ `deviceType`（默认 `UNKNOWN`）/ `ipAddress`（私网 / 回环落空）/ `loginMethod`（默认手机短信）/ `createdAt` / `revokedAt`（签发时为空 = active）
- **FR-S02**: device 标识来源与回退 — 服务端 MUST 接受客户端经请求头 `X-Device-Id` 传递的稳定 device 标识，有则采用之；缺失时 MUST 生成回退标识写入 `deviceId`（保证非空约束），此时 `deviceName` 留空、`deviceType=UNKNOWN`。`deviceName`/`deviceType` 的客户端来源（额外 header）延后到 `005-device-management`；本 feature 服务端字段就位但默认空 / `UNKNOWN`（per Clarifications）
- **FR-S03**: refresh token 强度与存储 — refresh token MUST 为高熵随机（256-bit），仅以**单向哈希**持久化（小写十六进制）；服务端任何时刻不持久化、不日志化原文
- **FR-S04**: refresh 端点 — 接受客户端呈递的 refresh token；查找**仍 active**（`revokedAt` 为空且 `expiresAt > now`）记录，确认所属账号可登录，**原子**轮换：签新 access（15min）+ 签新 refresh（30d）→ 撤销旧记录 → 插入新记录 → 返回新 access + 新 refresh
- **FR-S05**: 轮换血缘继承 — 新记录 MUST 继承父记录的 `deviceId` / `deviceName` / `deviceType` / `loginMethod`；`ipAddress` MUST 更新为当前请求 IP（私网 / 回环落空）；`expiresAt` 为自 now 起新的 30 天窗口（非继承父剩余）
- **FR-S06**: 单次使用 — 轮换 MUST 撤销所呈递记录；重放已撤销 token MUST 失败（401 `INVALID_CREDENTIALS`）；无宽限窗口、无重复使用
- **FR-S07**: 轮换原子性 — 签发 + 撤销旧 + 插入新 MUST 在单事务内；任一步失败 MUST 整体回滚（旧记录保持 active、不插入新记录）
- **FR-S08**: 并发乐观保护 — 撤销旧记录使用条件更新并检查受影响行数；受影响行数为 0（已被并发轮换 / 撤销抢先）MUST 终止并回滚本次轮换（不插入新记录、返回 401 `INVALID_CREDENTIALS`）；保证同一 token 并发轮换**恰 1 成功**
- **FR-S09**: refresh 反枚举 — 所有凭据失败分支（不存在 / 过期 / 撤销 / 伪造 / 账号缺失 / 账号不可登录 / 竞态失败）MUST 折叠为**字节级一致**的 401 `INVALID_CREDENTIALS`；请求体缺失 / 空白 refresh token MUST 返 400 校验错误（与凭据路径区分）
- **FR-S10**: access token 无状态 — 刷新 / 登出 MUST NOT 主动失效已发出的 access token；旧 access 在其 15min 自然过期前仍有效
- **FR-S11**: logout-all 端点 — 已认证请求 MUST 撤销该账号**全部 active** 记录（含当前 device 自身）；幂等返回 204 空 body（撤销 0 / 1 / 多条均成功）；不加载 / 不门槛账号状态
- **FR-S12**: logout-all 撤销范围隔离 — MUST 仅撤销目标账号的 active 记录；已撤销记录的 `revokedAt` 不变、其他账号记录不受影响
- **FR-S13**: logout-all 鉴权 — 缺失 / 无效 / 过期的访问凭据 MUST 返 401 `INVALID_CREDENTIALS`（与既有受保护端点一致路径）
- **FR-S14**: 限流 — 复用既有 `@nestjs/throttler` + Redis storage（`001` 已配）；新增 per-UC 配置：refresh `per-IP 100/60s` + `per-token-hash 5/60s`（IP 桶在哈希前消费、token 桶在哈希后）；logout-all `per-account 5/60s` + `per-IP 50/60s`（account 桶先消费）；超限 MUST 返 429 + `Retry-After`
- **FR-S15**: 错误响应格式 — 所有错误 MUST 遵循 RFC 9457 ProblemDetail（`application/problem+json`），由既有全局错误映射产出，与既有 use case 一致
- **FR-S16**: bounded context 边界 — refresh / logout-all 端点编排归 `auth`；refresh-token 记录的持久化 / 轮换 / 撤销操作归 `security`；auth → security 轮换为 **R2 CROSS-CONTEXT-SYNC**（轮换失败回滚整请求），跨 context 注入点 MUST 带 `// CROSS-CONTEXT-SYNC` 注释（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）；`security` 操作清单与 catalog 一致

### Client Functional Requirements

- **FR-C01**: 透明续期拦截 — 认证请求返回 401 时 MUST 触发一次刷新并**仅重试一次**原请求；刷新成功用新 access token 重试、失败则清本地会话 + 路由登录
- **FR-C02**: single-flight — 多个并发 401 MUST 共享**单次**刷新调用（不并发多次刷新）；等待请求复用同一结果后各自重试一次
- **FR-C03**: 防循环 — 刷新端点自身 401 MUST NOT 再触发刷新（豁免）；重试后的原请求仍 401 MUST NOT 二次刷新 / 重试（带重试标记拦截）
- **FR-C04**: device 标识 — mono mobile MUST 生成并本地持久化一个稳定 device 标识，**本批次**经请求头 `X-Device-Id` 随认证 / 刷新请求发送，使记录携带 device 血缘；device 名称 / 类型 header 延后到 `005-device-management`（本 feature 不发送，per Clarifications）
- **FR-C05**: 登出 wrapper 逻辑 — 本 feature client 段提供 logout-all wrapper 逻辑：调 logout-all 并在 `finally` **无条件**清本地会话（即便服务端失败）+ 路由登录。**本 feature 不落用户可见的「登出」按钮**——可见控件随设置外壳（settings shell，独立 spec）落地（per Clarifications）

> **测试分层（per mono 约定）**：client 逻辑（拦截器 single-flight / 重试 / 错误映射 / 登出清理）→ vitest logic-level helper 单测；任何 UI render / a11y → Playwright Expo Web e2e。本 feature client 段 = 拦截器逻辑 + `X-Device-Id` 头注入 + logout-all wrapper（**无可见 UI**，per Clarifications）。

## Key Entities _(数据涉及)_

- **RefreshToken record**（refresh-token 记录，归 `security`；表已 db-pull，本 feature 不改表结构）— 属性级（不带存储类型）：
  - `tokenHash`：refresh token 的单向哈希（唯一查找键）；原始 token 永不入库
  - `accountId`：所属账号引用
  - `expiresAt`：硬过期时刻（签发起 30 天）
  - `revokedAt`：撤销时刻；**为空 = active**
  - `createdAt`：记录创建时刻
  - `deviceId`：稳定 device 标识（客户端提供 / 服务端回退生成）；**非空**
  - `deviceName`：客户端上报的 device 显示名；可空
  - `deviceType`：粗粒度 device 类型（phone / tablet / desktop / web / unknown）；默认 `UNKNOWN`，供后续 device 管理 UI
  - `ipAddress`：签发 / 刷新时的来源 IP；私网 / 回环落空；可空
  - `loginMethod`：开启本 device 血缘的登录方式（默认手机短信）；轮换时继承
  - **血缘关系**：无显式父子外键列；血缘经轮换时**继承** `deviceId/deviceName/deviceType/loginMethod` 隐式体现（非外键链）
  - **active 谓词**：`revokedAt` 为空 AND `expiresAt > now`

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 签发持久化覆盖 — 成功认证后 DB 必有对应 active 记录（`tokenHash` = 返回 token 的哈希、`deviceId` 非空、`expiresAt` ≈ +30d）；集成测试覆盖「客户端有 / 无 device 标识」两路径
- **SC-S02**: 原文不落盘 — 全代码路径 + 日志 grep 不出现持久化 / 打印 refresh token 原文；仅哈希入库（集成测试 + 静态 grep）
- **SC-S03**: 轮换正确性 — 轮换后旧记录被撤销、新记录 active、device 血缘 4 字段继承、IP 更新为当前、`expiresAt` 为新 30d 窗口（集成测试逐字段断言）
- **SC-S04**: 单次使用 — 重放已轮换 token 必 401 `INVALID_CREDENTIALS`（集成测试）
- **SC-S05**: 轮换原子性 — 注入签发失败 → 断言旧记录仍 active、无新记录（集成测试）
- **SC-S06**: 并发安全 — 10 并发同 token 轮换恰 1 成功、DB 终态 active 记录 = 1；100 并发不同 token 轮换 0 错误（并发集成测试）
- **SC-S07**: refresh 反枚举 — 7 类失败场景响应 body / status / `code` 字节级一致（均 401 `INVALID_CREDENTIALS`）；请求体缺失 token 返 400（集成测试）
- **SC-S08**: logout-all 幂等与隔离 — 撤销 0/1/N 均 204；目标账号 active 全撤、已撤销记录时间戳不变、其他账号不受影响（集成测试）
- **SC-S09**: 限流准确性 — FR-S14 四条规则集成测试验证生效；429 + 正确 `Retry-After`
- **SC-S10**: 模块边界 — module 边界 CI 检查（per ADR-0032）0 violation；跨 context 注入点注释齐全（`scripts/checks/check-server-moat.ts` 通过）；catalog Operation 清单新增对应行

### Client Measurable Outcomes

- **SC-C01**: 透明续期 — 401 → 刷新 1 次 → 重试 1 次原请求成功；刷新失败 → 清会话 + 路由登录（logic-level 单测）
- **SC-C02**: single-flight — N 个并发 401 仅触发 1 次刷新调用（logic-level 单测断言刷新被调用次数 = 1）
- **SC-C03**: 防循环 — 刷新端点 401 不再刷新、重试后仍 401 不再重试（logic-level 单测）
- **SC-C04**: 真后端冒烟 — Playwright Web e2e：登录 → 模拟 access 过期触发 401 → 透明续期 → 业务请求成功（复用 `apps/mobile/e2e/_support/api-mock.ts`）

## Assumptions

- **既有横切复用**：限流（throttler + Redis）/ RFC 9457 ProblemDetail 全局映射 / access token 签发 已随 `001` ship，本 feature 引用不重立。
- **数据表已就位**：`RefreshToken` 表已 db-pull，字段满足本 spec；**假设无需 schema migration**（若 clarify / plan 暴露缺字段，再走 migration 治理）。
- **access token TTL = 15 分钟、refresh token TTL = 30 天**：沿用旧系统铁规则（旧 Java IT 实证），M2+ 可调。
- **签发持久化要改既有登录流**：本 feature MUST 修改已 ship 的手机短信登录流（接入持久化），用户已确认此 scope 扩张。
- **登录方式当前仅手机短信**：`loginMethod` 默认手机短信；多登录方式（OAuth 等）后续引入时扩枚举。
- **客户端为单一 mono mobile（Expo）**：透明续期拦截器落 api-client 层；device 标识生成 / 存储细节 plan / clarify 决。

## Out of Scope（本 feature 不做）

- **设备列表 / 单设备撤销 / 设备 IP 地理解析 / 设备管理 UI** → 全部归 `005-device-management`（本 feature 仅为其铺设 device 元数据基座）
- **账号删除 / 冻结引发的 token 撤销副作用**（如删除账号时撤全部 token）→ 归 `004-account-deletion`
- **实名认证** → **不做**（功能已废弃，2026-05-31）
- **单设备 `/logout` 端点** → **不做**；登出语义 = 全端登出（logout-all），与旧系统决策一致
- **access token 黑名单 / 主动失效** → 无状态设计，旧 access 自然过期；不引入黑名单
- **device 登录上限 / 同 device 登录前撤旧** → 本 feature **不设**上限、**不去重**（同 device 多条 active 共存，per Clarifications）；per-device-single-active 随 `005` 评估
