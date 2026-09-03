---
feature_id: 046-optionsdesk-detail-thermometer
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: 2026-08-02
updated_at: 2026-08-03
---

# Tasks: 046-optionsdesk-detail-thermometer（optionsdesk M2a — 标的详情上半 + 波动温度计）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Mockup**: [`design/handoff.md`](./design/handoff.md)（10 帧）｜ **Branch**: `046-optionsdesk-detail-thermometer`

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）
- 层级：`[Server]` / `[Server-IT]` / `[Shim]`（futu-shim Python）/ `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]`（跨层收口）
- **层级 → size 映射**（`docs/conventions/testing.md`）：`[Server]` 的 verify 落 **Small** `*.spec.ts`（`unit` project，零容器）· `[Server-IT]` = **Medium** `*.it.spec.ts`（`it` project + 共享 PG）· 真 vendor 探针 = **Large** `*.vendor.spec.ts`（默认 skip）· `[Mobile]` = Small（logic-only）· `[Mobile-E2E]` / `[Contract-Smoke]` = Medium（`apps/mobile/e2e/` 单一档、免后缀）
- **测试不独立成 task**（per `sdd.md`），绑在每个实现 task 的 `verify:` 里；**IT 例外**（跨多文件、单独成 task）
- 每 task = 30min–2h 单 commit 单元；`- [ ]` pending / `- [X]` done

## Path Conventions

| 面                         | 路径                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| server 业务（optionsdesk） | `apps/server/src/optionsdesk/`（扁平，无 domain/application/infrastructure） |
| server 采集（marketdata）  | `apps/server/src/marketdata/`                                                |
| schema / migration         | `apps/server/prisma/schema.prisma` · `apps/server/prisma/migrations/`        |
| server IT（Medium）        | `apps/server/test/integration/optionsdesk-046.*.it.spec.ts`                  |
| server 真 vendor（Large）  | **扩既有** `apps/server/test/integration/marketdata.futu-shim.vendor.spec.ts`（同一 shim，勿新建） |
| mobile e2e（Medium）       | `apps/mobile/e2e/optionsdesk-detail-thermometer.spec.ts`（feature-slug，**无编号前缀**，045 先例 `optionsdesk-anchors-radar.spec.ts`） |
| markets-OFF 断言           | **只能落** `apps/mobile/e2e/markets-feature-gate.spec.ts`（`playwright.markets-off.config.ts` 的 `testMatch` 锁死单文件） |
| contract-smoke（Medium）   | `apps/mobile/e2e/contract-smoke/optionsdesk-detail-thermometer.contract.ts` + **在 `run.ts` import 注册** |
| futu-shim（自有 pytest）   | `services/futu-shim/src/futu_shim/` · `services/futu-shim/tests/`（不在 size 分类学扫描面内） |
| mobile                     | `apps/mobile/src/optionsdesk/`（**全 Small 单一档，目录即坐标、免后缀**）    |

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **指数维度 MUST NOT 挂锚闸**（FR-027, plan D1）——`us_index_daily` 的工作集是 VIX/VVIX 两个固定代码，**不查 `Instrument`、不走 `loadActiveInstruments`**。挂了闸零锚时会静默不跑，与「表盘不依赖锚」矛盾。⚠️ 复用 `factExecutor` 那条「先取工作集再逐票」的路径就是踩这个坑。
2. **optionsdesk 禁碰复权**（plan D2）——`adjusted-bars.rules.ts` 在 optionsdesk 的 ESLint disallow 里（`67a7e34a`，ADR-0053 绊线）。价格序列由**客户端**直接调 marketdata bars 端点。想在 server 端拼序列 = lint 红，**别改 allowlist 绕过**。
3. **shim 限频按各自官方值配**（plan D7）——`overview` 60/30s、`his_volatility` 60/30s。⚠️ **别套全局最严兜底值**：`/kline` 当初就是这么配的（且逐页计数），直接导致 08-01 回填事故（p3b E38）。
4. **CBOE 只走官方历史 CSV**（plan D6, FR-025）——盘中报价端点 `delayed_quotes/quotes/*.json` **在 ToS 禁令面**（p3b E1/E24）。impl 期任何「顺手加个实时值」的念头停在这里。
5. **IV 标注禁写「IV30d」**（FR-035）——一律「富途标的聚合 IV」。p3 §9-1 的口径采纳声明明写该序列**非严格 30d-ATM 锁定**。本 spec clarify 期已因此订正过一次 drift，别改回去。
6. **新维度上线前先实打 shim 端点**（plan D7）——`us_equity_bar` 首跑 7/7 全 404，真因是 shim 被从不含 `/kline` 的分支部署覆盖。`/healthz` 绿 ≠ 端点在。
7. **VVIX 只有 CLOSE**（FR-025）——其余 OHLC 列 **nullable，禁填 0**。
8. **`--nvy-text-subtle` 在白底是 2.85:1**（mockup handoff 实测）——降级状态字（「不可用」「分位不可算」）**禁用最淡档**，用 `--nvy-text-muted` 或 `--nvy-text`。
9. **进度条类组件禁给外层加 `overflow:hidden`**（mockup 踩过）——位置标记比槽高，会被整个裁掉且不报错。裁剪下沉到内层。
10. **本片三处「选错不会被机器拦」的测试决定**（通用分类学不复述 —— 改任何测试文件时 `.claude/rules/test-taxonomy-trigger.md` 会**逐字自动加载**三档后缀 / 决定顺序 / 七条不变量；那七条**选错会红**，不属 Guardrail）——① **PG 入口**：T005 用 `setupEmptyDb()`（它自己跑 `migrate deploy` 验产物），T011/T014/T016/T018 用 `setupIsolatedDb()`；**选错既不红也不慢，只是把被测对象抽掉**；② **真 vendor 复用既有文件与既有门** —— 扩 `marketdata.futu-shim.vendor.spec.ts` + `RUN_MARKETDATA_IT`，**别为同一个 shim 再造 flag / 再开文件**；③ **markets-OFF 断言只能落 `markets-feature-gate.spec.ts`**（见 Path Conventions）。
11. **档位系数禁字面量**（`check-optionsdesk-rule-constants.ts`，PR 门 `gate-checks` **无条件全扫**，#839 新增）——`apps/server/src/optionsdesk/` 下**除 `anchor.rules.ts` 外**任何 `.ts` 都不得出现 `0.8` / `0.6` / `1.2`（W / 四区间下界 / 上界·长持愿卖），**一律 `import` 常量**。本片 T015 / T017 正住在该目录且满屏 W=0.8V / 1.2V 语义 —— 抄字面量 = PR 红。这与 FR-003「派生值 MUST 复用 045 规则纯函数」是同一条纪律的机器版。
12. **IVP 阈值档取 25 / 70 / 90，不取 mockup 的刻度标签**（FR-036）——mockup 分段条段宽 25/45/20/10 ⇒ 边界 **25/70/90**，但同组刻度标签写的是 `0/50/90/100`，两者对不上（2026-08-02 analyze 扫出、user 拍板以段宽为准）。**照刻度写会让「提醒状态」整体偏移一整档，且不会红**；impl 时把刻度一并对齐到 25/70/90。

