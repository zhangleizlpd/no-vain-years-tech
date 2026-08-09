---
feature_id: 021-alert-management
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-06'
updated_at: '2026-06-06'
adr_refs: ['0024', '0032', '0033', '0043', '0048', '0049']
context7_verified: []
---

# Implementation Plan: 021-alert-management（预警管理 V1 — EOD 价格预警 + 应用内消息中心）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `021-alert-management` | **设计源**: [需求对焦](../../docs/private/plans/2026-06/06-06-alert-management-v1-scope.md) | **Mockup baseline**: [`design/`](./design/)（`brief.md` + `handoff-claude-design/股票预警管理.html` + `AlertScreens.jsx` + `AlertKit.jsx`）

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011-020）。
> **统一 mockup-first 流程**（per [sdd.md](../../docs/conventions/sdd.md)）：spec ✅ → clarify ✅（2026-06-06 3Q）→ mockup ✅（handoff 已验收归档，chrome 色映射 brand 蓝定稿）→ **plan（本）** → tasks → impl。
> **⚠ 头号架构事实**：**`alert` = 第 6 个 bounded context**（catalog Q4 命中，**ADR-0052 随 PR-1 落地**）。跨 ctx 面只有**两条 Q7-B 只读直查**（alert → marketdata `daily_bar`/`instrument`，018 先例，`CROSS-CONTEXT-READ` 探针强制）；**调度自治**（不挂 017 调度链、不做 outbox consumer，见 D1）。

## Summary _(mandatory)_

021 = 预警闭环三件套：**① 预警 CRUD**（统一模型：1..N 条 AND 条件、同类型限 1、三档提醒频率、≤22 字备注、启停）→ **② EOD 评估引擎**（alert 自治 BullMQ repeatable cron，每晚 23:00 + 翌晨 08:00 catch-up，幂等 by `(alertId, tradeDate)` 唯一键；直接遍历求值不上 AST）→ **③ 应用内消息中心**（AlertTrigger 兼任消息源 + per-account 已读水位线 → 未读角标）。

- **server 段（主体）**：新 bounded context `apps/server/src/alert/`，4 张新表（`alert` / `alert_condition` / `alert_trigger` / `alert_read_cursor`，Prisma schema `alert`）；8 个端点（CRUD×5 + 消息×3）；评估引擎 = 纯函数求值 + Q7-B 读 marketdata none 口径 bar。
- **mobile 段**：新 feature dir `apps/mobile/src/alert/`（7 屏 + 2 sheet，mockup 已定稿）+ 2 处既有页改造（014 `bottom-bar.tsx` bell 接通、013 `watchlist-main-screen.tsx` 工具栏三 icon）。行情条/全部预警组头走 **015 EP2 批量报价 client-side merge**（013 `use-quote-merge` 同款，per ADR-0048 server 零跨 ctx 拉行情）；涨停/跌停 = 客户端纯函数 `limit-price.rules.ts`。

**新基础设施** = 4 张表 + 1 个 alert BullMQ queue（复用 marketdata Redis 连接 provider 模式）+ ESLint boundaries / moat 注册各 1 处。**零新外部依赖 / 零新 token / 零新 vendor**。

## API Contracts _(mandatory)_

