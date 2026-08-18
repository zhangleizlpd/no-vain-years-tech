---
feature_id: 062-trading-calendar-horizon
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-18'
updated_at: '2026-08-18'
---

# Tasks: 062-trading-calendar-horizon（交易日历前瞻视野与三态语义收口）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0053`](../../docs/adr/0053-cross-context-pure-rules-import.md)（`marketdata-rules` 单 ctx 放行边，本片**刻意不触发**其 trigger #2）+ [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（optionsdesk → marketdata 端口边，本片复用）+ [`ADR-0047`](../../docs/adr/0047-marketdata-pluggable-data-access.md)（port-first + fallback chain）+ [`ADR-0052`](../../docs/adr/0052-alert-bounded-context.md)（alert 叶子 + Q7-B 只读）
**Branch**: `062-trading-calendar-horizon`
**病根一句话**：`trading_day` 只向后填充，读侧把「无记录」读成「不是交易日」（closed-world assumption）⇒ 盘中预警全天不求值 / 期权快照二级兜底从不执行 / 建锚补数在美东凌晨标错来源与 OI 归属日。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Ops]` / `[Docs]`。本片**无** mobile / contract 面（`web_compat: na`，零 HTTP 端点变更）。
- 🚨 **FR / SC 一律逐条枚举，禁写 `FR-004~FR-008` 这类范围记法** —— 本仓自审纪律是逐条 `grep`，范围记法会让中间几条每次都被报成零命中（2026-08-18 analyze 实撞）。

## Path Conventions

| 用途                                     | 路径                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三态判据纯函数（**新建**）               | `apps/server/src/marketdata/trading-day.rules.ts`                                                                                                                     |
| 覆盖声明推进判据（**新建**）             | `apps/server/src/marketdata/calendar-coverage.rules.ts`                                                                                                                |
| 日历读端口（改：换三态 + 增方法）        | `apps/server/src/marketdata/trading-calendar.port.ts`                                                                                                                  |
| 表驱动 adapter（改：判据换 coverage）    | `apps/server/src/marketdata/db-trading-calendar.adapter.ts`                                                                                                            |
| mock adapter（改：同步实现新签名）       | `apps/server/src/marketdata/mock-market-data.adapter.ts`                                                                                                               |
| 填充服务（改：两段 + coverage 推进）     | `apps/server/src/marketdata/trading-calendar-sync.service.ts`                                                                                                          |
| 接线 + exports（改）                     | `apps/server/src/marketdata/marketdata.module.ts`                                                                                                                      |
| seed CLI（改：推进 coverage）            | `apps/server/src/marketdata/marketdata-trading-day-seed.cli.ts`                                                                                                        |
| marketdata 侧消费方（改 ×4）             | `apps/server/src/marketdata/{option-snapshot-remediation,anchor-cold-start.usecase,freshness-sla.check,get-instrument-bars.usecase}.ts`                                |
| alert 盘中闸（改）                       | `apps/server/src/alert/intraday-eval.processor.ts`                                                                                                                     |
| optionsdesk 盘中闸（改：裸查 → 端口）    | `apps/server/src/optionsdesk/sync-anchor-intraday.ts`                                                                                                                  |
| optionsdesk 陈旧度基准（改：裸查 → 端口）| `apps/server/src/optionsdesk/last-closed-session.ts` + 4 个消费 use case（`get-underlying-detail` / `list-anchors` / `update-anchor` / `review-anchor`）               |
| DB（**新表**）                           | `apps/server/prisma/schema.prisma` + `apps/server/prisma/migrations/<yyyymmddhhmm>_add_calendar_coverage/`                                                              |
| 视野探针（改）                           | `ops/jobs/marketdata-calendar-health.{sh,sql}`                                                                                                                         |
| 防复发门禁（**新建**）+ 接线             | `scripts/checks/check-trading-day-read.ts` + `lefthook.yml` + `.github/workflows/pr-validation.yml`                                                                     |
| IT                                       | `apps/server/test/integration/marketdata.calendar-062.{horizon,tri-state,horizon-probe}.it.spec.ts` · `alert-intraday-calendar-062.it.spec.ts` · `optionsdesk-062.calendar.it.spec.ts` |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/{marketdata,alert,optionsdesk}/` 下 **MUST NOT** 建任何子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且**踩了不会红**的坑）

