---
feature_id: 010-wechat-account-binding
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-31'
---

# Tasks: 010-wechat-account-binding（微信账号绑定/解绑 — 端口桩接 + 短信验证码解绑，两阶段）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `010-wechat-account-binding`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Verify]`（per sdd.md）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑 **unit 测试**（红→绿→typecheck/lint→`[X]`→commit）；**integration 测试（Testcontainers）单列 `[Server-IT]` task**（= 每 US 的 Independent Test 验收）；mobile 纯逻辑（错误映射 / 表单态 / schema）= vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004/006/007/008/009 + orchestrator 暂不用）
- **解绑流 100% 镜像 004 delete-account**：复用 `deletion-code.rules/store`（仅加 `SmsPurpose.UNBIND_WECHAT`）+ 单 tx + affected-count 恰一次闸 + 4 分支折叠字节级一致 401；并发原语全程 READ COMMITTED + 条件 `deleteMany/updateMany` affected-count，**不**用 `FOR UPDATE` / Serializable（per memory `prisma_serializable_p2002_and_p2034`）
- **bind port** 镜像 `SMS_GATEWAY` 范式：契约 phase-stable，Phase 1 仅 stub adapter；**生产 boot 拒 `kind==='mock'`**
- 三位一体：server + api-client regen + mobile **同 1 PR**（Phase 1）
- **Phase 2（US5 真实 native SDK）= 后续独立 PR**，本批不交付（见末尾 Phase 9 说明）

## Path Conventions