| #   | Method | Path                                               | Auth   | Request                                                                                              | Response                                                                            | trace FR               |
| --- | ------ | -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| EP1 | GET    | `/api/v1/alert/instruments/{market}/{code}/alerts` | bearer | —                                                                                                    | **200** `AlertListResponse{ alerts[] }` / 401 / 429                                  | FR-S07, FR-M01         |
| EP2 | GET    | `/api/v1/alert/alerts`                             | bearer | —                                                                                                    | **200** `AlertListResponse{ alerts[] }`（含 market/code，分组归 client）/ 401 / 429  | FR-S07, FR-M04         |
| EP3 | POST   | `/api/v1/alert/alerts`                             | bearer | `CreateAlertsRequest{ instruments[{market,code}], conditions[{type,threshold}], frequency, note? }`  | **201** `AlertListResponse`（每标的各建一条，批量原子）/ 400 / 401 / 429             | FR-S01, FR-S02, FR-M09 |
| EP4 | PATCH  | `/api/v1/alert/alerts/{id}`                        | bearer | `UpdateAlertRequest{ conditions?, frequency?, note?, enabled? }`                                     | **200** `AlertResponse` / 400 / 401 / **404**（他人/不存在，反枚举）/ 429            | FR-S01, FR-S08         |
| EP5 | POST   | `/api/v1/alert/alerts/delete-batch`                | bearer | `{ ids: string[] }`                                                                                  | **200** `{ deleted: number }`（仅删本账号命中项）/ 401 / 429                         | FR-S01, FR-M05         |
| EP6 | GET    | `/api/v1/alert/messages`                           | bearer | `?cursor=&limit=`                                                                                    | **200** `MessageListResponse{ messages[], nextCursor? }`（triggeredAt 倒序）/ 401 / 429 | FR-S06, FR-M06         |
| EP7 | GET    | `/api/v1/alert/messages/unread-count`              | bearer | —                                                                                                    | **200** `{ unread: number }` / 401 / 429                                             | FR-S06, FR-M07         |
| EP8 | POST   | `/api/v1/alert/messages/mark-read`                 | bearer | —                                                                                                    | **200** `{ unread: 0 }`（水位线推到 now）/ 401 / 429                                 | FR-S06, FR-M06         |

- `Alert` shape：`{ id, market, code, conditions[{type,threshold}], frequency, note, enabled, createdAt }`；`threshold` Decimal 序列化 string（015 体例）。`type ∈ PRICE_RISE_TO|PRICE_FALL_TO|DAILY_GAIN_OVER|DAILY_LOSS_OVER`；`frequency ∈ ONCE_DELETE|ONCE_DISABLE|DAILY`（默认 DAILY）。
- `Message` shape：`{ id, market, code, instrumentName, tradeDate, conditions[{type,threshold,actual}], note, triggeredAt, unread }`（`unread` = `triggeredAt > readCursor`，server 计算）——正文「股价跌到13.00元（今日最低12.80元）」由 mobile 按 `{type,threshold,actual}` 渲染，文案不进契约。
- **校验（FR-S02，`alert-validation.rules.ts` 纯函数 + class-validator DTO）**：conditions 1..4、同类型限 1（DB `@@unique([alertId,type])` 双保险）、价格阈值 >0、涨跌幅阈值 ∈ (0,100]、note ≤22 字（Unicode code point 计）、market 仅 `cn`（V1）。违规 → 400 ProblemDetail（ADR-0038）。
- **批量创建原子性**：EP3 单 `$transaction` 建 N 条，任一校验失败整体 400（不部分成功，D5）。
- 鉴权：全端点 `JwtAuthGuard` + status==ACTIVE → 401；**他人资源 → 404 反枚举**（EP4/EP5 scope `where accountId`）。限流：复用 `AccountIdThrottlerGuard`，新 named 桶 `alert-read-account 120/60s` + `alert-write-account 30/60s`，`@SkipThrottle` 其余桶。
- **perf SoT** = spec frontmatter `perf_budgets`（EP1/EP6/EP7 100/200，EP2-EP5 150/300）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则                                               | 状态 | 备注                                                                                                                                                                          |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅ → mockup ✅ → plan（本）→ tasks → analyze → implement                                                                                                      |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | 求值/校验/涨跌停全走纯函数 vitest 红绿；CRUD/引擎/消息 Testcontainers IT 覆盖 spec `state_branches` 全 14 条；mobile 逻辑 vitest + UI Playwright                                |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | 三段式 PR（见 § Phase 2），tasks 按 30min-2h 拆                                                                                                                                 |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 新 ctx `alert` 文件平铺；4 表自持（moat owner 注册）；跨 ctx 仅 2 条 Q7-B 只读（`CROSS-CONTEXT-READ` 探针强制，018 先例）；boundaries 单向 alert→{account,security}，无人依赖 alert |
| V. 类型同步链 Nx-driven                            | ✅   | PR-1 ship CRUD+消息端点 + api-client regen 先 merge；PR-3 mobile 消费已落地 typed client（PR-1 描述 cite §V 例外）                                                              |

