---
feature_id: 084-optionsdesk-broker-push-sync
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-16'
updated_at: '2026-09-16'
adr_refs: ['0040', '0043', '0047', '0058', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 券商持仓实时增量同步（推送式）

## Summary *(mandatory)*

把券商的订单 / 成交推送接进已上线的 `broker_*` 数据面：shim 在既有常驻交易 context 上挂两个推送 handler，事件进进程内环形缓冲（单调 `seq` + 进程 `epoch`），server 每 2 秒主动拉取 → 锚过滤 → 幂等写 → 按市场去抖 5 秒刷持仓；`seq` 断档或 `epoch` 变化即触发当日缺口补偿。技术路径 = shim 新增 1 个只读端点 + 1 个缓冲模块、server 新增 1 个 use case + 1 个纯函数规则文件 + 1 条部分唯一索引迁移；**零新依赖、server 侧零新 HTTP endpoint、零 OpenAPI 变更、零 mobile 改动**。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**显式 no-op 声明**：推送 handler 用港机 shim venv 里既有 `futu-api` 的 `TradeOrderHandlerBase` / `TradeDealHandlerBase`（与 082 的查询 context 同包同解释器；维护者 2026-09-13 POC-3 以同一 venv 实测收到推送，原始记录见 `docs/private/evidence/broker-account-poc/`）。server 侧 HTTP 复用既有 `VendorHttpClient` 与 082 建立的 `futu-shim-trade.constraint-profile.ts`。缓冲用 Python 标准库 `collections.deque(maxlen=…)`，不引第三方队列。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

| 原则 | 本片如何满足 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify（Session 2026-09-16，5 问）已走完，本文是 plan；纯后端，无 Mockup 步；spec `modules: [optionsdesk]` 与物理 context 一致（shim 属 `services/`，非 bounded context） |
| II. Test-First TDD（NON-NEGOTIABLE） | 每 task 红→绿；spec 23 条 `state_branches` 逐条落 `it()`（映射见下方测试映射表）；关键判据配反例臂 |
| III. Atomic Task = 30min-2h + 独立 commit | tasks 按「shim 缓冲 / shim 端点 / 推送行映射 / 游标规则 / 消费 use case / 补偿模式 / 索引迁移 / 读端口径 / 治理」切片 |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | 全部 server 文件平铺 `apps/server/src/optionsdesk/`；无 Repository、无 class 化领域对象；本片**零新增跨 ctx 边**（沿用 082/083 既有的只读 `option_contract` / `instrument` 与 `TRADING_CALENDAR_PORT`）；零跨 ctx 写 |
| V. 类型同步链 Nx-driven | **server 侧零 controller / DTO 改动 ⇒ 无 OpenAPI 变更 ⇒ 无需 api-client regen、无 mobile 改动**。读端 `syncedAt` 的**取值来源**变了（D7），但响应结构不变 |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: server 侧**零新增 HTTP endpoint**，按空集满足；等价物 = Testcontainers IT（`optionsdesk-084.*.it.spec.ts`，真 PG 装配 `OptionsdeskModule`，券商 port 以 test double 注入）覆盖消费、断档补偿、防重入、卡死回收全部落库分支。门禁 task 另跑 `nx affected` 全量门（含 `server:runtime-smoke`），覆盖模块级 IT 够不到的 `AppModule` 装配（新 cron 注册、新配置项）。
- [x] **Shim**: 新增 1 个端点 `/trade/events`，真启动冒烟 = 部署自检（`services/futu-shim/deploy/remote-deploy.sh:78-96`：从 `/healthz` 取 `routes` 校验声明路由全部已注册）+ 部署后在港机对该端点真打一次。
- [x] **Mobile / Web**: N/A —— 本片无 UI 改动。
- [x] **Evidence**: planned —— 由 tasks 的 `[Server-IT]` / `[Vendor]` / `[Ops]` task 落证据；**本 gate 在 plan 阶段是「已规划」而非「已完成」**。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A —— 不引入新的第三方 package / SDK / tool。** 富途早经 `services/futu-shim/` 接入（ADR-0047 Amendment §4）；本片在 082 已常驻的同一个交易 context 上多挂两个 handler 基类。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— mono-native。** 触及的 `apps/server/src/optionsdesk/`、`services/futu-shim/` 均诞生于 mono。

- **Evidence**: `rg -l 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk services/futu-shim` → 零命中（2026-09-16 plan 起草时执行）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

扫描 `docs/adr/*.md` 的 sunset trigger 与 Open Questions。**本片不触发任何新的 ADR 复审**，逐条写出判据：

| ADR | sunset trigger / 判据 | Classification | 说明 |
|---|---|---|---|
| ADR-0043 | #1「单个 bounded context use case 数 > 20」 | **accepted-as-is（复审线未到）** | 该 trigger 已由 083 于 2026-09-15 fired · mitigated，维护者同日定下 **optionsdesk 下次复审线 = use case 达 30 个**（ADR-0043 §复审记录 2026-09-15）。当前 **24** 个，本片 +1 = **25**，未达线 ⇒ 不重开复审 |
| ADR-0062 | #4「期权台扩到下单 / 持仓联动」 | **accepted-as-is（已 mitigated 范围内）** | 该条已由 082 于 2026-09-14 fired · mitigated（持仓联动落为本 ctx 自持的券商镜像）。本片是同一联动的**延迟优化**，写同一批 `broker_*` 表、不新增表、不触碰 portfolio ⇒ 落在既有缓解范围内，非新触发 |
| ADR-0062 | #3「出现第二个消费锚表的 ctx」 | accepted-as-is（未触发） | 锚过滤仍由 optionsdesk 自己执行（FR-005 复用 `broker-scope.rules.ts` 单点），无新消费方 |
| ADR-0062 | #1 / #2 / #5 | accepted-as-is（未触及） | #1 实时 spot 已于 2026-08-18 单独 mitigated；#2 价格序列读未搬动；#5 估值管线无关 |
| ADR-0047 | #3「出现第 2 个同类『外部数据访问』子系统」 | accepted-as-is（未触发） | 事件读取复用 082 建立的 `VendorHttpClient` + 约束档机制，未另起并列子系统 |
| ADR-0058 | 准入规则「`integrations/` 只收 ≥2 ctx 复用的 vendor 适配器」 | accepted-as-is | 券商 adapter 仍是单消费者（optionsdesk）⇒ 留 ctx 内 |

- **Evidence**: `ls apps/server/src/optionsdesk/*.usecase.ts | grep -v '\.spec\.ts$' | wc -l` → 24（2026-09-16 执行）；复审线原文取自 ADR-0043 §复审记录 2026-09-15；sunset 原文取自各 ADR frontmatter。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。（本片不新增此类组件，条款保留防顺手加。）
- **MANDATORY INTEGRATION**: 落库行为必须用 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` + `setupIsolatedDb`（`apps/server/test/_support/isolated-db.ts`）装配；**只替换券商 port**（test double），`PrismaService` / 规则函数 / 调度器一律真实。
- **EXHAUSTIVE BRANCHING**: spec 的 **23 条** `state_branches` 每条**必须**有对应 `it()`。纯判定分支（游标断档 / 重试判定 / 推送行映射）落 Small `*.rules.spec.ts` 与 adapter spec；**凡涉及落库结果**的分支（写入 / 不写入 / 幂等 / 订单守卫 / 补偿状态流转 / 防重入 / 卡死回收 / 同步时刻）**必须**在 Medium IT 里再有一条 `it()`，不许只在 Small 层证明。

**本片额外的反例臂（都是「不写就永远不会红」的形态）：**

- 🚨 **组合单腿要喂对象、不是文本**：adapter spec 必须构造「腿是对象数组」的入参断言各腿代码被解出。**只喂文本数组的用例对错误实现同样绿** —— 现有 `parseComboLegs`（`broker-code.rules.ts:99-107`）对数组入参做 `filter(typeof === 'string')`，喂对象会**静默返回 `[]`**。同时补一条「腿为空 ⇒ 走回查补全并留痕」的臂（FR-020）。
- 🚨 **成交号要用超出安全整数范围的整数喂**：fixture 用小整数时，「转字符串」与「原样透传」两种实现都绿。喂真实尺寸的大整数才能让错误实现红（FR-021；同 082 上线首次失败的形态）。
- 🚨 **`kind` 隔离要用「当日已有补偿成功」反证**：构造「当日已有一条成功的缺口补偿」后断言开盘前对账**照常发起**（FR-010 / branch 10）。不写这条，把补偿误记成对账类型的实现会一直绿，直到某天开盘前对账被静默跳过。
- 🚨 **防重入要区分「执行中」与「已完成」两侧**：① 已有执行中的补偿 ⇒ 第二次断档不新起（branch 19）② 当日**已完成**过补偿 ⇒ 再次断档**照常新起**（branch 20）。只测 ① 的话，照抄上游谓词（把 `succeeded` 也纳入）的实现同样绿，而那会让当天第二次断档永远补不回来。
- 🚨 **卡死回收要针对新类型单独断言**：现有 `reclaimStuckRuns`（`broker-account.scheduler.ts:123-130`）只有 `backfill` / `reconcile` 两条分支，新类型不加分支就**没有任何路径**清理它。构造一条超时的执行中补偿记录，断言被回收为终态（branch 7 / FR-011）。
- 🚨 **同步时刻要断言「推送刷新也计入」**：083 既有 IT（`optionsdesk-083.broker-positions-read.it.spec.ts:452-534`）的 `syncedAt` 用例**全部只造 `reconcile` / `backfill` 夹具**，给 `lastSucceededSyncAt` 加一个 OR 分支**不会让它们红** ⇒ FR-012 若不新增断言就是零覆盖。必须新增「只有一条推送刷新成功记录 ⇒ `syncedAt` 取它」的臂（branch 8）。
- 🚨 **断档检测要喂「序号跳号」与「代次变化」两种**：只测其中一种，另一种的漏判不会被发现（branch 5 / 6）。再补一条「服务端重启但事件量未超缓冲 ⇒ 不判断档」的反例臂（branch 22），否则「每次拉取都判断档」的实现也能通过前两条。
- 🚨 **去抖要断言「合并」而非「刷了几次」**：同一市场窗口内喂多条事件，断言持仓查询**只发生一次**（branch 21）。断言「持仓被刷新」对逐条刷的实现同样绿。
- 🚨 **只读守卫沿用 082 的 sabotage 臂**：shim AST 守卫做一次 sabotage（临时插一行下单调用）→ 红 → 还原 → 绿，结果写进测试文件头（FR-001）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/optionsdesk/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows. NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly. Business invariants go in `*.rules.ts`.
> - **The Moat**: NEVER write `tx.<otherTable>.*`. 本片**零新增跨 ctx 边**，沿用 082 / 083 既有的只读边。

### 🚨 Impl Guardrails（仅留本 feature 适用条目）

- **并发 / 事务**：补偿记录的插入撞部分唯一索引即跳过本拍（`create` + 捕获 `P2002`，🚫 `upsert`，同 082 D9）；事件拉取的 HTTP **在事务外**完成（split-tx），拿到事件后再开短事务写。调度器按 connection × market 各自 try/catch，互不连坐。→ `docs/conventions/server-impl-playbook.md`
- **账号标识**：推送行经实测不含券商账户号字段（维护者 2026-09-13 采集样本、2026-09-16 分析），但 shim 侧仍 MUST 无条件执行与查询路径等价的剔除（D2）—— 依赖「vendor 现在不给」是把正确性押在对方的实现细节上。
- **时间语义**：事件时间按所属市场的交易所时区解析（沿用 082 的 `vendorTimeToDate`）；去抖窗口与拉取间隔是**相对时长**，不涉日期轴，不需日历。→ ADR-0066 / `docs/conventions/cross-timezone-date-semantics.md`

---

#### D1 — shim：事件缓冲与读取端点

新文件 `services/futu-shim/src/futu_shim/trade_events.py`：

- **`TradeEventBuffer`**：`collections.deque(maxlen=N)` + 单调递增 `seq`（进程内计数器）+ 进程启动时生成的 `epoch`（随机串或启动时刻，重启必变）。写入由推送 handler 调用，读取由路由调用，二者跨线程 ⇒ 全部操作在一把 `threading.Lock` 内完成（SDK 回调线程 ≠ waitress 工作线程）。
- **容量**（clarify Q5）：按条数封顶，默认值取「足以覆盖服务端一次常规重启窗口内的事件量」。单条事件约一两 KB，容量取数千条也只有几 MB，对港机内存无实质压力；**要害不是省内存，是信号质量** —— 容量不足会让每次例行部署都绕回、产生一条补偿留痕，淹没 FR-014 赖以判断通道健康的信号。默认值走 env（D6），便于上线后按实际事件密度调。
- **`TradeSupervisor` 挂 handler**（改 `trade.py`）：`TradeOrderHandlerBase` / `TradeDealHandlerBase` 两个子类，`on_recv_rsp` 里把行经 D2 的映射后 `append` 进缓冲。**不调用 `unlock_trade`**（FR-002）。handler 在交易 context 建立时 `set_handler`，context 重建时重挂。
- **路由** `GET /trade/events?epoch=<e>&after_seq=<n>`（`create_app()` 内**字面量** `@app.get` —— 部署探针按字面量 grep，`tests/test_app.py:275-276` 有断言）：非阻塞立即返回 `{epoch, rows, next_seq, dropped}`。`epoch` 与当前不符 ⇒ 回全部在缓冲内的事件并在响应里给出新 `epoch`，由 server 判定断档（D4）；`after_seq` 早于缓冲最旧一条 ⇒ `dropped=true`。**MUST NOT 长轮询**（clarify Q1）：挂起会占住 waitress 仅有的 4 个工作线程，与行情面抢资源，正是 POC-7 要求避开的方向。
- **限频**：本端点读的是进程内存、不打券商 ⇒ **不登记券商限频 capability**。但沿用既有 Bearer 鉴权，并加进 `tests/test_app.py` 的 401 参数化清单（`:318-322`）与 `TRADE_ROUTES` 集合（`:339`）。
- **测试形态**照既有：不 mock `futu` 模块，经 `create_app(...)` 注入假缓冲与假 handler 触发（`test_app.py` 先例）。

#### D2 — 推送行的映射：自建，不走通用兜底

**这是本片最容易静默出错的地方**，三条都有实测支撑：

- **`combo_legs` 是 `ComboLeg` 对象列表，不是文本**。券商官方文档三个接口页（`update-order` / `get-order-list` / `get-history-order-list`，2026-09-16 直取 `openapi.futunn.com/futu-api-doc/trade/`）一致定义为 `list`，子字段见 `place-combo-order` 的 ComboLeg 表：`code`（`str`，「格式如 `US.AAPL`、`US.AAPL260529C302500`」）· `trd_side` · `qty_ratio`（float）· `position_id`（int）· `pred_side`（仅下单入参）。shim 侧 MUST **显式展开前四个属性**为结构化字段，🚫 依赖 `mappers.clean_value` —— 其末行 `return str(value)`（`mappers.py:52`）会把整个列表压成 `str(list of ComboLeg)`，而 `ComboLeg.__repr__` 产出的是 `ComboLeg(code=…, trd_side=…, …)` 这种需要正则硬解的串。查询路径上 `combo_legs` 变成串正是同一原因 ⇒ 两路是「一样地坏」而非「不一样」。
- **成交号是超出安全整数范围的整数**（FR-021）。⚠️ **券商官方文档把它声明为 `str`，与实际返回不符** —— 082 上线首次失败即源于此。推送路径不经 `TradeSupervisor.call`（`trade.py:171-173`），因此 `_ids_as_digit_strings` 不会生效，MUST 在推送映射里自建等价处理。
- **账户号字段**：实测样本中推送行不含该字段，但 `_strip_account_ids` 同样不在推送路径上 ⇒ 仍 MUST 无条件剔除（FR-019 / Guardrails）。
- **市场字段名**：推送是 `trd_market`，历史订单是 `order_market`（维护者 2026-09-13 POC-3 记录）⇒ 两路分别映射（FR-015 / branch 13）。
- server 侧 `futu-broker-account.adapter.ts` 增事件行 → port 类型的规范化；订单事件与成交事件**字段集不同**，分别映射（branch 13）。

#### D3 — server：消费 use case 与拉取节奏

- 新增 `consume-broker-events.usecase.ts`（use case 数 24 → 25，Gate 0.4 已判未达复审线）：拉事件 → 按 `broker-scope.rules.ts` 锚过滤（FR-005，🚫 另起一份判定）→ 幂等写 `broker_deal` / `broker_order`（沿用 082 的唯一键与 `vendor_updated_at` 守卫）→ 按市场登记「待刷新」→ 去抖到期后刷持仓与开仓时间。
- **拉取间隔 2 秒**（clarify Q1）：`@Cron` 秒级表达式，`waitForCompletion: true`（同 082 D9 的理由：默认不等上一拍 Promise）。间隔是**代码常量**、不做成配置 —— 它与 SC-001 的 ≤5 秒预算强耦合，配置化会让「改一个数就破坏验收口径」成为可能；照 `RECONCILE_SLOT_MINUTES`（`broker-sync-slot.rules.ts:24`）的先例，常量旁注明出处。
- **去抖 5 秒**（clarify Q4）：受券商持仓查询限频约束（每账户 10 次 / 30 秒，官方文档；且该配额与对账、补偿共用）—— 5 秒窗口 ⇒ 30 秒内最多 6 次，留约 40% 余量；3 秒恰好打满上限，与对账并发即触发限频，而**限频的表现是持仓静默不刷新、不报错**。
- **mock 门控**：`marketdataConfig.kind === 'mock'` ⇒ 整拍跳过、零 port 调用（FR-016 / branch 12，照 082 先例）。

#### D4 — 游标与断档判定（纯函数）

新增 `broker-event-cursor.rules.ts`：输入「本地记的 `{epoch, lastSeq}`」+「本次响应的 `{epoch, rows, next_seq, dropped}`」→ 输出 `{ accepted, gapDetected, nextCursor }`。

- `epoch` 不同 ⇒ 事件源重启 ⇒ `gapDetected`，游标从新 `epoch` 的起点重建，**MUST NOT 按旧序号续拉**（branch 6）。
- `dropped` 为真或首条 `seq` > `lastSeq + 1` ⇒ 序号断档（branch 5 / 23）。
- 序号连续 ⇒ 正常消费，不触发补偿（branch 22）—— 这条是「服务端常规重启但缓冲未绕回」的正常路径，必须与断档区分开。
- 游标存哪：**进程内存**即可。进程重启时 `epoch` 比对会自然判出「要不要补偿」，无需持久化；持久化反而要多维护一张表与其一致性。

#### D5 — 缺口补偿：复用同步 use case，独立记录类型

- **复用 `sync-broker-account.usecase.ts`**，把 `BrokerSyncMode`（`:35`）从 `'backfill' | 'reconcile'` 扩为三值，新增第三种。补偿 = 对该市场当日做一次窗口受限的对账，流程与 `reconcile` 相同 ⇒ 复用避免「过滤口径 / 幂等写 / 持仓刷新」三处各自漂移（同 082 D1 的理由）。
- **记录类型独立**（FR-010）：`broker_sync_run.kind` 是 `VarChar(16)`（`schema.prisma:2394`），加第三个取值**不需要迁移**。🚨 开盘前对账的三处判定 —— `todaysRuns` / `lastSucceeded`（`broker-account.scheduler.ts:247` / `:251`，共用 `scope = { connectionId, kind: 'reconcile', market }`）与部分唯一索引谓词（`schema.prisma:2413`，已带 `kind='reconcile'`）—— **本就按类型过滤，新增类型不会污染它们**（起片前已取证）。本片**不改这三处**，只需保证补偿写的是新类型。
- **失败重试**（clarify Q2）：沿用开盘前对账的规则（同交易日最多 3 次、间隔 15 分钟，仍失败留痕放弃）。MUST NOT 降级为触发一次开盘前对账 —— 那会产出 `reconcile` 类型记录，破坏 FR-010 与上游验收口径。
- **防重入**（clarify Q3 / FR-022）：新增一条部分唯一索引，谓词**只含执行中状态**（🚫 照抄上游把 `succeeded` 也纳入 —— 断档一天可能合法发生多次，纳入会让当天第二次断档再也补不回来）。写法先例 `schema.prisma:2413` 的 `where: raw(...)`，`partialIndexes` 预览特性已开。**这是本片唯一的迁移。**

#### D6 — 卡死回收补第三条分支

`reclaimStuckRuns`（`broker-account.scheduler.ts:117-136`）现只处理 `backfill`（置回 `pending`）与 `reconcile`（置 `failed`）。新类型 MUST 加一条分支，否则执行中的补偿记录在进程重启后**没有任何路径**清理（FR-011 / branch 7）。语义取 `reconcile` 那侧（置 `failed` 并计入当日失败次数，由重试规则重新发起），因为补偿与对账同属「当日可重试」的形态。

#### D7 — 读端：同步时刻与陈旧口径

- `lastSucceededSyncAt`（`list-broker-positions.usecase.ts:293-308`）的 `OR` 条件现只含 `reconcile`（按市场）与 `backfill`（按 `target`）两支，MUST 加第三支使推送刷新计入（FR-012 / branch 8）。
- **陈旧判定不改算法**（FR-013）：`isStale`（`broker-freshness.rules.ts:76-85`）比较的是「最近成功同步时刻 vs 最近一个已过宽限的对账时点」，`syncedAt` 的来源扩大后，推送通道健在时自然不再标陈旧 —— 无需改判据本身。
- ⚠️ **接口结构不变** ⇒ 无 DTO / OpenAPI / api-client 改动（Constitution V）。

#### D8 — 订阅健康

FR-014 的判据 = 「最近一次事件到达时刻」+ 补偿留痕，**MUST NOT** 使用 SDK 私有标记 `__is_acc_sub_push`（维护者 2026-09-13 POC-3 实测：该标记恒为假，与实际收到推送的事实矛盾）。「最近事件到达时刻」由 shim 在 `/healthz` 或事件响应里带出；阈值（多久没事件算异常）本片**不定**，理由见 spec clarify 覆盖率表的 Outstanding 项 —— 本片不主动通知，阈值只影响排障展示。

#### D9 — 配置

- shim 新增一个非密 env 控制缓冲容量，照 `config.py:98 trade_call_timeout_s()` 的形态（`_env` + 默认值 + 类型转换），并进 `install.sh` 非密收敛段。
- server 侧**不新增配置项**：拉取间隔与去抖窗口都是与验收口径强耦合的常量（D3）。

#### D10 — 可观测性

- shim：事件端点沿用既有日志行；**不打印**账户号、成交 / 订单明细。
- server：每次消费写一行 `info`（拉到条数 / 写入条数 / 是否触发补偿 / 耗时）；触发补偿时 `warn`（与 082「补回条数 > 0 即 warn」同级）；失败 `error` 带原因。均不含账户号。

#### D11 — 治理随 PR

- **补上游 082 的措辞缺口**：`specs/082-optionsdesk-broker-pull-sync/spec.md` 的 SC-004 只写「每个市场恰有 1 条成功的对账记录」，未限定记录类型（其跟踪 issue 限定了）。本片引入第三种类型后该措辞产生歧义 ⇒ 随本 PR 补上类型限定（docs 改动，不影响其已上线的行为）。
- `check-server-moat.ts` 的 `MODEL_OWNERSHIP` **无需改**：本片零新表。

### 测试映射（`state_branches` 23 条 → 落点；analyze 期逐条 grep 对账）

| 层 | 文件 | 覆盖的 `state_branches` 序号 |
|---|---|---|
| Shim pytest | `services/futu-shim/tests/test_trade_events.py` | 3, 16, 22, 23（缓冲绕回 / `epoch` 变化 / 大整数承载 / 腿展开），加鉴权与路由登记 |
| Server Small | `broker-event-cursor.rules.spec.ts` | 5, 6, 22, 23 |
| Server Small | `futu-broker-account.adapter.spec.ts`（扩） | 13, 14, 15, 16 |
| Server Small | `broker-sync-slot.rules.spec.ts`（扩） | 17, 18 |
| Server Medium | `apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts` | 1, 2, 3, 4, 9, 11, 12, 21 |
| Server Medium | `apps/server/test/integration/optionsdesk-084.push-gap.it.spec.ts` | 5, 6, 7, 10, 17, 18, 19, 20 |
| Server Medium | `optionsdesk-083.broker-positions-read.it.spec.ts`（扩一条臂） | 8 |

**SC 落点**：SC-001 / SC-002 / SC-005 = prod 验收（维护者在券商 App 挂单再撤、重启事件源）· SC-003 = 消费 IT 重放臂 · SC-004 = 上线后观察，口径同上游 T022（按开盘前对账类型过滤统计）· SC-006 = 照 POC-7 同一采样脚本对照一次，**延迟对比两侧都取休市时段**，盘中与批处理时段只判零新增错误 · SC-007 = 卡死回收 IT · SC-008 = `check-identifier-boundary` 私有清单 + PR 前私有数据扫描。

### 新增 / 触碰文件清单（tasks 拆分的物料面）

- **shim 新增**：`src/futu_shim/trade_events.py` · `tests/test_trade_events.py`
- **shim 触碰**：`src/futu_shim/trade.py`（挂 handler + 推送行映射）· `app.py`（字面量 `@app.get` 路由）· `config.py`（缓冲容量 env）· `install.sh`（非密收敛段）· `tests/test_app.py`（`TRADE_ROUTES:339` + 401 参数化 `:318-322`）
- **server 新增**：`optionsdesk/broker-event-cursor.rules.ts`（+ `.spec.ts`）· `consume-broker-events.usecase.ts` · `apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts` · `optionsdesk-084.push-gap.it.spec.ts`
- **server 触碰**：`broker-account.port.ts`（事件类型）· `futu-broker-account.adapter.ts`（事件行规范化）· `sync-broker-account.usecase.ts`（第三个 mode）· `broker-account.scheduler.ts`（2 秒 cron + 卡死回收第三分支）· `list-broker-positions.usecase.ts`（`lastSucceededSyncAt` 第三支）· `optionsdesk.module.ts` · `prisma/schema.prisma` + 一条迁移（部分唯一索引）
- **docs**：`specs/082-optionsdesk-broker-pull-sync/spec.md` SC-004 补类型限定（D11）

## Complexity Tracking

无原则违背。一处值得 review 留意的取舍记录在此：

| 改动 | 为什么需要 | 更简单的替代为何不行 |
|---|---|---|
| 推送路径自建 `combo_legs` / 成交号 / 账户号三道映射，不复用查询路径的通用兜底 | 推送是 SDK 回调，不经 `TradeSupervisor.call`（`trade.py:171-173`）与 `mappers.clean_value`，三道处理全都不生效（起片前已取证） | 把推送行塞进 `dataframe_to_records` 复用兜底 = 腿被 `str()` 压成需正则硬解的串、成交号按数字传出去被精度护栏拒收 —— 后者正是上游上线首次失败的形态 |
| 新增一条部分唯一索引，谓词与上游同名索引**不同**（只含执行中状态） | 缺口补偿一天可能合法发生多次，而开盘前对账一天只该一次 | 照抄上游谓词（纳入 `succeeded`）会让当天第二次断档再也补不回来，且该失效**静默**——没有任何报错 |
