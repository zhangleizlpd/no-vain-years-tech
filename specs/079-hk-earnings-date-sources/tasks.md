---
feature_id: 079-hk-earnings-date-sources
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-13'
updated_at: '2026-09-13'
---

# Tasks: 079-hk-earnings-date-sources（港股财报日期多源采集与确认层 · 片 1/2：数据层）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0043`](../../docs/adr/0043-server-flat-module-paradigm.md)（扁平 / 贫血 / 护城河）+ [`ADR-0047`](../../docs/adr/0047-marketdata-pluggable-data-access.md)（port + 约束档 + fail-or-flag）+ [`ADR-0035`](../../docs/adr/0035-data-layer-governance.md)（migration 治理）+ [`ADR-0066`](../../docs/adr/0066-time-semantics-ubiquitous-language.md)（时间语义）
**Branch**: `079-hk-earnings-date-sources`

**一句话**：`marketdata` 内新建「财报日期」层 —— 富途财报日历、交易所公告（刊发事实 + 标题识别的会前通知信号）、港交所「董事會會議通知」清单（全部主板，每日一次 GET）三个可插拔来源产出带口径的观测，纯函数合并成「一个公布日 + 口径 + 状态」；**零 PDF**；清单改版 / 换地址 / 停更一律计入运行失败、次日飞书日报标红；美股顺带进层但现役逐字节不变，期权台一行不动。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, SC-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与同批其他 `[P]` task 并行（不同文件、无未完成依赖）。依赖写在正文「前置 =」。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红 → 绿在同一个 task 内闭环（Constitution §II），新增断言一律**定向变异证能红**。
- 层级：`[Server]` / `[Manual]` / `[Ops]`。**本片无 `[Contract]` / `[Mobile]`** —— 零 controller / DTO / UI 改动（FR-022）。
- 测试文件后缀按 [`docs/conventions/testing.md`](../../docs/conventions/testing.md) 判 size 后选定；`check-test-size` 若判不同以它为准。
- 🚨 **FR / SC / `state_branches` 一律逐条枚举**，禁范围记法（自审靠逐条 `grep`）。

## Path Conventions

| 用途 | 路径（均在 `apps/server/` 下） |
| --- | --- |
| 报告期规则 / 公告分类规则 / 清单解析规则 | `src/marketdata/earnings-period.rules.ts` / `earnings-notice.rules.ts` / `hkex-board-meeting-list.rules.ts` |
| 清单解析 fixture（港交所公开页面，文本） | `src/marketdata/__fixtures__/hkex-board-meeting-list/`（体例同 `src/portfolio/__fixtures__/`；取自本机 evidence 目录 `hkex-board-meeting-list/`：当日页面 + 2024-04-24 快照） |
| 合并纯函数 / 合并用例 | `src/marketdata/earnings-date-merge.rules.ts` / `sync-earnings-dates.usecase.ts` |
| 来源 port / 来源 A / B / C | `src/marketdata/earnings-date-source.port.ts` / `futu-calendar.source.ts` / `hkex-announcement.source.ts` / `hkex-board-meeting-list.source.ts` |
| 清单约束档 | `src/marketdata/hkexnews.constraint-profile.ts` |
| HTTP 客户端（加 `redirect` 透传） | `src/marketdata/vendor-http-client.ts` + `vendor-http-client.spec.ts` |
| 交易日历（加区间交易日数） | `src/marketdata/trading-calendar.port.ts` / `db-trading-calendar.adapter.ts` + `db-trading-calendar.adapter.spec.ts` |
| 配置 | `src/config/marketdata.config.ts`（+ 根 `.env.example` / `.env.production` / `docker-compose.tight.yml`） |
| 主 IT / schema IT | `test/integration/marketdata-079.earnings-dates.it.spec.ts` / `marketdata-079.schema.it.spec.ts`（PG 走 `test/_support/isolated-db.ts` 三入口） |
| 飞书日报面 IT | `test/integration/marketdata.sync-report-digest.it.spec.ts`（既有） |
| 真 vendor（`RUN_MARKETDATA_IT` 门控） | `test/integration/marketdata.futu-shim.vendor.spec.ts`（既有，加港股臂）/ `marketdata.hkexnews.vendor.spec.ts`（新增） |
| 运维 SQL | 根 `ops/jobs/marketdata-table-health.sql` / `ops/jobs/marketdata-sync-report.sql` |

## 🚨 排序铁律（违反会产生不可部署或静默错数的中间态）

1. **migration ① 只含表（T008）；维度 seed 与全部注册触点同 commit（T015）**，且 T015 晚于 T010–T014。先落 seed 会让写死维度清单的 IT 在中间 commit 变红，也会让 tick 触发一个没有执行器的维度。
2. 🚫 `hk_earnings_date` **不进** `ANCHOR_SCOPED_DIMENSIONS`；🚫 **不把 `hk` 加进** `earnings_event` 的 scope（`session-clock.ts:163-172` 跨时区直接抛）。T015 用反向断言钉住。
3. **清单失败三件套同 commit**（T013）：来源失败 finding + `stats.failed += 1` + 清单观测零写入。只落其中一两件的中间态会出现「日报为绿但清单没写」或「写了半页」。清单解析与获取 🚫 返回空数组、🚫 跟随重定向（T003 / T012）。
4. 美股钩子的基线对比臂**先红后绿**（T018）—— 先证明它能看到 `stats` / `sync_run` 的任何变化，再接钩子。
5. T022（回放复跑）达标前不合并、不接 auto-merge；T023 是 prod 写操作，命令与参数**先呈维护者确认**。
6. 新表不给 `optionsdesk` 任何读口（FR-022 的结构保证，T008 / T019）。
7. T003 入仓的 fixture 是港交所公开页面：commit message 写明来源 URL 与抓取日期。

