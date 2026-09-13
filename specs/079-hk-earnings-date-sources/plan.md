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

在 `marketdata` 内新建一层「财报日期」：可插拔来源（富途财报日历 / 交易所公告）各自产出**带口径的观测**，纯函数合并成「一个公布日 + 取值口径 + 状态」的事件。港股由新维度 `hk_earnings_date` 每日跑，美股由现役 `earnings_event` 采集**顺带**落观测（零新增调用）。交易所公告复用现役 `announcement` 维度已采数据；会前通知正文走**异步文档流水线**：采集运行只写任务行并入队，独立队列 + 独立 worker 取 PDF，CPU 解析放进单个受限 worker 线程（超时 / 超内存可强制回收），临时失败指数退避重试，任务状态落库并经现有日报链告警（FR-025）。全部新表只归 `marketdata`，期权台读端一行不动。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| `pdfjs-dist@6.3.289`（Apache-2.0，服务端运行时依赖） | 从港交所会前通知 PDF 提取正文 | plan 期 PoC（2026-09-13，本机 scratchpad，不入仓）：45 份真实通知 + 1 份未发生，**带 CMap** 46/46 中文可读、日期集合与 poppler `pdftotext` 逐份一致、均 17 ms/份；**不带 CMap** 20/46 份中文整段丢失。`npm view pdfjs-dist@6.3.289` license = Apache-2.0、unpacked 34 MB（`cmaps/` 1.6 MB、`standard_fonts/` 816 KB）。 |
| （不引入）`node:worker_threads` 内置模块 | 解析线程隔离 | Node 内置；PoC 见 D7。 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 纯 server、单分支单 PR（§V；无 OpenAPI / mobile 变更）；TDD 红绿闭环 + 定向变异证能红（§II）；扁平 / 贫血 / 护城河零违背（§IV：新表全部归 `marketdata` 并登记 `MODEL_OWNERSHIP`，判据在 `*.rules.ts`，线程脚本是纯函数文件、零 DI；`optionsdesk` 零改动）；mockup-first 免（§I：无 UI）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 无新 endpoint。Testcontainers 真 DI IT：`marketdata-079.earnings-dates.it.spec.ts`（维度、合并、逾期、零回归、打标隔离）+ `marketdata-079.document-pipeline.it.spec.ts`（PG + Redis：入队去重、重试、永久失败、重试耗尽落库、清扫重投、增量合并）；`pdf-text-thread.it.spec.ts`（真 pdfjs + 真 worker 线程：CMap、超时回收、OOM 隔离）。真 vendor 契约由 `RUN_MARKETDATA_IT` 门控用例手动跑并贴输出。
- [x] **Mobile / Web**: N/A —— 零 UI、零契约变更（FR-022）。
- [x] **Evidence**: specify 期 prod 只读取证见 spec「取证」段；plan 期 PoC（PDF 解析 / worker 线程 / BullMQ 队列行为 / 线程 OOM 隔离）数字见 D7。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

| #   | Question | Answer |
| --- | --- | --- |
| Q1 | 长期维护信号 | Mozilla pdf.js 官方发行包；npm 最近发布 2026-08-29（`npm view pdfjs-dist time.modified`）。 |
| Q2 | 已装工具能否等价覆盖 | 否。仓内零 PDF / HTML 解析依赖。poppler `pdftotext` 需在 runner 镜像 `apk add`，而 runner 阶段只有 `apk upgrade`（`apps/server/Dockerfile:65`）。`unpdf@1.8.1` 内含同一 pdf.js 核心并带 `@napi-rs/canvas` peer 依赖，PoC 中与 `pdfjs-dist` 同进程加载出现 worker 版本冲突。线程池不引入 `piscina`：单线程 + 超时 + 重建用内置 `worker_threads` 即可（D7 PoC）。 |
| Q3 | 与现栈兼容 | Node 22 下用 `pdfjs-dist/legacy/build/pdf.mjs`（PoC 同版本 Node v22.22.3 跑通，含在 worker 线程内）；纯 JS 适配 `node:22-alpine`；server 由 SWC 转译不打包，`cmaps/` 与 `standard_fonts/` 随 `node_modules` 进镜像 —— impl 期容器冒烟核实（D7）。BullMQ 已在用 `5.78.0`（`apps/server/package.json:30`），`UnrecoverableError` 实测可导入。 |
| Q4 | LLM 覆盖度 | `getDocument` / `getTextContent` 稳定；v6 文档对象无 `destroy()`，改用 `loadingTask.destroy()`（PoC 实撞并修正）。 |
| Q5 | 解耦成本 | 只在线程脚本内使用，对外一个 `extractPdfText(bytes)` 消息协议，替换 < 1 天。 |
| Q6 | 风险面 | Apache-2.0；npm 国内可达；输入限定港交所域名白名单 + 5 MB 上限。历史漏洞 CVE-2024-4367（字体渲染可执行任意 JS，推断在 4.2.67 修复，**未验证**）—— 仅文本提取、`isEvalSupported: false`、跑在无 DI 的受限线程内；impl 期查 advisory 核实所选版本不受影响。 |

**Evidence**: PoC 脚本与结果留在本机 scratchpad；数字见 Dependencies 表与 D7。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] mono-native，无迁移面。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / 约束 | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0047 | §6 口径敏感维度「fail-or-flag，不静默切异口径备源」（`:136`）；「整链耗尽 fail loudly」（`:140`）；新增 / 改动 vendor adapter MUST 答 ADR-0067 D5 三问（`:56`） | accepted-as-is | 不用 FallbackChain（首个成功即返回会丢掉其余来源）；多源并存 + 口径标注即 fail-or-flag。富途财报日历（改）、港交所文档（新）两个 adapter 的约束档写「缺失语义」三问（D5 / D6）。 |
| ADR-0058 | `integrations/` 只收 ≥ 2 个 ctx 复用的 vendor adapter（`:33-34`） | accepted-as-is | PDF 获取与解析只有 `marketdata` 消费 ⇒ 留在 `marketdata/`。 |
| ADR-0066 | 业务日期跟交易所走；交易日必须查日历 | accepted-as-is | 公布日为交易所当地日期；「满 2 个交易日」查 `trading_day` 三态（D8）；业务日单市场取（D9）。 |
| ADR-0067 | D5：新 vendor adapter 必答缺失语义三问 | accepted-as-is | D5 / D6 各答一次。 |
| ADR-0035 | migration 命名 / `migration_refs` frontmatter | accepted-as-is | 一条 expand-only migration（D3 / D9）；impl 期写进 spec `migration_refs`。 |
| ADR-0062 | optionsdesk ↔ marketdata 边界 | accepted-as-is | 零新增跨 ctx 读；新表不给 optionsdesk 读口（FR-022）。 |
| ADR-0068 | 5 条 sunset（含「财报复测」） | accepted-as-is | 不触发：本片不改打标、召回、窗。 |

