---
feature_id: 012-broker-account-binding
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-02'
---

# Tasks: 012-broker-account-binding（券商账户绑定 — 持仓归属字典池）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `012-broker-account-binding`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Contract / Polish 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Verify]`（per sdd.md）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 的单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（字典/rules）= vitest 无 DB；**每 US 的 Independent Test = 单列 `[Server-IT]` 全 boot task**；mobile 纯逻辑（乐观删除回滚/错误分流/脱敏）= vitest helper-level，UI·render·手势·a11y = Playwright Expo Web e2e（per mono 测试分层 logic=vitest·UI=Playwright）
- 无 task-meta JSON（**manual 模式**，per 004/006-011 + orchestrator 暂不用）
- **portfolio = 复用 011 已立第 4 bounded context**（与 security/account/auth 平级，ADR-0032 Q4 已判定）：module 目录 + Prisma `portfolio` schema + ESLint 单向边界 + `BUSINESS_CTX` 含 portfolio **均已就位**，本 feature **仅新增 `broker_account` 多行表 + moat 一行登记**。**零跨 ctx 业务调用**（intra only，无 R2/R3 → 无 `// CROSS-CONTEXT-*` 注释）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（经 `AccountModule` export 复用的 account-bound 鉴权 artefact，非 use case 调用，无注释要求，per plan §Architecture Notes）
- **dup 并发原语 = 唯一索引 + catch P2002 → 409**（D1，⚠️ gate review）：broker_account 行相互独立（≠ 011 min-1 跨行不变性），**无 FOR UPDATE / 无 SERIALIZABLE / 无预查重**——唯一索引 `(accountId,brokerCode,clientNo)` 天然串行化并发同键插入，败者抛 `PrismaClientKnownRequestError code='P2002'`。**IT 必含并发同键 POST 验 adapter-pg 下 P2002 真生效**（per memory `prisma_serializable_p2002_and_p2034` 警示 Prisma 7+adapter-pg 改错误形态——011 是 SERIALIZABLE 下 P2034 变 DriverAdapterError，本特性是普通 insert 唯一冲突标准 P2002，不靠假设）
- **删除 id 碰撞消歧 = 先 scoped-delete 后判定**（D3）：默认账户读侧虚拟派生（OQ3），其暴露 id = caller account id，与 broker_account 自增 id 共享 BigInt 空间可能数值碰撞 → `deleteMany({where:{id, accountId}})` count 分流（`1`→204 / `0 && id===accountId`→400 默认不可删 / `0 && id!==accountId`→404 反枚举），**不可**先判 `id===accountId`（会把恰好 id==accountId 的真实 broker 行误判默认）
- **两段式 PR（Constitution §V v1.2.0 跨端默认 + 005/011 先例）**：**PR1 = Server**（T001–T013，ships 真后端 + **api-client regen committed**）→ **PR2 = Mobile**（T014–T021，消费 PR1 已 merge 的 typed client + 对真后端跑 Playwright 冒烟，per 类 2 流程纪律②）。**§V「同 PR」刻意例外**：regen 在 PR1 committed/merged，mobile 在 PR2 消费已落地 typed client → 类型同步链 drift 已消解；**PR1 描述须 cite 此 §V 例外**

## Path Conventions

- server：`apps/server/src/portfolio/`（**复用 011 module**，ADR-0043 扁平文件平铺；broker 文件与既有 market-preferences 平级）；schema `apps/server/prisma/schema.prisma`；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_add_portfolio_broker_account/`（expand-only + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js` 非 dump-openapi.mjs，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile app-local：`apps/mobile/src/portfolio/`（**复用 011 feature 目录**，broker 子模块文件落点按 [fe-directory-structure](../../docs/conventions/fe-directory-structure.md)）；复用 `~/core/api`、`~/theme`、`~/settings/primitives`（Card/Row）、`~/format`（mask helper 同 `phone.ts`）
- mobile 入口：`apps/mobile/app/(app)/settings/`（**壳 + 投资设置 Card 已存在**：011 已加「投资设置」Card 含 `证券市场` Row（live）+ `券商账户` Row（**disabled 占位**，011 plan D5）——本 feature 把 `券商账户` Row **翻 live**，非新建 Card，per plan D9）；`~/ui` 新 5 原语（`SwipeRow`/`ConfirmModal`/`SearchBar`/`AlphaIndex`/`BrokerPickerSheet`，barrel 导出）
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + `_support/api-mock.ts` mockJson；**必 mock refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；`getByRole` 收窄 stacked screen per memory `playwright_expo_stacked_screen_locator_collision`；web-stripped route group URL；**本地跑前杀 :3000 nx serve 父进程** per memory `nx_serve_respawns_3000_poisons_seed_e2e`）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）

