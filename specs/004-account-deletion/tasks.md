---
feature_id: 004-account-deletion
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-26'
---

# Tasks: 004-account-deletion（注销 → 15 天冻结 → 撤销 / 匿名化）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `004-account-deletion`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]`（per sdd.md）
- **TDD（强制）**：每个 impl task 内联绑 **unit 测试**（红→绿→typecheck/lint→`[X]`→commit，6 步闭环，per `.claude/rules/implement-task-closure.md`）；**integration 测试（Testcontainers）单列 `[Server-IT]` task**（= 每 US 的 Independent Test 验收）
- 无 task-meta JSON（手动模式，per p3 §3）
- 三位一体：server + contract + mobile **同 1 PR**
- **并发原语**（D2）：所有状态转换用 READ COMMITTED + 条件 UPDATE `updateMany` affected-count，**不**用 `FOR UPDATE` / Serializable（per plan D2 + memory `prisma_serializable_p2002_and_p2034`）

## Path Conventions

- server：`apps/server/src/{auth,account,security}/`（ADR-0043 扁平，文件平铺）；IT：`apps/server/test/integration/`
- contract：`apps/server/openapi.json` → `packages/api-client/`（Orval）
- mobile：`apps/mobile/app/(auth)/` + `apps/mobile/src/auth/`；e2e：`apps/mobile/e2e/`

---

## Phase 1: Setup & 决策

- [X] T001 [Server] 装 `@nestjs/schedule`（`pnpm -C apps/server add @nestjs/schedule`）+ `ScheduleModule.forRoot()` 注册进 `apps/server/src/app.module.ts`（或 `account.module.ts`）+ verify typecheck/build 绿（mono 首个 scheduler）。锚定 plan 6 决策：D1 用 DB `account_sms_code`（已 db-pull 无 migration）/ D2 affected-count 非悲观锁 / D3 R2 sync 扩 `revokeAllForAccount` 收 tx / D4 scheduler 每日 cron / D5 sms purpose / D6 匿名化不删码行

## Phase 2: Foundational（阻塞多 US — security 扩 + account.rules + sms infra）

