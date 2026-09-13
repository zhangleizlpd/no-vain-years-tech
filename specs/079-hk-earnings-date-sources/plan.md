---
feature_id: 079-hk-earnings-date-sources
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-13'
updated_at: '2026-09-13'
adr_refs: ['0035', '0043', '0047', '0058', '0062', '0066', '0067']
context7_verified: []
---

# Implementation Plan: 港股财报日期多源采集与确认层（片 1/2：数据层）

## Summary _(mandatory)_

在 `marketdata` 内新建一层「财报日期」：三个可插拔来源各自产出**带口径的观测** —— 富途财报日历（结构化日期）、交易所公告（业绩刊发事实 + 按标题识别的会前通知信号，复用现役 `announcement` 维度已采数据）、港交所「董事會會議通知」清单（主板会议日，每日一次 GET）—— 纯函数合并成「一个公布日 + 取值口径 + 状态」的事件。港股由新维度 `hk_earnings_date` 每日跑，美股由现役 `earnings_event` 采集**顺带**落观测（零新增调用）。**不获取、不解析公告 PDF**（spec Session（五）采纳方案 B）。清单解析失败必须响亮失败，不写入任何清单观测。全部新表只归 `marketdata`，期权台读端一行不动。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| （不引入）HTML 解析库 | 清单是固定结构的小表：页首日期 + 一张 5 列表 | 仓内零 HTML 解析依赖（`apps/server/package.json` 无 cheerio / htmlparser2 / parse5 / node-html-parser / linkedom / jsdom）；页面结构取证见 D7。纯函数正则 + 结构不变量（D7）足够，改版由 FR-025 失败告警兜住。 |
| （不引入）`pdfjs-dist` 与 worker 线程 / 文档队列 | —— | 方案 A 已取消（spec Session（五）；备选否决 8）。 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 纯 server、单分支单 PR（§V；无 OpenAPI / mobile 变更）；TDD 红绿闭环 + 定向变异证能红（§II）；扁平 / 贫血 / 护城河零违背（§IV：新表全部归 `marketdata` 并登记 `MODEL_OWNERSHIP`，判据在 `*.rules.ts`；`optionsdesk` 零改动）；mockup-first 免（§I：无 UI）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 无新 endpoint。Testcontainers 真 DI IT：`marketdata-079.earnings-dates.it.spec.ts`（维度运行、三来源、合并、逾期、清单失败 / 陈旧 / 消失、零回归、打标隔离）+ `marketdata-079.schema.it.spec.ts`（migrate 产物）。清单解析用入仓 HTML fixture 的 Small spec 覆盖全部写法。真 vendor 由 `RUN_MARKETDATA_IT` 门控用例手动跑并贴输出（富途港股日历、港交所清单页）。
- [x] **Mobile / Web**: N/A —— 零 UI、零契约变更（FR-022）。
- [x] **Evidence**: specify 期 prod 只读取证与 plan 期调研 / PoC（清单快照、回放 172 / 176、写法归纳）见 spec「取证」段；原始数据在本机 `docs/private/evidence/079-hk-earnings-date-sources/`（gitignored）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card（港交所「董事會會議通知」清单页）

| #   | Question | Answer |
| --- | --- | --- |
| Q1 | 长期维护信号 | 港交所官方页面；Wayback 最早存档 2024-02-03，至 2026-09 仍在用、结构未变（8 份可解析快照与当日页面同构）。无接口承诺（「僅供參考」）。 |
| Q2 | 已装工具能否等价覆盖 | 否。富途港股日历只给已公告日期、有缺漏、无会议日（spec 取证）；理杏仁公告只有标题与链接，日期在 PDF 正文里。清单是唯一免费、结构化给出主板会议日的来源。 |
| Q3 | 与现栈兼容 | 静态 UTF-8 HTML（`<meta charset=utf-8>`），`VendorHttpClient.requestText` 已支持文本读取（`vendor-http-client.ts:106-123`，`text` 为可选字段），零客户端改动；prod 应用主机 HTTP 200、约 1.5 秒。 |
| Q4 | LLM 覆盖度 | 无库；解析规则全部由取证归纳（D7），以入仓 fixture 固化。 |
| Q5 | 解耦成本 | 一个 source 文件 + 一个 rules 文件 + 一个约束档；停用改 `EARNINGS_DATE_SOURCES` 配置即可（FR-001）。 |
| Q6 | 风险面 | 改版 / 停更 / 漏收 —— FR-025 失败与陈旧告警 + FR-017 已通知日期未知告警 + 富途与刊发事实兜底。页面使用条款未核实（推断公开页可读），每日 1 次请求。URL 为代码常量、不来自数据 ⇒ 无 SSRF 面。 |

