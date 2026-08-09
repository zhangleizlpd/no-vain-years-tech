---
feature_id: 025-portfolio-holdings
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-07'
updated_at: '2026-06-07'
adr_refs: ['0030', '0032', '0038', '0043', '0048']
orchestrator_compat: '>=0.1.0'
context7_verified: []
---

# Implementation Plan: 025-portfolio-holdings（自有持仓导入）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `025-portfolio-holdings` | **方案权威输入**: [06-07-holdings-import-decisions.md](../../docs/private/plans/2026-06/06-07-holdings-import-decisions.md)（拉取位置/接口形态/字段清单/幂等语义已锁）| **Mockup**: [design/brief.md](./design/brief.md)（已收口，9 artboard）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011-022）。
> **⚠ 头号架构事实**：**013 持仓组派生 = 改读路径，不 materialize**（D1）——`ListWatchlistItems/Groups` 的 holdings 分支从「恒返空」改为读 `holding` 表派生视图，零 WatchlistItem 写入、零同步逻辑、永不 drift。**marketdata 可识别性判定移到导入时**（D2）——import UC 内一次批量 instrument 查询（Q7-B 临时路径 + `CROSS-CONTEXT-READ` 注释，018/021 先例）落 `quotable` 列，读热路径零跨 ctx 读。

## Summary _(mandatory)_

025 = 同花顺汇总持仓 xlsx 的服务端导入 + 三类数据查询 + 013 持仓组数据源闭环 + mobile 两屏：**① server 导入链路**（`@fastify/multipart` 收文件 → exceljs 解析 3 sheet → 纯函数规范化（`--`/汇总行/类别 enum）→ 单事务按账户整体替换 3 新表 → 导入摘要）→ **② 查询面**（持仓+已清仓列表 / 按标的交易历史）→ **③ 持仓组派生读**（holdings 分支改读 holding 表）→ **④ mobile**（持仓屏双 tab + 标的交易历史屏 + 自选工具栏入口，行情走既有 quote client-merge per ADR-0048）→ **⑤ 本机同步工具**（拉取 + 上传两段，FR-012，人工验收）。

- **server 段**：portfolio ctx +3 新表（`holding` / `closed_position` / `trade_record`）+ 3 端点 + 导入/查询 UC + 2 个既有 UC 改造（watchlist items/groups 的 holdings 分支）。**新跨 ctx 面 = 1 条 Q7-B 读**（import 时批量查 `instrument` 可识别性）。
- **mobile 段**：`src/portfolio/` 新增 holdings/trade-history 屏 + hooks（orval typed client + 复用 `use-quote-merge`）；2 新路由 + 自选主屏工具栏钱包入口。
- **新外部依赖 = 2**：`exceljs`（只读解析，npm `xlsx` 因 CVE 永滞 0.18.5 否决）+ `@fastify/multipart` v10（Fastify 5 线）。

## API Contracts _(mandatory)_

| #   | Method | Path                                      | Auth   | Request                                                      | Response                                                                 | trace FR              |
| --- | ------ | ----------------------------------------- | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------- |
| EP1 | POST   | `/api/v1/portfolio/holdings/import`       | bearer | multipart/form-data：`file`（xlsx ≤2MB 必填）+ `asOf`（YYYY-MM-DD 可选，缺省=服务端当日） | **200** `ImportSummaryResponse{ asOf, holdings:{imported,skipped[]}, closed:{...}, trades:{...} }` / 400 / 401 / 413 / 422 / 429 | FR-001..006           |
| EP2 | GET    | `/api/v1/portfolio/holdings`              | bearer | —                                                            | **200** `HoldingsListResponse{ asOf: string\|null, current: HoldingItem[], closed: ClosedPositionItem[] }` / 401 | FR-007                |
| EP3 | GET    | `/api/v1/portfolio/trades?market=&code=`  | bearer | query：`market`（'cn'）+ `code` 必填                          | **200** `TradeListResponse{ items: TradeItem[] }`（成交时间倒序，资金行天然不命中）/ 400 / 401 | FR-008                |