- [X] T002 [P] [Server] `account.rules.ts` in `apps/server/src/account/` 扩 state-transition 纯函数 + 常量 + 单测：`canFreeze(a)`（status===ACTIVE）/ `isFrozenInGrace(a, now)`（FROZEN ∧ freezeUntil>now）/ `canCancelFromFrozen(a, now)`（=isFrozenInGrace）/ `canAnonymize(a, now)`（FROZEN ∧ freezeUntil!=null ∧ freezeUntil<=now）；常量 `FREEZE_DURATION_DAYS=15` / `ANONYMIZED_DISPLAY_NAME='已注销用户'`；单测（表驱动：各状态 × grace 边界 freezeUntil = now-1ms/now/now+1ms，验 `>` vs `<=` 严格划分）
- [X] T003 [P] [Server] `refresh-token.service.ts` in `apps/server/src/security/`：`revokeAllForAccount(accountId, now, tx?)` + `persist(accountId, rawToken, meta, tx?)` 加可选 tx-client 重载（tx 传 → 用 `tx.refreshToken.*`，否则 `this.prisma.*`，**既有行为不变**）+ 定义 `TxClient` 类型（`Prisma.TransactionClient`）+ 单测（Testcontainers：tx 内 revoke 与外部 commit/rollback 联动 — 模拟 caller tx rollback → token 未撤）。**回归**：003 logout-all / login persist 既有调用（无 tx arg）全绿
- [X] T004 [P] [Server] outbox publisher `producer_context` 参数化 in `apps/server/src/security/outbox/`：`publish(client, eventType, payload, producerContext?='auth')` 加可选入参（account 发 AnonymizedEvent 传 `'account'`）+ 单测（envelope `metadata.producer_context` 按入参 / 默认 'auth' 不破 003 既有）
- [X] T005 [P] [Server] `deletion-code.rules.ts` in `apps/server/src/auth/`：纯函数 + 常量 —— 复用 `generateSmsCode()`（6 位 CSPRNG，既有）+ HMAC-SHA256 hash/compare（复用 ADR-0023 secret，与 `sms-code.store.ts` 同 hasher）+ 常量 `DELETION_CODE_TTL_MIN=10` + `SmsPurpose` 枚举（`DELETE_ACCOUNT` / `CANCEL_DELETION`）+ 单测（hash 稳定 / timing-safe compare / TTL 常量）
- [X] T006 [Server] `deletion-code.store.ts` in `apps/server/src/auth/`（DB `account_sms_code`，PrismaService 直注，无 repository，ADR-0043）：`issue(accountId, purpose, codeHash, expiresAt, tx?)`（`create`）/ `findActive(accountId, purpose, now)`（`usedAt==null ∧ expiresAt>now ∧ purpose` 过滤，偏索引 `idx_account_sms_code_account_purpose_active`）/ `markUsed(codeId, now, tx)`（条件 `updateMany where {id, usedAt:null}` affected-count）+ 单测（Testcontainers PG：issue→findActive 命中 / 过期 miss / 已用 miss / 跨 purpose 隔离 miss / markUsed 幂等）。**run via `nx test server <file>`（cwd=apps/server）**
- [X] T007 [P] [Server] `sms-gateway.port.ts` `sendCode(phone, code, purpose?: SmsPurpose)` 加 purpose 入参 + `aliyun-sms.gateway.ts` 按 purpose 选 templateCode（config 加 `DELETE_ACCOUNT` / `CANCEL_DELETION` templateCode，缺省回退既有）+ `mock-sms.gateway.ts` 记录 purpose + 单测（各 purpose 选对模板 / 缺省回退）。**回归**：001 request-sms-code（无 purpose）全绿
- [X] T007b [P] [Server] **FR-S21 503 映射**（analyze C1）：`sms-send-failed.exception.ts` in `apps/server/src/auth/`（`HttpException` 503，`code='SMS_SEND_FAILED'`，RFC 9457 ProblemDetail，镜像 `auth-attempt-locked.exception.ts`）；gateway `sendCode` 抛底层错误时 usecase（T008/T017 eligible 发码路径）catch→转 `SmsSendFailedException` + 单测（gateway 抛 → 503 SMS_SEND_FAILED）。mono 001 无此映射（grep 实证非 reuse），本批新增

---

## Phase 3: User Story 1 — 发送注销验证码 SendDeletionCode (P1) 🎯 MVP

**Independent Test**: ACTIVE 账号持有效 token 发码 → 204 + DB active DELETE_ACCOUNT 码；FROZEN/ANONYMIZED → 401 `INVALID_CREDENTIALS` 反枚举，无码行。

- [X] T008 [US1] [Server] `send-deletion-code.usecase.ts` in `apps/server/src/auth/`：注入 `InspectAccountStatusByIdUseCase`（注入点 `// CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛`）+ `DeletionCodeStore` + `SmsGateway` → `inspectAccountStatusById(accountId)` 非 ACTIVE → throw `UnauthorizedException('INVALID_CREDENTIALS')`（反枚举折叠）→ `generateSmsCode` + HMAC → `store.issue(accountId, DELETE_ACCOUNT, hash, now+10min)` → `sendCode(phone, code, DELETE_ACCOUNT)` + 单测（mock：ACTIVE→发码 / FROZEN→401 / ANONYMIZED→401 / NOT_FOUND→401，字节级一致）
- [X] T009 [US1] [Server] `account-deletion.controller.ts` in `apps/server/src/auth/`（`@Controller('v1/accounts')`，挂 `JwtAuthGuard`）：`@Post('me/deletion-codes')` `@HttpCode(204)`（EP1，accountId from JWT sub，phone from account）+ Swagger（204/401/429/503）+ register `auth.module.ts`（controller + usecase provider）+ named throttler `del-code-account` 1/60s（AccountIdThrottlerGuard 复用）+ `del-code-ip` 5/60s + `@SkipThrottle` 其余桶（反污染）+ 单测（mock usecase 映射 + 204）
- [X] T010 [US1] [Server-IT] `apps/server/test/integration/deletion.us1-send-code.it.spec.ts`（Testcontainers PG+Redis 全 boot）：ACTIVE 账号 login 取 token → 发码 → 204 + DB 1 条 active DELETE_ACCOUNT 码（codeHash 非空 / expiresAt≈+10min / usedAt null）；FROZEN 账号（freezeUntil 未来）持旧 token → 401 `INVALID_CREDENTIALS` 字节级一致（与无 token 比），无新码行

