---
feature_id: 062-trading-calendar-horizon
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-18'
updated_at: '2026-08-18'
adr_refs: ['0032', '0040', '0043', '0047', '0052', '0053', '0062']
context7_verified: []
---

# Implementation Plan: 交易日历前瞻视野与三态语义收口

## Summary _(mandatory)_

把 `marketdata.trading_day` 从「只向后填充 + 无行即非交易日」改成「有显式覆盖声明的前瞻视野 + 三态判定」：每日在既有历史段填充之外多填一段 `[明天, 当年 12-31]`（源只走权威年历），新增一条 per-market 覆盖声明作为「未知」的唯一判据；读侧端口由布尔换三态，各消费方显式处置「未知」（`alert` 经既有 `marketdata-rules` 边复用纯判据 + 自持只读直查，`optionsdesk` 经既有 `MarketdataModule` 端口边注入）；配一条视野告警与一道机器门禁防复发。**零 boundaries 配置改动、零新依赖。**

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

本 feature **不新增任何 vendor / npm 包**：前瞻段两个源（`FutuCalendarAdapter` / `StaticCalendarAdapter`）与路由层 `MarketRoutedCalendarSource` 均已在仓内实装并已在生产服役。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles.

逐条：**I SDD** 完整链无跳步（无 UI，不需 Mockup 步）；**II TDD** 每 task 红→绿闭环，且有三条「现在必红」的回归先行；**III 原子 task** 见 tasks 阶段；**IV 模块边界** 见 D2/D3 —— **不新增任何放行边**，两个消费 ctx 各走其既有合法边，跨 ctx 注入点与只读直查均挂注释、护城河探针可见；**V 类型同步链** 无 HTTP 端点变更，不触发 openapi / api-client 重生成。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 本 feature **零新增 endpoint**，「每个新端点至少一次真启动冒烟」不适用；等价保障 = 每条 `state_branches` 一个 Testcontainers（PG + Redis）集成断言 + **生产验收**（部署后次一交易日盘中查 `bull:alert-eval:completed` 的 `returnvalue` 必须出现 `evaluated`）。
- [x] **Mobile / Web**: N/A — 纯 server 侧，`web_compat: na`。
- [x] **Evidence**: 基线实测（2026-08-18 生产）：`trading_day` 三市场 `max(date)` 均为 `2026-08-17`、`>= current_date` 零行；`calendar_sync_health` 末次成功 `2026-08-17 13:00 UTC`（= 21:00 北京）、`served_by` cn/hk=`tencent` / us=`futu`、零 `last_error`；`bull:alert-eval:completed` 保留的 60 拍中 43 拍 in-session 全为 `{"status":"skipped-holiday"}`、17 拍午休 `skipped-session`、**零 evaluated**。验收时须重取同三项对照。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 不引入任何新第三方包 / SDK / 工具（见上方 Cargo-cult 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。触及的全部代码（`marketdata` / `alert` / `optionsdesk` 三 ctx 与 `ops/jobs/`）无 Java/Spring 迁移史。

- [x] **Evidence**: `rg -n 'org\.springframework|org\.mapstruct|mbw-[a-z]+/src/main/java' apps/server/src/{marketdata,alert,optionsdesk} ops/jobs` → 零命中（impl 起手复跑留证）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question affected                                                                           | Classification     | Mitigation / next step                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0053 | `sunset_trigger` #2「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts` → 重审是否升级为共享 package」 | **未命中**（维持） | 本 plan 只让 **`alert` 一个 ctx** import `marketdata/*.rules.ts`（其放行边 023 起即存在）；`optionsdesk` 走**端口注入**、零 rules import。⇒ 仍是「单 ctx 放行」，061 的同款判定得以保持。见 D3 |
| ADR-0053 | `sunset_trigger` #1「任一 `*.rules.ts` 出现带状态/带 IO 内容 → 细分元素判据失效」                 | accepted-as-is     | 新增的 `trading-day.rules.ts` **零 IO、零 class、零 DI**，判据不失效。D2 有一条硬禁令锁住这点                                                                                                    |
| ADR-0047 | 端口形态：`TRADING_CALENDAR_PORT` 由布尔换三态 + 增一个方法，属 port reshape                      | accepted-as-is     | 不触发其任一 trigger（链长未 > 5；非 QUOTE_PORT 实时化；非第 2 个外部数据子系统）。port-first 原则本就要求先定形再实现，本 plan 即在定形                                                          |
| ADR-0062 | optionsdesk 对 marketdata 的 module 边（061 T008 立为「本 ctx 唯一一条 module 边」）              | accepted-as-is     | 本 plan 复用该边、不新增第二条；`MarketdataModule` 的 exports 多一个既有 token                                                                                                                   |
| ADR-0052 | alert 三条 trigger                                                                                | 未触发             | 不改 alert 的调度形态与数据通路，只改它问日历的方式                                                                                                                                             |