## Architecture Notes _(mandatory)_

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7Q，逐条 → **ADR-0052 随 PR-1 落地**）

| Q     | 问题                | 判定                                                                                                                                                                                                                                                                                       |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1    | 直改某 ctx 核心表？ | **No** — alert/trigger/cursor 全是新表，无既有 owner                                                                                                                                                                                                                                       |
| Q2    | 编排多 ctx 流程？   | **No** — 自持生命周期（CRUD/评估/消息全在 alert 域内闭环）                                                                                                                                                                                                                                 |
| Q3    | 纯 platform infra？ | **No** — 业务领域（监控引擎，master PRD §3.5 独立板块 E）                                                                                                                                                                                                                                  |
| Q4    | 完全新业务领域？    | **Yes** — 5 现 ctx 都不沾 → **新 bounded context `alert`**。判据：spec 6 US/14 state_branches 体量足；落 portfolio 会让其吃进「调度+引擎+消息」三类异质职责；消息中心 V1 仅预警消息暂归 alert，下期多消息源时再评估拆 `notification`（ADR-0052 记 seam）                                   |
| Q5/Q6 | R2 sync / R3 async？| **No** — 无跨 ctx 写、无 caller 等待、无 side-effect 通知他 ctx                                                                                                                                                                                                                            |
| Q7    | 独立跨 ctx 读？     | **Yes ×2 → Q7-B 直查**（018 终态先例，摊销判据同款：每晚一读 + 一句话重建，无投影对象）：① 评估引擎读 `marketdata.daily_bar`（none 口径最新 bar 的 high/low/close/prevClose/tradeDate）② 触发时读 `marketdata.instrument.name` 快照进流水。两处 `prisma.<table>.find*` 上方 **必须** `// CROSS-CONTEXT-READ:` 注释（moat 探针拒） |

**单向边**：`alert → account`（JwtAuthGuard/AccountIdThrottlerGuard，鉴权 artefact 非业务调用）+ `alert → security`（PrismaService/Redis infra）；**无人依赖 alert**（叶子 ctx）。ESLint boundaries 加 `{ type: 'alert', pattern: 'src/alert/**' }` + 依赖白名单（`apps/server/eslint.config.mjs:36-89`）；moat 注册 4 表 owner=alert（`apps/server/scripts/checks/check-server-moat.ts:53-99`）。

### 数据模型（Prisma schema `alert`，4 表，migration `yyyymmddhhmm_create_alert_context_tables`）

```text
Alert            @@map("alert") @@schema("alert")
  id BigInt autoincrement | accountId BigInt（逻辑引用，跨 schema 禁 FK，对齐 portfolio.Group 体例）
  market('cn') + code | frequency: ONCE_DELETE|ONCE_DISABLE|DAILY | note VarChar(64)?（≤22 字由 rules 校验）
  enabled Boolean default(true) | createdAt/updatedAt
  @@index([accountId, market, code]) @@index([enabled])

AlertCondition   @@unique([alertId, type]) ← 同类型限 1 的 DB 保险
  id | alertId FK(Cascade) | type String | threshold Decimal(18,4)

AlertTrigger     流水独立于 Alert 生命周期（FR-S05）
  id | alertId BigInt?（普通列无 FK：仅1次·删除后流水自立；判重键用）| accountId | market + code
  instrumentName（触发时 Q7-B 快照，消息正文用）| tradeDate Date
  conditionsSnapshot Json: [{type, threshold, actual}] | frequencySnapshot | noteSnapshot?
  triggeredAt default(now())
  @@unique([alertId, tradeDate]) ←「每日1次」判重 | @@index([accountId, triggeredAt Desc])

AlertReadCursor  已读水位线（屏级置已读语义，D6）
  accountId @id | lastReadAt
```