**Evidence**: 调研报告要点与 PoC 数字见 spec 取证段；快照与对账脚本归档在本机 evidence 目录 `hkex-board-meeting-list/`。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] mono-native，无迁移面。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / 约束 | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0047 | §6 口径敏感维度「fail-or-flag，不静默切异口径备源」（`:136`）；「整链耗尽 fail loudly」（`:140`）；新增 / 改动 vendor adapter MUST 答 ADR-0067 D5 三问（`:56`） | accepted-as-is | 不用 FallbackChain；多源并存 + 口径标注即 fail-or-flag。清单结构异常 fail loudly、零写入（FR-025）。富途财报日历（改）、港交所清单（新）各写「缺失语义」三问（D5 / D7）。 |
| ADR-0058 | `integrations/` 只收 ≥ 2 个 ctx 复用的 vendor adapter（`:33-34`） | accepted-as-is | 清单只有 `marketdata` 消费 ⇒ 留在 `marketdata/`。 |
| ADR-0066 | 业务日期跟交易所走；交易日必须查日历 | accepted-as-is | 清单日期是香港当地日期，`日/月/年` 顺序解析（D7）；「满 2 个交易日」「页面陈旧 2 个交易日」查 `trading_day` 三态（D8 / D7）；业务日单市场取（D9）。 |
| ADR-0067 | D5：新 vendor adapter 必答缺失语义三问 | accepted-as-is | D5 / D7 各答一次。 |
| ADR-0035 | migration 命名 / `migration_refs` frontmatter | accepted-as-is | 两条 expand-only migration（D3：四张表；D9：维度 seed + 依赖边）；impl 期写进 spec `migration_refs`。 |
| ADR-0062 | optionsdesk ↔ marketdata 边界 | accepted-as-is | 零新增跨 ctx 读；新表不给 optionsdesk 读口（FR-022）。 |
| ADR-0068 | 5 条 sunset（含「财报复测」） | accepted-as-is | 不触发：本片不改打标、召回、窗。 |

其余 ADR 的 Open Question 段与本片无交集（`rg -l "Open Question" docs/adr/` 逐份扫过）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 本片零新 `Guard` / `Interceptor` / `Filter` / `Pipe`，禁令全文有效。
- **MANDATORY INTEGRATION**: 维度执行、三来源观测落库、事件合并、逾期判定、清单失败零写入、清单陈旧与提前消失告警、美股零回归、港股打标隔离 MUST 在 Testcontainers 真 DI（`Test.createTestingModule` 真 boot，PG 真容器）下验证。MUST NOT 只靠 mock 证「没写入 / 告警了」。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 每条在 D12 有对应 `it()`，蓄意零覆盖的写明理由。
- **PROVE-IT-CAN-FAIL**: 每条新断言用定向变异证明会红（清单去掉结构不变量 / 日期按「月/日」解析 / 两位年份按 19YY / 纯股息行不排除 / 让美股来源声明成「仅已公告」/ 让逾期不查日历 / 让「已通知日期未知」不查「曾在清单」/ 補充排除放宽），rebase 后重做。
- **观察面**：「零写入」「不告警」这类否定断言，MUST 同时断言同一轮里的正向计数（如失败 finding 存在、其余来源观测条数 > 0），否则「整个维度没跑」也会绿（`docs/conventions/testing.md` §7.1）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。全部文件平铺在 `apps/server/src/marketdata/`；判据全在 `*.rules.ts`；use case 直注 `PrismaService` 读写自己的表。

**D1 · 归属与边界**

- 全部落 `marketdata`（catalog Q1）。无新 bounded context、无 `integrations/`（ADR-0058）。
- `optionsdesk` **零改动**：它读财报日期只读 `earnings_event`（`get-legs.usecase.ts:733-739`，按标的过滤、不分市场）。本片**不往 `earnings_event` 写任何港股行**，也不给新表加任何 `CROSS-CONTEXT-READ` —— FR-022 的结构保证。
- 新表 4 张登记 `scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP`（marketdata 段 `:80-134`）。

**D2 · 来源抽象（port + 可插拔 adapter；FR-001 / FR-002 / FR-018）**

- 新 port `earnings-date-source.port.ts`，token `EARNINGS_DATE_SOURCES` 注入**来源数组**。每个来源提供：`name`（落库用稳定名：`futu_calendar` / `hkex_announcement` / `hkex_board_meeting_list`）；`capabilities(market)`（前向日期语义 `announced_only` / `unconfirmed` / 无、是否提供确认信号、是否提供刊发事实；不支持该市场返回 null）；`collect({ market, businessDate, now, mode })`（`daily | backfill`，返回已归一观测与会前通知信号；失败直接抛，由合并用例按来源隔离，FR-018）。
- 合并用例只认 port 契约，**不出现任何来源名分支**（FR-001）。IT 注入只提供刊发事实的假来源、再移除真来源，合并规则零改动（SC-010）。
- 注册：`marketdata.module.ts` 工厂按配置 `EARNINGS_DATE_SOURCES` 组装数组；`kind=mock` 时每个来源经既有 `collectionPort()`（`marketdata.module.ts:218-238`）得到拒绝壳。
- 美股富途观测**不走 `collect`**（D9 钩子），但映射函数与港股共用 `toSourceObservations(events, market)`（取值单点）。

**D3 · 数据模型（expand-only）**

新表设计意图（字段形状以 `schema.prisma` 为准）：

