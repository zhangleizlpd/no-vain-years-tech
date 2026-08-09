---
feature_id: 015-marketdata-access-layer
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-02'
updated_at: '2026-06-02'
adr_refs: ['0019', '0022', '0024', '0032', '0035', '0038', '0041', '0043', '0047']
context7_verified: []
---

# Implementation Plan: 015-marketdata-access-layer（Marketdata 可插拔数据访问层 — schema + 8 capability 端口 + 多 vendor adapter + 读侧 API）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `015-marketdata-access-layer` | **设计源**: [Master](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-master.md) + [子 plan 1 访问层](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p1-access-layer.md) + [ADR-0047](../../docs/adr/0047-marketdata-pluggable-data-access.md)

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011/012 形态）。
> **纯 server 数据层流程**：spec ✅ → clarify ✅ → **plan（本）** → tasks → analyze → implement。**无 mockup / 无 mobile 段**（读端点的 mobile 消费归 013/014）。验证全走 Testcontainers IT + env-gated 真 vendor IT。

## Summary _(mandatory)_

015 = **marketdata 第 5 个 bounded context bootstrap**（与 auth/account/security/portfolio 平级，per ADR-0032 Q4）+ **可插拔股票数据访问层**（ADR-0047 落地）。交付：① **6 张事实/注册表** Prisma schema（Instrument/DailyBar/FundamentalSnapshot/FinancialMetric/CorporateAction/TradingDay；同步配置/审计 3 表 DDL 推迟 016，per clarify）+ migration（含 `CREATE EXTENSION pg_trgm` + Instrument GIN trgm）。② **8 capability-scoped 端口**（`Symbol + interface`）+ 每端口 config-driven DI 工厂（镜像 `SMS_GATEWAY`）+ 全套 **Mock adapter**（零 env 默认）。③ **共享 `VendorHttpClient` + Vendor Constraint Profile**（双窗限频 + 必需 header + Cockatiel 退避重试 + 瞬时等待）。④ **Live adapter**：理杏仁 4（EOD/估值/财报/公司行动）+ 东财 search + 本地 pg_trgm search + `FallbackChainAdapter` + `EodBackedQuoteAdapter` + 符号归一化。⑤ **4 读端点**（搜索/报价/详情/K线，JWT-authed）+ OpenAPI + `@nvy/api-client` regen。

**范式** = ADR-0043 扁平贫血 + 单向 Moat + ADR-0047 可插拔访问层（端口先于来源）。**out of scope（→ 016 同步 feature）**：夜间全量同步管线 / 配置化驱动 / 重要度分级 / 调度 / 规模归档 + UNIVERSE/TRADING_CALENDAR 的 **live** adapter（见 § Open Decisions D2）。