**Evidence**: `rg -n 'sunset_trigger' -A 6 docs/adr/*.md` 逐条过。**本 feature 无需 amend 任何 ADR。**

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（本 feature 适用条目）

- **并发/事务**：覆盖声明推进用 upsert、**逐市场独立**（一市场失败不拖垮其余，沿 `syncRange` 既有形态）。外部 I/O 全程 **split-tx**，禁 tx 内等 HTTP。→ `../../docs/conventions/server-impl-playbook.md`
- **跨时区日期**：任何「今天」必须按**交易所时区**求（`marketDateFor`），禁用宿主时区。→ `../../docs/conventions/cross-timezone-date-semantics.md`
- **前端**：N/A，无 mobile 改动。

---

#### D1 — 覆盖声明：新表，且**只在整段成功后推进**

- 新增 `marketdata.calendar_coverage`：`market`（PK）/ `covered_from` / `covered_to` / `served_by` / `updated_at`。它是判定「未知」的**唯一**依据。
- **推进规则**：某段 `[a, b]` 整段填充成功后，仅当它与既有区间**相邻或重叠**（`a <= covered_to + 1 天`）才扩展 `covered_from = min(...)` / `covered_to = max(...)`；出现缺口 ⇒ **不推进** + ERROR 留痕（只在停摆 > 30 天或首次上线时触发，正是该触发的时候）。
- 🚫 **MUST NOT 用 `max(date)` 派生覆盖终点**。那是又一次「库里没有的即为假」推断，中间空洞看不出来 —— 不能在修这个病的过程中原地重犯一次。
- 🚫 **MUST NOT 往 `calendar_sync_health` 加列凑合**。那张是 **liveness**（填充还活着吗），本表是 **coverage**（覆盖到哪儿了）。044 已把 liveness 与 freshness 分清过一次并写进注释；混一张表 = 两个语义重新焊死，探针再分不出「填充挂了」与「填充活着但视野不动」。
- 命名三处一致（per `business-naming.md`）：概念 `calendar coverage` / 表 `calendar_coverage` / model `CalendarCoverage`。

#### D2 — 三态判定：纯函数落 `*.rules.ts`，两个消费 ctx 各走**已有**的那条边

判定本体 = **零 IO 纯函数**，新建 `apps/server/src/marketdata/trading-day.rules.ts`：

`classifyTradingDay({ hasExactRow, coverage, date }) → 'trading' | 'non-trading' | 'unknown'`

- 🚫 **该文件 MUST 保持零 IO / 零 class / 零 DI**（不接 `PrismaService`、不接 Prisma 类型）。带 IO 进去会直接让 **ADR-0053 sunset_trigger #1** 触发、`marketdata-rules` 细分元素的判据当场失效 —— 那条元素正是 alert 唯一的合法边。
- **两个消费 ctx 走两条不同的既有边，这是刻意的、不是不一致**：

  | ctx          | 合法边（已存在）                                              | 本 feature 的接法                                                          |
  | ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | `alert`      | 仅 `marketdata-rules`（023/ADR-0053 放行）                    | import 纯判据 + **自持** `PrismaService` 只读直查（挂 `CROSS-CONTEXT-READ`） |
  | `optionsdesk` | 仅 `MarketdataModule` 端口（061 T008 立为「本 ctx 唯一 module 边」） | **注入 `TRADING_CALENDAR_PORT`**（挂 `CROSS-CONTEXT-SYNC`），零 rules import |

