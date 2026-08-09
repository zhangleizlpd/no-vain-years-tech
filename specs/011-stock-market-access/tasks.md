---
feature_id: 011-stock-market-access
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-01'
---

# Tasks: 011-stock-market-access（证券市场准入设置页 — 多市场激活开关）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `011-stock-market-access`（设计在 `investment` 长期分支，impl 阶段开 feature 分支）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Contract / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Verify]`（per sdd.md）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 的单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（字典/rules）= vitest 无 DB；**每 US 的 Independent Test = 单列 `[Server-IT]` 全 boot task**；mobile 纯逻辑（乐观更新/min-1 预判/错误分流）= vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004/006/007/008/009/010 + orchestrator 暂不用）
- **portfolio = 第 4 bounded context**（与 security/account/auth 平级，ADR-0032 Q4 判定）：module 目录 + Prisma `portfolio` schema + ESLint 单向边界 + moat 登记**同批落地**（FR-S10）。**零跨 ctx 业务调用**（intra only，无 R2/R3 → 无 `// CROSS-CONTEXT-*` 注释）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（经 `AccountModule` export 复用的 account-bound 鉴权 artefact，非 use case 调用，无注释要求，per plan §Architecture Notes）
- **min-1 并发原语 = READ COMMITTED + `SELECT ... FOR UPDATE` 锁账号核心行集**（D1，⚠️ gate review）：这是本 feature **刻意的例外**——min-1 是跨行不变性（count across ≤3 行），单行条件写防不住「两端关不同市场致 0 激活」竞态；拒 SERIALIZABLE（规避 SSI 假冲突 retry + memory `prisma_serializable_p2002_and_p2034` 警示的 Prisma 7 P2034 检测漏洞）。配 materialize-on-first-write（GET 零写库投影，首 PUT 落 3 核心默认行）
- **两段式 PR（user 定，2026-06-01）**：**PR1 = Server**（T001–T012，ships 真后端 + **api-client regen committed**）→ **PR2 = Mobile**（T013–T017，消费 PR1 已 merge 的 typed client + 对真后端跑 Playwright 冒烟，per 类 2 流程纪律②）。**Constitution §V「同 PR」刻意例外**：§V 防的类型同步链 drift 已消解——regen 在 PR1 committed/merged，mobile 在 PR2 消费已落地 typed client（沿 005 先例）；**PR1 描述须 cite 此 §V 例外**

## Path Conventions

- server：`apps/server/src/portfolio/`（**新 module**，ADR-0043 扁平文件平铺，无 domain/application/infra 层）；schema `apps/server/prisma/schema.prisma`；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_add_portfolio_market_preference/`（expand-only + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js` 非 dump-openapi.mjs，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile app-local：`apps/mobile/src/portfolio/`（**新 feature 目录**，落点按 [fe-directory-structure](../../docs/conventions/fe-directory-structure.md)）；复用 `~/core/api`、`~/theme`、`~/settings/primitives`（Card/Row）
- mobile 入口：`apps/mobile/app/(app)/settings/`（**壳已存在**：`index.tsx` 含账号/隐私/登出多 Card + `_layout.tsx` Stack + `account-security/` 子树）——本页是该 stack **新增 screen**（非首次创建，per plan D5 修正）；`~/ui` 新 `Switch.tsx`（barrel 导出）
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + `_support/api-mock.ts` mockJson；**必 mock refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；`getByRole` 收窄 stacked screen per memory `playwright_expo_stacked_screen_locator_collision`；web-stripped route group URL；**本地跑前杀 :3000 nx serve 父进程** per memory `nx_serve_respawns_3000_poisons_seed_e2e`）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）

---

## Phase 1: Foundational（阻塞全部 UC — portfolio bootstrap：schema + boundaries + 字典/rules）

