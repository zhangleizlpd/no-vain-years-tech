---
feature_id: 015-marketdata-access-layer
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-02'
---

# Tasks: 015-marketdata-access-layer（Marketdata 可插拔数据访问层）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `015-marketdata-access-layer`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 映射 spec user story（US1 端口骨架 / US2 搜索 / US3 详情+K线 / US4 报价 / US5 vendor 约束 / US6 universe·calendar·fsType 能力面）；Foundational / Contract / Verify 不带
- 层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Verify]`（per sdd.md；**本 feature 纯 server，无 [Mobile]/[Mobile-E2E]** —— 读端点 mobile 消费归 013/014）
- **Phase = PR 交付单元**（user 定 3 段，per plan §Phase 2 / D5）：015 的 6 个 US 是**分层 infra**（US1 骨架阻塞全部；US5 VendorHttpClient 阻塞 US3/4 读侧），非 012 那种并行垂直切片 → 按 PR 组 phase，task 标 US 映射 spec 验收。
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读 DB / adapter 落库 = **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；纯函数（rules / 符号归一化 / 限频器）= vitest 无 DB；**每 PR 末单列 `[Server-IT]` 全 boot task**；vendor 契约 = mock 单测 + **env-gated 真 vendor IT**（`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`/东财，默认 skip，沿 `RUN_PERF_IT` `describe.skipIf`）
- 无 task-meta JSON（**manual 模式**，per 004-012）
- **marketdata = 新建第 5 bounded context**（ADR-0032 Q4，与 auth/account/security/portfolio 平级）：module 目录 + Prisma `marketdata` schema + ESLint 单向边界 + `BUSINESS_CTX` 加 marketdata + `MODEL_OWNERSHIP` 6 行 **均本 feature 首次落地**（≠ 012 复用 011 已立 portfolio）。**零跨 ctx 业务调用**（叶子，intra only，无 R2/R3 → 无 `// CROSS-CONTEXT-*` 注释）；唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（经 `AccountModule` export 复用的 account-bound 鉴权 artefact，非 use case 调用，无注释，per plan §Cross-cutting）
- **可插拔范式（ADR-0047）**：消费者只依赖端口 `Symbol + interface`；config discriminated-union（镜像 [`sms.config.ts`](../../apps/server/src/config/sms.config.ts)）；Vendor Constraint Profile 由共享 `VendorHttpClient` 统一执行；多源经 `FallbackChainAdapter`
- **新 dep（D3/D4 ⚠️ impl 前 context7 grounding）**：限频器/http 优先自写/Node 内置零新 dep；`pinyin-pro`（本地搜索拼音）impl 前验当前版本 API + CN 可用（per ADR-0040 Dependencies 防火墙，禁无锚点 cargo-cult）
- **3 段 PR（均纯 server）**：**PR1 骨架**（T001–T004，schema+8 端口+config+Mock，可独立 ship boot 绿）→ **PR2 vendor+读端点**（T005–T011，理杏仁事实源+EP2/3/4+contract regen）→ **PR3 search+fallback**（T012–T015，东财+本地+FallbackChain 接通 EP1）。Constitution §V 纯 server 单端 → 各 PR 自带 IT；api-client regen 随端点 PR ship（mobile 暂不消费，供 013/014，沿 005/011 先例）

## Path Conventions

