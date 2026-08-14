---
feature_id: 054-marketdata-mock-write-provenance
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-13'
updated_at: '2026-08-13'
adr_refs: ['0047', '0043', '0040']
context7_verified: []
---

# Implementation Plan: mock 行情写入留痕

## Summary *(mandatory)*

把「口的意图」（采集 vs 读取）从代码里的**隐含事实**升为**被类型强制的显式分类**：`kind === 'mock'` 时只有读取口绑 `MockMarketDataAdapter`，采集口改绑一个拒绝式 adapter —— 伪造行情因此**根本不落库**，而不是落库后靠留痕补救。新增采集口若照抄既有 `? mock : new X()` 写法会在**编译期**红，FR-010 的「结构上走不通」由类型系统兑现，零守门清单。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

零新依赖。全部改动落在既有 `apps/server/src/marketdata/` + `apps/server/src/config/` 文件内，复用既有 adapter class 范式（`EodBackedQuoteAdapter` / `DbTradingCalendarAdapter` 已是同形 class）。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

逐条：

1. **§ I SDD** — 本 feature 无 UI（`web_compat: na`），后端 use case 不含 mockup 步，`specify → clarify(specify 内消解) → plan → tasks → analyze → implement` 完整。
2. **§ II TDD** — 红点**已定位到具体行**，不需要现造：`apps/server/test/integration/marketdata.boot-015.it.spec.ts:60` 断言 `MOCK_PORTS`（含 `EOD_BAR_PORT` 等采集口）全部 `toBeInstanceOf(MockMarketDataAdapter)`，且 `:76` 直接调 `bars.getBars(...)` 期望返 fixture。**这条断言正是把缺陷编码成了预期行为** —— 改绑定的第一刻它就红。
3. **§ III Atomic task** — 见下方任务切分意图，5 条，每条 30min-2h 可独立 commit。
4. **§ IV Module boundary** — 全部改动在 `marketdata` 单 context 内 + `config/`（平台基座）。文件平铺无层子目录；新增的 `RefusingCollectionAdapter` 是 **adapter class**，属 ADR-0047 既有范式，**不是** ADR-0043 § 2/§ 4 禁的充血 Domain Class / Entity Mapper / 校验 VO class。无跨 context import，无 `prisma.<otherTable>.*`。
5. **§ V 类型同步链** — 零 controller / DTO / swagger 装饰器改动 ⇒ 无 `export-openapi` regen、无 `packages/api-client` 重生成、无 mobile 侧。纯 server 单 PR。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（Testcontainers PG + Redis）覆盖改动面。既有 `marketdata.boot-015.it.spec.ts` 全 boot `AppModule` 并逐 port 断言解析结果 —— 它就是本 feature 绑定改动的验证载体（改后断言分裂为「读取口 → Mock / 采集口 → Refusing」）。**新增**一条 remediation 写库路径 IT 顶替 dev 手工验证（见 D-6）。
- [x] **Mobile / Web**: N/A —— 本 feature 零 UI 改动，无 user story 落在客户端。
- **Evidence**: `apps/server/test/integration/marketdata.boot-015.it.spec.ts:60,76`（现有断言，改后即红）；新增 IT 落 `apps/server/src/marketdata/option-snapshot-remediation.it.spec.ts`。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本 plan 不引入任何第三方 package / SDK / tool（见 Dependencies 表的 explicit no-op）。

**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— feature is mono-native**。`marketdata` context 自 spec 015 起就是 mono 原生，从未存在于旧 Java/Spring meta-repo。

- **Evidence**: `rg -l 'org.springframework|mbw-.*src/main/java' apps/server/src/marketdata apps/server/src/config` → 零命中；`docs/adr/0047-marketdata-pluggable-data-access.md` 的 References 段只引 mono 内 ADR-0032 / 0043 / 0033。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0047 | 三条 Open Question（理杏仁配额 / 东财 ToS 限频 / 未来实时 `QUOTE_PORT` vendor 选型）**均不受本 feature 影响** | accepted-as-is | 不动 |
| ADR-0047 | 🚨 **不是 Open Question，是 Decision § 2 的绑定表**：其中「全部 \| `MockMarketDataAdapter`（dev/test 默认，零 env）」一行在本 feature 后**不再成立** | escalated-to-amend | 本 PR 内 amend ADR-0047 § 2 —— 把「全部」拆为「读取口 → Mock / 采集口 → Refusing」，并记因由。**amend 而非新 ADR**：范围在单 module 内，且是对既有决策的**收窄**不是推翻 |