---

## Phase 4: User Story 2 — 提交验证码冻结 DeleteAccount (P1) + US3 反枚举/并发

**Independent Test**: 正确码 → 单 tx：码 markUsed + ACTIVE→FROZEN(freezeUntil+15d) + 撤全 token + outbox RequestedEvent + 204；注入撤 token 失败 → 整 tx 回滚。4 码失败字节级一致 401 `INVALID_DELETION_CODE`；5 并发恰一。

- [X] T011 [US2] [Server] `commit-account-freeze.usecase.ts` in `apps/server/src/account/`（tx 参与：`execute(tx, accountId, freezeUntil)` 条件 UPDATE `tx.account.updateMany({where:{id, status:'ACTIVE'}, data:{status:'FROZEN', freezeUntil, updatedAt}})` → 返回 `{ won: count===1 }`，用 `account.rules` 常量）+ 单测（Testcontainers：ACTIVE→won / 已 FROZEN→count0 lost / 不存在→lost）
- [X] T012 [P] [US2] [Server] `account-deletion-requested.event.ts` in `apps/server/src/account/`：事件类型 + payload `{ accountId, freezeAt, freezeUntil, occurredAt }` + `ACCOUNT_DELETION_REQUESTED_EVENT_TYPE='auth.account.deletion-requested'`（analyze I1：follow mono `auth.account.created` 范式 `<producer-ctx>.<aggregate>.<action>`；delete 由 auth 编排产，故 `auth.` 前缀 + producerContext='auth'）（镜像 `account-created.event.ts`）+ 单测（payload shape）
- [X] T013 [US2] [Server] `delete-account.usecase.ts` in `apps/server/src/auth/`（**auth 持 tx**）：findActive(DELETE_ACCOUNT 码) + HMAC compare（4 失败折叠 `UnauthorizedException('INVALID_DELETION_CODE')`）→ `prisma.$transaction`（READ COMMITTED）：`store.markUsed(tx, codeId)` + `account.commitAccountFreeze(tx, accountId, now+15d)`（`won=false`→throw 回滚）+ `security.revokeAllForAccount(accountId, now, tx)` + `outbox.publish(tx, RequestedEvent)` → 完成。跨 ctx 注入点 `// CROSS-CONTEXT-SYNC`（CommitAccountFreeze + RefreshTokenService）+ `// CROSS-CONTEXT-ASYNC: account.deletion-requested`（publish 上方）+ 单测（mock：happy 各步序 / 码失败 401 / commitFreeze lost→统一失败 / revoke 抛→整 tx 回滚无事件）
- [X] T014 [US2] [Server] `account-deletion.controller.ts` 加 `@Post('me/deletion')` `@HttpCode(204)`（EP2）+ `delete-account.request.ts`（`{ code }` `@Matches(/^\d{6}$/)`，非法→400 `FORM_VALIDATION`）+ Swagger（204/401 INVALID_DELETION_CODE/400/429）+ named throttler `del-submit-account` 5/60s + `del-submit-ip` 10/60s + 单测（mock 映射 + 码格式 400）
- [X] T015 [US2] [Server-IT] `deletion.us2-freeze.it.spec.ts`（全 boot）：发码 → 提交正确码 → 204 + DB 账号 status=FROZEN / freezeUntil≈+15d / 码 usedAt 置 / 该账号 refresh token 全撤 / outbox 1 条 `account.deletion-requested`（payload 逐字段）；**原子性**：注入 revoke 失败 fixture → 账号仍 ACTIVE / freezeUntil null / 码仍 active / 无事件
- [X] T016 [US3] [Server-IT] `deletion.us3-anti-enum-concurrency.it.spec.ts`：①4 类码失败（未找到/哈希不符/过期/已用）响应字节级一致（剥 traceId 后 ProblemDetail 深等，均 401 `INVALID_DELETION_CODE`）+ 缺/非 `\d{6}` → 400 ②5 并发持同码提交（service 层直测绕限流）→ 恰 1×204 + 4 失败，DB FROZEN 单次 + outbox RequestedEvent 恰 1 条

