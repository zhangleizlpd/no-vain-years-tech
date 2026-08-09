---
feature_id: 025-portfolio-holdings
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-07'
---

# Tasks: 025-portfolio-holdings（自有持仓导入）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `025-portfolio-holdings` | **方案权威输入**: [06-07-holdings-import-decisions.md](../../docs/private/plans/2026-06/06-07-holdings-import-decisions.md) | **Mockup**: [design/brief.md](./design/brief.md)

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Tool]` / `[Manual]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server）；纯函数（import rules / mobile helpers）= vitest 无 DB；mobile UI·render·a11y = Playwright Expo Web e2e（mono 测试分层）；**本机同步工具 = 人工验收矩阵显式归属（FR-012 不进 CI，plan EXHAUSTIVE BRANCHING）**
- 无 task-meta JSON（**manual 模式**，per 004-022）
- 🚨 **零新 ctx / 1 条 Q7-B（plan D2）**：`holding` / `closed_position` / `trade_record` 3 新表自持 owner=portfolio（moat 注册）；import UC 内**唯一**跨 ctx 读 = `prisma.instrument.findMany` 批查可识别性（**必带 `CROSS-CONTEXT-READ` 注释**，018/021 先例，moat 探针强制）；**跨 ctx 写永远禁**
- 🚨 **整体替换幂等（plan §导入链路）**：EP1 单 `$transaction` 三表 deleteMany(accountId)+createMany；解析/校验失败发生在 tx 前 → 库不变；**禁增量 upsert**（全量历史前提，方案文档已锁）
- 🚨 **持仓组派生 = 改读路径（plan D1）**：`list-watchlist-items/groups` holdings 分支读 `holding` 表派生视图；**不写一行 WatchlistItem**；`HoldingsGroupReadonly` 写保护不动（FR-009）
- 🚨 **行情零冗余（ADR-0048）**：EP2/EP3 响应零行情字段；现价/浮动盈亏 = mobile `use-quote-merge` client-merge（013 先例，禁 detail N+1）
- **三段式 PR（per Constitution §V + plan §Phase 2）**：**PR-1 = Server**（T001–T010，ships EP1/EP2/EP3 + 持仓组派生 + **api-client regen committed**，描述 cite §V 例外）→ **PR-2 = Mobile**（T011–T017，消费 PR-1 已 merge typed client + 两层验证）→ **PR-3 = 同步工具**（T018–T020，人工验收，可与 PR-2 并行）

## Path Conventions