---

## Phase 1: 地基（schema + 维度注册 + 纯函数）🎯

- [X] T001 [Server] **三张新表 + migration**（FR-023/FR-025, plan D5）：`schema.prisma` 在 `marketdata` schema 下新增 ① **标的级 IV 日快照**（键 `(instrument_id, date)`，存 vendor 直读 iv / iv_rank / iv_percentile / 各档 hv）② **标的级 IV 历史序列**（键 `(instrument_id, date)`，存 iv / hv / 标的价，供自算与双算对表）③ **指数日线**（键 `(index_code, date)`，VIX 有 OHLC、**VVIX 只有 close ⇒ 其余列 nullable 禁填 0**）。三表 `@@schema("marketdata")` + `@@map` snake_case + **Decimal 禁 Float**；migration 走 `prisma migrate diff` 零 drift（顶部 `-- migration_refs: specs/046-optionsdesk-detail-thermometer`）；**`check-server-moat.ts` `MODEL_OWNERSHIP` 声明三表 → `marketdata`**（漏则 optionsdesk 一读就 `moat-unmapped` 硬拒）→ verify: `prisma validate` + `generate` + dev DB `migrate deploy` 无 drift + **幂等重 deploy** + `nx typecheck server` 绿 + `check-server-moat.ts` exit 0

- [X] T002 [Server] **两个维度 seed + `DIMENSION_KEYS` 注册**（FR-023/FR-025/FR-027, plan D1）：migration seed 两行 `SyncDimension`（样板 = `20260731_2230_seed_us_equity_bar_dimension`）—— `underlying_iv_daily`（`market_scope={us}`、cron 与 `us_equity_bar` 同档 `0 0 6 * * *` 北京 06:00 = 美股收盘后）+ `us_index_daily`（`{us}`、同档）；`dimension-executor.ts` 的 `DIMENSION_KEYS` 加两项。🚨 **`us_index_daily` 的 `market_scope` 只是元数据，其工作集不由它推导**（Guardrail 1）→ verify: `dimension-executor.spec.ts` 断言两个新 key 在册 + seed migration 幂等重跑 + `report.sh` 逐维解析不炸

- [X] T003 [P] [Server] **CBOE CSV 解析纯函数**（FR-025, plan D6）：`marketdata/cboe-index-csv.rules.ts` —— 解析 `DATE,OPEN,HIGH,LOW,CLOSE`（VIX）与 `DATE,VVIX`（VVIX）两种形态；**表头必须校验**（表头变了 = vendor 改格式，**报错而非把表头当数据**）；**非法行 / 日期解析失败跳过并计数**，计数随返回值上抛（禁静默丢）；日期 `MM/DD/YYYY` → `YYYY-MM-DD`。复杂度 O(n)。→ verify: `cboe-index-csv.rules.spec.ts`（Small，样板 = `src/optionsdesk/radar-cursor.spec.ts`）—— 两种表头各一条 happy path + **表头变更抛错** + 非法行被跳过且 `skipped` 计数正确 + 空文件 / 只有表头 / 尾部空行 + **VVIX 行只产出 close，其余 OHLC 为 `null` 不为 0**（FR-025）

- [X] T004 [P] [Server] **IVP 自算 + 双算差判定 + 分页窗口切分纯函数**（FR-024/FR-034, plan D4/D7）：`marketdata/underlying-iv.rules.ts` —— ① **IVP 分位自算**（给定 IV 序列与当前值求百分位；**窗口不足 252 交易日返回「不可算」而非 0**，复杂度 O(n log n) 排序主导）② **双算差三档判定**（≤2pp 静默 / 2–5pp WARN / >5pp 硬门，阈值落文件顶部具名常量，取 p3b §6.3 实测基线）③ **`his_volatility` 回填窗口切分**（总区间 → ≤364 天的窗口序列，**边界不重复计入、不漏日**）→ verify: `underlying-iv.rules.spec.ts`（Small，样板同上）—— 分位边界（最小/最大/中位）+ 窗口不足返「不可算」+ 三档判定的两个边界值（恰好 2pp / 恰好 5pp 的归属确定，不得两档都亮）+ 窗口切分对 3 年区间产出的窗口**首尾相接无缝无叠**、末窗不越界

- [X] T005 [Server-IT] **Phase 1 schema IT**（FR-023/FR-025）（共享 PG · **`setupEmptyDb()`** —— 本条自己跑 `migrate deploy` 并验证其产物，正是该入口的适用条件；**禁自起 Testcontainers**，Guardrail 10）：`migrate deploy` → 三表存在 + 三个唯一键生效（重复插入撞 P2002 = 幂等语义载体）+ **VVIX 行 OHLC 可为 null** + `check-server-moat.ts` 0 违规 + 两行 `SyncDimension` seed 在册。`apps/server/test/integration/optionsdesk-046.schema.it.spec.ts`。**样板 = `optionsdesk-045.schema.it.spec.ts`**（registry §测试样板「验 migrate 产物」变体）

---

## Phase 2: US3 采集 — 标的级 IV（P1）

- [X] T006 [Shim] **futu-shim 两个新端点 `/overview` + `/his-vol`**（FR-023/FR-024, plan D7）：`services/futu-shim/src/futu_shim/app.py` 加两个 route —— `/overview?codes=US.PEP,US.VICI`（`get_option_underlying_overview`，≤500 codes 批量）+ `/his-vol?code=US.PEP&start=&end=`（`get_option_underlying_his_volatility`）。🚨 **限频按各自官方值配 60 次/30s**（`ratelimit.py` 加两条 profile），**不套 `/kline` 那个最严兜底值**（Guardrail 3）；参数校验（缺 code / 跨度 >364 天 → 400，**不静默截断**）→ verify: `services/futu-shim/tests/test_app.py` 加 case —— 两端点 happy path（mock OpenD）+ 无 token 401 + 缺参 400 + **跨度 >364 天 400 而非截断** + 限频超额 429 + `/healthz` 仍不触发 OpenD