1. 🚨🚨 **T006 的调用点映射必须是 `!== 'non-trading'`，不是 `=== 'trading'`** —— 这是全片最容易写错、且**错了全绿**的一行。旧 adapter 在「近窗零行」时 fail-open 返 `true`；换三态后那条路径给的是 `unknown`。用 `=== 'trading'` 会把它翻成 `false` ⇒ **上线首刻**（coverage 表刚建、尚未灌值）全体消费方判「今天不是交易日」，正好在最不能停摆的时刻整体停摆。而生产里「近窗零行」从不发生、测试里也未必有断言 ⇒ **没有任何测试会红**。
2. 🚨 **coverage 推进 MUST NOT 出现在失败分支** —— `syncRange` 的 per-market `try/catch` 里，`catch` 分支只写心跳、**绝不碰 coverage**。声明是本 feature 唯一的真相源，它一旦在填充失败时照样前进，三态判定全线失真且**测试通常只断言「成功时推进」所以不会红**。必须**另配一条反例断言**：源抛错 → `covered_to` 一天都不动。
3. 🚨 **前瞻窗口的年份 MUST 按市场时区算，不能用宿主 `getFullYear()`** —— 跨年那几小时 us 与 cn 不在同一年（北京 1 月 1 日 08:00 = ET 前一年 12 月 31 日 19:00）。用宿主年份会给 us 请求一个**已经过去的**年末 ⇒ 前瞻段返空或触发截断断言。单测不跨年 ⇒ **不会红**。复用 `marketDateFor([market], now)` 取年份。
4. 🚨 **静态年历在年末整段 `throw` 是设计不是 bug** —— `StaticCalendarAdapter` 的 Guardrail 7 是「区间未被覆盖范围**完全包含**即 throw，禁返已覆盖的那部分」。**MUST NOT** 为了让前瞻段「通过」把它改成返回部分：返部分 ⇒ 缺失日被当成非交易日 ⇒ 本 feature 要消灭的病在静态层原样重演（该文件注释已警告过这一点）。年末视野停住 → T011 的年末豁免接住，这条链是完整的。
5. 🚨 **腾讯 MUST NOT 进前瞻路由** —— 它是「指数当日有 bar ⟺ 当日开市」的反推源，结构上答不了未来。放进链首只会让 cn/hk 每天各多一条恒定的假失败 WARN，044 已论证过这种告警疲劳的代价。前瞻路由只有 `us → [富途]` / `cn,hk → [静态]` 两条。
6. 🚨 **`trading-day.rules.ts` MUST 保持零 IO / 零 class / 零 DI**（不接 `PrismaService`、不 import Prisma 类型）。带 IO 进去 ⇒ **ADR-0053 sunset_trigger #1 当场触发**、`marketdata-rules` 细分元素判据失效 —— 而那条元素是 `alert` 唯一的合法边。**boundaries lint 只看路径不看内容，这条它拦不住。**
7. 🚨 **optionsdesk 侧若撞到 `marketdata-rules` 的 lint 红，说明接法走偏了** —— 该走端口注入却写成了 import。修法是**回到端口**，**MUST NOT 动 allowlist**。061 Guardrail 2 原话：「改了会让 Gate 0.4 对 ADR-0053 的『未命中』判定当场失效」。
8. 🚨 **跨 ctx 注释挂对位置、挂对种类** —— optionsdesk 侧是**构造器注入参数上方**的 `// CROSS-CONTEXT-SYNC:`（挂 import 上方探针不采信）；alert 侧仍是**访问语句上方**的 `// CROSS-CONTEXT-READ:`（它没有 module 边，只能直查）。`scripts/checks/check-server-moat.ts` 两种都硬扫，缺了 lefthook + CI 双层拒。
9. 🚨 **改完 `schema.prisma` 必须 `pnpm --dir apps/server exec prisma generate`，改了又撤回也要** —— `apps/server/src/generated/prisma/` 是 gitignored 构建产物，`git checkout` 撤不掉它。症状是大批「无关」测试同时红且形态是**工作集为空**，看不出与 schema 有关。⚠️ **没有** `server:prisma-generate` 这个 nx target。
10. 🚨 **探针的年末豁免必须写在 SQL 里，不能写进 bash、更不能靠「12 月人工静默」** —— 044 既定纪律：仓内无 bash 测试框架 ⇒ bash 里的判断必然无覆盖（撞 Constitution §II）。判据下沉 SQL 后才能被 IT 用 Testcontainers 真测。**改判据改 SQL，别在别处内联复制那段 SQL。**
11. 🚨🚨 **年末豁免只在 12 月成立；1 月 1 日起探针转红是有意的，MUST NOT「修」它** —— 豁免的表达式是「`covered_to` 已抵**当年** 12-31」。跨年那一刻「当年」变成新年，于是 `covered_to`（旧年 12-31）`< current_date` ⇒ 落进第 ② 档、**必红**，直到次年年历的年更 PR 合入才自动转绿。**这正是设计**：年历没更就该响。**MUST NOT** 把豁免延到次年、也 MUST NOT 加「1 月宽限期」—— 那等于把唯一会响的信号关掉，而年更漏跑的后果是整年日历失真。
12. 🚨 **门禁脚本 MUST 双向反例** —— 只测「违规被拒」的门禁，在正则写错时会静默放行一切且 CI 全绿。必须同时测「合规文件放行」。**两条 Check 各自都要双向。**
13. 🚨 **Testcontainers spec 必经 `pnpm nx test server <file>`**（`vitest --root` 找不到 schema）；且真容器里 `MARKETDATA_PROVIDER` 缺省 = `mock` ⇒ 凡断言 live adapter 行为的 IT **必须 `.overrideProvider(marketdataConfig.KEY)` 成 live**，否则整组恒走 mock、**全绿且毫无意义**（061 T009 实测：不加 override 那 9 条全红/全空）。
14. 🚨 **「必红」的回归要真的先红** —— T007/T009 的回归若把日历埋成「含今天」，测试会绿但什么都没验到。必须埋成「`trading_day` 只到昨天 + `calendar_coverage` 只覆盖到昨天」才踩得到今天这个 bug。**先跑一次看到红，再写实现**（Constitution §II）。
15. 🚨 **验收的唯一硬证据是 `bull:alert-eval:completed` 里 job 的 `returnvalue`** —— 别拿「日志没报错」或「探针绿」当验收。今天的基线是 43/43 `{"status":"skipped-holiday"}`，验收要的是同一口径下出现 `evaluated`。