---

## Phase 1: Foundational（阻塞全部 UC — broker 表 + moat 登记 + 字典/rules）

- [X] T001 [Server] `schema.prisma`：新 `model BrokerAccount`（贫血 row + `@map` snake_case，**无 Entity Mapper** per memory `raw_prisma_row_with_map_no_entity_mapper`：`id BigInt @id @default(autoincrement())` / `accountId @map("account_id")` 逻辑引用 JWT sub **无跨 schema FK**（同 portfolio_preference）/ `brokerCode @map("broker_code") @db.VarChar(32)` ∈ BROKER_CATALOG / `clientNo @map("client_no")` 明文不限长 / `createdAt @map("created_at") @db.Timestamptz(6)`，**无 updatedAt**（只增删不可编辑）/ `@@unique([accountId, brokerCode, clientNo], map:"uk_broker_account_acct_broker_client")` dup 兜底+并发串行点 / `@@index([accountId], map:"ix_broker_account_account")` 服务 list 查询 / `@@map("broker_account")` / `@@schema("portfolio")`）+ migration `{YYYYMMDD}_{HHMM}_add_portfolio_broker_account/`（**expand-only** CREATE TABLE + unique + index，**datasource schemas 已含 portfolio 无需改**，非破坏 → 单 PR 合规，ADR-0035 + `migration_refs` frontmatter）+ `prisma generate` + dev DB `docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy` 验证落表
- [X] T002 [P] [Server] **moat 登记**（SC-S07）：`scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP` 加 `brokerAccount: 'portfolio'`（**否则 portfolio UC 读自己的表即 `moat-unmapped` 硬拒**）。`BUSINESS_CTX` **已含 `portfolio`（011 立）无需改**；eslint `boundaries` portfolio element + 单向规则 **已配（011）无需改** → verify `nx lint server` 0 violation & `pnpm tsx scripts/checks/check-server-moat.ts` 关
- [X] T003 [P] [Server] **字典 + rules**（纯函数，无 DB → vitest）：`apps/server/src/portfolio/broker-catalog.ts`（**server 校验副本**——静态 `BROKER_CATALOG` 12 券商 `{ brokerCode, brokerName }`：东方财富/广发/国泰君安/国信/海通/华泰/平安/申万宏源/银河/招商/中信/中金（mockup 定）+ `isKnownBroker(code)` 谓词 + `brokerName(code)` 查名；**仅 code+name**，pinyin/logo 是 client-only D5）+ `portfolio.rules.ts`（**修改既有** 011 文件加纯函数，ADR-0043 §4）：`normalizeClientNo(raw)`（先对 **raw** 查禁字符 deny-list `[\x00-\x1F\x7F\u200B-\u200F\uFEFF\u2028\u2029]`（控制+零宽+行分隔符，**portfolio 自带常量不跨 ctx import account.rules**，镜像 002 displayName，写法 `new RegExp(...)` 转义 per memory `author_invisible_chars_via_fromcharcode`）命中→抛校验错；再 trim→空→抛；返 trimmed 明文；**不强制格式不限长** D6）+ `buildBrokerAccountList(rows, accountId)`（合成默认账户置顶虚拟条目 `{id:accountId, brokerCode:null, brokerName:'默认账户', clientNo:null, isDefault:true, createdAt:null}` + merge brokerName）+ 单测（12 券商常量完整性 / isKnownBroker 命中+未命中 / normalizeClientNo：禁字符拒、trim 空拒、正常 trim、不限长通过 / buildBrokerAccountList：空行仅默认置顶、有行默认置顶+brokerName merge+createdAt 序）