- **Evidence**: `docs/adr/0047-marketdata-pluggable-data-access.md:76-85`（绑定表，「全部」那一行在 `:85`）、`:140-144`（Open Questions 三条）。扫描命令 `rg -il "open question" docs/adr/*.md` 命中 20 份，逐份看下来只有 0047 与本 feature 的改动面相交。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序，mock 隔离 = 抹掉 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装真实 DI 容器。**本 feature 尤其吃这条** —— 改的就是 DI `useFactory` 的绑定结果，任何不经 DI 容器的「测试」验不到本 feature 的核心。
- **EXHAUSTIVE BRANCHING**: `spec.md` `state_branches` 列出的每条分支必须在 integration test 里有对应 `it()` 块。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**: 所有文件平铺于 `apps/server/src/marketdata/`，**绝不**生成 `domain/` / `application/` / `infrastructure/` / `web/` 子目录。
> - **Anemic Data & Zero-Class**: 数据即 Prisma row。**绝不**生成 Domain Class / Entity Mapper。
> - **No Repositories**: use case 直注 `PrismaService`。
> - **The Moat**: **绝不**写 `tx.<otherTable>.*`。

#### D-1 · 「口的意图」是既存事实，本 feature 只是给它命名并强制

逐 port 核过 consumer（`marketdata.module.ts` 的 `provide:` 全集 × 各自的 `@Inject` 消费方），**31 个 vendor port 零双用途**：

- **采集口（27 个）** —— 产出**必然被持久化**。消费方全是写手：`dimension-executor.ts`（22 个）+ `sync-option-snapshot.usecase.ts` / `sync-option-contract.usecase.ts` / `sync-profile.usecase.ts` / `sync-universe.usecase.ts` / `sync-earnings-event.usecase.ts`（各 1）。
- **采集源（1 个）** —— `TRADING_CALENDAR_SOURCE`，消费方 `trading-calendar-sync.service.ts`（写日历表）。
- **读取口（2 个）** —— `QUOTE_PORT`（消费方 `get-quotes.usecase.ts`）、`INSTRUMENT_SEARCH_PORT`（消费方 `search-instruments.usecase.ts`）。两个 use case 文件**零 `prisma.` 引用**，实证只读。
- **闸口（1 个）** —— `TRADING_CALENDAR_PORT`：形态是读，但 mock 下它返「周一~周五皆交易日」，而它的三个消费方全是 scheduler（`sync-tick-driver` / `option-snapshot-remediation` / `freshness-sla.check`）。

27 + 1 + 2 + 1 = 31 ✓。

📌 两个读取口里只有 `QUOTE_PORT` 绑 `MockMarketDataAdapter`；`INSTRUMENT_SEARCH_PORT` 在 mock 下绑的是 `LocalInstrumentSearchAdapter(prisma)`（直查真 `Instrument` 表的 pg_trgm 搜索，`marketdata.module.ts:507-511`）—— 它**本来就不伪造数据**，本 feature 不动它。

📌 **`TRADING_CALENDAR_PORT` 是事故的使能者，不是旁观者**：2026-08-12 是周三，08:00 补救 cron 的交易日闸正是被这个假日历放过去的。它的处置见 D-3。

#### D-2 · mock 侧「采集口不给数据」靠**缺省结构**强制，不靠类型（FR-010 的兑现）

🚨 **本节 2026-08-13 于 impl 起手时重写**。原方案押在「`MockMarketDataAdapter` 收窄 `implements` ⇒ 采集口绑定编译期红」，动手前探针实测**两条链都断**（证据见下），故换机制。