---

## Phase 1: 判据单点（阻塞其余）🎯

> 对应 plan D1 / D2 的纯函数半。两条都零 IO，可并行。

- [X] T001 [P] [Server] **三态判据纯函数**（`FR-010`, `FR-011`, `state_branches` 1–4, plan §D2）：新建 `apps/server/src/marketdata/trading-day.rules.ts`。导出 `type TradingDayStatus = 'trading' | 'non-trading' | 'unknown'` + `classifyTradingDay({ hasExactRow, coverage, date }): TradingDayStatus`，其中 `coverage` 为 `{ from: string; to: string } | null`。判据：有记录 → `trading`；无记录且 `from <= date <= to` → `non-trading`；无记录且落在区间外 **或** `coverage === null` → `unknown`。日期比较走 `YYYY-MM-DD` **字典序**（等价时序），非法格式 **throw**（照 `static-calendar.adapter.ts` 的 `assertIsoDate` 先例 —— 不 throw 的话 `'2026/03/01' >= '2026-01-01'` 之类会静默误判为区间内）。🚨 **Guardrail 6：零 IO / 零 class / 零 DI**。→ verify: colocate 单测覆盖 `state_branches` 1–4 四态 + 三条边界（`date` 恰等于 `from` / 恰等于 `to` / 恰在 `to` 后一天）+ 非法日期格式 throw；再加一条**反例断言**：`coverage === null` 时**任何**无记录日期都必须是 `unknown` 而**不是** `non-trading`（写成 `false` 就是把病换个地方犯）

- [X] T002 [P] [Server] **覆盖声明表 + 推进判据**（`FR-001`, `FR-002`, `FR-003`, `state_branches` 10–11, plan §D1）：① `schema.prisma` 新增 `CalendarCoverage`（`market` PK `@db.VarChar(8)` / `covered_from` `@db.Date` / `covered_to` `@db.Date` / `served_by` `@db.VarChar(16)?` / `updated_at`），`@@map("calendar_coverage")` `@@schema("marketdata")`，migration 命名 `<yyyymmddhhmm>_add_calendar_coverage`；② 新建 `apps/server/src/marketdata/calendar-coverage.rules.ts` 导出纯函数 `advanceCoverage(current, filled)`：`current === null` → 直接采用 `filled`；`filled.from <= current.to + 1 天` → 扩展为 `{ from: min, to: max }`；否则（有缺口）→ 返回一个**显式的「不推进 + 原因」结果**而不是静默返回 `current`。🚨 **Guardrail 9（`prisma generate`）**。🚫 **MUST NOT** 在任何地方用 `max(trading_day.date)` 派生覆盖终点（`FR-003`，T012 Check B 机器强制）。→ verify: colocate 单测覆盖 —— 首次（`current === null`）/ 相邻（`filled.from === current.to + 1`）/ 重叠 / **有缺口 → 不推进且给出原因** / 向前扩（`covered_to` 取 `max`）/ 向后扩（`covered_from` 取 `min`，反了不会红故必须单独断言）；`pnpm --dir apps/server exec prisma generate` 后 `pnpm nx test server` 全绿（既有测试不因加表而红）；migration 在空库单向可用

> 🔵 **Clear 检查点**（Constitution §III）：T001–T002 后停一次。

## Phase 2: 写入侧 —— 前瞻视野（支柱③；**落地即自动修掉三个活缺陷**）

- [X] T003 [Server] **填充源参数化 + 前瞻路由接线（纯重构，零行为变更）**（`FR-006`, `FR-008`, `state_branches` 12, plan §D4）：改 `trading-calendar-sync.service.ts` 抽 `syncRangeWith(source, markets, from, to)`，原 `syncRange` 委托它（seed CLI 与既有 IT 的调用面**一字不改**）；`marketdata.module.ts` 用 `MarketRoutedCalendarSource` 起**第二个实例**作前瞻路由（`us → [富途]` / `cn,hk → [静态]`）并以专属 token 注册 —— 本 task **只接线、`populate()` 暂不调用它**。🚨 **Guardrail 5**（腾讯不进前瞻路由）。→ verify: 既有 `marketdata.trading-calendar-sync.it.spec.ts` 与 `marketdata.calendar-044.*.it.spec.ts` **全绿且零改动**（零行为变更的硬证据）；新增 colocate 单测断言前瞻路由的三条：`cn`/`hk` → 静态源、`us` → 富途源、未登记市场 → **throw 且消息里列出已登记市场**（`state_branch` 12 的实现级保证）

