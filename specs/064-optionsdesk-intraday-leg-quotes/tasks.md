---
feature_id: 064-optionsdesk-intraday-leg-quotes
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-19'
updated_at: '2026-08-19'
---

# Tasks: 064-optionsdesk-intraday-leg-quotes（美股期权腿盘中实时报价）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Mockup**: `design/`（8 帧，六项探测全 0）
**架构 canonical**：[`ADR-0043`](../../docs/adr/0043-server-flat-module-paradigm.md)（扁平 / 贫血 / 护城河 / 零-class）+ [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（optionsdesk → marketdata 端口边，**本片复用 061 已 amend 的那条强一致同步读边**）+ [`ADR-0064`](../../docs/adr/0064-optionsdesk-retrieval-layering.md)（检索 port 是跨 ctx 只读的显式接缝）+ [`ADR-0066`](../../docs/adr/0066-time-semantics-ubiquitous-language.md)（ingestion time = 我们什么时候拿到它）
**Branch**: `064-optionsdesk-intraday-leg-quotes`
**病根一句话**：选约表读「最近一期 `session_date` 的全链快照」，而美股收盘采集跑在北京 06:30 ⇒ 用户在**美股盘中**打开选约表，看到的是**上一交易日收盘的盘口**，却要据此决定卖哪一档。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Ops]` / `[Docs]`。
- 📌 **术语别名**：本文的「**窗**」= spec 的「**候选范围**」（spec `## Key Entities` 已声明该别名）。两处指同一个东西，改判据时两边都要看。
- 🚨 **FR / SC 一律逐条枚举，禁写 `FR-004~FR-008` 这类范围记法** —— 本仓自审纪律是逐条 `grep`，范围记法会让中间几条每次都被报成零命中。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 窗派生纯函数（**新建**） | `apps/server/src/optionsdesk/leg-window.rules.ts` |
| 读取口 token + 接线（改） | `apps/server/src/marketdata/option-snapshot.port.ts` + `apps/server/src/marketdata/marketdata.module.ts` |
| 检索 port（改：query 加开关 / 行加档位） | `apps/server/src/optionsdesk/leg-retrieval.port.ts` |
| 检索 adapter（改：`loadChain` 尾部 overlay） | `apps/server/src/optionsdesk/leg-retrieval.adapter.ts` |
| 假实现同步新签名（改） | `apps/server/src/optionsdesk/fake-leg-retrieval.adapter.ts` |
| 两个读端 use case（改：传开关） | `apps/server/src/optionsdesk/get-legs.usecase.ts` + `get-chain-report.usecase.ts` |
| DTO 出档位与 asOf（改） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| 接线（改） | `apps/server/src/optionsdesk/optionsdesk.module.ts` |
| mobile 档位条（**新建**） | `apps/mobile/src/optionsdesk/leg-tier-bar.tsx` + `leg-tier-bar.rules.ts`（纯函数，档位文案与时间格式化） |
| mobile 成员变化条（**新建**） | `apps/mobile/src/optionsdesk/leg-membership-notice.tsx` |
| mobile 行 / 表头 / 屏 / hook（改） | `apps/mobile/src/optionsdesk/{leg-row.tsx,leg-table-header.tsx,underlying-detail-screen.tsx,use-leg-table.ts,leg-picker-copy.ts}` |
| hermetic e2e（**新建**） | `apps/mobile/e2e/optionsdesk-intraday-tiers.spec.ts` |
| 契约冒烟（**新建**） | `apps/mobile/e2e/contract-smoke/064-intraday-leg-quotes.contract.ts` |

## 🚨 Impl Guardrails（每条都是盲写会踩、且**踩了不会红**的坑）

