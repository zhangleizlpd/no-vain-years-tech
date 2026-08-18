---
feature_id: 060-anchor-cold-start-backfill
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-17'
updated_at: '2026-08-17'
adr_refs: ['0032', '0033', '0035', '0040', '0041', '0043', '0049', '0053', '0062']
context7_verified: []
---

# Implementation Plan: 锚首建冷启动补数

## Summary *(mandatory)*

建锚事务内发一条 outbox 事件，marketdata 侧 subscriber 消费后往**既有** `marketdata-sync` 队列入一个新 named job；该 job 按锚所属市场算出「最近一个已收盘交易日」，补齐期权链与正股日线（不受盘中约束），并在该市场非连续竞价时段时用既有 `SyncOptionSnapshotUseCase.collect(spec)` 补当场期权快照。**零新依赖、零新端点、零 mobile 面**；新增一张只记结局的运行记录表。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

> 显式 no-op 声明。全部落在既有栈内：outbox 三件套（`security/outbox/`）、BullMQ（`bullmq@^5.78`，已在 `marketdata-sync.worker.ts` 用）、`@nestjs/schedule`（本片**不新增** `@Cron`）、Prisma 新表。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

| 原则 | 判定 |
|---|---|
| **I. SDD**（禁跳步） | specify → clarify（4 问已答，`status: clarified`）→ 本 plan。**无 UI ⇒ 无 Mockup 步**（Constitution §I 明示后端 use case 无此步） |
| **II. Test-First TDD** | 每 task 红→绿→typecheck/lint→`[X]`→stage→commit。两个纯函数文件先红（D4 的三元组表 + D6 的时段表），编排与 subscriber 走 Testcontainers IT |
| **III. Atomic Task 30min-2h** | tasks 阶段按「时段表纯函数 / 三元组纯函数 / 新表+migration / subscriber / 编排 use case / worker 路由 / 事件生产 / IT」切，每条独立可 commit |
| **IV. Module Boundary** | 见 D2 的方向铁律专段。**新增写面全在 `marketdata` 自有表**；optionsdesk 侧只多一行 `publish(tx, …)`（platform infra，ADR-0041 无跨 ctx 注释要求）。两侧 outbox **互不 import**，只各持一份事件类型字面量副本 —— 这不是风格选择，是 eslint 硬拦（见 D1） |
| **V. 类型同步链** | **零新端点** ⇒ 无 swagger 装饰器改动、无 `export-openapi`、无 `packages/api-client` regen、无 mobile 两层验证。冷启动全程无对外 HTTP 面 |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: Testcontainers 真 PG 下走通 —— 建锚 → `outbox_event` 落行（含回滚场景断言两者都不在）→ subscriber 入队 → 编排 use case 的各分支。spec 的 24 条 `state_branches` **逐条**对应 `it()` 块（Testing Invariants 第 3 条 EXHAUSTIVE BRANCHING）。
- [x] **Mobile / Web**: **N/A** —— 本片零前端面（spec `web_compat: na`），无 user-facing 屏可走。
- [x] **Evidence**: 待 impl 阶段填 IT commit。**验收硬条件三条**：
  1. 盘中分支下 `optionDailySnapshot.count()` **零变化**（US2 的全部价值）。
  2. **「数据已在、运行记录表为空」⇒ 零外呼**（FR-016a 的机器证据）。构造法：直接插入目标交易日的快照 / 日线行，**不**写任何运行记录，再触发冷启动 → 断言 vendor port 零调用。谁把复判实现成「读运行记录判这只锚做过没有」，这条立刻红。
  3. **删锚后重建 ⇒ 运行记录表两行**（FR-026a 的机器证据）。重建得到新 `anchor_id` ⇒ 新行；若有人把 PK 写成 ticker，就只会有一行，这条立刻红。
  ⚠️ **不要写「两只锚指向同一标的」的用例** —— `anchor.ticker` 是 `@unique`，今天在库里插不进去。多用户场景本身不可测，可测的是上面两条**判据维度**。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** — 本片不引入任何第三方 package / SDK / tool（见 Dependencies 表的 explicit no-op）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** 本片触碰的三处全是 mono 原生：`optionsdesk`（2026-08 新建的第 10 ctx，ADR-0062）、`marketdata`（mono 原生，016 起）、`security/outbox/`（ADR-0033，mono 原生）。无 Java 类名 / Maven 坐标 / Spring 路径可漂。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| **ADR-0033** | 「Worker 失败重试策略（指数退避 / dead-letter）—— 起步 N=3 简单重试，DLQ 留 Plan 3 ship」 | **accepted-as-is** | 本片的有界重试**不落在 outbox relay 层**，而落在 BullMQ job 层（既有 `attempts` + 指数退避 60s 起）。relay 层仍是无界重投，本片靠 D2 的「抛 / 不抛」判据不让它变成毒丸循环。DLQ 仍 defer |