- [X] T004 [Server] **`populate` 两段 + coverage 推进**（`FR-002`, `FR-004`, `FR-005`, `FR-007`, `FR-008`, `FR-015`, `SC-003`, `SC-009`, `state_branches` 10, 11, 12, 13, 16, plan §D4）：`populate(now)` 变两段 —— 历史段 `[今天-30, 今天]` 走既有 `TRADING_CALENDAR_SOURCE`，前瞻段 `[明天, 当年 12-31]` 走 T003 接好的前瞻源；每段整段成功后按 T002 的 `advanceCoverage` upsert `calendar_coverage`，`served_by` 记胜出层。🚨 **Guardrail 2**（catch 分支绝不碰 coverage）· **Guardrail 3**（年份按市场时区）· **Guardrail 4**（静态层年末 throw 是设计）。→ verify: 新建 `marketdata.calendar-062.horizon.it.spec.ts`（Testcontainers PG，stub 两个源）覆盖：整段成功 → `covered_to` 推到年末（`state_branch` 10）；**源抛错 → `covered_to` 一天不动**（`state_branch` 11 + Guardrail 2 的机器化）；源返回区间未被完全包含 → 不推进 + 留痕；未登记路由 → 显式失败且**其余市场照常**（`state_branch` 12）；历史段失败 / 前瞻段成功（及反向）→ 两段各自留痕、互不污染声明（`state_branch` 16）；静态源在跨年抛错 → 视野停在当年末、**不伪造次年日期**（`state_branch` 13）。再加一条**跨年断言**：时钟停在北京 1 月 1 日 08:00，断言 us 的前瞻窗 `to` 是 **ET 当年**的 12-31 而非宿主年份（Guardrail 3 的机器化）。跑 `pnpm nx test server <file>`

- [X] T005 [Server] **seed CLI 推进 coverage + 前瞻/历史交叉校验留痕**（`FR-009`, `state_branches` 17, plan §D4/§D8）：① `marketdata-trading-day-seed.cli.ts` 走 T004 的同一条推进路径（上线灌视野靠它，见 T013）；② 历史段填充时，对窗口内**已被前瞻段写过**的日期做一次差集比对，答案相反 → `WARN` + 计数留痕。⚠️ 「前瞻先写、历史后到」说的是**同一个日期**被两条路径先后写到（某日在成为「今天」之前先由前瞻段落库，日后再被历史段的活源覆盖到），**与 `populate()` 内两段的执行顺序无关** —— T004 定义的执行顺序是先历史后前瞻，别把这两件事搞混。🚫 **MUST NOT 自动订正** —— 谁对谁错要人判（交易所临时休市 vs 年历解析错，处置完全相反）。→ verify: 同一 IT 文件加两条：seed CLI 跑完后 `calendar_coverage` 覆盖到指定区间；埋一个「前瞻说是交易日、历史段活源没给」的冲突日 → 断言 `WARN` 留痕且**两边数据都没被改动**

> 🔵 **Clear 检查点**：T003–T005 后停一次。**此刻三个活缺陷应已在真库上消失** —— 建议顺手手工验一次再继续。

## Phase 3: 读侧换三态（**机械改签名，零行为变更**）

- [X] T006 [Server] **端口换三态 + adapter + exports + 全调用点机械映射**（`FR-010`, `FR-019`, `SC-002`, `state_branches` 1–4, plan §D2）：① `trading-calendar.port.ts`：`isTradingDay(market,date): Promise<boolean>` → `classify(market,date): Promise<TradingDayStatus>`，**删除**布尔方法；② `db-trading-calendar.adapter.ts` 内部由「exact + 近窗 count」改为「exact + 读 `calendar_coverage`」再喂 T001 纯函数，**旧的「近 30 日整窗零行 ⇒ fail-open」判据整体删除**；③ `mock-market-data.adapter.ts` 同步实现新签名；④ `marketdata.module.ts` 的 `exports` 增列 `TRADING_CALENDAR_PORT`；⑤ **全部既有调用点机械映射为 `!== 'non-trading'`**，本 task **零行为变更**（真正的分派留给 Phase 4）。🚨🚨 **Guardrail 1 —— 用 `=== 'trading'` 会静默把上线首刻翻成全体停摆**。→ verify: 新建 `marketdata.calendar-062.tri-state.it.spec.ts`（Testcontainers PG）走真 adapter 覆盖 `state_branches` 1–4：有记录 / 无记录且在覆盖内 / 无记录且覆盖外 / **`calendar_coverage` 空表**（→ 全 `unknown`，且经映射后各调用点行为与改动前**逐一相同**）；`pnpm nx test server` + `pnpm nx lint server` 全绿（编译器已把所有调用点逼出来）；`pnpm tsx scripts/checks/check-server-moat.ts` 绿

  > 📌 **impl 期记录（2026-08-18）—— 两个既有 IT 靠的是被删掉的那条近似判据**：`marketdata.hk-038.price-base.it.spec.ts` ④ 与 `optionsdesk-047.integrity.it.spec.ts` ⑦ 都直接 seed `trading_day` 行、再断言「表里没这一天 ⇒ 非交易日」，靠的正是旧的「近窗有别的行就算填过」。换三态后那两处给的是 `unknown`（还没填到），故各补了一行 `calendar_coverage` seed 把「已填过这一段」显式说出来。**生产代码零行为变更**：这两处改的是测试数据，不是判据。