- 28 个采集口的 provider 改由 `collectionPort(token, { inject, live })` helper 产出：**mock 分支收进 helper 内部恒给拒绝壳，per-port 根本没有「mock 分支」这一行可写。**
- 读取口（`QUOTE_PORT` / `TRADING_CALENDAR_PORT`）与 `INSTRUMENT_SEARCH_PORT` 保留裸 provider 字面量 + 显式 `cfg.kind === 'mock' ? mock : …`，并各带一行「为什么它可以留 mock」的判据注释 —— 让偏离**看得见**，而不是混在 28 个同形块里看不出来。
- **关键机制 = 缺省正确**：将来有人加一个采集口，照抄邻居就是 `collectionPort(...)`，**自动**拿到拒绝壳 —— 作者确实什么都没多做。FR-010 的兑现方式从「让错的事变红」改成「让对的事成为唯一能写的事」。后者更强：它不依赖任何守门物**存在**，也就没有守门物可被绕开或忘记更新。
- `MockMarketDataAdapter` 的 `implements` 列表**保持原样，不收窄**（理由见下）。

🚨 **拒绝侧用「带类型参数的工厂」，不要手写实现**：`MockMarketDataAdapter` 现有 **931 行 / 34 个方法**；照它对等手写一个实现 27 个采集口接口的拒绝类，是 senior engineer 会当场判过度的形态。改用一个泛型工厂返回按目标 port 类型标注的拒绝壳（属性访问返一个「一调即抛」的函数），**约 15 行**顶掉全部。

工厂形态引入的唯一新风险是「误把读取口也拒了」—— 由 boot IT 的读取口断言接住（T001 verify）。

**实测证据**（探针落 `apps/server/src/marketdata/`，走仓内 `tsconfig.typecheck.json`；两处 `@ts-expect-error` **全部报 TS2578 "Unused"** ⇒ 两处都不产生类型错误）：

| 探针 | 模拟形态                                              | 原 D-2 预期                | 实测                                                                                                                                                     |
| ---- | ----------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `implements` 收窄了、方法体还在                       | 不能再当 `EodBarPort` 用   | 照样通过 —— TS 是**结构化**类型，`implements` 只是一次 check，不是 nominal 约束                                                                          |
| B    | 方法体也删光的对象绑进 `EOD_BAR_PORT` 的 `useFactory` | `tsc` 直接红               | 零报错 —— Nest 的 `provide` 是裸 `Symbol`（`InjectionToken`），`FactoryProvider<T>` 的 `T` 从 `useFactory` **返回值反向推断**，token 与 `T` 之间零关联 |

⇒ 「把 `mock` 绑到采集口会红」这件事**在收窄前的今天就已经不红**，收窄之后也不会红。原 T001 verify 里那条 `@ts-expect-error` 负向断言按原写法会因 unused 而**自己变红**。

**为什么连 `implements` 收窄也一并撤掉**：探针 A 证明它零强制力；而 `implements` 当下**仍在干一件实事** —— 保证 mock 的 34 个方法签名与各 port 接口不漂移，而**46 个测试文件**正是拿它当「其余端口」的 no-data stub。撤掉 = 零收益 + 丢掉一道现存的签名检查。改为**只更新类文档注释**：写明自 054 起 DI 只在两个读取口绑它，采集口在 mock 下绑拒绝壳，它对其余 port 的实现自此只服务测试内的 stub 用途。

#### D-3 · `TRADING_CALENDAR_PORT` 保留 mock，理由是它不落库

闸口留在 mock 侧（否则 dev 下 `freshness-sla.check` 这类只读检查也起不来，违 FR-009）。伪造日历放行之后，写手会在**下一步**撞上 `RefusingCollectionAdapter` —— 拦截点后移一格，但结果相同：**零写库**。

代价是 dev 下每天会多几条「被拒」日志。这是刻意的：它是「你的本地进程在试图采集」的**可见信号**，而事故当天最缺的正是可见性。

#### D-4 · 拒绝的形态必须是可识别的专属错误，不是裸 `Error`

`RefusingCollectionAdapter` 每个方法抛专属错误类型（如 `MockCollectionRefusedError`），消息里写清「这是 `MARKETDATA_PROVIDER=mock` 使然，不是故障」。

写手侧**不改** catch 结构 —— 既有写手已各自整轮 try/catch 且不上抛（`sync-anchor-quote.scheduler.ts` / `trading-calendar-sync.service.ts` 皆 `logger.error` 不上抛，`option-snapshot-remediation.ts` 逐票独立）。让专属错误走既有路径落日志即可。**不要**为了「日志好看」去逐个写手加分支判断 —— 那正是清单式方案的复活。