- server：`apps/server/src/{auth,account,config}/`（ADR-0043 扁平，文件平铺）；schema `apps/server/prisma/schema.prisma`；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**，per memory `testcontainers_spec_run_via_nx_cwd`）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js` 非 dump-openapi.mjs，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval）
- mobile 入口：`apps/mobile/app/(app)/settings/account-security/index.tsx`（007 微信占位行，D1：既有 `<Row disabled />` 改活行）
- mobile app-local：`apps/mobile/src/wechat/`（新 feature 目录，落点按 [fe-directory-structure](../../docs/conventions/fe-directory-structure.md)）；复用 `~/core/api/use-me`、`~/ui/SmsInput`、`~/settings/primitives`、`~/theme`
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + `_support/api-mock.ts` mockJson；**必 mock refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；仿 `account-security-refactor.spec.ts`；本地跑前杀 :3000 nx serve 父进程，per memory `nx_serve_respawns_3000_poisons_seed_e2e`）

---

## Phase 1: Setup & 决策

- [X] T001 [Server] `config/wechat.config.ts` in `apps/server/src/config/`：discriminated union（`kind:'mock'|'real'`，默认 `mock`；`real` 时 Zod 校验 `WECHAT_APP_ID`/`WECHAT_APP_SECRET` 非空 fail-fast，镜像 `sms.config.ts`）+ wire `config/index.ts` + 单测（默认 mock / real 缺 secret → boot 抛）。**锚定用户决策（2026-05-31）**：①新表 WechatBinding ②Phase 1 单 PR 先交付 ③unionid 现在就存（nullable，不用于唯一性）④web 生产端隐藏绑定按钮（e2e 仍走 stub）。verify typecheck/build 绿

---

## Phase 2: Foundational（阻塞多 US — port + schema + rules 扩 + account commit/inspect 三原语）

- [X] T002 [P] [Server] `wechat-auth.port.ts` in `apps/server/src/auth/`（镜像 `sms-gateway.port.ts` 零-class）：`export const WECHAT_AUTH = Symbol('WECHAT_AUTH')` + `WechatAuthPort { resolveIdentity(authCode): Promise<{openid; unionid?}> }` + `mock-wechat-auth.gateway.ts`（镜像 `mock-sms.gateway.ts`：由 authCode 派生确定性 28 位 `oMOCKDEV...` openid——同 authCode→同 openid 供冲突 IT，`[STUB WECHAT]` log）+ 单测（同 authCode→同 openid / 格式 28 位 `o` 开头 / 不同 authCode→不同 openid）
- [X] T003 [P] [Server] `deletion-code.rules.ts` in `apps/server/src/auth/`：`SmsPurpose` 枚举加 `UNBIND_WECHAT`（**唯一改动**，hash/compare/TTL 全复用 004）+ 单测（枚举值存在 / 不破既有 `DELETE_ACCOUNT`/`CANCEL_DELETION`）。**`AccountSmsCode` 表不改**（`purpose` VarChar(32) 容纳；无 migration）
- [X] T004 [Server] `schema.prisma` 加 `WechatBinding` model（贫血 + `@map` + `@@schema("account")`：`openid @unique(map:"uk_wechat_binding_openid")` = FR-S01 全局唯一冲突闸 / `unionid String?` 决策3 / `@@unique([accountId, provider], map:"uk_wechat_binding_account_provider")` 幂等闸 / `@@index([accountId])`；**无声明 FK relation**，同 AccountSmsCode）+ migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_create_wechat_binding/`（expand-only CREATE TABLE + `migration_refs` frontmatter，ADR-0035）+ `prisma generate` + dev DB `docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy` 验证落表（per memory `mono_dev_db_compose_stack`）
- [X] T005 [P] [Server] `commit-wechat-bind.usecase.ts` in `apps/server/src/account/`（PrismaService 直注，无 repository，ADR-0043）：try `create wechat_binding`；撞**任意** P2002 → **查本账号现有 WECHAT 绑定**（`findFirst({accountId, provider:'WECHAT'})`，与约束触发顺序无关，避免依赖 Prisma 报哪个 constraint）：existing 同 openid→`IDEMPOTENT`、existing 不同 openid→`SELF_DIFFERENT`（R2，本账号已绑别的微信）、无 existing→`CONFLICT`（openid 被他号占，**不泄露他账号**）；返回 4 态判别结果（`CREATED|IDEMPOTENT|SELF_DIFFERENT|CONFLICT`）。**MUST NOT 改 displayName/bio/gender**（不回填）+ 单测（Testcontainers：新建→CREATED + 落库逐字段 / 同号同 openid 重→IDEMPOTENT 无重复行 / 同号绑不同 openid→SELF_DIFFERENT 无副作用 / 他号同 openid→CONFLICT）。**run via `nx test server <file>`（cwd=apps/server）**
- [X] T006 [P] [Server] `commit-wechat-unbind.usecase.ts` in `apps/server/src/account/`（tx 参与，镜像 `commit-account-freeze`）：`execute(tx, accountId)` 条件 `tx.wechatBinding.deleteMany({where:{accountId, provider:'WECHAT'}})` → `{won: count===1}` + 单测（Testcontainers：有绑定→won / 无绑定→`won:false` lost / 跨 provider 不误删）
- [X] T007 [P] [Server] `inspect-wechat-binding.usecase.ts` in `apps/server/src/account/`（只读）：`execute(accountId) → {bound:boolean}`（`count`/`findFirst` WHERE accountId AND provider='WECHAT'）+ 单测（绑定存在→true / 无→false / 跨 provider 隔离不误判）
- [X] T008 [Server] **接线 + throttler 反污染 chore**：①`account/account.module.ts` providers + exports 三 use case（`CommitWechatBindUseCase` / `CommitWechatUnbindUseCase` / `InspectWechatBindingUseCase`，供 auth ctx 跨界 DI）②`security/throttler-skip-buckets.ts`（**实证在 security/ 非 auth/**，plan §Project Structure 路径误植）加 `WECHAT_BIND_BUCKETS{wx-bind, wx-bind-ip}` / `WECHAT_UNBIND_CODE_BUCKETS{wx-unbind-code, wx-unbind-code-ip}` / `WECHAT_UNBIND_BUCKETS{wx-unbind, wx-unbind-ip}` + aggregate `WECHAT_BUCKETS`（spread 三组）③`auth.module.ts` `ThrottlerModule` `throttlers[]` 注册 6 个新 named throttler（getTracker per-account/per-IP，复制 `del-*` 形状）④**所有既有 controller**（account-deletion / cancel-deletion / device-management / account-token / account-sms-code / me 等）`@SkipThrottle` spread `...WECHAT_BUCKETS` 跳过新桶（反污染，同 004 5→17 桶 chore，per `throttler-skip-buckets.ts` 文件头注释）+ verify typecheck 绿

---

## Phase 3: User Story 1 — [Server] 绑定创建 + 冲突规则 (P1) 🎯 MVP

**Independent Test**: Testcontainers；authed + stub openid → 201 + 绑定落库（account↔openid、boundAt）+ profile（displayName/头像）不变 + `GET /me` `wechatBound:true`；同 openid 他号 → 409 不泄露；自号重 → 幂等无副作用；缺 token → 401。

- [X] T009 [P] [US1] [Server] `wechat-already-bound.exception.ts` in `apps/server/src/auth/`（`HttpException` 409，`code='WECHAT_ALREADY_BOUND_OTHER'`，RFC 9457 ProblemDetail，镜像 `auth-attempt-locked.exception.ts`；**不含他账号任何信息**）+ `wechat-account-already-bound.exception.ts`（R2：409 `code='WECHAT_ACCOUNT_ALREADY_BOUND'`，detail「请先解绑当前微信」，同范式）+ `bind-wechat.request.ts`（`{authCode}` `@IsString @IsNotEmpty`）+ 单测（两 exception shape / DTO 校验）
- [X] T010 [US1] [Server] `bind-wechat.usecase.ts` in `apps/server/src/auth/`（auth 编排）：注入 `WECHAT_AUTH` port + `InspectAccountStatusByIdUseCase`（注入点 `// CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛`）+ `CommitWechatBindUseCase`（注入点 `// CROSS-CONTEXT-SYNC: auth→account create wechat binding (R2 写)`）→ `resolveIdentity(authCode)`（tx 外）→ inspect 非 ACTIVE → 折叠 `UnauthorizedException`（反枚举）→ `commitWechatBind.execute` → CREATED/IDEMPOTENT 返回（同 201）、CONFLICT → throw `WechatAlreadyBoundException`、SELF_DIFFERENT → throw `WechatAccountAlreadyBoundException`（R2）+ 单测（mock：ACTIVE+未绑→201 / 他号同 openid→409 OTHER / 自号同 openid→幂等 201 / 自号绑不同 openid→409 ACCOUNT_ALREADY_BOUND / 非 ACTIVE→401）
- [X] T011 [US1] [Server] `wechat-binding.controller.ts` in `apps/server/src/auth/`（`@Controller('v1/accounts')` + `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()`，对齐 `account-deletion.controller.ts`）：`@Post('me/wechat-binding')` `@HttpCode(201)`（EP1，accountId from JWT sub）+ Swagger（201/409 `WECHAT_ALREADY_BOUND_OTHER` + `WECHAT_ACCOUNT_ALREADY_BOUND`/401/429）+ named throttler `wx-bind` 5/60s + `wx-bind-ip` 10/60s + `@SkipThrottle` 其余桶 + register `auth.module.ts`（controller + bind-wechat usecase + `WECHAT_AUTH` env-gated `useFactory`，复制 `SMS_GATEWAY` factory 形状，**生产 boot 拒 mock**）+ 单测（mock usecase 映射 + 201 + 409）
- [X] T012 [US1] [Server-IT] `apps/server/test/integration/wechat-binding.us1-bind.it.spec.ts`（Testcontainers PG+Redis 全 boot）：ACTIVE 账号 login 取 token → bind（stub openid）→ 201 + DB `wechat_binding` 1 行（openid 非空 / boundAt≈now / provider=WECHAT）+ 账号 displayName/头像 **不变** + `GET /me` `wechatBound:true`；同 openid 他账号 bind → 409 `WECHAT_ALREADY_BOUND_OTHER`（body 不含他账号信息）；自号同 openid 重 bind → 幂等（DB 仍 1 行、无副作用）；缺 token → 401

---

## Phase 4: User Story 2 — [Server] 解绑发码 + 验码解绑 (P1)

**Independent Test**: Testcontainers；bound+ACTIVE authed 发码 → 204 + DB 1 条 active `UNBIND_WECHAT` 哈希码（10min/usedAt 空）+ 绑定不变 + 无事件；持有效码提交 → 单 tx markUsed + 删绑定 + 204 + `GET /me` `wechatBound:false`；码失败 4 分支字节级一致 401；并发同码恰 1 次；未绑/非 ACTIVE 发码 → 反枚举折叠。

- [X] T013 [US2] [Server] `send-unbind-wechat-code.usecase.ts` in `apps/server/src/auth/`（1:1 镜像 `send-deletion-code.usecase.ts`）：注入 `InspectAccountStatusByIdUseCase`（`// CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛`）+ `InspectWechatBindingUseCase`（`// CROSS-CONTEXT-SYNC: auth→account 读绑定门槛`）+ `DeletionCodeStore` + `SmsGateway` → inspect 非 ACTIVE **或** 未绑 → 字节级一致折叠 `UnauthorizedException`（FR-S03 反枚举）→ 否则 `store.issue(accountId, UNBIND_WECHAT, hash, now+10min)` + `sendCode(phone, code, UNBIND_WECHAT)`；**无绑定改动、无事件**；SMS 失败 → `SmsSendFailedException`(503)（复用 004 `sms-send-failed.exception.ts`）+ 单测（mock：bound+ACTIVE→发码 / 未绑→401 / 非 ACTIVE→401 / NOT_FOUND→401，字节级一致）
- [X] T014 [US2] [Server] `unbind-wechat.usecase.ts` in `apps/server/src/auth/`（**auth 持 tx**，1:1 镜像 `delete-account.usecase.ts`）：码校验 tx 外（`findActive(UNBIND_WECHAT)` + HMAC compare，4 分支折叠 `UnauthorizedException('INVALID_UNBIND_CODE')`）→ `$transaction`(READ COMMITTED)：`store.markUsed(tx, codeId)`→false⇒401 回滚（恰一次闸）+ `commitWechatUnbind.execute(tx, accountId)`（注入点 `// CROSS-CONTEXT-SYNC: auth→account 删绑定 (R2 写)`）→`won:false`⇒401 回滚。**无 token revoke、无事件**（O6）+ 单测（mock：happy 各步序 / 4 码失败折叠 401 / markUsed lost→回滚 / commitUnbind `won:false`→回滚无副作用）
- [X] T015 [P] [US2] [Server] `unbind-wechat.request.ts` in `apps/server/src/auth/`（`{code}` `@Matches(/^\d{6}$/)`，非法→400 `FORM_VALIDATION`，copy `delete-account.request.ts`）+ 单测（合法 6 位 / 缺失 / 非数字 / 长度错 → 400）
- [X] T016 [US2] [Server] `wechat-binding.controller.ts` 加 `@Post('me/wechat-binding/unbind-codes')` `@HttpCode(204)`（EP2，accountId from bearer，无 body）+ `@Post('me/wechat-binding/unbind')` `@HttpCode(204)`（EP3）+ Swagger（204/401 折叠 `INVALID_UNBIND_CODE`/400/429，EP3 字节镜像 `POST me/deletion`）+ named throttler `wx-unbind-code` 1/60s + `wx-unbind-code-ip` 5/60s · `wx-unbind` 5/60s + `wx-unbind-ip` 10/60s + `@SkipThrottle` 其余 + register usecase providers + 单测（mock 映射 + 码格式 400）
- [X] T017 [US2] [Server-IT] `apps/server/test/integration/wechat-binding.us2-send-code.it.spec.ts`（全 boot）：bound+ACTIVE authed 发码 → 204 + DB 恰 1 条 active `UNBIND_WECHAT` 码（codeHash 非空 / expiresAt≈+10min / usedAt null）+ 绑定不变 + **无** outbox 行 + `MockSmsGateway.getLastPurpose===UNBIND_WECHAT`；未绑微信 ACTIVE 账号发码 → 401 字节级一致（与无 token 比，反枚举）；非 ACTIVE → 401；per-account 第 2 次 60s 内 → 429
- [X] T018 [US2] [Server-IT] `apps/server/test/integration/wechat-binding.us2-unbind-anti-enum-concurrency.it.spec.ts`：发码 → 持正确码提交 → 204 + DB 绑定删除（0 行）+ 码 usedAt 置 + `GET /me` `wechatBound:false` + 账号 displayName/头像不变；①4 类码失败（未找/哈希不符/过期/已用）响应字节级一致（剥 traceId 后 ProblemDetail 深等，均 401 `INVALID_UNBIND_CODE`）+ 缺/非 `\d{6}`→400；②5 并发持同码提交（service 层直测绕限流）→ 恰 1×204 + 4 失败，DB 绑定删除单次、不双删
- [X] T018b [US2] [Server-IT] `apps/server/test/integration/wechat-binding.us2-rate-limit.it.spec.ts`（全 boot + `beforeEach` Redis flushall，镜像 004 `deletion.us9-rate-limit.it.spec.ts`，trace FR-S06）：6 桶各超限 → 429 + `Retry-After`（`wx-bind` account 第 6/IP 第 11 · `wx-unbind-code` account 第 2/IP 第 6 · `wx-unbind` account 第 6/IP 第 11）+ 限流命中时未触账号加载/未写码行/未改绑定

---

## Phase 5: User Story 1+2 状态契约 — [Server] /me 扩展 + Contract 同步链（Constitution V）

- [X] T019 [Server] EP4 `/me` 扩展：`account-profile.response.ts` 加 `@ApiProperty wechatBound: boolean`（**MUST NOT 返 openid**，FR-S07）+ `get-account-profile.usecase.ts` 加 R1 **同 account ctx** 读 `wechat_binding` 存在性（复用 `InspectWechatBindingUseCase` 或直读，account 内 ctx → **无** cross-ctx 注释）+ 单测（bound→true / 无→false / 响应不含 openid 任何字段）
- [X] T020 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（canonical `node dist/main.js`，含 EP1 `me/wechat-binding` · EP2 `me/wechat-binding/unbind-codes` · EP3 `me/wechat-binding/unbind` + EP4 `AccountProfileResponse.wechatBound`）→ `nx run api-client:generate`（Orval regen）→ typed hooks（`useWechatBindingControllerBind` 等 + `wechatBound` 字段，**函数式非 class** ✓）+ api-client/mobile typecheck 绿

---

## Phase 6: User Story 3 — [Mobile] 绑定入口（007 微信行翻 active，Phase 1 stub）(P1)

**Independent Test**: Playwright Expo Web（stub）；seed `/me {wechatBound:false}` → 账号与安全页微信行「绑定」→ 点击 → stub 授权 → mock bind 201 → 行翻「解绑」。

- [X] T021 [US3] [Mobile] `src/wechat/use-wechat-bind.ts`（镜像 `src/auth/delete-account.ts`）：stub `authorizeWechatStub()` 返确定性 authCode → Orval `useWechatBindingControllerBind({data:{authCode}})`；onSuccess invalidate `useMe` query→行翻解绑；409→toast「该微信已绑定其他账号」行不变；失败→toast 不脏写（仅服务端确认后翻行，FR-C06）+ `src/wechat/wechat-errors.ts`（镜像 `deletion-errors.ts`：409/401/network 映射）+ `src/wechat/index.ts` barrel + vitest logic 单测（错误映射 / onSuccess invalidate / 409 不脏写）。Metro 相对 import **extensionless**（per memory `metro_web_cannot_resolve_js_extension_imports`）
- [X] T022 [US3] [Mobile] `app/(app)/settings/account-security/index.tsx`：从 `useMe()` 读 `wechatBound`；既有 disabled 微信 `<Row>`（D1）改活行：unbound→bind 流（接 use-wechat-bind），bound→确认对话→`router.push('.../wechat-unbind')`；确认对话**内联** 006 范式（`Platform.OS==='web'?window.confirm('确定要解除微信绑定?'):Alert.alert(...)`，copy 自 `settings/index.tsx`）；**web 生产端隐藏绑定按钮**（决策4；e2e 仍走 stub）；google 保持 disabled。+ 更新 `e2e/account-security-refactor.spec.ts` 微信断言（D7：旧断言微信行 disabled/不导航 → state-driven 活行）
- [X] T023 [US3] [Mobile-E2E] `apps/mobile/e2e/wechat-binding.spec.ts` **bind 段**（Playwright Web，复用 `_support/api-mock.ts` mockJson + addInitScript seed，**mock REFRESH_URL 200**）：seed `/me {wechatBound:false}`→进账号与安全页→微信行「绑定」→点击→stub authorize→mock bind 201→re-mock `/me {true}`→断言行翻「解绑」；409 段：mock 409→toast + 行保持「绑定」。`getByRole` 收窄（stacked screen）；web-stripped URL；本地跑前杀 :3000 nx serve 父进程

---

## Phase 7: User Story 4 — [Mobile] 解绑流（确认对话 + 短信验证码页，Phase 1）(P1)

**Independent Test**: Playwright Web；seed `/me {true}` → 微信行「解绑」→ 确认对话「确定要解除微信绑定?」→ 确定 → 解绑验证页 → 发码（mock 204）→ 输码 → 提交（mock 204）→ 返回、行翻「绑定」；取消 → 留原页、仍绑定。

- [X] T024 [US4] [Mobile] `src/wechat/wechat-unbind-form.schema.ts`（`{code: z.string().regex(SMS_CODE_REGEX)}` 复用 login schema regex）+ `src/wechat/use-wechat-unbind-form.ts`（镜像 `use-delete-account-form.ts`，**去双勾选 + 去 success-clearSession**——解绑保留 session）：idle/sms_sent/submitting/success/error 状态机 + isSubmitting 单源 + 60s countdown + 发码（Orval unbind-codes）+ 提交（Orval unbind）+ onSuccess invalidate `useMe` + `router.back()` + error latch + vitest logic 单测（状态机迁移 / isSubmitting 单源 / 60s countdown / error 映射 / 成功不 clearSession）
- [X] T025 [US4] [Mobile] `app/(app)/settings/account-security/wechat-unbind.tsx`（`delete-account.tsx` 近拷去双勾选块）：标题「账号解绑」+ 副文「您正在申请解除微信绑定，需验证以下身份」+ `~/ui/SmsInput`（RHF `<Controller>`）+ 发码按钮 + 提交「确认解绑」，接 `use-wechat-unbind-form` + `app/(app)/settings/account-security/_layout.tsx` 注册 `wechat-unbind` Stack.Screen（标题「账号解绑」）+ typecheck/lint 绿。RHF Golden Sample 4 铁律（Controller 非 register / 表单态副作用态分层 / isSubmitting 单源 / 错误+a11y 一体）
- [X] T026 [US4] [Mobile-E2E] `apps/mobile/e2e/wechat-binding.spec.ts` **unbind 段**：seed `/me {true}`→微信行「解绑」→点击→`window.confirm` 确定→`/wechat-unbind`→发码（mock 204）→输码→提交（mock 204）→re-mock `/me {false}`→断言 `router.back` + 行翻「绑定」；确认对话点「取消」→留原页、仍绑定；码错→401「验证码错误」/ 400 格式 → 提示、仍绑定。**mock REFRESH_URL 200**（避 refresh 拦截器误登出）；`getByRole` 收窄

---

## Phase 8: Polish & Verify

- [X] T027 [Server] catalog Operation 清单新增 6 行：`docs/conventions/server-bounded-context-catalog.md` § Operation Catalog 加 `commit-wechat-bind` / `commit-wechat-unbind` / `inspect-wechat-binding`（account）+ `bind-wechat` / `send-unbind-wechat-code` / `unbind-wechat`（auth 编排），propagation 标 R2 CROSS-CTX-SYNC + source PR；spec.md `modules:` frontmatter `[account, auth, security]` 与 catalog 该 6 operation context 一致；spec frontmatter `status: draft→implemented`；plan frontmatter `status: planned→done`
- [X] T028 [Verify] **全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`）：lint+typecheck（4 projects 0）/ test（server 全 Testcontainers IT 含 US1/US2；mobile use-wechat-bind + use-wechat-unbind-form + wechat-errors + schema 单测；api-client）/ build / runtime-smoke（`server-boot-smoke` 真 boot 探 EP1-4 契约 + RFC 9457 ProblemDetail + mobile `expo export -p web` + playwright e2e 含 T023/T026）+ `check-server-moat.ts` **0 违规**（跨 ctx 注释齐）+ 真后端冒烟（bind→发码→解绑 主路径 IT 等价）

---

## Phase 9: User Story 5 — [Phase 2] 真实 native 微信 SDK 接入 port (P2 · 后续独立 PR)

> **本批（Phase 1 PR）不交付**。Phase 2 = 真实 native 微信授权接入同一 bind port（**bind 契约不变，仅 adapter 替换**），**设备专属、无 web e2e**。
> **阻塞性产品/运维前置（非代码，per plan §Phasing）**：开放平台企业认证（¥300，~3 工作日）+ AppID/AppSecret（[ADR-0037](../../docs/adr/0037-security-credentials-governance.md)）+ 应用签名报备 + custom dev client pipeline（不支持 Expo Go）。
> 下列 task 待前置就绪后另开 PR，届时本节转入新 tasks.md（或本文件续编）。

- [ ] T029 [US5] [Server] `wechat-auth.gateway.ts` in `apps/server/src/auth/`（Phase 2 real）：AppID/AppSecret 调 `GET https://api.weixin.qq.com/sns/oauth2/access_token?...&grant_type=authorization_code` 换 openid/unionid，包 `RETRY_EXECUTOR`（同 `AliyunSmsGateway`）+ `wechat.config.ts` `kind='real'` 生产 env Zod 校验 + `auth.module.ts` env-gated `useFactory` 切换（**生产 boot 拒 `kind==='mock'`**）+ 单测/IT（mock 微信 API 响应：成功换 openid / 微信错误码 / 网络重试）。设备专属、无 web e2e
- [ ] T030 [US5] [Mobile] native 微信 SDK 接入：expo config plugin + custom dev client + 开放平台 AppID → `sendAuthRequest` → 授权 code → 接入 `use-wechat-bind`（替换 `authorizeWechatStub()`，bind 端点契约不变）+ 拒绝/未装微信友好提示。**设备/手动验证**（SC-007 覆盖缺口：无 web e2e；production web 真实绑定[扫码/H5] out of scope，不假装覆盖）

---

## Dependencies（完成顺序）

```text
Setup(T001) → Foundational(T002-T008) → US1(T009-T012) → US2(T013-T018) → /me+Contract(T019-T020) → US3 mobile(T021-T023) → US4 mobile(T024-T026) → Polish(T027-T028) ┄┄> [后续 PR] Phase 2(T029-T030)
```

- **Foundational 阻塞全部 US**：T002（port）→ T010 bind；T003（UNBIND_WECHAT 枚举）→ T013/T014；T004（schema/migration）→ T005/T006/T007（account 三原语）；T008（module 接线 + throttler buckets）→ 所有 controller task。
- **US1**：T009（exception+DTO）[P]；T010（usecase）依赖 T002/T005/`InspectAccountStatusById`；T011（controller）依赖 T009/T010/T008；IT T012 依赖 T011。
- **US2**：T013（发码 usecase）依赖 T003/T007/`DeletionCodeStore`/`SmsGateway`；T014（解绑 usecase 持 tx）依赖 T003/T006/`DeletionCodeStore`；T015（DTO）[P]；T016（controller 加 2 端点）依赖 T013/T014/T015/T011（同文件续）；IT T017/T018/T018b 依赖 T016（T018b rate-limit 依赖全 6 桶在 T008 注册 + T011/T016 端点落地）。
- **/me+Contract**：T019 依赖 T007（inspect）；T020（openapi+Orval）依赖 4 端点全落（T011/T016）+ T019。
- **Mobile（US3/US4）** 依赖 T020（typed api-client）。US4 的 `wechat-unbind.tsx`（T025）依赖 T024（form hook）；e2e T023/T026 同 spec 文件（bind/unbind 两段）依赖各自屏落地。
- **Phase 2（T029/T030）** 依赖 Phase 1 全落 + 非代码产品前置；**不阻塞 Phase 1 交付**。