- [X] T001 [Server] `schema.prisma`：`datasource db.schemas` 加 `"portfolio"`（→ `["account", "portfolio", "public"]`）+ 新 `model MarketPreference`（贫血 row + `@map` snake_case，**无 Entity Mapper** per memory `raw_prisma_row_with_map_no_entity_mapper`：`id BigInt @id @default(autoincrement())` / `accountId @map("account_id")` 逻辑引用 JWT sub **无跨 schema FK**（同 refresh_token）/ `market @db.VarChar(8)` 核心码 CNY/HKD/USD（海外不入库）/ `active Boolean` not-null / `createdAt`/`updatedAt` Timestamptz(6) / `@@unique([accountId, market], map:"uk_market_preference_account_market")` / `@@map("market_preference")` / `@@schema("portfolio")`）+ migration `{YYYYMMDD}_{HHMM}_add_portfolio_market_preference/`（**expand-only** CREATE SCHEMA + CREATE TABLE + unique index，非破坏 → 单 PR 合规，ADR-0035 + `migration_refs` frontmatter）+ `prisma generate` + dev DB `docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy` 验证落表
- [X] T002 [P] [Server] **boundaries + moat 登记**（FR-S10 / SC-S06）：①`apps/server/eslint.config.mjs` `boundaries/elements` 加 `{ type: 'portfolio', pattern: 'src/portfolio/**' }` + `boundaries/dependencies` 加 portfolio → `{security, account}` allow（**禁 auth**，portfolio 不依赖编排层）+ `security`/`account`/`auth` 各 disallow `portfolio`（保 portfolio 为叶子）②`scripts/checks/check-server-moat.ts`：`MODEL_OWNERSHIP`（L53）加 `marketPreference: 'portfolio'`（**否则 portfolio UC 读自己的表即 `moat-unmapped` 硬拒**）+ `BUSINESS_CTX`（L99）加 `'portfolio'`（新 ctx 同步登记约定；011 无跨 ctx 注入故 Check 2 对 portfolio 暂无违规，但后续 PRD 02 需此登记）+ verify `nx lint server` 0 violation & `pnpm tsx scripts/checks/check-server-moat.ts` 关
- [X] T003 [P] [Server] **字典 + rules**（纯函数，无 DB → vitest）：`apps/server/src/portfolio/market-catalog.ts`（静态 `MARKET_CATALOG` 9 市场 `{ marketCode, displayName, isoCurrency(ISO 4217), group:'core'|'overseas', v1Available, order }` = FR-S06 真相源 + `CORE_MARKETS`/`OVERSEAS_MARKETS` 派生 + `isCoreMarket(code)`/`isKnownMarket(code)` 谓词）+ `portfolio.rules.ts`（ADR-0043 §4 纯函数不变量：`projectMarkets(rows)` merge 静态字典 9 行 / `countActiveCore(rows)` / `wouldViolateMinOne(rows, market, active)`）+ 单测（9 市场常量完整性 / 核心 3 vs 海外 6 分组 / 顺序固定 / 海外恒 v1Available=false / projectMarkets 0 行→默认 {CNY:active,HKD/USD:inactive} / wouldViolateMinOne 单激活关→true、多激活关→false）

---

## Phase 2: User Story 1 — [Server] 读取市场偏好（含新用户默认）(P1) 🎯 MVP

**Independent Test**: Testcontainers PG；①新账号无偏好记录 authed GET → 核心 3 市场 {CNY:active, HKD:inactive, USD:inactive} + **GET 零写库副作用**；②预置 {CNY:active, HKD:active, USD:inactive} → GET 返同态；③响应含海外 6 市场元信息（group/isoCurrency/v1Available=false，恒 inactive）；④未认证/非 ACTIVE → 401 反枚举。

- [X] T004 [US1] [Server] `apps/server/src/portfolio/get-market-preferences.usecase.ts`（intra query，`PrismaService` 直注无 repository，ADR-0043）：`prisma.marketPreference.findMany({ where:{accountId} })` → 调 `portfolio.rules.ts` `projectMarkets(rows)` merge `MARKET_CATALOG` 9 行（0 行→投影默认，≥1 行→读核心态 merge）→ `MarketPreferencesResponse`；**GET MUST NOT 写库**（FR-S01/D4）+ `market-preferences.response.ts`（`MarketPreferencesResponse{ markets: MarketItem[] }` + `MarketItem{ marketCode, displayName, isoCurrency, group, v1Available, active }`，swagger `@ApiProperty`）+ 单测（Testcontainers PG：新账号→投影默认 9 行逐字段 / 预置 {HKD 也激活}→返持久化态 / 海外 6 行 v1Available=false 恒 inactive / **GET 后 DB 仍 0 行**断言零写库）。run via `nx test server <file>`

---

## Phase 3: User Story 2 — [Server] 切换核心市场激活态（即时持久化 + min-1 + 海外拒绝）(P1)