其余 ADR 的 Open Question 段与本片无交集（`rg -l "Open Question" docs/adr/` 逐份扫过）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 本片零新 `Guard` / `Interceptor` / `Filter` / `Pipe`，禁令全文有效。
- **MANDATORY INTEGRATION**: 维度执行、观测落库、事件合并、逾期判定、文档任务入队 / 重试 / 失败落库 / 清扫重投、美股零回归、港股打标隔离 MUST 在 Testcontainers 真 DI（`Test.createTestingModule` 真 boot，PG + Redis 真容器）下验证；worker 线程的超时回收与内存隔离 MUST 用真线程验证。MUST NOT 只靠 mock 证「重试了 / 回收了」。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 每条在 D12 有对应 `it()`，蓄意零覆盖的写明理由。
- **PROVE-IT-CAN-FAIL**: 每条新断言用定向变异证明会红（去掉 CMap 参数 / 去掉线程超时 / 把永久失败改成抛普通错误 / 把 `jobId` 去掉 / 让清扫不重投 / 让美股来源声明成「仅已公告」/ 让逾期不查日历），rebase 后重做。
- **观察面**：重试、去重、清扫这类事后收敛机制，最终状态可能与错误实现逐字节相同 ⇒ 断言落在**调用次数 / 尝试次数 / 入队次数**上（`docs/conventions/testing.md` §7.1）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。全部文件平铺在 `apps/server/src/marketdata/`；判据全在 `*.rules.ts`；use case / worker 直注 `PrismaService` 读写自己的表；线程脚本只含纯函数，🚫 不 import 任何 Nest 模块或 Prisma。

**D1 · 归属与边界**

- 全部落 `marketdata`（catalog Q1）。无新 bounded context、无 `integrations/`（ADR-0058）。
- `optionsdesk` **零改动**：它读财报日期只读 `earnings_event`（`get-legs.usecase.ts:733-739`，按标的过滤、不分市场）。本片**不往 `earnings_event` 写任何港股行**，也不给新表加任何 `CROSS-CONTEXT-READ` —— FR-022 的结构保证。
- 新表 5 张登记 `scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP`（marketdata 段 `:80-134`）。

**D2 · 来源抽象（port + 可插拔 adapter）**

- 新 port `earnings-date-source.port.ts`，token `EARNINGS_DATE_SOURCES` 注入**来源数组**。每个来源提供：`name`（落库用稳定名：`futu_calendar` / `hkex_announcement`）；`capabilities(market)`（前向日期语义 `announced_only` / `unconfirmed` / 无、是否提供确认信号、是否提供刊发事实；不支持该市场返回 null）；`collect({ market, businessDate, now, mode })`（`daily | backfill`，返回已归一观测；失败直接抛，由合并用例按来源隔离，FR-018）。
- 合并用例只认 port 契约，**不出现任何来源名分支**（FR-001）。IT 注入只提供刊发事实的假来源、再移除真来源，合并规则零改动（SC-010）。
- 注册：`marketdata.module.ts` 工厂按配置 `EARNINGS_DATE_SOURCES` 组装数组；`kind=mock` 时每个来源经既有 `collectionPort()`（`marketdata.module.ts:218-238`）得到拒绝壳。
- 美股富途观测**不走 `collect`**（D9 钩子），但映射函数与港股共用 `toSourceObservations(events, market)`（取值单点）。
- 🚨 来源 B 的 `collect` **只返回已完成解析的观测 + 业绩刊发事实**；尚未解析的会前通知由它负责登记为文档任务（D7），**不在 `collect` 内等待解析**。

**D3 · 数据模型（expand-only，一条 migration）**

新表设计意图（字段形状以 `schema.prisma` 为准）：

1. **`earnings_date_observation`**（来源观测，PIT）：唯一键 `(source, instrument_id, period_key)`。市场、报告类型、统一期末日（可空）、来源原文报告期、公布日（可空）、取值口径（`filed` / `explicit` / `structured` / `meeting`）、会议日、公布时刻、刊发日、凭据指针、首次 / 最近观测时刻、上一个公布日与变更时刻、刊发后回填的偏差天数（FR-019）。
2. **`earnings_date_event`**（合并后事件）：唯一键 `(instrument_id, period_key)`。状态（`confirmed` / `unconfirmed` / `conflict` / `notified_unparsed` / `overdue` / `published`）、公布日及口径、冲突候选日期、公布时刻、确认日期及口径（`announced` / `first_seen`）、参与来源、报告类型与期末日、逾期起算时刻、**`revision` 整数**（乐观并发，D8）。
3. **`earnings_date_event_log`**（事件流水，append-only）：状态迁移、取值变更、冲突产生 / 解除、逾期产生 / 解除（FR-013 / FR-014 / FR-019a）。
4. **`earnings_notice_task`**（文档任务台账 = 异步流水线的**真相源**）：唯一键 `(announcement_id, extractor_version)`。状态 `pending` / `parsed` / `unparsed`（文档本身不可解析，终态）/ `failed`（临时失败重试耗尽）；尝试次数、清扫轮次、最后错误与错误类别（`transient` / `permanent`）、入队 / 开始 / 结束时刻、解析耗时与文本长度；提取结果（会议日、明写公布日、公布句时区、期末日、报告类型）。同一份 PDF 同一提取器版本只处理一次；回填中断续跑跳过终态行（FR-020a）；提取规则升级改版本号即重跑。
5. **`earnings_meeting_lag`**（会议 → 刊发间隔）：唯一键 `(instrument_id, report_kind)`；最近一次间隔天数、来源期末日、观测时刻（FR-010）。