## Parallel Opportunities

- Foundational：T002（port）∥ T003（rules 枚举）∥ T005（commit-bind）∥ T006（commit-unbind）∥ T007（inspect）（不同文件；均依赖 T004 schema 先落 → T005/T006/T007 在 T004 后并行）。
- US1：T009（exception+DTO）∥ T010 前置准备（不同文件）。
- US2：T015（DTO）∥ T013/T014（usecase，不同文件）。
- Mobile：T021（bind hook）∥ T024（unbind form，不同文件）。

## Implementation Strategy

1. **MVP = US1**（绑定创建 + 冲突）：建立 bind port stub + WechatBinding 表 + account 写原语，验唯一性冲突闸（他号 409 不泄露 / 自号幂等）。
2. **解绑链（US2）**：发码（镜像 send-deletion-code，加 inspectWechatBinding 门槛）→ 验码删绑定（**auth 持 tx 跨 account ctx**，affected-count 恰一次 + 4 分支折叠 401），100% 复用 004 安全保证。
3. **契约同步**：/me 加 `wechatBound`（account 内 ctx 读）→ openapi+Orval regen（typed hooks 供 mobile）。
4. **mobile 闭环**：US3（007 占位行翻活行 + bind 入口）→ US4（确认对话 + 解绑验证页，复用 SmsInput + RHF delete-account 范式去双勾选）。
5. **收尾**：catalog 6 行 + frontmatter + 全门 verify（含 runtime-smoke 探 EP1-4 + e2e）。
6. **Phase 2（后续 PR）**：real adapter（不改契约，仅替 stub）+ native SDK，待开放平台/custom dev client 产品前置就绪。
7. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环）；并发原语全程 affected-count（禁 FOR UPDATE/Serializable）。