1. 🚨 **禁新建第二套断路器**（plan §D3）。spec `state_branch` 4 的「熔断打开」在本片的实现形态是**传导**：tick 熔断 → 停写 `intraday_price`/`intraday_at` → `isIntradayFresh()` 判假 → 定窗基准不可用 → 回落。看到 spec 里「熔断」二字就 `new CircuitBreaker()` 会造出两个阈值两套状态，而它们必然不同步。本片只需**请求级超时**。
2. 🚨 **单批上限用 `OPTION_SNAPSHOT_MAX_CONTRACT_CODES = 399`**，不是 `REALTIME_QUOTE_MAX_SYMBOLS = 400`。减掉的那 1 是**标的自身那行的槽位** —— 用 400 切批会每批多带一个 code，撞 shim 400 上限而**整批被拒**。🚫 MUST NOT 在 `optionsdesk` 再写一个 399/400 字面量。
3. 🚨 **`useFactory` 必须返回同一个 `FutuOptionSnapshotAdapter` 实例，MUST NOT 新 `new`**。shim 侧限频是 per-capability 单桶，客户端每个 `VendorHttpClient` 实例各持一个令牌桶 ⇒ 多起一个 = 上游允许值的 2 倍撞 429。`futu-shim.constraint-profile.ts` 记着同一病灶在 prod 上让链发现每 30 分钟顺延、12 只锚只采到前 2 只。
4. 🚨 **MUST NOT 注入 `OPTION_SNAPSHOT_PORT`（采集口）**。它经 `collectionPort()` 注册，mock 下是拒绝壳；直接用会让 054 的「采集口产出必然被持久化」意图分类变成假话。走本片新增的读取口 token。
5. 🚨 **窗的两个 strike 边界是包络不是等价**，`0.7 / 1.05` **不能**从 `PREMIUM_FLOOR` 反解（它是 `max(spot × 0.0018, 0.20)` 的动态门槛）。代码里必须带注释声明，并由 FR-007 绊线守卫兜住。
6. 🚨 **OI 三列靠结构不靠纪律**：它们**不出现**在 overlay 的写入面上。MUST NOT 为「对称」把 OI 纳入再跳过 —— 那把编译期保证降级成注释。
7. 🚨 **档位复用 `PriceKind`**（`marketdata.types.ts:29` 已有 `'eod_close' | 'realtime'`，`optionsdesk.dto.ts` 已在 import）。🚫 禁新造第二套枚举 —— 两套会让「实时」在同一个响应里有两个来源。
8. 🚨 **若发现自己在写第二处 `res?.rows` / `as_of` 解析，说明走错了路**。正确路径是经读取口拿已解析好的 `OptionSnapshotBatch`（信封单点已由 PR #116 收口）。
9. 🚨 **`--nvy-info` 就是 `--nvy-primary`**（`info-soft` = `primary-soft`）。成员变化条 MUST 走中性 `--nvy-surface-sunken`，用 info 会和实时档撞脸。
10. 🚨 **`--nvy-quote-up` / `--nvy-quote-down` 本片一处不用** —— 档位不是涨跌方向，误用会让「实时」被读成「涨」。
11. 🚨 **禁在 Prisma 事务里等这次外呼**（本片根本不该开事务；split-tx 心智）。
12. 🚨 **`useMutation` / `useQuery` 返回对象 identity 每 render 变**，进 `useCallback` 依赖 = 自激风暴。只解构要用的方法。

---

## Phase 1: 取数底座与判据（阻塞其余）🎯

- [X] T001 [P] [Server] **窗派生纯函数 + 包络绊线**（`FR-005`, `FR-006`, `FR-007`, `FR-008`, plan §D4）：新建 `apps/server/src/optionsdesk/leg-window.rules.ts`，导出 `legWindowFor(market: string, spot: Prisma.Decimal): LegWindow`（`{ optionType: 'PUT'; dteMin; dteMax; strikeMin; strikeMax; isStandard: true }`）。DTE 段由 `BUILD_RECALL_DTE` / `RENT_RECALL_DTE` **取并**派生（禁手写 `1` / `365`）；strike 上下界常量与召回常量**同文件邻接声明**并带注释「带余量的包络，非 `PREMIUM_FLOOR` 的精确反解」；另导出 `windowTripwire(legs, window, criteria)` —— 返回「被窗排除却能过召回判据」的腿。🚨 **Guardrail 5** · **零 IO / 零 class / 零 DI**（ADR-0043）。→ verify: colocate 单测覆盖 —— ① 窗边界确实由召回常量算出（改动 `RENT_RECALL_DTE.max` 后窗随之变，硬编码会红）；② `market` 传 `'us'` 之外的值 → **throw 且消息列出已支持市场**（p4 的入口，静默返空会让 hk 悄悄拿到 us 的窗）；③ 绊线：造一条 strike 落在 `0.7×spot` 之下、但权利金高于 `PREMIUM_FLOOR` 的腿 → `windowTripwire` **必须**报它；④ 反例：窗内且能过判据的腿 → 绊线**不**报（否则绊线恒响 = 等于没有）。跑 `pnpm nx test server src/optionsdesk/leg-window.rules.spec.ts`

