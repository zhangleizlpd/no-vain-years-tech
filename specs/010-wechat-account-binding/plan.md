---
feature_id: 010-wechat-account-binding
spec_ref: ./spec.md
status: done
created_at: '2026-05-31'
updated_at: '2026-05-31'
adr_refs: ['0023', '0024', '0032', '0035', '0037', '0043']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 010-wechat-account-binding（微信账号绑定/解绑 — 端口桩接 + 短信验证码解绑，两阶段）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `010-wechat-account-binding`

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per 004/006/007 先例）。
> **两阶段**：Phase 1 = bind+unbind 全链走「微信授权 port 桩接」（web Playwright 全测、单独 PR 先交付）；Phase 2 = 真实 native 微信 SDK 接入同一 port（设备专属、无 web e2e、后续 PR）。
> 本 plan 经**代码实证**（grep + Read），纠正 spec/调研里多处 stale 叙述（见 §
> Architecture Notes 的 Drift 表）。研究底稿见 `docs/private/plans/humble-squishing-flamingo.md`（main 仓，待移归档）。

## Summary _(mandatory)_

给已登录用户加「微信账号**绑定/解绑**」（**非微信登录**）。绑定授权抽象为 **port**（照搬 `SMS_GATEWAY` 范式）：客户端发不透明 `authCode`，服务端 `resolveIdentity(authCode)→openid`，契约 phase-stable，仅换 adapter（Phase 1 stub 确定性假 openid / Phase 2 真微信 SDK）。**解绑流 100% 镜像 004 delete-account 短信验证码范式**：复用 `deletion-code.rules/store`（仅加 `SmsPurpose.UNBIND_WECHAT`，AccountSmsCode 表不变）+ 单 tx + affected-count 恰一次闸 + 4 分支折叠字节级一致 401。

绑定关系存**新表 `WechatBinding`**（account schema，`openid` 全局唯一 = FR-S01 冲突闸，`unionid` nullable 现存）。bounded context：绑定数据→**account**、bind/unbind 编排→**auth**、短信 crypto 复用 auth/deletion-code。状态折叠进 `GET /me` 加 `wechatBound: boolean`（**无 openid**）。

**用户决策（2026-05-31）**：①新建 WechatBinding 表 ②Phase 1 单独 PR 先交付 ③unionid 现在就存（nullable，不用于唯一性）④web 生产端隐藏绑定按钮（真实绑定目标 = native；web e2e 仍走 stub）。

## API Contracts _(mandatory)_

新 controller `apps/server/src/auth/wechat-binding.controller.ts`（`@Controller('v1/accounts')` + `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()`），对齐 `account-deletion.controller.ts`：

| # | Method | Path | HttpCode | Throttle（account/IP） | Body | trace FR |
|---|---|---|---|---|---|---|
| EP1 bind | POST | `/api/v1/accounts/me/wechat-binding` | 201 | wx-bind 5/60s · ip 10/60s | `{authCode}` `@IsString @IsNotEmpty` | FR-S02, FR-C02 |
| EP2 解绑发码 | POST | `/api/v1/accounts/me/wechat-binding/unbind-codes` | 204 | wx-unbind-code 1/60s · ip 5/60s | 无（accountId 从 bearer 派生）| FR-S03, FR-S06 |
| EP3 解绑验码 | POST | `/api/v1/accounts/me/wechat-binding/unbind` | 204 | wx-unbind 5/60s · ip 10/60s | `{code}` `@Matches(/^\d{6}$/)` | FR-S04, FR-S06 |
| EP4 状态 | GET | `/api/v1/accounts/me`（扩展）| 200 | 既有 me-get | — | FR-S07, FR-C01 |