- [X] T007 [Server] **`UNDERLYING_IV_PORT` + futu-shim adapter**（FR-023, plan D7）：`marketdata/underlying-iv.port.ts`（capability-scoped，沿仓内 26 port 惯例）+ `futu-underlying-iv.adapter.ts` 调 shim 两端点；DI 注册进 `marketdata.module.ts`。vendor 错误映射走既有 `VendorConstraintProfile` 形态 → verify: `futu-underlying-iv.adapter.spec.ts`（mock fetch）—— 批量拆批（>500 codes 分批）+ vendor 4xx/5xx 映射 + 超时；**外加真 vendor 探针 —— 扩既有文件，禁新建**：`apps/server/test/integration/marketdata.futu-shim.vendor.spec.ts` 里**加两个 `describe.skipIf(!ENABLED)` 块**（`/overview` + `/his-vol`），**复用该文件既有的 `RUN_MARKETDATA_IT` + `FUTU_SHIM_URL` + `FUTU_SHIM_TOKEN` 门**（已在 `check-env-sync` ALLOWLIST ⇒ **无需登记新 env**；同一个 shim 再造一个 gate flag 就是给同一坐标二次赋义）。整文件保持 100% vendor 门控 ⇒ 后缀仍是 `.vendor.spec.ts`（不变量 3）。⚠️ 该 env **无任何 workflow 设置 = 恒 skip**，「测试全绿」对这块**不构成任何证据**，契约要么手工真调过要么就是没验过（testing.md §4 步 4 / 矩阵 T-4）。⚠️ 跑一次会拉起 OpenD ≈ 行情权从手机收走约 10 分钟，**别在美股盘中随手跑**；该 env-gated IT 内**记录 12 只锚单轮墙钟并断言 ≤5min**（**SC-005 的唯一有效载体** —— T011/T014 是 hermetic IT、vendor 被 mock，在那里计时测的是 mock 往返，与 5 分钟预算无关）

- [X] T008 [Server] **`underlying_iv_daily` 维度 executor**（FR-023/FR-026/FR-028/FR-029/FR-030/FR-031, plan D1）：`dimension-executor.ts` 加该维度 —— 走 `factExecutor` 路径（工作集 = `loadActiveInstruments`，**已含 `need_sync = true`** ⇒ 无锚不采、加第 13 只锚零代码自动纳入）；**业务日期按 A′**（`marketDateFor`，us 时区）；落库幂等 upsert；vendor 不可达 → 记失败 + 按「可重拉」等级告警（**不照抄期权链的当日必醒**，FR-030）→ verify: `dimension-executor.spec.ts` 加 case（⚠️ 该文件住 `src/` 且非 `.it.` ⇒ 在 `unit` project，**零容器是机器强制的硬不变量** —— 依据是 `.claude/rules/test-taxonomy-trigger.md` 的**七条不变量**，选错**会红**，**不属 Guardrail 面**）——**只放纯逻辑**：工作集构造只含开闸标的 + A′ 求值用 us 时区不是 `shanghaiToday`；**「失败不破坏已落历史」需真 DB ⇒ 归 T011 的 IT**，禁往这个 unit spec 里塞容器或共享 PG helper

- [X] T009 [Server] **`his_volatility` 回填 + 首次拉满 3 年**（FR-024, plan D7）：回填路径接 `marketdata-backfill.cli.ts`（沿 `us_equity_bar` 形态）；用 T004 的窗口切分按 ≤364 天分页；**首次上线拉满 vendor 上限（约 3 年）**——理由写进代码注释：`his_volatility` 的 3 年是**滑动窗**，今天不拉明年那段就永久没了 → verify: `marketdata-backfill.cli.spec.ts` 加 case —— 3 年区间产出的请求数与窗口边界正确 + 分页结果合并后**逐日无重无漏** + 额度估算不再复现 `us_equity_bar` 那次「报 350,760 实跑 7」的高估
  - 🚨 **订正（2026-09-03）**：T009 里「理由写进代码注释：3 年是滑动窗」那部分已按实测订正 ——底是固定数据纪元而非滑动窗，代码注释已改（见 `underlying-iv.rules.ts` 的 EVIDENCE）。任务本身的产出与验收不变。

- [X] T010 [Server] **IVP 双算对表 → 采集侧告警**（FR-034/FR-035, plan D4）：采集 `underlying_iv_daily` 时顺带由历史序列自算一次分位（T004 的纯函数），与 `overview` 直读值比对，按三档进告警面。🚨 **只进告警，不进 API 响应、不进 UI** —— 显示值恒为 `overview` 直读值（**FR-035 显示口径单源**）；**窗口不足时跳过对表且不告警**（缺窗口不是口径漂移，state_branch 已列）。存在理由写进注释：富途聚合规则未文档化，这是唯一能发现它改规则的信号 → verify: 单测覆盖三档 + 窗口不足跳过；**断言响应 DTO 里不含自算值**（防它顺着 DTO 漏进 UI）

- [X] T011 [Server-IT] **标的级 IV 采集 IT**（FR-023/FR-026/FR-029/FR-030/FR-031/FR-034）（共享 PG · **`setupIsolatedDb()`**）：塞真行 `Instrument`（部分开闸）+ `Anchor` → 跑一轮 → 断言 ① 请求只覆盖有锚标的（**非锚定标的请求数 = 0**，SC-006 的可验证判据）② 同日重跑幂等无重复行 ③ 新增一条锚后下一轮自动纳入（FR-031）④ vendor 不可达时记失败、已落历史不动、次日重跑补齐 ⑤ 双算差超阈进 WARN 名单。`apps/server/test/integration/optionsdesk-046.underlying-iv.it.spec.ts`。**样板 = `optionsdesk-045.anchor.it.spec.ts`**（直接 new 贫血 usecase 打真 `PrismaService`）

---

## Phase 3: US3 采集 — 指数（P1）

- [X] T012 [Server] **`US_INDEX_PORT` + CBOE CSV adapter**（FR-025/FR-033, plan D6）：`marketdata/us-index.port.ts` + `cboe-us-index.adapter.ts` —— **77 直连**拉两个官方历史 CSV（`--noproxy` 语义：不走代理），用 T003 的纯函数解析。🚨 **禁引 CSV 解析库**（plan § Dependencies）；🚨 **禁碰盘中报价端点**（Guardrail 4，注释里写明该端点在 ToS 禁令面 + 出处 p3b E1/E24）→ verify: `cboe-us-index.adapter.spec.ts`（mock fetch）—— 两个文件各自解析 + 非法行计数上抛 + HTTP 非 200 映射为 vendor 错误 + **断言代码里不出现 `delayed_quotes` 字样**（机械防线）