**Independent Test**: Testcontainers PG；预置 {CNY:active 唯一激活}；①PUT {HKD,active:true}→200 持久化，GET 返 {CNY+HKD active}；②续 PUT {CNY,active:false}→200（HKD 仍激活满足 min-1）；③回到仅 {CNY:active}，PUT {CNY,active:false}（关最后一个）→ **422 MIN_ONE_MARKET_REQUIRED** 态不变；④PUT {JPY,active:true}（海外）→ **422 MARKET_NOT_AVAILABLE** 不持久化；⑤未知码→404 MARKET_NOT_FOUND；⑥幂等。

- [X] T005 [US2] [Server] `apps/server/src/portfolio/update-market-preference.usecase.ts`（intra 写，**持 tx**）：①字典校验（tx 外）：`!isKnownMarket(code)`→404 `MARKET_NOT_FOUND`；`!isCoreMarket(code)`（海外）→422 `MARKET_NOT_AVAILABLE`（FR-S05）②`$transaction`(READ COMMITTED)：`SELECT ... WHERE accountId AND market IN (CNY,HKD,USD) FOR UPDATE`（**D1 串行化同账号并发 toggle**）→ 无行则 INSERT 3 核心默认行（materialize-on-first-write）→ `wouldViolateMinOne` 归 0 → 422 `MIN_ONE_MARKET_REQUIRED`（FR-S04）→ 否则 `update` 目标行 active → 返回**全量** 9 市场态（复用 `projectMarkets`，D7）+ 3 exception `min-one-market-required.exception.ts`(422) / `market-not-available.exception.ts`(422) / `market-not-found.exception.ts`(404)（镜像 `auth-attempt-locked.exception.ts`：HttpException 子类 + RFC 9457 ProblemDetail extension，ADR-0038）+ `update-market-preference.request.ts`（`{ active: boolean }` class-validator `@IsBoolean()`，缺/类型错→400 `FORM_VALIDATION`）+ 单测（Testcontainers PG：toggle on→落库 / 多激活关 1→成功 / 单激活关→422 MIN_ONE 态不变 / 海外→422 NOT_AVAILABLE 不写库 / 未知码→404 / 幂等（已是目标态→200 无变更）/ materialize 首写落 3 行）。run via `nx test server <file>`

---

## Phase 4: [Server] controller + module 接线 + throttler（serves US1+US2）

- [X] T006 [Server] `apps/server/src/portfolio/market-preferences.controller.ts`（`@Controller('v1/portfolio/market-preferences')` + `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()`，对齐 `account-profile.controller.ts`）：`@Get()`（EP1，accountId from JWT sub）+ `@Put(':market')` `@HttpCode(200)`（EP2）+ Swagger（EP1 200/401/429；EP2 200/400/401/422/404/429）+ named throttler `mkt-pref-get-account` 60/60s · `mkt-pref-put-account` 30/60s（D3 ⚠️ gate review）+ `@SkipThrottle` 其余全部桶；接线：①`portfolio.module.ts`（`imports:[SecurityModule, AccountModule]`，`controllers:[MarketPreferencesController]`，`providers:[GetMarketPreferencesUseCase, UpdateMarketPreferenceUseCase]`）②`app/app.module.ts` `imports` 加 `PortfolioModule`（新 top-level，需显式注册）③`security/throttler-skip-buckets.ts` 加 `MARKET_PREF_BUCKETS{mkt-pref-get-account, mkt-pref-put-account}` + aggregate `MARKET_PREF_ALL`④`auth/auth.module.ts` `ThrottlerModule.forRootAsync` `throttlers[]` 注册 2 个新 named throttler（getTracker per-account，复制既有形状）⑤**7 个既有 controller**（account-profile / device-management / account-deletion / cancel-deletion / account-sms-code / account-token / wechat-binding）`@SkipThrottle` spread `...MARKET_PREF_ALL`（反污染纪律，同 004/010 桶扩张 chore）+ 单测（mock usecase 映射：GET→200 全量态 / PUT→200 / 422 / 404；DTO 校验 400）+ verify typecheck 绿

---

## Phase 5: [Server-IT] 全 boot 集成测试（Testcontainers PG+Redis）