## 🗂 推进批次（每批 2–3 个 task 为一个 /clear 检查点；批 ≠ commit，每 task 仍各自 atomic commit）

| 批 | Task | 主题 |
| --- | --- | --- |
| A | T001 → T003 · T002 | 报告期 / 清单解析 / 公告分类纯规则 |
| B | T004 → T005 · T006 | 合并纯规则 + 交易日计数 |
| C | T007 · T008 · T009 | HTTP 重定向透传 + 表 + 来源 port |
| D | T010 · T011 · T012 | 三个来源 |
| E | T013 → T014 | 合并用例 + findings / 飞书标红面 |
| F | T015 → T016 | 维度注册 + 场景 IT |
| G | T017 · T018 · T019 | 清单失败 IT + 美股钩子 + 打标隔离 |
| H | T020 · T021 | 来源增删演练 + 历史 / 回填 |
| I | T022 →（合并部署）→ T023 → T024 | 回放闸门与 prod 验收 |

## Server

- [ ] T001 [P] [Server] **报告期统一 `earnings-period.rules.ts`**（`FR-015`, plan §D4）：纯函数。① 清单期间 → 期末日与类型：「截至DD/MM/YY止N個月」（N = 3 / 9 ⇒ 季度、6 ⇒ 中期、12 ⇒ 年度、其他 N ⇒ 年度并计数）、「年度DD/MM/YY」、「截至DD/MM/YY止季度」、「截至DD/MM/YY期間」「由DD/MM/YY至DD/MM/YY」（期末 = 截止日、类型由目的列定）、「YYYY年第N季」与空白 ⇒ `T:` 键并计数；目的列无季度 / 中期 / 末期字样时类型由期间定。🚨 自行按 `日/月/年` 拆解、两位年份 = `20YY`，🚫 交给 `new Date()` 等按「月/日」解析的工具。② 交易所业绩公告标题 →「截至YYYY年M月D日止（三個月 / 六個月 / 九個月 / 年度）」「YYYY年M月底止季度」（阿拉伯与中文数字）⇒ `P:`。③ 富途 `period_text` 按公司财年换算：财年结束月依次取该公司交易所年度业绩标题期末日 → 历史配对（同公司富途与刊发事实公布日相差 ≤ 1 天反推）→ 都无 ⇒ `T:<来源>:<原文>`；兜底 `D:<来源>:<日期>`；美股一律 `T:`；🚫 默认 12 月结年。→ verify: `earnings-period.rules.spec.ts`：清单期间 spec 取证列出的每种形态各一例（含 15 個月、空白）、`10/09/26` ⇒ 2026-09-10；阿里 `2027Q1` ⇒ 截至 2026-06-30；自然年公司 `2026Q2`、清单「截至30/06/26止6個月」、公告「截至二零二六年六月三十日止六個月」落同一 `P:` 键；定向变异：日期按「月/日」解析 ⇒ 用例必红；两位年份按 `19YY` ⇒ 必红；默认 12 月结年 ⇒ 阿里用例必红。（`state_branches` 18 规则部分；Edge 9）

- [ ] T002 [P] [Server] **交易所公告分类规则 `earnings-notice.rules.ts`**（`FR-004`, `FR-005`, plan §D6）：单一维护点，两个纯函数：① 会前通知信号 —— 标题匹配强通知写法常量（董事會會議召開日期 / 通告 / 通知 / 日期、董事會召開日期、召開董事會的日期、業績公告日期、盈利公布及審議、審議會否派發、委員會會議日期、董事會委任的委員會會議）且 `types` 不含 `fs_main`；「決議」「名單」「委任」「職權範圍」「工作細則」等排除；② 业绩刊发事实 —— `types` 含 `fs_main`，「補充 / 更正」**窄排除**：只排除不含「業績公告 / 業績公佈」本体的。→ verify: `earnings-notice.rules.spec.ts`：spec 取证全部通知标题写法命中（含 `hk:01299`「董事會委任的委員會會議」、`hk:00005`「盈利公布及審議會否派發股息」、`hk:09961`「審計委員會會議日期及…業績公告日期」）；「董事會會議決議公告」「董事會成員名單與其角色及職能」「提名與薪酬委員會工作細則」不命中；业绩公告本身不作通知；`hk:09992`「截至2026年6月30日止六個月的中期業績公告及授出獎勵之補充公告」⇒ 刊发事实、「有關截至…年報之補充公佈」⇒ 非刊发；定向变异：補充排除放宽成「含補充即排除」⇒ `hk:09992` 用例必红。（`state_branches` 12；Edge 8）

