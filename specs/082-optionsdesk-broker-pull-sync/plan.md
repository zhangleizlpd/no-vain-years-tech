---
feature_id: 082-optionsdesk-broker-pull-sync
spec_ref: ./spec.md
status: approved
created_at: '2026-09-14'
updated_at: '2026-09-14'
adr_refs: ['0033', '0040', '0043', '0047', '0058', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 期权台券商账户同步底座（拉取式）

## Summary *(mandatory)*

把富途账户中属于锚标的的持仓 / 成交 / 订单拉进 optionsdesk 自有的 `broker_*` 表：新建锚触发该标的历史补齐（outbox 订阅方插待执行记录）、每分钟心跳按交易所当地时刻判定开盘前对账，二者共用**一个**同步 use case。技术路径 = futu-shim 新增只读交易查询端点 + server 侧 port / adapter + 五个纯函数规则文件 + 调度器；**零新依赖、零新 HTTP endpoint（server 侧）、零 mobile 改动**。上线前的一次性回填不是系统能力（D15）。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**显式 no-op 声明**：shim 侧的交易查询用港机 shim venv 里既有的 `futu-api`（`OpenSecTradeContext` 与 `OpenQuoteContext` 同包；2026-09-13 POC-1 / POC-3 用同一解释器同版实测只读查询与推送可用，签名记录于 POC-1 原始输出 `meta.futu_signatures`）。server 侧 HTTP 复用既有 `VendorHttpClient`（`marketdata/vendor-http-client.ts:212`，cockatiel 已在依赖树）。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

| 原则 | 本片如何满足 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify（4 问）已走完，本文是 plan；纯后端，无 Mockup 步；spec `modules: [optionsdesk]` 与物理 context 一致（shim 属 `services/`，不是 bounded context） |
| II. Test-First TDD（NON-NEGOTIABLE） | 每 task 红→绿；spec 32 条 `state_branches` 逐条落 `it()`（映射见 Testing Invariants）；关键判据配反例臂 |
| III. Atomic Task = 30min-2h + 独立 commit | tasks 阶段按「shim 端点 / 时间与代码解析 / 规则纯函数 / 表 + 迁移 / 同步 use case / 订阅方 / 调度器 / 治理」切片 |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | 全部 server 文件平铺 `apps/server/src/optionsdesk/`；无 Repository、无 class 化领域对象；跨 ctx 只读 `option_contract` / `instrument` 走 `// CROSS-CONTEXT-READ:`，零跨 ctx 写；marketdata 侧只加两处**非 rules** 薄导出（D4），不 import `marketdata/*.rules.ts` |
| V. 类型同步链 Nx-driven | **server 无 controller / DTO 改动 ⇒ 无 OpenAPI 变更 ⇒ 无需 api-client regen** |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: server 侧**零新增 HTTP endpoint**，按空集满足；等价物 = Testcontainers IT（`optionsdesk-082.*.it.spec.ts`，真 PG 装配 `OptionsdeskModule`，券商 port 以 test double 注入）覆盖补齐 / 对账 / 订阅方 / 调度器全部落库分支。另在门禁 task 本地跑 `scripts/ci/server-boot-smoke.ts`（live / mock 各一次），覆盖模块级 IT 够不到的 `AppModule` 装配（新配置项进 `validate-config`、`ScheduleModule` 下的新 cron、按 `marketdata.kind` 绑定 port）。shim 侧新增 4 个端点，真启动冒烟 = 部署自检（`remote-deploy.sh:53-96`：`/healthz.version == SHA` + 声明路由全在 `routes`）+ 部署后在港机对 `/trade/accounts` 真打一次。
- [x] **Mobile / Web**: N/A —— 本片无 UI。
- [x] **Evidence**: 由 tasks 的 `[Server-IT]` 与 `[Ops]` task 落证据。**本 gate 在 plan 阶段是「已规划」而非「已完成」**。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A —— 不引入新的第三方 package / SDK / tool。** 富途早经 `services/futu-shim/` 作为 vendor 接入（ADR-0047 Amendment §4）；本片让同一 SDK 多用一个 context 类型。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— mono-native。** 触及的 `optionsdesk/`、`marketdata/` 两个文件、`services/futu-shim/` 均诞生于 mono。

- **Evidence**: `rg -l 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk apps/server/src/marketdata services/futu-shim` → 零命中（2026-09-14 plan 起草时执行）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

扫描：`docs/adr/*.md` 的 `## … Open Questions` 段落内对 `broker|券商|futu|shim|trade|交易|outbox|subscriber|订阅|持仓|position|scheduler|cron|对账` 零命中。**但有一条 sunset trigger 真的触发、四条看着近而未触发**，逐条写出：

| ADR | sunset trigger | Classification | 说明 |
|---|---|---|---|
| ADR-0062 | #4「期权台从锚 + 雷达扩到下单 / **持仓联动** → 与 portfolio 的边界（谁持有仓位事实）重审」 | **fired · mitigated** | 本片让 optionsdesk 持有券商持仓镜像。结论 = optionsdesk 持有「期权台范围内的券商镜像」（`broker_` 前缀 + port 隔离 vendor），**不扩** portfolio `BrokerAccount`；拆出条件（范围开关打开且出现期权台外读取方，或接入第二家券商）入复审记录。**复审记录随本片 PR 提交**（tasks `[Docs]`） |
| ADR-0062 | #3「出现第二个消费锚表的 ctx」 | accepted-as-is（未触发） | 读锚表的是 optionsdesk 自己（范围判定），不是新 ctx |
| ADR-0043 | #1「单个 bounded context use case 数 > 20」 | accepted-as-is（**未触发，已到阈值**） | optionsdesk 现 **19** 个；本片只加 **1** 个（D1 合并补齐与对账）⇒ 20。⚠️ **p3 加读接口必然越线** —— p3 plan 必须在 Gate 0.4 做该 trigger 的复审（内部分组 or 券商镜像拆出评估），此处先登记 |
| ADR-0047 | #3「出现第 2 个同类『外部数据访问』子系统」 | accepted-as-is（未触发） | 券商 adapter 复用 `VendorHttpClient` + 约束档机制，没有另起并列子系统 |
| ADR-0058 | 准入规则「integrations/ 只收 ≥2 ctx 复用的 vendor 适配器」 | accepted-as-is | 券商 adapter 单消费者（optionsdesk）⇒ 留 ctx 内，不进 `integrations/` |

- **Evidence**: `ls apps/server/src/optionsdesk/*.usecase.ts | grep -v '\.spec\.ts$' | wc -l` → 19；sunset 原文取自 ADR frontmatter；ADR-0058 准入原文 `:33-34`。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。（本片不新增此类组件，条款保留防顺手加。）
- **MANDATORY INTEGRATION**: 落库行为必须用 `Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()` + `setupIsolatedDb`（`apps/server/test/_support/isolated-db.ts`）装配；**只替换券商 port**（test double），`PrismaService` / outbox registry / 规则函数一律真实。
- **EXHAUSTIVE BRANCHING**: spec 的 **32 条** `state_branches` 每条**必须**有对应 `it()`。纯判定分支（范围 / 代码解析 / 开仓时间 / 对账时点 / DST）落 Small `*.rules.spec.ts`；**凡涉及落库结果**的分支（写入 / 不写入 / 清空 / 移除 / 幂等 / 订单守卫 / 失败不动 / 补齐与对账状态流转 / 订阅方）**必须**在 Medium IT 里再有一条 `it()`，不许只在 Small 层证明。

**本片额外的反例臂（都是「不写就永远不会红」的形态）：**

- 🚨 **开仓时间 = 持仓起点，不是 FIFO**：构造「D1 开 2、D2 加 1、D3 平 1」断言 = D1；再构造「清仓后重开」断言落在重开那笔。只测单笔开仓的用例对两种实现都绿。
- 🚨 **幂等要打重放，不是跑一次**：同一补齐连跑两次断言行数与内容逐条相同；同一 `sourceEventId` 投递两次断言只产生 1 条待执行记录（outbox 某订阅方抛错时**全部订阅方重投**，`security/outbox/outbox-subscriber.registry.ts:26-31`）；**两个连接**下同一事件断言各得 1 条（唯一键只按事件 ID 时第二个连接会被静默挡掉，D10）。
- 🚨 **重试上限要两侧夹逼**：`first_attempted_at` 距今 23h59m 的基础设施失败断言回 `pending`，24h00m 断言 `failed`；只测一侧对「永不设上限」和「立即失败」两种错误实现总有一个是绿的。
- 🚨 **防重入要用并发直调证明**：两个 `run()` 同时进入美股 09:10 ET ⇒ 对账记录恰 1 条。只靠 `waitForCompletion` 的实现在测试直调下会插出两条 —— 这正是数据层部分唯一索引要挡的（D9）。
- 🚨 **对账补缺的反例用输入构造**：先写满 → 删 1 条成交 → 对账断言补回 = 1 → 再跑断言 = 0（in-test 对照臂，`testing.md` §7.1 第一形态）。
- 🚨 **订单守卫必须喂同秒不同毫秒**：两次更新 `updated_time` 同秒、毫秒不同，先喂新的再喂旧的，断言库内是新的 —— D4 的毫秒修复不做这一条就会退化成相等而不自知。
- 🚨 **失败不清空要用「先有数据」起步**：空库上断言「失败后没数据」对错误实现同样绿。
- 🚨 **只读守卫要证明能红**：shim AST 守卫做一次 sabotage 臂（临时在 `src/` 插一行 `ctx.place_order`）→ 红 → 还原 → 绿，结果写进测试文件头。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> - **Flat Module**: ALL files live flatly in `apps/server/src/optionsdesk/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows. NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly. Business invariants go in `*.rules.ts`.
> - **The Moat**: NEVER write `tx.<otherTable>.*`. 本片跨 ctx 只有**只读** `optionContract` / `instrument`（`// CROSS-CONTEXT-READ:` 挂在 prisma 调用正上方，先例 `optionsdesk/leg-retrieval.adapter.ts:254`）。

### 🚨 Impl Guardrails（仅留本 feature 适用条目）

- **并发 / 事务**：待执行记录的认领用 conditional UPDATE **affected-count**（`updateMany where {id, status:'pending'}` → count===1 才执行）；**NEVER** `FOR UPDATE` / Serializable。券商 HTTP **在事务外**完成（split-tx，P6），拉回后再开短事务写；持仓整体替换在**一个**事务内完成。调度器按 connection × market 各自 try/catch，互不连坐（P5）。→ `docs/conventions/server-impl-playbook.md`
- **账号标识**：富途 `acc_id` **只存在于港机 shim 进程内存**；shim 响应、shim 日志、server 库 / 日志 / fixture MUST NOT 出现。shim 映射层**无条件剔除** `acc_id` 键（防 SDK 某列带出）。

---

#### D1 — 补齐与对账合并为一个 use case

`sync-broker-account.usecase.ts` 一个入口，输入 `{ connectionId, markets, target: ticker | '*', window: { start, end } | 'all-history', mode: 'backfill' | 'reconcile' }`。两者流程相同：拉成交 + 订单（按窗口）→ 判正股 → 范围过滤 → 幂等写 → 刷新目标市场持仓与开仓时间；差别只在窗口与留痕字段（补齐记写入条数，对账记补回条数）。

- **为什么合并**：两份实现会在「过滤口径 / 幂等写 / 持仓刷新」三处各自漂移；且 ADR-0043 #1 阈值（Gate 0.4）。
- 「单只标的补齐」也拉**全账户**历史再过滤（富途历史接口按账户查；POC-8 全量约 74 s）⇒ `target` 只影响过滤，不影响拉取。

#### D2 — shim：只读交易面

新文件 `services/futu-shim/src/futu_shim/trade.py`：

- **`TradeSupervisor`**：懒建并常驻一个 `OpenSecTradeContext(filter_trdmarket=NONE)`；每次取用先经既有 `OpenDSupervisor.session()`（复用其 systemd unit 存活检查与 OpenD 拉起，`opend.py:97-109`）再确认交易 context；SDK 抛错 / 连接断开时**照 `_drop_ctx` 模式**清引用 + daemon 线程 `close()`（`opend.py:277-297`，2026-08-01 四线程卡死事故的教训）。
- **选户**（POC F1）：`trd_env=REAL ∧ acc_status=ACTIVE ∧ trdmarket_auth∩{HK,US}≠∅`。基金户由权限字段自然排除（POC-1 原始输出：基金户 `trdmarket_auth` 只含 `HKFUND` / `USFUND`；`acc_type` 值域只有 `MARGIN` / `CASH`，**没有**可判的基金值，别按它写条件）；命中数 ≠ 1 ⇒ 路由返回 `409 {"error":"account_selection","matched":n}`，**不任取**。命中结果缓存于进程内存，context 重建时重选。
- **路由**（`create_app()` 内字面量 `@app.get`，部署自检按此 grep）：

  | 路由 | 参数 | 内部调用 | capability |
  |---|---|---|---|
  | `/trade/accounts` | — | `get_acc_list` | `trade_acc_list` |
  | `/trade/positions` | `market=US\|HK` | `position_list_query(refresh_cache=True, position_market=…)` | `trade_position` |
  | `/trade/deals` | `market`, `start`, `end` | `history_deal_list_query(deal_market=…)`；`end` ≥ 当日时再合并 `deal_list_query(refresh_cache=True)` 按 `deal_id` 去重 | `trade_deal_history` / `trade_deal_today` |
  | `/trade/orders` | `market`, `start`, `end` | 同上，`order_market` / `order_id` 去重 | `trade_order_history` / `trade_order_today` |

  `/trade/accounts` 只回 `{trdmarket_auth, matched}`，不回账户号的任何片段（连接尾号不从 shim 取，见 D7；2026-09-14 amend）。`start/end` 跨度 > 90 天 ⇒ `400`（富途历史窗上限，E4）。
- **限频**：`ratelimit.py` `LIMITS` 登记上表 capability。持仓 / 历史成交 / 历史订单 = `(10, 30)`，`EVIDENCE` 指富途文档 get-position-list · get-history-order-fill-list · get-history-order-list；当日成交 / 当日订单与账户列表**先查文档再登记**，查不到按兜底 `(10, 30)` 并写 `ASSUMED`（`ratelimit.py:72-80` 先例纪律）。同步 `test_ratelimit.py:83` 的实测对照表。
- **超时与并发上限**（POC-7「不阻塞」设计的实现面）：交易 SDK 调用经「daemon 线程 + `join(timeout)`」包装（照 `opend.py:307-330` 健康探测），env `FUTU_TRADE_CALL_TIMEOUT_S` 默认 10；超时 ⇒ 丢弃交易 context + `503 {"error":"trade_timeout"}`。交易路由共用一个**并发上限 2** 的 semaphore ⇒ waitress 4 线程里恒至少留 2 条给行情面（`app.py:812` `threads=4` 写死）。🚨 **非阻塞获取**，拿不到立即 `503 {"error":"trade_busy"}`（server 侧 `VendorHttpClient` 按 5xx 退避重试）—— 阻塞等待时排队的请求仍占着 waitress 线程，等于没限。
- **只读 AST 守卫**：`tests/test_readonly_guard.py` 解析 `src/**/*.py`，出现 `unlock_trade` / `place_order` / `modify_order` / `place_combo_order` / `cancel_all_order` 的 `Attribute` / `Name` 即红（master §5-1）。
- **测试形态**照既有：不 mock `futu` 模块，经 `create_app(supervisor, gate, trade=…)` 注入 `FakeTradeCtx`（`test_app.py:20-218` 先例）；新路由加进 401 参数化清单（`:273-309`）与部署探针对照（`:255-270`）。
- **部署**：合入 main 后 `deploy-futu-shim.yml` 自动部署，早于 server 发版 ⇒ server 上线时端点已在。`/healthz` 的 `trd_logined` 字段已有，不改巡检脚本。

#### D3 — server：port + futu adapter

- `broker-account.port.ts`：token `BROKER_ACCOUNT_PORT` + 券商无关的规范化行类型（持仓 / 成交 / 订单 / 账户概要）。
- `futu-broker-account.adapter.ts`：**自建**一个 `VendorHttpClient` 实例（marketdata 不导出其客户端实例，`marketdata.module.ts:811-818`），约束档新文件 `futu-shim-trade.constraint-profile.ts`（10 次 / 30 秒；超时略大于 shim 侧 10 s；重试 1 次）。base URL / token 复用 `marketdataConfig` 的 `futuShimUrl` / `futuShimToken`（`config/marketdata.config.ts:30-31`，只在 live 分支存在）。shim `409 account_selection` 映射为不可重试错误；`503` / `429` 走客户端既有重试与退避。
- **mock 门控**：`marketdataConfig.kind === 'mock'` ⇒ 调度器整拍 `skipped-mock`、订阅方直接 return（照 `sync-anchor-intraday.scheduler.ts:84-87`）；模块层 port 绑拒绝壳（照 `marketdata.module.ts:222-237`）。

#### D4 — 时间：复用单一实现，补毫秒

- **成交 / 订单时间解析**复用 `vendorTimeToDate(v, market)`（`marketdata/futu-option-snapshot.adapter.ts:170`，注释明令「别再抄第二份」）。
- 🚨 **其正则 `NAIVE_DATETIME_RE`（`:86`）只匹配到秒且无尾锚** ⇒ 富途交易时间 `YYYY-MM-DD HH:MM:SS.fff`（POC-1 原始输出：成交 244 / 244、订单 `updated_time` 393 / 393 带毫秒）会被**静默截掉毫秒**。后果：指派的期权平仓与正股成交同秒（F2）无法排序；订单守卫同秒更新判为相等。⇒ 正则加可选毫秒组 `(?:\.(\d{1,3}))?` 并计入 `Date.UTC`。不带毫秒的串结果不变（行情快照 adapter 零影响），在该 adapter 既有 spec 补「带 / 不带毫秒」两例。
- **交易所当地时刻**：`session-clock.ts` 导出新函数 `exchangeClock(market, now) → { date, minutesOfDay }`，薄包装文件内既有私有 `timeInTimeZone(now, exchangeTimeZone(market))`（`:97`）。`session-clock.ts` 在 `check-time-semantics` 的 `TABLE_FILES`（`:62`）内，合规；optionsdesk 不得 import 的是 `market-session.rules.ts` 的 `marketNow`。
- **轴归属**（`cross-timezone-date-semantics.md` §1）：心跳 cron = processing time，`@Cron('0 * * * * *', { timeZone: 'Asia/Shanghai', waitForCompletion: true })`（时区为仓内唯一允许的字面量；`waitForCompletion` 见 D9）；对账是否到点 = 按交易所当地 `minutesOfDay` 判 ⇒ **夏令时切换不需要任何特殊代码**；「本交易日」= `exchangeCalendarDate` + `TradingCalendarPort.classify`（`non-trading` 跳过、`unknown` 照跑并 warn，照 `sync-anchor-intraday.ts:275-291`）。成交时间存 `Timestamptz` 绝对时刻，不存日期串。

#### D5 — 代码解析与正股判定

- `broker-code.rules.ts`（纯函数）：`US.X` → 正股 `us:X`（带点原样，F9）；`HK.00700` → `hk:00700`；期权码 → `{market, root, expiry, right, strike}`（词根 = 6 位日期前的字母数字段；行权价 ×1000，F6）；组合单：解析 `combo_legs` 字符串里的各腿 `code=`（F7），**不**解析合成 `code`。
- `resolve-broker-underlying.ts`（非 rules，含跨 ctx 读）：每次同步开始时按市场**一次性**读 `option_contract` 的去重 `(market, root, underlyingInstrumentId)` + `instrument.code` 建内存映射（`root` 无索引，`schema.prisma:1159-1160`；一次顺扫可接受，不逐行查）⇒ 期权先查映射 → 查不到的**在挂**合约批量打 shim 既有 `/option-snapshot` 取 `stock_owner`（`futu_shim/app.py:675`）→ 结果写 `broker_contract_ref` 缓存 → 仍不出 ⇒ `unresolved`。
- 组合单归属：各腿正股一致 ⇒ 取之；不一致或任一腿未解析 ⇒ 订单记 `unresolved`（各腿原样保留在原始记录）。

#### D6 — 范围判定单点

`broker-scope.rules.ts`：`inScope({ scope, anchoredTickers, underlyingTicker, accountId })`。`full` ⇒ 恒真；`anchored` ⇒ 正股 ∈ 锚集（锚表**全部**行，含 `excluded`，U8）；**正股未解析 ⇒ 恒保留**（FR-006 不丢弃）。`accountId` 现阶段不参与判定（master §12-A4 预留）。锚集在每次同步开始时读一次（本 ctx 自有表，R1）。持仓 / 成交 / 订单三类调用同一函数。

#### D7 — 表的设计意图（SoT = `schema.prisma`，此处不镜像字段表）

六张表均在 `optionsdesk` schema，`broker_` 前缀，全部登记 `check-server-moat.ts` `MODEL_OWNERSHIP`：

- **连接**：一行 = 一个账号 × 一家券商 × 一个证券户；存券商码、人读标签、所属账号手机号后四位 `phone_last4`（上线建连接时由维护者手填；代码不读 `account` 表的手机号，也不从券商取 —— 富途三个账户号字段的末 4 位互不相同；2026-09-14 amend）。调度器与订阅方**遍历连接行**取 `account_id`，代码中不存在「管理员 ID」常量（master §12-A3）。
- **持仓**：唯一 `(connection_id, market, code)`；数量 / 市值 / 两个成本字段（`cost_price` 摊薄、`average_cost`，F4 留给 p3 选）/ 现价用 `Decimal`；`first_seen_at` 仅在插入时写；`opened_at` + `opened_at_source`（`derived` / `fallback`）；`synced_at`；原始行 `raw Json`。
- **成交**：唯一 `(connection_id, deal_id)`；成交视为不可变 ⇒ `createMany({ skipDuplicates })`，返回的插入数即对账「补回条数」。
- **订单**：唯一 `(connection_id, order_id)`；`vendor_updated_at` 毫秒精度；写入 = 先 `createMany({ skipDuplicates })` 插入，再对全部入参执行 `updateMany where vendor_updated_at < incoming`（FR-013）—— 两步都是原子写；🚫 先查后写（补齐与对账并发写同一连接时撞唯一约束抛 `P2002`，会被误判为基础设施失败进入重试）。
- **合约归属参考**：主键 `(market, code)`，**无** `account_id`（master §12-A2）；记来源（`root_map` / `stock_owner`）。
- **同步记录**：`kind`（`backfill` / `reconcile`；p2b 追加 `push_gap`）、`status`（`pending` / `running` / `succeeded` / `failed`）、`market`（对账必填；补齐可空，空 = 目标标的所属市场或全部市场）、`target`、窗口起止、`trading_date`（对账：交易所当地日期）、`attempt`、`first_attempted_at`、`next_attempt_at`、写入 / 补回条数、`error`、`source_event_id`（与 `connection_id` 组成**唯一键**，订阅方幂等键）。另加**部分唯一索引** `(connection_id, market, trading_date) WHERE kind='reconcile' AND status IN ('running','succeeded')`（D9 防重入第二层；写法先例 `schema.prisma:2058` 的 `where: raw(...)`，`partialIndexes` 预览特性已开 `:4`）。按 E14 **不写** marketdata `sync_run`。
- 共同约定照 portfolio 先例：`account_id BigInt` 不建 FK（`schema.prisma:182-183`），带 `account_id` 的表加 `(account_id, market)` 索引；时间列 `Timestamptz(6)`；索引命名 `uk_` / `ix_` + 表 + 列。
- 迁移 `pnpm db:migrate "add broker account sync tables"`；生成后手工剔除误报的 `DROP CONSTRAINT ck_anchor_market`（`schema.prisma:1840-1841`）。

#### D8 — 持仓刷新与开仓时间

- `broker-position-sync.rules.ts`：输入「库内该连接该市场持仓」+「本次券商报告（已过滤）」→ 输出 `{ toInsert, toUpdate, toDelete }`；`toUpdate` 保留 `first_seen_at`。空报告且 `RET_OK` ⇒ 全删（确实空仓）；拉取失败**根本不进入**本函数（调用方直接留痕返回）。
- `broker-opened-at.rules.ts`：对某合约的库内成交按 `(traded_at, deal_id)` 升序累计带符号数量（`BUY` / `BUY_BACK` 为正，`SELL` / `SELL_SHORT` 为负），最后一次「0 → 非 0」或「正负翻转」处为起点；终值 ≠ 持仓数量 ⇒ `fallback` 取 `first_seen_at`。期权数量单位两侧同为张（POC-1 ③）。
- 刷新时机：补齐成功后（clarify Q3，刷新目标市场）与每次对账成功后。

#### D9 — 调度器与执行状态机

`broker-account.scheduler.ts`，每分钟一拍，全路径不上抛。🚨 **防重入两层**：① `waitForCompletion: true` —— cron 4.4.0 在该选项为假（默认）时每拍照常触发、不等上一拍的 Promise（`node_modules/.pnpm/cron@4.4.0/node_modules/cron/dist/job.js:121-133`），而补齐一次约 74 s > 心跳 60 s，不设就会两拍并发、各插一条对账记录，直接违反 SC-004；`@nestjs/schedule` 6.1.3 原样透传装饰器选项（`scheduler.orchestrator.js:56-60`）。② 数据层部分唯一索引（D7）：对账插 `running` 撞冲突 ⇒ 本拍跳过 —— 进程内选项挡不住测试直调与未来多实例。补齐记录的认领另由 conditional UPDATE 防重复执行。单实例部署，不加分布式锁（照 `sync-anchor-intraday.scheduler.ts:24-26` 先例）。每拍对每个连接依次：

1. **回收卡死**：`running` 且 `started_at` 早于 15 分钟前（进程在执行中重启的情形）⇒ 补齐记录置回 `pending`；对账记录置为 `failed`（`error` 注明「执行中断」，计入当日失败次数，由步骤 3 按重试规则重新发起）。
2. **补齐**：认领 `pending ∧ next_attempt_at ≤ now` 的 `backfill` 记录并执行。结果：成功 ⇒ `succeeded`；基础设施故障（网络 / 5xx / 超时 / 429 用尽 / DB 连接 / 超时 / 连接数耗尽 / 事务写冲突）⇒ 首次失败时写 `first_attempted_at`；距其未满 24 h ⇒ 回 `pending`、`next_attempt_at += 15 min`、`attempt++`；**已满 24 h ⇒ `failed`**（`error` 注明「基础设施重试耗尽」，`logger.error`）；数据无法处理（shim `409` / 解析异常）⇒ 立即 `failed`，不重试。上限口径参照 NServiceBus recoverability「有上限的延迟重试，耗尽进 error queue」（spec Clarifications 第 5 条）。
   - **重新触发**（维护者手动，非系统能力）：把该记录 `status` 置回 `pending` 并清空 `first_attempted_at`，下一拍即被认领；语句随私有 runbook。
3. **对账**：对每个市场调 `broker-sync-slot.rules.ts` 纯函数判定。输入 = 交易所当地 `{date, minutesOfDay}`、日历三态、该市场该交易日已有对账记录（成功数 / 失败数 / 最近失败时刻）、上次成功对账的交易日。输出 = `skip(reason)` 或 `run({ windowStart })`：
   - 时点：美股 `09:10`、港股 `09:05`（交易所当地分钟数常量；**POC-6 结果出来后只改这两个常量**，常量旁注明来源与待复核）
   - 已到点 ∧ 非 `non-trading` ∧ 本交易日无成功 ∧ 失败次数 ≤ 3 ∧ 距最近失败 ≥ 15 分钟 ⇒ `run`。**首次 + 最多 3 次重试 = 至多 4 次尝试**（clarify Q1）
   - 窗口起点 = min(上次成功对账的交易日, 今天 − 7 个自然日)（clarify Q2）；从未成功过 ⇒ 今天 − 7
   - 服务在时点停机、重启时仍在同一交易日 ⇒ 下一拍自然满足条件（无需额外「补跑」分支）
4. 每次执行前插一条 `running` 记录（对账撞部分唯一索引 ⇒ 本拍跳过）、结束时回写；补回条数 > 0 ⇒ `logger.warn`（clarify Q4：不主动通知）。

#### D10 — 新建锚订阅方

`broker-history-backfill.subscriber.ts`，`implements OnModuleInit` 注册到 `OutboxSubscriberRegistry`，`eventType = 'optionsdesk.anchor-created'`（字面量本地一份，照 `marketdata/anchor-cold-start.subscriber.ts:15`）。与冷启动订阅方**并存**（registry 支持同事件多订阅方，`outbox-subscriber.registry.ts:14-20`）。

- 载荷 `{ anchorId, ticker }`（`create-anchor.usecase.ts:315-320`）；`ticker` 缺失 / 非法 ⇒ `logger.error` + return（毒丸不抛）。
- 对每个连接插一条 `pending` 补齐记录（`target = ticker`，`source_event_id = delivery.sourceEventId`），唯一键 **`(connection_id, source_event_id)`** —— 只按事件 ID 唯一会让第二个连接的记录被当成重复静默丢弃（Microsoft Learn Idempotent Consumer：多消费方共用去重存储时须以「消费方 + 消息」组合为键）。写入用「冲突即忽略」的原子插入（`createMany({ skipDuplicates })`），**不**先查后写、不靠捕获 `P2002`。DB 故障 ⇒ **抛**（交 relay 重投）。
- **只插记录，绝不在 relay 线程执行补齐**（relay 每 10 秒一批 100 条，`outbox-event-cron.publisher.ts:28-38`，长任务会拖住全部事件）。
- ⚠️ 本订阅方一旦抛错，同事件的冷启动订阅方也会被重投（registry 顺序投递、整条事件不标 published）⇒ 冷启动订阅方的幂等性**已核实**：它蓄意不用 `sourceEventId`，重复投递由 job 起手复判「该标的在目标交易日的数据在不在」吸收（`marketdata/anchor-cold-start.subscriber.ts:32-37`），本订阅方抛错引起的重投不会让冷启动重复采集；本片不改它，IT 里断言「本订阅方重投不产生第二条记录」。
- 📌 **平台层已知差距，本片不修**：业内做法是每个订阅方独立副本、独立追踪完成状态（NServiceBus 每 endpoint 一条队列；Microsoft Learn「each consumer … needs to independently track processing completion」），而仓内 registry 是一条事件、一个 `publishedAt`，且 relay 无重试上限、无死信（`outbox-event-cron.publisher.ts:53-60`）。改它是 `security/outbox` 全仓的事；本片按业内底线应对 = 本订阅方自身幂等 + 只做一次 DB 插入（抛错面仅 DB 故障）。

#### D11 — 配置

`BROKER_SYNC_SCOPE` 加入既有 `config/optionsdesk.config.ts`：`z.enum(['anchored', 'full']).default('anchored')`，同文件既有「缺失 → 默认，非法（含空串）→ boot 抛」口径。实施走 `/config-add`（`.env.example` / `vitest.config.ts` test.env / `docker-compose.tight.yml` 映射 / `check-env-sync` 收尾）；非密。shim 侧新 env `FUTU_TRADE_CALL_TIMEOUT_S` 进 `config.py` 与 `install.sh` 非密收敛段。

#### D12 — 可观测性

- shim：交易路由沿用既有 429 / 503 日志行；**不打印** `acc_id`、成交 / 订单明细。
- server：每次同步一行 `info`（kind / market / 条数 / 耗时）；补回条数 > 0 `warn`；失败 `error` 带原因。均不含账户号（shim 侧由 T002、server 侧由 T015 的日志断言钉住）。
- 数据陈旧的可见性 = 持仓 `synced_at`（读端由 p3 呈现）。

#### D13 — 与既有行情面的相互影响（SC-009）

默认同进程（POC-7 基线：有 / 无常驻交易 context 的 `/trading-days` 延迟中位 31.3 ms / 30.5 ms，均为休市时段）。保护措施 = D2 的超时 + 并发上限 2。上线后按 POC-7 同一采样脚本对照一次，**口径同 POC-7 判据**：延迟对比两侧都取休市时段；盘中与批处理时段只判 journal 零新增错误（负载本身会抬高延迟，拿盘中数值比休市基线会误判）；若出现持续影响，交易 context 改独立 shim 进程，server 侧与业务逻辑不变。

#### D14 — 治理随 PR

- `check-server-moat.ts` `MODEL_OWNERSHIP` 登记 6 个 accessor → `optionsdesk`。
- ADR-0062 追加复审记录（Gate 0.4 第一行）。
- use case 数 19 → 20，在 ADR-0043 复审提醒里写明「p3 越线」。

#### D15 — 上线时一次性动作（非系统能力，不入仓）

发版后、首个交易日对账前，由维护者在 prod 执行一次（经既有 prod PG 访问方式，写操作由维护者本人执行）：

1. 插入一条连接行（账号 = 期权台管理员账号，券商 = `futu`，`phone_last4` 由维护者从 prod `account` 表查该账号手机号后四位手填，不取自 shim）。
2. 插入一条 `backfill` 记录：`status = pending`，`target = '*'`，窗口起点 `2024-09-01`（POC-2）。
3. 等下一拍调度器认领执行 → 查记录 `succeeded` → 按 SC-001 逐只锚标的与富途 App 核对条数。

语句形态随 tasks 的 `[Ops]` task 起草，含账号标识，**只放私有 runbook**，不进仓库文件、commit 与 PR body。

## Complexity Tracking

无原则违背。两处「越出 optionsdesk 目录」的改动均为既有文件的最小薄改，记录在此便于 review 定位：

| 改动 | 为什么需要 | 更简单的替代为何不行 |
|---|---|---|
| `marketdata/futu-option-snapshot.adapter.ts` 正则加可选毫秒组 | 交易时间毫秒是排序与订单守卫的判据（D4） | 在 optionsdesk 另写解析 = 违反该函数「别抄第二份」的既有约束，两份时区规约会漂移 |
| `marketdata/session-clock.ts` 新增导出 `exchangeClock` | 对账时点要交易所当地分钟数（D4） | import `market-session.rules.ts` 的 `marketNow` 被 lint 禁；自写 `Intl.DateTimeFormat` 被 `check-time-semantics` Rule B 拒 |