- [ ] T002 [Server] **快照读取口 token + 接线**（`FR-015` 前置, plan §D1）：① `option-snapshot.port.ts` 新增 `export const OPTION_SNAPSHOT_READ_PORT = Symbol('OPTION_SNAPSHOT_READ_PORT')`，doc 写明**与采集口的分野**（读意图 / 零落库 / mock 下显式降级而非拒绝壳 / 054 意图分类为何不能复用采集口）；② `marketdata.module.ts` 用**裸 provider**（🚫 不走 `collectionPort`）注册它，`useFactory` 返回**与 `OPTION_SNAPSHOT_PORT` 同一个** `FutuOptionSnapshotAdapter` 实例；`kind: 'mock'` 分支返回一个**显式降级实现**（`getSnapshots` 抛一个具名的「本环境无实时源」错误，供上游落到收盘档）；③ 加进 `exports`。🚨 **Guardrail 3**（同实例）· **Guardrail 4**。→ verify: 新建 `marketdata-064.read-port.it.spec.ts`（`Test.createTestingModule({ imports: [MarketdataModule] })`）断言 —— ① `kind: live` 下两个 token 解析出的**是同一个对象引用**（`toBe`，不是 `toEqual`；这条是 Guardrail 3 的机器化，写成 `toEqual` 就漏了）；② `kind: mock` 下采集口调用即抛「拒绝壳」原有错误、读取口抛的是**可区分的**降级错误（两者混同会让 dev 的降级看起来像故障）；③ `MarketdataModule` 的 `exports` 含新 token（否则 optionsdesk 注入时 boot 才炸）

## Phase 2: overlay 主干（US1 + US2 的服务端）

- [ ] T003 [Server] **检索面加显式开关与档位字段（关态逐字节不变）**（`FR-009`, `FR-015`, `FR-016`, `SC-005`, `state_branches` 2, plan §D6, §D7）：① `leg-retrieval.port.ts`：`LegRetrievalQuery` 与 `LegChainQuery` 各加 `readonly realtime: boolean`（**无默认值，调用方必须显式传**）；`LegChainRow` 加 `readonly priceKind: PriceKind`；`LegChainMeta` 加 `readonly priceKind: PriceKind`；② `leg-retrieval.adapter.ts` 在 `realtime === false` 时全部行标 `'eod_close'`、meta 同；③ `fake-leg-retrieval.adapter.ts` 同步新签名；④ `get-legs.usecase.ts` / `get-chain-report.usecase.ts` 显式传 `realtime: false`（**本 task 先全关**，实装在 T004a）。🚨 **Guardrail 7**（复用 `PriceKind`，禁新枚举）。🚫 MUST NOT 给 `realtime` 设默认值 —— 有默认值就等于「不写也能跑」，FR-015 的 fail-closed 立刻名存实亡。→ verify: 新建 `optionsdesk-064.overlay-off.it.spec.ts`（Testcontainers PG，真容器 `imports: [OptionsdeskModule]`）：① **对读取口的调用次数 = 0**（用 spy 计数，🚨 这是 FR-016 / `state_branch` 2 的唯一机器判据 —— 「看起来没变」不算）；② 两个端点的响应与改动前**逐字段相同**（先在改动前 snapshot 一份基线夹具）；③ 全部行的 `priceKind === 'eod_close'`；`pnpm nx test server` 既有 `leg-retrieval` / `get-legs` / `get-chain-report` 三个 spec **全绿且零改动**（逐点等价的硬证据）