- [X] T013 [Server] **`us_index_daily` 维度 executor —— 不挂锚闸**（FR-027/FR-028/FR-029, plan D1）：`dimension-executor.ts` 加该维度。🚨 **不复用 `factExecutor`**（那条路径先 `loadActiveInstruments`）—— 工作集 = **VIX / VVIX 两个固定代码常量**，不查 `Instrument`、不挂 `need_sync`；形态更接近既有 **meta 维度**。业务日期仍按 A′；**全量文件 upsert**（覆盖式历史文件，无增量端点 ⇒ 幂等天然成立，`delta_lookback_days` 不适用，注释写明）→ verify: `dimension-executor.spec.ts` 加 case —— **零 `Instrument` / 零锚时该维度照常执行**（Guardrail 1 的机械断言）+ 不调用 `loadActiveInstruments`（spy 断言调用次数 0）—— 二者均为纯逻辑，留 `unit` project；**「同日重跑幂等」需真 DB ⇒ 归 T014 的 IT**（同 T008 的切分纪律；依据同为 taxonomy 七条不变量，非 Guardrail）

- [X] T014 [Server-IT] **指数采集 IT**（FR-025/FR-027/FR-029）（共享 PG · **`setupIsolatedDb()`**）：① **库里零锚零 `Instrument` 时跑一轮仍落数**（FR-027 的核心断言，也是与 FR-018 空态分支一致性的守门）② VVIX 行 close 有值、其余 OHLC 为 null ③ 同日重跑幂等 ④ 源不可达时记失败且历史不动 ⑤ 非法行被跳过且计数进 `SyncRun` 统计。`apps/server/test/integration/optionsdesk-046.us-index.it.spec.ts`（样板同 T011）

---

## Phase 4: US1 详情读端（P1）

- [X] T015 [Server] **详情读端 `GET /api/v1/optionsdesk/underlyings/{symbol}`**（FR-002/FR-003/FR-004/FR-005/FR-011/FR-012/FR-013/FR-014/FR-020/FR-032, plan D8）：`optionsdesk/get-underlying-detail.usecase.ts` + controller/DTO —— 读自己的 `Anchor`（**派生复用 045 的 `anchor.rules.ts`，禁重造**）+ **`// CROSS-CONTEXT-READ:`** 直查 marketdata 的 IV 日快照（Q7-B，禁 `@Inject()` marketdata use case）。返回锚卡字段 + 四区间边界 + IV 读数 + **各自 `asOf`**；无锚 → 明确的 404 语义（前端据此渲染「尚未建锚」而非报错页，FR-011）；IV 缺失 / 窗口不足 → 显式态而非空值（FR-014）→ verify: `get-underlying-detail.usecase.spec.ts` —— 锚在 + IV 在 / 锚在 + IV 缺 / 锚在 + IV 窗口不足 / **无锚** 四态 + 跨 ctx 读失败只降级不整体失败 + **DTO 不含双算自算值**（承接 T010）+ **`check-optionsdesk-rule-constants.ts` exit 0**（Guardrail 11：本文件住 `src/optionsdesk/`，W / 四区间 / 愿卖锚系数一律 `import` `anchor.rules.ts` 的常量，禁抄 `0.8`/`0.6`/`1.2`）

- [X] T016 [Server-IT] **详情读端 IT**（含 real-boot smoke）（共享 PG · **`setupIsolatedDb()`**；起 Nest 容器时用 **`narrowTestModule([...])`** 收窄 boot，别整 `AppModule`）：塞真行（us `Instrument` + `Anchor` + IV 日快照）→ 真 HTTP 打端点，断言 RFC 9457 ProblemDetail 形状 + traceId 端到端 + 四态各一条。`apps/server/test/integration/optionsdesk-046.detail.it.spec.ts`（样板同 T011）

---

## Phase 5: US2 温度计读端（P1）

- [X] T017 [Server] **温度计读端 `GET /api/v1/optionsdesk/thermometer`**（FR-015/FR-016/FR-017/FR-018/FR-032, plan D8；⚠️ **FR-019 不挂本条** —— 免责文案是纯 UI 呈现，server 端满足不了，验证落 T024）：`optionsdesk/get-thermometer.usecase.ts` + controller/DTO —— 读全部 `Anchor` + 跨 ctx 直查逐票 IV 日快照 + 指数日线最新一期。🚨 **VVIX/VIX 比在 server 算但带基准判定**：两侧 `asOf` **不同交易日则不计算**并返回显式标记（FR-016）—— 放前端等于每个消费方都要重新实现一次基准纪律；`excluded` 的锚**照常出现在列表并带标记**（045 语义）；指数不可得 → 显式不可用态，**禁 0 值**（FR-017）→ verify: `get-thermometer.usecase.spec.ts` —— 同基准算比值 / **不同基准不算并标注** / VVIX 缺 / VIX 缺 / 零锚（**表盘部分照常返回**）/ 列表含「分位不可算」与 `excluded` 行 + **`check-optionsdesk-rule-constants.ts` exit 0**（同 T015）

- [X] T018 [Server-IT] **温度计读端 IT**（含 real-boot smoke）（共享 PG · **`setupIsolatedDb()`** + **`narrowTestModule([...])`**）：真 HTTP 打端点 + 上述六态各一条 + **零锚时指数部分仍有数据**（与 T014 呼应，端到端确认 FR-027 的效果传到了 UI 契约层）。`apps/server/test/integration/optionsdesk-046.thermometer.it.spec.ts`（样板同 T011）

---

## Phase 6: 契约同步（Constitution §V 类型同步链）

- [X] T019 [Contract] **OpenAPI export + api-client regen**（Constitution §V）：`pnpm exec nx affected --target=generate` 跑通 server `export-openapi` → `packages/api-client` orval regen → mobile 类型可用。⚠️ **regen 必走 canonical `node dist/main.js`**（memory：`dump.mjs` 是漂移路径）；nullable 字段的 `@ApiProperty` 必须显式 `type:'string'`（否则 orval 生成 objectmap）→ verify: `apps/server/openapi.json` 含两个新端点 + `nx typecheck mobile` 绿 + `check-api-property-nullable.ts` exit 0 + **两个端点路径与 spec frontmatter `perf_budgets` 里的暂定值一致**（不一致则改 frontmatter 并重跑 `plan-compiler.ts`，把 plan 里的「暂定」注记作废）