---

## Phase 2: User Story 1 — [Server] 列出券商账户（默认置顶 + 跨账号隔离）(P1) 🎯 MVP

**Independent Test**: Testcontainers PG；①新账号 authed GET → 仅默认账户一条（isDefault=true，id=account id，brokerCode/clientNo=null）；②预置本账号 2 已绑 + 他人 1 → GET → 默认置顶 + 本账号 2 条（按 createdAt，他人不可见），每条含 **raw clientNo**（D8 server 返明文）；③未认证/非 ACTIVE → 401 反枚举。

- [X] T004 [US1] [Server] `apps/server/src/portfolio/list-broker-accounts.usecase.ts`（intra query，`PrismaService` 直注无 repository，ADR-0043）：`prisma.brokerAccount.findMany({ where:{accountId}, orderBy:{createdAt:'asc'} })` → 调 `buildBrokerAccountList(rows, accountId)` 合成默认置顶 + merge brokerName → `BrokerAccountListResponse`（FR-S01）+ `broker-account-list.response.ts`（`BrokerAccountListResponse{ accounts: BrokerAccountItem[] }`）+ `broker-account-item.response.ts`（`BrokerAccountItem{ id, brokerCode(nullable), brokerName, clientNo(nullable, **raw**), isDefault, createdAt(nullable) }`，swagger `@ApiProperty`）+ 单测（Testcontainers PG：新账号→仅默认置顶 / 预置 2 已绑 + 他人 1 行→默认置顶 + 本账号 2 按 createdAt、他人不可见 / clientNo 返 raw 明文）。run via `nx test server <file>`

---

## Phase 3: User Story 2 — [Server] 绑定券商账户（字典+禁字符校验 + 唯一性 dup→409）(P1)

**Independent Test**: Testcontainers PG；①POST {brokerCode∈字典, clientNo="3119...2466"}→201 持久化，GET 含新条；②重复 POST 同 {brokerCode, clientNo}→**409 BROKER_ACCOUNT_DUPLICATE** 不重复落库；③POST {brokerCode 不在字典}→400；④POST {clientNo trim 后空}→400；⑤POST {clientNo 含控制字符}→400；⑥同券商不同客户号→均 201。

- [X] T005 [US2] [Server] `apps/server/src/portfolio/bind-broker-account.usecase.ts`（intra 写）：①`!isKnownBroker(brokerCode)`→400 `FORM_VALIDATION`（未知券商）②`normalizeClientNo(raw)`（禁字符/空→400 `FORM_VALIDATION`）③`prisma.brokerAccount.create({data:{accountId, brokerCode, clientNo}})`；**catch P2002**（唯一约束）→ 409 `BROKER_ACCOUNT_DUPLICATE`（**无 FOR UPDATE/无预查重** D1）→ 201 返新行（`BrokerAccountItem`）+ `broker-account-duplicate.exception.ts`(409，镜像 011 `market-not-available.exception.ts` HttpException 子类 + RFC 9457 extension，ADR-0038)+ `bind-broker-account.request.ts`（`{ brokerCode: string, clientNo: string }` class-validator `@IsString()`+`@IsNotEmpty()`，缺/类型错→400 `FORM_VALIDATION`；深度校验在 UC rules）+ 单测（Testcontainers PG：有效→201 落库 / dup 同键→409 不重复落库 / 未知券商→400 / 空 clientNo→400 / 禁字符 clientNo→400 / 同券商不同 clientNo→均 201）。run via `nx test server <file>`

---

## Phase 4: User Story 3 — [Server] 删除券商账户（默认不可删 + 反枚举 + id 消歧）(P1)

**Independent Test**: Testcontainers PG；①DELETE 本账号已绑 id→204，GET 不再含；②DELETE 默认账户（id=account id）→**400 DEFAULT_ACCOUNT_NOT_DELETABLE** 列表不变；③DELETE 不存在 id / 他人账号 id→均 **404 字节级一致**；④幂等：DELETE 已删 id→404。