- [X] T007 [US1] [Server-IT] `apps/server/test/integration/market-preferences.us1-get.it.spec.ts`（全 boot）：ACTIVE 账号 login 取 token → GET → 200 + 核心 {CNY:active, HKD/USD:inactive} + 海外 6 行元信息（group=overseas / isoCurrency / v1Available=false / active=false）+ **DB market_preference 仍 0 行**（GET 零写库）；预置 {CNY+HKD active} → GET 返持久化态；缺 token / 非 ACTIVE 账号 → 401 ProblemDetail（与 `/me` 字节级一致路径，剥 traceId，反枚举）
- [X] T008 [US2] [Server-IT] `apps/server/test/integration/market-preferences.us2-put.it.spec.ts`（全 boot）：预置 {CNY:active 唯一}；PUT {HKD,true}→200 + GET 返 {CNY+HKD active} + DB 落 3 行（materialize）；续 PUT {CNY,false}→200（HKD 仍激活）；回到仅 {CNY:active} PUT {CNY,false}→**422 `MIN_ONE_MARKET_REQUIRED`** + GET 仍 {CNY:active}（态不变）；PUT {JPY,true}→**422 `MARKET_NOT_AVAILABLE`** + DB 无海外行；PUT 未知码 `XXX`→404 `MARKET_NOT_FOUND`；PUT {HKD,true} 当 HKD 已 active→200 幂等无重复行；PUT body 缺 active→400 `FORM_VALIDATION`；缺 token→401
- [X] T009 [US2] [Server-IT] `apps/server/test/integration/market-preferences.us2-concurrency-ratelimit.it.spec.ts`（全 boot + `beforeEach` Redis flushall）：**并发（SC-M03 server 锚）**——预置 {CNY+HKD+USD 全激活}，N 端并发 PUT 关不同核心市场（service 层直测绕限流）→ `FOR UPDATE` 串行化 → 断言**恰保留 ≥1 激活**（无 0 激活中间态，证 D1 跨行不变性）；**限流（SC-S05）**——`mkt-pref-get-account` 第 61 / `mkt-pref-put-account` 第 31 次 60s 内 → 429 + `Retry-After`，限流命中时未触 DB 写

---

## Phase 6: [Contract] 同步链（Constitution V，Nx-driven）

- [X] T010 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（canonical `node dist/main.js`，含 EP1 `GET portfolio/market-preferences` + EP2 `PUT portfolio/market-preferences/{market}` + `MarketPreferencesResponse`/`MarketItem` schema + 3 新 error code）→ `nx affected -t generate`（Orval regen api-client portfolio 端点 typed hook：`usePortfolioControllerGetMarketPreferences` query + `usePortfolioControllerUpdateMarketPreference` mutation，**函数式非 class** ✓）+ api-client/mobile typecheck 绿（mobile 暂不消费，同 005/010 先 regen 供 PR2）

---

## Phase 7: PR1 收尾（catalog + server 全门）