---

## Phase 5: User Story 4 — 发送撤销验证码 SendCancelDeletionCode (P1, public 反枚举)

**Independent Test**: FROZEN-in-grace 手机号 → 200 + DB active CANCEL_DELETION 码 + SMS；4 ineligible → 200 无码行无 SMS + dummy 哈希 pad；eligible/ineligible 响应字节级一致。

- [X] T017 [US4] [Server] `send-cancel-deletion-code.usecase.ts` in `apps/server/src/auth/`：注入 `InspectAccountStatusUseCase`（by phone，`// CROSS-CONTEXT-SYNC`）+ `DeletionCodeStore` + `SmsGateway` + `TIMING_DEFENSE_EXECUTOR`（复用 `bcrypt-timing-defense.executor`）→ inspect(phone)：**eligible**（FROZEN ∧ freezeUntil>now，用 `account.rules.isFrozenInGrace`）→ issue CANCEL_DELETION 码 + `sendCode(phone, code, CANCEL_DELETION)`；**4 ineligible**（未注册/ACTIVE/ANONYMIZED/grace 已过）→ `timingDefense.pad()` 不发不写 → 均返 void（控制器 200）+ 单测（mock：eligible 发码 / 4 ineligible 各跑 pad 且不发不写 / 响应无差异）
- [X] T018 [US4] [Server] `cancel-deletion.controller.ts` in `apps/server/src/auth/`（`@Controller('v1/auth/cancel-deletion')`，**public 无 JwtGuard**）：`@Post('sms-codes')` `@HttpCode(200)`（EP3）+ `send-cancel-code.request.ts`（`{ phone }` `@Matches(E.164 大陆)`，非法→422 `INVALID_PHONE_FORMAT`）+ Swagger + 自定义 phone-hash throttler guard（镜像 `sms-phone-throttler.guard.ts`，`cancel-code` 1/60s + `cancel-code-ip` 5/60s，phone 哈希作 key）+ `@SkipThrottle` 其余 + register `auth.module.ts` + 单测（mock 映射 + phone 格式 422）
- [X] T019 [US4] [Server-IT] `cancel.us4-send-code-anti-enum.it.spec.ts`（全 boot）：FROZEN-in-grace 手机号 → 200 + DB 1 条 active CANCEL_DELETION 码 + mock gateway 收到 send；4 ineligible（未注册/ACTIVE/ANONYMIZED/grace 已过）各 → 200 + **无**码行 + **无** send；断言 eligible vs ineligible 响应 body/status 字节级一致 + 时序 diff P95 ≤ 50ms（dummy pad 对齐，N 次采样）

---

## Phase 6: User Story 5 — 提交撤销码解冻 CancelDeletion (P1) + US6 反枚举/并发