| **ADR-0033** | 「跨 context publisher 出现时 `producer_context` 切 `event_type` prefix 自推 vs caller 显式传 —— 第一个其他 context 发 event 的 feature surface 时决定」 | **accepted-as-is** | optionsdesk 是新的 producer context ⇒ 该问题被本片 surface。定为 **caller 显式传** `'optionsdesk'`，与 `ideation/generate-brief.usecase.ts` 显式传 `'ideation'` 的既有先例一致。不改 port 签名、不引入 prefix 自推 |
| **ADR-0062** | `sunset_trigger` #3：「出现第二个消费锚表的 ctx（**除 marketdata 采集闸外**）→ 锚表升级为多消费者读模型」 | **accepted-as-is** | **判据的排除条款正好覆盖本片**：读锚表的仍只有 marketdata（本片新增的读发生在同一个 ctx、同一条 Q7-B 只读边上），消费方数量不变 ⇒ 不触发 |
| **ADR-0062** | `sunset_trigger` #1：「盘中实时 spot 上线 → 跨 ctx 读形态升格为强一致同步读」 | **accepted-as-is** | 本片**不引入实时 spot**：冷启动恰恰在盘中**拒绝**写快照。`last_close` + asOf 仍是唯一价源 ⇒ 不触发 |
| **ADR-0053** | 跨 ctx 纯函数 import 细分边（`marketdata-rules`） | **accepted-as-is** | 本片新增的 `market-session.rules.ts` 落在既有 `src/marketdata/*.rules.ts` 元素内，`from: alert` 的 disallow 未列 `marketdata-rules` ⇒ alert 可 import，**零 eslint 配置改动**。细分边的语义原样成立（见 D6） |
| **ADR-0035** | 「`db:migrate` wrapper 的 graceful rollback」 | **accepted-as-is** | 本片 migration 是纯 expand（单条 `CREATE TABLE`），无破坏性变更、无回滚需求 |

**Evidence**: `grep -ln "Open Question" docs/adr/*.md` + 逐个核对 `sunset_trigger` frontmatter。**无需 ADR amend / 新 ADR** —— 上表全部 accepted，无 escalated。

> 📌 顺带纠正一处 stale：ADR-0033 文末「consumer 端当前未实装」已过期 —— `OutboxSubscriberRegistry` + `agent-bridge/enqueue-requirement.subscriber.ts` 早已跑通。**本片不回改 ADR 正文**（那是冻结决策记录），仅在此注明，免得下一个人照那句话以为要自建消费侧。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支（本片 **24 条**），**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（并发 / 安全）

- **并发/事务**：outbox 事件 `publish(tx, …)` 与锚行 + `anchor_change` **同 `$transaction`**（任一失败一起回滚）。外部 I/O **split-tx**：vendor HTTP 一律在事务外，**禁** tx 内持锁等 HTTP。运行记录表的写走单行 upsert（每锚一行，覆盖式）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：本片**零新对外面**（无端点、无 guard、无凭证比较）⇒ 反枚举 / 哈希 / PII 三条均不适用。触发者是既有建锚动作本身。

---

### D1 事件生产 —— 单点，两条创建入口自动覆盖

在 `optionsdesk/create-anchor.usecase.ts` 的建锚事务内：

```
// CROSS-CONTEXT-ASYNC: optionsdesk.anchor-created
await this.outboxPublisher.publish(tx, 'optionsdesk.anchor-created', { anchorId, ticker }, 'optionsdesk');
```