- [ ] T004a [Server] **`loadChain` 尾部覆盖七列 + OI 结构性不覆盖**（`FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-019`, `SC-006`, `SC-007`, `state_branches` 1, 8, 9, 10, plan §D1, §D6, §D8）：`leg-retrieval.adapter.ts` 注入**可空**的 `OPTION_SNAPSHOT_READ_PORT`；`realtime === true` 且端口非 null 时，在 `loadChain` 组装 `legs` **之后**、`return` **之前**做一次覆盖：调 `getSnapshots({ underlyingSymbol, contractCodes })`，用返回的 `isOption: true` 行覆盖 `bid` / `ask` / `bidSize` / `askSize` / `delta` / `iv` / `volume` **七列**，`quoteAsOf` 取 `batch.asOf`，逐行标 `priceKind: 'realtime'`；返回集里库内不存在的合约**直接忽略**；库内零快照行时维持既有「未就绪」。🚨 **注入点上方 MUST 挂 `// CROSS-CONTEXT-SYNC:`**（构造器参数紧邻上方，非 import 上方）—— `check-server-moat.ts` 的 `checkInjectionAnnotations()` 扫构造器参数、按 import 来源判 ctx，缺注释即 violation，**lefthook + CI 硬拒**；体例照抄 `sync-anchor-intraday.ts:204-210` 已有的两条。🚨 **Guardrail 6**（OI 三列不进覆盖面）· **Guardrail 8**（不自己解信封）。🚫 **MUST NOT** 在 `recallCandidates` 之后再插一层 —— 插在共同根之后、召回之前，`FR-017` 才是结构保证而非纪律。→ verify: 扩 `optionsdesk-064.overlay-off.it.spec.ts` 为 `optionsdesk-064.overlay.it.spec.ts`，加：① 七列确实取到实时值且逐行 `priceKind === 'realtime'`；② **`FR-004` / `SC-006`**：`openInterest` / `netOpenInterest` / `oiAsOf` 三列在实时档与收盘档下**逐字节相同**（🚨 反例断言：把 mock 的 OI 喂成不同值，若被覆盖则红）；③ **`state_branch` 9**：库内零快照行 → 维持「未就绪」，**不靠实时值单独成链**；④ **`state_branch` 10**：返回集塞一个库内没有的合约 → 不出现在结果里；⑤ `pnpm tsx scripts/checks/check-server-moat.ts` 绿（F2 的机器判据）

- [ ] T004b [Server] **两个标的现价 + 召回口径**（`FR-006a`, `FR-017`, `SC-003`, `SC-008`, plan §D4, §D5）：在 T004a 的覆盖段前后补两件事 —— ① **定窗基准**：读 `anchor.intraday_price` 经 `isIntradayFresh()` 判可用，喂 `legWindowFor('us', 基准)` 圈出窗内 `contractCodes`。📌 `Anchor` 是 `@@schema("optionsdesk")` 的**本 ctx 自有表**，这次读是 intra-ctx，**MUST NOT 挂 `// CROSS-CONTEXT-READ:`** —— 挂上去等于在代码里留一条「anchor 归别的 ctx」的假注释，而本仓的护城河审计链完全靠这类注释承载；② **判据与呈现的现价**取返回集里 `isOption: false` 那一行，覆盖链级 `spot`。🚨 **Guardrail 2**（用 399，不是 400）· **Guardrail 5**（包络非等价）。🚫 两个现价**禁合并成一个**。→ verify: 同一 IT 文件加：① **US2-AS1**：造一条收盘权利金低于门槛、实时权利金高于门槛的腿 → 实时档下**出现在候选集内**（这条必须先红）；② **US2-AS2** 反向 → 不在；③ **US2-AS4**：跳空日，把 `intraday_price` 与 `last_close` 拉开 20% → 窗的 strike 区间必须跟着盘中价动；④ **US2-AS3 / `FR-017`**：同一次请求里 `retrieveCandidates` 与 `retrieveChain` 拿到的 `quoteAsOf` **相同**；⑤ **`SC-003`**：一次请求对读取口的调用次数 **= 1**；⑥ **`FR-006a`**：表头 spot 取的是 `isOption: false` 那行、**不是** `anchor.intraday_price`（两者喂不同值，断言取的是前者）