## Phase 4: 消费方分派（US1–US3 + `state_branches` 5–9；**每条先红再绿**）

- [ ] T007 [Server] **alert 盘中闸接三态**（US1, `FR-012`, `FR-013`, `FR-015`, `FR-019`, `SC-001`, `state_branches` 5, plan §D5）：改 `alert/intraday-eval.processor.ts`：裸 `count` 之外**再读一次 `calendar_coverage`**（同样挂 `// CROSS-CONTEXT-READ:`），两个事实喂 T001 的 `classifyTradingDay`；`trading` → 求值；`non-trading` → `skipped-holiday`；`unknown` → **求值 + 留痕**，且 outcome 必须与「确认交易日才跑」**可区分**（`FR-013`）。🚨 **Guardrail 8**（注释挂访问语句上方）· **Guardrail 14**（先看到红）。🚫 alert **MUST NOT** import `marketdata` 本体，只能 import `marketdata/*.rules.ts`。→ verify: 新建 `alert-intraday-calendar-062.it.spec.ts`（Testcontainers PG + Redis，真 DI 容器 `Test.createTestingModule({ imports: [AlertModule] })`）：**① 埋「`trading_day` 只到昨天 + coverage 只覆盖到昨天」+ 时钟停在连续竞价时段 → 断言求值真的发生**（这条在写实现前必须先红 —— 它就是今天生产上 43/43 跳过的那条）；② 埋「今天在库 + coverage 含今天」→ 求值且 outcome 标为「已确认」；③ 埋「今天不在库但 coverage 含今天」→ `skipped-holiday` 且零外呼；④ 时钟停在午休 → 按时段跳过（与日历无关）。`pnpm tsx scripts/checks/check-server-moat.ts` 绿

- [ ] T008 [Server] **optionsdesk 盘中闸改注入端口**（`FR-012`, `FR-013`, `FR-014`, `FR-015`, `FR-019`, `state_branches` 5, plan §D5）：改 `optionsdesk/sync-anchor-intraday.ts`：**删掉裸 `prisma.tradingDay.count`**，改为注入 `TRADING_CALENDAR_PORT`（构造器参数上方挂 `// CROSS-CONTEXT-SYNC:`，体例照抄同文件已有的 `REALTIME_QUOTE_PORT` / `MARKET_STATE_PORT` 两条）；`unknown` → 继续采（另有 vendor 市场状态闸取交集），并在 `MarketIntradayOutcome` 上留可断言的痕。🚨 **Guardrail 7**（撞 `marketdata-rules` 红 = 接法走偏，回端口不动 allowlist）· **Guardrail 8**。🚫 **两闸取交集的结构一行不动**（`FR-014`：交易日闸 MUST NOT 被市场状态顶替）。→ verify: 新建 `optionsdesk-062.calendar.it.spec.ts`（真容器 `imports: [OptionsdeskModule]`，🚨 **Guardrail 13** 的 `MARKETDATA_PROVIDER` override）：`trading` + 常规时段 → 采集；`non-trading` + 常规时段 → `skipped-holiday`（既有语义不回归）；`unknown` + 常规时段 → **采集且留痕**；`unknown` + 非常规时段 → 仍不采（交集语义未被削弱）。`pnpm nx lint server` 绿（**不应**出现任何 boundaries 报错；出现即 Guardrail 7）

- [ ] T009 [Server] **marketdata 三处消费方分派**（US2, US3, `FR-012`, `FR-013`, `SC-004`, `SC-005`, `state_branches` 6, 7, 8, plan §D5）：改三个文件：① `option-snapshot-remediation.ts` ② 级 —— `unknown` → **继续执行**（起手覆盖率复判决定是否真外呼），且 `idle()` 那条**静默返回**必须补上可诊断的留痕（今天它零日志，这正是二级兜底死了几个月没人发现的原因）；② `anchor-cold-start.usecase.ts` —— `todayIsTradingDay` 由布尔换三态，`unknown` → **abandon 落既有 `COLD_START_OUTCOME.CALENDAR_MISSING`**（写敏感档不猜口径）；③ `freshness-sla.check.ts` —— `unknown` → 当开市（保守多算龄）。🚨 **Guardrail 14**（先看到红）。→ verify: 在 `marketdata.calendar-062.tri-state.it.spec.ts` 内补三组，覆盖 `state_branches` 6–8：**① 埋「视野充足」+ 时钟停在 ET 03:00 + 上一交易日有缺口 → 断言二级兜底真的执行了复判**（今天它恒 `not_needed`，此条写实现前必须先红，`SC-004`）；**② 同样时钟 + 视野充足 → 断言 D4 给 `premarket_backfill` 且 `oi_as_of` = 目标场**（今天给的是 `eod` + 早一天，此条同样先红）；③ 时钟停在 ET 16:30 → `eod` + `oi_as_of` = 目标场的上一交易日 —— ②③ 两个时刻的口径与常规轮/盘前兜底**逐一一致**（`SC-005`）；④ `unknown` → 冷启动落 `CALENDAR_MISSING` 且**零写库**；⑤ 折龄遇 `unknown` → 按开市折算