- **EP1 响应**：201 created/idempotent；**409** `WECHAT_ALREADY_BOUND_OTHER`（不泄露他账号，SC-008）；401 折叠；429。
- **EP3 响应**：204；**400** `FORM_VALIDATION`（缺/非 6 位，与凭据路径区分）；**401** 折叠 `INVALID_UNBIND_CODE`（4 分支字节级一致：未找/哈希/过期/已用）；429。字节镜像 `POST me/deletion`。
- **EP4 扩展**：`AccountProfileResponse` 加 `@ApiProperty wechatBound: boolean`（**MUST NOT 返 openid**，FR-S07）；`get-account-profile.usecase.ts` 加 R1 同 ctx 读 `wechat_binding` 存在性。
- **契约同步链（Constitution V，active）**：新端点 + 响应扩字段 → `node dist/main.js` 导 openapi（per memory `openapi_export_must_use_canonical_mainjs`，非 dump-openapi.mjs）→ `pnpm nx affected -t generate` regen `packages/api-client` → mobile typed hook。**server impl + api-client regen + mobile 消费同 PR**。
- 新 DTO：`bind-wechat.request.ts`、`unbind-wechat.request.ts`（copy `delete-account.request.ts` 的 code DTO）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（2026-05-30 记入 spec `## Clarifications`）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | server：Testcontainers IT 红绿（绑定创建/冲突/发码/验码删绑定/反枚举/限流/并发恰一次，cwd=apps/server `nx test server`）；mobile：Playwright Expo Web e2e（bind→行翻解绑、unbind 短信全链，Phase 1 stub）；form/error 纯逻辑 → vitest helper-level |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks 按此拆；server + api-client regen + mobile **同 PR**（Phase 1），多 commit |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅ | 绑定数据 = **account ctx**（`commit-wechat-*`/`inspect-wechat-binding` 直注 PrismaService 读写自表）；bind/unbind 编排 = **auth ctx**（持 tx 跨界经 Commit/Inspect use case，CROSS-CONTEXT-SYNC 注释，**auth 不碰 `prisma.wechatBinding.*`**）；贫血 row + `@map`，零-class 纯函数（per ADR-0043） |
| V. 类型同步链 Nx-driven | ✅（active） | 4 端点新增/扩展 → openapi 变 → api-client regen → mobile 消费，**同 PR** |

## Architecture Notes _(mandatory)_

### Spec-drift 纠正（实证，覆盖 spec/调研原文）

| # | spec/调研原叙述 | 实证真相 | 影响 |
|---|---|---|---|
| D1 | "复用 007 微信占位行、翻 active" | `account-security/index.tsx` 身份/绑定卡里已有 `<Row label={COPY.wechat} disabled />`（disabled 占位，非状态行） | 010 = 把该 disabled 行改成 state-driven 活行（非新建 section、非翻已有活行）；google 保持 disabled |
| D2 | "mobile 用 i18next `t()`" | 仓内**无 i18next**，golden-sample 屏用内联 `const COPY = {...}` | 用内联 COPY，不引 i18n |
| D3 | "Credential/RefreshToken 已有 WECHAT 字面量" | `grep wechat apps/server/src` 全空，纯 greenfield | 无遗留可借 |
| D4 | "PR 栈在 007 之上、007 先合" | 007 已在 main | 010 直接 base main，无栈 |
| D5 | "复用 Credential（identifier=openid）" | Credential 无 identifier 列、`@@unique([accountId,type])`、password-centric | 复用给不出 openid 全局唯一 → 新建表 |
| D6 | "account-security 单文件" | 实为目录（index/delete-account/_layout/...） | 解绑页 = 新增 `account-security/wechat-unbind.tsx` |
| D7 | 既有 007 e2e | `account-security-refactor.spec.ts` 断言微信行 disabled、不导航 | 010 须更新该断言 |

### Server

- **bind port**（新 `apps/server/src/auth/wechat-auth.port.ts`，镜像 `sms-gateway.port.ts` 零 class）：
  ```ts
  export const WECHAT_AUTH = Symbol('WECHAT_AUTH');
  export interface WechatAuthPort {
    resolveIdentity(authCode: string): Promise<{ openid: string; unionid?: string }>;
  }
  ```
  Stub `mock-wechat-auth.gateway.ts`（镜像 `mock-sms.gateway.ts`）：由 authCode 派生确定性 28 位 `oMOCKDEV...`（同 authCode→同 openid，供冲突 IT），`[STUB WECHAT]` log。Real `wechat-auth.gateway.ts`（P2）：AppID/AppSecret 调 `GET https://api.weixin.qq.com/sns/oauth2/access_token?appid=&secret=&code=&grant_type=authorization_code`，包 `RETRY_EXECUTOR`（同 AliyunSmsGateway）。注入：新 `config/wechat.config.ts` discriminated union（`kind:'mock'|'real'`，默认 mock；real boot 时 Zod 校验 AppID/AppSecret fail-fast），`auth.module.ts` env-gated `useFactory` 复制 `SMS_GATEWAY` factory 形状。**生产 boot 拒 `kind==='mock'`**。