---

## Phase 7: US1 / US2 mobile 消费（P1）

- [X] T020 [P] [Mobile] **窗口→粒度映射纯函数**（FR-008/FR-009, plan D3）：`apps/mobile/src/optionsdesk/window-granularity.rules.ts` —— `1Y=day / 3Y=week / 5Y=week / 10Y=month`，输出直接喂 bars 端点 `period` 参数；未知档位 **fail-closed**（不回落成 day 静默拉全量）。🚨 **禁在此实现任何抽稀 / LTTB**（FR-009）→ verify: `window-granularity.rules.spec.ts` —— 四档映射 + 未知档位抛错 + **断言模块内不 import 任何降采样库**（SC-007 机械防线）

- [X] T021 [Mobile] **标的详情屏（上半）**（FR-001/FR-002/FR-004/FR-005/FR-006/FR-007/FR-008/FR-010/FR-011/FR-012/FR-013/FR-014/FR-020/FR-035/FR-036, plan D2/D9）：`optionsdesk/underlying-detail-screen.tsx` + 子件 —— 自上而下**固定三块**（锚卡 → 个股温度计区块 → 区间时序）；**两端点并行合成**（optionsdesk 详情端点 + marketdata bars 端点，**各自 `asOf`、各自独立降级、禁整页失败**）；区间时序 = `react-native-svg` 折线 + 纯 `View` 四区间背景带（复用 045 `zone-band.tsx` 色带语义）；窗口 chip 行接 T020。🚨 Guardrail 8（降级字不用最淡档）+ 9（进度条外层禁 `overflow:hidden`）→ verify: `underlying-detail.rules.spec.ts`（vitest logic-only）—— 两端点四种成败组合的降级决策 + `asOf` 新鲜度分档 + 无锚态判定 + **三个「本片无数据源」字段的恒态**（plan D9）：① 仓位水位档恒为「未知 · 待接入」**禁 0** ② 未持股 ⇒ 愿卖锚行不出现 ③ 提醒状态按 **FR-036 边界 25/70/90** 三档分类、且 IVP「分位不可算」时**不出徽标** + **断言 UI 文案与 DTO 字段名中不出现 `iv30d` / `IV30d`**（FR-035 机械防线，形态同 T012 的 `delayed_quotes` 断言）+ **FR-013 机械防线：断言呈现字段里 IVP 在 IVR 之前、且不渲染 `iv_rank`**（vendor 的 IVR 只落库不上屏，见 FR-013 可验证判据）；**UI/render 走 T024 E2E**（本仓测试分层：vitest=logic / Playwright=UI）

- [X] T022 [Mobile] **波动温度计屏**（FR-015/FR-016/FR-017/FR-018/FR-019/FR-035/FR-036, plan D9）：`optionsdesk/thermometer-screen.tsx` + 子件 —— VIX 半圆表盘（`react-native-svg` 三段弧 + 指针，绿/黄/红 = 平静<20 / 抬升20-30 / 高波>30）+ 旁列 VVIX / 比值（各带 `asOf`；🚨 **不呈现 regime 字段** —— FR-015 📌，mockup 帧⑦ 画了 `regime N` 但已于 2026-08-03 拍板移除，别照 mockup 抄回来）+ **常驻「不构成开仓理由」**（非折叠非 tooltip）+ 个股 IVP 列表（纯 `View` 分段条，「分位不可算」行保留、`excluded` 行带标记）。🚨 **表盘三段是波动读数不是涨跌** —— 禁复用 `--nvy-quote-*`；🚨 大数字与轴心/指针位置要错开（mockup 踩过，轴心圆会看着像小数点）→ verify: `thermometer.rules.spec.ts` —— 表盘角度几何（值→角度映射的三档边界）+ 比值展示决策（同基准 / 不同基准 / 缺 VVIX / 缺 VIX 四态）+ IVP 行态分类（含 **FR-036 阈值档三分**：`<70` 未越 / `70–90` 已越高档 / `≥90` 已越极高档，边界值 70 与 90 各断言归属唯一；「分位不可算」行**不出徽标**）+ **分段条段宽与 FR-036 边界一致**（25/45/20/10 ↔ 25/70/90，刻度标签同源）+ **断言文案与字段名不出现 `iv30d`**（FR-035）

- [X] T023 [Mobile] **US4 雷达 🌡 转真 + 路由与门控**（FR-021/FR-022, plan D9）：`optionsdesk/radar-screen.tsx` 题头 🌡 由灰置「即将可用」改为可点直达 P7（**这是本片对 045 既有代码的唯一改动面**）；两个新屏挂进 `optionsdesk-routes.ts`，随期权台 tab 一并受 markets 门控（**纯客户端门控**，与 045 同构：tab `href:null` + 路由级 guard，server 端不新增第二套）→ verify: 路由常量单测（Small）+ **门控真验落 `apps/mobile/e2e/markets-feature-gate.spec.ts`**（该文件是 `playwright.markets-off.config.ts` `testMatch` 认的唯一文件），跑 **`nx run mobile:e2e-public`**（target 已钉 `EXPO_PUBLIC_FEATURE_MARKETS=false`，Metro 打包期内联 ⇒ 只有换 bundle 才是真验，运行期改 env 无效）

- [X] T028 [Mobile] **雷达行点击进标的详情（US1 的入口）**（US1-AS1 / `spec.md:198,202`；045 FR-018 前提失效, plan D9）：`optionsdesk/radar-screen.tsx` 行点击由「标的详情即将可用」轻提示改为 `router.push(optionsdeskUnderlyingRoute(该行 ticker))`（路由函数归 T023，内部已对冒号 `encodeURIComponent`）；点击目标沿用行既有稳定 testID `optionsdesk-radar-row-<ticker>`（T024 定位用）。**清 orphan**：`optionsdesk-copy.ts` 的 `radar.detailComingSoon` 与屏内 notice 条随之删除，文件头注释同步改掉（别留「仍是即将可用」的假注释）。<br>📌 **补录理由**：045 `FR-018`「该入口 MUST 以『即将可用』形态呈现」是**以「本片内详情页尚不存在」为前提**的，T021 落地后前提失效；本片 `FR-021` 只写了题头 🌡，T023 又把改动面锁死成「🌡 是唯一改动面」，于是这条没人认领（两轮 `/speckit-analyze` 都没扫出来 —— 它长在 User Scenario 层，三张覆盖矩阵的值域都不含 Acceptance Scenario）。⇒ **T023 的「唯一改动面」措辞以本条为准**：046 对 045 既有代码共两处改动面（题头 🌡 + 行点击）→ verify: `radar.rules.spec.ts` 加机械防线（雷达文案子树**深走零命中**「即将可用」，值面断言体例同 T012/T021/T022）+ `nx run-many -t typecheck lint test -p mobile` 绿 + 045 回归 e2e `optionsdesk-anchors-radar.spec.ts` 绿；**「点行 → 详情三块可见」的 UI 断言归 T024**（本仓分层：vitest=logic / Playwright=UI）