**Independent Test**: 正确码 → 单 tx：commitCancellation(FROZEN→ACTIVE) + 码 markUsed + 持久化新 token + outbox CancelledEvent + 200 LoginResponse；注入 token 失败 → 整 tx 回滚。5 类失败字节级 401 `INVALID_CREDENTIALS`；5 并发恰一。

- [X] T020 [US5] [Server] `commit-account-cancellation.usecase.ts` in `apps/server/src/account/`（tx 参与：`execute(tx, accountId, now)` 条件 UPDATE `tx.account.updateMany({where:{id, status:'FROZEN', freezeUntil:{gt:now}}, data:{status:'ACTIVE', freezeUntil:null, updatedAt}})` → `{ won: count===1 }`，grace 谓词内嵌防 scheduler 抢跑）+ 单测（Testcontainers：FROZEN-in-grace→won / grace 已过→lost / ACTIVE→lost / ANONYMIZED→lost）
- [X] T021 [P] [US5] [Server] `account-deletion-cancelled.event.ts` in `apps/server/src/account/`：payload `{ accountId, cancelledAt, occurredAt }` + `ACCOUNT_DELETION_CANCELLED_EVENT_TYPE='auth.account.deletion-cancelled'`（I1：auth 编排产，`auth.` 前缀）+ 单测
- [X] T022 [US5] [Server] `cancel-deletion.usecase.ts` in `apps/server/src/auth/`（**auth 持 tx，public**）：phone→accountId 解析 → 预生成 tokens（signAccess + genRefresh，纯）→ `$transaction`：`account.commitAccountCancellation(tx, accountId, now)`（`won=false`→throw）+ `store.findActive(CANCEL_DELETION)+markUsed(tx)` + HMAC compare（失败 throw）+ `security.persist(accountId, refresh, meta, tx)` + `outbox.publish(tx, CancelledEvent)` → 返 `LoginResponse`。5 类失败（未注册/ACTIVE/ANONYMIZED/grace 过/码失败）折叠 `UnauthorizedException('INVALID_CREDENTIALS')`，phone-class 分支前置 `timingDefense.pad()`；跨 ctx 注释齐 + 单测（mock：happy / 5 失败折叠 + phone-class pad / token persist 抛→回滚无事件无 token）
- [X] T023 [US5] [Server] `cancel-deletion.controller.ts` 加 `@Post()` `@HttpCode(200)`（EP4，复用 `PhoneSmsAuthResponse`）+ `cancel-deletion.request.ts`（`{ phone, code }`，缺字段→400）+ Swagger + named throttler `cancel-submit` 5/60s + `cancel-submit-ip` 10/60s（phone-hash guard）+ 单测（mock 映射）
- [X] T024 [US5] [Server-IT] `cancel.us5-unfreeze.it.spec.ts`（全 boot）：发撤销码 → 提交正确码 → 200 + 新 access/refresh；DB 账号 ACTIVE / freezeUntil null / 码 usedAt 置 / 新 1 条 active refresh token(30d) / outbox 1 条 `account.deletion-cancelled`；**原子性**：注入 persist 失败 → 账号仍 FROZEN / freezeUntil 不变 / 码仍 active / 无事件 / 无新 token
- [X] T025 [US6] [Server-IT] `cancel.us6-anti-enum-concurrency.it.spec.ts`：①5 类失败响应字节级一致（均 401 `INVALID_CREDENTIALS`）+ 缺字段 400 ②5 并发持同码（service 层直测）→ 恰 1×200 + 4×401，DB ACTIVE 单次 + outbox CancelledEvent 恰 1 条 + 新 token 恰 1 条

---

## Phase 7: User Story 7 — 冻结期满匿名化 AnonymizeFrozenAccount (P1, scheduler) + US8 互斥

**Independent Test**: FROZEN+freezeUntil≤now → 单行 tx：ANONYMIZED + phone null + displayName 常量 + previousPhoneHash + 撤全 token + outbox AnonymizedEvent；策略失败整行回滚 + REQUIRES_NEW 隔离 + 批 100 + phone-null 幂等 skip。US8：撤销⟷匿名化并发终态恒 ANONYMIZED。