**只改这一处就满足 FR-002**，靠的是结构而不是纪律：`ImportAnchorFromModelUseCase` 的 create 分支是**委托** `CreateAnchorUseCase`（`import-anchor-from-model.usecase.ts:130`），App 手工建锚走 `optionsdesk.controller.ts:424` 也是它。⇒ 两条入口共用同一个 publish 点，将来加第三条入口只要仍走 `CreateAnchorUseCase` 就自动被覆盖。**MUST NOT 在 import use case 里再 publish 一遍**（那会双发）。

- **只在 create 分支发**，update 分支一行不动（FR-003）。
- payload 只带 `{ anchorId, ticker }`；**market 由消费侧从 ticker 前缀解析**（FR-020），不在生产侧预解析 —— 生产侧解析等于把市场知识复制到第二处。
- `OUTBOX_PUBLISHER` 由 `SecurityModule` export，属 platform infra（ADR-0041）⇒ 注入点**无** cross-ctx 注释要求；但 `publish` 调用点上方 **SHOULD** 标 `// CROSS-CONTEXT-ASYNC:`（R3 惯例，探针不扫、靠 CR 引导）。

🚨 **事件类型字面量两侧各持一份副本，禁 import。** `apps/server/eslint.config.mjs:190-204` 的 `from: { type: 'marketdata' }` disallow 列表**含 `optionsdesk`** ⇒ marketdata 侧 import 任何 optionsdesk 的导出都会被 boundaries 拦。这正是 ADR-0043 R3「双方互不 import、只共享 event-type 字符串字面量」的物理成因。两处各写 `'optionsdesk.anchor-created'`，**靠 IT 钉住二者相等**（subscriber 的 `eventType` 必须等于生产侧实际写进 `outbox_event.event_type` 的值），不靠人眼。

### D2 事件消费 —— subscriber 只做「校验 + 入队」，抛与不抛的判据必须精确

新建 `marketdata/anchor-cold-start.subscriber.ts`，`implements OutboxSubscriber, OnModuleInit`，`onModuleInit` 里 `registry.register(this)` 自注册（IoC，security 不反向依赖业务）。形态逐字照抄 `agent-bridge/enqueue-requirement.subscriber.ts`。

🚨 **subscriber 内绝不同步跑采集** —— outbox relay 是 `@Cron(EVERY_10_SECONDS)` 单线，一次链 + 快照采集是分钟级，同步跑会把 relay 整条顶住（所有 ctx 的事件一起卡）。subscriber 只：解析 ticker → 入一个 job → 返回（毫秒级）。

🚨 **两类失败的处置方向相反，写成一条会各错一半**：

| 失败 | 处置 | 为什么 |
|---|---|---|
| payload 形状不符（毒丸） | `logger.error` + **return，不抛** | 抛了 relay 每 10s 重投同一条，永久卡死且挡住后面所有事件（`enqueue-requirement.subscriber.ts:49-54` 明写的教训） |
| 入队失败（Redis 不可达等基建故障） | **抛** | 那不是毒丸，下轮重投正是正确处置；吞掉会把事件标成 published 而冷启动永远丢失 |

- 幂等：relay 是 at-least-once，`sourceEventId` 可用于去重 —— 但本片**不用**它。重复投递由 job 的起手复判吸收（判据是「该标的该交易日的数据在不在」，见 D5），一处判据同时管住重复投递与常规轮已采两种情形。

**方向铁律的处置**：outbox 两侧无 import 边（D1 已述），marketdata 只多知道一个字符串。运行时上 marketdata 早已知道锚存在（`anchor-driven-sync-gate.ts:109` 的 `CROSS-CONTEXT-READ`）。subscriber 落 marketdata 侧的理由是**工作在哪、消费方就在哪**（本片全部写面都是 marketdata 自有表），与 `agent-bridge` 消费 `ideation.*` 同构。

### D3 执行体 —— 新 named job，走同一条 `marketdata-sync` 队列

🚨 **必须复用 `marketdata-sync` 队列**（`marketdata-sync.worker.ts:30`，`concurrency=1`）。另起一条队列 = 冷启动与夜间批**并发打 vendor**，直接撞限频 —— 那条 `concurrency=1` 是限频的支柱（FR-017 / SC-004 全靠它）。