- **存储 — 新表 WechatBinding**（`schema.prisma`，贫血 + `@map` + `@@schema("account")`）：
  ```prisma
  model WechatBinding {
    id        BigInt   @id @default(autoincrement())
    accountId BigInt   @map("account_id")
    provider  String   @default("WECHAT") @db.VarChar(16)
    openid    String   @unique(map: "uk_wechat_binding_openid") @db.VarChar(64)  // FR-S01 全局唯一冲突闸
    unionid   String?  @db.VarChar(64)                                           // 决策3 现在就存
    boundAt   DateTime @default(now()) @map("bound_at") @db.Timestamptz(6)
    createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
    @@unique([accountId, provider], map: "uk_wechat_binding_account_provider")   // 幂等/一账号一绑定
    @@index([accountId], map: "idx_wechat_binding_account_id")
    @@map("wechat_binding")
    @@schema("account")
  }
  ```
  无声明 FK relation（同 AccountSmsCode，不动 Account model）。migration `{YYYYMMDD}_{HHMM}_create_wechat_binding/`，expand-only CREATE TABLE，加 `migration_refs` frontmatter（ADR-0035）。**AccountSmsCode 表不改**（purpose VarChar(32) 容 UNBIND_WECHAT）。

- **bounded context + CROSS-CONTEXT-SYNC 委托链**（镜像 004 delete-account）：

  | Use case | Context | 说明 |
  |---|---|---|
  | `commit-wechat-bind` | account | 写 wechat_binding；CREATED/IDEMPOTENT/CONFLICT 判别 |
  | `inspect-wechat-binding` | account | 读 `{bound}`（发码门槛 + /me 状态） |
  | `commit-wechat-unbind` | account | 删 wechat_binding，affected-count `{won}` |
  | `bind-wechat` | auth（编排） | port resolve（tx 外）+ 委托 account 写 |
  | `send-unbind-wechat-code` | auth | 1:1 镜像 send-deletion-code |
  | `unbind-wechat` | auth（持 tx） | 1:1 镜像 delete-account |

  - `bind-wechat`：`resolveIdentity(authCode)` → `InspectAccountStatusByIdUseCase` 验 ACTIVE（非 ACTIVE 折叠 401）→ `// CROSS-CONTEXT-SYNC: auth → account create wechat binding (R2 写)` `commitWechatBind.execute`。`commit-wechat-bind`：try create；openid 撞 P2002 → 查 owner，同账号→IDEMPOTENT、他账号→CONFLICT（不泄露）。**MUST NOT 改 displayName/bio/gender**（不回填）。
  - `send-unbind-wechat-code`：`inspectAccountStatusById`（ACTIVE+phone）**和** `inspectWechatBinding`（bound 门槛）均加 CROSS-CONTEXT-SYNC 注释。非 ACTIVE **或** 未绑 → 字节级一致折叠 401（FR-S03 反枚举）。否则 `deletionCodeStore.issue(accountId, UNBIND_WECHAT, hash, +10min)` + `smsGateway.sendCode(phone, code, UNBIND_WECHAT)`。无绑定改动、无事件；SMS 失败 → `SmsSendFailedException`(503)。
  - `unbind-wechat`：码校验 tx 外（findActive+verifyDeletionCode，4 分支折叠 401）。`$transaction(ReadCommitted)`：`markUsed`→false⇒401 回滚（恰一次闸）；`commitWechatUnbind.execute(tx, accountId)`（`deleteMany WHERE accountId AND provider='WECHAT'`→`{won: count===1}`，同 commit-account-freeze）→won:false⇒401 回滚。**无 token revoke、无事件**（O6）。

### Mobile（Phase 1，web 可测）

- **`account-security/index.tsx`**：从 `useMe()`（`~/core/api/use-me`）读 `wechatBound`；把既有 disabled 微信 `<Row>` 改活行（`~/settings/primitives` 的 Row）：unbound→bind 流，bound→确认对话→`router.push('.../wechat-unbind')`。确认对话 = 内联 006 范式（`Platform.OS==='web'?window.confirm('确定要解除微信绑定?'):Alert.alert(...)`，copy 自 `settings/index.tsx`）。**web 生产端隐藏绑定按钮**（决策4；e2e 仍走 stub）。google 保持 disabled。更新 `account-security-refactor.spec.ts` 微信断言（D7）。
- **bind 流** `src/wechat/use-wechat-bind.ts`（镜像 `src/auth/delete-account.ts`）：stub `authorizeWechatStub()` 返确定性 authCode → Orval `useWechatBindingControllerBind({data:{authCode}})`；onSuccess invalidate `useMe` query→行翻解绑；409→toast「该微信已绑定其他账号」行不变；失败→toast 不脏写（仅服务端确认后翻行，FR-C06）。
- **解绑验证页** `account-security/wechat-unbind.tsx`（delete-account.tsx 近拷去双勾选块）：标题「账号解绑」+副文「您正在申请解除微信绑定，需验证以下身份」+ `~/ui/SmsInput`（RHF `<Controller>`）+ 发码 + 提交「确认解绑」。form hook `src/wechat/use-wechat-unbind-form.ts`（镜像 `use-delete-account-form.ts` 去双勾选 + 去 success-clearSession——解绑保留 session）；schema `src/wechat/wechat-unbind-form.schema.ts`（`{code: z.string().regex(SMS_CODE_REGEX)}` 复用 login schema regex）；错误映射 `src/wechat/wechat-errors.ts`（镜像 `deletion-errors.ts`）。onSuccess → invalidate `useMe` + `router.back()`（行翻绑定）。