- [X] T006 [US3] [Server] `apps/server/src/portfolio/delete-broker-account.usecase.ts`（intra 写）：**先 scoped-delete 后判定**（D3）：`prisma.brokerAccount.deleteMany({ where:{ id, accountId } })` → `count===1`→204；`count===0 && id===accountId`（默认虚拟 id）→400 `DEFAULT_ACCOUNT_NOT_DELETABLE`；`count===0 && id!==accountId`→404（字节级一致 ProblemDetail 反枚举，FR-S05）+ **V1 归属回落 = 仅删行**（import 未建无 position 数据，文档化语义不建空 seam，FR-S06/D7）+ `default-account-not-deletable.exception.ts`(400) + 单测（Testcontainers PG：删本账号→204 + GET 不再含 / 删默认 id=accountId→400 列表不变 / 不存在 id→404 / 他人账号 id→404 / 已删 id 幂等→404 / 验本账号真实 broker 行 id 即使数值==accountId 仍先删命中 204 不误判默认）。run via `nx test server <file>`

---

## Phase 5: [Server] controller + module 接线 + throttler（serves US1+US2+US3）

- [X] T007 [Server] `apps/server/src/portfolio/broker-accounts.controller.ts`（`@Controller('v1/portfolio/broker-accounts')` + `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()`，对齐 `market-preferences.controller.ts`）：`@Get()`（EP1）+ `@Post()` `@HttpCode(201)`（EP2）+ `@Delete(':id')` `@HttpCode(204)`（EP3，`id` ParseBigInt pipe 或 string→BigInt）+ Swagger（EP1 200/401/429；EP2 201/400/401/409/429；EP3 204/400/401/404/429）+ named throttler `broker-acct-get-account` 60/60s · `broker-acct-post-account` 30/60s · `broker-acct-delete-account` 30/60s（D4 ⚠️ gate review）+ `@SkipThrottle` 其余全部桶（含 011 market-pref 桶）；接线：①`portfolio.module.ts` `controllers` 加 `BrokerAccountsController` + `providers` 加 3 broker UC（imports 不变，SecurityModule+AccountModule 已足）②`security/throttler-skip-buckets.ts` 加 `BROKER_ACCT_BUCKETS{broker-acct-get/post/delete-account}` + aggregate `BROKER_ACCT_ALL`③`auth/auth.module.ts` `ThrottlerModule.forRootAsync` `throttlers[]` 注册 3 新 named throttler（getTracker per-account，复制 `MARKET_PREF_THROTTLERS` 形状）④**9 个既有业务 controller**（account-profile / account-phone-sms-auth / account-sms-code / account-token / account-deletion / cancel-deletion / device-management / wechat-binding / **011 market-preferences**）`@SkipThrottle` spread `...BROKER_ACCT_ALL`（反污染纪律，同 004/010/011 桶扩张 chore）+ 单测（mock 3 UC 映射：GET→200 list / POST→201 / 409 / DELETE→204 / 400 默认 / 404；DTO 校验 400）+ verify typecheck 绿（app.module 已注册 PortfolioModule 无需改）

---

## Phase 6: [Server-IT] 全 boot 集成测试（Testcontainers PG+Redis）