**bounded context（per [catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 决策问题，见 § Architecture Notes）**：**marketdata** 自持 6 张事实表（贫血 row + `marketdata.rules.ts` / `*-symbol.rules.ts` 纯函数）。**零跨 ctx 业务调用**（marketdata 是叶子，被 portfolio 反向消费属 016+ 后续；本 feature 不读任何他 ctx 表）——唯一跨 module 依赖 = `JwtAuthGuard` + `AccountIdThrottlerGuard`（`AccountModule` export 的 account-bound 鉴权 artefact，非业务 use case 调用，无 R2/R3 注释要求）。读端点仅逻辑引用 `accountId`（JWT sub）做限流 tracker，**不读写 account 表**。

## API Contracts _(mandatory)_

| #   | Method | Path | Auth | Request | Response | trace FR |
| --- | ------ | ---- | ---- | ------- | -------- | -------- |
| EP1 | GET | `/api/v1/marketdata/search` | bearer | query `q`（非空，名/拼音/代码） | **200** `InstrumentSearchResponse{items[]}` / 401 / 429 | FR-S04, FR-S10, FR-S13 |
| EP2 | GET | `/api/v1/marketdata/quote` | bearer | query `symbols`（逗号分隔 canonical `market:code`） | **200** `QuoteListResponse{quotes[]}`（每项含 asOf/priceKind/no-data flag） / 400 / 401 / 429 | FR-S07, FR-S08, FR-S13 |
| EP3 | GET | `/api/v1/marketdata/instruments/{symbol}` | bearer | path `symbol`（canonical） | **200** `InstrumentDetailResponse`（报价 header + 公司聚合，覆盖 014 详情字段集） / 401 / 404 / 429 | FR-S05, FR-S08, FR-S11, FR-S13 |
| EP4 | GET | `/api/v1/marketdata/instruments/{symbol}/bars` | bearer | path `symbol` + query `period`(day\|week\|month\|quarter\|year, 缺省 day) + `adjust`(none\|forward\|backward, 缺省 none) + `from`/`to`(可选) | **200** `DailyBarListResponse{bars[]}` / 400 / 401 / 404 / 429 | FR-S06, FR-S08, FR-S13 |

- **Decimal-string 序列化（FR-S08）**：响应所有价格/比率/市值字段 = **string**（`@ApiProperty({ type: 'string' })` 显式标注 —— 否则 nullable Decimal 联合被 orval 误生成 `{[k]:unknown}|null`，per memory `nullable_apiproperty_needs_type_string`）。
- **新鲜度标注（EP2，服务 013 自选行）**：`QuoteItem = { symbol, price?, change?, changePct?, asOf?, priceKind: 'eod_close', hasData: boolean }`；批量 `symbols`；无 EOD 数据项 `hasData:false`、price/asOf 缺省（不污染同批其余项，FR-S07）。013 watchlist mobile 拿 items 后调本端点批量取 quote、渲染层 merge（涨红跌绿）。
- **详情字段集（EP3，服务 014 详情页阶段一）**：`InstrumentDetailResponse` 聚合 ① 报价 header（最新=最近 close / 涨跌 / 涨跌幅 / 昨收 prevClose）② 估值（PE TTM/static/dynamic、PB、PS、股息率、总市值、流通市值）③ 分位（PE/PB y3/y5 cvpos）④ 财务（ROE/毛利率/EPS/BPS 最近报告期）⑤ 公司行动列表 ⑥ 身份（name/type/currency from Instrument）+ **52 周高低**（DailyBar 近 252 交易日 max/min close 计算，`marketdata.rules.ts` 纯函数）。缺失维度字段 null（不报错，014 US1 case②）。**阶段一仅 EOD 可算字段，盘中独有字段不出现**（实时源接入由 QuotePort 透明补，014 两阶段边界）。
- **K线聚合（EP4，服务 014 图表 Tab）**：`period=day` 直返 DailyBar；`week/month/quarter/year` 由日线**服务端聚合**（OHLC 取区间首开/最高/最低/末收 + 量求和，`marketdata.rules.ts` 纯函数）；`adjust` 复权口径；区间无数据 → 空 bars（200，014 US2 case④）。
- **错误**一律 RFC 9457 ProblemDetail（复用全局 filter，per [ADR-0038](../../docs/adr/0038-error-handling-ux-contract.md)）：`MARKETDATA_INSTRUMENT_NOT_FOUND`（404，EP3/EP4 未知 symbol）；非法 `adjust` / 缺 `q` / 缺 `symbols` → 复用既有 `FORM_VALIDATION`（400）；401 沿用 `JwtAuthGuard`（反枚举不区分原因）；429 + `Retry-After`（throttler）。
- 路径前缀 `api`（全局 setGlobalPrefix）。端点路径为 spec 提案，OpenAPI code-first（swagger 装饰器）contract 阶段定稿。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md` v1.2.1） | 状态 | 备注 |
| ------------------------------------------------ | ---- | ---- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅ → plan（本）→ tasks → analyze → implement；plan→tasks 人工卡点 |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 每 impl task 红→绿→typecheck/lint→`[X]`→commit；12 条 state_branches 各有 IT；vendor 契约走 mock 单测 + env-gated 真 IT（`RUN_MARKETDATA_IT` 范式，沿 `RUN_PERF_IT`）；NestJS lifecycle 组件（guard/filter）走 `createTestingModule` 集成测，禁隔离 mock |
| III. Atomic 30min-2h + 独立 commit | ✅ | tasks.md 按 p1 §A.6 6 步落地序拆；多 server PR（见 § Phase 2 PR 策略） |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 新 `marketdata` 第 5 ctx；单向 `marketdata → {security, account}`（仅 PrismaService + guard 复用）；marketdata 内零 `prisma.<otherTable>.*`（仅 `prisma.instrument/dailyBar/...`）；无 R2/R3（叶子，零跨 ctx 业务调用）；`check-server-moat.ts` 关（须先登记 6 model owner + BUSINESS_CTX 加 marketdata，见 § Cross-cutting） |
| V. 类型同步链 Nx-driven | ✅ | **纯 server → 单/多 server PR**（无 mobile 段）；server swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval）→ `@nvy/api-client` typed（mobile 暂不消费，供 013/014，沿 005/011 regen-ships-with-server 先例） |

## Architecture Notes _(mandatory)_

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7 questions，逐条）

| Q | 问题 | 判定 |
| --- | ---- | ---- |
| Q1 | 直改 account/credential/portfolio 核心表 row state？ | **No** — marketdata 6 表全新，仅逻辑引用（无跨 schema FK）；不写他 ctx 表 |
| Q2 | 编排多 context user-facing 流程？ | **No** — 单一领域（市场数据访问），accountId 仅做限流 tracker（经 guard），无跨 ctx 编排 |
| Q3 | 纯 platform infra（token/pwd/generic crypto）？ | **No** — 业务领域（股票市场数据：universe/EOD/估值/财报/公司行动/报价），非 platform |
| Q4 | 完全新业务领域，4 现 ctx 都不沾？ | **YES → STOP，新 bounded context** `marketdata`（第 5 个，与 auth/account/security/portfolio 平级） |
| Q5-Q7 | 跨 ctx call 传播？ | **N/A** — marketdata 是**叶子**，本 feature 零跨 ctx 业务调用。portfolio→marketdata 的反向只读消费属 016+ 后续（届时走 marketdata export 的 read use case + R2/Q7 注释，本 feature 不引入）。guard 复用 = account-bound 鉴权 artefact（`AccountModule` export），非 use case 调用，不触发 R2/R3 |

**ADR-0032 sunset trigger 评估**：marketdata 是独立于「用户业务域 portfolio」的「外部市场数据基础设施域」——master §0 四轮调研钉死其独立性（多 vendor 可靠性分层 / 限频约束 / universe 枚举 / 全量同步地基），被 portfolio（自选/详情/预警）+ 未来策略实验室共同消费。立第 5 个 top-level bounded context 是正确粒度（**非 over-split**：市场数据访问独立于用户 portfolio 偏好/持仓；**非 over-merge**：塞进 portfolio 会让 portfolio 同时承载用户态 + 全市场数据双职责）。后续 marketdata 内若 >30 模块或 >50K LOC 再评 sub-context 拆分。

### marketdata module 落位（per catalog，ship 时新增 Operation 行）

| 操作 | context | 类型 | 跨 ctx | 备注 |
| ---- | ------- | ---- | ------ | ---- |
| `search-instruments` | **marketdata** | intra query UC | — | authed；经 `INSTRUMENT_SEARCH_PORT`（东财主 + 本地 pg_trgm 备，FallbackChain）|
| `get-quotes` | **marketdata** | intra query UC | — | authed；经 `QUOTE_PORT`（EodBacked）；Redis 热快照 → PG |
| `get-instrument-detail` | **marketdata** | intra query UC | — | authed；聚合 `prisma.{instrument,dailyBar,fundamentalSnapshot,financialMetric,corporateAction}`（R1 自己的表）|
| `get-instrument-bars` | **marketdata** | intra query UC | — | authed；`prisma.dailyBar`（adjust 过滤）|

> **8 端口 vs 4 操作**：端口是内部能力抽象（消费者依赖 `Symbol+interface`）；对外 user-facing 操作 = 4 读 UC。`UNIVERSE`/`TRADING_CALENDAR` 端口本 feature **只落接口 + Mock**（无读端点消费，live adapter 归 016，见 D2）。

### 消费模型（013/014 → 015，零跨 ctx 耦合）+ 回写计划（user 定 2026-06-02 = 方案 ①）

**决策**：marketdata 自有 `/api/v1/marketdata/*` HTTP 端点（EP1-4）；013/014 **mobile 直调** marketdata 端点取市场数据 + 调 portfolio 端点取自选态，**渲染层 client-side merge**。marketdata 与 portfolio **运行时零跨 ctx 调用**（只共享 `market:code` 逻辑业务键），各自端点独立缓存（市场数据 TTL 至 EOD / 自选态随 toggle 变）。

**为何方案 ①**（拒 portfolio 服务端聚合）：① 零跨 ctx 耦合最贴合数据护城河（catalog「独立只读查询禁 cross-ctx use case 直 DI」）；② marketdata 成自洽可独立 ship/HTTP 冒烟的访问层；③ 独立缓存契合两类数据生命周期；④ 详情页 3 个并行请求成本可忽略。

**013/014 现 spec 端点归属订正**（**回写推迟到 015 落地后**，per user「后边回写」；013/014 均 `draft` 状态，纯 spec 改低风险）：

| 现 013/014 声明 | 数据本质 | 订正后归属 |
| --- | --- | --- |
| 014 `…/instruments/{m}/{code}/detail`（报价+公司）| 纯 marketdata | **迁 015 = EP3**；014 `[Server]` US1 整体移除 |
| 014 `…/instruments/{m}/{code}/bars` | 纯 marketdata | **迁 015 = EP4**；014 `[Server]` US2 整体移除 |
| 013 watchlist 行「行情注入」| 纯 marketdata | client 调 015 EP2 `/quote` merge |
| 013 加自选 mini 搜索 | 纯 marketdata | client 调 015 EP1 `/search` |
| 013 watchlist-groups/item CRUD、014 `…/watchlist-status` | 用户自选态 | **portfolio 保留** |

→ 回写后 **014 退化为纯 mobile feature**（UI: tab/K线/报价 header，消费 015 EP3/EP4 + portfolio watchlist-status）；**013 server 段仅 watchlist CRUD**，行情/搜索走 015 端点。两者 frontmatter 依赖改指 `015-marketdata-access-layer`。回写清单见 § Phase 2「013/014 回写 follow-up」。

### 可插拔访问层设计（ADR-0047 落地，镜像 `SMS_GATEWAY`）

**1. 8 端口**（`apps/server/src/marketdata/*.port.ts`，canonical `${market}:${code}`）：

| Port（Symbol） | 能力 | 本 feature adapter |
| --- | --- | --- |
| `INSTRUMENT_SEARCH_PORT` | 模糊搜名/拼音/代码 | `FallbackChainAdapter([EastmoneySearchAdapter, LocalInstrumentSearchAdapter])` + Mock |
| `EOD_BAR_PORT` | EOD 日线（含复权） | `LixingerEodBarAdapter` + Mock |
| `FUNDAMENTAL_PORT` | 估值 + cvpos 分位 | `LixingerFundamentalAdapter`（内部 fsType 路由）+ Mock |
| `FINANCIALS_PORT` | 财报衍生 | `LixingerFinancialsAdapter` + Mock |
| `CORPORATE_ACTION_PORT` | 分红/拆股/配股 | `LixingerCorporateActionAdapter` + Mock |
| `QUOTE_PORT` | 最新价（涨跌） | `EodBackedQuoteAdapter`（消费 `EOD_BAR_PORT`）+ Mock |
| `INSTRUMENT_UNIVERSE_PORT` | 枚举全 A 股 | **仅接口 + Mock**（live `EastmoneyUniverseAdapter` → 016）|
| `TRADING_CALENDAR_PORT` | 交易日历 | **仅接口 + Mock**（live adapter → 016，vendor 见 D1）|

**2. config**（`config/marketdata.config.ts`，zod discriminated-union，镜像 [`sms.config.ts`](../../apps/server/src/config/sms.config.ts)）：`kind: 'mock' | 'live'`；`live` 时 `LIXINGER_TOKEN` 必填（`.min(1)` boot fail-fast）、东财 baseUrl 有默认；`registerAs('marketdata', …)`。`MarketdataModule` 每端口一个 `useFactory` DI 工厂按 `kind` 选 adapter。

**3. `VendorHttpClient` + Vendor Constraint Profile**（一等公民，因「多数外部源都有约束」）：每 adapter 声明 `{ requiredHeaders, rateLimit:{perMin, perSec}, retry:{maxAttempts, backoff}, transientWait }`；共享 `vendor-http-client.ts` 统一执行——注入必需 header + 过**双窗令牌桶限频器**（分窗 + 秒窗，任一超即排队 await，**不向 caller 抛 429**）+ 用 **`cockatiel` 库**（npm 弹性库，已是 repo dep）自配退避+熔断 policy + 429/瞬时故障 `transientWait` 等待。⚠️ **直 `import { retry, circuitBreaker, … } from 'cockatiel'` 自写 ~15 行 wrapper，禁 DI `auth/cockatiel-retry.executor.ts`**——marketdata 叶子不依赖 auth（ESLint boundaries 拦跨 module，库 import 不受限），且 vendor policy（双窗+`transientWait`）与 auth 的 SMS 策略不同、本就需独立配置（C1 修，analyze 2026-06-02）。
  - 理杏仁 profile = `{ perMin:1000, perSec:36, headers:{'Content-Type':'application/json','Accept-Encoding':'gzip'}, retry:{maxAttempts:3, backoff:'exponential'}, transientWait:'≥60s' }`（对齐其分钟级自检，master F4/F7）。
  - 东财 profile = `{ perSec: 逆向保守, headers:{UA, Referer}, retry:3 }`（无 SLA，FallbackChain 兜底）。

**4. FallbackChainAdapter<T>**：包裹 `[primary, ...secondaries]`，主源 503/超时/配额耗尽 → 退避 → 平移次源；搜索 V1 = 两节点（东财 → 本地 pg_trgm）。

**5. 符号归一化**：每 adapter `*-symbol.rules.ts` 纯函数 canonical `market:code` ↔ vendor symbol（Lixinger stockCode / 东财 secid `1.600519`），双向无损（property/round-trip 测）；未知市场前缀明确拒绝。

**6. fsType 内部路由（FR-S11）**：`LixingerFundamentalAdapter` 内部调 `cn/company` 解析公司类型（non_financial/bank/security/insurance/other_financial）→ 路由对应 fundamental 端点 → 缓存到 `Instrument.lixingerCompanyType`；端口对外签名 `getFundamentals(symbols)` 不暴露 fsType。

### Server side（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md) 扁平贫血，文件平铺于 `apps/server/src/marketdata/`）

**新增（marketdata 新 module）**：

- `marketdata.module.ts`：`imports:[SecurityModule, AccountModule]`（前者给 PrismaService + 全局 ProblemDetailFilter + JwtModule + Redis client；后者 export `JwtAuthGuard` + `AccountIdThrottlerGuard`）；`controllers:[MarketdataController]`；`providers:[…4 read UC, 8 port DI 工厂, VendorHttpClient, …adapters, EodBackedQuoteAdapter, FallbackChainAdapter]`（镜像 [`portfolio.module.ts`](../../apps/server/src/portfolio/portfolio.module.ts)）
- `marketdata.controller.ts`（`@Controller('v1/marketdata')`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`）：EP1-4 + named throttler config（`@Throttle` 自己 + `@SkipThrottle` 其余全部桶）+ swagger（200/400/401/404/429）
- 4 读 UC（intra query）：`search-instruments.usecase.ts` / `get-quotes.usecase.ts` / `get-instrument-detail.usecase.ts` / `get-instrument-bars.usecase.ts`（直注端口 Symbol + PrismaService + Redis client）
- 8 `*.port.ts`（Symbol + interface）；adapters：`lixinger-{eod-bar,fundamental,financials,corporate-action}.adapter.ts`（4）+ `eastmoney-search.adapter.ts` + `local-instrument-search.adapter.ts`（pg_trgm + 拼音）+ `eod-backed-quote.adapter.ts` + `fallback-chain.adapter.ts` + `mock-market-data.adapter.ts`（8 端口全覆盖，零 env 默认）
- `vendor-http-client.ts` + `*.constraint-profile.ts`（Lixinger/东财）+ 双窗令牌桶限频器
- `*-symbol.rules.ts`（Lixinger/东财 各一）+ `marketdata.rules.ts`（前收算涨跌 / asOf 投影 / Decimal-string 等纯函数）
- 响应 DTO：`instrument-search.response.ts` / `quote-list.response.ts` / `instrument-detail.response.ts` / `daily-bar-list.response.ts`（swagger 装饰器，Decimal 字段显式 `type:'string'`）
- `instrument-not-found.exception.ts`（404，镜像现有 exception 范式）

**修改既有（platform / cross-cutting）**：

- `apps/server/prisma/schema.prisma`：`datasource db.schemas` 加 `"marketdata"`；6 新 model（见 § Prisma schema）
- 新 migration `<yyyymmddhhmm>_add_marketdata_access_layer`（**expand-only**：create schema + 6 表 + 索引 + `CREATE EXTENSION IF NOT EXISTS pg_trgm` + Instrument `pinyin_abbr` GIN trgm raw SQL → 非破坏单 PR 合规，per [ADR-0035](../../docs/adr/0035-data-layer-governance.md)）
- `apps/server/src/security/throttler-skip-buckets.ts`：加 `MARKETDATA_BUCKETS`（4 读端点桶，tracker = JWT sub）+ `MARKETDATA_ALL`
- `apps/server/src/auth/auth.module.ts`（全局 ThrottlerModule 注册处）：加 marketdata 4 named throttler
- **所有既有 controller**（account/portfolio/auth/...）：`@SkipThrottle` 列表 spread `...MARKETDATA_ALL`（throttler 反污染纪律，沿 011/012 同款成本）
- `apps/server/src/app/app.module.ts`：`imports` 加 `MarketdataModule`
- `apps/server/eslint.config.mjs`：`boundaries/elements` 加 `{ type:'marketdata', pattern:'src/marketdata/**' }`；`boundaries/dependencies` 加 marketdata 仅许依赖 `security`/`account`（叶子，不依赖 auth/portfolio）+ 其余 ctx 禁依赖 marketdata（本 feature 无消费者）
- [`scripts/checks/check-server-moat.ts`](../../scripts/checks/check-server-moat.ts)：`MODEL_OWNERSHIP` 加 6 行（`instrument/dailyBar/fundamentalSnapshot/financialMetric/corporateAction/tradingDay` → `'marketdata'`，**否则探针 `moat-unmapped` 硬拒**）+ `BUSINESS_CTX` 加 `'marketdata'`（当前 = `{auth, account, portfolio}`，per 文件约定「新 bounded context 同步加入」）

### Prisma schema（6 张事实/注册表 — 配置/审计 3 表 DDL 推迟 016，per clarify 2026-06-02）

> 字段定义源 = [子 plan 1 §A.2](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p1-access-layer.md)。camelCase + `@map` snake_case + `@@schema("marketdata")`；逻辑 `instrumentId` 无跨 schema FK（沿用 BrokerAccount/refresh_token 范式）；价格/比率全 `Decimal` 禁 Float。

- `model Instrument`（universe 注册表，全量 A 股）：`(market, code)` 唯一；`pinyinAbbr`/`pinyinFull`（本地搜索备援）；`lixingerCompanyType`（fsType 缓存）；`syncTier`（默认 2，**016 重算**，本 feature 仅建列不消费）；GIN trgm index on `pinyin_abbr`（migration raw）。
- `model DailyBar`（EOD 事实，三复权各一行）：**唯一键 `(instrumentId, tradeDate, adjust)`**（修正 PRD 原 `(instrumentId, date)`）；`open/high/low/close/prevClose Decimal(18,4)`；`(instrumentId, tradeDate desc)` 索引。
- `model FundamentalSnapshot`（日频估值+分位）：`(instrumentId, date)` 唯一；pe/pb/ps/分位全 Decimal。
- `model FinancialMetric`（财报衍生）：`(instrumentId, reportPeriod)` 唯一。
- `model CorporateAction`（公司行动）：`(instrumentId, exDate, type)` 唯一；`payload Json`。
- `model TradingDay`（交易日历）：`(market, date)` 唯一。

> ⚠️ **SyncDimension / SyncBlacklist / SyncRun 不在本 migration**（clarify 定）——其 DDL + datasource schema 内的 model 块整体归 016。本 feature `datasource.schemas` 仅需 `marketdata` 已建（016 不再重建 schema，仅 add tables）。

### 读路径设计

1. **搜索（EP1）**：`SEARCH_PORT` → `FallbackChain([东财, 本地 pg_trgm])`；东财 live MultiMatch（A/HK/US）→ 归一化 canonical；东财 503/超时 → 平移 `LocalInstrumentSearchAdapter`（`pg_trgm` similarity on name + `pinyin_abbr`，需 Instrument 已 seed）；双空 → 空 items（200）。
2. **报价（EP2）**：`QUOTE_PORT(EodBacked)` → 读路径 `Redis 热快照（key=quote:{symbol}，TTL 至下次 EOD）→ miss 回 PG 最近 DailyBar`；`marketdata.rules.ts` 前收算 change/changePct；asOf=tradeDate，priceKind=`eod_close`；无 DailyBar → `hasData:false`。
3. **详情（EP3）**：聚合 `prisma` 5 表（最近 DailyBar + 最近 FundamentalSnapshot + 最近 FinancialMetric + CorporateAction 列表）；未知 symbol → 404。
4. **K线（EP4）**：`prisma.dailyBar.findMany({ where:{instrumentId, adjust, tradeDate∈[from,to]}, orderBy:tradeDate })`；非法 adjust → 400。
- **Decimal 跨边界**：DTO 层 `.toString()`（rules 纯函数统一），response 字段 `@ApiProperty({type:'string'})`。

### 限流配置（FR-S13，复用 throttler infra + AccountIdThrottlerGuard）

| 端点 | per-account | named bucket |
| ---- | ----------- | ------------ |
| search | `60/60s` | `mktdata-search-account` |
| quote | `120/60s` | `mktdata-quote-account`（自选轮询，调高）|
| instrument-detail | `60/60s` | `mktdata-detail-account` |
| instrument-bars | `60/60s` | `mktdata-bars-account` |

4 端点 authed（accountId 取 JWT sub）→ 复用 `AccountIdThrottlerGuard`，无 public IP 桶。`@SkipThrottle` 其余全部桶防污染。← 阈值 tasks gate review。

### Dependencies & Vendor Assessment（Cargo-cult 防火墙 + Vendor 6Q，本 feature 引入外部集成故必填）

**新依赖**（每条需 fact-check 锚点，per template Dependencies 防火墙）：

| 依赖 | 目的 | Fact-check 锚点（impl 前 context7 grounding）|
| ---- | ---- | ---- |
| `pinyin-pro`（候选） | Instrument 拼音 abbr/full 生成（本地搜索备援 `pinyinAbbr`/`pinyinFull` 填充）| ⚠️ impl 前 context7 验当前版本 API + CN 可用；若过重可换轻量方案/查表 |
| 双窗限频器 | per-vendor 分窗+秒窗令牌桶 | **优先自写纯函数**（≤100 行，无新 dep）或复用 `cockatiel` bulkhead/rate-limit 能力 → impl 前验 cockatiel 是否原生支持双窗，否则自写 |
| HTTP/gzip | vendor 请求 + `Accept-Encoding: gzip` | **Node 内置 `undici`/`fetch` + zlib**，无新 dep（验证 NestJS 11/Node 22 fetch 全局可用）|

> 无确定新增 dep 的项标 "自写/复用，N/A"。**禁无锚点 cargo-cult**（per ADR-0040 Pattern F）；最终 dep 决策落 tasks gate（D3）。

**Vendor 6Q（东财 / 理杏仁 — HTTP API 非 npm，逆向/付费风险）**：

| # | Q | 东财 | 理杏仁 |
| --- | --- | --- | --- |
| Q1 | 长期维护信号 | 大厂免费端点，无 SLA / 可能改版 | 已付费商业 API，可靠主源 |
| Q2 | 已装工具可替代？ | 否（理杏仁无搜索/universe，master F2）| 否（东财无可靠 EOD/财报）|
| Q3 | 栈兼容 | 纯 HTTP（fetch），无 SDK 耦合 | 纯 HTTP，token 鉴权 |
| Q4 | LLM 训练覆盖 | 低（逆向端点）→ master §0 钉死请求形态 | 中 → 真实请求验证 fsType/字段 |
| Q5 | 解耦成本 | 低（port 抽象，换源只改 adapter）| 低（同）|
| Q6 | 风险面 | 逆向 ToS / 无 SLA → FallbackChain + 限频缓释 | 双窗限频 429 封号 → Constraint Profile 严格执行 |

→ 风险通过 **ADR-0047 端口抽象 + FallbackChain + Constraint Profile** 系统性缓释（换 vendor 只改 adapter，限频/header 由共享传输层强制）。

### Cross-cutting

- **同步链**（Constitution V）：server controller/DTO/swagger → `nx run server:export-openapi` → `nx affected -t generate`（orval regen marketdata 端点 hook）→ `@nvy/api-client` typed（mobile 暂不消费，供 013/014）。
- **catalog 更新**：ship 时 `server-bounded-context-catalog.md` § Operation Catalog 新增 4 行（4 读 UC，context=marketdata，propagation=intra）+ marketdata 加入 context 清单。
- **moat 登记前置**：先在 `check-server-moat.ts` `MODEL_OWNERSHIP` 登记 6 model + `BUSINESS_CTX` 加 marketdata，**否则 marketdata 读自己的表即 `moat-unmapped` 红**（探针 defense-in-depth）。
- **跨 ctx 注释**：marketdata 叶子无 R2/R3 业务调用 → 无 `// CROSS-CONTEXT-SYNC/ASYNC` 注释；guard 经 `AccountModule` export 复用（account-bound 鉴权 artefact，非业务调用，无注释）。
- **反枚举不变性**：读端点未认证/非 ACTIVE → 统一 401（JwtAuthGuard，与 /me 一致路径）。
- **本地 IT 前置**：`env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL`（compose dev :5433/:6380）+ `nx test server <file>`（cwd=apps/server，Testcontainers，禁 `vitest --root`，per memory）。
- **env-gated 真 vendor IT**：`RUN_MARKETDATA_IT` + `LIXINGER_TOKEN`/东财 默认 skip（沿 `RUN_PERF_IT` 范式 `describe.skipIf`），本地/nightly 显式启用。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
| --- | ---- | ---- | ----- |
| **D1** | TRADING_CALENDAR vendor（东财 vs Lixinger，spec deferred）| 端口 + Mock 落 015；**live adapter 推迟 016**（无读端点消费）。016 选源建议 **Lixinger trade-day**（已付费可靠，与 EOD 同源减一个逆向面）← 016 定 | ⚠️ |
| **D2** | UNIVERSE/CALENDAR live adapter 落哪 feature | **user 定 2026-06-02 = A**：仅接口 + Mock 入 015（完成端口抽象 + 模块 boot 一致）；**live `EastmoneyUniverseAdapter` + calendar adapter 入 016**（其唯一消费者 = 同步管线；015 不建无消费者的 speculative live adapter，过 YAGNI test）| ✅ |
| **D3** | 新 npm dep（pinyin / 限频器 / http）| impl 前 context7 grounding 逐条验（见 § Dependencies）；限频器/http 优先自写/内置零新 dep；pinyin 验 `pinyin-pro` 后定 | ⚠️ |
| **D4** | 双窗限频器实现 | **自写纯函数令牌桶**（分窗+秒窗，≤100 行）或复用 cockatiel；impl 前验 cockatiel 双窗能力 | ⚠️ |
| **D5** | 015 PR 切分粒度 | **user 定 2026-06-02 = 3 段**：PR1 骨架（schema+8 端口+config+Mock）/ PR2 vendor 传输+Lixinger 事实源+读端点（EP1-4 除 search）/ PR3 东财 search+本地备+FallbackChain（接通 EP1 search）| ✅ |
| **D6** | Redis 热快照 key/TTL | `quote:{market:code}`，TTL 至下次 EOD（保守至次日 08:00）；惊群用 jittered TTL ±10% | — |
| **D7** | adjust 缺省值 | `none`（不复权原始价）；前端 K 线默认请求 `forward`（前复权），由消费方显式传 | — |
| **D8** | search V1 是否 wire 东财 live | **是**：015 ship 东财 search live adapter（读端点唯一 live 验证面）+ 本地 pg_trgm 备；真东财 IT env-gated | — |
| **Perf** | 4 端点 P95/P99 | spec frontmatter SoT（见 § Performance Budget）| — |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Senior-engineer test（本 feature 内禀复杂，逐项 justify 非 over-engineering）**：
1. **第 5 bounded context** = Q4 正确粒度（外部市场数据域独立于用户 portfolio 域，master §0 调研支撑），非 over-split。
2. **8 端口抽象** = ADR-0047 核心（「多源 + 各有约束」是真实约束面，master F1-F9 钉死）；非投机——4 读端点直接消费 6 端口，universe/calendar 2 端口仅留接口+Mock（live 推迟，D2）规避 YAGNI。
3. **VendorHttpClient + Constraint Profile** = 把「双窗限频 + 必需 header + 退避」收敛到一处（否则每 adapter 重写传输层 = 更多代码）；理杏仁双窗 429 封号是硬约束非镀金。
4. **FallbackChain** = 东财无 SLA 的真实降级需求（master Q6 风险），两节点最小实现。
5. **out-of-scope 严格切分**（同步/分级/调度/规模 + universe/calendar live → 016）= 控制本 feature 体量，访问层先 ship 可独立验收。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| -------- | -------: | -------: |
| `GET /api/v1/marketdata/search` | 300 | 600 |
| `GET /api/v1/marketdata/quote` | 120 | 250 |
| `GET /api/v1/marketdata/instruments/{symbol}` | 150 | 300 |
| `GET /api/v1/marketdata/instruments/{symbol}/bars` | 200 | 400 |

_perf 预算 SoT = spec.md frontmatter `perf_budgets`。search 含东财外呼故宽松；quote 走 Redis 热快照命中应远低于预算；detail/bars 走 PG 索引扫描。env-gated perf IT（`RUN_PERF_IT`）本地/nightly 验。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review，user 定）

本 feature 体量大（schema + 8 端口 + 6 live adapter + VendorHttpClient + 4 读端点 + contract），单 PR 过大。**user 定 = 3 段 server PR**（均纯 server，无 mobile）：

- **PR1（schema + 可插拔骨架）**：6 表 schema + migration（pg_trgm + GIN）+ moat/boundaries 登记 + 8 端口接口 + `marketdata.config.ts` + `MarketdataModule` + 全套 Mock adapter + boot smoke。**可独立 ship**（模块 boot + Mock 端到端绿）。
- **PR2（vendor 传输 + Lixinger 事实源 + 读端点）**：`VendorHttpClient` + Constraint Profile + 双窗限频器 + 理杏仁 4 adapter（fsType 路由 + 符号归一化）+ `EodBackedQuoteAdapter` + 4 读 controller/DTO + Redis 热快照 + OpenAPI + `@nvy/api-client` regen。
- **PR3（东财 search + 本地备 + FallbackChain）**：`EastmoneySearchAdapter` + `LocalInstrumentSearchAdapter`（pg_trgm + 拼音）+ `FallbackChainAdapter` + search 端点接通 + 真东财 IT（env-gated）。

各 PR 均带 IT，符合 Constitution III atomic + 真后端验收。PR1 可独立 ship（模块 boot + Mock 端到端绿）；PR2 ship 读侧主体（理杏仁事实源 + EP2-4 + contract regen）；PR3 补 search FallbackChain（EP1 接通）。

### 建议 tasks.md 层级（每 task 30min-2h + 独立 commit + TDD 红绿 + `[X]` flip，对齐 p1 §A.6 落地序）

**PR1（骨架）**：

- `[Server]` schema + migration：6 model + datasource schemas 加 marketdata + expand-only migration（6 表 + 索引 + `CREATE EXTENSION pg_trgm` + GIN trgm raw）+ `prisma generate` gate → verify: `nx test server <marketdata-schema IT>` Testcontainers migrate deploy 通过
- `[Server]` boundaries + moat 登记：eslint marketdata element + dependency rules + `check-server-moat.ts` 6 MODEL_OWNERSHIP + BUSINESS_CTX 加 marketdata → verify: `nx lint server` 0 violation + `tsx check-server-moat.ts` 关
- `[Server]` 8 端口接口 + config + module + Mock：`*.port.ts`(8) + `marketdata.config.ts`(discriminated-union) + `MarketdataModule`(每端口 DI 工厂) + `mock-market-data.adapter.ts` → verify: 零 env boot smoke + `kind:live` 缺 token boot fail-fast 单测 + Mock 端口调用确定性 fixture

**PR2（vendor + Lixinger + 读端点）**：

- `[Server]` VendorHttpClient + Constraint Profile + 双窗限频器：→ verify: 双窗限频单测（超 perSec/perMin 排队）+ 必需 header 注入 + 429/瞬时退避重试单测
- `[Server]` Lixinger 4 adapter + 符号归一化 + fsType 内部路由：→ verify: env-gated 真理杏仁 IT + mock 单测 + 符号 round-trip 测 + fsType 不外泄签名断言
- `[Server]` EodBackedQuoteAdapter + 读端点（4 UC + controller + DTO + Redis 热快照 + exception）：→ verify: 前收算涨跌单测 + Decimal-string 序列化测 + no-data 隔离 + 详情聚合/404/非法 adjust 400 IT
- `[Server]` throttler 4 桶 + 既有 controller spread skip + swagger：→ verify: 桶边界 429 IT
- `[Contract]`：`nx run server:export-openapi` → `nx affected -t generate`（orval regen）+ api-client typecheck 绿
- `[Server-IT]`（Testcontainers PG+Redis，seed fixtures）：quote EOD-backed/no-data/Redis 命中 · detail 聚合/404 · bars adjust/非法 · 限流桶边界

**PR3（东财 search + 本地备 + FallbackChain）**：

- `[Server]` EastmoneySearchAdapter + 东财符号归一化：→ verify: env-gated 真东财 IT（MultiMatch 解析）+ mock 单测
- `[Server]` LocalInstrumentSearchAdapter（pg_trgm + 拼音）+ pinyin 填充：→ verify: seed Instrument + pg_trgm similarity IT（拼音/名/代码命中）
- `[Server]` FallbackChainAdapter + search 端点接通：→ verify: 主命中/主 503 平移本地/双空返空 三分支 IT（SC-S02）
- `[Verify]`：`nx affected -t lint typecheck test build --base=origin/main` 全绿 + catalog 4 Operation 行 + boundaries 0 违规 + `check-server-moat.ts` 关

预估 task 数：PR1 ~3 + PR2 ~6 + PR3 ~4 = **~13**（3 段方案）。主要新点 = 第 5 bounded context bootstrap + 8 端口可插拔骨架 + 双窗限频 VendorHttpClient + 多 vendor adapter + FallbackChain；**无 mobile 段 / 无并发跨行不变性 / 无 outbox / 无 scheduler**（调度归 016）。

### 013/014 回写 follow-up（**015 落地后**做，per user「后边回写」；纯 spec 改，独立 docs PR）

> 触发时机：015 EP1-4 contract 定稿（OpenAPI）后。013/014 均 `draft`，回写无 impl 风险。

1. **014-stock-detail**（改动最大）：移除 `[Server]` US1（详情读）+ US2（K线读）→ 注明「数据由 015 EP3/EP4 提供，mobile 直调」；perf_budgets 删 detail/bars 两行（迁 015）；server 段仅留 `watchlist-status`；frontmatter 依赖加 `015`；US3+ mobile 段消费 015 端点不变。
2. **013-watchlist**：行情注入改「client 调 015 `/quote` merge」；加自选搜索指 015 `/search`；保留 watchlist CRUD server 段；frontmatter 依赖加 `015`。
3. **一致性**：两者 `→ 03 数据层 / quote-provider` 措辞统一改指 `015-marketdata-access-layer`（PRD-03 已是设计源，spec 引用更新）。
4. verify：`tsx scripts/check-spec-frontmatters.ts` 绿 + markdownlint。

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-02 | **ID-namespace**: EP1-4 / FR-S01..S14 / SC-S01..S08 | **Out-of-scope ref**: 016 marketdata 同步（[子 plan 2](../../docs/private/plans/2026-06/06-02-portfolio-marketdata-p2-sync.md)）