🚨 **拒绝壳的 `get` 陷阱必须对一批 infra key 返 `undefined`，否则 `kind=mock` 下全 boot 当场崩**（2026-08-13 读源码核出，非推测）：`@nestjs/core/hooks/on-module-init.hook.js:13` 对**每个 provider 实例**做 `isFunction(instance.onModuleInit)` —— 拒绝壳若对任意 key 都返「一调即抛的函数」，Nest 会认定它有生命周期钩子并**在 boot 时调用**。denylist 至少含：5 个 Nest lifecycle hook（`onModuleInit` / `onModuleDestroy` / `onApplicationBootstrap` / `onApplicationShutdown` / `beforeApplicationShutdown`）+ `then`（否则 `await` 会**挂住而不是抛** —— 全清单里唯一连红都不给的坑）+ 序列化 / 调试类（`constructor` / `toJSON` / `toString` / `valueOf` / `inspect`）+ **全部 symbol key**。

#### D-5 · 配置层：`kind` 未知值必须 boot 抛，且 compose 的 `:-mock` 兜底必须去掉（FR-008）

**两处，缺一不可。**

**① `apps/server/src/config/marketdata.config.ts:38`** 现状 `const kind = process.env.MARKETDATA_PROVIDER ?? 'mock'`，随后 `if (kind === 'live')` —— **任何非 `'live'` 的值都静默落 mock**，包括拼错的 `liv` / `Live` / `production`，以及**空串**（`??` 是 nullish 合并，空串不触发）。改法：显式枚举校验，未知值 boot 即抛（与该文件已有的「`kind=live` 缺 `LIXINGER_TOKEN` 即 fail-fast」同构）。

**② `docker-compose.tight.yml:170`** 现状 `MARKETDATA_PROVIDER: ${MARKETDATA_PROVIDER:-mock}`。`.env.production:59` 确实写了 `=live`，但这个 `:-mock` 意味着 **env-file 一旦没加载，生产容器就静默跑 mock**，且经 ① 的空串路径一路穿到底、零告警。去掉 `:-mock`，让缺失变成空串 → 撞 ① 的枚举校验 → boot 抛。

📌 **这个仓自己已经把它当标准范例在引用**：`docker-compose.tight.yml` 内有 **6 处**注释写「同 `MARKETDATA_PROVIDER` 静默陷阱」（OSS / code-index / ASR / 推送 / 队列 token 各自的漏映射风险都拿它作参照）—— 范例本身从未被修。本 feature 一并修掉。

**变量缺失仍默认 mock**（dev 侧）—— 这是刻意保留，但**理由不是「测试依赖它」**（`apps/server/vitest.config.ts:49` 与 `.env.example:104` 都显式设了值，不依赖默认）。真正理由：D-2 落地后 mock 默认**已不再能写库**，silent default 在本例中不再危险 —— 保留它不违背 fail-fast 原则的**目的**。ADR-0047 的「零 env → dev/test 可跑」设计意图因此得以保留。

> 业界锚：silent fallback 是公认 antipattern（"In critical systems, it's better to be clearly broken than silently wrong"），主张缺失/非法配置 boot 即崩。本条对「缺失」的偏离是**带论证的刻意选择**，不是疏漏。

#### D-6 · dev 失去的验证能力由 IT 顶替（FR-011）

D-2 之后 dev **彻底跑不了**写手写库这条路（这是 spec Edge Cases「拆东墙补西墙」点名要补的）。现状盘点：`marketdata` 目录下只有 **1 个** IT（`eod-backed-quote.adapter.it.spec.ts`），而 `option-snapshot-remediation.spec.ts` / `sync-option-snapshot.usecase.spec.ts` 都是单测。

⇒ **必须新增** remediation 写库路径 IT：起 Testcontainers PG，用 stub 采集口喂确定性数据，覆盖 ① 当日重试（落 `source = eod`）与 ② 盘前兜底（落 `source = premarket_backfill`）两条，断言**落库行的 `source` 值**而不只是返回值。测试命名 / size 归属照 `docs/conventions/testing.md`（`*.it.spec.ts` 后缀）。

#### D-7 · 留痕类 FR 在本路线下是**蓄意的空满足**，不是覆盖缺口

🚨 **写给 `/speckit-analyze` 与 tasks 作者**：spec 的 FR-001 / FR-002 / FR-003 / FR-005 / FR-006 都是「**若**伪造行情被持久化，则……」形态的条件句。本 plan 选的是 FR-004 二择一里的**「拒绝写入」**那一支 ⇒ 前件恒假 ⇒ 这 5 条**空满足**。