- **`period_key` 三种形态，列非空**（`.claude/rules/migration-rules.md:96-98`）：`P:<期末日>`（可跨来源对齐）/ `T:<来源>:<原文报告期>`（来源内稳定）/ `D:<来源>:<公布日>`（兜底）。只有 `P:` 参与跨来源合并（FR-015）。
- 🚫 **MUST NOT 复用 `earnings_event`**（D1 / FR-021）。
- 一条 migration：5 张表 + `hk_earnings_date` 维度 seed + 依赖边（D9）；命名 `<yyyymmdd_hhmm>_create_earnings_date_layer`（`lefthook.yml:133-160`）。

**D4 · 报告期统一 `earnings-period.rules.ts`（纯函数）**

- 交易所侧：从标题 / 正文取期末日与类型 ——「截至YYYY年M月D日止（三個月 / 六個月 / 九個月 / 年度）」「YYYY年M月底止季度」，数字写法同 D6；取到即 `P:`。
- 富途侧：原文 `period_text` 按**公司财年**记（阿里 `2027Q1` = 截至 2026-06-30，spec 取证）。财年结束月按序取：① 该公司交易所年度业绩公告标题期末日；② 历史配对（同公司富途观测与交易所刊发事实公布日相差 ≤ 1 天时反推）；③ 都没有 ⇒ `T:` 键，独立事件并计数（FR-015）。🚫 MUST NOT 默认 12 月结年。
- 美股：无第二来源，一律 `T:` 键。

**D5 · 来源 A：富途财报日历 `futu-calendar.source.ts`**

- 既有 adapter `futu-earnings-calendar.adapter.ts` 前缀表加 `hk ↔ HK`（`:56-63`）；锁定「hk 抛错」的 spec 用例（`futu-earnings-calendar.adapter.spec.ts:213-215`）翻转，commit message 写理由。
- `EarningsCalendarEvent`（`earnings-calendar.port.ts:86-115`）增加可空 `publicationTime`，映射原始行 `earnings_timestamp`（现被丢弃，`:127-136`）。美股 `earnings_event` 写入列不变。
- 港股窗口：日常 `[业务日 − 7, 业务日 + EARNINGS_FORWARD_HORIZON_DAYS]`；回填往前 730 天。经既有 `EARNINGS_CALENDAR_PORT`（专用 client、shim 限频档）。
- 能力：港股 = 前向「仅已公告」+ 历史口径 `structured`（`hk:00857` 三次记的是会议日，所以不是 `filed`）；美股 = 前向 `unconfirmed`。
- **缺失语义三问**：① 无下一次财报 = 不下发行，EPS 类 `N/A` 哨兵（既有 `numToString`）；② 「无行」分不清「没有财报 / 尚未公告」—— 登记不可判定，由能力声明承载；③ 数据反推（港股前向 364 天仅 54 行）⇒ 运行时不变量 = 每轮 notice 输出港股前向行数。

**D6 · 来源 B：交易所公告 `hkex-announcement.source.ts`**

- 读 `marketdata.announcement`（本 ctx 表，零新增理杏仁调用，FR-004）。日常窗口 `[业务日 − 7, 业务日]`，与现役 7 天回看一致（`20260801_2248_add_sync_dimension_delta_lookback/migration.sql:30-31`）。
- **业绩公告**（`types` 含 `fs_main`）→ 刊发事实观测（同步产出，无 PDF）：公布日 = 公告日期（`+08:00` 当地日期，`lixinger-announcement.adapter.ts:19-21`），口径 `filed`，报告期取自标题。
- **会前通知**：`earnings-notice.rules.ts` 标题分类（单一维护点，FR-005）—— 纳入 spec 取证全部写法，排除「決議」「董事名單」「委任」等；命中后在 `earnings_notice_task` 登记 `pending`（已有终态行则跳过），交给 D7。已 `parsed` 的任务结果在 `collect` 里转成观测：明写公布日 ⇒ `explicit`；只有会议日 ⇒ `meeting`；`unparsed` / `failed` ⇒ 事件态 `notified_unparsed`（FR-017）。
- **正文日期 `earnings-notice-date.rules.ts`**（纯函数，线程外调用）：按句切分；「公佈 / 公布 / 發佈 / 刊發」+「業績 / 盈利」句取明写公布日，「舉行 / 召開」+「會議」句取会议日；另要求正文出现业绩 / 盈利审批字样作第二道闸；阿拉伯数字、中文数字、缺「日」字；时区只认**同一句**内标注 —— 当地或未标注 ⇒ 交易所当地日期；标注他时区且无时刻 ⇒ `unparsed`，🚫 不猜（FR-006）。电话会句不参与。
- **缺失语义三问**：① 公告不存在 = 不下发行；正文日期缺失 = 无文本层或写法未覆盖；② 「无通知」分不清「未发 / 漏采」—— 由 FR-019a 逾期兜底；③ 45 份实测归纳 ⇒ 运行时不变量 = D10 提取失败率与积压 notice。

**D7 · 正文获取与解析：异步文档流水线（FR-025）**

**为什么必须异步 + 线程隔离（依据）**