- 🚫 **MUST NOT 为了「统一」而给 optionsdesk 放行 `marketdata-rules`**。那条禁令是 ADR-0053 sunset_trigger #2 的机器绊线，061 的 Guardrail 2 原话：「撞红了要把逻辑推回 adapter，不是改 allowlist；改了会让 Gate 0.4 对 ADR-0053 的『未命中』判定当场失效」。本 plan 正是把它推回端口。
- 🚫 **MUST NOT 把 Prisma 查询搬进 alert 侧的共享函数**（哪怕只是「接受一个 `PrismaService` 参数」）。搬进去之后 alert → `trading_day` 这条跨 ctx 读边就从 `check-server-moat` 视野里消失（注释会落在 marketdata 自己家，那儿不算跨 ctx）。**护城河探针失明**比多写两行查询贵得多。
- 端口 `TRADING_CALENDAR_PORT`：`isTradingDay(market,date): boolean` → `classify(market,date): TradingDayStatus`（**删除布尔方法** —— 保留 = 留坑；换签名让 TS 编译器把每个调用点逼出来显式处置），并增一个 `lastClosedSession(market, now): string | null`（见 D5 末行）。`MockMarketDataAdapter` 同步实现（它是 054 之后仍绑 mock 的两个端口之一）。`MarketdataModule` 的 `exports` 增列 `TRADING_CALENDAR_PORT`。
- `DbTradingCalendarAdapter` 内部由「exact + 近窗 count」改为「exact + 读 coverage」再喂纯函数。旧的「近 30 日整窗零行 ⇒ fail-open」判据**整体退役** —— 它想表达的「表还没填过」现在由 coverage 缺行精确表达。

#### D3 — boundaries：**零配置改动**，两条既有边各司其职

- `apps/server/eslint.config.mjs` **一行不改**。`alert` 的 `marketdata-rules` 放行边自 023 即存在；`optionsdesk` 的 `MarketdataModule` 端口边自 061 即存在（且 `optionsdesk` 的 disallow 本就不含 `marketdata`）。
- 因此 **ADR-0053 sunset_trigger #2 不触发**：仍然只有 alert 一个 ctx import 他 ctx 的 `*.rules.ts`。**无需 amend 任何 ADR。**
- ⚠️ impl 期若在 optionsdesk 侧撞到 `marketdata-rules` 的 lint 红，**说明接法走偏了**（该走端口却写成了 import）。修法是回到端口，**不是**动 allowlist。

#### D4 — 前瞻填充：同一个路由类的**第二个实例**

- `MarketRoutedCalendarSource` 起第二个实例作**前瞻路由**：`us → [富途]`、`cn/hk → [静态年历]`。同一个类、不同 routes map，**零新抽象**。未登记市场照既有语义 throw（fail-closed）。
- 🚫 **MUST NOT 把腾讯放进前瞻路由**。它是「指数当日有 bar ⟺ 当日开市」的反推源，结构上答不了未来；放进链首只会让 cn/hk 每天各多一条恒定假失败 WARN —— 044 已论证过这种告警疲劳的代价。
- `syncRange` 参数化其 source（抽 `syncRangeWith(source, markets, from, to)`），`populate()` 变成同一次运行内的两段：历史段 `[今天-30, 今天]`（与今天完全一致）+ 前瞻段 `[明天, 当年 12-31]`。两段**各自留痕、各自推进 coverage**，一段失败不让另一段的声明失真。
- 跨年：前瞻窗自然变成 `[明天, 次年 12-31]`；静态年历年更入库前，静态层按其 Guardrail 7「区间未被覆盖范围完全包含 → throw」整段失败 ⇒ 视野停在当年末不动 ⇒ D6 的年末豁免生效、不假红。**既有机制，不新写。**
- `marketdata-trading-day-seed.cli.ts` 同样推进 coverage（上线灌视野走它，见 D9）。

#### D5 — 消费方接入：逐个显式处置「未知」