1. **`earnings_date_observation`**（来源观测，PIT）：唯一键 `(source, instrument_id, period_key)`。市场、报告类型、统一期末日（可空）、来源原文报告期、公布日（可空）、取值口径（`filed` / `explicit` / `structured` / `meeting`）、会议日、公布时刻、刊发日、凭据指针（公告链接 / 清单页首日期）、首次 / 最近观测时刻、上一个日期与变更时刻、刊发后回填的偏差天数（FR-019）。清单观测的「最近观测时刻」即最近一次出现在清单的运行时刻（FR-020a）。
2. **`earnings_date_event`**（合并后事件）：唯一键 `(instrument_id, period_key)`。状态（`confirmed` / `unconfirmed` / `conflict` / `notified_undated` / `overdue` / `published`）、公布日及口径、冲突候选日期、公布时刻、确认日期及口径（`announced` / `first_seen`）、参与来源、报告类型与期末日、逾期起算时刻、`revision` 整数（乐观并发，D8）。
3. **`earnings_date_event_log`**（事件流水，append-only）：状态迁移、取值变更、冲突产生 / 解除、逾期产生 / 解除、清单行提前消失（FR-013 / FR-014 / FR-016 / FR-019a）。
4. **`earnings_meeting_lag`**（会议 → 刊发间隔）：唯一键 `(instrument_id, report_kind)`；最近一次间隔天数、来源期末日、观测时刻（FR-010）。

- **会前通知信号不单独建表**：由来源 B 每轮从 `marketdata.announcement` 按标题现算（本 ctx 表、有 `(instrument_id, date)` 索引 `schema.prisma:915`），合并时按标的与日期窗口匹配（D8）。
- **`period_key` 三种形态，列非空**（`.claude/rules/migration-rules.md:96-98`）：`P:<期末日>`（可跨来源对齐）/ `T:<来源>:<原文报告期>`（来源内稳定）/ `D:<来源>:<日期>`（兜底）。只有 `P:` 参与跨来源合并（FR-015）。
- 🚫 **MUST NOT 复用 `earnings_event`**（D1 / FR-021）。
- **两条 migration**（commit 原子）：① 四张表 `<yyyymmdd_hhmm>_create_earnings_date_layer`；② `hk_earnings_date` 维度 seed + 依赖边 `<yyyymmdd_hhmm>_seed_hk_earnings_date_dimension`，与 D9 全部注册触点**同 commit** —— 先落 seed 会让写死维度清单的 IT 在中间 commit 变红、tick 触发无执行器的维度。命名规则 `lefthook.yml:133-160`。

**D4 · 报告期统一 `earnings-period.rules.ts`（纯函数）**

- 清单侧（D7 行 → 期末日与类型）：「截至DD/MM/YY止N個月」⇒ 期末日 = 该日，N = 3 / 9 ⇒ 季度、6 ⇒ 中期、12 ⇒ 年度，其他 N（如 15 / 18，停牌补批）⇒ 年度并计数；「年度DD/MM/YY」⇒ 年度；「截至DD/MM/YY止季度」⇒ 季度；「截至DD/MM/YY期間」「由DD/MM/YY至DD/MM/YY」⇒ 期末日 = 截止日、类型由目的列定；「YYYY年第N季」⇒ 无期末日（公司财年未知）⇒ `T:` 键并计数；期间空白 ⇒ `T:` 键并计数。目的列无季度 / 中期 / 末期字样（如「業績」）时类型由期间换算。🚨 两位年份 = `20YY`；`日/月/年` 顺序。
- 交易所公告侧：从业绩公告标题取期末日与类型 ——「截至YYYY年M月D日止（三個月 / 六個月 / 九個月 / 年度）」「YYYY年M月底止季度」，阿拉伯与中文数字；取到即 `P:`。
- 富途侧：原文 `period_text` 按**公司财年**记（阿里 `2027Q1` = 截至 2026-06-30，spec 取证）。财年结束月按序取：① 该公司交易所年度业绩公告标题期末日；② 历史配对（同公司富途观测与交易所刊发事实公布日相差 ≤ 1 天时反推）；③ 都没有 ⇒ `T:` 键，独立事件并计数（FR-015）。🚫 MUST NOT 默认 12 月结年。
- 美股：无第二来源，一律 `T:` 键。

**D5 · 来源 A：富途财报日历 `futu-calendar.source.ts`（FR-003）**

- 既有 adapter `futu-earnings-calendar.adapter.ts` 前缀表加 `hk ↔ HK`（`:56-63`）；锁定「hk 抛错」的 spec 用例（`futu-earnings-calendar.adapter.spec.ts:213-215`）翻转，commit message 写理由（`earnings_event` scope 仍只有 us，放开 adapter 不改现役行为）。
- `EarningsCalendarEvent`（`earnings-calendar.port.ts:86-115`）增加可空 `publicationTime`，映射原始行 `earnings_timestamp`（现被丢弃，`:127-136`）。美股 `earnings_event` 写入列不变。
- 港股窗口：日常 `[业务日 − 7, 业务日 + EARNINGS_FORWARD_HORIZON_DAYS]`；回填往前 730 天。经既有 `EARNINGS_CALENDAR_PORT`（专用 client、shim 限频档）。
- 能力：港股 = 前向「仅已公告」+ 历史口径 `structured`（`hk:00857` 三次记的是会议日，所以不是 `filed`）；美股 = 前向 `unconfirmed`。
- **缺失语义三问**：① 无下一次财报 = 不下发行，EPS 类 `N/A` 哨兵（既有 `numToString`）；② 「无行」分不清「没有财报 / 尚未公告」—— 登记不可判定，由能力声明承载；③ 数据反推（港股前向 364 天仅 54 行）⇒ 运行时不变量 = 每轮 notice 输出港股前向行数。