- **未读语义** = `count(trigger WHERE accountId AND triggeredAt > lastReadAt)`（无 cursor 行 = 全未读）；EP8 upsert 水位线为 now。**单一服务端真相 → 多设备一致**（SC-005）。
- **快照自洽**：消息渲染全部走 trigger 快照字段，不 join 活 Alert（删除后消息完整可读，spec Edge）。

### EOD 评估引擎（核心决策 **D1：调度自治**，不挂 017 / 不做 outbox consumer）

> **D1 理由**：spec FR-S04「EOD 同步完成后评估」的三个实现路径——(a) 注册成 marketdata SyncDimension 维度/executor 钩子 = **marketdata 反向知道 alert**（底座依赖业务，方向错；017 DIMENSION_KEYS/registry 是 marketdata 私有面，`dimension-executor.ts:28-35`）；(b) outbox 事件 `eod-sync-completed` → alert consumer = 消费端基础设施**尚不存在**（`outbox-event-cron.publisher.ts` 是 T041 placeholder，零真实 consumer），为单消费者建 relay 不摊销；(c) **alert 自治 cron + tradeDate 幂等** = 时间解耦 + 唯一键判重把「完成信号」弱化为「幂等轮询」，零跨 ctx 调度耦合。**取 (c)**；(b) 是下期多消费者出现时的演进路径（ADR-0052 记 seam）。

- **调度**：alert 自己的 BullMQ queue `alert-eval`（repeatable job，`Asia/Shanghai`：`0 23 * * *` 主跑——prod 三维度 22:00 同步后；`0 8 * * *` 翌晨 catch-up——兜同步晚到）。Redis 连接镜像 `marketdata-queue-connection.ts` provider 模式（`maxRetriesPerRequest: null`），alert 自持 `ALERT_QUEUE_REDIS` token 不共用 marketdata 连接对象。
- **幂等**：评估任意次重跑无害——触发写入撞 `@@unique([alertId, tradeDate])` → P2002 catch-skip。停牌/非交易日：标的最新 bar 的 tradeDate 已评估过 → 天然 no-op（**不需要 TradingCalendarPort**，D4）。
- **求值（`evaluate-alerts.usecase.ts` + `alert-evaluation.rules.ts` 纯函数）**：
  1. load 启用预警（含 conditions），按 `(market,code)` 去重取标的集
  2. `// CROSS-CONTEXT-READ:` 批量读各标的 **none 口径**最新 `daily_bar`（high/low/close/prevClose/tradeDate）+ `instrument.name`——**none = 真实成交价口径**（D8），用户阈值是对真实价格设的，与 020 读时换算无关
  3. 纯函数逐预警求值（**全部含等号**，D7）：`PRICE_FALL_TO: low ≤ threshold`｜`PRICE_RISE_TO: high ≥ threshold`｜`DAILY_LOSS_OVER: prevClose>0 && (close−prevClose)/prevClose ≤ −threshold%`｜`DAILY_GAIN_OVER: ≥ +threshold%`；`prevClose` null → 该条件不命中（spec Edge 新上市）；标的无 bar → 跳过
  4. 全条件命中 → 单 alert 小事务：`create trigger`（含快照 + actual 值）+ 后置动作（`ONCE_DELETE` → delete alert｜`ONCE_DISABLE` → `enabled=false`｜`DAILY` → 不动）