- server：`apps/server/src/portfolio/`（既有 module，扁平平铺新文件）；schema `apps/server/prisma/schema.prisma`（`@@schema("portfolio")` +3 表）+ migration `create_portfolio_holdings_tables`；multipart 注册 `apps/server/src/main.ts`（cors 注册位旁）；IT `apps/server/test/integration/*.it.spec.ts`；fixtures `apps/server/src/portfolio/__fixtures__/`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）；**EP2 `asOf` nullable string 必须 `@ApiProperty({type:'string', nullable:true})`**（orval 陷阱 memory 实证）
- mobile：屏体/hooks/helpers `apps/mobile/src/portfolio/`；薄路由 `apps/mobile/app/(app)/portfolio/holdings.tsx` + `apps/mobile/app/(app)/portfolio/trades/[symbol].tsx`（`parseSymbol` 复用 014 canonical `cn:603915`）；工具栏 `apps/mobile/src/portfolio/watchlist-main-screen.tsx`
- e2e：hermetic `apps/mobile/e2e/`（**必 mock 003 refresh-token 端点** per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/portfolio-holdings.contract.ts`
- tool：`scripts/holdings-sync/`（fetch-tzzb.ts / upload-holdings.ts / README.md）；token 持久化 `~/.nvy/holdings-sync.json`（chmod 600）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（mbw-poc-postgres:5433 / redis:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**；新表落库后 `prisma generate` 先行；新文件首跑 `--skip-nx-cache`

---

## Phase 1: Server — 导入 + 查询 + 持仓组派生（PR-1）

**Goal**：3 表 + EP1/EP2/EP3 ship 真后端 + 013 持仓组数据源闭环 + api-client regen。

- [X] T001 [Server] **deps + 注册面 + schema**：`pnpm -C apps/server add exceljs @fastify/multipart`（版本线 per plan 6Q card：multipart ^10 ↔ Fastify 5）+ `main.ts` `app.register(fastifyMultipart, {limits:{fileSize: 2*1024*1024, files: 1}})`（cors 旁，路由 mount 前；TS typing 摩擦用 named export per NestJS #14866）+ Prisma schema 3 表（`Holding`/`ClosedPosition`/`TradeRecord`，`@@schema("portfolio")`，形态 per plan §数据模型：Decimal 禁 Float / raw Json / `@@unique([accountId,market,code])` on holding / trade `@@index([accountId,market,code,tradeDate])`）+ migration `create_portfolio_holdings_tables` + `prisma generate` + moat `MODEL_OWNERSHIP` 注册 3 表 owner=portfolio `apps/server/scripts/checks/check-server-moat.ts`。**验**：migrate deploy 绿 + moat 检查绿 + server boot 绿
- [X] T002 [P] [US1] [Server] **导入规则纯函数**：`apps/server/src/portfolio/holdings-import.rules.ts` + vitest 红绿：行规范化（`--`/空串 → null；金额/数量/百分比 parse；日期 parse）+ 汇总行判定（代码列='汇总' → skip 带原因）+ category 词表映射（`buy/sell/xd/dividend_tax/repo_out/repo_back/cash/unknown` 8 值，`其他`→cash，未知→unknown 警示）+ 三形态行校验（持仓/已清仓/流水各自必填面）+ 列语义映射表（表头前缀匹配容忍日期后缀如「当日盈亏05-06」）。**纯函数零 DB**
- [X] T003 [US1] [Server] **xlsx parser + fixtures 双轨**：`apps/server/src/portfolio/holdings-xlsx.parser.ts`（exceljs `workbook.xlsx.load(buffer)` → 按 sheet 名定位三 sheet（缺任一 → 结构化错误）→ 表头行 + 数据行原值数组输出；**唯一 exceljs 触点**）+ `__fixtures__/build-holdings-xlsx.ts` 程序化 builder（exceljs 写测试文件：标准 3 sheet / 缺 sheet / 含汇总行 / 含 `--` / 未知类别 / 资金行）+ 脱敏真实样本 `__fixtures__/sample-holdings.xlsx`（inlineStr 真实解析回归——exceljs 自产走 sharedStrings，两路径都踩；**脱敏尺度 user 拍板后入库，plan D8**）+ vitest：builder 文件 + 真实样本均解析出 3 sheet 行数/表头正确
- [X] T004 [US1] [Server] **导入 UC + EP1 controller**：`import-holdings.usecase.ts`（parse → T002 rules 规范化 → **跨 ctx 批查** `prisma.instrument.findMany({where:{OR:[(market,code)...]}, select:{market,code}})` 落 `quotable`（**`CROSS-CONTEXT-READ` 注释挂注入点/调用点**）→ `$transaction`: 首行 `pg_advisory_xact_lock(accountId 派生 key)` 账户级串行化（analyze I2）→ 三表 deleteMany(accountId)+createMany → ImportSummary 组装）+ `import-summary.response.ts` DTO + `holdings-import.controller.ts`（`POST portfolio/holdings/import`：`req.file()` 取流转 buffer / `asOf` 可选字段缺省北京时间当日（plan D4）/ 非 xlsx mimetype·扩展 → 422 / `JwtAuthGuard` + named 桶 `portfolio-import-account 6/60s` + `@ApiBearerAuth` + swagger multipart requestBody 全响应码）+ **Testcontainers 单测**：样本导入行数断言（2 持仓+1 已清仓+23 流水，汇总行 skip 留痕）/ 重导幂等（两次后逐行一致）/ 缺 sheet 422 库不变 / 脏数据行级容错（`--`→null、unknown 类别入库+警示）/ quotable 批查正确（已注册标的 true / GC001 类 false）
- [X] T005 [P] [US2] [Server] **EP2 持仓列表 UC + controller**：`list-holdings.usecase.ts`（holding weightPct desc + closed_position closeDate desc 双查询拼 `HoldingsListResponse{asOf, current[], closed[]}`；asOf 取首行，无导入 → null+双空）+ DTO（**asOf 显式 `type:'string', nullable:true`**；金额序列化对齐 015 quote response 体例）+ `holdings.controller.ts` GET + **Testcontainers 单测**：有数据回显（字段映射全）/ 空态 null asOf / 账号隔离
- [X] T006 [P] [US3] [Server] **EP3 标的流水 UC + controller**：`list-trades.usecase.ts`（等值 (accountId, market, code) 查 trade_record，`ORDER BY tradeDate DESC, tradeTime DESC NULLS LAST`）+ query DTO 校验（market/code 必填 → 缺失 400）+ controller GET `portfolio/trades` + **Testcontainers 单测**：国茂股份全量 9 条时序正确 / 未交易标的空 items 200 / 资金行（code null）天然不命中
- [X] T007 [US4] [Server] **持仓组派生改造（D1 改读路径）**：`list-watchlist-items.usecase.ts` holdings 分支从 `return {items:[]}` 改为查 `holding where accountId AND qty>0 AND quotable=true` weightPct desc → 映射 item view（id=holding.id / pinned=false / color=null，响应 shape 不变）+ `list-watchlist-groups.usecase.ts` 持仓组 itemCount 同源派生 + **Testcontainers 单测**：导入后持仓组成员=quotable 持仓集合 / GC001 不进组 / 重导清空 → 组员清空 / 未导入恒空（既有行为零回归）/ 写保护不动（add/delete 仍 422 HOLDINGS_GROUP_READONLY，013 既有测试零回归）
- [X] T008 [US1] [Server-IT] `apps/server/test/integration/portfolio-holdings.it.spec.ts`（Testcontainers 全 boot，覆盖 spec `state_branches` server 条目）：导入成功摘要↔库内逐表一致（SC-001 数据面）/ 幂等重导 0 差异（SC-002）/ 非法文件（非 xlsx/缺 sheet/超 2MB→413）整体拒绝库不变 / 行级容错摘要可追溯（SC-005）/ 持仓组派生闭环（SC-003：导入→组员、清空持仓文件→组员清空）/ 清仓后重建仓并存（国茂股份双在）/ EP1 401·429 分支 / EP2/EP3 401
- [X] T009 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen EP1/EP2/EP3 hooks + 类型）→ `packages/api-client` + mobile typecheck 绿；**核对 EP2 asOf 非 `{[k]:unknown}|null`（orval 陷阱）+ EP1 multipart 生成物不破坏既有 client**。**regen 产物随 PR-1 commit**（Constitution §V，PR 描述 cite 例外）
- [X] T010 [Verify] PR-1 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**首跑 `--skip-nx-cache`**；本地 IT 前 `env -u OSS_*`）+ moat 探针绿（3 新表 owner + Q7-B 注释齐）+ spec frontmatter `status: implementing` 翻 + PR 描述 cite Constitution §V 例外 + 部署 gate 3-checkbox

**Checkpoint**：PR-1 merge → 导入/查询真后端可用 + 持仓组点亮，api-client 落地。

---

## Phase 2: Mobile — 持仓两屏 + 工具栏入口（PR-2）

**Goal**：mockup 翻 RN（design/handoff-claude-design/ 为 baseline），quote client-merge 接通，两层验证。

> **Follow-up（PR-2 分支首 commit）**：EP2 `holdDays`（`number|null`）@ApiProperty 漏 `type:'number'` → orval 误生成 `{[k]:unknown}|null`（T009 仅核对 asOf，nullable number 形态漏网）；server DTO 修 + openapi/api-client regen 同 commit（§V 例外）。

- [X] T011 [P] [US2] [Mobile] **helpers 纯函数 + hooks**：`apps/mobile/src/portfolio/holdings.helpers.ts` + vitest 红绿（浮动盈亏=(现价−unitCost)×qty / 盈亏率 / 总市值·总累计盈亏聚合（降级行剔除规则）/ 流水月份分组 / 金额千分位+signed 格式化——复用既有格式化工具先 grep `~/portfolio` 避免重造）+ `use-holdings.ts` / `use-trades.ts`（orval 生成 hook + React Query key 体例对齐 `use-watchlist-*`；current 列表二次 `use-quote-merge`（既有 hook，013 先例））
- [X] T012 [US2] [Mobile] **持仓屏**：`apps/mobile/src/portfolio/holdings-screen.tsx`（汇总条：总市值+总累计盈亏+asOf 标注 / 双 tab 当前持仓·已清仓 / 持仓行 4 列+次级信息条 / 已清仓行 日期区间+总盈亏+次级条 / 降级行 quotable=false 行情列 `--`+「无行情」角标 / 空态「暂无持仓数据·持仓数据由本机同步工具导入」无按钮 / 行点入交易历史）+ 薄路由 `app/(app)/portfolio/holdings.tsx`；视觉按 mockup（HoldingsKit.jsx baseline），token 用 `quote.up/down/flat` + `~/ui` MarketBadge，**0 token 重设**
- [X] T013 [US3] [Mobile] **交易历史屏**：`apps/mobile/src/portfolio/trade-history-screen.tsx`（nav=股票名+代码 / 有持仓时摘要条 / 倒序流水：买红·卖绿圆 badge+价×量+金额费用，息税中性灰 badge+XD 原始名保留 / 月份吸顶小标 / 尾「已经到底了」/ 空态）+ 薄路由 `app/(app)/portfolio/trades/[symbol].tsx`（`parseSymbol` 复用，非法 symbol 兜底对齐 014 体例）
- [X] T014 [US2] [Mobile] **工具栏入口 + 持仓组点亮核对**：`watchlist-main-screen.tsx` 顶部工具栏 bell 旁加钱包 icon（mockup 位序：搜索→铃铛→持仓→消息）→ `router.push('/(app)/portfolio/holdings')` + a11y label「持仓」+ **自选页持仓组零改动点亮核对**（PR-1 派生后该组显示真实成员——只验不改，发现 shape 不兼容才改）
- [X] T015 [US2] [Mobile-E2E] hermetic（Playwright Expo Web，mock EP1/EP2/EP3 + quote + **003 refresh-token**）：工具栏入口 → 持仓屏双 tab 切换 / 三变体（默认·降级行·空态文案无上传按钮）/ 持仓行·已清仓行点入交易历史（买卖 badge 可视区分+息税中性）/ 空流水态；locator 用 getByRole 收窄（stacked screen 双命中 memory）
- [X] T016 [US1] [Contract-Smoke] `apps/mobile/e2e/contract-smoke/portfolio-holdings.contract.ts`（生成 client 打 testcontainers 真 server）：登录 → EP1 导入程序化 fixture（FormData 路径验真）→ EP2 回显断言（asOf/current/closed 行数字段）→ EP3 流水断言 → 重导幂等回显不变；加入 `nx run mobile:contract-smoke` 套件
- [X] T017 [Verify] PR-2 gate：`nx affected -t lint typecheck test --base=origin/main` + hermetic + contract-smoke 全绿 + Expo Web 手动走查 golden path（截图贴 PR）+ 部署 gate 3-checkbox

**Checkpoint**：PR-2 merge → App 内持仓全貌可见，预警买卖点参考的展示面闭环。

---

## Phase 3: 本机同步工具（PR-3，可与 Phase 2 并行）

**Goal**：FR-012 拉取+上传两段交付，端到端人工验收（不进 CI）。

- [X] T018 [P] [US1] [Tool] **拉取段**：`scripts/holdings-sync/fetch-tzzb.ts`（playwright `chromium.connectOverCDP('http://127.0.0.1:18800')` attach 常驻调试 Chrome；未起则带 `--remote-debugging-port` + 固定 profile（`~/.nvy/chrome-tzzb-profile`）启动并提示人工登录；页面点「数据导出」→ note API 轮询 file_name → 页内 XHR 取二进制 base64 → 落 `汇总持仓_YYYYMMDD.xlsx`；**user_id/fund_key 从 CDP network 捕获实际导出请求提取，零硬编码**；重试 ×3）+ `scripts/holdings-sync/README.md`（首跑登录/日常一键/故障排查）
- [X] T019 [US1] [Tool] **上传段**：`scripts/holdings-sync/upload-holdings.ts`（读 `~/.nvy/holdings-sync.json` refresh token → 调 003 refresh 换 access + **轮转回写新 refresh**（chmod 600）→ multipart POST EP1（asOf=文件名日期）→ 打印导入摘要表；首跑无 token → CLI 交互 SMS 登录（发码/验码端点）；`--base-url` 区分 dev/prod；`--file` 可指定跳过拉取）+ 入口串联 `pnpm tsx scripts/holdings-sync/sync.ts`（fetch → upload 一键）
- [X] T020 [US1] [Manual] **端到端人工验收矩阵**（证据贴 PR-3 描述）：真实拉取（含登录态复用二跑）→ 上传 dev server → EP2/App 回显比对真实数据（SC-001 <10s 实测 + SC-004 全量核对）→ 重跑幂等（SC-002）→ refresh 轮转续期路径（state_branch #9：token 过期→续期→重试成功）→ spec frontmatter `status: implemented` 翻 + tasks 全 `[X]` 核对

---

## Dependencies & 执行序

```text
T001 ──→ T002 [P]──→ T003 ──→ T004 ──→ T008 ──→ T009 ──→ T010   (PR-1)
   └────→ T005 [P] / T006 [P] ──┘         ↑
   └────→ T007（依赖 T004 的 quotable 落列）┘

PR-1 merge ──→ T011 [P] ──→ T012 ──→ T013 ──→ T014 ──→ T015 ──→ T016 ──→ T017   (PR-2)
PR-1 merge ──→ T018 [P] ──→ T019 ──→ T020   (PR-3，与 PR-2 并行)
```

- **MVP = Phase 1**（US1 + US4 server 面：导入落库 + 持仓组点亮——curl 即可用）；Phase 2 交付 US2/US3 展示面；Phase 3 交付日常同步闭环。
- 并行机会：T002 与 T005/T006（不同文件）；T011 与 T018（跨 PR）；PR-2 与 PR-3 整体并行。
- **Clear 检查点批次**（Constitution §III）：T001-T003 / T004-T007 / T008-T010 / T011-T014 / T015-T017 / T018-T020。