- 新 named job **`sync:anchor-cold-start`**，**自有 payload 类型**（`{ ticker: string }`），worker 按 `job.name` 加一条路由分支（既有分支路由到 `DimensionExecutorRegistry`，本 job 走新分支）。
- `attempts` + `backoff`（指数，60s 起）复用 `MarketdataSyncQueue.jobOpts` 的既有语义（FR-019a）。
- 🚫 **蓄意不给 `DimensionJobPayload` 加 `codes` 收窄字段。** 那会给「工作集选择」开第二个口子，正是 `anchor-driven-sync-gate.ts:50-55` 那条绊线注释（`needSync` 是受保护列、只有两个合法写入点）警告的形态。建锚是个位数/天的低频动作，跑一轮全集（T011 实测 13 只锚 4'32"）比开这个口子便宜。

新建 `marketdata/anchor-cold-start.usecase.ts` 承载编排（顺序有硬依赖，见 D9）：

```
1. 解析 market；不可解析 / 未登记时段 / 未开通期权采集 ⇒ 记结局后返回（零外呼）
2. 目标交易日定位（查日历，见 D4）；查不到 ⇒ 结局 blocked + ERROR，不猜日期
3. Instrument 行缺失 ⇒ seed
4. AnchorDrivenSyncGate.recalcSafely()（幂等开闸）
5. 起手复判：**本锚的标的**在目标交易日的数据是否已具备；已具备 ⇒ 结局 already_covered，零外呼
6. 非敏感档：组 flow 入队 sync:us_equity_bar + sync:option_contract（普通 delta，不指定 asOf）
7. 敏感档：盘中 ⇒ 结局 intraday_skipped；非盘中 ⇒ 按 D4 算 spec → SyncOptionSnapshotUseCase.collect(spec)
8. 落运行记录
```

### D4 三元组决策 —— 本片唯一「差一天不报错」的判据

新建 `marketdata/anchor-cold-start.rules.ts`（纯函数、零 I/O，日历查询由调用方做完再喂进来）。

设 `today = marketDateFor([market], now)`，`target` = `trading_day` 中 ≤ `lastClosedSessionCutoff(market, now)` 的最大交易日：

| 条件 | `sessionDate` | `source` | `oiAsOf` |
|---|---|---|---|
| `target` 查不到（日历缺行） | — | — | **不猜，放弃 + ERROR**（照抄 remediation 的 `blocked`） |
| `today === target`（仍在目标 session 收盘当日的盘后） | `target` | `eod` | `target` 的**上一个交易日** |
| `today > target` 且 `today` **是**交易日（已进下一交易日盘前，OI 已翻新） | `target` | `premarket_backfill` | `target` |
| `today > target` 且 `today` **不是**交易日（周末 / 节假日，OI 未翻新） | `target` | `eod` | `target` 的上一个交易日 |

逐条对表（us，北京时刻）：

| 时刻 | ET | `today` | `target` | 判定 |
|---|---|---|---|---|
| 周六 10:00 | 周五 22:00 | 周五 | 周五 | `eod`，`oiAsOf`=周四 |
| 周一 10:00 | 周日 22:00 | 周日（非交易日） | 周五 | `eod`，`oiAsOf`=周四 |
| 周一 18:00 | 周一 06:00 | 周一（交易日） | 周五 | `premarket_backfill`，`oiAsOf`=周五 |
| 周二 10:00 | 周一 22:00 | 周一 | 周一 | `eod`，`oiAsOf`=周五 |

这条规则把既有 `option-snapshot-remediation` 的**两条固定路径推广成一个连续函数**，且在它自己的两个时点（北京 08:00 / 18:00）上取值**逐字相同** ⇒ **回归断言就用「与 remediation 同点等值」**，谁改坏了立刻红。

🚨 **`oiAsOf` 两条路径 MUST NOT 抹平** —— `sync-option-snapshot.usecase.ts:196-204` 明写：抹平后永远不会红，但两条路径产出的 OI 差一天，而活跃度排名与 UI 的 `asOf` 都读它。

🚨 **MUST NOT 补「最近 N 天」** —— `option-snapshot-remediation.ts:52`：只有**紧邻的上一个 session** 能从当下快照原样补回，再往前一天拿到的是错的收盘价。本片只补 `target` 一天（FR-008）。

📌 **一个继承来的口径，不要当成本片的疏漏去「修」**：北京 06:30 的常规快照轮 = ET 17:30/18:30，本就落在美股盘后延长时段（16:00–20:00 ET）内。所以「非连续竞价时段即可抓」这条闸与既有实现同口径，本片沿用而非新引入；成立前提是期权盘后基本无成交、`last` 仍是收盘态。