- **并发编辑策略（spec Edge 结算，D9）**：行级 last-write-wins；评估中用户删除该预警 → 后置动作 P2025 catch-skip（trigger 已落，消息仍达——合理：触发先于删除）；toggle 竞态同理。无 Serializable 必要。
- **手动触发**：`alert-eval.cli.ts`（mirror marketdata sync CLI 体例）供 dev dogfood / misfire 手补。
- **双模 seam（spec 留点）**：rules 纯函数签名吃 `{high,low,close,prevClose}` 快照——未来盘中模式只换数据来源（实时 tick 喂同形状），求值零改。

### Mobile side（`apps/mobile/src/alert/` 新 feature dir）

**Expo routes**（`app/(app)/alert/` 新 Stack + 既有改造）：

- `app/(app)/alert/index.tsx` 全部预警｜`[symbol].tsx` 个股预警（param `cn:603305`）｜`edit.tsx` 编辑/新建（params: alertId 或 instruments 批量）｜`add-condition.tsx`｜`select-target.tsx`｜`messages.tsx` 消息通知｜`_layout.tsx`（anchor + `makeHeaderBackOrParent` 硬刷新兜底，per memory）

**组件群（mockup `AlertScreens.jsx`/`AlertKit.jsx` 翻 RN，复用 `~/theme` token 0 重设）**：

- `alert-list-screen.tsx`（屏1 + 1b 多选态）/ `all-alerts-screen.tsx`（屏5，分组 + 就地 toggle）/ `alert-edit-screen.tsx`（屏2，本地草稿态：条件增删/频率/备注，完成一次提交）/ `add-condition-screen.tsx`（屏3，单分类 4 条件）/ `target-select-screen.tsx`（屏4，自选多选「去添加」批量 + 搜索即点即用；自选列表复用 013 `useWatchlistItems`、搜索复用 `add-watchlist-entry` 同源搜索 hook，D11）/ `message-center-screen.tsx`（屏6，进入即 EP8 mark-read）/ `frequency-sheet.tsx`（7a）/ `value-input-sheet.tsx`（7b）/ `alert-card.tsx` / `quote-strip.tsx`（行情条 5 字段）
- `limit-price.rules.ts` + spec（涨跌停纯函数，clarify #2）：代码段判板块（`688/689→±20%`、`300/301→±20%`、北交 `8x/4x→±30%`、其余 `±10%`）+ 名称含 `ST` → `±5%`；`round(prevClose×(1±pct), 2)`；新股首日等边角不准（接受）
- `use-alerts.ts` / `use-alert-messages.ts`（orval RQ hooks 包装 + 乐观更新 toggle + 错误分流 toast，013 `use-watchlist-items` 范式；**401 触发 003 refresh 拦截器，e2e 必 mock refresh 端点**，per memory）；未读角标 = unread-count hook（focus refetch，不轮询）
- `alert-copy.ts` 中文文案常量
- **行情 merge**：行情条/组头价用 015 EP2 批量报价 client-side merge（013 `use-quote-merge.ts` 同款复用）；alert 端点不内联行情（ADR-0048）

**既有页改造（2 处，surgical）**：

- 013 `watchlist-main-screen.tsx:125-130`：工具栏「＋」→ 三 icon：放大镜（开既有 `AddWatchlistEntry`，行为不变仅换图标）+ 预警铃铛（`router.push('/(app)/alert')`）+ 信封（`/(app)/alert/messages`，badge 红点 by unread-count）
- 014 `bottom-bar.tsx` bell：disabled 占位 → `router.push('/(app)/alert/' + symbol)`（去 onDisabledTap 路径）

**icon**：铃+闪电/信封/放大镜 = `~/ui` icon 体系核对，缺则按 mockup `AIcon` path 补 SVG（react-native-svg 已装）。

### Cross-cutting