- [ ] T005 [Server] **降级四路径 + 定窗基准不可用**（`FR-010`, `FR-011`, `FR-012`, `SC-004`, `state_branches` 3, 4, 5, 6, 11, 14, plan §D3）：在 T004a / T004b 的覆盖段外包降级 —— ① 市场非常规交易状态 / 当日非交易日 → **不外呼**，收盘档（复用 061 的 `MARKET_STATE_PORT` 白名单 + `TRADING_CALENDAR_PORT`，两闸取交集）；② 读取口抛 / 超时 → 整体回落收盘档；③ 部分合约未在返回集 → **逐行**保留收盘值并逐行标 `'eod_close'`；④ 单腿 `bid`/`ask` 皆为 null → 按「该行未取到实时」整行处理；⑤ 定窗基准缺失或 `isIntradayFresh()` 判假 → 整体回落并标降级；⑥ 返回集里的标的行 spot 缺失 → 显式「未就绪」（`loadChain` 返 null，沿既有语义）。🚨 **Guardrail 1**（这里只加超时，不加断路器）。🚫 MUST NOT 回落成 0、MUST NOT 清空既有值、MUST NOT 拿 `last_close` 顶替缺失 spot。→ verify: 同一 IT 文件逐条覆盖 `state_branches` 3 / 4 / 5 / 6 / 11 / 14 六条，每条一个 `it()`。📌 **`state_branch` 4 的 IT 只制造「不可达 / 超时」两种输入** —— 该分支里的「上游熔断」在本片**没有可独立制造的输入**（tick 的断路器一开就停写基准，那条路径归 `state_branch` 14），🚫 别为它 stub 一个本片根本不存在的 breaker；🚨 外加一条**跨全部降级路径的扫描断言**：遍历响应里所有数值字段，**被置为 `0` 或空串的项数 = 0**（`SC-004` 的机器化 —— 逐字段肉眼核对必漏）；再加一条 `state_branch` 5 的**分布断言**：部分缺失时 `priceKind` 必须**两种值都出现**（全 `eod_close` = 页级一刀切，全 `realtime` = 缺失被吞，两种错都不会自己红）

- [ ] T006 [Server] **超上限 fail-closed + 三类特有失败留痕**（`FR-018`, `FR-023`, `SC-010`, `state_branches` 7, plan §D11, §分批）：① 窗内 `contractCodes.length > OPTION_SNAPSHOT_MAX_CONTRACT_CODES` → **整体回落收盘档并标降级**，🚫 **MUST NOT 截断到前 399 条**（少一截而外表完全正常）；② 三类本片特有失败各落一条结构化 warn，带可聚合的类别字段：`partial_miss`（附缺失条数）/ `window_over_cap`（附窗内条数与上限）/ `window_basis_stale`（附基准时刻与判据阈值）。🚨 **通道级健康不由本片回答** —— 复用 061 的观测面，本片不新建心跳（按需触发的指标「没人看就没数据」，当哨兵会误导）。→ verify: IT 加 —— ① 把上限 stub 成一个小值驱动超限路径 → 断言**整表 `eod_close` + 降级标记 + 零外呼**，且候选集条数与不开实时时**相同**（截断的话会少）；② 三类失败各触发一次 → 断言日志留痕**可按类别聚合**（断言类别字段值，不是断言「日志非空」）；③ `SC-010` 反例：制造一个降级但**不属于**三类的情形 → 断言它不会被错误归类

## Phase 3: 契约面（US1 的出口）

- [ ] T007 [Server] **DTO 出档位与两种 asOf**（`FR-009`, `FR-010`, `FR-013`, `FR-014`, `SC-001`, plan §D7）：`optionsdesk.dto.ts` —— ① 腿行 DTO 加 `priceKind`（`@ApiProperty({ enum: PRICE_KINDS })`）；② 区块级加 `priceKind` + `quoteAsOf`，**实时档序列化为时刻（ISO 含秒）、收盘档序列化为交易日（`YYYY-MM-DD`）**，照该文件 `:87` 已有的「日历日 vs 时刻混成一种会让 asOf 呈现出错」纪律；③ OI 相关列的 `oiAsOf` **独立出参**，不复用区块级；④ 成交量/成交额字段的 `description` 写明两档口径差异（`FR-013` 的服务端半边）。🚨 nullable 字段的 `@ApiProperty` 必须显式 `type: 'string'`（否则 orval 误生 objectmap）。→ verify: 扩既有 `optionsdesk.controller.spec.ts`（controllers-only module，🚫 禁 full boot）断言两档的 `quoteAsOf` **形态不同**（一个匹配 `/T\d{2}:\d{2}:\d{2}/`、一个匹配 `/^\d{4}-\d{2}-\d{2}$/`）；`pnpm nx run server:export-openapi` 后 `pnpm nx run api-client:generate`，断言生成的类型里 `priceKind` 是**联合字面量**而非 `string`