- [X] T008 [US1] [Server-IT] `apps/server/test/integration/broker-accounts.us1-list.it.spec.ts`（全 boot）：ACTIVE 账号 login 取 token → GET → 200 + 仅默认账户（isDefault=true / id=account id / brokerCode=null / clientNo=null）；预置本账号 2 已绑 + 他人账号 1 → GET → 默认置顶 + 本账号 2（按 createdAt，clientNo raw 明文）、他人不可见；缺 token / 非 ACTIVE → 401 ProblemDetail（与 `/me` 字节级一致路径，剥 traceId，反枚举）
- [X] T009 [US2] [Server-IT] `apps/server/test/integration/broker-accounts.us2-bind.it.spec.ts`（全 boot）：POST {有效 brokerCode, clientNo}→201 + GET 含新条（raw）；重复 POST 同 {brokerCode, clientNo}→**409 `BROKER_ACCOUNT_DUPLICATE`** + GET 仍 1 条（不重复落库）；**并发同键（D1 gate）**——N 端并发 POST 同 {brokerCode, clientNo}（service 层直测绕限流）→ 唯一索引串行化 → 断言**恰一 201 一/多 409**（验 adapter-pg 下 P2002 catch 真生效，**不靠假设**，per memory `prisma_serializable_p2002_and_p2034`）；POST 未知 brokerCode→400 `FORM_VALIDATION`；POST 空 clientNo→400；POST 含控制字符 clientNo→400；POST 同券商不同 clientNo 两条→均 201；缺 token→401
- [X] T010 [US3] [Server-IT] `apps/server/test/integration/broker-accounts.us3-delete-ratelimit.it.spec.ts`（全 boot + `beforeEach` Redis flushall）：**删除（SC-S03）**——预置本账号 1 已绑 → DELETE 该 id→204 + GET 不再含；DELETE 默认账户（id=account id）→**400 `DEFAULT_ACCOUNT_NOT_DELETABLE`** + GET 列表不变；DELETE 不存在 id→404；DELETE 他人账号已绑 id→**404 字节级一致**（与「不存在」ProblemDetail 深等剥 traceId，反枚举）；DELETE 已删 id 幂等→404；**限流（SC-S05）**——`broker-acct-get-account` 第 61 / `broker-acct-post-account` 第 31 / `broker-acct-delete-account` 第 31 次 60s 内→429 + `Retry-After`

---

## Phase 7: [Contract] 同步链（Constitution V，Nx-driven）

- [X] T011 [Contract] `nx run server:export-openapi` 产 `apps/server/openapi.json`（canonical `node dist/main.js`，含 EP1 `GET` + EP2 `POST` + EP3 `DELETE portfolio/broker-accounts` + `BrokerAccountListResponse`/`BrokerAccountItem` schema + 2 新 error code `BROKER_ACCOUNT_DUPLICATE`/`DEFAULT_ACCOUNT_NOT_DELETABLE`）→ `nx affected -t generate`（Orval regen api-client portfolio broker 端点 typed hook：`useGetBrokerAccounts` query + `useBindBrokerAccount` + `useDeleteBrokerAccount` mutation，**函数式非 class** ✓）+ api-client/mobile typecheck 绿（mobile 暂不消费，同 005/010/011 先 regen 供 PR2）

---

## Phase 8: PR1 收尾（catalog + server 全门）