- **同步链**：PR-1 swagger → `nx run server:export-openapi` → `nx affected -t generate` → api-client alert hooks regen 随 PR-1 merge；**nullable string DTO（note）必须显式 `@ApiProperty({ type: 'string', nullable: true })`**（per memory：orval 误生成 object-map）。
- **catalog**：operation 靠代码派生（`ls apps/server/src/alert/*.usecase.ts`），无需手维护表；ADR-0052 落 `docs/adr/`（编号续 0051）+ `check-adr-index` 过。
- **business-naming 三处同名**：`apps/server/src/alert/` + `apps/mobile/src/alert/` + Prisma `@@schema("alert")` 同 PR 链落齐（CI 拦）。
- **反枚举不变性**：401 统一（guard）；他人 alert PATCH/DELETE → 404；EP5 batch 只删命中本账号项不报错杂音。
- **prod 部署注意**：repeatable job 在 app boot 幂等注册（BullMQ job scheduler upsert）；发版重启不丢 cron（repeatable 落 Redis）+ 翌晨 catch-up tick 兜底。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #       | 决策               | 结论                                                                                                                                                                                       | gate?        |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **D1**  | 评估调度机制       | **alert 自治 BullMQ repeatable cron（23:00 + 翌晨 08:00 catch-up，Asia/Shanghai）+ tradeDate 唯一键幂等**；不挂 017（方向反）、不建 outbox consumer（infra 不存在，单消费不摊销）。ADR-0052 记 (b) 演进 seam | ⚠️ 请 review |
| **D2**  | 新 bounded context | **`alert` 第 6 ctx**（Q4 判定见上表）；消息中心 V1 暂归 alert，多消息源时再评估拆 notification                                                                                              | ⚠️ 请 review |
| **D3**  | 跨 ctx 读形态      | **Q7-B 直查 ×2**（daily_bar + instrument.name），018 终态先例同摊销判据；`CROSS-CONTEXT-READ` 注释探针强制                                                                                  | ✅ 018 先例  |
| **D4**  | 交易日判定         | **不用 TradingCalendarPort**——tradeDate 幂等键天然处理非交易日/停牌（最新 bar 已评估过 → no-op）；port 现状也仅 mock 无 live adapter                                                        | ✅ 默认接受  |
| **D5**  | 批量创建原子性     | EP3 单 tx 全建或全拒（部分成功的语义混乱 > 原子重试成本）                                                                                                                                   | ✅ 默认接受  |
| **D6**  | 消息已读粒度       | **屏级水位线**（AlertReadCursor.lastReadAt，进提醒 tab 即 mark-read）；不做 per-message 已读（V1 无此交互）                                                                                 | ✅ clarify 定 |
| **D7**  | 求值边界含等号     | 四类条件全部 ≥/≤ 含等号（「跌到 13.00」当日低=13.00 算触发）；IT 边界 case 必验                                                                                                             | ✅ 默认接受  |
| **D8**  | bar 口径           | **none（真实成交价）**——用户阈值是对真实价格设的；与 020 读时换算无关                                                                                                                       | ✅ 默认接受  |
| **D9**  | 并发编辑 vs 评估   | 行级 last-write-wins + P2025/P2002 catch-skip（评估中删除 → trigger 已落消息仍达）；无 Serializable                                                                                          | ✅ 默认接受  |
| **D10** | note 计数口径      | Unicode code point 计 ≤22（前后端同口径：mobile `[...note].length` / server rules 同式）                                                                                                    | ✅ 默认接受  |
| **D11** | 搜索 tab 数据源    | 复用 013 `add-watchlist-entry` 同源标的搜索（015 搜索端点 hook），不新建搜索端点                                                                                                            | ✅ 默认接受  |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) 新 ctx 但**形态极简**：扁平贫血 + 4 表自持 + 叶子无人依赖；引擎不上 AST/短路（4 类条件直接遍历，spec 已定不过度设计）。(2) 唯一「重」件 = BullMQ queue 自持——完全镜像 marketdata 既有 provider 模式，无新模式发明。(3) mobile 7 屏全是列表/表单/sheet（mockup 验收零新库），复杂度低于 014 的 K 线。