| 消费方                                                       | 现状                       | 改后取数路径           | unknown ⇒     | 依据                                                |
| ------------------------------------------------------------ | -------------------------- | ---------------------- | ------------- | --------------------------------------------------- |
| `alert/intraday-eval.processor.ts`（cn 盘中，5min）          | 裸 `count`，无行即 holiday | 自持直查 + 纯判据      | **跑** + 留痕 | 另有独立时段闸；多跑一轮 << 永久静默                |
| `optionsdesk/sync-anchor-intraday.ts`（us 盘中，30s）        | 裸 `count`                 | **注入端口**           | **跑** + 留痕 | 另有 vendor 市场状态闸取交集（FR-014 两闸不可互替） |
| `marketdata/option-snapshot-remediation.ts` ② 级             | 端口                       | 端口                   | **跑**        | 起手覆盖率复判，不缺即零外呼                        |
| `marketdata/anchor-cold-start.usecase.ts` D4                 | 端口                       | 端口                   | **abandon**   | 落既有 `CALENDAR_MISSING` 结局；写敏感档不猜口径    |
| `marketdata/freshness-sla.check.ts` 折龄                     | 端口                       | 端口                   | 当开市        | 保守多算龄；且只问过去，实际不会 unknown            |
| `optionsdesk/last-closed-session.ts`（4 个 use case 消费）   | 裸查最大交易日             | **注入端口**（新方法） | 返 `null`     | 基准日超出覆盖 ⇒ 回退当期档（与既有 fail-open 同向） |
| `marketdata/get-instrument-bars.usecase.ts` 同款判据         | 自查                       | 复用同一实现           | 返 `null`     | 同上，顺带消掉两处重复实现                          |

- 🚨 **留痕必须能区分「跑是因为确认交易日」与「跑是因为不知道」**（FR-013）。两者日志长一样 = 下次同类故障还是查不出。
- 末两行顺带修掉早前查出的一个 🟡：cn/hk 在北京 15:00–21:00 窗口内「最近一场已收盘交易日」少算一天、陈旧度偏乐观。D4 落地后该窗口自愈，coverage 判据是其失效兜底。
- ⚠️ `optionsdesk/last-closed-session.ts` 文件头那条「**不合并**：合并等于让 optionsdesk 经 marketdata 的函数无痕读表，护城河探针就再也看不见这条边」写于 046，其**前提在 061 之后已变**：改走端口后这条边以 `CROSS-CONTEXT-SYNC` 注入点的形态存在，`check-server-moat` Check 2 照样扫得到。**改该文件时必须同步改写那段注释并写明理由**，否则下一个人会以为规矩被违反了。

#### D6 — 视野探针：判据下沉 SQL，年末豁免写进判据

- 判据**全部**写进 `ops/jobs/marketdata-calendar-health.sql`，bash 侧零 `if`、零阈值 —— 044 既定纪律（仓内无 bash 测试框架 ⇒ bash 里的判断必然无覆盖，撞 Constitution §II）。**改判据改 SQL，别改 bash，也别在别处内联复制那段 SQL。**
- 三档由重到轻：① 覆盖声明整体缺失 → 🔴；② `covered_to < current_date` → 🔴（视野已落后于今天）；③ `covered_to` 之后的交易日数 < **5** 且 `covered_to` 未抵当年 `12-31` → 🔴。
- **年末豁免必须在 SQL 里**（`covered_to >= 当年 12-31` 即达标）。靠人记 ⇒ 每年 12 月必假红 ⇒ 训练出「这条可以忽略」。
- ⚠️ `current_date` 是 DB 服务器（UTC）口径，与各市场「今天」最多差一天；阈值取 5 个交易日 ⇒ 1 天偏差不会假红。**这个容差是刻意的**，别为了精确把市场时区搬进 SQL（那就成了第三份时区表）。
- 与既有心跳告警**并存**：心跳答「填充还活着吗」，视野答「视野还在往前走吗」。二者 MUST NOT 互相替代（FR-017）。

#### D7 — 防复发门禁

- 新增 `scripts/checks/check-trading-day-read.ts`：扫 `apps/server/src/**/*.ts`，`src/marketdata/` 之外**命中 `prisma.tradingDay.` 的文件必须 import 共享三态判据**，否则拒（报错文案给出两条合法路径：注入 `TRADING_CALENDAR_PORT` / import `marketdata/trading-day.rules.ts`）。挂 lefthook + CI，与既有 `scripts/checks/*` 同形（`REPO_ROOT` 下沉写法 per 既有先例）。
- **改造完成后 `optionsdesk/` 侧应零命中**（两处都走端口），`alert/` 侧一处命中且合规 ⇒ **无需 allowlist**。若 impl 结束仍要给谁开白名单，说明 D5 某一行没落实。
- **双向反例必测**（合规放行 / 绕过被拒）—— 单向测试的门禁会静默失效。
- 与 `check-server-moat` **正交**：moat 管「跨 ctx 读/注入有没有注释」，本门禁管「读完之后有没有用对判据」。两者都拦不住对方那一类。