## Project Structure _(mandatory)_

```text
apps/server/src/
  auth/
    wechat-auth.port.ts                    # 新 WECHAT_AUTH token + interface
    mock-wechat-auth.gateway.ts            # 新 Phase 1 stub
    wechat-auth.gateway.ts                 # 新 Phase 2 real（后续 PR）
    bind-wechat.usecase.ts                 # 新 auth 编排
    send-unbind-wechat-code.usecase.ts     # 新 镜像 send-deletion-code
    unbind-wechat.usecase.ts               # 新 镜像 delete-account（持 tx）
    wechat-binding.controller.ts           # 新 4 端点
    bind-wechat.request.ts                 # 新 DTO
    unbind-wechat.request.ts               # 新 DTO
    wechat-already-bound.exception.ts      # 新 409
    deletion-code.rules.ts                 # 编辑 加 SmsPurpose.UNBIND_WECHAT（唯一改动）
    throttler-skip-buckets.ts              # 编辑 加 WECHAT_*_BUCKETS
    auth.module.ts                         # 编辑 接线 provider/controller/throttler/config
  account/
    commit-wechat-bind.usecase.ts          # 新 account 写
    commit-wechat-unbind.usecase.ts        # 新 account 删
    inspect-wechat-binding.usecase.ts      # 新 account 读
    get-account-profile.usecase.ts         # 编辑 加 wechatBound 读
    account-profile.response.ts            # 编辑 加 wechatBound 字段
    account.module.ts                      # 编辑 providers + exports 三 use case
  config/
    wechat.config.ts                       # 新 discriminated union
    index.ts                               # 编辑 wire
  prisma/
    schema.prisma                          # 编辑 加 WechatBinding model
    migrations/{ts}_create_wechat_binding/ # 新 migration

apps/mobile/
  app/(app)/settings/account-security/
    index.tsx                              # 编辑 微信活行
    wechat-unbind.tsx                      # 新 解绑验证页
    _layout.tsx                            # 编辑 注册 wechat-unbind Stack.Screen
  src/wechat/                              # 新目录
    use-wechat-bind.ts
    use-wechat-unbind-form.ts
    wechat-unbind-form.schema.ts
    wechat-errors.ts
    index.ts
  e2e/
    wechat-binding.spec.ts                 # 新 Playwright stub 全链
    account-security-refactor.spec.ts      # 编辑 微信断言（D7）

docs/conventions/server-bounded-context-catalog.md  # 编辑 加 3 行 Operation Catalog
```

## Complexity Tracking _(mandatory)_

无超预算复杂度。bind port 复用 SMS_GATEWAY 范式（已验证模式）；解绑复用 004 全套（DeletionCodeStore 原样、rules 加 1 枚举值）；新增仅 1 表 + 6 use case + 1 controller + mobile 1 页/1 行改。无新 Guard/Filter/Repository/Entity Mapper（per ADR-0043 零-class）。

## Phasing _(optional)_

- **Phase 1（本 PR，web 全测、可独立交付）**：全部 server（stub adapter）+ mobile（after Orval regen）。匹配 spec `web_compat: stub`。
- **Phase 2（后续 PR，设备专属）**：real adapter（`wechat-auth.gateway.ts` + `wechatConfig.kind='real'` 生产 env）+ mobile native SDK（expo config plugin + custom dev client，不支持 Expo Go）。bind 契约不变，仅 adapter 替换。**阻塞性产品/运维前置（非代码）**：开放平台企业认证（¥300，~3 工作日）+ AppID/AppSecret（ADR-0037）+ 应用签名报备 + custom dev client pipeline。**SC-007 覆盖缺口**：native 唤起设备/手动验证，无 web e2e；production web 真实绑定（扫码/H5）out of scope。

## Testing Strategy _(mandatory)_