- [X] T011 [Server] catalog 2 Operation 行：`docs/conventions/server-bounded-context-catalog.md` § Operation Catalog 加 `get-market-preferences` / `update-market-preference`（context=**portfolio**，propagation=**intra**（无 R2/R3），source PR）；**新 bounded context `portfolio` 首次登记**（catalog ctx 清单加 portfolio）；spec.md `modules: [portfolio]` 与 catalog 一致（已对齐，无需改）
- [X] T012 [Verify] **PR1 server 全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`，per memory `nx_cache_false_green_on_new_files` 新文件首跑 `--skip-nx-cache`）：lint+typecheck 0 / test（portfolio 字典+rules 单测 + get/update UC Testcontainers 单测 + US1/US2/并发/限流 IT + api-client）/ build / runtime-smoke（真 boot 探 EP1-2 契约 + RFC 9457 ProblemDetail）+ `boundaries` 0 violation + `check-server-moat.ts` **0 违规**（portfolio MODEL_OWNERSHIP 已登记，intra 无跨 ctx 注释需求）。ships 真后端供 PR2 冒烟

---

## Phase 8: User Story 3–6 — [Mobile] 证券市场设置页（PR2，对 PR1 真后端冒烟）

**Independent Test**：见各 US 验收 + T017 Playwright 真后端冒烟（per 类 2 流程纪律②）。

- [X] T013 [Mobile] `apps/mobile/src/ui/Switch.tsx`（基于 RN 原生 `Switch` 包装，ON 色=`brand-500`（mockup 定稿蓝，commit `3ece552`）：`trackColor`/`thumbColor` 用 `~/theme` tokens，**0 新增 token / 0 hex 字面量**，SC-M06）+ `disabled` 态置灰 + a11y `accessibilityRole='switch'` + `accessibilityState.checked/disabled` 透传 + `~/ui/index.ts` barrel 加 `Switch` 导出 + typecheck/lint 绿（presentational **无单测**，per mono 测试分层）
- [X] T014 [P] [US4] [US5] [Mobile] `apps/mobile/src/portfolio/use-market-preferences.ts`（包 orval `usePortfolioControllerGetMarketPreferences` query + `usePortfolioControllerUpdateMarketPreference` mutation）：乐观更新 + 响应对账（EP2 返全量态，D7）+ 失败回弹（FR-M07）+ **min-1 客户端预判**（持当前激活集，关最后一个激活核心市场→直接拦截弹回 + 轻提示「至少保留一个激活市场」，**不发 PUT**，D6 informed-default；server FR-S04 最终真相）+ 错误分流（422 min-1 / 通用网络错，复用 `~/core/api` errors guard 体例）+ `src/portfolio/market-copy.ts`（中文文案：「证券市场」/「核心」/「海外」/「即将支持」/「至少保留一个激活市场」/ errorToast）+ `src/portfolio/index.ts` barrel + vitest logic 单测（min-1 预判拦截**不发 PUT** / 失败回弹原态 / 422 vs 网络错分流 / 乐观更新对账）。Metro 相对 import **extensionless**（per memory `metro_web_cannot_resolve_js_extension_imports`）
- [X] T015 [US3] [US6] [Mobile] 屏 + 行 + route + settings 入口：`src/portfolio/market-row.tsx`（label `市场名（ISO）` + 右 `Switch`；海外行 `disabled` 置灰 + 「即将支持」副文案 + 点击零副作用，FR-M04/US6；a11y per FR-M09）+ `src/portfolio/stock-market-screen.tsx`（分组标题 核心/海外 + 9 行固定顺序 + loading/retry 态 + min-1 轻提示）+ `app/(app)/settings/stock-market.tsx`（薄 route，import `StockMarketScreen` from `~/portfolio`）+ `app/(app)/settings/_layout.tsx` 注册 `<Stack.Screen name="stock-market" options={{ title:'证券市场', headerLeft: makeHeaderBackOrParent('/(app)/settings') }}/>`（沿用既有 header 体例）+ `app/(app)/settings/index.tsx` 新增**独立投资设置 `<Card>`**（与账号/隐私/登出各 Card 平级，D5）：`<Row label="证券市场" onPress={→ /(app)/settings/stock-market} />` + `<Row label="券商账户" disabled />`（PRD 02 占位，镜像现有 disabled 行）+ 入口文案进 `~/settings` copy 或 `market-copy.ts` + typecheck/lint 绿（视觉 0 硬编码 grep，SC-M06）
- [X] T016 [US3] [US4] [US5] [US6] [Mobile-E2E] `apps/mobile/e2e/stock-market-access.spec.ts`（Playwright Expo Web，**真后端冒烟** against PR1 已 ship server，per 纪律②；seed-authed addInitScript + **mock REFRESH_URL 200**；`getByRole` 收窄；web-stripped route group URL；本地跑前杀 :3000 nx serve 父进程）：登录 → 进设置断言**投资设置 Card**（证券市场 Row + 券商账户 disabled）→ tap 证券市场进入页 → 断言 **9 行 / 2 组 / 固定顺序 / ISO label / 默认 toggle 态**（A 股 ON、港股/美股 OFF、海外 6 disabled+「即将支持」，US3）→ 切港股 ON → 重进确认**持久化**（US4，真后端对账）→ 关最后一个激活核心市场 → **弹回 + 轻提示**（US5，断言无 0 激活中间态）→ 海外行点击**零副作用**（无 PUT / 无 navigation，US6）→ 截图归档 `runtime-debug/2026-06-XX-stock-market-access/`

---

## Phase 9: PR2 收尾 & 全门

- [X] T017 [Verify] **PR2 mobile 全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`）：lint+typecheck（4 projects 0）/ test（`use-market-preferences` vitest logic 单测 + 既有不回归）/ build / runtime-smoke（`expo export -p web` + playwright e2e 含 T016）+ 视觉 0 硬编码 grep（实现文件无 theme token 外 hex/rgb，SC-M06）+ **frontmatter flip**：spec.md `status: draft→implemented` + plan.md `status: planned→done`