---

## Phase 8: 收口（两层验证 + 无回归 + 全绿门）

- [X] T024 [Mobile-E2E] **hermetic UI e2e**（US1/US2/US4 + 全部 UI state_branch）：`apps/mobile/e2e/optionsdesk-detail-thermometer.spec.ts`（Playwright；**样板 = `optionsdesk-anchors-radar.spec.ts`** —— 网络边界**全 mock**（`mockJson`）+ 断言逐条对应 task 编号 + 稳定 testID 定位，纪律见 `.claude/rules/mobile-e2e-hermetic.md`；feature-slug 命名、无编号前缀）—— 详情四态（常态 / 锚卡异常 / 温度计降级 / 序列降级）+ 无锚态 + 窗口切换（含长窗实际起点标注）+ 温度计四态 + **三条断言（各自唯一的机械载体，落在别处都验不到）**：① 温度计页「不构成开仓理由」**常驻可见且非折叠非 tooltip**（FR-019 —— e2e 是唯一能验「常驻」的层）② 雷达题头 🌡 **可点直达 P7、且页内不再出现「即将可用」字样**（FR-021 / US4-AS1）③ **从雷达点某行 → 详情屏三块可见**（承接 T028；US1-AS1 的机械载体 —— 深链进详情验的是「详情渲不渲」，验不到「入口通不通」）。<br>🚨 **markets OFF 深链拦截不写在本文件** —— `playwright.markets-off.config.ts:23` 的 `testMatch` **锁死 `markets-feature-gate.spec.ts` 一个文件**（主套件与 runtime-smoke config 反向 `testIgnore` 它，两侧对称隔离）。⇒ OFF 断言**必须加进 `apps/mobile/e2e/markets-feature-gate.spec.ts`**，跑 `nx run mobile:e2e-public`（该 target 已钉 `EXPO_PUBLIC_FEATURE_MARKETS=false`，build-time 内联常量）。**写在本文件里 = 在 ON bundle 下跑，永远验不到 OFF，且不会红。**⚠️ 写之前过一遍 memory `expo_web_e2e_and_router_footguns`（goBack 重映射 / 叠屏 DOM 双命中 / `(group)` 段 URL 隐藏 / 硬刷新丢返回）

- [X] T025 [Contract-Smoke] **契约冒烟**（Constitution §V 第二层）：`apps/mobile/e2e/contract-smoke/optionsdesk-detail-thermometer.contract.ts`（feature-slug，045 先例 `optionsdesk.contract.ts`）—— 生成的 `@nvy/api-client` 打真 server，验两个读端**契约对齐 + 真落库**（补 hermetic mock 与 server IT 都覆盖不到的缝）。🚨 **必须在 `apps/mobile/e2e/contract-smoke/run.ts` 里 `import * as … from './optionsdesk-detail-thermometer.contract'` 注册**，否则文件在但永不执行（run.ts 是显式 import 清单，不是目录扫描）。**样板 = `optionsdesk.contract.ts`**：用**专属 ticker** 避开其他 spec 与 mock fixture（045 用 `us:NVYX`，本片另取一个）+ **末尾 DELETE 自清理**，保同一 boot 内多 spec 幂等→ verify: `nx run mobile:contract-smoke` 绿。⚠️ 本地跑必显式 `MARKETDATA_PROVIDER=mock`（memory：继承 shell env 会被 live 误导）

- [X] T026 [Server] **ADR-0062 跨 ctx 面清单 amend**（plan Gate 0.4）：`docs/adr/0062-optionsdesk-bounded-context.md` 的跨 ctx 面清单补三张新表的读面，每条标 Q7-B；**boundaries 配置不动**（optionsdesk → marketdata 读边 045 已开，本片不碰 `marketdata-rules` 那条禁令）→ verify: `check-adr-index.ts` 绿 + `nx lint server` 绿 + **反例确认绊线仍在**：临时文件里 `import { deriveAdjustedBars } from '../marketdata/adjusted-bars.rules'` 应撞红，删掉后 0 errors（ADR-0053 绊线未被误开）