## Phase 4: mobile 呈现（US1 + US2 的用户面）

- [ ] T008 [P] [Mobile] **区块级档位条 + 行级档位标**（`FR-009`, `FR-010`, `FR-013`, `FR-014`, `SC-001`, plan §D10, mockup 帧 ①②③④⑤）：① 新建 `apps/mobile/src/optionsdesk/leg-tier-bar.tsx` —— 实时档呈时刻含秒 + `--nvy-primary` / `--nvy-primary-soft`；收盘档呈交易日 + `--nvy-text-muted` / `--nvy-surface-alt`；降级与未就绪走 `--nvy-warning-soft` 底 + 3px `--nvy-warning` 左边框 + `--nvy-text` 正文，且**必须给原因**（不是「加载失败」）；② `leg-row.tsx` 收盘行的 bid/ask 降 `--nvy-text-muted`，冻结列行权价旁挂「收」角标（**复用既有 badge 视觉，不新建组件、不新开一列**）；③ `leg-table-header.tsx` 的 OI 列挂 `oiAsOf`、成交量列按档位切「至此刻 / 当日」；④ 文案落 `leg-picker-copy.ts`。🚨 **Guardrail 9**（不用 info）· **Guardrail 10**（不用涨跌色）。→ verify: `leg-row.rules.ts` / 新增 `leg-tier-bar.rules.ts` 的 colocate 单测（vitest，**logic-only，禁组件 render**）覆盖：两档的时间格式化分支、降级三态的文案与原因非空、OI 列取 `oiAsOf` 而非区块级（🚨 反例：喂两个不同的时间，断言取的是前者）；UI 归 T012

- [ ] T009 [P] [Mobile] **首屏等待态 + 刷新保表**（`FR-022`, `state_branches` 12, plan §D10, mockup 帧 ⑥⑦）：`use-leg-table.ts` + `underlying-detail-screen.tsx` —— 首屏走等待态（骨架），**MUST NOT 先渲染一份收盘档的表再覆盖重排**；下拉刷新期间**保留当前表**（不遮罩、不置灰到看不清），新一批到齐后整体替换；刷新指示位于档位条、带「上次」时刻。🚫 MUST NOT 引入自动轮询（spec Assumption）。→ verify: `use-leg-table.spec.ts` 加断言 —— ① 首次加载中 `rows` 恒为**空**而非「库内收盘档」（这条先红：若实现走渐进覆盖，这里会拿到非空）；② 刷新中 `rows` **保持上一批的引用不变**且 `isRefreshing` 为真；③ 无任何定时器被注册（断言 `vi.getTimerCount() === 0`，防自动轮询悄悄混进来）

- [ ] T010 [Mobile] **成员变化提示**（`FR-021`, `SC-009`, `state_branches` 12, plan §D9, mockup 帧 ⑧）：新建 `apps/mobile/src/optionsdesk/leg-membership-notice.tsx` + 在 `use-leg-table.ts` 里持有**上一轮的合约码集合**做差集，刷新后报出「本轮新进 N · 已不满足 M」，中性 `--nvy-surface-sunken`，可关闭。🚨 **Guardrail 9**。🚫 服务端**不引入会话态** —— 差集只在客户端算。→ verify: `use-leg-table.spec.ts` 加：① 两轮不同成员 → 差集条数与实际一致（🚨 双向各断言一次：只进不出 / 只出不进 / 有进有出，三种都要，只测一种会漏方向写反）；② 首屏（无上一轮）→ **不报**成员变化（否则用户一进页面就被告知「3 条进」）；③ 成员完全相同 → 不报

## Phase 5: 两层验证与实证

- [ ] T011 [Mobile-E2E] **hermetic UI e2e**（`FR-009`, `FR-011`, `FR-013`, `FR-021`, `FR-022`, `SC-004`, `SC-009`, US1-AS3, US1-AS4, US1-AS5, US1-AS6, US2-AS5）：新建 `apps/mobile/e2e/optionsdesk-intraday-tiers.spec.ts`（Playwright Expo Web，mock 后端）覆盖 —— 实时档 asOf 呈时刻 / 收盘档呈交易日 / 熔断降级整表回落且**零 0 值** / 部分缺失**逐行**标档（断言两种档位都在 DOM 里）/ OI 列归属日不随实时档变今天 / 刷新后成员变化提示出现且条数正确 / 首屏等待态期间**不出现任何腿行**。→ verify: `pnpm nx run mobile:e2e --grep 064`；🚨 叠屏 DOM 双命中用 `getByRole` 收窄（per `reference_expo_web_e2e_and_router_footguns`）