- [ ] T003 [Server] **清单解析纯函数 `hkex-board-meeting-list.rules.ts` + fixture**（`FR-006`, `FR-025`, `SC-002`, plan §D7 解析）：前置 = T001。输入 HTML 文本，输出 `{ pageDate, rows[], counts }` 或抛 `BoardListParseError`（带原因与首个不合法行）：① 页首「日期 : DD/MM/YYYY」MUST 解析成功；② 表头 MUST 含「會議日期 / 證券簡稱 / 代號 / 目的 / 期間」；③ 🚨 结构不变量：首格形如 `DD/MM/YYYY` 的 `<tr>` 数 MUST 等于按列解析成功的行数（每行 6 个 `<td>`：日期 / 空列 / 简称 / 代码 / 目的 / 期間可空），任一不合法 ⇒ 整页抛错；④ 目的含「業績」或「收益資料」⇒ 业绩行，否则纯股息行计数跳过；⑤ 期间交 T001；⑥ 代码补零到 5 位（查主表在 T012）；⑦ 同页同日同代码多行各自成行。🚫 捕获后返回空结果。入仓 fixture：当日页面 + 2024-04-24 快照（含多期多行、人民币柜台 `8xxxx`、纯股息行）。→ verify: `hkex-board-meeting-list.rules.spec.ts`：两份 fixture 全部数据行解析，业绩行 / 纯股息行 / `T:` 键计数与手工核对值一致，0 行静默丢弃（`SC-002`）；多日会议取所列日期；三类变异 fixture（删页首日期 / 删表头 / 破坏一行列数）各自抛 `BoardListParseError` 且原因可读；定向变异：去掉结构不变量 ⇒ 「破坏一行」用例必红；纯股息行不排除 ⇒ 计数用例必红。（`state_branches` 19 代码补零部分、20、21 结构部分；Edge 5 / 6 / 7）

- [ ] T004 [P] [Server] **合并规则 ①：取值 / 冲突 / 确认**（`FR-002`, `FR-008`, `FR-009`, `FR-010`, `FR-011`, `FR-012`, `FR-014`, `SC-006`, plan §D8）：新建 `earnings-date-merge.rules.ts`，纯函数零 I/O，输入某 `(instrument, period_key)` 全部观测 + 来源能力 + 间隔 + 该标的会前通知信号；输出事件字段 + 流水 + findings。本 task：口径优先级 `filed > explicit > structured > meeting`（`meeting` = 会议日 + 最近间隔，无历史 0）；精确 / 近似冲突矩阵；近似差 1 天不冲突；可解释差异（结构化 = 清单会议日 且 推定 = 会议日 + 间隔 ⇒ 取推定）；冲突候选全保留；确认 —— 有「仅已公告」来源 ⇒ `confirmed`，只有 `unconfirmed` 来源 ⇒ `unconfirmed` 🚫 永不升级；确认日期 = 同标的、刊发日 ∈ `[事件日期 − 120 天, 事件日期]` 且晚于该标的上一次刊发事实的信号中最早者（`announced`），无则来源首次观测的交易所当地日期（`first_seen`）；公布日落在非交易日照记。🚫 规则里出现来源名分支。→ verify: `earnings-date-merge.rules.spec.ts`：US1 AS1（清单 M + 富途 D + 通知 ⇒ 公布日 D、口径结构化、确认日 = 通知刊发日）、AS2（只有清单 M、间隔 0 ⇒ M）、AS3（`hk:00857` 2026-08-28 周五 + 间隔 2 ⇒ 2026-08-30，富途 08-28 留痕不告警）、AS4（只有富途、无通知 ⇒ `first_seen`）；US2 AS1（刊发事实 08-20 vs 结构化 08-19 ⇒ 08-20 不告警）、AS2（两精确 11-12 / 11-13 ⇒ 冲突）、AS3（推定 11-14 vs 结构化 11-11 ⇒ 冲突；vs 11-15 ⇒ 取结构化不告警）；`hk:00960` 形态（清单 03-28 vs 富途 03-31、无间隔可解释 ⇒ 冲突）；通知匹配窗口边界（121 天前不算、上一次刊发之前不算、多通知取最早）；只有美股 `unconfirmed` 来源 ⇒ `unconfirmed`；定向变异：美股来源声明成「仅已公告」⇒ 必红；删可解释差异分支 ⇒ AS3 必红。（`state_branches` 1、2、3、4、5、6、7、8、10；Edge 1 / 2 / 17）

- [ ] T005 [Server] **合并规则 ②：已通知日期未知 / 刊发覆盖 / 逾期 / 改期 / 提前消失**（`FR-010`, `FR-013`, `FR-016`, `FR-017`, `FR-019`, `FR-019a`, `SC-011`, plan §D8）：前置 = T004（同文件）。① `notified_undated`：会前通知信号刊发后满 2 个交易日、该标的无任何未刊发事件带日期 —— 输入「该标的是否曾有清单观测」为真 ⇒ 状态 + finding，否则只计数；之后任一来源给出日期即转确认、确认日取该信号刊发日。② 出现 `filed` ⇒ `published` + 各来源各口径偏差 + 有会议日时产出间隔更新。③ 逾期：非 `published` 且公布日后已过交易日数 ≥ 2 ⇒ `overdue`；输入「不可判」⇒ `unjudged` 不判；刊发或改期后解除。④ 某来源日期变化 ⇒ 流水记旧日期与变更时刻后重判。⑤ 清单行提前消失（输入：上一轮在、本轮解析成功而不在、会议日 > 本轮页首日期、同期无新日期）⇒ 流水 + finding，观测保留、🚫 不撤销确认；本轮清单解析失败 ⇒ 🚫 不判消失。⑥ 无会前通知的期不产生 `notified_undated`。→ verify: merge spec 加臂：US3 AS1（推定 11-13 → 11-13 刊发 ⇒ 口径 `filed`、偏差 0）；US3 AS2 规则部分（`hk:00857` 年度周五会议、周日刊发 ⇒ 间隔 2）；曾在清单 ⇒ `notified_undated` + finding，从未在清单 ⇒ 仅计数；过 1 个交易日不判、满 2 个 ⇒ `overdue`、含 `unknown` ⇒ `unjudged`；刊发后解除转 `published`；提前消失保留日期 + finding、解析失败轮次不判；`hk:00941` 季度无通知 ⇒ 无未知日期态；定向变异：未知日期不查「曾在清单」⇒ 创业板形态用例必红；逾期改按日历日 ⇒ 跨周末用例必红。（`state_branches` 11、13、14、15、16；Edge 3 / 4 / 10 / 11 / 12 / 14 / 15）