**D6 · 来源 B：交易所公告 `hkex-announcement.source.ts`（零 PDF；FR-004 / FR-005）**

- 读 `marketdata.announcement`（本 ctx 表，零新增理杏仁调用，FR-004）。日常窗口 `[业务日 − 7, 业务日]`，与现役 7 天回看一致（`20260801_2248_add_sync_dimension_delta_lookback/migration.sql:30-31`）；回填 730 天。
- **业绩刊发事实**（`types` 含 `fs_main`）→ `filed` 观测，**全部港股**：公布日 = 公告日期（`+08:00` 当地日期，`lixinger-announcement.adapter.ts:19-21`），报告期取自标题（D4）。
  - 🚨 「補充 / 更正」排除 MUST 窄：只排除不含「業績公告 / 業績公佈」本体的公告（`hk:09992` 2026-08-20 真实刊发标题带「補充公告」，spec 取证）。
  - A+H 公司的季度报告另以 `all` 类型的「海外監管公告」刊发，锚表港股两年 22 份**同日均有** `fs_main` 行 ⇒ 只认 `fs_main` 不漏；🚫 不要放宽到按标题认 `all` 类（会把「…業績公告日期」「盈利公布及審議會否派發股息」这类**通知**认成刊发，PoC 实撞）。
- **会前通知信号**（FR-005，单一维护点 `earnings-notice.rules.ts`）：标题匹配强通知写法（spec 取证列出的全部写法：董事會會議召開日期 / 通告 / 通知 / 日期、董事會召開日期、召開董事會的日期、業績公告日期、盈利公布及審議、審議會否派發、委員會會議日期、董事會委任的委員會會議）且 `types` 不含 `fs_main` ⇒ 信号 `{ instrument, noticeDate, title, link }`；「決議」「名單」「委任」「職權範圍」「工作細則」等排除。锚表港股两年回放：181 份正文判定为会前通知的公告**全部**属于上述强写法（spec 取证，方案 A PoC），标题规则在存量上不漏。
- **缺失语义三问**：① 公告不存在 = 不下发行；② 「无通知」分不清「未发 / 漏采 / 公司不为该类报告发通知（`hk:00941` 一、三季度）」—— 无通知不产生任何告警，事件照常由其余来源决定；③ 标题写法由两年回放归纳 ⇒ 运行时不变量 = D10 `earnings_board_list_scan` 里的会前通知信号数与清单行数对照。

**D7 · 来源 C：港交所董事會會議通知清单 `hkex-board-meeting-list.source.ts` + `hkex-board-meeting-list.rules.ts`（FR-006 / FR-020a / FR-024 / FR-025）**

- **获取**：`GET https://www3.hkexnews.hk/reports/bmn/ebmn_c.htm`（URL 为代码常量）经 `VendorHttpClient.requestText`；新约束档 `hkexnews.constraint-profile.ts`：每轮 1 次请求、超时 30 s、客户端内重试 3 次（`ASSUMED:` 礼貌值，无官方限额；错了的后果是被限流 ⇒ 本轮来源失败告警、次日重试）。日常与回填模式行为相同（清单无历史）。
- **页面结构（2026-09-13 取证）**：`<meta ... charset=utf-8>`；页首文本「日期 : DD/MM/YYYY」；数据表 `<table class=textfont>`，每个数据行 6 个 `<td>`（会议日期 / 空列 / 證券簡稱 / 代號 / 目的 / 期間，期間可空）；页面自述未必尽列、多日会议只列开始日。`Last-Modified` = 2026-09-10 12:30（香港时间），2026-09-11 未见更新。
- **解析纯函数**（零 I/O）输入 HTML 文本，输出 `{ pageDate, rows[], skipped{ dividendOnly, … } }` 或抛 `BoardListParseError`：
  1. 页首日期 MUST 解析成功（`日/月/年`，交易所当地日期）；
  2. 表头 MUST 含「會議日期 / 證券簡稱 / 代號 / 目的 / 期間」；
  3. 🚨 **结构不变量**：页面中「形如数据行」的 `<tr>`（首格为 `DD/MM/YYYY`）数 MUST 等于成功按列解析的行数，任一行列数 / 代码 / 日期不合法 ⇒ 整页抛错（FR-025：零写入）；
  4. 目的含「業績」或「收益資料」⇒ 业绩行；否则纯股息行 ⇒ 计数跳过（1776 行中目的 34 种，spec 取证）；
  5. 期间 → 期末日与类型交给 D4；
  6. 代码补零到 5 位，按 `hk` + code 查标的主表，查不到（人民币柜台 `8xxxx` 等）⇒ 计数跳过（FR 同现役口径）；
  7. 同页同日同代码多行 ⇒ 按期间各自成观测。