- [ ] T012 [Contract-Smoke] **契约冒烟**（`FR-009`, `FR-010`, `FR-016`, `SC-005`）：新建 `apps/mobile/e2e/contract-smoke/064-intraday-leg-quotes.contract.ts` —— 用生成的 `@nvy/api-client` 打 testcontainers 真 server，走一条 happy path：拉选约表 → 断言 `priceKind` 与 `quoteAsOf` 的**序列化形态**（联合字面量 / 两种时间格式）能被客户端正确解封；再断言**实时关闭**时的响应与基线一致。→ verify: `pnpm nx run mobile:contract-smoke`

- [ ] T013 [Ops] **美股盘中真机实证**（`SC-001`, `SC-002`, US1-AS1, US1-AS2, US2-AS1, US2-AS2, US2-AS3, US2-AS4, US3-AS1, US3-AS2）：美股常规时段（北京 21:30–04:00）真机打开选约表，逐条与外部行情终端对拍 bid/ask/成交量；下拉刷新观察 asOf 推进；记录 285 合约档的端到端等待时间（`SC-002` 预算 P95 ≤ 1.5 s，基线是 p0 线上实测的 0.35–0.41 s）。⚠️ 这三类 web e2e **验不到**（spec `web_compat_notes` 已写明）：真实时段内候选集随价格移动的进出 / 收盘那一刻的档位切换 / 与真源的数值一致性。→ verify: 截图 + 对拍表贴进本文件；env-gated 真 vendor IT（`RUN_MARKETDATA_IT=true`）手动跑一次并贴输出（该门恒 skip，「测试全绿」对真契约不构成证据）

## Phase 6: 收口

- [ ] T014 [Docs] **ADR-0062 跨 ctx 面补一行 + spec/plan status 转**（plan Gate 0.4）：`docs/adr/0062-optionsdesk-bounded-context.md` 的跨 ctx 面清单补上本片新增的读取口 token（061 已 amend 那条强一致同步读边，本片只是第二个消费者，**不重开重审**）；`spec.md` frontmatter `status: planned → implemented`、`updated_at` 同步；`plan.md` `status: drafted → approved`。→ verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；`pnpm tsx scripts/checks/check-adr-index.ts` 绿

## Dependencies

```text
T001 ─┐
      ├─→ T004a ─→ T004b ─→ T005 ─→ T006 ─→ T007 ─┬─→ T008 ─┐
T002 ─┘    ▲                             ├─→ T009 ─┼─→ T011 ─→ T013 ─→ T014
           │                             └─→ T010 ─┘        ▲
T003 ──────┘                                  └──────────────┴─→ T012
```

- **T001 / T002 可并行**（不同 ctx、不同文件）。
- **T003 必须在 T004a 之前**：先把开关与档位字段立起来并证明**关态逐字节不变**，再实装覆盖 —— 顺序反过来的话「有没有改坏既有行为」这个问题永远拿不到干净的基线。
- **T004a → T004b 串行**：T004b 的窗要圈出 `contractCodes` 喂给 T004a 建好的那次调用，两者共用同一段代码路径，并行会互相改同一处。
- **T008 / T009 / T010 三者可并行**（不同文件）。
- **T013 有时间窗**：只能在美股常规时段跑（北京 21:30–04:00）。

## 判据覆盖矩阵（`state_branches` 14 条 → task）