### D5 **无合流机制** —— 幂等键取标的 + 交易日，不取锚 / 用户

**一条建锚 = 一条消息 = 一个 job，各自执行，零去重逻辑**（FR-019c）。合流在当前系统里没有对应场景：`ImportAnchorFromModelUseCase` 是 by-ticker 的单只接口，App 建锚也是单只 —— 批量路径根本不存在。将来真有批量入口，收敛做在**消息形态**上（一条消息带多只锚），不在消费侧加去重。

丢掉合流**不损失任何东西**：非敏感档本就跑全量工作集，所以 B 锚若在 A 的那一轮还排队 / 执行时创建，B 的 job 起手复判就会判「已具备」⇒ 零外呼；只有 B 在 A 那轮跑完之后才建，才会真跑第二轮 —— 而那时 B 确实需要。合流想要的效果由既有的「起手复判 + 全量工作集」顺带给出。

🚫 **顺带记下不要去够 BullMQ `jobId` 去重**（下一个人想做合流时第一反应就是它）：`jobOpts` 的 `removeOnComplete: { count: N }` 会**保留**已完成 job，同 `jobId` 再入队被静默忽略并返回旧 job ⇒「先建 A（跑完并保留）→ 再建 B」时 B 的冷启动被吞、B 永远没数据，**队列与日志都不会红**。这也是仓内「幂等靠 DB 唯一键、不靠队列去重」那条纪律的具体成因。

#### 🚨 幂等键的维度 —— 今天与将来都必须是「标的 + 交易日」

锚现在不区分用户（`anchor.ticker @unique`，一个标的至多一只锚），**将来一旦区分，同一标的会有 N 只锚**。而期权链 / 快照 / 日线是**跨锚、跨用户共享的标的级事实**，不属于任何一只锚。

落库层天然安全 —— 三张表的唯一键本就是标的级的：`option_daily_snapshot(contract_id, session_date, source)` / `option_contract(market, code)` / `daily_bar(instrument_id, trade_date, adjust)`。**会出事的只有两处，都在本片新写的代码里**：

| 位置 | 错的写法 | 后果（多用户下） | 正确写法 |
|---|---|---|---|
| 起手复判（FR-016a） | 「这只**锚**冷启动过没有」（去读运行记录表） | 同标的的 N 只锚各判「没做过」⇒ 同一份共享数据被拉 N 遍 | 「**该标的在目标交易日**的数据是否已具备」—— 查 `option_daily_snapshot` / `daily_bar` 本身 |
| 运行记录主键（FR-026a） | PK = ticker | 两只锚**撞同一行、互相覆盖结局**（先建的「已补齐」被后建的「已具备零外呼」盖掉） | PK = `anchor_id` |

两条今天与「按锚判」**完全等价、零额外成本**，所以现在就按正确的写 —— 不是给未来加设计，是别现在就写错。

⚠️ 复判 **MUST NOT 反过来读运行记录表**来决定要不要跑：那张表是审计面（D7），不是数据存在性的真相源；把它当判据就正好落进上表左列。

### D6 盘中时段表 —— 新建 `marketdata/market-session.rules.ts`，并把 alert 那份下沉合并

**现状**：唯一的盘中时段实装在 `alert/intraday-eval.processor.ts:39` 的 `MARKET_SESSION`，**只登记了 `cn`**；未登记市场 `isWithinTradingSession` 直接 `return false` ⇒ 原样拿来判美股会**恒判为非盘中、盘中照抓**，正是本片要防的那件事。而 `trading-day-gate.ts:120` 的 `MARKET_CLOSE_MINUTES` 注释明写它「**不是**盘中时段表 —— 午休段归各消费方」。本片出现第二个消费方，散在两处必漂。

**落点判据是 eslint 实测出来的，不是偏好**：

- `from: { type: 'alert' }` 的 disallow 列了 `marketdata`、**没列 `marketdata-rules`**（`eslint.config.mjs:231-245`）⇒ **alert 可以 import `src/marketdata/*.rules.ts`**，合并零配置改动。
- ⚠️ 反向不成立：`from: { type: 'optionsdesk' }` 的 disallow **含** `marketdata-rules`（`:334-346`）⇒ optionsdesk **不能** import 它。本设计里 optionsdesk 不需要（冷启动全在 marketdata 侧）—— 但这条得记住，将来若把盘中判断挪进 optionsdesk 会直接撞墙。