- **观测**：口径 `meeting`，会议日 = 行日期，凭据 = 页首日期；来源语义「仅已公告」（FR-011）。
- **陈旧**：页首日期距业务日超过 2 个交易日（`trading_day` 区间计数，D8 同一方法）⇒ `earnings_board_list_stale` finding，解析出的行照常入库。
- **提前消失**（FR-016）：上一轮在清单、本轮不在、且会议日 > 本轮页首日期、且同标的同期无新日期 ⇒ 流水记「清单消失」+ `earnings_board_list_dropped` finding，观测保留最后日期、🚫 不删、🚫 不撤销确认。仅在本轮清单解析成功时判定（解析失败的轮次不判消失）。
- **缺失语义三问**：① 无会议 = 不列行；纯股息行 = 有会议无业绩；② 「未列」分不清「公司未发通知 / 清单漏收 / 页面滞后 / 创业板不在清单」—— 由 FR-017（仅对曾出现在清单的标的告警）+ 富途兜底；③ 写法由 8 份 Wayback 快照 + 当日页面（1776 行）归纳 ⇒ 运行时不变量 = 每轮 `earnings_board_list_scan`（页首日期、数据行、业绩行、股息行、跳过代码、`T:` 键数）。
- **依据（PoC）**：会议日落在快照时段内的锚表港股会前通知 16 份，清单收录 16 / 16 且会议日一致；清单会议日 + 富途回放锚表两年逐日一致 172 / 176（spec 取证）。

**D8 · 合并 `earnings-date-merge.rules.ts`（纯函数）+ `sync-earnings-dates.usecase.ts`（FR-008 ~ FR-019a 逐条见下）**

- 纯函数输入：某 `(instrument, period_key)` 全部观测、来源能力、间隔、该标的会前通知信号、「该标的是否曾有清单观测」、公布日之后已过交易日数（或「日历不可判」）。输出：事件字段、流水、findings。零 I/O。
- 规则：
  - **取值**（FR-008 / FR-009 / FR-010）：`filed` > `explicit` > `structured` > `meeting`（会议日 + 间隔，无历史按 0）。首批来源不产出 `explicit`。
  - **可解释差异**（FR-014）：仅近似口径、差 ≥ 2 天，且结构化日期 = 清单会议日、会议日推定 = 会议日 + 间隔 ⇒ 取推定值，写流水不发冲突。
  - **冲突**（FR-014）：精确口径间任何不一致；或近似口径差 ≥ 2 天且不可解释 ⇒ `conflict`。近似差 1 天 ⇒ 优先级取值、写流水。
  - **确认**（FR-011 / FR-012 / FR-021）：有「仅已公告」来源观测 ⇒ `confirmed`；只有 `unconfirmed` 来源 ⇒ `unconfirmed`，🚫 永不升级。确认日期 = 对应会前通知信号的刊发日（`announced`）：同标的、刊发日 ∈ `[事件日期 − 120 天, 事件日期]` 且晚于该标的上一次刊发事实的信号中**最早**的一个；无对应信号 ⇒ 给出日期的来源首次观测的交易所当地日期（`first_seen`）。
  - **已通知日期未知**（FR-017）：会前通知信号刊发后满 2 个交易日、该标的无任何未刊发事件带日期：该标的曾有清单观测 ⇒ `notified_undated` + finding；否则只计数。之后任一来源给出日期即转确认，确认日期取该信号刊发日。
  - **刊发覆盖**（FR-019）：出现 `filed` ⇒ `published`，回填各来源各口径偏差；有会议日时更新 `earnings_meeting_lag`。
  - **逾期**（FR-019a）：非 `published` 且公布日之后满 2 个交易日 ⇒ `overdue`。交易日数用 `trading_day` 三态计数（`trading-day.rules.ts:91` 判据）；区间含 `unknown` ⇒ 不判，发 `unjudged`。`TradingCalendarPort`（`trading-calendar.port.ts:23-70`）新增「区间交易日数」方法，写法照 `previousTradingDay` 覆盖闸（`db-trading-calendar.adapter.ts:102-121`）。
- **触发点**：只有日常运行（全量重算当天有观测或信号变化的事件 + 逾期扫描 + 未知日期扫描）。事件行仍带 `revision` 条件更新（CLI 回填与定时运行可能重叠）：读观测与事件 → 计算 → `updateMany where { id, revision }` → 命中 0 行则重读重算，最多 3 次（`docs/conventions/server-impl-playbook.md` 条件 UPDATE + affected-count）；🚫 不用 `SELECT … FOR UPDATE`。
- 每个事件一个事务（观测 upsert → 事件条件更新 → 流水 insert）；🚫 HTTP 在事务外。

**D9 · 编排：港股维度 + 美股钩子 + 回填（FR-007 / FR-020 / FR-021 / FR-022 / FR-024）**