- [ ] T006 [P] [Server] **交易日历「区间交易日数」**（`FR-019a`, `FR-025`, plan §D7 陈旧 / §D8 逾期）：`trading-calendar.port.ts`（`:23-70`）加方法：`(from, to]` 内交易日数，任一天 `unknown` 或缺行 ⇒ 返回「不可判」；`db-trading-calendar.adapter.ts` 照 `previousTradingDay` 覆盖闸（`:102-121`）写法实现，三态判据复用 `trading-day.rules.ts:91`。→ verify: `db-trading-calendar.adapter.spec.ts` 加臂：跨周末 + 港股假日计数正确；区间含 `unknown` ⇒ 不可判；超出日历覆盖 ⇒ 不可判（🚫 回 0）；定向变异：把 `unknown` 当交易日 ⇒ 必红。（`state_branches` 14、22 日历部分）

- [ ] T007 [P] [Server] **HTTP 客户端 `redirect` 透传**（`FR-025`, `SC-012`, plan §D7 获取）：`vendor-http-client.ts` 的 `VendorRequest`（`:168-174`）加可选 `redirect?: 'follow' | 'manual'`，原样传给 fetch（`:279-288`）；不传 ⇒ 行为逐字节不变。3xx 自然落进既有「非 ok ⇒ `VendorHttpError`」永久错误通路（`:308-310`，不重试）；`VendorHttpError` 加可选 `location`（取 `headers.get('location')`，`headers` 本就可选），错误消息带新地址。→ verify: `vendor-http-client.spec.ts` 加臂：传 `redirect: 'manual'` 时假 fetch 收到该参数；301 + `location` ⇒ `VendorHttpError` 且 `location` 可读、只调用 1 次（不重试）；不传时假 fetch 参数与既有用例一致（既有 spec 全绿）；定向变异：不透传 `redirect` ⇒ 参数断言必红。（`state_branches` 21 地址跳转部分）

- [ ] T008 [P] [Server] **migration ①：四张表 + 护城河登记**（`FR-013`, plan §D3）：`schema.prisma` 按 D3 加 `earnings_date_observation` / `earnings_date_event`（状态含 `notified_undated`，含 `revision`）/ `earnings_date_event_log` / `earnings_meeting_lag`，全部 `@@schema("marketdata")`，`period_key` 非空；expand-only migration `<yyyymmdd_hhmm>_create_earnings_date_layer`，**只含表**（排序铁律 1）；`scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP` 登记 4 个 model 归 `marketdata`；spec frontmatter `migration_refs` 写入；`prisma generate`。🚫 不给 `optionsdesk` 加任何 `CROSS-CONTEXT-READ`。→ verify: `marketdata-079.schema.it.spec.ts`（`setupEmptyDb()` 变体跑 `migrate deploy`）断四表与各唯一键存在；`check-server-moat` 绿；定向变异：去掉一个 `MODEL_OWNERSHIP` 登记 ⇒ moat 必红。

- [ ] T009 [P] [Server] **来源 port + 装配 + 配置**（`FR-001`, `FR-002`, `FR-018`, plan §D2, §D11）：新建 `earnings-date-source.port.ts`（token `EARNINGS_DATE_SOURCES` 注入来源数组；`name` / `capabilities(market)` / `collect({ market, businessDate, now, mode })` 返回观测与会前通知信号，失败直接抛）；`marketdata.module.ts` 工厂按配置组装，`kind=mock` 经既有 `collectionPort()`（`:218-238`）得拒绝壳；按 config-add 流程加非密 env `EARNINGS_DATE_SOURCES`（默认 `futu_calendar,hkex_announcement,hkex_board_meeting_list`）到 `src/config/marketdata.config.ts` + `.env.example` + `.env.production` + `docker-compose.tight.yml`；未知来源名装配期拒。→ verify: 新建装配 spec：去掉一个来源 ⇒ 数组只剩另两个；未知名 ⇒ 启动报错；`scripts/checks/check-env-sync.ts` 绿；定向变异：未知名静默忽略 ⇒ 报错臂必红。