- [ ] T010 [Server] **陈旧度基准收编端口**（`FR-012`, `FR-019`, `state_branches` 9, plan §D5）：① `trading-calendar.port.ts` 增 `lastClosedSession(market, now): Promise<string | null>`，实现落 `db-trading-calendar.adapter.ts`（基准日落在覆盖区间外 → 返 `null`）+ mock adapter；② 改 `optionsdesk/last-closed-session.ts` 由 `PrismaService` 直查改为走该端口，4 个消费 use case（`get-underlying-detail` / `list-anchors` / `update-anchor` / `review-anchor`）注入并挂 `// CROSS-CONTEXT-SYNC:`；③ `marketdata/get-instrument-bars.usecase.ts` 里那份**同款重复实现**一并收编到端口的同一实现。返 `null` → 既有 `freshnessTier` fail-open 判当期档。🚨 **该文件头那条「不合并：合并等于让 optionsdesk 无痕读表、护城河探针看不见这条边」写于 046，其前提在 061 之后已变** —— 改走端口后这条边以 `CROSS-CONTEXT-SYNC` 注入点存在、`check-server-moat` Check 2 照样扫得到。**必须同步改写那段注释并写明理由**，否则下一个人会以为规矩被违反了。→ verify: `optionsdesk-062.calendar.it.spec.ts` 补两条：基准日在覆盖内 → 返该日、档位判定与改前逐一相同（零回归）；基准日在覆盖外 → 返 `null` → 当期档；`pnpm tsx scripts/checks/check-server-moat.ts` 绿；`git grep -n 'prisma.tradingDay' apps/server/src/optionsdesk/` **零命中**（T012 Check A 的前置条件）

> 🔵 **Clear 检查点**：T007–T008 一批、T009–T010 一批。

## Phase 5: 可观测与防复发（US4 / US5）

- [ ] T011 [Ops] **视野探针**（US4, `FR-016`, `FR-017`, `SC-003`, `SC-006`, `SC-008`, `state_branches` 13, 14, 15, plan §D6）：改 `ops/jobs/marketdata-calendar-health.sql` 增三档判据（① 覆盖声明整体缺失 → 🔴；② `covered_to < current_date` → 🔴；③ `covered_to` 之后的交易日数 < **5** 且 `covered_to` 未抵当年 `12-31` → 🔴），摘要行给出每市场的 `covered_to` 与余量；`marketdata-calendar-health.sh` **零 if、零阈值**，只跑谓词 + 打摘要 + 透传退出码。🚨 **Guardrail 10**（判据必须在 SQL 里，年末豁免也是）· 🚨🚨 **Guardrail 11**（1 月 1 日起转红是有意的，判据注释里必须写死「MUST NOT 延到次年 / MUST NOT 加 1 月宽限期」）。⚠️ `current_date` 是 DB（UTC）口径，与各市场「今天」最多差一天；阈值取 5 个交易日故 1 天偏差不会假红 —— **这个容差是刻意的**，别把市场时区搬进 SQL（那会成为第三份时区表）。与既有心跳判据**并存**（`FR-017`：心跳答「填充还活着吗」，视野答「视野还在往前走吗」）。→ verify: 新建 `marketdata.calendar-062.horizon-probe.it.spec.ts`（Testcontainers PG，照 `marketdata.calendar-044.health.it.spec.ts` 的埋数据范式）：终点距今 2 个交易日且未到年末 → `exit 1`（`state_branch` 14）；终点距今 8 个交易日 → 绿；**终点 = 当年 12-31、时钟在 12 月 → 绿**（`state_branch` 15 + `SC-008`）；**终点 = 上一年 12-31、时钟在 1 月 2 日 → 红**（Guardrail 11 的机器化 —— 有人把豁免延到次年时这条立刻红）；声明缺失 → `exit 1` 且文案与「视野过近」可区分；既有心跳判据的四条断言**不回归**