- [X] T026 [US7] [Server] `commit-account-anonymization.usecase.ts` in `apps/server/src/account/`（**account 持 tx**：`execute(accountId, now)` 开 `$transaction`：先 `findUnique` 取 phone 算 `previousPhoneHash`（phone null→领域拒绝 skip）→ 条件 UPDATE `updateMany({where:{id, status:'FROZEN', freezeUntil:{lte:now}}, data:{status:'ANONYMIZED', phone:null, displayName:ANONYMIZED_DISPLAY_NAME, previousPhoneHash, freezeUntil:null, updatedAt}})`（`count=0`→skip 返回 `{ won:false }`）+ `security.revokeAllForAccount(accountId, now, tx)`（`// CROSS-CONTEXT-SYNC`）+ `outbox.publish(tx, AnonymizedEvent, 'account')`（`// CROSS-CONTEXT-ASYNC`）→ `{ won:true }`）+ 单测（Testcontainers：FROZEN-expired→匿名化逐字段 + token 撤 / FROZEN-in-grace→count0 skip / phone-null→领域拒绝 skip / revoke 抛→整行回滚无事件）
- [X] T027 [P] [US7] [Server] `account-anonymized.event.ts` in `apps/server/src/account/`：payload `{ accountId, anonymizedAt, occurredAt }` + `ACCOUNT_ANONYMIZED_EVENT_TYPE='account.account.anonymized'`（I1：strict `<producer-ctx>.<aggregate>.<action>` —— anonymize 由 account 产，producer=aggregate=account + producerContext='account'；双 account 视觉冗余但与 `auth.account.created` 结构一致）+ 单测
- [X] T028 [US7] [Server] `anonymize-frozen-accounts.scheduler.ts` in `apps/server/src/account/`：`@Cron('0 0 3 * * *', { timeZone:'Asia/Shanghai' })` → 扫 `account.findMany({where:{status:'FROZEN', freezeUntil:{lte:now}}, take:100})`（偏索引 `idx_account_freeze_until_active`）→ 逐 id 调 `commitAccountAnonymization`（每行独立 tx = REQUIRES_NEW 等价；领域拒绝/skip 不计失败、其他异常计 failure）+ 持续失败计数 + 阈值 3 升 ERROR log + metric + 单测（mock：批 100 上限 / 单行抛不阻塞 sibling / 失败计数阈值）。**注**：`@Cron` 走 e2e/手动触发验，单测测纯扫描+派发逻辑（注入 mock usecase）
- [X] T029 [US7] [Server-IT] `anonymize.us7.it.spec.ts`（全 boot 或 service 直触发）：FROZEN+freezeUntil 过去 + N active token → 触发 → 账号 ANONYMIZED / phone null / displayName=「已注销用户」/ previousPhoneHash=原哈希 / freezeUntil null / token 全撤 / outbox 1 条 `account.anonymized`；隔离：2 账号其一策略抛错 → 抛错行留 FROZEN 无事件、另一行成功（REQUIRES_NEW）；批次：>100 待匿名化 → 本轮 ≤100；幂等：phone-null 行重扫 → skip 不报错
- [X] T030 [US8] [Server-IT] `anonymize.us8-mutex.it.spec.ts`：FROZEN + freezeUntil 恰过 + active CANCEL_DELETION 码 → 并发触发 CancelDeletion + commitAnonymization → 断言终态恒 ANONYMIZED + 撤销 401 `INVALID_CREDENTIALS` + outbox 有 `account.anonymized`、**无** `account.deletion-cancelled`（谓词互斥 + 行写锁，重复跑 N 次稳定）

---

## Phase 8: User Story 9 — 限流 (P2)