#### D8 — 交叉校验（FR-009）

- 前瞻段先写、历史段后到。历史段填充时对窗口内**已被前瞻段写过**的日期做一次差集比对：前瞻声称是交易日而活源没给（或反之）→ **WARN + 计数**，不阻断本轮。
- 🚫 **MUST NOT 自动订正**。谁对谁错要人判（交易所临时休市 vs 年历解析错，两者处置完全相反）。这条留痕的价值是「两条独立路径互为校验」—— 单源时代根本发现不了的那类错。

#### D9 — 上线顺序（**不可颠倒**）

1. 迁移建表 —— 空表 = 全 `unknown`，各消费方按 unknown 分派照常工作，**不停摆**（这是三态设计换来的：上线过程本身不制造停摆窗口）
2. 部署带前瞻填充的版本
3. **立即手动跑一次 seed CLI** 灌历史 + 前瞻视野（否则空等到当晚 21:00 才有视野）
4. 次一交易日盘中取验收证据（见 Gate 0.1）

🚨 顺序颠倒（先上三态/门禁、后上填充）会让线上白背一天全 `unknown`：能工作，但每个闸都在「不知道」的状态下跑，且探针立刻红。

#### D10 — 明确不做

- us **不补**离线年历第三层兜底（沿用 2026-07-31 拍板）。**别顺手往 `SUPPORTED_MARKETS` 里加个 `us` 字符串就算完** —— `static-calendar.adapter.ts` 那段绊线注释明写「要改这个取舍，连带要改探针的主源表与该段」。
- 半日市 `trade_date_type` 落库、交易所临时休市的事后订正 —— 均不在范围。
- 不动 alert 的调度形态、不动 061 的两闸结构、不动夜间管线的 22:00 / 06:30 时点。

### 测试策略

- **分层**：三态纯函数 → `*.spec.ts` 单测；端口 / adapter / 填充 / 消费方 → `*.it.spec.ts`（Testcontainers PG；alert 侧还需 Redis）。分类判据与后缀 per `docs/conventions/testing.md`。
- **`state_branches` 逐条对应 `it()` 块**（17 条，见 spec frontmatter）—— Testing Invariants 第三条，硬要求。
- **三条「现在必红」的回归先行**（TDD 的 RED 由它们提供）：① 埋「日历只到昨天」+ 盘中时刻 → 断言求值发生；② 埋视野充足 + 美东凌晨时钟 → 断言 D4 给 `premarket_backfill` 且 `oi_as_of` = 目标场；③ 埋终点过近 / 年末两种 coverage → 断言探针分别红 / 不红。
- ⚠️ Testcontainers spec **必须**经 `nx test server <file>` 跑（`vitest --root` 找不到 schema）。

## Complexity Tracking

> 无 Constitution 违规。以下两条是**扩大了公共面**的改动，记账备查（非违规，但下一个人应知道为什么）。

| 改动                                              | Why Needed                                                                                   | Simpler Alternative Rejected Because                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MarketdataModule` exports 增列 `TRADING_CALENDAR_PORT` | optionsdesk 两处消费方需要三态判定，而它**不能** import `marketdata/*.rules.ts`（ADR-0053 绊线） | 给 optionsdesk 放行 `marketdata-rules` → 触发 sunset_trigger #2 且要 amend ADR-0053；让 optionsdesk 各写一份判据 → 判据分散正是本 feature 的病根                  |
| `TRADING_CALENDAR_PORT` 增 `lastClosedSession` 方法      | 收编 optionsdesk 最后一处裸查，使 D7 门禁**无需 allowlist**；顺带消掉 marketdata / optionsdesk 两处重复实现 | 保留裸查 + 给门禁开白名单 → 白名单会腐烂，且「最近一场已收盘交易日」的判据继续两处维护、必漂移（`get-instrument-bars` 与 `last-closed-session` 现已是两份） |