## Performance Budget

| Endpoint                                  | P95 (ms) | P99 (ms) |
| ----------------------------------------- | -------: | -------: |
| EP1 个股预警列表 / EP6 消息 / EP7 未读数  |      100 |      200 |
| EP2 全部预警 / EP3-EP5 写                 |      150 |      300 |

_SoT = spec frontmatter `perf_budgets`。评估引擎非端点：SC-002 要求同步完成后 5 分钟内评估+消息可见——23:00 cron 一轮全量（自用规模 ~几十预警）秒级完成，余量充足。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**三段式 PR**（021 server 体量 > 014，CRUD 与引擎独立可 ship）：

- **PR-1（server 骨架，feat(alert)）**：ADR-0052 + Prisma schema/migration（4 表）+ boundaries/moat/AppModule 注册 + CRUD 5 端点 + 消息 3 端点 + rules 纯函数 + Testcontainers IT（state_branches 校验/反枚举/水位线条）+ **api-client regen**（cite §V 例外）。
- **PR-2（server 引擎，feat(alert)）**：`alert-evaluation.rules.ts` 纯函数 + `evaluate-alerts.usecase.ts`（Q7-B 读 + 触发 tx + 后置动作）+ BullMQ queue/repeatable + CLI 手动触发 + IT（四类条件 × 边界含等号 × 三档后置 × 停牌跳过 × prevClose null × 幂等重跑 × 评估中删除竞态）。
- **PR-3（mobile，feat(alert)）**：7 屏 + 2 sheet + 2 既有页改造 + `limit-price.rules.ts` + hooks + vitest（limit-price/note 计数/多选态/badge 派生）+ `[Mobile-E2E]` hermetic（Playwright，mock alert 端点 + 015 EP2 + 003 refresh）+ `[Contract-Smoke]`（登录 → 批量建预警（2 标的）→ 列表/编辑/toggle → 注入 trigger → unread-count → mark-read，落 `apps/mobile/e2e/contract-smoke/alert.contract.ts`）。

> 依赖：015 EP2（行情 merge）/ 013 hooks（自选列表+搜索复用）已 ship；无外部前置。

### 建议 tasks.md 层级（每 task 30min-2h，预估 **~15-18 task**）

- **PR-1 ~6**：`[Server]` ADR-0052+注册面（schema/migration/boundaries/moat/module）→ `[Server]` 校验 rules 红绿 → `[Server]` CRUD UC（create-batch/update/delete-batch）+controller → `[Server]` 消息 UC（list/unread/mark-read 水位线）+controller → `[Server-IT]` state_branches 全条 → `[Contract]` export-openapi+regen+`[Verify]`
- **PR-2 ~4**：`[Server]` 求值 rules 纯函数红绿（四类×边界）→ `[Server]` evaluate UC（Q7-B+tx+后置）→ `[Server]` queue/repeatable/CLI → `[Server-IT]` 引擎全分支+幂等
- **PR-3 ~6-8**：`[Mobile]` limit-price rules+quote-strip+alert-card → `[Mobile]` hooks（use-alerts/use-alert-messages+乐观 toggle）→ `[Mobile]` 屏1+5（列表+分组+多选删）→ `[Mobile]` 屏2+3+sheets（编辑草稿态）→ `[Mobile]` 屏4+6+routes+2 既有页改造 → `[Mobile-E2E]` → `[Contract-Smoke]`

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-06 | **ID-namespace**: US1-6 / FR-S01..S08 / FR-M01..M09 / SC-001..006 | **ADR**: 0052（新 ctx alert + 调度自治，随 PR-1 落）/ 0048（Q7-B 先例）/ 0043（扁平贫血）/ 0033（outbox 演进 seam）/ 0049（017 体系，明确不挂）