- [X] T031 [US9] [Server-IT] `deletion.us9-rate-limit.it.spec.ts`（全 boot + `beforeEach` Redis flushall）：8 规则各超限 → 429 + `Retry-After`（del-code account 第 2/IP 第 6 · del-submit account 第 6/IP 第 11 · cancel-code phone 第 2/IP 第 6 · cancel-submit phone 第 6/IP 第 11）+ 限流命中时未触账号加载/未写码行（验证账号状态不变）

---

## Phase 9: Contract（类型同步链，Constitution V）

- [X] T032 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（含 4 端点：me/deletion-codes · me/deletion · auth/cancel-deletion/sms-codes · auth/cancel-deletion）→ `nx run api-client:generate`（Orval regen）→ 生成 typed 调用 + react-query hooks（**函数式非 class** ✓）+ api-client/mobile typecheck 绿。deletion 端点也 regen（供后续 settings shell；本批不接 UI）

---

## Phase 10: User Story 11 — FROZEN 登录拦截 + 撤销注销屏 (P2, client)

> US10（注销发起屏 delete-account）**已 clarify 定延后** settings shell feature → 本批无 task。

**Independent Test**: 登录撞 FROZEN → 拦截 modal（剩余天数 + 两分支）→ 撤销跳屏手机号预填 → 请求码 → 输码 → 提交 → 主页；保持分支留登录清 form。

- [X] T033 [P] [US11] [Mobile] 撤销注销屏 `apps/mobile/app/(auth)/cancel-deletion.tsx`（port 旧 `cancel-deletion.tsx`）：RHF + zodResolver（Golden Sample 4 铁律：Controller 非 register / 表单态副作用态分层 / isSubmitting 单源 / 错误+a11y）—— 手机号（路由参数 `phone` 预填 / 可手填）→ 请求撤销码（Orval `cancelDeletionControllerSendCode`）→ 输 6 位码 → 提交（`cancelDeletionControllerCancel`）→ 成功 setSession + AuthGate 跳主页 + `cancel-deletion-errors.ts` 错误映射（401 INVALID_CREDENTIALS / 422 / 429 → 文案）+ vitest logic 单测（错误映射 / 提交态 / 路由参数预填）。Metro `.js`：相对 import extensionless
- [X] T034 [US11] [Mobile] FROZEN 登录拦截 modal：改 `apps/mobile/app/(auth)/login.tsx` + `apps/mobile/src/auth/`——login 提交收到 403 `ACCOUNT_IN_FREEZE_PERIOD` + `freezeUntil`（001 server 已就位）→ 弹 modal（剩余冻结天数 = `ceil((freezeUntil-now)/天)` 纯函数 + 单测）+「撤销注销」（`router.push('/cancel-deletion?phone=...')`）/「保持注销」（清 form 留登录）+ vitest logic 单测（剩余天数计算 / 403 解析 / 分支路由）
- [X] T035 [US11] [Mobile-E2E] `apps/mobile/e2e/cancel-deletion.spec.ts`（Playwright Web，复用 `e2e/_support/api-mock.ts` `mockJson`）：mock login 返 403 ACCOUNT_IN_FREEZE_PERIOD+freezeUntil → 断言拦截 modal（剩余天数文案 + 两分支）→ 点撤销 → cancel-deletion 屏手机号预填 → 请求码（mock 200）→ 输码 → 提交（mock 200 LoginResponse）→ 断言路由 `/`（主页）；另测点「保持注销」→ 留 login + form 清。locator 优先 `getByRole`/`exact`（警惕中文 label 子串撞）

---

## Phase 11: Polish & Verify