- [ ] T010 [Server] **来源 A：富途财报日历**（`FR-002`, `FR-003`, `FR-021`, `FR-024`, plan §D5）：前置 = T001、T009。`futu-earnings-calendar.adapter.ts:56-63` 前缀表加 `hk ↔ HK`，翻转 `futu-earnings-calendar.adapter.spec.ts:213-215`「hk 抛错」用例（commit message 写理由：`earnings_event` scope 仍只有 us）；`earnings-calendar.port.ts` 的 `EarningsCalendarEvent`（`:86-115`）加可空 `publicationTime`，映射 `earnings_timestamp`（`:127-136`）；新建 `futu-calendar.source.ts`：港股 = 前向「仅已公告」+ 历史 `structured`，美股 = `unconfirmed`；取值单点 `toSourceObservations(events, market)`；港股窗口 `[业务日 − 7, 业务日 + EARNINGS_FORWARD_HORIZON_DAYS]`、backfill 730 天；主表外代码跳过计数；notice 输出港股前向行数。→ verify: adapter spec 港股臂 + `publicationTime` 映射臂；source spec：能力声明、跳过计数；`earnings_event` 既有 spec 全绿；真 vendor `marketdata.futu-shim.vendor.spec.ts` 加港股用例（门控，impl 期手动跑贴输出）。（`state_branches` 1 来源部分、19；Edge 16）

- [ ] T011 [Server] **来源 B：交易所公告（刊发事实 + 会前通知信号，零 PDF）**（`FR-004`, `FR-005`, `FR-020`, `FR-024`, plan §D6）：前置 = T001、T002、T008、T009。新建 `hkex-announcement.source.ts`：读 `marketdata.announcement`（零新增理杏仁调用），日常窗口 `[业务日 − 7, 业务日]`、回填 730 天；刊发事实（T002 ②）⇒ `filed` 观测，**全部港股**，公布日 = `+08:00` 当地日期（`lixinger-announcement.adapter.ts:19-21`），报告期取标题（T001）；会前通知信号（T002 ①）⇒ `{ instrument, noticeDate, title, link }`；主表外代码跳过计数。→ verify: `marketdata-079.earnings-dates.it.spec.ts`：种公告行 ⇒ 刊发事实观测覆盖锚与非锚港股；`hk:09992` 補充标题刊发被收；通知信号条数与标题分类一致、决议公告不出信号；主表外代码跳过计数。（`state_branches` 12 来源部分、19）

- [ ] T012 [Server] **来源 C：港交所清单（获取 + 陈旧 + 主表映射）**（`FR-006`, `FR-020a`, `FR-024`, `FR-025`, plan §D7）：前置 = T003、T006、T007、T009。新建 `hkexnews.constraint-profile.ts`（每轮 1 次、超时 30 s、客户端内重试 3 次，`ASSUMED:` 写明错了的后果）与 `hkex-board-meeting-list.source.ts`：URL 常量，`requestText` 带 `redirect: 'manual'`；🚨 404 / 3xx / 网络失败 / `BoardListParseError` 一律向上抛（由 T013 计失败），🚫 捕获后返回空；解析成功后：代码按 `hk` + code 查主表，查不到（人民币柜台等）计数跳过；产出 `meeting` 口径观测（凭据 = 页首日期）；页首日期距业务日 > 2 个交易日（T006）⇒ 返回 `stale` 标记（行照常产出）；回传本轮在清单上的 `(instrument, period_key)` 集合供提前消失判定。→ verify: source spec（假 HTTP）：404 / 301 / 变异页均抛错且错误含状态码或跳转目标或首个不合法行；正常页产出观测、跳过计数、`stale` 标记在落后 3 个交易日时为真、1 个交易日时为假；真 vendor `marketdata.hkexnews.vendor.spec.ts`（门控，取当日页并过 T003，impl 期手动跑贴输出）；定向变异：不带 `redirect: 'manual'` ⇒ 301 臂必红。（`state_branches` 19 主表部分、21 获取部分、22 判定部分）

- [ ] T013 [Server] **合并用例 `sync-earnings-dates.usecase.ts`：来源隔离 + 失败计数 + 乐观并发**（`FR-007`, `FR-012`, `FR-013`, `FR-016`, `FR-018`, `FR-020a`, `FR-023`, `FR-025`, `SC-005`, plan §D8, §D10 标红链路）：前置 = T004、T005、T006、T008、T010、T011、T012。直注 `PrismaService`；按来源 try/catch：🚨 **失败三件套同 commit**（排序铁律 3）—— `earnings_date_source` failure finding（`symbol = source:<来源名>`，含原因）+ `stats.failed += 1` + 该来源本轮观测零写入；清单 `stale` ⇒ `earnings_board_list_stale` failure finding + `stats.failed += 1`（观测照写）；其余来源照常合并、🚫 撤销既有确认。合并：对当天有观测或信号变化的事件全量重算 + 逾期扫描 + 未知日期扫描；清单观测维护首次 / 最近出现时刻与会议日变更史，并据上一轮集合判定提前消失（仅本轮清单成功时）；每事件一事务（观测 upsert → 事件 `updateMany where { id, revision }` → 流水），命中 0 行重读重算最多 3 次；🚫 `FOR UPDATE`、🚫 事务内 HTTP；间隔更新写 `earnings_meeting_lag`。→ verify: 079 IT（直接调用用例）：① 会前通知刊发后、清单首次列出该期那一轮 ⇒ `confirmed`、确认日期 = 通知刊发日而非首次观测（`SC-005`，US1 AS1）；② 两精确口径冲突 ⇒ `conflict` + 全部日期可查；次日一致 ⇒ 解除留痕（US2 AS2 / AS4）；③ 清单来源抛错 ⇒ `stats.failed ≥ 1`、运行状态经 recorder 为 `partial`、清单观测 0 条、富途与公告观测 > 0；④ 两次合并交错写同一事件 ⇒ `revision` 冲突重试后结果正确；定向变异：来源失败不加 `stats.failed` ⇒ ③ 的 `partial` 断言必红；去掉 `revision` 条件 ⇒ ④ 必红。（`state_branches` 4、9、10、17 用例部分；US2 AS4）