- 部署形态：API、全部 BullMQ worker、定时任务**同一个 Node 进程**（`docker-compose.tight.yml:157-158`；入口 `node dist/main.js`），容器 `mem_limit: 640m`、`--max-old-space-size=448`（`:120` / `:162`），2026-09-05 出过整机内存耗尽（`:106-117`）。
- 主线程解析**无法中止、无法限内存**：PoC 45 份通知在主线程解析，单份中位 15 ms、最大 118 ms，事件循环最大延迟 22 ms —— 常规通知不重，但遇到畸形 / 超大 PDF 时耗时与内存不可预期，一旦卡住或暴涨会拖垮同进程的 API 与全部采集 worker。
- 失败可见性：BullMQ 重试耗尽只写 `logger.error`（`marketdata-sync.worker.ts:139,169`），容器日志无接收端（issue #209）；唯一能叫到人的链路是「状态落库 → 09:00 日报读 `sync_run` → 飞书」（`ops/jobs/marketdata-sync-report.sh:146-158`）。⇒ 任务状态 MUST 落库，告警 MUST 走采集运行记录。
- 业内：Node 官方建议 CPU 密集任务放到专用 worker 池、不压在事件循环（[Don't Block the Event Loop](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)）；文档处理流水线普遍「入队即返回 + 后台 worker + 临时失败退避重试 + 永久失败隔离人工复核 + 文档 ID 加版本做幂等键」（[Retry and dead letter](https://theneuralbase.com/document-ai/learn/beginner/retry-and-dead-letter/)）；BullMQ 官方提供 `attempts` + 指数退避（[Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)）、`UnrecoverableError` 跳过重试（[Stop retrying jobs](https://docs.bullmq.io/patterns/stop-retrying-jobs)）、失锁任务回收（[Stalled Jobs](https://docs.bullmq.io/guide/workers/stalled-jobs)），但**没有任务级超时**（[discussion #1378](https://github.com/taskforcesh/bullmq/discussions/1378)）⇒ 卡死必须由我们自己的线程超时回收。

**plan 期 PoC（2026-09-13，本机 Node v22.22.3 + 本机 Redis db 15，队列名带 `poc079` 前缀，跑完清空）**

| 验证点 | 结果 |
| --- | --- |
| pdfjs + CMap 在 worker 线程内解析 | 46/46 中文可读；线程堆峰值 65 MB；主线程事件循环最大延迟 6 ms |
| 单份超时 + `terminate()` + 重建 | 2 s 超时触发，线程退出，新线程随即正常解析 |
| 线程堆上限（`resourceLimits.maxOldGenerationSizeMb: 64`）内存打爆 | 仅该线程以 `ERR_WORKER_OUT_OF_MEMORY` 终止，主进程存活（RSS 49 MB） |
| 传递 PDF 字节用 `transferList` | 零拷贝（发送方 buffer 长度变 0），128 MB 上限的新线程正常解析 |
| BullMQ `jobId` 去重 | 同 `jobId` 入队 2 次，只存在 1 个任务（6 次入队 → 5 个任务） |
| 临时失败 + 指数退避 | 失败 2 次后第 3 次成功；配置 200 / 400 ms，实测间隔 1514 / 1836 ms（延迟任务调度粒度约秒级） |
| `UnrecoverableError` | 只尝试 1 次即进失败集，不重试 |
| 解析卡死（线程超时抛错） | 重试到上限 3 次后进失败集；`failed` 事件只在最终失败时触发 |
| 任务执行中进程崩溃（子进程 exit 137） | 失锁后被另一个 worker 接手完成（`stalledCounter` = 1） |
| 全程主线程事件循环 | 最大延迟 7 ms |

**分层与数据流**

1. **生产者**（`hk_earnings_date` 维度的日常 / 回填运行）：分类会前通知 → `earnings_notice_task` 以唯一键插入 `pending`（已存在即跳过）→ `addBulk` 入队。`jobId = hkex-notice:<announcement_id>:v<extractor_version>`（仓内现无 `jobId` 用法，本片首用；PoC 证去重）。**运行不等待解析**，只合并已完成的观测。
2. **独立队列 `marketdata-document` + `HkexDocumentWorker`**：手写 `Queue` / `Worker`，与现有 4 个队列同形（`marketdata-sync.queue.ts` / `marketdata-sync.worker.ts`）；复用 `MARKETDATA_QUEUE_REDIS` 连接（`marketdata-queue-connection.ts:6`）；`MARKETDATA_WORKER_DISABLED` 时不启动（同 `marketdata-sync.worker.ts:119`，CLI 进程据此不消费）；🚫 不挂到 `marketdata-sync` 的 default / futu lane —— 文档积压 MUST NOT 阻塞维度采集，反之亦然。并发 **1**（640 MB 容器内存预算）。
3. **处理器（主线程，持 DI）**：读任务行 → 非 `pending` 或版本不符 ⇒ 直接完成（幂等）→ 经 `HKEX_DOCUMENT_PORT` 取 PDF（I/O，不占 CPU）→ 交给 `PdfTextThread` 解析 → 调 `earnings-notice-date.rules.ts` → **同一事务**写任务行终态 + 写观测 → 事务外触发该 `(instrument, period_key)` 的增量合并（D8）。
4. **`PdfTextThread`**（`pdf-text.thread.ts` 纯函数线程脚本 + `pdf-text-thread.pool.ts` 主线程侧管理器）：单个常驻 worker 线程；`resourceLimits.maxOldGenerationSizeMb` **96**（PoC 堆峰值 65 MB + 余量；上限取值见下方内存预算）；PDF 字节用 `transferList` 传入；单份超时 **30 s**；超时 / `ERR_WORKER_OUT_OF_MEMORY` / 线程异常退出 ⇒ `terminate()` 并重建，本次抛 `DocumentExtractTimeoutError` / `DocumentExtractCrashedError`。线程内 🚨 MUST 传 `cMapUrl` + `cMapPacked: true` + `standardFontDataUrl`（路径由 `require.resolve('pdfjs-dist/package.json')` 求得）、`isEvalSupported: false`、`disableFontFace: true`、`useSystemFonts: false`，`finally` 里 `loadingTask.destroy()`。🚫 MUST NOT 安装 `unpdf`（worker 版本冲突）。
5. **HTTP**：`VendorHttpClient` 新增二进制读取方法（`arrayBuffer`；`FetchResponseLike` 补字段，`vendor-http-client.ts:106-118`），重试 / 熔断 / 超时语义不变；新约束档 `hkexnews.constraint-profile.ts`：1 次 / 秒、40 次 / 分（**推断的礼貌值，未找到官方限额**）、超时 30 s、客户端内重试 3 次。`HKEX_DOCUMENT_PORT` adapter：**域名白名单**只放行 `https://www1.hkexnews.hk/`（链接来自供应方数据，防 SSRF）；响应 > 5 MB 判永久失败。

**失败分类与重试**

| 类别 | 例子 | 处置 |
| --- | --- | --- |
| 临时 | 网络错误、5xx、429（客户端内重试已耗尽）、线程超时、线程 OOM / 崩溃 | 抛普通错误 ⇒ BullMQ `attempts: 4`、`backoff: { type: 'exponential', delay: 300_000 }`（5 / 10 / 20 分钟）；最终失败由 `failed` 监听把任务行写成 `failed` + 最后错误 |
| 永久（文档本身） | 非港交所域名、非 PDF、超 5 MB、无文本层、正文找不到日期、标注他时区无时刻 | 任务行写 `unparsed` + 原因，**正常完成任务**（这是业务结局不是任务故障，不进 BullMQ 失败集）；事件态 `notified_unparsed` |
| 不变式破坏 | 任务行不存在 / 版本不符 | 直接完成（幂等），计数 |

- 线程 OOM 视为临时：同一份文档连续 4 次 OOM 会以 `failed` 落库并告警，由人判断是否提升线程上限。
- **失锁回收**：`lockDuration: 120_000`、`maxStalledCount: 1`。🚨 与 `marketdata-sync` worker 的 `maxStalledCount: 0`（`marketdata-sync.worker.ts:79`，起因 09-05 事故里失锁重投）**蓄意不同**：文档任务靠任务行状态机幂等、单份开销小，重跑无副作用；PoC 证进程崩溃后可被接手。CPU 解析在线程内，主线程续锁不受影响（PoC 事件循环最大延迟 7 ms）。
- **优雅关停**：`onModuleDestroy` 里 `closeWithTimeout(worker)`（`close-with-timeout.ts:25`）后 `terminate()` 解析线程；Redis 连接沿用 `onApplicationShutdown` 顺序（`queue-shutdown-order.it.spec.ts` 回归面）。

**台账清扫（BullMQ 只是搬运工，任务行才是真相源）**

`hk_earnings_date` 每次日常运行在合并前清扫一次：

- `pending` 且入队超过 6 小时 ⇒ 重新入队（`jobId` 去重保证不会重复执行；覆盖 Redis 丢任务、部署时 `failed` 监听没写成的情况）。
- `failed` 且距上次尝试 ≥ 24 小时、清扫轮次 < 3 ⇒ 重置为 `pending` 并重新入队（港交所短时不可用时次日自愈）；轮次用完保持 `failed`。
- 清扫结果进 findings（D10）。

**内存预算（风险，上线前闸门）**

- 主进程 V8 老生代上限 448 MB + 线程上限 96 MB + 新生代 / 原生内存 已接近 640 MB 容器上限（推断，未实测）；而 compose 注释写明采集轮内存峰值本就未实测（`docker-compose.tight.yml:118` / `:161`）。
- ⇒ impl 期立一条 `[Ops]` task：用生产镜像 + 生产 compose 限额，在回填量级（数千份通知）下跑文档 worker，`docker stats` 记录 RSS 峰值；超过 560 MB 则先下调线程上限或把文档 worker 与夜间采集错峰，**不达标不开回填**。
- 并发恒为 1、线程恒为 1；🚫 MUST NOT 为了提速把并发调大。

**D8 · 合并 `earnings-date-merge.rules.ts`（纯函数）+ `sync-earnings-dates.usecase.ts`**

- 纯函数输入：某 `(instrument, period_key)` 全部观测、来源能力、间隔、公布日之后已过交易日数（或「日历不可判」）。输出：事件字段、流水、findings。零 I/O。
- 规则：
  - **取值**（FR-009 / FR-010）：`filed` > `explicit` > `structured` > `meeting`（会议日 + 间隔，无历史按 0）。
  - **可解释差异**（FR-014）：仅近似口径、差 ≥ 2 天，且结构化日期 = 通知会议日、会议日推定 = 会议日 + 间隔 ⇒ 取推定值，写流水不发冲突。
  - **冲突**（FR-014）：精确口径间任何不一致；或近似口径差 ≥ 2 天且不可解释 ⇒ `conflict`。近似差 1 天 ⇒ 优先级取值、写流水。
  - **确认**（FR-011 / FR-012 / FR-021）：有「仅已公告」来源观测或交易所观测 ⇒ `confirmed`；只有 `unconfirmed` 来源 ⇒ `unconfirmed`，🚫 永不升级。确认日期 = 通知 / 公告刊发日最小值（`announced`），否则取「仅已公告」来源首次观测的交易所当地日期（`first_seen`）。文档异步解析**不影响**确认日期（取刊发日，与解析完成时刻无关）。
  - **已通知未解析**（FR-017）：有会前通知任务但 `unparsed` / `failed` ⇒ `notified_unparsed`；若他源有日期则以他源确认，确认日期仍取通知刊发日。任务仍 `pending` 时不判未解析（异步进行中）。
  - **刊发覆盖**（FR-019）：出现 `filed` ⇒ `published`，回填偏差；有会议日时更新 `earnings_meeting_lag`。
  - **逾期**（FR-019a）：非 `published` 且公布日之后满 2 个交易日 ⇒ `overdue`。交易日数用 `trading_day` 三态计数（`trading-day.rules.ts:91` 判据）；区间含 `unknown` ⇒ 不判，发 `unjudged`。`TradingCalendarPort`（`trading-calendar.port.ts:23-70`）新增「区间交易日数」方法，写法照 `previousTradingDay` 覆盖闸（`db-trading-calendar.adapter.ts:102-121`）。
- **两个触发点**：日常运行（全量重算当天有观测变化的事件 + 逾期扫描）；文档 worker 完成一份后的**增量合并**（只算该事件）。二者可能同时写同一事件 ⇒ 事件行 `revision` 乐观并发：读观测与事件 → 计算 → `updateMany where { id, revision }` → 命中 0 行则重读重算，最多 3 次（`docs/conventions/server-impl-playbook.md` 条件 UPDATE + affected-count）；🚫 不用 `SELECT … FOR UPDATE`。
- 每个事件一个事务（观测 upsert → 事件条件更新 → 流水 insert）；🚫 HTTP / 线程解析一律在事务外。

**D9 · 编排：港股维度 + 美股钩子 + 回填**

- **新维度 `hk_earnings_date`**：`{hk}`、`queue_lane='futu'`（唯一走共享限频的是富途调用；`vendor` 列只是标注，`market-routed-eod-bar.adapter.ts:19`）、cron `0 30 23 * * *`（`Asia/Shanghai`，在 `announcement` 22:00 之后）、asOf `calendar-day`、`next_fire_at` 留 NULL（`sync-tick-driver.ts:324-333`）。依赖边 `universe → hk_earnings_date`、`announcement → hk_earnings_date` 均 soft。非交易日由 tick 交易日闸跳过（`sync-tick-driver.ts:245-254`）。
- 运行步骤：① 台账清扫（D7）② 各来源 `collect`（来源 B 顺带登记新文档任务并入队）③ 合并 + 逾期扫描 ④ findings。**不等待文档解析**；当晚解析完成的通知由 worker 增量合并，未完成的由次日运行兜底。
- **注册触点**（073 同形，commit `5790a777`）：`DIMENSION_KEYS`（`dimension-executor.ts:187`）；asOf 表（`sync-asof.rules.ts:65-105`）；executor 注册与构造器尾部默认值（仿 `earnings_event` 非 factExecutor 写法 `:1057-1062`）；**不**进锚作用域表，并在 `anchor-scoped-dimensions.rules.spec.ts` 加反向断言；拓扑守卫 `dimension-executor.spec.ts:4521-4630`；写死维度清单的 IT（`marketdata.schema-016`、`backfill-cli`、`tick-driver`、`adjustment-factor`、`flow-orchestration`、`tier-night-e2e`、`night-e2e-019`、`marketdata-066.hk-dimension-seed`、`sync-schema-gate`、`test-dimension-registration`）；`ops/jobs/marketdata-table-health.sql` 与 `marketdata-sync-report.sql` 纳入新维度。
- 🚨 **不把 `hk` 加进 `earnings_event` 的 scope**：跨时区 scope 在 `exchangeCalendarDateForScope` 直接抛（`session-clock.ts:163-172`）。
- **美股钩子**（FR-021，零新增调用）：`SyncEarningsEventUseCase` 构造器尾部加可选观测记录器（默认空实现，照 `dimension-executor.ts:853` 默认值写法），在既有写入完成后（`sync-earnings-event.usecase.ts:245` 之后、`return` 之前）用 `observed` 调用一次。约束：① 包 `try/catch`，失败只 `logger.warn`，🚫 不改 `stats` / `findings` / `written`、不让异常冒出 `run()`（否则 `sync_run` 与重试行为改变，`dimension-executor.ts:1160-1163`）；② 两处提前 return（`:218` / `:221`）不调用；③ 429 顺延时部分数据照样落；④ 既有 Small spec 的 Prisma 替身不含新表（`sync-earnings-event.usecase.spec.ts:131-146`），默认空记录器保证不受影响。美股不涉及文档流水线。
- **回填**（FR-020a）：经既有回填 CLI（`marketdata-trigger.cli.ts`）以 `mode=backfill` 跑 `hk_earnings_date`：富途 730 天窗；交易所侧两年业绩公告（零 PDF）+ 每家公司每类报告最近 1 次会前通知**登记为文档任务**（CLI 进程只入队，不消费，`MARKETDATA_WORKER_DISABLED=1`，`marketdata-trigger.cli.ts:330`）；由应用进程内的文档 worker 按限频慢慢消化，任务台账天然支持中断续跑。量级约 6–8 千份（推断）；按 1 份 / 秒约 2–3 小时（推断）。🚨 prod 执行属于写操作，命令与参数先交维护者确认；执行前 D7 内存闸门必须通过。

**D10 · findings 与告警（FR-023 / FR-025）**

沿用 `SyncRunStats`（`sync-run.recorder.ts:29-82`）写在 `hk_earnings_date` 运行记录上，日报经 `marketdata-sync-report.sql:111-138` 按 `step` 聚合 → 09:00 飞书：

| step | kind | 触发 |
| --- | --- | --- |
| `earnings_date_conflict` | notice | 新进入 `conflict`（含候选日期） |
| `earnings_date_overdue` | notice | 新进入 `overdue` |
| `earnings_date_source` | failure | 某来源 `collect` 抛错（含来源名） |
| `earnings_date_calendar_unknown` | unjudged | 逾期判定区间日历不可判 |
| `earnings_date_unaligned` | notice | 新增 `T:` / `D:` 键港股观测数 > 0 |
| `earnings_notice_scan` | notice | 每轮：扫描公告数、会前通知数、排除数、新登记任务数 |
| `earnings_notice_unparsed` | notice | 自上一轮以来新增 `unparsed`（含公告链接与原因） |
| `earnings_notice_failed` | failure | 自上一轮以来新增 `failed`（重试耗尽，含最后错误） |
| `earnings_notice_backlog` | notice | 最老 `pending` 超过 24 小时（worker 停摆 / 积压），含积压数 |
| `earnings_notice_requeued` | notice | 本轮清扫重投数（区分「pending 超时」与「failed 次日重试」） |
| `earnings_notice_extraction_degraded` | notice | 过去 24 小时 `unparsed + failed` / 终态总数 > `NOTICE_EXTRACTION_DEGRADED_RATIO`（起手 0.2，单点常量） |

- 文档 worker 自身的 `failed` 监听只写任务行 + `logger.error`，**不直接发告警**（容器日志无接收端，#209）；人能看到的一律经上表进日报。
- 美股钩子失败不进 findings（D9）。

**D11 · 配置**

- 新增非密 env `EARNINGS_DATE_SOURCES`（默认 `futu_calendar,hkex_announcement`），按 `config-add` 流程落 `marketdata.config.ts`（`:13-33` / `:60-70`）+ `.env.example` + `.env.production` + `docker-compose.tight.yml`，收尾 `check-env-sync`。
- 文档 worker 的并发（1）、线程堆上限、单份超时、重试次数与退避、清扫阈值均为代码内具名常量，🚫 不做成 env（避免运维误调并发把内存打爆）。
- 港交所无凭据；域名白名单为代码常量。

**D12 · 验证与测试分层（`state_branches` 落点）**

| # | branch（spec `state_branches` 顺序） | 落点 |
| --- | --- | --- |
| 1 | 正文明写公布日 → 按句内时区换算 | `earnings-notice-date.rules.spec.ts`（携程 / 网易 / 阿里原句字符串；未标注；他时区无时刻 → unparsed） |
| 2 | 只有结构化日历 → `structured`、确认口径 `first_seen` | `earnings-date-merge.rules.spec.ts` + 079 IT |
| 3 | 只有会议日 → 会议日 + 最近间隔 | merge spec（间隔 0 / 2 / 无历史）+ 079 IT（`hk:00857` 形态） |
| 4 | 多口径并存按优先级 | merge spec |
| 5 | 精确口径不一致 → 冲突 + 告警 | merge spec + 079 IT |
| 6 | 精确 vs 近似 → 取精确、留痕不告警 | merge spec + 079 IT |
| 7 | 近似差 1 天 → 优先级取值 | merge spec |
| 8 | 近似 ≥ 2 天可解释 → 取推定、不告警 | merge spec + 079 IT |
| 9 | 近似 ≥ 2 天不可解释 → 冲突 | merge spec |
| 10 | 冲突解除留痕 | 079 IT（两轮） |
| 11 | 确认时刻取最早刊发日 / 首次观测 | merge spec + 079 IT |
| 12 | 通知日期未解析 → 显式态 + 告警，有他源则以他源确认 | document-pipeline IT（假文档 port 返无文本层 PDF → `unparsed` → 下一轮 `notified_unparsed` + finding） |
| 13 | 非会前通知不当确认信号 | `earnings-notice.rules.spec.ts` |
| 14 | 刊发覆盖 + 偏差统计 + 间隔更新 | merge spec + 079 IT |
| 15 | 满 2 个交易日未刊发 → 逾期；刊发后解除 | 079 IT（种 `trading_day`，含假日与 `unknown` 臂） |
| 16 | 改期 → 留痕重判 | 079 IT |
| 17 | 来源失败隔离 | 079 IT |
| 18 | 报告期无法对齐 → 独立事件并计数 | `earnings-period.rules.spec.ts` + 079 IT |
| 19 | 标的不在主表 → 跳过计数 | 079 IT |
| 20 | 上线回填：最近 1 次通知 → 初始间隔；中断续跑不重复 | document-pipeline IT（回填登记任务 → worker 处理一半停止 → 再启动：终态行不再取 PDF，假文档 port 调用计数） |
| 21 | 美股进层 `unconfirmed`；现役逐字节不变 | `sync-earnings-event.usecase.spec.ts`（记录器抛错时 `stats` / findings / 调用数不变）+ `optionsdesk-047.earnings-pit.it.spec.ts` 加臂（`earnings_event` 行与 `sync_run` 与基线逐字节相同，新表美股事件全 `unconfirmed`） |
| 22 | 港股打标读不到本片产出 | 079 IT 调期权台既有取腿用例：新表有 `confirmed` 港股事件，收租腿仍「无日期」 |
| 23 | 文档解析异步解耦：采集运行不等待；单份失败不阻断他份 | document-pipeline IT（维度运行结束时任务仍 `pending`；一份永久失败、另一份照常 `parsed`） |
| 24 | 临时失败退避重试 / 永久失败不重试 / 重试耗尽落库告警 / 清扫重投 | document-pipeline IT（按**尝试次数与入队次数**断言，testing.md §7.1）+ 079 IT（`earnings_notice_failed` / `backlog` / `requeued` findings） |

其余测试面：

- **`pdf-text-thread.it.spec.ts`**（Medium：真 worker 线程 + 入仓 fixture，1 份港交所公开通知 PDF）：带 CMap 中文可读、日期可取；**对照臂**不带 CMap 中文丢失；**超时臂**（测试用线程脚本死循环）超时后线程被回收、下一份正常；**内存臂**（测试用线程脚本打爆堆）以 `ERR_WORKER_OUT_OF_MEMORY` 终止、主进程继续、下一份正常。线程脚本路径可注入，仅供测试。
- **`marketdata-079.document-pipeline.it.spec.ts`**（Medium：PG + Redis，按 `apps/server/test/_support/isolated-db.ts` 头部表选 PG + Redis 入口）：同 `jobId` 重复入队只执行一次；临时失败 2 次后成功（尝试次数 = 3）；永久失败只执行 1 次且任务行 `unparsed`；重试耗尽任务行 `failed`；`pending` 超时清扫重投；`failed` 次日重试与轮次上限；worker 完成后事件增量合并；`revision` 冲突重试（两个合并交错写同一事件）；`MARKETDATA_WORKER_DISABLED` 下不消费。进程崩溃后失锁接手：结构性难以在 IT 内构造，由 plan 期 PoC 证明，测试断言 worker 配置 `maxStalledCount: 1` / `lockDuration` 取值，文件头写明 PoC 结果与复跑方式（testing.md §7.1 out-of-test 臂）。
- `vendor-http-client.spec.ts` 加二进制读取臂；港交所文档 adapter spec 加白名单与尺寸上限臂。
- 真 vendor（Large，`RUN_MARKETDATA_IT` 门控，默认 skip）：`marketdata.futu-shim.vendor.spec.ts` 加港股财报日历用例；新增 `marketdata.hkexnews.vendor.spec.ts`（取一份真实通知并在线程内提取）。impl 期手动跑并贴输出。
- **容器冒烟**（`[Ops]`）：生产镜像内 `cmaps/` 可读、线程内中文可提取；D7 内存闸门在同一 task 内完成。
- **SC-001 ~ SC-004 数据验收**：回填完成、文档积压清零后，在 prod 跑一次只读核对，结果回填 spec；tasks 期立独立 `[Ops]` task + issue + 到期日。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发 / 事务**：事件写入用 `revision` 条件更新 + 命中数判定（D8），🚫 不用 `FOR UPDATE`；HTTP 与线程解析在事务外；文档 worker 并发恒 1、线程恒 1。
- **线程隔离**：线程脚本只做 PDF → 文本，🚫 不在线程内做日期规则、不碰 DB、不 import Nest；主线程侧超时 / OOM / 退出一律 `terminate()` + 重建，🚫 不复用出过错的线程。
- **时间语义**：业务日一律 `exchangeCalendarDate(market, now)`，单市场；公布日是交易所当地日期；交易日数查日历三态；时区换算只用 `session-clock.ts` 工具（Rule A / B）。
- **安全**：港交所域名白名单、5 MB 上限、`isEvalSupported: false`；不触鉴权 / PII。
- **配额**：富途只多港股每日约 38 次日历调用（推断）；港交所走独立约束档；回填靠 worker 并发 1 + 约束档自然限速。
- **美股零回归绊线**：D9 钩子四条约束；`optionsdesk-047.earnings-pit.it.spec.ts` 基线对比臂先红后绿。
- **内存闸门**：D7 未通过前不在 prod 开回填。
- **守卫脚本**：`check-server-moat`（5 张新表）、`check-time-semantics`、`check-test-size`（线程与队列测试为 `.it.`；真 vendor 必门控）、`check-env-sync`。
- **构建产物**：线程脚本在 SWC 转译后的 `dist/` 中 MUST 能按路径加载（按仓内实际模块格式选 `new URL(…, import.meta.url)` 或 `path.join(__dirname, …)`，impl 期先查 `apps/server` 的模块格式再定，容器冒烟兜底）。
- **Markdown**：spec / tasks 中带下划线的标识符一律包反引号。

### 决策备选与既有事实核录

**备选否决**：

1. 港股行写进 `earnings_event` —— 否：期权台读端不分市场（`get-legs.usecase.ts:733-739`）。
2. 每个来源各建一个维度 —— 否：加减来源要改 migration 与拓扑，与 FR-001 相反。
3. 美股来源改读 `earnings_event` —— 否：无「最近观测时刻」，满足不了 FR-013。
4. poppler `pdftotext` —— 否：runner 无 `apk add` 先例（`Dockerfile:65`），二进制跨环境版本各异。
5. `unpdf` —— 否：同核心 + 原生 canvas peer，PoC 同进程冲突。
6. 套用 `FallbackChainAdapter` —— 否：首个成功即返回，做不了交叉验证（ADR-0047 §6）。
7. 富途报告期默认 12 月结年 —— 否（FR-015）。
8. 为财年结束月调理杏仁财报接口 —— 否：`financial_metric` 不存报告类型（`schema.prisma:466-480`，`lixinger-financials.adapter.ts:147-153`），标题 + 历史配对已够。
9. **在维度运行内同步取 PDF + 主线程解析** —— 否：单进程 640 MB 容器内无法中止卡死、无法限内存，一份畸形文档可拖垮 API 与全部采集；失败只进无人接收的日志（D7 依据）。
10. **BullMQ 沙箱处理器（`useWorkerThreads`）** —— 否：整个处理器进线程后拿不到 Nest DI（Prisma / HTTP 客户端 / 来源），且 BullMQ 无任务级超时，卡死无法由队列中止；我们只把纯 CPU 的解析放线程，I/O 与写库留主线程，超时由自己控制（PoC 证）。
11. **`piscina` 线程池** —— 否：并发恒 1，单线程 + 超时 + 重建用内置模块即可，不值得一个依赖。
12. **独立 worker 容器 / 进程** —— 暂否：生产 compose 只有 app 一个应用服务（`docker-compose.tight.yml:31,75,104,313`），2 GB 整机再起一个 Node 进程的内存代价更大（推断）；D7 内存闸门若不过，此项作为升级路径重新评估。
13. **只用 DB 任务表轮询、不用 BullMQ**（仿 `public.agent_queue_event` 的领取模式）—— 否：需要自写退避、失锁回收与调度；BullMQ 已在用且 PoC 证语义满足。任务表仍保留为真相源，BullMQ 只搬运。
14. **BullMQ 失败事件直接推飞书** —— 否：server 内无飞书通道，现有告警链是「落库 → 日报 → 飞书」（`marketdata-sync-report.sh`），不另开第二条。
15. 腾讯自选股数据 —— 否（spec Clarifications）。

**既有事实核录**（2026-09-13 plan 期逐项 grep / 子代理只读核查，行号锚消费点）：

- 期权台读端：`optionsdesk/get-legs.usecase.ts:727-740`。
- 财报采集：`marketdata/sync-earnings-event.usecase.ts`（`run()` `:203`、业务日 `:213`、取窗 `:216`、提前 return `:218` / `:221`、写入 `:235-244`、窗序列 `:133`、视野 `:86`、notice 写法 `:341-345` / `:521-525`）；注册 `dimension-executor.ts:1057-1062`、DI `marketdata.module.ts:618`；seed `20260804_1155_seed_option_chain_dimensions/migration.sql:73`。
- 富途财报 adapter：`futu-earnings-calendar.adapter.ts:56-63`、`:189-194`、`:127-136`；port `earnings-calendar.port.ts:86-115`；绑定 `marketdata.module.ts:388-392`。
- 公告维度：`dimension-executor.ts:1008-1010`、`:356-370`、`:2614-2664`；seed `20260715_1800_create_hk_classification_text_tables/migration.sql:74`；幂等键 `schema.prisma:914`；回看 7 天 `20260801_2248…/migration.sql:30-31`。
- 维度注册触点：`dimension-executor.ts:187`；`dimension-executor.spec.ts:4521-4776`；`sync-asof.rules.ts:65-105`；`anchor-scoped-dimensions.rules.ts:44-62`；`sync-tick-driver.ts:245-254` / `:324-333`；`session-clock.ts:163-172`。
- 日历：`trading-calendar.port.ts:23-70`；`db-trading-calendar.adapter.ts:102-121`；`trading-day.rules.ts:91`。
- 队列与进程：`marketdata-sync.queue.ts:42,45,62,295-303`（两条 lane、attempts = `retry_max`、指数退避）；`marketdata-sync.worker.ts:61`（`lockDuration` 600 s）、`:79`（`maxStalledCount` 0）、`:119`（`MARKETDATA_WORKER_DISABLED`）、`:129-131`（并发 1）、`:139,169`（`failed` 只写日志）；`marketdata-queue-connection.ts:6`；`close-with-timeout.ts:25`；`main.ts:115`；CLI 禁用 worker `marketdata-trigger.cli.ts:330`；仓内零 `worker_threads` / `piscina` / `useWorkerThreads` / 显式 `jobId`。
- 部署内存：`docker-compose.tight.yml:120`（`mem_limit: 640m`）、`:162`（`--max-old-space-size=448`）、`:106-118`（09-05 事故与「峰值未实测」注释）、`:157-158`（单进程）。
- 告警链：`ops/jobs/marketdata-sync-report.sh:146-158`（非零退出 → `nvy-run-reported` → 飞书）；`marketdata-sync-report.sql:111-138`；kinds `sync-run.recorder.ts:29-82`。
- 任务表先例：`alert.push_delivery`（`schema.prisma:1614-1628`，status / attempts / next_attempt_at / last_error + BullMQ 清扫）。
- HTTP 客户端：`vendor-http-client.ts:106-118`、`:246-268`；约束档 `vendor-constraint-profile.ts:10-44`；`collectionPort()` `marketdata.module.ts:218-238`。
- 护城河：`check-server-moat.ts:53-208`（marketdata `:80-134`）。
- migration：`.claude/rules/migration-rules.md:96-98`；`lefthook.yml:133-160`；`.github/workflows/pr-validation.yml:125-150`。
- 镜像：`apps/server/Dockerfile:3`、`:65`。
- BullMQ：`apps/server/package.json:30`（`^5.78.0`，安装 5.78.0）。

## Complexity Tracking

无违规，无需 justify。