---

## Dependencies（完成顺序）

```text
[PR1 Server]
Foundational(T001-T003) → US1 get UC(T004) → US2 update UC(T005) → controller+module(T006) → IT(T007-T009) → Contract(T010) → 收尾(T011-T012)
                                                                                                                              ┊ ships 真后端
[PR2 Mobile]（依赖 T010 typed api-client + T012 真后端 ship）
Switch(T013) → hook(T014) → 屏+行+route+入口(T015) → e2e(T016) → 收尾(T017)
```

- **Foundational 阻塞全部 UC**：T001（schema/migration）→ T004/T005（UC 读写 `market_preference`）；T002（boundaries+moat）→ T012 verify（moat 登记齐才不红）；T003（字典+rules）→ T004（projectMarkets）/ T005（isCoreMarket/wouldViolateMinOne）。
- **US1**：T004 依赖 T001+T003。
- **US2**：T005 依赖 T001+T003（+ 3 exception/DTO 同 task）。
- **controller**：T006 依赖 T004+T005（注入两 UC）+ T002（module 边界）；throttler 桶接线 + 7 既有 controller spread skip 同 task。
- **IT**：T007 依赖 T006（GET 端点）；T008/T009 依赖 T006（PUT 端点 + 限流桶在 T006 注册）。
- **Contract**：T010 依赖 EP1+EP2 全落（T006）。
- **PR1 收尾**：T011 catalog 依赖 2 UC 落地；T012 verify 依赖 T001-T011 全绿。
- **Mobile（PR2）** 全部依赖 T010（typed api-client）+ T012（真后端 ship 供 T016 冒烟）。T015 依赖 T013（Switch）+ T014（hook）；T016 e2e 依赖 T015（屏+入口落地）；T017 verify 依赖 T013-T016。

## Parallel Opportunities

- Foundational：T002（boundaries+moat）∥ T003（字典+rules）（不同文件，均不依赖 T001 的 schema 物理落表——eslint/moat 是静态登记，字典/rules 是纯常量）。T001 schema 先落则 T004/T005 才能跑 Testcontainers 单测。
- Mobile：T014（hook）可与 T013（Switch）并行起手（不同文件；T015 屏组件依赖二者就绪）。

## Implementation Strategy

1. **portfolio bootstrap（Foundational）**：先立第 4 bounded context 三件套——schema/migration（T001）+ ESLint 单向边界 + moat 登记（T002）+ 静态字典/纯函数 rules（T003）。**moat 登记是硬前置**：不登记 `marketPreference:'portfolio'` 则 UC 读自己的表即 `moat-unmapped` 红。
2. **MVP = US1 GET**（T004）：读侧投影 + 新用户默认 + 海外元信息 + **零写库**，设置页渲染与下游准入都依赖它。
3. **US2 PUT**（T005）：核心写动作 + 两条 server 不变性——min-1（**FOR UPDATE 串行化**跨行 count，D1）+ 海外拒绝（422）+ materialize-on-first-write。
4. **接线 + IT**（T006-T009）：单 controller 服务 GET+PUT + throttler 反污染 chore；每 US 的 Independent Test 落 [Server-IT] 全 boot（含并发 SC-M03 server 锚 + 限流）。
5. **契约同步**（T010）：openapi（canonical node dist/main.js）+ Orval regen typed hook 供 mobile。
6. **PR1 ship**（T011-T012）：catalog 2 行 + server 全门 → ships 真后端。
7. **mobile 闭环（PR2）**：Switch 原语（T013）→ hook（min-1 预判 + 乐观更新 + 错误分流，T014）→ 屏+行+route+settings 入口 Card（T015）→ Playwright 真后端冒烟（US3-6，T016）。
8. **PR2 收尾**（T017）：全门 + 视觉 0 硬编码 + frontmatter flip。
9. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环）；**min-1 用 FOR UPDATE 是本 feature 刻意例外**（跨行不变性，拒 Serializable）。

> **plan→tasks gate review 项**：**PR 策略**=两段式（user 定 2026-06-01，§V 例外见 Format）✅。余项已随 tasks 批准锁定：**D1** min-1 并发原语（READ COMMITTED + FOR UPDATE 锁核心行集）/ **D2** min-1·海外拒绝用 **422**（区别 400 格式错）、未知码 404 / **D3** 限流阈值 get `60/60s`·put `30/60s`。