- [ ] T014 [Server] **findings 出口 + 飞书日报标红面**（`FR-023`, `FR-025`, `SC-012`, plan §D10）：前置 = T013。按 plan §D10 表写 `SyncRunStats`（`sync-run.recorder.ts:29-82`）：`earnings_date_conflict` / `earnings_date_overdue` / `earnings_date_source`（failure，计数）/ `earnings_date_calendar_unknown`（unjudged）/ `earnings_date_unaligned` / `earnings_notice_undated` / `earnings_board_list_scan`（页首日期、数据行、业绩行、纯股息行、跳过代码、`T:` 键数、会前通知信号数）/ `earnings_board_list_stale`（failure，计数）/ `earnings_board_list_dropped`。→ verify: 079 IT：各 finding 的 step / kind 与 plan §D10 表逐行一致、failure 类与 `stats.failed` 同增；`marketdata.sync-report-digest.it.spec.ts` 加一臂：种 `hk_earnings_date` 的 `partial` 运行（含 `earnings_date_source` failure finding），断言日报该维度行为非成功图标、`↳` 摘要含 `failure×1{earnings_date_source}` 形态、脚本退出码非零（飞书 🔴 的触发条件，`ops/jobs/marketdata-sync-report.sh:151` / `:345`）；定向变异：stale 写成 notice 且不计数 ⇒ 079 IT 的 `partial` 断言必红。（`state_branches` 21、22 告警部分）

- [ ] T015 [Server] **维度 seed migration ② + 注册触点 + 运行编排**（`FR-007`, `FR-023`, `FR-024`, plan §D9）：前置 = T010–T014（排序铁律 1）。migration `<yyyymmdd_hhmm>_seed_hk_earnings_date_dimension`：`hk_earnings_date`（`{hk}`、`queue_lane='futu'`、cron `0 30 23 * * *` `Asia/Shanghai`、asOf `calendar-day`、`next_fire_at` NULL）+ 依赖边 `universe → hk_earnings_date` / `announcement → hk_earnings_date` 均 soft；**同 commit** 完成：`DIMENSION_KEYS`（`dimension-executor.ts:187`）、asOf 表（`sync-asof.rules.ts:65-105`）、executor 注册与构造器尾部默认值（仿 `:1057-1062`）、`anchor-scoped-dimensions.rules.spec.ts` 加**反向断言**、拓扑守卫 `dimension-executor.spec.ts`、写死维度清单的 IT（`marketdata.schema-016`、`backfill-cli`、`tick-driver`、`adjustment-factor`、`flow-orchestration`、`tier-night-e2e`、`night-e2e-019`、`marketdata-066.hk-dimension-seed`、`sync-schema-gate`、`test-dimension-registration`）、`ops/jobs/marketdata-table-health.sql` 与 `ops/jobs/marketdata-sync-report.sql`。运行步骤：① 各来源 `collect`（富途 → 公告 → 清单）② 合并 + 扫描 ③ findings。🚫 `hk` 进 `earnings_event` scope。→ verify: 解析 `cron_expr` 断下一触发时刻晚于同日 `announcement` 的 22:00（机械断言）；079 IT 经维度执行跑通三来源一轮；`nx test server` 全量中上列 IT 全绿；定向变异：把 `hk_earnings_date` 加进 `ANCHOR_SCOPED_DIMENSIONS` ⇒ 反向断言必红。

- [ ] T016 [Server] **079 场景 IT（经维度运行端到端）**（`FR-009`, `FR-010`, `FR-014`, `FR-015`, `FR-016`, `FR-017`, `FR-019`, `FR-019a`, `SC-006`, `SC-011`, plan §D12）：前置 = T015。`marketdata-079.earnings-dates.it.spec.ts` 经维度执行：① `hk:00857` 形态序列（清单周五会议日 → 周日刊发事实 ⇒ 间隔学到 2；下一期清单会议日 + 富途记会议日 ⇒ 取推定 +2、0 条冲突告警、差异留痕，US1 AS3 / US3 AS2 / `SC-006` 后半）；② 满 2 个交易日未刊发 ⇒ `overdue` + finding 且未转历史，注入刊发 ⇒ 解除转 `published`（`SC-011`；种 `trading_day` 含假日与 `unknown` ⇒ `unjudged`）；③ 两份 fixture 页先后运行、同期会议日变化 ⇒ 改期流水；④ 第二份页缺该行、会议日未到 ⇒ 提前消失 finding、确认保留；⑤ 报告期无法对齐 ⇒ 独立事件 + `earnings_date_unaligned`；⑥ 刊发覆盖 + 偏差统计（US3 AS1）；⑦ 通知信号 2 个交易日后仍无日期：曾在清单的标的 ⇒ `notified_undated` + finding，从未在清单的创业板代码 ⇒ 仅计数。→ verify: 七臂全绿；定向变异：逾期改按日历日 ⇒ ② 必红；提前消失在解析失败轮次也判 ⇒ 加一轮失败页后 ④ 断言必红。（`state_branches` 7、11、13、14、15、16、18；Edge 3 / 4 / 10 / 11）