- [X] T036 [Server] catalog Operation 清单新增 8 行：`server-bounded-context-catalog.md` § Operation Catalog 已实装表加 `send-deletion-code`/`delete-account`/`send-cancel-deletion-code`/`cancel-deletion`（auth 编排）+ `commit-account-freeze`/`commit-account-cancellation`/`commit-account-anonymization`/`anonymize-frozen-accounts`（account）+ `revoke-all-refresh-tokens` 标注扩 tx 重载 + 三 R3 事件（`auth.account.deletion-requested` / `auth.account.deletion-cancelled` / `account.account.anonymized`，per analyze I1）；从 anticipated 表移除已实装的 `freeze-account`（注明实装为 delete-account R2-sync 非预设 R3，记差异）；spec frontmatter `status: clarified→implemented`；plan frontmatter `status: planned→done`
- [X] T037 [Verify] **全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`）：lint+typecheck（4 projects 0）/ test（server 全 Testcontainers IT 含 US1-US9；mobile cancel-deletion + frozen modal 单测；api-client）/ build / runtime-smoke（server-boot-smoke 真 boot 探 4 端点契约 + mobile `expo export -p web` + playwright e2e 含 T035）+ `check-server-moat.ts` **0 违规**（跨 ctx 注释齐）+ 真后端冒烟（注销→冻结→撤销 主路径 curl 或 IT 等价）

---

## Dependencies（完成顺序）

```text
Setup(T001) → Foundational(T002-T007) → US1(T008-T010) → US2/3(T011-T016) → US4(T017-T019) → US5/6(T020-T025) → US7/8(T026-T030) → US9(T031) → Contract(T032) → US11 client(T033-T035) → Polish(T036-T037)
```

- **Foundational 阻塞全部 US**：T002（account.rules 状态函数）→ T011/T020/T026 commit；T003（security tx 重载）→ T013/T022/T026；T004（outbox producerContext）→ T026；T005/T006（deletion-code rules/store）→ T008/T013/T017/T022；T007（sms purpose）→ T008/T017。
- **US2** 内：T011（commit-freeze）∥ T012（event）[P]；T013（usecase）依赖 T011/T012/T003/T006；T014（controller）依赖 T013；IT T015/T016 依赖 T014。
- **US5** 内：T020（commit-cancel）∥ T021（event）[P]；T022 依赖 T020/T021/T003/T006；T023 依赖 T022。
- **US7** 内：T026（commit-anonymize）∥ T027（event）[P]；T028（scheduler）依赖 T026 + T001（@nestjs/schedule）；IT T029/T030 依赖 T028。
- **Contract（T032）** 依赖 4 端点全落（T009/T014/T018/T023）。
- **Client（US11）** 依赖 T032（typed api-client）。
- **US8 mutex IT（T030）** 依赖 T022（cancel）+ T026（anonymize）全落。

## Parallel Opportunities

- Foundational：T002（rules）∥ T003（security tx）∥ T004（outbox）∥ T005（code rules）∥ T007（sms gateway）（不同文件；T006 依赖 T005）。
- 各 US 内 commit usecase ∥ event 类型（T011∥T012 / T020∥T021 / T026∥T027）。
- Client：T033（cancel 屏）∥（T034 改 login 不同文件，但同 (auth) 组 — 可并行）。

## Implementation Strategy

1. **MVP = US1**（发码）：建立 DELETE_ACCOUNT 码发放，验 DB account_sms_code 路径 + 反枚举折叠。
2. **核心串行链**：US2（冻结，含 US3 反枚举/并发）→ US4（撤销发码）→ US5（解冻，含 US6 反枚举/并发）—— 注销生命周期主路径，**auth 持 tx 跨 3 ctx** 的新模式首落地（US2）。
3. **scheduler + 互斥**：US7（匿名化定时，account 持 tx）→ US8（撤销⟷匿名化互斥 IT，谓词互斥验证）。
4. **限流 + 同步链**：US9 限流 IT → Contract（T032 openapi+Orval）。
5. **client 恢复闭环**：US11（撤销屏 + FROZEN modal，依赖 typed api-client）。
6. **收尾**：catalog 8 行 + frontmatter + 全门 verify（含 runtime-smoke）。
7. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环）；并发原语全程 affected-count（D2，禁 FOR UPDATE/Serializable）。