- [ ] T012 [Server] **防复发门禁（两条 Check）**（US5, `FR-003`, `FR-018`, `SC-007`, plan §D7）：新建 `scripts/checks/check-trading-day-read.ts`，两条正交判据：**Check A（跨 ctx 用对判据）** —— `apps/server/src/` 下 `marketdata/` **之外**命中 `prisma.tradingDay.` 的文件**必须** import `marketdata/trading-day.rules.ts`，否则拒，报错文案给出两条合法路径（注入 `TRADING_CALENDAR_PORT` / import 共享判据）；**Check B（`FR-003` 禁派生视野）** —— **写 `calendarCoverage` 的文件内 MUST NOT 出现 `tradingDay` 的「取最大日期」形状**（`aggregate` / `_max` / `orderBy: { date: 'desc' }`）。Check B 补的是 Check A 的射程盲区：`max(date)` 派生的风险在 **marketdata 内部**，Check A 恰好扫不到那儿，而 `FR-003` 是本 feature 最核心的 MUST NOT（2026-08-18 analyze 发现它此前零机器强制）。接 `lefthook.yml`（照 `server-moat-check` 位置）+ `.github/workflows/pr-validation.yml`（照 `check-server-moat` 那个 step 的 full-scan 形态，`--no-verify` 绕不过云端）。🚨 **Guardrail 12（两条 Check 各自双向反例）**。→ verify: Check A 双向 —— 合规样例（alert 现状：直查 + import 判据）放行 / 违规样例（直查但不 import）被拒且退出码非零；Check B 双向 —— 合规样例（写 coverage 但不取最大日期）放行 / 违规样例（同文件内 `tradingDay.aggregate({ _max: { date: true } })` 后写 coverage）被拒；全仓实跑**零命中**（T010 完成后 optionsdesk 侧应已无裸查，**若此刻还要给谁开白名单，说明 D5 某一行没落实**）

## Phase 6: 上线与生产实证

- [ ] T013 [Ops] **上线灌视野 + 生产验收取证**（`SC-001`, `SC-002`, `SC-004`, plan §D9）：按 plan §D9 的**不可颠倒**顺序：① migration 上线（空表 = 全 `unknown`，各消费方按 unknown 分派照常工作，**不停摆**）→ ② 部署带前瞻填充的版本 → ③ **立即手动跑一次 seed CLI** 灌历史 + 前瞻视野（否则空等到当晚 21:00）→ ④ 次一交易日取证。→ verify: **四项实测，逐条对照 plan Gate 0.1 的基线**：① `select market, covered_from, covered_to, served_by from marketdata.calendar_coverage` —— 三市场 `covered_to` 均抵当年 12-31；② `select market, max(date) from marketdata.trading_day group by market` —— 三市场均 ≥ 今天；③ **次一交易日北京 09:30 之后**查 `bull:alert-eval:completed` 的 `returnvalue`，**必须出现 `evaluated`**（基线是 43/43 `skipped-holiday`，🚨 Guardrail 15：这是唯一硬证据，别拿日志没报错顶替）；④ 视野探针手动跑一次 → 绿。四项全过才算本 feature 落地

## Dependencies

```text
T001 ┐
T002 ┼→ T003 → T004 → T005 ┐
     │                      ├→ T006 → T007 ┐
     │                      │              ├→ T008 → T010 → T012
     │                      │              └→ T009
     └──────────────────────────────────────────→ T011（只依赖 T002 的表）
T007 · T008 · T009 · T010 · T011 · T012 → T013
```

- **T004 必须早于 T006**：读侧换三态时 `calendar_coverage` 必须已被填充逻辑维护，否则 T006 的「零行为变更」断言无从成立（空 coverage ⇒ 全 `unknown`）。
- **T003 是纯重构**（`populate` 不调用新路由），单独 commit 后树必须绿。
- **T011 可与 Phase 3–4 并行**（只依赖 T002 的表结构）。
- **T012 必须晚于 T010**（否则 Check A 全仓实跑会命中 optionsdesk 的裸查）。

## 判据覆盖矩阵（`state_branches` 17 条 → task）

| #   | 分支                                  | task                           |
| --- | ------------------------------------- | ------------------------------ |
| 1   | 有记录 → 交易日                       | T001 · T006                    |
| 2   | 无记录 + 覆盖区间内 → 非交易日        | T001 · T006                    |
| 3   | 无记录 + 覆盖区间外 → 未知            | T001 · T006                    |
| 4   | 无覆盖声明 → 未知                     | **T001（反例断言）** · T006    |
| 5   | 未知 + 盘中采集闸 → 跑 + 留痕         | T007 · T008                    |
| 6   | 未知 + 补救 ② 级 → 跑                 | T009                           |
| 7   | 未知 + 建锚补数写入决策 → abandon     | T009                           |
| 8   | 未知 + 折龄 → 按开市                  | T009                           |
| 9   | 陈旧度基准超出覆盖 → 回退当期档       | **T010（唯一载体）**           |
| 10  | 前瞻整段成功 → 推进声明               | T002 · T004                    |
| 11  | 部分成功 / 未完全覆盖 → 不推进 + 留痕 | **T002 · T004（Guardrail 2）** |
| 12  | 前瞻源未登记路由 → 显式失败留痕       | T003 · T004                    |
| 13  | 次年年历未发布 → 停当年末、不伪造     | T004 · T011                    |
| 14  | 终点距今不足阈值且未到年末 → 告警     | T011                           |
| 15  | 终点已抵当年末 → 不告警               | **T011（`SC-008` 的机器化）**  |
| 16  | 一段失败 MUST NOT 让另一段声明失真    | T004                           |
| 17  | 前瞻与历史活源答案相反 → 留可查痕迹   | **T005（唯一载体）**           |