**这是蓄意的，不要为它们补 task。** 需要的只是一条 IT 断言把「前件恒假」本身验掉（`kind=mock` 下写手跑完，目标表行数零增长）。

唯一仍需实做的留痕类需求是 **FR-007（历史无痕行判「来源不可考」）**：靠**水位线**兑现 —— 「本 feature 生效之前写入的 dev 库行一律来源不可考」，写进 runbook；而 dev 库每日 `truncate + reload` 会让这个集合递减到空。不新增 schema 列、不做数据迁移。

#### D-7b · 业界对照（2026-08-13 联网核过，非记忆）

| 业界实践 | 出处 | 与本 plan 的关系 |
|---|---|---|
| 「收到非预期调用即抛」的 test double 是 canonical 形态（Meszaros 分类里唯一被明确描述为会抛的类型） | Fowler · TestDouble | ✅ `RefusingCollectionAdapter` 有出处，不是自创 |
| ISP 应用到 hexagonal port：按用途拆，第一条收益原文即「queries 与 commands 可以有不同实现」；但明确**警告过度分割** | codeartify · Interface Segregation | ✅ D-1/D-2 命中该收益，且**不越警戒线** —— 本 feature 不拆任何 port，只是给已单一职责的 31 个 port 分组 |
| 配置 silent fallback 是 antipattern，应 boot 即崩 | Enterprise Craftsmanship · Fail Fast | ✅ 见 D-5（含一处**带论证的刻意偏离**） |
| **合成数据应自识别、一眼可辨**：RFC 2606 保留 `.invalid` 供构造「obvious at a glance」的无效名；Stripe 测试卡 `4242…` "never works in production" | RFC 2606 / Stripe Docs | ⚠️ **本 plan 蓄意不做，见下** |

**关于「让 mock 数据一眼假」—— 知道且蓄意不做**：本仓 mock 的 spot 是 `128.40`，与真行情同形，事故正源于此。业界正解是让它一眼假。不做的理由有三：① D-2 落地后 mock 产出**已不可能落库**，这层只剩纵深防御价值；② `128.40` 是**刻意选的**（`mock-market-data.adapter.ts:839` 注释：`spot 取 128.40 (< K=130) ⇒ PUT 实值`），改绝对值会打乱 fixture 编码的实值/虚值关系；③ RFC-2606 式的正解（把 `600519` 换成保留式假代码）会 churn 大量以 `cn:600519` 为键的 fixture 与断言，成本落在与本 feature 无关的测试上。

🚨 **残余风险已知**：它挡不住「有人拿 dev 的**读**数据下结论」这条路（052 T016 差一点就是那样）。若将来再撞一次，这条就该被提起来单做。

#### D-8 · ADR-0047 § 2 绑定表本 PR 内 amend

`docs/adr/0047-marketdata-pluggable-data-access.md:85` 的「全部 | `MockMarketDataAdapter`（dev/test 默认，零 env）」一行改为读取口 / 采集口两行，并记本次因由。见 Gate 0.4。

#### 任务切分意图（供 `/speckit-tasks`）

1. `[Server]` 采集口 / 读取口分类落地 + 拒绝式工厂 + `marketdata.module.ts` 28 个绑定经 `collectionPort` helper 改写 —— 红点是 `marketdata.boot-015.it.spec.ts:60,76`
2. `[Server]` `marketdata.config.ts` `kind` 枚举校验 **+** `docker-compose.tight.yml:170` 去掉 `:-mock` 兜底（FR-008，D-5 两处缺一不可）。⚠️ 动 compose 映射属 `config-env-sync` 纪律 9 位置之一 ⇒ 收尾必跑 `check-env-sync`
3. `[Server]` remediation 写库路径 IT（FR-011，D-6）
4. `[Server]` 「`kind=mock` 下写手跑完零写库」IT 断言（D-7 的前件恒假验证，覆盖 `state_branches` 前 5 条）
5. `[Docs]` ADR-0047 § 2 amend + runbook 水位线与「被拒日志是预期行为」说明（D-7 / D-8）

## Complexity Tracking

> 无 Constitution 违规，本表留空。