- server：`apps/server/src/marketdata/`（**新 module**，ADR-0043 扁平文件平铺）；schema `apps/server/prisma/schema.prisma`；config `apps/server/src/config/marketdata.config.ts`；migration `apps/server/prisma/migrations/{YYYYMMDD}_{HHMM}_add_marketdata_access_layer/`（expand-only + `migration_refs` frontmatter，ADR-0035）；IT `apps/server/test/integration/*.it.spec.ts`（**run via `nx test server <file>`，cwd=apps/server**）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js` 非 dump-openapi.mjs，per memory `openapi_export_must_use_canonical_mainjs`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- 复用：**`cockatiel` 库**（npm 弹性库，退避+熔断原语，marketdata 自配 vendor policy；**直 `import from 'cockatiel'`，禁 DI `auth/cockatiel-retry.executor.ts`**——叶子不依赖 auth，C1 修）、[`config/sms.config.ts`](../../apps/server/src/config/sms.config.ts)（discriminated-union 样板，**仅照搬范式非 import**）、`SecurityModule`（PrismaService + `REDIS_CLIENT` ioredis singleton + ProblemDetailFilter）、`AccountModule`（JwtAuthGuard + AccountIdThrottlerGuard export）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（per memory `mono_dev_db_compose_stack`；mbw-poc-postgres:5433 / redis:6380）；本地起服/IT 前 **`env -u OSS_*`** + 显式 dev `DATABASE_URL`/`REDIS_URL`（per memory `local_it_smoke_needs_env_unset_oss`）
- ⚠️ 新 ts/spec 首跑带 **`--skip-nx-cache`**（per memory `nx_cache_false_green_on_new_files`）

---

## Phase 1: PR1 — 可插拔骨架（schema + 8 端口 + config + Mock；阻塞全部后续）🎯 MVP

**PR1 Independent Test**: Testcontainers PG+Redis；① 零 env boot → 8 端口全解析 Mock adapter、健康启动、各端口返确定性 fixture；② config `kind:live` 缺 `LIXINGER_TOKEN` → boot 失败（zod 校验错，非静默降级）；③ migrate deploy 6 表 + pg_trgm extension + GIN index 落库。**可独立 ship**（模块 boot + Mock 端到端绿）。

- [X] T001 [Server] `apps/server/prisma/schema.prisma`：`datasource db.schemas` 加 `"marketdata"` + **6 张事实/注册表**（贫血 row + `@map` snake_case，**无 Entity Mapper** per memory `raw_prisma_row_with_map_no_entity_mapper`；价格/比率全 `Decimal` 禁 Float；逻辑 `instrumentId` 无跨 schema FK）：`Instrument`（`(market,code)` 唯一 + `pinyinAbbr`/`pinyinFull` + `lixingerCompanyType` + `syncTier Int @default(2)`（**016 重算，本 feature 仅建列不消费**）+ status/listDate/delistDate）/ `DailyBar`（**唯一键 `(instrumentId,tradeDate,adjust)`** 修正 PRD + OHLC `Decimal(18,4)` + prevClose/volume/amount/turnoverRate + `(instrumentId,tradeDate desc)` 索引）/ `FundamentalSnapshot`（`(instrumentId,date)` 唯一）/ `FinancialMetric`（`(instrumentId,reportPeriod)` 唯一）/ `CorporateAction`（`(instrumentId,exDate,type)` 唯一 + `payload Json`）/ `TradingDay`（`(market,date)` 唯一）。**SyncDimension/SyncBlacklist/SyncRun 不建（归 016，clarify 定）**。+ migration `{YYYYMMDD}_{HHMM}_add_marketdata_access_layer/`（**expand-only**：CREATE SCHEMA + 6 表 + 索引 + raw `CREATE EXTENSION IF NOT EXISTS pg_trgm` + Instrument `pinyin_abbr` GIN trgm index → 非破坏单 PR 合规，ADR-0035 + `migration_refs` frontmatter）+ `prisma generate` + dev DB `docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy` 验证落表 → verify: `nx test server <marketdata-schema.it.spec>`（Testcontainers migrate deploy + pg_trgm 可用断言）
- [X] T002 [P] [Server] **moat + boundaries 登记**（SC-S07，**marketdata 新 ctx 首次**）：[`scripts/checks/check-server-moat.ts`](../../scripts/checks/check-server-moat.ts) `MODEL_OWNERSHIP` 加 6 行（`instrument`/`dailyBar`/`fundamentalSnapshot`/`financialMetric`/`corporateAction`/`tradingDay` → `'marketdata'`，**否则 marketdata UC 读自己的表即 `moat-unmapped` 硬拒**）+ `BUSINESS_CTX` 加 `'marketdata'`（当前 `{auth,account,portfolio}`）；`apps/server/eslint.config.mjs` `boundaries/elements` 加 `{type:'marketdata', pattern:'src/marketdata/**'}` + `boundaries/dependencies` marketdata 仅许依赖 `security`/`account`（叶子，不依赖 auth/portfolio）+ 其余 ctx 禁依赖 marketdata → verify: `nx lint server` 0 violation & `pnpm tsx scripts/checks/check-server-moat.ts` 关
- [X] T003 [US1] [US6] [Server] **8 端口接口 + config + module + Mock**：`apps/server/src/marketdata/*.port.ts`（8 个 `Symbol + interface`：`INSTRUMENT_SEARCH`/`INSTRUMENT_UNIVERSE`/`TRADING_CALENDAR`/`EOD_BAR`/`FUNDAMENTAL`/`FINANCIALS`/`CORPORATE_ACTION`/`QUOTE`，canonical `${market}:${code}`）+ `config/marketdata.config.ts`（zod discriminated-union `kind:'mock'|'live'`，`live` 时 `LIXINGER_TOKEN` `.min(1)` boot fail-fast、东财 baseUrl 默认，`registerAs('marketdata',…)`，**镜像 sms.config.ts**）+ `marketdata.module.ts`（`imports:[SecurityModule,AccountModule]`，每端口一个 `useFactory` DI 工厂按 kind 选 adapter）+ `mock-market-data.adapter.ts`（8 端口全覆盖确定性 fixtures，零 env 默认）+ `app.module.ts` 加 `MarketdataModule` → verify: 零 env boot smoke（`scripts/ci/server-boot-smoke.ts`）+ `kind:live` 缺 token boot fail-fast 单测 + Mock 各端口返 fixture 单测
- [X] T004 [US1] [Server-IT] **PR1 boot IT**（Testcontainers PG+Redis 全 boot，per memory NestJS lifecycle 用 `createTestingModule` 非隔离 mock）：零 env → 8 端口解析 Mock + 各端口可调返 fixture / `kind:live` 缺 token → boot 抛 zod 错（fail-fast，spec state_branch「config fail-fast」「mock default」）。run via `nx test server <file>`

---

## Phase 2: PR2 — Vendor 传输 + 理杏仁事实源 + 读端点（EP2/3/4）

**PR2 Independent Test**: Testcontainers PG+Redis（seed Instrument + 多 adjust DailyBar + Fundamental/Financial/CorpAction）；① 双窗限频器超 perSec/perMin → 排队不向 caller 抛 429 + 必需 header 注入 + 429/瞬时退避重试；② 报价 EOD-backed（前收算涨跌 + asOf/priceKind + no-data 隔离 + Redis 命中）；③ 详情聚合（报价 header + 估值/分位/财务/公司行动 + 身份 + 52 周高低 + 缺失维度 null）/ 404 / Decimal-string；④ K线 adjust + period 聚合（周/月/季/年）+ 空区间。

- [X] T005 [US5] [Server] **VendorHttpClient + Constraint Profile + 双窗限频器**：`apps/server/src/marketdata/vendor-http-client.ts`（注入必需 header + 过双窗限频 + 用 **`cockatiel` 库**自配退避+熔断 policy（`import { retry, circuitBreaker, … } from 'cockatiel'`，~15 行 wrapper，**禁 DI auth 封装类**——叶子不依赖 auth，C1 修）+ 429/瞬时 `transientWait`）+ `lixinger.constraint-profile.ts`（`{perMin:1000,perSec:36,headers:{'Content-Type':'application/json','Accept-Encoding':'gzip'},retry:{maxAttempts:3,backoff:'exponential'},transientWait:'≥60s'}`）+ `eastmoney.constraint-profile.ts`（逆向保守 + UA/Referer）+ 双窗令牌桶限频器（分窗+秒窗纯函数，**D4 自写零新 dep 优先**；impl 前验 cockatiel 是否原生双窗）→ verify（vitest 纯逻辑）: 超 perSec 突发 → 节流到窗口内（非 429-to-caller）/ 超 perMin 同理 / 必需 header 注入断言 / 429+瞬时 → 按 profile 退避重试 N 次（spec state_branch「vendor constraint enforce」）
- [X] T006 [US3] [US6] [Server] **理杏仁 4 adapter + 符号归一化 + fsType 内部路由**：`lixinger-{eod-bar,fundamental,financials,corporate-action}.adapter.ts`（经 VendorHttpClient + Lixinger profile）+ `lixinger-symbol.rules.ts`（canonical `market:code` ↔ Lixinger stockCode 纯函数双向）+ fsType 内部路由（`LixingerFundamentalAdapter` 内部调 `cn/company` 解析公司类型 → 路由对应 fundamental 端点 → 缓存 `Instrument.lixingerCompanyType`，端口签名 `getFundamentals(symbols)` 不暴露 fsType，FR-S11）→ verify: mock 单测（各 adapter 解析）+ 符号 round-trip 测（spec state_branch「symbol normalization round-trip」）+ fsType 不外泄签名断言 + **env-gated 真理杏仁 IT**（`RUN_MARKETDATA_IT`+`LIXINGER_TOKEN`，默认 skip）。run via `nx test server <file>`
- [X] T007 [US4] [Server] **EodBackedQuoteAdapter + marketdata.rules + 报价 UC + Redis 热快照**：`eod-backed-quote.adapter.ts`（消费 `EOD_BAR_PORT`/PG DailyBar，asOf/priceKind）+ `marketdata.rules.ts`（纯函数：前收算 change/changePct、Decimal→string、period OHLC 聚合（首开/最高/最低/末收+量和）、52 周高低（近 252 DailyBar max/min close））+ `get-quotes.usecase.ts`（批量 symbols；读路径 `Redis 热快照 quote:{symbol} TTL 至下次 EOD → miss 回 PG`，jittered TTL ±10% 防惊群，D6）+ `quote-list.response.ts`（`QuoteItem{symbol,price?,change?,changePct?,asOf?,priceKind,hasData}`，Decimal `@ApiProperty({type:'string'})` per memory `nullable_apiproperty_needs_type_string`）→ verify: 前收算涨跌单测 + period 聚合/52周高低 纯函数测 + no-data 项 `hasData:false` 隔离 + Decimal-string 序列化 + Redis 命中不重打 PG（spec state_branch「quote eod-backed」「quote no-data」）
- [X] T008 [US3] [Server] **详情 + K线 读端点 UC + DTO + controller（EP3/EP4）+ exception**：`get-instrument-detail.usecase.ts`（聚合 `prisma.{instrument,dailyBar,fundamentalSnapshot,financialMetric,corporateAction}` 最近行 + 调 marketdata.rules 算报价 header/52周高低，未知 symbol → 404）+ `get-instrument-bars.usecase.ts`（`prisma.dailyBar` adjust 过滤 + period 聚合）+ `instrument-detail.response.ts`（报价 header + 估值/分位/财务/公司行动 + 身份 + 52周高低，缺失维度 null，Decimal `type:'string'`）+ `daily-bar-list.response.ts` + `marketdata.controller.ts`（`@Controller('v1/marketdata')` `@UseGuards(JwtAuthGuard,AccountIdThrottlerGuard)`：EP3 `GET instruments/:symbol` + EP4 `GET instruments/:symbol/bars`，swagger 200/400/401/404/429）+ `instrument-not-found.exception.ts`（404，镜像 011 exception，ADR-0038）→ verify（Testcontainers PG seed）: 详情聚合字段集 + 缺失维度 null + 404 + Decimal-string / bars adjust 三态 + period 聚合 + 非法 adjust 400 + 空区间空 bars（spec state_branch「detail aggregate」「detail not-found」「bars adjust」「bars period aggregation」「detail field coverage」）。run via `nx test server <file>`
- [X] T009 [US4] [Server] **报价端点（EP2）+ throttler 4 桶 + 既有 controller 反污染**：`marketdata.controller.ts` 加 EP2 `GET quote`（swagger）+ `security/throttler-skip-buckets.ts` 加 `MARKETDATA_BUCKETS`（4 桶：`mktdata-{search,quote,detail,bars}-account`，tracker=JWT sub）+ `MARKETDATA_ALL` + `auth/auth.module.ts` 全局 ThrottlerModule 加 4 named throttler（search 60/quote 120/detail 60/bars 60 per 60s，⚠️ tasks gate）+ **所有既有 controller** `@SkipThrottle` spread `...MARKETDATA_ALL`（反污染纪律，沿 011/012）→ verify: 桶边界 429+Retry-After IT
- [X] T010 [US3] [US4] [Server-IT] **PR2 读侧全 boot IT**（Testcontainers PG+Redis，seed fixtures）：报价 EOD/no-data/Redis 命中 · 详情聚合/404/字段集/Decimal-string · K线 adjust/period/空 · 限流桶边界。run via `nx test server <file>`。**实装跨 3 文件**：报价 `marketdata.read-quote.it.spec.ts`（本 task 新增 — EodBackedQuoteAdapter 读 PG，overrideProvider QUOTE_PORT 绕 Mock 单例；mock 全 boot 干净，live 下 search/universe/calendar 仍 notWiredLive 会崩 boot 落 PR3）；详情/404/字段集/Decimal-string + K线 adjust/period/空 = T008 `marketdata.read-detail-bars.it.spec.ts`；限流桶边界 = T009 `marketdata.ratelimit.it.spec.ts`
- [X] T011 [Contract] **EP2/3/4 契约同步**：`nx run server:export-openapi`（canonical `node dist/main.js`，per memory `openapi_export_must_use_canonical_mainjs`）→ `nx affected -t generate`（Orval regen marketdata 端点 hook）→ `packages/api-client` + server typecheck 绿（mobile 暂不消费，供 013/014）

---

## Phase 3: PR3 — 东财 search + 本地 pg_trgm 备 + FallbackChain（接通 EP1）

**PR3 Independent Test**: Testcontainers PG（seed Instrument + 拼音）；① 东财 mock 返候选 → 归一化 canonical；② 东财 503/超时 → FallbackChain 平移本地 pg_trgm（名/拼音/代码命中）；③ 主空 + 本地无命中 → 空 items（200，非 5xx）；④ env-gated 真东财 MultiMatch 解析。

- [X] T012 [US2] [Server] **EastmoneySearchAdapter + 东财符号归一化**：`eastmoney-search.adapter.ts`（经 VendorHttpClient + 东财 profile，searchapi MultiMatch A/HK/US → 归一化 canonical + name + type）+ `eastmoney-symbol.rules.ts`（canonical ↔ 东财 secid `1.600519` 双向）→ verify: mock 单测（MultiMatch 解析 + 归一化）+ 符号 round-trip + **env-gated 真东财 IT**（`RUN_MARKETDATA_IT`，默认 skip）。run via `nx test server <file>`
- [X] T013 [US2] [Server] **LocalInstrumentSearchAdapter（pg_trgm + 拼音）**：`local-instrument-search.adapter.ts`（`prisma` raw `pg_trgm` similarity on `name` + `pinyin_abbr`，need Instrument seed）+ Instrument 拼音填充策略（`pinyinAbbr`/`pinyinFull` 由 `pinyin-pro` 生成，**D3 impl 前 context7 验版本+CN 可用**；填充时机 = 016 同步写 Instrument 时算，本 feature 仅 seed fixture 含拼音验搜索）→ verify: seed Instrument（含拼音）→ pg_trgm similarity IT（名/拼音/代码命中、相似度排序）。run via `nx test server <file>`
- [X] T014 [US2] [Server] **FallbackChainAdapter + search UC + 端点（EP1）+ 契约**：`fallback-chain.adapter.ts`（`<T>` 包裹 `[primary,...secondaries]`，主源 503/超时/配额耗尽 → 退避 → 平移次源）+ `marketdata.module.ts` SEARCH 端口工厂绑 `FallbackChainAdapter([EastmoneySearchAdapter, LocalInstrumentSearchAdapter])` + `search-instruments.usecase.ts` + `instrument-search.response.ts` + `marketdata.controller.ts` 加 EP1 `GET search`（swagger 200/400/401/429，缺 `q` → 400）+ `nx run server:export-openapi` → `nx affected -t generate`（EP1 regen）→ verify（Testcontainers PG seed）: 主命中归一化 / 主 503 平移本地 / 双空返空 items 三分支（SC-S02，spec state_branch「search primary-hit」「search fallback」「search both-empty」）。run via `nx test server <file>`
- [X] T015 [Verify] **全绿门 + catalog**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（`--skip-nx-cache` 首跑）+ `server-bounded-context-catalog.md` § Operation Catalog 新增 4 行（`search-instruments`/`get-quotes`/`get-instrument-detail`/`get-instrument-bars`，context=marketdata，propagation=intra）+ marketdata 加入 context 清单 + boundaries 0 违规 + `check-server-moat.ts` 关 + 4 perf 端点 env-gated perf IT（`RUN_PERF_IT`）本地抽验

---

## Follow-up（后续 PR，非本批；登记于 2026-06-03）

- [X] T016 [Contract-Smoke] **015 专属契约冒烟 `apps/mobile/e2e/contract-smoke/marketdata.contract.ts`**（node 层打 testcontainers 真 server，注册进 `e2e/contract-smoke/run.ts` 的 `SPECS`，`nx run mobile:contract-smoke`）：**负责种 marketdata**（`instrument` + `dailyBar`×N + `fundamentalSnapshot` + `financialMetric`，镜像 `marketdata.read-quote.it.spec.ts` seed 体例）→ 用生成的 `@nvy/api-client` 打 **EP3 详情**（断 `valuation`/`financials`/`corporateActions` 字段 + 52 周高低）+ **EP4 bars**（断 `period`/`adjust` 切换序列）+ EP1 search / EP2 quote → 验真落库 + 契约对齐 → cleanup 保 boot 内幂等。**前置（已免）**：原计划需 harness `RealBackendCtx` 暴露 `databaseUrl` 供种库；实现时发现 021 已加 `ctx.execSql()` 可直插事实表（schema=marketdata，无公开写端点），故复用，无需新增 harness 能力。**缘起**：014 contract-smoke 收尾时（[014 tasks.md T016](../014-stock-detail/tasks.md)）按 ADR-0048「014 server 零 marketdata 耦合」边界，把 015 EP3/EP4 断言从 014 spec 移除，归位到本 feature 自己的 contract-smoke——015 是 detail/bars 数据正确性的真正 owner。

---

## Dependencies & 执行顺序

```
PR1（T001–T004）骨架 ──┬─→ PR2（T005–T011）vendor+读端点 ──→ PR3（T012–T015）search+fallback
  T001 schema ─┐        │     T005 VendorHttpClient ─→ T006 Lixinger ─┐         T012 东财 ─┐
  T002 moat  ──┼─→ T003 端口/config/Mock ─→ T004 boot-IT              ├─→ T007 quote ─→ T009 EP2     ├→ T013 本地 ─→ T014 FallbackChain+EP1 ─→ T015 Verify
               │                                                       └─→ T008 EP3/EP4 ─→ T010 IT ─→ T011 Contract
```

- **PR1 阻塞 PR2/PR3**（端口接口 + config + Mock + schema 是一切基础）。
- **PR2 内**：T005（VendorHttpClient）阻塞 T006（Lixinger adapter 经它）；T006/T007 阻塞 T008（详情聚合 fundamental/财报）；T007 阻塞 T009（quote 端点）；T008/T009 阻塞 T010（读侧 IT）→ T011（contract）。
- **PR3 内**：T012/T013 阻塞 T014（FallbackChain 包裹两者）。
- **[P] 并行**：T002 与 T001 可并行（不同文件）；T012 与 T013 可并行（东财 vs 本地，不同 adapter）。

## US → task 覆盖矩阵（spec 验收回溯）

| US | spec story | tasks |
| --- | --- | --- |
| US1 | 8 端口骨架 + Mock 默认 | T003, T004 |
| US2 | 搜索 FallbackChain | T012, T013, T014 |
| US3 | 详情 + K线 | T006, T008, T010 |
| US4 | EOD-backed 报价 | T007, T009, T010 |
| US5 | Vendor 约束统一执行 | T005 |
| US6 | universe/calendar/fsType 能力面 | T003（端口接口+Mock）, T006（fsType 路由）；**live universe/calendar adapter → 016**（D2=A） |

## Implementation Strategy（MVP first）

1. **MVP = PR1**（T001–T004）：schema + 8 端口可插拔骨架 + Mock。模块 boot + Mock 端到端绿即可独立 ship/验收——access layer 抽象立住。
2. **PR2** 接真理杏仁事实源 + 读端点（详情/K线/报价），读侧可用（seed/真数据）。
3. **PR3** 补搜索（东财 live + 本地备 + FallbackChain），4 读端点全通。
4. **016 同步 feature** 接 universe/calendar live + 全量灌库 + 分级 + 调度（本 feature out of scope）。
5. **013/014 回写**（015 落地后，per plan §Phase 2 follow-up）：014 detail/bars server 段迁 015、013 行情/搜索走 015 端点。

---

**Tasks Version**: 1.0.0 | **Created**: 2026-06-02 | **总计 15 task**（PR1 4 / PR2 7 / PR3 4）| **层分布**: [Server] 10 / [Server-IT] 3 / [Contract] 1 / [Verify] 1