| # | 分支（缩写） | task |
| --- | --- | --- |
| 1 | 常规时段 + 交易日 + 已开启 → 取全窗实时 | T004a |
| 2 | 未显式开启 → 纯收盘档且外呼 = 0 | T003 |
| 3 | 非常规状态 / 非交易日 → 不外呼 | T005 |
| 4 | 源不可达 / 超时 / 熔断 → 整体回落 | T005 |
| 5 | 部分合约未返回 → 逐行保留 | T005 |
| 6 | 标的现价缺失 → 未就绪 | T005 |
| 7 | 超单批上限 → 不得混时刻 | T006 |
| 8 | 持仓量列恒取收盘档 | T004a |
| 9 | 库内无快照行 → 维持未就绪 | T004a |
| 10 | 返回集含库内不存在的合约 → 忽略 | T004a |
| 11 | 单腿关键报价为空 → 整行按未取到处理 | T005 |
| 12 | 相邻两次取数成员不同 → 重算 + 报进出 | T010 |
| 13 | 实时批未到齐 → 等待态 / 保表 | T009 |
| 14 | 定窗基准缺失或陈旧 → 回落并标降级 | T005 |

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **5 层**：`state_branches`（14）· FR（24）· SC（10）· Edge Cases（8）· Acceptance Scenarios（13）。**五层全扫**，无差集。

### FR 覆盖（24 条，逐条枚举无范围记法）

`FR-001` T004a · `FR-002` T004a · `FR-003` T004a · `FR-004` T004a · `FR-005` T001 · `FR-006` T001 · `FR-006a` T004b · `FR-007` T001 · `FR-008` T001 · `FR-009` T003 T007 T008 T011 T012 · `FR-010` T005 T007 T008 T011 T012 · `FR-011` T005 T011 · `FR-012` T005 · `FR-013` T007 T008 T011 · `FR-014` T007 T008 · `FR-015` T002 T003 · `FR-016` T003 T012 · `FR-017` T004b · `FR-018` T006 · `FR-019` T004a · `FR-020` T010 · `FR-021` T010 T011 · `FR-022` T009 T011 · `FR-023` T006

### SC 覆盖（10 条）

`SC-001` T007 T008 T013 · `SC-002` T013 · `SC-003` T004b · `SC-004` T005 T011 · `SC-005` T003 T012 · `SC-006` T004a · `SC-007` T004a · `SC-008` T004b · `SC-009` T010 T011 · `SC-010` T006

### Acceptance Scenario 覆盖（13 条）

US1-AS1 T013 · US1-AS2 T013 · US1-AS3 T011 · US1-AS4 T011 · US1-AS5 T011 · US1-AS6 T011 · US2-AS1 T004b T013 · US2-AS2 T004b T013 · US2-AS3 T004b T013 · US2-AS4 T004b T013 · US2-AS5 T010 T011 · US3-AS1 T006 T013 · US3-AS2 T006 T013

### Edge Case 覆盖（8 条）

收盘后到采集前那段 T005 · 正在看的行消失 T010 · 库内零快照行 T004a · 返回含库内没有的合约 T004a · 单腿部分字段为空 T005 · 成交量口径切换 T007 T008 · 跳空日 T004b · 定窗基准不可用 T005

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

- **`FR-020`（候选集每次整体重召回、不锁定成员）在服务端零 task** —— 它是 T004a 的**结构结果**而非独立行为：overlay 插在 `loadChain`（召回的共同根）之后，每次请求本就整条链重新召回，**要「锁定成员」反而得额外写代码**。客户端侧由 T010 承担。⇒ 下次 analyze 别把它当缺口补 task。
- **US3（超上限分批）不实装分批** —— 现有 13 只美股锚窗内最大 285，全部 ≤ 399，今天零触发。T006 只落 fail-closed 守卫。真要分批是将来的事，届时区块级时间取**最早**那批。
- **plan §D2（shim 信封解析单点化）在 tasks 里零引用** —— 它是 047 与 061 之间的**既有**重复，已作为独立 refactor 走 **PR #116** ship（5 个 adapter 收成 1 个单点，零行为变化）。本片经读取口拿已解析好的 `OptionSnapshotBatch`，**不产生第三份**。⇒ 这是唯一一个「plan 有 §D 而 tasks 零 task」的合法情形，下次 analyze 别当缺口。
- **链分析报表无独立 mockup / 无独立 mobile task** —— 它与选约表共用 `loadChain`，档位标记同源，主体是 IV 曲线不受档位形态影响。若 T013 真机发现曲线在实时档下另有呈现问题，再补。

## 单 PR 与上线顺序

跨端 feature ⇒ **单 PR 原子 merge**（Constitution §V）：server impl + IT + `api-client` regen + mobile 消费 + 两层验证全部同 PR。

T013 的真机实证有时间窗（美股常规时段），**允许在 PR 开着的状态下补**，但 `SC-001` / `SC-002` 拿不到前不翻 `implemented`。