- **新维度 `hk_earnings_date`**：`{hk}`、`queue_lane='futu'`（唯一走共享限频的是富途调用；`vendor` 列只是标注，`market-routed-eod-bar.adapter.ts:19`）、cron `0 30 23 * * *`（`Asia/Shanghai`，在 `announcement` 22:00 之后；清单页白天生成）、asOf `calendar-day`、`next_fire_at` 留 NULL（`sync-tick-driver.ts:324-333`）。依赖边 `universe → hk_earnings_date`、`announcement → hk_earnings_date` 均 soft。非交易日由 tick 交易日闸跳过（`sync-tick-driver.ts:245-254`）。
- 运行步骤：① 各来源 `collect`（富途 → 公告 → 清单；按来源 try/catch 隔离）② 合并 + 逾期扫描 + 未知日期扫描 ③ findings。
- **注册触点**（073 同形，commit `5790a777`）：`DIMENSION_KEYS`（`dimension-executor.ts:187`）；asOf 表（`sync-asof.rules.ts:65-105`）；executor 注册与构造器尾部默认值（仿 `earnings_event` 非 factExecutor 写法 `:1057-1062`）；**不**进锚作用域表，并在 `anchor-scoped-dimensions.rules.spec.ts` 加反向断言；拓扑守卫 `dimension-executor.spec.ts:4521-4630`；写死维度清单的 IT（`marketdata.schema-016`、`backfill-cli`、`tick-driver`、`adjustment-factor`、`flow-orchestration`、`tier-night-e2e`、`night-e2e-019`、`marketdata-066.hk-dimension-seed`、`sync-schema-gate`、`test-dimension-registration`）；`ops/jobs/marketdata-table-health.sql` 与 `marketdata-sync-report.sql` 纳入新维度。
- 🚨 **不把 `hk` 加进 `earnings_event` 的 scope**：跨时区 scope 在 `exchangeCalendarDateForScope` 直接抛（`session-clock.ts:163-172`）。
- **美股钩子**（FR-021，零新增调用）：`SyncEarningsEventUseCase` 构造器尾部加可选观测记录器（默认空实现，照 `dimension-executor.ts:853` 默认值写法），在既有写入完成后（`sync-earnings-event.usecase.ts:245` 之后、`return` 之前）用 `observed` 调用一次。约束：① 包 `try/catch`，失败只 `logger.warn`，🚫 不改 `stats` / `findings` / `written`、不让异常冒出 `run()`（否则 `sync_run` 与重试行为改变，`dimension-executor.ts:1160-1163`）；② 两处提前 return（`:218` / `:221`）不调用；③ 429 顺延时部分数据照样落；④ 既有 Small spec 的 Prisma 替身不含新表（`sync-earnings-event.usecase.spec.ts:131-146`），默认空记录器保证不受影响。
- **回填**（FR-020）：经既有回填 CLI（`marketdata-trigger.cli.ts`）以 `mode=backfill` 跑 `hk_earnings_date`：富途 730 天窗 + 交易所两年业绩刊发事实与会前通知信号；清单只取当日页面（无历史）。🚨 prod 执行属于写操作，命令与参数先交维护者确认。

**D10 · findings 与告警（FR-023 / FR-025）**

沿用 `SyncRunStats`（`sync-run.recorder.ts:29-82`）写在 `hk_earnings_date` 运行记录上，日报经 `marketdata-sync-report.sql:111-138` 按 `step` 聚合 → 09:00 飞书：

| step | kind | 触发 |
| --- | --- | --- |
| `earnings_date_conflict` | notice | 新进入 `conflict`（含候选日期） |
| `earnings_date_overdue` | notice | 新进入 `overdue` |
| `earnings_date_source` | failure | 某来源 `collect` 抛错（含来源名；清单解析失败含失败原因与首个不合法行） |
| `earnings_date_calendar_unknown` | unjudged | 逾期 / 陈旧判定区间日历不可判 |
| `earnings_date_unaligned` | notice | 新增 `T:` / `D:` 键港股观测数 > 0 |
| `earnings_notice_undated` | notice | 新进入 `notified_undated`（含公告链接）；另计从未在清单出现标的的未知日期通知数 |
| `earnings_board_list_scan` | notice | 每轮：页首日期、数据行、业绩行、纯股息行、跳过代码、`T:` 键数、本轮会前通知信号数 |
| `earnings_board_list_stale` | notice | 页首日期距业务日超过 2 个交易日 |
| `earnings_board_list_dropped` | notice | 清单行在会议日前消失且无新日期 |

- 美股钩子失败不进 findings（D9）。

**D11 · 配置**

- 新增非密 env `EARNINGS_DATE_SOURCES`（默认 `futu_calendar,hkex_announcement,hkex_board_meeting_list`），按 `config-add` 流程落 `marketdata.config.ts`（`:13-33` / `:60-70`）+ `.env.example` + `.env.production` + `docker-compose.tight.yml`，收尾 `check-env-sync`。
- 清单 URL、陈旧阈值（2 个交易日）、通知匹配窗口（120 天）、未知日期判定（2 个交易日）为代码内具名常量，🚫 不做成 env。港交所无凭据。

**D12 · 验证与测试分层（`state_branches` 落点）**