**17/17 全覆盖，零遗漏。**

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **5 层**判据（条数为实时 `grep`，非抄 checklist）：`state_branches`(17) · FR(19) · SC(9) · Acceptance Scenario(19) · Edge Case(8)。**五层全扫，无差集。**

### FR 覆盖（19 条，逐条枚举无范围记法）

| FR     | task               | FR     | task                      |
| ------ | ------------------ | ------ | ------------------------- |
| FR-001 | T002               | FR-011 | T001                      |
| FR-002 | T002 · T004        | FR-012 | T007 · T008 · T009 · T010 |
| FR-003 | T002 · **T012(B)** | FR-013 | T007 · T008 · T009        |
| FR-004 | T004               | FR-014 | T008                      |
| FR-005 | T004               | FR-015 | T004 · T007 · T008        |
| FR-006 | T003 · T004        | FR-016 | T011                      |
| FR-007 | T004               | FR-017 | T011                      |
| FR-008 | T003 · T004        | FR-018 | T012                      |
| FR-009 | T005               | FR-019 | T006 · T007 · T008 · T010 |
| FR-010 | T001 · T006        |        |                           |

### SC 覆盖（9 条）

| SC     | 判据落点                                                          |
| ------ | ----------------------------------------------------------------- |
| SC-001 | T007（IT）+ **T013（生产实测，唯一终验）**                        |
| SC-002 | T006（IT）+ T013（实测 `covered_to`）                             |
| SC-003 | T004（推到年末）+ T011（阈值判据）                                |
| SC-004 | T009 ①（IT）+ T013                                                |
| SC-005 | T009 ②③（美东凌晨 / 收盘后两个时刻的口径一致断言）                |
| SC-006 | T011（探针 timer 周期 4h，既有；本片只加判据不改周期）            |
| SC-007 | T012（两条 Check 各自双向反例）                                   |
| SC-008 | T011（年末场景断言）                                              |
| SC-009 | T004（前瞻段每市场每日 1 次调用；零新增 vendor 见 plan Gate 0.2） |

### Acceptance Scenario 覆盖（19 条）

US1 AS1–4 → T007（AS2 = 那条必红回归）｜US2 AS1–4 → T009 ①｜US3 AS1–4 → T009 ②③④｜US4 AS1–4 → T011｜US5 AS1–3 → T012。

### Edge Case 覆盖（8 条）

年末跨年 → T004 · T011（含 Guardrail 11 的 1 月转红断言）｜前瞻源返回残缺 → T004（Guardrail 4）｜声明区间内有空洞 → T002（推进规则**不产生**空洞；已存在的空洞登记为人工介入态，见下）｜首次上线全 unknown → T006 · T013｜未登记路由 fail-closed → T003 · T004｜交易所临时休市 → **故意零覆盖**｜半日市 → **故意零覆盖**｜时区 → T004（Guardrail 3）· T007 · T008。

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

以下五项**故意不做**，不是遗漏，下次 analyze 不要当缺口补 task：

1. **us 的离线年历第三层兜底** —— 沿用 2026-07-31 拍板（新增 NYSE 假日采集 = 新 drift 面；离线表反映不了临时休市与半日市；us 两活源走不同物理通路）。代价由 T011 的视野探针接住，失败响亮。**别顺手往 `SUPPORTED_MARKETS` 加个 `us` 字符串。**
2. **半日市 `trade_date_type` 落库** —— 半日市即交易日，不影响本 feature 的任何判定；落库语义要等 cn/hk 两个源都能给出该值才有意义（否则列语义随 `served_by` 漂移）。
3. **交易所临时休市（国丧等）的事后订正** —— 年历发布后才出现的变更。本片只保证前瞻记录**不阻止**历史段活源事后修正该日，自动订正明确不做（T005 的交叉校验只留痕、不改数）。
4. **已存在空洞的自动修复与探测** —— T002 的推进规则保证**今后不再产生**空洞；历史遗留空洞登记为需人工介入的破坏态。自动补 = 又一次「猜」，正是本 feature 要消灭的形状；探测手段（如「覆盖区间内每月至少 N 个交易日」的弱断言）本次不做，若将来空洞真的发生一次再补。
5. **mobile / web 面** —— `web_compat: na`，零 HTTP 端点变更，不触发 openapi / api-client 重生成。

## 单 PR 与上线顺序

全部 13 个 task 走**单分支单 PR**（Constitution §V）。本片**无第二条部署链**（不涉及 futu-shim），合入即随 mono app 部署链上线。

🚨 **上线顺序不可颠倒**（plan §D9）：migration → 部署 → **立即灌视野** → 次一交易日取证。先上三态/门禁、后上填充的话，线上会白背一天全 `unknown` —— 能工作，但每个闸都在「不知道」的状态下跑，且探针立刻红。

🚨 **T013 的终验必须挑一个真交易日的盘中时段**（北京 09:30–15:00 之间查 alert 那条），非交易日跑出来的 `skipped-holiday` 是**正确**结果，拿它当失败会误判。