- [ ] T017 [Server] **清单失败与陈旧 IT（飞书标红面端到端）**（`FR-025`, `SC-012`, plan §D12 #21–22）：前置 = T015。079 IT 经维度执行，假 HTTP 分别返：① 404、② 301 + `location`、③ 缺页首日期、④ 缺表头、⑤ 一行列数被破坏 —— 每种都断言：`earnings_date_source` failure finding 含对应原因、`sync_run.status = partial`、`failed ≥ 1`、本轮清单观测新增 0 条、富途与公告观测 > 0；⑥ 页首日期落后 3 个交易日 ⇒ `partial` + `earnings_board_list_stale` + 该页行照常入库。→ verify: 六臂全绿；定向变异：清单来源失败时返回空数组而非抛错 ⇒ ①–⑤ 的 `partial` 断言必红。（`state_branches` 21、22；Edge 13）

- [ ] T018 [Server] **美股钩子：观测顺带进合并层，现役逐字节不变**（`FR-021`, `SC-008`, plan §D9 美股钩子）：前置 = T010、T013。**先写基线对比臂并跑红**（排序铁律 4），再接钩子：`SyncEarningsEventUseCase` 构造器尾部加可选观测记录器（默认空实现，照 `dimension-executor.ts:853`）；在既有写入完成后（`sync-earnings-event.usecase.ts:245` 之后、`return` 之前）用 `observed` 经 `toSourceObservations` 调一次；① `try/catch` 只 `logger.warn`，🚫 改 `stats` / `findings` / `written`、🚫 异常冒出 `run()`（`dimension-executor.ts:1160-1163`）；② 两处提前 return（`:218` / `:221`）不调用；③ 429 顺延时部分数据照落；④ 零新增 vendor 调用。→ verify: `sync-earnings-event.usecase.spec.ts` 加臂：记录器抛错时 `stats` / findings / vendor 调用数与基线一致、提前 return 不调用；`optionsdesk-047.earnings-pit.it.spec.ts` 基线对比臂：`earnings_event` 行与 `sync_run` 与本片前逐字节相同、新表美股事件全 `unconfirmed`、`confirmed` 计数 0；定向变异：让记录器异常冒出 ⇒ 基线臂必红。（`state_branches` 23；Edge 17）

- [ ] T019 [Server] **港股打标隔离**（`FR-022`, `SC-009`, plan §D1）：前置 = T016。079 IT 调期权台既有取腿用例：新表里有 `confirmed` 港股事件时，港股收租腿财报标签仍为「无日期」；另加结构断言：`apps/server/src/optionsdesk/` 内零引用本片 4 个新 model。→ verify: 两臂绿；定向变异：往 `earnings_event` 写一行港股 ⇒ 打标臂必红。（`state_branches` 24）

- [ ] T020 [Server] **来源增删演练 + 单源失败隔离**（`FR-001`, `FR-018`, `SC-007`, `SC-010`, plan §D2）：前置 = T015。079 IT：① 配置去掉清单来源跑一轮 ⇒ 正常完成、此前由清单参与确认的事件不删除；恢复 ⇒ 清单重新参与（US4 AS1，`SC-007`）；② 注入只提供刊发事实的假来源、移除真来源 ⇒ 合并 / 口径 / 冲突规则零改动完成，并断言 `earnings-date-merge.rules.ts` 不含来源名字面量（US4 AS2，`SC-010`）；③ 富途来源抛错 ⇒ 其余照常合并、既有确认不撤销、`partial` + failure finding。→ verify: 三臂绿；定向变异：来源异常不隔离 ⇒ ③ 必红。（`state_branches` 17；Edge 13）

- [ ] T021 [Server] **历史业绩公布日 + 回填 CLI**（`FR-020`, `SC-001`, plan §D9 回填）：前置 = T015。历史刊发事实合并各来源、覆盖可得范围 ≥ 2 年；`marketdata-trigger.cli.ts` 以 `mode=backfill` 跑 `hk_earnings_date`：富途 730 天窗 + 交易所两年刊发事实与会前通知信号 + 清单当日页（无历史）。→ verify: `marketdata.backfill-cli.it.spec.ts` 加臂：回填后 `hk:00005` 历史含 2026-02-25 / 2026-05-05 并标来源（US5 AS1）、`hk:00857` 三个周日刊发日与 `hk:09992` 補充标题刊发在列；清单请求次数 = 1；定向变异：回填模式按日循环请求清单 ⇒ 请求次数断言必红。

## Manual / Ops

- [ ] T022 [Manual] **合并前回放复跑（SC-004 闸门）**（`SC-004`, plan §D12 数据验收）：前置 = T001–T021 全绿。用本机 evidence 目录的回放输入（锚表港股两年 176 次有会前通知的刊发、清单会议日代理值、富途历史日期、刊发事实）驱动**已实现的** `earnings-period.rules.ts` 与 `earnings-date-merge.rules.ts` 纯函数重算公布日（回放脚本留本机、不入仓）。→ verify: 逐日一致 ≥ 97%（基线 172 / 176），其余全部落在「会议日 → 其下一交易日」内或产生冲突；结果与命令贴进 PR 描述；**不达标不合并、不接 auto-merge**（排序铁律 5）。