| # | branch（spec `state_branches` 顺序） | 落点 |
| --- | --- | --- |
| 1 | 只有结构化日历 → `structured`；确认口径通知刊发日 / 首次观测 | `earnings-date-merge.rules.spec.ts` + 079 IT |
| 2 | 只有清单会议日 → 会议日 + 最近间隔 | merge spec（间隔 0 / 2 / 无历史）+ 079 IT |
| 3 | 多口径并存按优先级 | merge spec |
| 4 | 精确口径不一致 → 冲突 + 告警 | merge spec + 079 IT |
| 5 | 精确 vs 近似 → 取精确、留痕不告警 | merge spec + 079 IT |
| 6 | 近似差 1 天 → 优先级取值 | merge spec |
| 7 | 近似 ≥ 2 天可解释 → 取推定、不告警 | merge spec + 079 IT（`hk:00857` 形态） |
| 8 | 近似 ≥ 2 天不可解释 → 冲突 | merge spec（`hk:00960` 形态） |
| 9 | 冲突解除留痕 | 079 IT（两轮） |
| 10 | 确认时刻 = 对应通知刊发日 / 首次观测 | merge spec（窗口边界、多通知取最早、上一次刊发之前的通知不算）+ 079 IT |
| 11 | 已通知日期未知：曾在清单 → 告警；从未在清单 → 计数 | merge spec + 079 IT |
| 12 | 带「董事」字样但非通知写法 → 不作信号 | `earnings-notice.rules.spec.ts` |
| 13 | 刊发覆盖 + 偏差统计 + 间隔更新 | merge spec + 079 IT |
| 14 | 满 2 个交易日未刊发 → 逾期；刊发后解除 | 079 IT（种 `trading_day`，含假日与 `unknown` 臂） |
| 15 | 改期（清单两轮会议日变化 / 富途日期变化）→ 留痕重判 | 079 IT（两份 fixture 页面） |
| 16 | 清单行提前消失 → 保留、告警 | merge spec + 079 IT（第二份页面缺该行；另加「本轮解析失败不判消失」臂） |
| 17 | 来源失败隔离 | 079 IT |
| 18 | 报告期无法对齐 → 独立事件并计数 | `earnings-period.rules.spec.ts` + 079 IT |
| 19 | 不在主表（含人民币柜台）→ 跳过计数 | `hkex-board-meeting-list.rules.spec.ts` + 079 IT |
| 20 | 纯股息行 → 不作事件、计数 | board list rules spec |
| 21 | 清单结构异常 → 来源失败 + 零写入 | board list rules spec（三类变异 fixture）+ 079 IT（失败 finding 存在 且 清单观测 0 条 且 其余来源观测 > 0） |
| 22 | 清单陈旧 → 告警、观测照用 | 079 IT |
| 23 | 美股进层 `unconfirmed`；现役逐字节不变 | `sync-earnings-event.usecase.spec.ts`（记录器抛错时 `stats` / findings / 调用数不变）+ `optionsdesk-047.earnings-pit.it.spec.ts` 加臂（`earnings_event` 行与 `sync_run` 与基线逐字节相同，新表美股事件全 `unconfirmed`） |
| 24 | 港股打标读不到本片产出 | 079 IT 调期权台既有取腿用例：新表有 `confirmed` 港股事件，收租腿仍「无日期」 |

其余测试面：

- **`hkex-board-meeting-list.rules.spec.ts`**（Small，入仓 fixture `src/marketdata/__fixtures__/hkex-board-meeting-list/`：当日页面 + 一份多行 / 多期 / 人民币柜台 / 纯股息行齐全的 Wayback 快照，均为港交所公开页面）：页首日期、全部数据行逐行解析、目的与期间每类写法（spec 取证列出的形态各至少一例）、`日/月/年` 与两位年份、三类结构异常变异（删页首日期 / 删表头 / 破坏一行列数）。
- 真 vendor（Large，`RUN_MARKETDATA_IT` 门控，默认 skip）：`marketdata.futu-shim.vendor.spec.ts` 加港股财报日历用例；新增 `marketdata.hkexnews.vendor.spec.ts`（取当日清单页并过解析纯函数）。impl 期手动跑并贴输出。
- **SC-001 / SC-003 数据验收**：回填完成后与上线 30 天后，在 prod 跑只读核对，结果回填 spec；tasks 期立独立 `[Ops]` task + issue + 到期日。SC-004 以本机 evidence 目录的回放脚本在 impl 期复跑一次（输入改为新规则实现的纯函数）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发 / 事务**：事件写入用 `revision` 条件更新 + 命中数判定（D8），🚫 不用 `FOR UPDATE`；HTTP 在事务外。
- **时间语义**：业务日一律 `exchangeCalendarDate(market, now)`，单市场；公布日与清单日期是交易所当地日期；🚨 清单日期 MUST 自行按 `日/月/年` 拆解，🚫 MUST NOT 交给 `new Date('10/09/2026')` 或任何按「月/日」解析的工具；交易日数查日历三态（Rule A / B）。
- **响亮失败**：清单解析任何不变量破坏 ⇒ 抛错 ⇒ 来源失败 finding；🚫 MUST NOT 捕获后返回空数组（那等于宣布「今天没有会议」）。
- **安全**：清单 URL 为常量；不触鉴权 / PII。
- **配额**：富途只多港股每日约 38 次日历调用（推断）；港交所清单每日 1 次请求。
- **美股零回归绊线**：D9 钩子四条约束；`optionsdesk-047.earnings-pit.it.spec.ts` 基线对比臂先红后绿。
- **守卫脚本**：`check-server-moat`（4 张新表）、`check-time-semantics`、`check-test-size`（真 vendor 必门控）、`check-env-sync`。
- **Markdown**：spec / tasks 中带下划线的标识符一律包反引号。

### 决策备选与既有事实核录

**备选否决**：