- [X] T012 [Server] catalog 3 Operation 行：`docs/conventions/server-bounded-context-catalog.md` § Operation Catalog 加 `list-broker-accounts` / `bind-broker-account` / `delete-broker-account`（context=**portfolio**，propagation=**intra**（无 R2/R3），source PR）；spec.md `modules: [portfolio]` 与 catalog 一致（已对齐，无需改）
- [X] T013 [Verify] **PR1 server 全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`，per memory `nx_cache_false_green_on_new_files` 新文件首跑 `--skip-nx-cache`）：lint+typecheck 0 / test（broker 字典+rules 单测 + list/bind/delete UC Testcontainers 单测 + US1/US2/US3 IT 含并发+限流 + api-client）/ build / runtime-smoke（真 boot 探 EP1-3 契约 + RFC 9457 ProblemDetail）+ `boundaries` 0 violation + `check-server-moat.ts` **0 违规**（brokerAccount MODEL_OWNERSHIP 已登记，intra 无跨 ctx 注释需求）。ships 真后端供 PR2 冒烟。**PR1 描述 cite §V 例外**

---

## Phase 9: User Story 4–6 — [Mobile] 券商账户三页流转（PR2，对 PR1 真后端冒烟）

**Independent Test**：见各 US 验收 + T020 Playwright 真后端冒烟（per 类 2 流程纪律②）。

- [X] T014 [Mobile] **UI 原语①删除交互对**（`~/ui`，presentational **无单测** per mono 测试分层，typecheck/lint + 视觉 0 hex SC-M06）：`SwipeRow.tsx`（左滑露出 84px `err` 红底白字「删除」块，`react-native-gesture-handler` Swipeable 或等价；色用 `~/theme` err token **0 hex**；手势与列表滚动冲突走手势库默认）+ `ConfirmModal.tsx`（二次确认 modal：取消 / 删除，`err` 强调删除按钮）+ `~/ui/index.ts` barrel 导出
- [X] T015 [Mobile] **UI 原语②选择弹层**（`~/ui`，presentational 无单测，typecheck/lint + 0 hex）：`SearchBar.tsx`（搜索输入，按名/简拼过滤）+ `AlphaIndex.tsx`（右侧 A-Z 字母条点击跳转 + sticky group header，按 pinyinInitials 首字母分组）+ `BrokerPickerSheet.tsx`（**底部 sheet** 上滑 translateY + scrim + drag handle + 圆角，mockup 定**非全屏**；标题「选择券商」+ 返回 + 内嵌 SearchBar + AlphaIndex + 券商列表 logo+名 + 搜索无结果空态；**无「开户」按钮/无能力标签** mockup DO-NOT；选中回调传 brokerCode）+ barrel 导出
- [X] T016 [P] [Mobile] **client 字典 + 脱敏**：`apps/mobile/src/portfolio/broker-catalog.ts`（client 字典 12 券商 `{ brokerCode, brokerName, pinyinInitials, logoAsset }` + 按 pinyinInitials 分组/排序派生供页 C A-Z 索引+搜索；logo = mockup「名首字蓝 chip」(`brand soft` 底/`brand-500` 字) 占位，真品牌 logo 后续 FR-M07）+ `apps/mobile/src/format/broker.ts`（`maskClientNo(clientNo: string|null): string`，mockup maskCust 口径 `>8 字符→前4+'****'+后4` 如 `3119****2466`，≤8 对齐 baseline；同 `phone.ts maskPhone` 范式）+ `format/broker.spec.ts` vitest（前4后4 / 短号 / null）+ Metro 相对 import **extensionless** per memory `metro_web_cannot_resolve_js_extension_imports`
- [X] T017 [US4] [US5] [US6] [Mobile] `apps/mobile/src/portfolio/use-broker-accounts.ts`（包 orval `useGetBrokerAccounts` query + `useBindBrokerAccount` + `useDeleteBrokerAccount` mutation）：绑定成功 invalidate 列表 + 回页 A（FR-M03）；删除乐观移除 + 失败回滚（FR-M06）；错误分流（409 dup→行内重复提示 / 400 校验 / 通用网络错，复用 `~/core/api` errors guard 体例 FR-M08）+ `src/portfolio/broker-copy.ts`（中文文案：「股票账户」/「绑定券商」/「选择券商」/「系统默认」/「本账号 · 未归类持仓的默认归属」/「已绑定」/「删除」/「新建」/重复错误文案）+ vitest logic 单测（删除乐观移除 + 失败回滚原态 / 409 dup vs 400 校验 vs 网络错分流 / 绑定成功 invalidate）。extensionless import
- [X] T018 [US4] [US6] [Mobile] **页 A 列表 + route + 入口翻 live**：`src/portfolio/broker-row.tsx`（默认/已绑两变体：默认 ◉ 灰 chip + 「系统默认」tag + 副文案 + **无删除入口**；已绑 logo chip + 券商名 + 「已绑定」tag + **脱敏客户号**(maskClientNo) + 左滑删除 SwipeRow；a11y FR-M09）+ `src/portfolio/broker-account-list-screen.tsx`（默认置顶 + 已绑列表 + 右上「新建」→页 B + 空态(仅默认) + loading/retry + 左滑删除接 ConfirmModal 二次确认→deleteMutation，US6）+ `app/(app)/settings/broker-accounts.tsx`（薄 route，import screen from `~/portfolio`）+ `app/(app)/settings/_layout.tsx` 注册 `<Stack.Screen name="broker-accounts" .../>`（title「股票账户」+ headerLeft makeHeaderBackOrParent）+ `app/(app)/settings/index.tsx` 把投资设置 Card 内 `券商账户` Row **翻 live**（`onPress→/(app)/settings/broker-accounts`，移除 disabled，D9）+ typecheck/lint（视觉 0 硬编码 grep，SC-M06）
- [X] T019 [US5] [Mobile] **页 B 表单 + 页 C 接线**：`src/portfolio/broker-bind-screen.tsx`（行 1「选择券商」点击开 `BrokerPickerSheet`（页 C）；选中后 logo+名内联显示（替占位）；「客户号」文本输入（右对齐 mono）；「绑定」按钮（券商已选 + clientNo 非空→enabled 否则 disabled，FR-M04/SC-M03，**不发请求**）；提交→bindMutation→成功回页 A、409→行内红框重复错误；**无货币单位行** mockup DO-NOT）+ 页 C BrokerPickerSheet 接线（broker-catalog 数据源 + 搜索 + A-Z + 选中回填页 B）+ `app/(app)/settings/broker-accounts/bind.tsx` route + `_layout.tsx` 注册 Screen（title「绑定券商」）+ typecheck/lint（0 hex）
- [X] T020 [US4] [US5] [US6] [Mobile-E2E] `apps/mobile/e2e/broker-account-binding.spec.ts`（Playwright Expo Web，**真后端冒烟** against PR1 已 ship server，per 纪律②；seed-authed addInitScript + **mock REFRESH_URL 200**；`getByRole` 收窄 stacked screen；web-stripped route group URL；本地跑前杀 :3000 nx serve 父进程）：登录 → 设置进券商账户列表 → 断言**仅默认账户**（系统默认 tag，无删除入口，US4）→ 右上「新建」进页 B → 点「选择券商」开**底部 sheet**（搜索 + A-Z 索引，**无开户按钮/无能力标签** SC-M05）→ 选中某券商回填页 B → 填客户号 → 「绑定」→ 回列表含新条（**脱敏客户号** SC-M02）→ 左滑已绑行 + 二次确认 → 移除（SC-M04/US6）→ dup 重复绑定 → 行内红框错误（US5.5）→ 默认账户行无左滑删除（US6）→ 截图归档 `runtime-debug/2026-06-XX-broker-account-binding/`

---

## Phase 10: PR2 收尾 & 全门

- [X] T021 [Verify] **PR2 mobile 全门绿**（`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache`）：lint+typecheck（4 projects 0）/ test（`use-broker-accounts` + `format/broker` vitest logic 单测 + 既有不回归）/ build / runtime-smoke（`expo export -p web` + playwright e2e 含 T020）+ 视觉 0 硬编码 grep（实现文件无 theme token 外 hex/rgb，SC-M06）+ **frontmatter flip**：spec.md `status: draft→implemented` + plan.md `status: draft→done`

---

## Dependencies（完成顺序）

```text
[PR1 Server]
Foundational(T001-T003) → US1 list UC(T004) → US2 bind UC(T005) → US3 delete UC(T006) → controller+module+throttler(T007) → IT(T008-T010) → Contract(T011) → 收尾(T012-T013)
                                                                                                                                                  ┊ ships 真后端