- **EP1 语义**：单事务 `deleteMany(accountId)` ×3 表 → `createMany`；任何整体性失败回滚（FR-002 不留半态）；幂等 = 全量替换天然成立（FR-006）。缺必要 sheet / 非 xlsx → 422 ProblemDetail（ADR-0038）；超 2MB → 413（multipart limits 层拒）。行级容错不阻断：跳过行带原因进 `skipped[]`（FR-004/005）。
- **EP2**：`asOf` 取 holding 表快照日（无导入 → null + 双空数组）。浮动盈亏/现价**不在响应内**——mobile 走 quote client-merge（ADR-0048，013 先例）。
- **EP3**：按 (market, code) 等值查 trade_record，时间倒序；未交易标的 → 空 items（200 非 404）。
- 鉴权：三端点 `JwtAuthGuard` + ACTIVE；数据按 accountId 隔离（FR-010）。限流：EP1 named 桶 `portfolio-import-account 6/60s`（沿 021 named 桶机制）；EP2/EP3 默认桶。
- **DTO 注意**：`asOf: string|null` 等 nullable string 必须显式 `@ApiProperty({ type: 'string', nullable: true })`（orval 陷阱，memory 实证）；金额字段序列化体例 impl 时对齐 015 quote response（Decimal 出口形态单源）。
- **perf SoT** = spec frontmatter `perf_budgets`（EP1 3000/5000；EP2/EP3 200/400）。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| `exceljs@^4.4.0`（server，runtime） | 只读解析上传 xlsx（`workbook.xlsx.load(buffer)` → `eachSheet/eachRow`，inline-string 解析为普通 cell 值）。**否决 npm `xlsx`（SheetJS）**：npm 永滞 0.18.5（2022-03），CVE-2023-30533（原型污染）修复版 0.19.3+ 仅在自有 CDN 分发，frozen-lockfile 不兼容 | [SheetJS advisory CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533) · [Snyk SNYK-JS-XLSX-5457926](https://security.snyk.io/vuln/SNYK-JS-XLSX-5457926) · [SheetJS #2961 不发 npm](https://git.sheetjs.com/sheetjs/sheetjs/issues/2961) · [Snyk exceljs 0 active CVE](https://security.snyk.io/package/npm/exceljs) |
| `@fastify/multipart@^10`（server，runtime） | 接收 multipart 文件上传；v9/v10 线对应 Fastify 5（`fastify-plugin ^5`）= `@nestjs/platform-fastify` 11 所带；`app.register(fastifyMultipart)` 官方支持（cors/static 同款注册位）。已知 TS typing 摩擦：用 named export 或 `as any`（NestJS #14866） | [fastify/fastify-multipart](https://github.com/fastify/fastify-multipart) · [NestJS #14866](https://github.com/nestjs/nest/issues/14866) |
| 其余 | None | N/A — playwright（本机脚本 CDP 复用）已是 repo dev 依赖；mobile 零新依赖 |

## Constitution Check _(mandatory)_

通过，无违反。

| 原则 | 状态 | 备注 |
| --- | --- | --- |
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（2Q）→ mockup ✅（design/ 收口）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | 解析/规范化/类别映射/派生过滤走纯函数 vitest 红绿（`holdings-import.rules.ts`）；EP1/2/3 + 持仓组派生 Testcontainers IT 覆盖 state_branches；本机脚本 = 人工验收（FR-012 显式不进 CI） |
| III. Atomic 30min-2h + 独立 commit | ✅ | 三段式 PR（见 § Phase 2），tasks 按 30min-2h 拆 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅ | 3 新表自持 owner=portfolio（moat 注册）；+1 条 Q7-B 跨 ctx 读（import 时批量查 instrument，`CROSS-CONTEXT-READ` 注释，018/021 先例）；零跨 ctx 写、零新边（portfolio 既有依赖面不变） |
| V. 类型同步链 Nx-driven | ✅ | PR-1 ship 三端点 + api-client regen 先 merge；PR-2 mobile 消费已落地 typed client（PR-1 描述 cite §V 例外） |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: PR-1 Testcontainers IT 覆盖 EP1（成功导入/重导幂等/缺 sheet 422/脏数据行级容错/未知类别兜底/汇总行跳过/事务回滚不留半态）+ EP2（有数据/空态 null asOf）+ EP3（全量流水时序/空 items）+ 持仓组派生（quotable 过滤/重导清空）至少各一次。
- [x] **Mobile / Web**: 持仓屏/交易历史屏 golden path 走 `[Mobile-E2E]` hermetic（Playwright Expo Web，mock 后端）+ `[Contract-Smoke]`（生成 client 打 testcontainers 真 server：导入样本 → GET holdings → GET trades 全链）。
- [x] **Evidence**: xlsx 样本结构已实测（本 session 解析 `~/Downloads/汇总持仓.xlsx`：3 sheet/inlineStr/27+13+11 列/7 交易类别/汇总行），结论固化于方案文档 § 数据调研；IT/e2e 随 PR 落。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

新引入 `exceljs` + `@fastify/multipart`：

| # | Question | exceljs | @fastify/multipart |
|---|---|---|---|
| Q1 | 维护信号 | 4.4.0（2023-10），release 节奏放缓但 ~8.6M 周下载、0 active CVE；只读解析面 API 稳定 | 10.0.0（2026-04），fastify 官方组织维护，~1.55M 周下载 |
| Q2 | 已装工具可覆盖？ | 否——repo 无任何 spreadsheet 解析依赖；自写 zip+XML 解析（本 session 调研用法）≈ 重造易碎轮子 | 否——`@fastify/cors`/`@fastify/static` 不含 multipart；NestJS 内置 FileInterceptor 是 Express/multer 面，Fastify 5 不适用 |
| Q3 | 栈兼容 | 纯 JS，Node 22 直跑；只用 `xlsx.load(buffer)` 只读面 | v10 ↔ Fastify 5 ↔ platform-fastify 11 版本线对齐（fastify-plugin ^5） |
| Q4 | LLM 训练覆盖 | 高（主流包，API 稳定多年） | 高（fastify 官方插件） |
| Q5 | 解耦成本 | 低——解析封装在单文件 `holdings-xlsx.parser.ts`，换 `read-excel-file` 等 = 改一文件 | 低——注册一行 + controller 取 file 一处 |
| Q6 | 风险面 | MIT；0 active CVE；上传文件先过大小/类型校验再进解析（不可信输入面收窄） | MIT；官方组织；limits 配置即 DoS 防线（fileSize/files 上限） |

**Evidence**: 联网 fact-check 2026-06-07（锚点见 Cargo-cult 表：SheetJS npm 停滞 + CVE 双链接、multipart↔Fastify5 版本线、NestJS 注册方式 #14866）；备选 `read-excel-file`（活跃维护）已评估留作替换路径，`node-xlsx` 因依赖 SheetJS CDN tarball 否决。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

N/A — feature is mono-native（无 meta-repo 迁移面；同花顺侧脚本为新写）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg -n "Open Question" docs/adr/0047* docs/adr/0048* docs/adr/0032*` 扫描结果：

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0048 | portfolio→marketdata 读传播路径（quote client-merge / server 侧读走 R2） | **accepted-as-is** | 行情合成 100% 沿既有 client-merge（mobile `use-quote-merge`），server 响应零行情字段；唯一新 server 读 = import 时 instrument 可识别性批查，走 Q7-B 临时路径 + 注释（非 0048 改动面） |
| ADR-0047 | 理杏仁配额/东财 ToS/实时 QUOTE_PORT 选型 | **accepted-as-is** | 本 feature 不触 vendor 面（不新增行情消费路径），开放问题不受影响 |
| ADR-0032 | catalog Q7 独立只读查询的终态载体（共享读服务 vs 物化视图；Q7-B 直查为临时路径） | **accepted-as-is** | +1 Q7-B 实例（018/021 先例同款）：单点批量、只读、带 `CROSS-CONTEXT-READ` 注释，moat 探针可见；终态收敛随 catalog 决议统一迁移 |

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装微型 DI 容器让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试"视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 9 条每条**必须**有对应验证项归属（server IT / hermetic e2e / contract-smoke / 本机人工验收矩阵——认证分支落 IT，脚本续期分支落人工矩阵，均须显式列出）。

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7Q — 全部落 portfolio 既有 ctx，零新 ctx）

| Q | 问题 | 判定 |
| --- | --- | --- |
| Q1 | 直改某 ctx 核心表？ | **Yes → portfolio** — 3 新表全是持仓域事实，与 BrokerAccount/Group/WatchlistItem 同域共生（013 持仓组派生直接消费） |
| Q2 | 编排多 ctx 流程？ | No — 导入/查询在 portfolio 域内闭环 |
| Q3 | 纯 platform infra？ | No — xlsx 解析是业务导入规则（列语义映射/类别 enum 全是持仓业务） |
| Q4 | 完全新业务领域？ | No — 「自有持仓」是 portfolio（投资组合）的字面核心子域 |
| Q5/Q6 | R2 sync / R3 async？ | No — 零跨 ctx 写、零 caller 回滚耦合、零 side-effect 通知 |
| Q7 | 独立跨 ctx 读？ | **Yes，1 条 Q7-B** — import UC 内 `prisma.instrument.findMany({ where: { OR: [(market,code)...] }, select: {market,code} })` 批量判定可识别性 → 落 `holding.quotable`。只读单点 + `CROSS-CONTEXT-READ` 注释（moat 探针强制），018/021 先例 |

**单向边不变**：portfolio → security（Prisma infra）+1 条 Q7-B 读 marketdata；无人依赖本 feature 新面。moat 注册 3 新表 owner=portfolio（`check-server-moat.ts`）。

### 数据模型（Prisma schema `portfolio`，+3 表，migration `yyyymmddhhmm_create_portfolio_holdings_tables`；Decimal 禁 Float 沿 marketdata FR-S08 体例；贫血 row + `@map` snake_case）

```text
Holding          @@map("holding") @@schema("portfolio")
  id BigInt autoincrement | accountId BigInt（逻辑引用 JWT sub，跨 schema 禁 FK，012/013 体例）
  market VarChar(4)（V1 'cn'）| code VarChar(16) | name VarChar(128)（参考非权威）
  qty Decimal(18,4) | unitCost Decimal(18,6) | weightPct Decimal(8,4)?
  holdDays Int? | cumPnl Decimal(18,2)? | cumPnlPct Decimal(10,4)?
  quotable Boolean（D2：import 时 instrument 批查落列）| asOf Date | raw Json | createdAt
  @@unique([accountId, market, code])  ← 同账户同标的单行（文件本身聚合口径）

ClosedPosition   @@map("closed_position") @@schema("portfolio")
  id | accountId | market | code | name
  openDate Date | closeDate Date | buyAvg Decimal(18,4) | sellAvg Decimal(18,4)
  totalPnl Decimal(18,2) | totalPnlPct Decimal(10,4)? | fee Decimal(18,2)?
  indexPct Decimal(10,4)?（同期大盘）| vsIndexPct Decimal(10,4)?（跑赢大盘）
  raw Json | createdAt
  @@index([accountId, market, code])  ← 同标的多轮清仓合法，无唯一约束（整体替换兜底）

TradeRecord      @@map("trade_record") @@schema("portfolio")
  id | accountId | market VarChar(4)? | code VarChar(16)?（资金行 null）| name VarChar(128)?（XD 前缀保留）
  category VarChar(16)（normalized enum，见下）| tradeDate Date | tradeTime VarChar(8)?（'14:53:27'，资金行 null）
  qty Decimal(18,4)? | price Decimal(18,6)? | amount Decimal(18,2)（发生金额，signed）
  turnover Decimal(18,2)?（成交金额）| fee Decimal(18,2)? | note VarChar(256)?
  raw Json | createdAt
  @@index([accountId, market, code, tradeDate])  ← EP3 查询路径
```

- **category enum（normalized，原始中文保留在 raw）**：`buy(买入) | sell(卖出) | xd(除权除息) | dividend_tax(股息个税征收) | repo_out(质押回购拆出) | repo_back(拆出质押购回) | cash(其他=资金转入转出) | unknown(兜底，摘要警示)`。映射纯函数 + 词表常量落 `holdings-import.rules.ts`。
- **raw Json**：三表每行存原始行 `{列名: 原值}`（含 typed 之外全部列），方案文档字段清单的「不丢信息」承诺载体。
- **快照只留最新**：EP1 事务内 delete+insert；asOf 为列非表级（行级冗余换查询简单，V1 单账户量级无虞）。

### 导入链路（全部平铺 `apps/server/src/portfolio/`，扁平贫血零-class）

- **multipart 接入（`main.ts`）**：`app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } })`（cors 注册位旁，插件顺序在路由 mount 前）；controller 内 `req.file()` 取流转 buffer。TS typing 摩擦按 #14866 用 named export。
- **`holdings-xlsx.parser.ts`**：exceljs 封装——按 sheet 名定位（持仓数据/已清仓/交易记录，缺任一 → 422），首行表头按**列语义映射**（前缀匹配容忍日期后缀如「当日盈亏05-06」），输出 raw 行数组。唯一 exceljs 触点（Q5 解耦单文件）。
- **`holdings-import.rules.ts` 纯函数**：行规范化（`--`/空 → null；金额/数量 parse；日期 parse）+ 汇总行判定（代码列='汇总' → skip 带原因）+ category 映射 + 持仓/已清仓/流水三形态校验。vitest 红绿主战场。
- **`import-holdings.usecase.ts`**：parse → rules 规范化 → **跨 ctx 批查 instrument**（`CROSS-CONTEXT-READ` 注释 + select 最小列）落 quotable → `$transaction`: 三表 deleteMany(accountId) + createMany → 组装 ImportSummary。整体性失败（解析炸/缺 sheet）发生在 tx 前 → 库天然不变；tx 内失败回滚（state_branch #4）。
- **并发导入（spec Edge，analyze I2 修订）**：import 事务首行 `SELECT pg_advisory_xact_lock(<accountId 派生 key>)` 账户级串行化——确定性「后完成者整体覆盖」。不加锁时 closed_position/trade_record 无唯一约束理论可重复（holding 的 P2002 只兜自己），一行锁消除该窗口。

### 查询 + 持仓组派生（D1：改读路径，不 materialize）

- **`list-holdings.usecase.ts`**（EP2）：holding（weightPct desc）+ closed_position（closeDate desc）两查询拼响应；asOf 取首行（表内同批一致）。
- **`list-trades.usecase.ts`**（EP3）：等值 (accountId, market, code) 查 trade_record，`ORDER BY tradeDate DESC, tradeTime DESC NULLS LAST`。
- **持仓组派生**：`list-watchlist-items.usecase.ts` holdings 分支从 `return { items: [] }` 改为：查 `holding where accountId AND qty>0 AND quotable=true` → 按 weightPct desc 映射 item view（id=holding.id / pinned=false / color=null）——响应 shape 不变，mobile 自选页零改动即点亮。`list-watchlist-groups.usecase.ts` 持仓组 itemCount 同源派生。**HoldingsGroupReadonly 写保护不动**（FR-009 只读语义不变）。
- **降级行**：quotable=false 行不进持仓组，但 EP2 照常返回（mobile 持仓屏降级展示，quote merge 查无报价自然显 `--`）。

### Mobile side（`src/portfolio/` + 2 路由 + 工具栏改造；mockup = design/handoff-claude-design/）

- **路由**：`app/(app)/portfolio/holdings.tsx`（薄 route → `HoldingsScreen`）+ `app/(app)/portfolio/trades/[symbol].tsx`（薄 route，`parseSymbol` 复用 014 canonical `cn:603915` 体例 → `TradeHistoryScreen`）。
- **屏体**（`src/portfolio/`）：`holdings-screen.tsx`（汇总条/双 tab/三变体）+ `trade-history-screen.tsx`（持仓摘要条/倒序流水/月份吸顶）+ `holdings.helpers.ts` 纯函数（浮动盈亏=(现价−unitCost)×qty、总市值聚合、月份分组——vitest 主战场）。视觉按 mockup 翻 RN：复用 `~/theme` token（盈亏色 = `quote.up/down/flat`）+ `~/ui`（MarketBadge / SafeAreaView / Spinner）。
- **hooks**：`use-holdings.ts` / `use-trades.ts`（orval 生成 hook + React Query）；现价/浮动盈亏 = `use-quote-merge` 既有 hook 对 current 列表二次 merge（013 先例，禁 detail N+1）。
- **工具栏入口**：`watchlist-main-screen.tsx` 顶部工具栏 bell 旁加钱包 icon（mockup 位序：搜索→铃铛→持仓→消息）→ `router.push('/(app)/portfolio/holdings')`。
- **空态文案**：「暂无持仓数据 / 持仓数据由本机同步工具导入」（mockup 定稿措辞；无任何上传入口）。

### 本机同步工具（`scripts/holdings-sync/`，FR-012；TS + tsx，复用 repo 既有 playwright 依赖）

- **`fetch-tzzb.ts`**（拉取段）：`chromium.connectOverCDP('http://127.0.0.1:18800')` attach 用户常驻调试 Chrome（profile 持久登录态，download_tzzb.md 方案翻 TS）；未起则带 `--remote-debugging-port` + 固定 profile 启动并等待人工登录。页面内点「数据导出」→ note API 轮询 file_name → 页内 XHR 取二进制 →落本地。**去硬编码**：user_id/fund_key 从页面会话/导出 XHR 的实际请求中捕获（CDP network 监听），不写死。
- **`upload-holdings.ts`**（上传段）：读 `~/.nvy/holdings-sync.json`（refresh token，chmod 600）→ 调 003 refresh 端点换 access（**轮转后回写新 refresh**）→ multipart POST EP1（asOf 取文件名日期）→ 打印导入摘要。首跑无 token → CLI 交互走 SMS 登录（发码/验码端点）。`--base-url` 区分 dev/prod。
- **验收 = 人工矩阵**（不进 CI）：真实拉取 → 上传 dev server → EP2 回显比对（SC-001/SC-004 实测）；refresh 轮转续期路径（state_branch #9）。

### Cross-cutting

- **同步链**：PR-1 swagger → `nx run server:export-openapi` → api-client regen 随 PR-1 merge；EP2 `asOf` nullable string 显式 `type:'string'`（orval 陷阱）。EP1 multipart 在 OpenAPI 为 `multipart/form-data` requestBody——mobile V1 不消费 EP1，regen 后仅核对生成物不破坏既有 client。
- **测试 fixture 双轨**：① 程序化 builder（exceljs 写测试 xlsx，覆盖边界：缺 sheet/汇总行/`--`/未知类别/资金行）= IT 主体；② 真实样本脱敏副本入 `apps/server/src/portfolio/__fixtures__/`（inlineStr 真实解析回归——exceljs 自产文件走 sharedStrings 路径，两条解析路径都要踩）。
- **business-naming**：无新模块（portfolio 三处同名已立：server module / mobile feature dir / DB schema）。
- **本地验证环境**：dev DB = `docker-compose.dev.yml`（:5433/:6380）；server IT 前 `env -u OSS_*`（memory 实证 boot ZodError）。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| # | 决策 | 结论 | gate? |
| --- | --- | --- | --- |
| **D1** | 持仓组派生机制 | **改读路径**（holdings 分支读 holding 表派生视图），不 materialize WatchlistItem——零同步、零 drift、写保护不动；mobile 零改动点亮 | ⚠️ 请 review |
| **D2** | marketdata 可识别性判定时机 | **导入时批查落 `quotable` 列**（1 条 Q7-B + 注释），读热路径零跨 ctx；代价 = 后补 instrument 须重导才点亮（日频导入下窗口可忽略） | ⚠️ 请 review |
| **D3** | xlsx 解析库 | **exceljs**（npm `xlsx` CVE 停滞否决；`read-excel-file` 留作替换路径；解析封装单文件） | ✅ 6Q card 定 |
| **D4** | asOf 来源 | EP1 可选 `asOf` 字段（脚本传文件名日期），缺省**北京时间（Asia/Shanghai）当日**（analyze A1：容器 UTC 0-8 点错位，导出日语义随交易日历）——文件内无可靠导出日字段 | ✅ 默认接受 |
| **D5** | category 词表 | 7 实测值 normalized enum + `unknown` 兜底（摘要警示不丢行）；原始中文保留 raw | ✅ 默认接受 |
| **D6** | EP2 形态 | 单端点返 current+closed 双数组（双 tab 一次取，V1 量级无分页）；asOf 表级语义行级冗余 | ✅ 默认接受 |
| **D7** | 同步工具语言 | **TS + tsx + 复用 playwright 依赖**（connectOverCDP），不引 Python/ws 新工具链；token 持久化 `~/.nvy/`（chmod 600，refresh 轮转回写） | ⚠️ 请 review |
| **D8** | 真实样本入库 | 脱敏副本入 fixtures（inlineStr 回归）+ 程序化 builder 双轨；脱敏尺度（金额是否打散）impl 时 user 拍板 | ⚠️ 请 review |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| — | — | — |

**Note**：(1) 零新 ctx、零新单向边——3 新表自持 + 1 条 Q7-B 只读（既有临时路径范式第 3 例）。(2) 导入 = 纯函数规则 + 单事务替换，无状态机/无队列/无重试 infra。(3) mobile 无新交互范式（列表 + tab + 行点入，全复用既有组件系）。

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| EP1 POST holdings/import（≤2MB） | 3000 | 5000 |
| EP2 GET holdings / EP3 GET trades | 200 | 400 |

_SoT = spec frontmatter `perf_budgets`。EP1 预算含 xlsx 解析 + 全量替换事务（样本量级 <100 行实际远低）；SC-001 的 <10s 端到端含网络与脚本侧。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**三段式 PR**（Constitution §V 两段 + 工具独立）：

- **PR-1（server，feat(portfolio)）**：deps（exceljs + @fastify/multipart + main.ts 注册）+ Prisma schema/migration（3 表）+ moat owner 注册 + `holdings-import.rules.ts` 纯函数红绿 + `holdings-xlsx.parser.ts` + import UC（含 Q7-B quotable 批查）+ EP1 controller + EP2/EP3 UC+controller + 持仓组派生改造（items/groups 两 UC）+ Testcontainers IT（state_branches server 条目全覆盖）+ fixtures 双轨 + **api-client regen**（cite §V 例外）。
- **PR-2（mobile，feat(portfolio)）**：holdings/trade-history 两屏 + helpers 纯函数 vitest + hooks（quote merge 复用）+ 2 薄路由 + 工具栏钱包入口 + 空态/降级态 + `[Mobile-E2E]` hermetic（双 tab/降级行/空态/行点入导航；mock 后端）+ `[Contract-Smoke]`（登录 → EP1 导入样本 → EP2 回显 → EP3 流水，落 `apps/mobile/e2e/contract-smoke/portfolio-holdings.contract.ts`）。
- **PR-3（同步工具，feat(portfolio)）**：`scripts/holdings-sync/` fetch-tzzb.ts + upload-holdings.ts（SMS 首登/refresh 轮转/multipart 上传）+ README 使用说明 + **人工验收矩阵**（真实拉取→dev 导入→回显比对 + 续期路径，证据贴 PR）。

> 依赖：PR-2 依赖 PR-1 merge（§V）；PR-3 依赖 PR-1 端点 ship（可与 PR-2 并行）。

### 建议 tasks.md 层级（每 task 30min-2h，预估 **~14-17 task**）

- **PR-1 ~8**：`[Server]` deps+multipart 注册+schema/migration/moat → `[Server]` import rules 纯函数红绿 → `[Server]` xlsx parser（fixture builder 起步）→ `[Server]` import UC + EP1（含 Q7-B）→ `[Server]` EP2/EP3 UC+controller → `[Server]` 持仓组派生改造 → `[Server-IT]` state_branches 全覆盖 + 真实样本回归 → `[Contract]` regen
- **PR-2 ~6**：`[Mobile]` hooks + helpers 红绿 → `[Mobile]` 持仓屏（双 tab 三变体）→ `[Mobile]` 交易历史屏 → `[Mobile]` 路由 + 工具栏入口 → `[Mobile-E2E]` hermetic → `[Contract-Smoke]`
- **PR-3 ~3**：`[Tool]` fetch-tzzb.ts → `[Tool]` upload-holdings.ts（auth 续期）→ `[Manual]` 端到端人工验收矩阵

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-07 | **ID-namespace**: US1-4 / FR-001..012 / SC-001..005 / EP1-EP3（portfolio 本 feature 命名空间）| **ADR**: 0032（Q1 归 portfolio + Q7-B 第 3 例）/ 0043（扁平贫血 + 解析单文件封装）/ 0048（quote client-merge 不变面）/ 0038（ProblemDetail 错误体例）/ 0030（无 packages 新共享，工具私有常量自持）