- [X] T027 [Gate] **全绿门 + 部署前置 + 零盘中实时扫描**（FR-033, Constitution §V / ADR-0040）：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` exit 0（⚠️ 2026-08-03 起 server `test/**` 已纳入 **typecheck + lint**、mobile e2e 专设 tsconfig 也已接入 ⇒ 本片新写的 IT / e2e 会被静态检查扫到，不再是盲区）；**`pnpm tsx scripts/checks/check-test-size.ts` exit 0** + **`pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` exit 0**（两者均在 PR 门 `gate-checks` job **无条件全扫**，不走 `nx affected`）；`prisma migrate deploy` 在 dev 库幂等；**shim 先部署且实打两个新端点**（Guardrail 6：`/healthz` 绿 ≠ 端点在）；PR body 三 checkbox 按 `pr-creation-protocol.md` 勾全。**外加一项「只有这次能做」的核对 —— `perf_budgets` 兑现**（045 T028 同款，**沿用其机制、不新造 perf harness**）：本片 40/80 · 50/100 是**从 045 借来的档位、对这两个新端点从未实测**，而 frontmatter 自称「回归探测器」—— 没有测量的探测器不探测任何东西。⇒ 从同批 `nx test server` 里 **T016 / T018 两条真 HTTP IT 的 pino `responseTime`** 取本片两个端点的 p95/p99，与 frontmatter 值对照：**超了就调档并说明，没超则把 frontmatter 的「暂定值」注记连同 T019 的路径核实一并作废** → verify: 上述命令逐条 exit 0 + shim 端点 curl 真返数据 + 两个端点实测 p95/p99 记入 `spec.md` frontmatter 注释（含日期与来源）+ **FR-033 / SC-008 全仓扫描**：本片改动面内无 `delayed_quotes`、无「在美股交易时段主动拉起行情网关」的调用（零盘中实时路径 = 与 V9 解耦的可验证判据） ⟨**2026-08-03 收口实况**：全绿门 / 两个 checker / `migrate deploy` 幂等 / SC-007 / SC-008 / `perf_budgets` 兑现 —— 均已实跑通过（实测值与判定见 `spec.md` frontmatter）。**「shim 先部署 + 实打两个新端点」(Guardrail 6) 起初未执行**（部署是对外动作 + 拉起 OpenD 会收走手机行情权约 10 分钟），**已于 2026-08-03 23:14 补做并通过** —— 两端点 HTTP 200 且 rows 非空，实况与命令见下方块⑥。⟩

> ### ⑥ ~~待 user 手动~~ ✅ **已执行并通过（2026-08-03 23:14）** —— shim 部署 + 实打两个新端点
>
> **实打结果**（判据 = HTTP 200 **且** rows 非空，两条都满足）：
>
> - `/healthz` → `version = 42c05f1f`（= #847 合并 SHA）⇒ 跑的正是含本片两个新端点的那棵树。shim 已随 #847 由 `deploy-futu-shim.yml` **自动部署**，非手工。
> - `/overview?codes=US.AAPL` → **HTTP 200 · count=1 · rows=1**，字段含 `iv` / `iv_rank` / `iv_percentile`（另有 `hv_30d`…`hv_365d` 及各自 percentile、`pre_iv`、call/put OI 与 volume）
> - `/his-vol?code=US.AAPL&start=2026-07-01&end=2026-07-31` → **HTTP 200 · count=22 · rows=22**，字段 `code`/`name`/`time`/`timestamp`/`iv`/`hv`/`underlying_price`
> - 📌 打之前 `/healthz` 是 `opend_connected=false`（OpenD 已空闲回收），业务端点照样返真数据 —— **业务请求自己会拉起 OpenD**，这正是它与「直连 `11111`」的区别（后者不会，见 [`futu-opend-hk.md` §五 冒烟](../../ops/runbook/futu-opend-hk.md)）。
>
> ⇒ **两个新维度可以照常在 08-04 06:00 首跑**，`us_equity_bar` 那次 7/7 全 404 的形态不会重演。
>
> **原本为什么留给 user**：部署是对外动作，且「拉起 OpenD 会把行情权从手机端收走约 10 分钟」。<br>⚠️ **后半条已于同日被 [V9 三臂实验](../../docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md)（§7.3-V9）证伪** —— 美股下 OpenD 持实时订阅期间手机反复主动争用，两侧同时保持最高档、零互踢。加上 shim 早已自动部署完毕、这两个调用是只读的，阻塞理由消失，故由 agent 直接跑完。（⚠️ V9 只测了美股，**港股未测**，别把这条外推。）
>
> 🚨 **Guardrail 6 的教训：`/healthz` 绿 ≠ 端点在。** `us_equity_bar` 首跑 7/7 全 404，真因是 shim 被从**不含 `/kline` 的分支**部署覆盖 —— healthz 照样绿。所以下面**必须实打端点本身**，只看 healthz 等于没验。
>
> ```bash
> # 0) 部署 shim 后，先确认跑的是含本片两个新端点的那个版本（healthz 只用来确认进程活着）
> curl -sS "$FUTU_SHIM_URL/healthz" -H "Authorization: Bearer $FUTU_SHIM_TOKEN"
>
> # 1) 实打 overview（标的级 IV 日快照的数据源）—— 期望 200 + iv / iv_rank / iv_percentile 字段
> #    ⚠️ 参数名是 `codes`（复数，逗号分隔批量），这是期权面唯一收 code 列表的端点
> curl -sS -o /tmp/shim-overview.json -w '\nHTTP=%{http_code}\n' \
>   "$FUTU_SHIM_URL/overview?codes=US.AAPL" -H "Authorization: Bearer $FUTU_SHIM_TOKEN"
>
> # 2) 实打 his-vol（标的级 IV 历史序列的数据源）—— 期望 200 + 非空 rows
> #    ⚠️ 参数名是 `code` / `start` / `end`（**不是 begin**）；窗口 > HIS_VOL_MAX_SPAN_DAYS 会被拒而非截断
> curl -sS -o /tmp/shim-hisvol.json -w '\nHTTP=%{http_code}\n' \
>   "$FUTU_SHIM_URL/his-vol?code=US.AAPL&start=2026-07-01&end=2026-07-31" \
>   -H "Authorization: Bearer $FUTU_SHIM_TOKEN"
>
> # 3) 判定：两条都必须 HTTP=200 **且 rows 非空**。响应信封 = {as_of, count, rows[]}
> #    404 = 部署的分支不含新端点（正是 us_equity_bar 踩的那个坑）；
> #    200 但 rows 为空 = 端点在但 OpenD 没连上 / 该窗口无数据，仍不算通过。
> python3 -c "import json;d=json.load(open('/tmp/shim-overview.json'));print('overview count=',d.get('count'),'rows=',len(d.get('rows',[])))"
> python3 -c "import json;d=json.load(open('/tmp/shim-hisvol.json'));print('his-vol count=',d.get('count'),'rows=',len(d.get('rows',[])))"
> ```
>
> 通过后再把本条从「待手动」划掉；未通过 **不要**开跑两个新维度的 cron（会重演 7/7 全 404）。

---

## Dependencies & 执行顺序

```text
T001 ─┬─ T002 ─┬─ T008（标的级维度）
      │        └─ T013（指数维度，不依赖锚闸）
      ├─ T003 ──── T012（CBOE adapter）
      ├─ T004 ─┬── T009（回填）
      │        └── T010（双算对表）
      └─ T005（schema IT）

T006（shim 端点）──── T007（port+adapter）──── T008
T008 + T009 + T010 ── T011（采集 IT）
T012 + T013 ───────── T014（指数 IT）

T011 + T014 ── T015（详情读端）── T016
            └─ T017（温度计读端）── T018
T016 + T018 ── T019（契约同步）── T020/T021/T022/T023（mobile）
                                  └── T024 + T025 ── T026 ── T027
```

**并行机会**：T003 / T004 互不相干可并行；T006（Python）与 T001–T005（TS）跨栈并行；T020 与 T021/T022 可并行起手（T020 是前两者的输入但接口面小，可先定签名）。

**MVP 边界**：Phase 1–5（server 全链）跑通即可用 `curl` 验证两个读端出真值；mobile 是呈现层。但**跨端 feature 必须单 PR**（Constitution §V），故不拆交付。

---

## state_branch 覆盖矩阵（32 条 → task，逐条 1:1）

| #   | state_branch（摘要）                              | 覆盖 task                 |
| --- | ------------------------------------------------- | ------------------------- |
| 1   | IVP 窗口充足 → 显示数值 + 分段条                  | T015 · T021 · T024        |
| 2   | IVP 窗口不足 → 「分位不可算」，禁 0 / 禁隐藏      | T004 · T015 · T024        |
| 3   | IVP 当日未采到 → 最近一期 + 显式 asOf             | T015 · T021 · T024        |
| 4   | IVP 从未采到 → 「暂无数据」，区块仍渲染           | T015 · T024               |
| 5   | VIX + VVIX 均可得同日 → 表盘 + 比值               | T017 · T022 · T024        |
| 6   | VVIX 不可得 → 两处各自标不可用，禁单独推算        | T017 · T022 · T024        |
| 7   | VIX 不可得 → 「显示不可用」，禁指针停 0           | T017 · T022 · T024        |
| 8   | 两者 asOf 不同日 → 比值不计算 + 标「基准不一致」  | T017 · T018 · T024        |
| 9   | 序列可得 ∧ 锚存在 → 折线 + 四区间带同图           | T021 · T024               |
| 10  | 序列为空 → 空态，四区间带仍单独呈现               | T021 · T024               |
| 11  | 序列短于窗口 → 标明实际起点，禁拉伸补空           | T021 · T024               |
| 12  | 窗口内有复权事件 → 前复权连续，与雷达口径差可解释 | T021 · T024               |
| 13  | 窗口→粒度固定映射，聚合在服务端                   | T020 · T024               |
| 14  | 切换窗口 → 四区间边界不变，纵轴容纳实际区间       | T021 · T024               |
| 15  | 两端点合成中一侧失败 → 另一侧照常，禁整页失败     | T021 · T024               |
| 16  | 锚卡派生链无覆盖 → 三处显示派生值                 | T015 · T021               |
| 17  | 锚卡人工态 → 显示人工值 + 回落标记                | T015 · T021 · T024        |
| 18  | next_review 逾期 → 红标                           | T015 · T021 · T024        |
| 19  | 持股 → 加显愿卖锚；未持股 → 该行不出现            | T015 · T021 ⚠️ **本片仅「未持股」半边** —— 持仓规模属 M3/M4，本片无数据通路 ⇒「持股」半边不可达（plan D9） |
| 20  | 标的无锚 → 「尚未建锚」+ 建锚入口                 | T015 · T016 · T024        |
| 21  | markets OFF → 两页随 tab 不可达（路由级 guard）   | T023 · T024（断言落 `markets-feature-gate.spec.ts`，跑 `e2e-public`） |
| 22  | IVP 列表零锚 → 空态；指数表盘照常渲染             | T017 · T018 · T022 · T024 |
| 23  | 采集（标的级）：工作集取自锚白名单                | T008 · T011               |
| 24  | 采集（指数）：固定 2 代码、不挂锚闸、零锚照常跑   | T013 · T014               |
| 25  | 采集：vendor 不可达 → 记失败 + 可重拉等级告警     | T008 · T011 · T014        |
| 26  | 采集：同日重跑幂等                                | T008 · T011 · T013 · T014 |
| 27  | 采集：his_volatility ≤364 天分页不重不漏          | T004 · T009               |
| 28  | 采集：业务日期 A′ 按 us 时区                      | T008 · T013 · T011        |
| 29  | 采集：新增锚 → 下一轮自动纳入                     | T008 · T011               |
| 30  | 采集：双算差三档 → 均不影响 UI 显示值             | T010 · T011               |
| 31  | 采集：序列不足自算 → 跳过对表且不告警             | T010 · T011               |
| 32  | 提醒状态：阈值档三分（25/70/90）；不可算时不出徽标 | T021 · T022               |

## Edge Case 覆盖（7 条 → task）

| Edge Case                                 | 覆盖 task               |
| ----------------------------------------- | ----------------------- |
| 深链进入无锚标的                          | T015 · T016 · T024      |
| 窗口内复权事件 → 与雷达未复权口径差可解释 | T021 · T024             |
| 有锚但无日线 → 四区间带仍单独呈现         | T021 · T024             |
| 序列短于窗口 → 标明实际起点               | T021 · T024             |
| IVP 两个来源 → 显示口径单一且可追溯       | T010 · T015（DTO 断言） |
| `excluded` 锚照常列出并标记               | T017 · T022             |
| 长窗 2500 点 → 服务端 OHLC 聚合           | T020 · T021             |

## SC 覆盖（8 条 → task；**故意零覆盖的已写明**）

> per `sdd.md` 反模式：**SC 层是系统性盲区**（人对着 FR 展开 tasks，SC 不产出代码行、没有牵引力）。此处逐条列，预期的零覆盖写明「故意的」。

| SC                                           | 覆盖 task          | 备注                                                                               |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| SC-001 15 秒读完三件事                       | —                  | ⚪ **故意零覆盖**：主观计时，spec 已明标**不作本片验收门**（与 045 SC-001 同性质） |
| SC-002 每处读数带可见时点标注                | T021 · T022 · T024 | 抽屏零处「不知道是哪天的」                                                         |
| SC-003 IVP 有值或显式不可算，零空值零 0 冒充 | T011 · T015 · T024 |                                                                                    |
| SC-004 新增锚下一轮自动出数据                | T008 · T011        |                                                                                    |
| SC-005 12 只锚规模单轮 ≤5 分钟               | **T007** · T027    | ⚠️ 载体已订正：**T007 扩进 `marketdata.futu-shim.vendor.spec.ts` 的那两个 gated 块**内计时（对照基线 `us_equity_bar` 7 票约 1 分钟）+ T027 核对 prod 首轮 `SyncRun` 墙钟。**原指 T011/T014 无效** —— 那两条 hermetic IT 把 vendor mock 了，计时测的是 mock 往返。⚠️ 该门恒 skip ⇒ 数得**手工跑一次**才有 |
| SC-006 对非锚定标的请求数 = 0                | T011               | 工作集闸的可验证判据                                                               |
| SC-007 新第三方运行时依赖 = 0                | T020 · T027        | 扫描判据：`git diff` 无 `package.json` dependencies 新增                           |
| SC-008 零盘中实时取数路径                    | T012 · T027        | 扫描判据：代码内无 `delayed_quotes`、无交易时段主动拉起行情网关的调用              |

## 单 PR（Constitution §V）

跨端 feature ⇒ **server impl + IT + shim + api-client regen + mobile 消费 + 两层验证全部同 PR 原子 merge**。PR body 走 `docs/conventions/pr-creation-protocol.md`（模板是 body 唯一权威 source，三 checkbox 缺一 CI 红）。