[PR2 Mobile]（依赖 T011 typed api-client + T013 真后端 ship）
UI 原语(T014-T015) → 字典+脱敏(T016) → hook(T017) → 页 A+入口(T018) → 页 B+C(T019) → e2e(T020) → 收尾(T021)
```

- **Foundational 阻塞全部 UC**：T001（schema/migration）→ T004/T005/T006（UC 读写 `broker_account`）；T002（moat 登记）→ T013 verify（登记齐才不红）；T003（字典+rules）→ T004（buildBrokerAccountList）/ T005（isKnownBroker+normalizeClientNo）/ T006（无直接依赖但同 rules 文件）。
- **US1**：T004 依赖 T001+T003。**US2**：T005 依赖 T001+T003（+ duplicate exception/DTO 同 task）。**US3**：T006 依赖 T001（+ default-not-deletable exception 同 task）。
- **controller**：T007 依赖 T004+T005+T006（注入 3 UC）+ T002（module 边界）；throttler 桶接线 + 9 既有 controller spread skip 同 task。
- **IT**：T008 依赖 T007（GET 端点）；T009 依赖 T007（POST + 限流桶在 T007 注册）；T010 依赖 T007（DELETE + 限流）。
- **Contract**：T011 依赖 EP1+EP2+EP3 全落（T007）。
- **PR1 收尾**：T012 catalog 依赖 3 UC 落地；T013 verify 依赖 T001-T012 全绿。
- **Mobile（PR2）** 全部依赖 T011（typed api-client）+ T013（真后端 ship 供 T020 冒烟）。T017 hook 依赖 T016（字典 type 可选）；T018 页 A 依赖 T014（SwipeRow/ConfirmModal）+ T016（maskClientNo）+ T017（hook）；T019 页 B+C 依赖 T015（BrokerPickerSheet）+ T016（字典）+ T017（hook）；T020 e2e 依赖 T018+T019（三页落地）；T021 verify 依赖 T014-T020。

## Parallel Opportunities

- Foundational：T002（moat 登记）∥ T003（字典+rules）（不同文件，均不依赖 T001 物理落表——moat 是静态登记，字典/rules 是纯常量）。T001 schema 先落则 T004-T006 才能跑 Testcontainers 单测。
- Server UC：T004/T005/T006 文件互不重叠，但 T005/T006 catch 逻辑+exception 各自独立 → 三者实现可流水（IT T008-T010 依赖 controller T007 接线后才全 boot）。
- Mobile：T014（删除交互对）∥ T015（选择弹层）∥ T016（字典+脱敏）（三组不同文件互不依赖，可并行起手）；T017 hook 与 UI 原语并行；T018/T019 屏组件依赖原语+hook 就绪后串行。

## Implementation Strategy

1. **broker 表 + 登记（Foundational）**：复用 011 portfolio ctx，仅新增 `broker_account` 多行表（T001）+ moat 一行登记（T002，`brokerAccount:'portfolio'`，**硬前置**否则读自己表即 `moat-unmapped` 红）+ 静态券商字典副本/纯函数 rules（T003，含 normalizeClientNo 禁字符 + buildBrokerAccountList 默认置顶）。**比 011 轻**：无新 ctx bootstrap、无 datasource schemas 改、无 boundaries 改。
2. **MVP = US1 list**（T004）：读侧默认账户虚拟置顶 + 跨账号隔离 + raw clientNo，列表是绑定/删除的承载基座。
3. **US2 bind**（T005）：字典+禁字符校验 + **唯一索引 + P2002→409**（D1，无 FOR UPDATE——行独立单行约束，区别于 011 min-1 跨行不变性）。
4. **US3 delete**（T006）：**先 scoped-delete 后判定**（D3）消除默认虚拟 id 与 broker 行 id 的 BigInt 碰撞歧义 + 反枚举 404 字节级一致 + V1 仅删行（D7）。
5. **接线 + IT**（T007-T010）：单 controller 服务 GET+POST+DELETE + throttler 反污染 chore（9 既有 controller spread skip）；每 US 的 Independent Test 落 [Server-IT] 全 boot，**US2 IT 必含并发同键验 adapter-pg P2002 真生效**（D1 gate）。
6. **契约同步**（T011）：openapi（canonical node dist/main.js）+ Orval regen typed hook 供 mobile。
7. **PR1 ship**（T012-T013）：catalog 3 行 + server 全门 → ships 真后端。**PR1 描述 cite §V 例外**。
8. **mobile 闭环（PR2）**：**5 新原语**（删除交互对 T014 + 选择弹层 T015）→ 字典+脱敏（T016）→ hook（乐观删除回滚+错误分流 T017）→ 页 A 列表+入口翻 live（T018）→ 页 B 表单+页 C sheet（T019）→ Playwright 真后端冒烟三页流转（US4-6，T020）。**mobile 重于 011**（5 原语+三页+A-Z 索引+底部 sheet vs 011 单 Switch）。
9. **PR2 收尾**（T021）：全门 + 视觉 0 硬编码 + frontmatter flip。
10. 每 task 30min-2h，独立 commit + `[X]` flip（Constitution III + 6 步闭环；UI 原语 5 个分 2 task 控 clear 批次 per Constitution §III）；**dup 用唯一索引+P2002 / 删除用 scoped-delete 消歧是本 feature 关键健壮性点**。