- **Server Testcontainers IT**（`nx test server`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`；dev DB `docker compose -f docker-compose.dev.yml up -d --wait` + migrate deploy）：
  - **Bind（SC-001/006）**：authed+stub openid→201 + 落库 + profile 不变；同 openid 他号→409 不泄露；自号→幂等；缺 token→401。
  - **发码（SC-002）**：bound+ACTIVE→204 + 恰 1 条 active UNBIND_WECHAT 哈希码（10min/usedAt 空）+ 绑定不变 + 无 outbox 行；未绑/非 ACTIVE→折叠 401；超限 429。经 `MockSmsGateway.getLastPurpose` 断言。
  - **验码（SC-003）**：有效码→单 tx markUsed+删；4 分支字节级一致 401；5 并发同码恰一次；畸形→400。
  - **反枚举（SC-008）**：发码/验码失败与鉴权失败字节级一致；冲突不泄露他账号。
- **Mobile e2e**（Playwright Expo Web，stub 全链，`wechat-binding.spec.ts`，复用 `_support/api-mock.ts` mockJson + addInitScript seed）：bind（seed `/me {false}`→绑定→stub authorize→mock 201→re-mock `/me {true}`→行翻解绑）；unbind（seed `{true}`→解绑→window.confirm→`/wechat-unbind`→发码 204→输码→提交 204+`/me {false}`→back 行翻绑定；取消→留原页）。`getByRole` 收窄（stacked screen）；web-stripped URL；401 测试 mock `REFRESH_URL` 200（避免 refresh 拦截器误登出，per memory `authed_business_401_triggers_refresh_interceptor`）。本地跑前杀 :3000 nx serve 父进程（per memory `nx_serve_respawns_3000_poisons_seed_e2e`）。
- **Mobile vitest**（logic-only，per memory `mono_mobile_test_layering`）：`use-wechat-unbind-form.spec.ts`（idle/sms_sent/submitting/success/error、isSubmitting 单源、60s countdown、error latch）+ `wechat-errors.spec.ts` + schema spec。presentational 行无单测。

## Risks & Mitigations _(optional)_

| 风险 | 缓解 |
|---|---|
| stub openid 格式与真 openid 不符致 P2 集成踩坑 | stub 用真 openid 同格式（28 位，`o` 开头）；契约 phase-stable，P2 仅换 adapter |
| 解绑误用 login-码 Redis 路径（非原子） | 明确走 DB `account_sms_code`（DeletionCodeStore），同 004 原子性 |
| throttler bucket 污染既有 controller | 新 bucket spread 进每个既有 controller 的 `@SkipThrottle`（同 004/005 chore，per plan §4） |
| refresh 拦截器在 e2e 误登出 | 401 测试 mock REFRESH_URL 200 |

## Open Questions _(optional)_

留 `/speckit-clarify`（如有分歧）或 implement 起手定，**不阻塞 Phase 1**：

- **O2**：port 切分 seam — client 发不透明 authCode、server 仅 `code→openid`（AppSecret 留服务端）。确认此 seam（vs client 解析 openid，已倾向拒）。
- **O6**：bind/unbind 是否发 outbox 审计事件 — 默认 Phase 1 不发（unbind=单表删，无跨 ctx 副作用）。需要可后加 `auth.wechat.bound/unbound`。
- ~~**O7**~~ **【已定 2026-05-31】**：bind 幂等 HTTP 码 — 创建与自号重绑幂等**同返 201**（单 HTTP 码，controller 不分支，不泄露"绑定是否预先存在"时序；逻辑上资源已存在）。
- ~~**R2**~~ **【已定 2026-05-31】**：对称冲突 — 已绑账号再绑**不同** openid → **拒**（独立 409 `WECHAT_ACCOUNT_ALREADY_BOUND`，不静默替换身份）。`@@unique([accountId,provider])` 已在 DB 层拒 → 不显式处理就是裸 P2002→500，故"拒"为必需正确性非可选。`commit-wechat-bind` 捕获**任意** P2002 后**查本账号现有 WECHAT 绑定**（与约束触发顺序无关）：existing 同 openid→IDEMPOTENT / existing 不同 openid→SELF_DIFFERENT(R2) / 无 existing→openid 被他号占 CONFLICT。happy-path mobile UI 不可达（bound→行显示解绑，不发 bind），纯服务端纵深防御。
- **R3**：状态端点 — 折叠进 `/me`（本 plan 选，FR-S07 允许）vs 独立 `GET /me/wechat-binding`。

## Acceptance (Definition of Done) _(optional)_

- Phase 1 全 SC（SC-001~006、SC-008）IT + e2e 绿；SC-007 覆盖缺口 spec/plan 明记。
- `pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` exit 0（PR 部署 gate）。
- api-client regen 同 PR；catalog 加 3 行 Operation。
- spec frontmatter `status` → implementing（impl 起）→ implemented（全完）。