- [ ] T023 [Manual] **prod 执行回填 CLI（写操作）**（`FR-020`, plan §D9 回填）：前置 = 本片已部署到 prod。回填命令与参数（`mode=backfill`、维度 `hk_earnings_date`、窗口）**先呈维护者确认**再执行；执行后只读核对刊发事实行数、清单观测行数与首轮 findings。→ verify: 维护者确认记录 + 执行输出贴 issue；次日 09:00 飞书日报出现 `hk_earnings_date` 行且状态为成功（或失败原因可读）。

- [ ] T024 [Ops] **prod 只读验收：SC-001 与 SC-003**（`SC-001`, `SC-003`, plan §D12 数据验收）：前置 = T023。开 issue（到期日 = 上线后 30 天）：① `SC-001` —— 锚表港股两年刊发事实与交易所刊发日逐条一致（含 `hk:00005` 两条、`hk:00857` 三个周日、`hk:09992` 補充标题）；② `SC-003` —— 上线 30 天内锚表港股经标题识别的会前通知，逐条核对 2 个交易日内被清单收录、或富途给出日期、或产生 `notified_undated` 告警。→ verify: issue 内贴只读查询与结果并回填 spec 取证段；未达标项开 follow-up。

---

## 覆盖自查（analyze 阶段请逐条 `grep` 复核，别信本表的历史数字）

| 维度 | 覆盖情况 |
| --- | --- |
| FR-001 | T009 + T020 |
| FR-002 | T004 + T009 + T010 |
| FR-003 | T010 |
| FR-004 | T002 + T011 |
| FR-005 | T002 + T011 |
| FR-006 | T003 + T012 |
| FR-007 | T013 + T015 |
| FR-008 | T004 |
| FR-009 | T004 + T016 |
| FR-010 | T004 + T005 + T016 |
| FR-011 | T004 |
| FR-012 | T004 + T013 |
| FR-013 | T005 + T008 + T013 |
| FR-014 | T004 + T016 |
| FR-015 | T001 + T016 |
| FR-016 | T005 + T013 + T016 |
| FR-017 | T005 + T016 |
| FR-018 | T009 + T013 + T020 |
| FR-019 | T005 + T016 |
| FR-019a | T005 + T006 + T016 |
| FR-020 | T011 + T021 + T023 |
| FR-020a | T012 + T013 |
| FR-021 | T010 + T018 |
| FR-022 | T019 |
| FR-023 | T013 + T014 + T015 |
| FR-024 | T010 + T011 + T012 + T015 |
| FR-025 | T003 + T006 + T007 + T012 + T013 + T014 + T017 |
| SC-001 | T021（代码）+ T024（prod） |
| SC-002 | T003 |
| SC-003 | T024 |
| SC-004 | T022 |
| SC-005 | T013 |
| SC-006 | T004 + T016 |
| SC-007 | T020 |
| SC-008 | T018 |
| SC-009 | T019 |
| SC-010 | T020 |
| SC-011 | T005 + T016 |
| SC-012 | T007 + T014 + T017 |
| `state_branches` 1–24 | 1 → T004 + T010 ｜ 2 → T004 ｜ 3 → T004 ｜ 4 → T004 + T013 ｜ 5 → T004 ｜ 6 → T004 ｜ 7 → T004 + T016 ｜ 8 → T004 ｜ 9 → T013 ｜ 10 → T004 + T013 ｜ 11 → T005 + T016 ｜ 12 → T002 + T011 ｜ 13 → T005 + T016 ｜ 14 → T005 + T006 + T016 ｜ 15 → T005 + T016 ｜ 16 → T005 + T016 ｜ 17 → T013 + T020 ｜ 18 → T001 + T016 ｜ 19 → T003 + T010 + T011 + T012 ｜ 20 → T003 ｜ 21 → T003 + T007 + T012 + T014 + T017 ｜ 22 → T006 + T012 + T014 + T017 ｜ 23 → T018 ｜ 24 → T019 |
| **Acceptance Scenario 13 条** | US1: AS1 → T004 + T013 · AS2 → T004 · AS3 → T004 + T016 · AS4 → T004 + T010；US2: AS1 → T004 · AS2 → T004 + T013 · AS3 → T004 · AS4 → T013；US3: AS1 → T005 + T016 · AS2 → T005 + T016；US4: AS1 → T020 · AS2 → T020；US5: AS1 → T021 |
| **Edge Case 17 条** | 1 会议日 ≠ 公布日 → T004 ｜ 2 周末 / 假日刊发 → T004 ｜ 3 清单只收主板 → T005 + T016 ｜ 4 清单漏收 / 页面滞后 → T005 + T016 ｜ 5 多日会议 → T003 ｜ 6 同一公司同日多行 → T003 ｜ 7 纯股息行 → T003 ｜ 8 长得像通知 → T002 ｜ 9 报告期对不上 → T001 ｜ 10 改期 → T005 + T016 ｜ 11 清单行提前消失 → T005 + T016 ｜ 12 日期已过仍未刊发 → T005 ｜ 13 来源停服 / 页面改版 / 换地址 → T017 + T020 ｜ 14 无历史间隔 → T005 ｜ 15 公司不为某类报告发通知 → T005 ｜ 16 非主表代码 → T010 + T011 + T012 ｜ 17 美股 → T004 + T018 |

> ⚠️ 本表由脚本枚举 spec 的 `state_branches`（24）/ FR（27）/ SC（12）/ Edge Case（17）/ Acceptance Scenario（13）后逐条对照写成；**本表这次对了，不构成它下次仍对的证据** —— analyze 前先重跑枚举。