1. 港股行写进 `earnings_event` —— 否：期权台读端不分市场（`get-legs.usecase.ts:733-739`）。
2. 每个来源各建一个维度 —— 否：加减来源要改 migration 与拓扑，与 FR-001 相反。
3. 美股来源改读 `earnings_event` —— 否：无「最近观测时刻」，满足不了 FR-013。
4. 套用 `FallbackChainAdapter` —— 否：首个成功即返回，做不了交叉验证（ADR-0047 §6）。
5. 富途报告期默认 12 月结年 —— 否（FR-015）。
6. 为财年结束月调理杏仁财报接口 —— 否：`financial_metric` 不存报告类型（`schema.prisma:466-480`，`lixinger-financials.adapter.ts:147-153`），标题 + 历史配对已够。
7. 腾讯自选股数据 —— 否（spec 取证）。
8. **方案 A：公告 PDF 获取与正文解析** —— 否：owner 2026-09-13 采纳 B。回放 174 vs 172 / 176，而 A 需要 PDF 解析依赖、受限 worker 线程、独立文档队列与任务台账、640 MB 容器内存闸门；B 差的 2 次由富途与冲突告警兜住（spec Session（五）；PoC 归档于本机 evidence 目录）。若日后 B 兜不住，A 可作为新增来源接回（FR-001）。
9. 只用清单、不接富途 —— 否：153 / 176，以美股为主上市的票整体差 1–4 天。
10. 付费 / 境外数据商（Wall Street Horizon、IBKR、LSEG、FactSet 等）—— 否：无公开证据覆盖港股且带确认状态；机构报价。
11. 长桥 OpenAPI 财报日历 —— 暂不：支持 `HK`，但是否含未公告日期与扩展字段内容未核实，且需开户；可作为后续新增来源（FR-001）。
12. 阿斯达克 / 經濟通网页 —— 否：非官方抓取、日期口径不明、条款风险；經濟通与港交所清单抽样同源。
13. 港交所 IIS 推送 —— 否：只给「董事會召開日期」分类码、无日期字段、付费。
14. 清单英文版页面 —— 否：写法归纳基于中文版 1776 行；两版择一。
15. 引入 HTML 解析库 —— 否：固定结构小表，正则 + 结构不变量已足。
16. 清单只做锚表港股 —— 否：一次请求覆盖全部主板（owner）。
17. 清单解析异常时沿用上一轮观测、不告警 —— 否：改版会静默吞掉新会议（FR-025）。

**既有事实核录**（2026-09-13 plan 期逐项 grep / 只读核查，行号锚消费点）：

- 期权台读端：`optionsdesk/get-legs.usecase.ts:727-740`。
- 财报采集：`marketdata/sync-earnings-event.usecase.ts`（`run()` `:203`、业务日 `:213`、取窗 `:216`、提前 return `:218` / `:221`、写入 `:235-244`、窗序列 `:133`、视野 `:86`、notice 写法 `:341-345` / `:521-525`）；注册 `dimension-executor.ts:1057-1062`、DI `marketdata.module.ts:618`；seed `20260804_1155_seed_option_chain_dimensions/migration.sql:73`。
- 富途财报 adapter：`futu-earnings-calendar.adapter.ts:56-63`、`:189-194`、`:127-136`；port `earnings-calendar.port.ts:86-115`；绑定 `marketdata.module.ts:388-392`。
- 公告维度：`dimension-executor.ts:1008-1010`、`:356-370`、`:2614-2664`；seed `20260715_1800_create_hk_classification_text_tables/migration.sql:74`；表 `schema.prisma:903-918`（幂等键 `:914`、`(instrument_id, date desc)` 索引 `:915`）；回看 7 天 `20260801_2248…/migration.sql:30-31`。
- 维度注册触点：`dimension-executor.ts:187`；`dimension-executor.spec.ts:4521-4776`；`sync-asof.rules.ts:65-105`；`anchor-scoped-dimensions.rules.ts:44-62`；`sync-tick-driver.ts:245-254` / `:324-333`；`session-clock.ts:163-172`。
- 日历：`trading-calendar.port.ts:23-70`；`db-trading-calendar.adapter.ts:102-121`；`trading-day.rules.ts:91`；prod `trading_day` 港股 2024-08-01 → 2026-12-31 共 596 行（只读）。
- HTTP 客户端：`vendor-http-client.ts:106-123`（`FetchResponseLike.text` 可选）、`requestText` 读文本 `:265`；约束档 `vendor-constraint-profile.ts:10-44`；`collectionPort()` `marketdata.module.ts:218-238`。
- 标的主表：`schema.prisma:346-364`（`market` / `type` / `listingStatus`，**无板块字段** ⇒ FR-017 以「曾有清单观测」判定而不按代码区段猜板块）。
- 港交所清单：URL 与结构、`Last-Modified`、prod 可达性、Wayback 快照与写法统计见 D7 与 spec 取证；本机 evidence 目录 `hkex-board-meeting-list/`（20 个文件：快照、CDX 列表、对账脚本）。
- 告警链：`ops/jobs/marketdata-sync-report.sh:146-158`（非零退出 → `nvy-run-reported` → 飞书）；`marketdata-sync-report.sql:111-138`；kinds `sync-run.recorder.ts:29-82`。
- 护城河：`check-server-moat.ts:53-208`（marketdata `:80-134`）。
- migration：`.claude/rules/migration-rules.md:96-98`；`lefthook.yml:133-160`；`.github/workflows/pr-validation.yml:125-150`。
- 期权台打标隔离面：`optionsdesk-047.earnings-pit.it.spec.ts`（既有 IT）。

## Complexity Tracking

无违规，无需 justify。