**做法**：把 `MARKET_SESSION` / `marketNow` / `isWithinTradingSession` 三个导出搬进新文件，登记 **cn（原样搬）+ us + hk**（hk 含午休两段 09:30–12:00 / 13:00–16:00），alert 改 import。走 `Intl` 而非手工偏移（DST）；未登记市场 **throw**（照抄 `marketNow` 现有纪律：静默套用别的市场的时段正是要根除的失败形态）。`INTRADAY_MARKET = 'cn'` **留在 alert**（那是 alert 的策略，不是时段表的事）。

🚨 **impl 期补一个导出（2026-08-17，user 定案）**：新文件除上述三个外还导出 `isSessionUnderway(market, minutesOfDay)` —— 「该场进行中」（首段开盘 → 末段收盘，**含**午休），未登记市场**抛**。D3 第 7 步与 D8 的敏感档闸用**它**，不用 `isWithinTradingSession`：后者在午休返 `false` ⇒ 放行，而此刻 D4 算出的目标日是**上一个交易日** ⇒ 把午休盘口标成「上一场收盘」，正是 FR-011 与 `state_branches` ③ 要防的错行。今天潜伏（us 无午休 ⇒ 两谓词等价），接 hk 期权即显形。

⚠️ **一处必须注意的连带**：合并后 `us` / `hk` 从「未登记」变成「已登记」，`marketNow('us', …)` 不再 throw。alert 侧唯一调用点是 `INTRADAY_MARKET='cn'`，**运行时行为零变化**；但 alert 现有 spec 里若有「未登记市场 throw」的断言用了 `us`/`hk` 当例子，会红 —— 那是**真实的语义变更**，改断言时要换一个仍未登记的市场代号，不要把断言删掉。

### D7 新表 `anchor_cold_start_run` —— 只记结局，不驱动重做

- **落 `marketdata` schema**（写方在 marketdata）。🚨 `scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP` **必须登记** `anchorColdStartRun: 'marketdata'`，否则 `moat-unmapped` 硬拒（ADR-0062 Consequences 已写明这条）。
- **每只锚一行，PK = `anchor_id`**（不是 ticker —— 见 D5 的幂等键表：ticker 作主键在锚按用户区分后会让两只锚撞同一行、互相覆盖结局）。`ticker` 作普通列留着，纯为排障可读。其余字段：最近一次运行时刻 / 结局 / 原因文本 / 目标交易日。写入走**单行 upsert**（覆盖式，只保留最近一次 —— FR-026 只要求「最近一次」）。
- `anchor_id` 是**逻辑引用、不建 FK**（跨 schema，且体例同 `anchor_change` 的 `anchor_id`：删锚不级联）。删锚后重建会得到新 id ⇒ 新行，语义正确。
- **结局值域 = FR-027 的八种，贫血字符串列**，不建 PG enum（照 `anchor_submission` 三态的先例）。八种取值必须在 IT 里被逐个断言到（SC-009）。
- **索引只建 PK** —— 日均个位数、查询形状就是按 ticker 点查，撒 B-tree 是 cargo cult（同 059 §6 的判据）。
- 🚫 **不复用 `sync_run`** —— `schema.prisma:1020` 明写「塞非维度行会污染 `report.sh` 逐维度解析 + 全景 IT 维度计数断言」。这与 044 的 `CalendarSyncHealth` 做的是同一个判断，本片是第二次。
- migration 纯 expand（单条 `CREATE TABLE`）⇒ 单 PR 合规（ADR-0035 + `.claude/rules/migration-rules.md §2`）。目录名走 `pnpm db:migrate "add anchor cold start run"` wrapper 自动生成 `<yyyymmdd>_<hhmm>_add_anchor_cold_start_run`（lefthook `migration-naming-check` 正则 `^[0-9]{8}_[0-9]{4}_[a-z][a-z0-9_]*$` 硬拦）。

🚨 **这张表不是待办队列**：没有任何代码读它来决定「要不要重做」。盘中未做的部分仍由当晚常规轮补齐（FR-013）。写成待办队列就等于建了第二套补偿机制。

### D8 分档执行 —— 敏感档 MUST NOT 走维度 job 的 `run()`

| 档 | 维度 | 做法 |
|---|---|---|
| 不敏感 | `option_contract` / `us_equity_bar` | 组 flow 入队**普通 delta job**，**不指定 `asOf`**（FR-012a：日线维度自带回看窗会把近期缺口一并补上）。flow 保证链 → 快照的 hard 依赖次序 |
| 敏感 | `option_daily_snapshot` | 直调 `SyncOptionSnapshotUseCase.collect(instruments, spec, stats)`，`spec` 由 D4 算出 |

🚨 **敏感档不能复用 `SyncOptionSnapshotUseCase.run()`** —— 那条路径写死 `sessionDate = marketDateFor(dim.marketScope, input.now)` + `mode = SNAPSHOT_SOURCE_EOD`（`:182-188`）。在盘前窗口（北京 18:00 那一档）它会把 `sessionDate` 标成**今天**（尚未收盘的那天），而我们要的是 `target`。`collect(spec)` 是**唯一**能显式指定 `sessionDate` 的入口。

📌 `us_equity_bar` 其实**确实吃** `input.asOf`（`dimension-executor.ts:658` `targetDate: input.asOf`，与三个期权/us 维度刻意忽略 asOf 不同）—— 但本片仍不用它。多一条与常规路径不同的分支只会多一处可漂的判据（FR-012a）。

### D9 前置顺序 —— seed → 开闸 → 载工作集，不能反

1. **Instrument 行缺失 ⇒ 先 seed**（复用 `SyncOptionContractUseCase.seedAnchoredInstruments` 的同一判据：`needSync` 落 `false`，`name` 落 code 占位）。
2. **`AnchorDrivenSyncGate.recalcSafely()`** 幂等开闸（把新锚的 `needSync` 翻 `true`）。
3. **之后**才载工作集。

🚨 顺序反了会静默拿到空工作集：gate 只认**已存在**的 Instrument 行，而新锚在 universe 轮到它之前可能一行都没有（059 T011 实证的那只 us 标的建锚前 `daily_bar` 0 行）。

### D10 重试语义分三层，混同任何两层都会静默丢事

| 层 | 语义 | 落点 |
|---|---|---|
| outbox relay | **无界**重投（`handle` 抛 → 不标 published → 下轮再来） | 靠 D2 的「抛 / 不抛」判据不让它变成毒丸循环 |
| BullMQ job | **有界** `attempts` + 指数退避；耗尽 → `QueueEvents('failed')` → ERROR log + 结局落 `retry_exhausted` | FR-019a |
| vendor 配额耗尽 | **顺延重入队、不耗 attempts**（`OptionChainBudgetExhaustedError` / `OptionSnapshotBudgetExhaustedError` 两个既有具名错误） | FR-019b —— 靠**复用既有 catch 分支**成立，不新写判据 |

告警只走 log-based（既有 `QueueEvents.on('failed')` 统一出口）。🚫 **不在 server 代码里直接发飞书** —— `scripts/checks/check-scheduled-tasks.ts` 机器强制「飞书 wire-format 只许出现在 `ops/lib/feishu-send.sh`」。

### D11 本片明确不做

- **不新增任何 `@Cron`**（触发全靠事件）。
- **不动** `FUTU_PREFIX_TO_MARKET`（当前只有 `US:'us'`）、期权维度的 `market_scope={us}`、`ANCHOR_GATED_MARKETS=['us']` —— 那三处是并行 HK 集成的地盘，同时改会撞车。hk 在本片只体现为：时段表登记了它，且「哪些市场支持哪些补数内容」的登记表里 hk 是**空表项**（走到冷启动 = 显式 no-op + 结局 `market_not_enabled`）。
- **不纳入 `underlying_iv_daily`**（spec Out of Scope）：代码自己把它归为「可重拉」（`his_volatility` 3 年滑动窗），且落库是 `upsert` 不是 `skipDuplicates` ⇒ 夜间轮自动覆盖修正。它也没有独立 use case（内联在 `dimension-executor.ts:2602`），纳入就要在 3000 行热路径上做抽取重构。
- **不建人工触发入口**（CLI / 端点）。

## Complexity Tracking

> Constitution Check 无违规，本表留空。
