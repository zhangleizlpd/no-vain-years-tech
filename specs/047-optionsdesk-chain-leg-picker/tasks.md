---
feature_id: 047-optionsdesk-chain-leg-picker
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-04'
updated_at: '2026-08-07'
---

# Tasks: 047-optionsdesk-chain-leg-picker（optionsdesk M2b — 意图 Tab 选约表 + 期权链逐日快照管道）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Mockup**: [`design/handoff.md`](./design/handoff.md)（8 帧）｜ **Branch**: `047-optionsdesk-chain-leg-picker`

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）
- 层级：`[Server]` / `[Server-IT]` / `[Server-Vendor]` / `[Shim]`（futu-shim Python）/ `[Ops]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]`（跨层收口）
- **层级 → size 映射**（`docs/conventions/testing.md`）：`[Server]` 的 verify 落 **Small** `*.spec.ts`（`unit` project，零容器）· `[Server-IT]` = **Medium** `*.it.spec.ts`（`it` project + 共享 PG）· `[Server-Vendor]` = **Large** `*.vendor.spec.ts`（默认 skip）· `[Mobile]` = Small（logic-only）· `[Mobile-E2E]` / `[Contract-Smoke]` = Medium（`apps/mobile/e2e/` 单一档、免后缀）
- **测试不独立成 task**（per `sdd.md`），绑在每个实现 task 的 `verify:` 里；**IT 例外**（跨多文件、单独成 task）
- 每 task = 30min–2h 单 commit 单元；`- [ ]` pending / `- [X]` done

## Path Conventions

| 面 | 路径 |
| --- | --- |
| server 业务（optionsdesk） | `apps/server/src/optionsdesk/`（扁平，无 domain/application/infrastructure） |
| server 采集（marketdata） | `apps/server/src/marketdata/` |
| schema / migration | `apps/server/prisma/schema.prisma` · `apps/server/prisma/migrations/` |
| server IT（Medium） | `apps/server/test/integration/optionsdesk-047.*.it.spec.ts` |
| server 真 vendor（Large） | **扩既有** `apps/server/test/integration/marketdata.futu-shim.vendor.spec.ts`（同一 shim，勿新建） |
| mobile e2e（Medium） | `apps/mobile/e2e/optionsdesk-chain-leg-picker.spec.ts`（feature-slug，**无编号前缀**） |
| markets-OFF 断言 | **只能落** `apps/mobile/e2e/markets-feature-gate.spec.ts`（`playwright.markets-off.config.ts` 的 `testMatch` 锁死单文件） |
| contract-smoke（Medium） | `apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts` + **在 `run.ts` import 注册** |
| futu-shim（自有 pytest） | `services/futu-shim/src/futu_shim/` · `services/futu-shim/tests/`（不在 size 分类学扫描面内） |
| 表级探针 | `ops/jobs/marketdata-table-health.{sh,sql}` |
| mobile | `apps/mobile/src/optionsdesk/`（**全 Small 单一档，目录即坐标、免后缀**） |

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **无套利下界用 `ask` 不用 `bid`**（FR-044, plan D-DATA-7）——直觉是「买价不应低于内在价值」，实测同一批 2138 行 `ask` 版 0 违规 / `bid` 版 **706** 违规（做市商对实值腿的机械占位报价普遍让 bid 跌破内在价值，是市场常态不是脏数据）。**用合成数据写测试永远不会红** ⇒ SC-010 必须拿已采真实样本回放。
2. **`earnings_event` 维度 MUST NOT 挂锚闸**（FR-035a, plan D-DATA-1）——它是**市场级**接口（单次 ≤7 天窗返全市场），锚闸零收窄作用，挂了只会复刻「零锚时静默不采」。⚠️ 复用 `factExecutor` 那条「先取工作集再逐票」的路径**就是**踩这个坑。**这是 046 已订正过一次的同形状问题（FR-026 → FR-027），本片是第三次**。
3. **采集端 `option_type = ALL`，含 CALL**（plan D-DATA-3）——「本片只含认沽」是**呈现面**的话（Assumptions）。盲写会在采集端就滤成 PUT，而**快照漏采即永久缺口**，M4 的 wheel/CC 要 CALL 时买不回来。链接口一次返双边、调用数不变，成本只是 snapshot 批次翻倍。
4. **非标合约采集端全采落库，排除只发生在选约层**（FR-008/FR-033）——同上一条的同款陷阱：在采集端滤掉 = 证据没了且不可回补。
5. **`option_chain` 的 10 次/30s 是官方真值，别"顺手修正"**（plan D-SHIM）——2026-08-04 直取 `openapi.futunn.com` 官方页复核，原文「每 30 秒内最多请求 10 次获取期权链接口」。它与 `history_kline` 那次「有官方 60/30s 却挂在兜底 10/30s」是**相反方向**的事，`option_chain` 这一行本片**一个字不改**。⚠️ **但「不改 `option_chain`」≠「整张 `LIMITS` 表冻结」**——同一轮复核顺带查实 `get_earnings_calendar` 的官方限频是 **60 次/30s**（原文「接口限制：30 秒内最多 60 次请求；分页请求仅首页计入限频统计」，2026-08-04 复核），而它原本不在表里、落到兜底 10/30s = **6x 偏严**（与 `history_kline` 同形状、反方向），已按 **T011a** 补登。表里其余档位一律以各自官方页为准，别凭直觉调。
6. **OI 不归 `session_date`**（plan D-DATA-4）——官方文档明写「美股期权 OI 在**盘前时段**更新」⇒ T 日收盘后采的快照，其 OI 其实是 **T−1 日**的。盲写会把 OI 当作 T 日数据，**永远不会红**，但活跃度排名与 UI 的 `asOf` 全错一天。⇒ 快照行必须有独立的 `oi_as_of`，UI 的 OI 列取它而非区块级 `asOf`。
7. **完整性分母含「当日到期」的合约**（FR-045, plan D-DATA-6）——分母是「到期日 **≥** 当日交易日」不是 `>`（当日到期的合约当日仍可取快照，官方文档「结束日期请输入今天或未来的日期」）。写成 `>` 只在到期日当天整批假红，平时看不出来。**注意选约表那侧是 `>`（已到期腿不可交易），两处判据故意不同，别统一。**
8. **详情页的纵向滚动容器必须换成虚拟化列表本身**（FR-005, plan D-UI-1）——在既有 `ScrollView` 里塞 `FlatList`/`SectionList` 会同时坏两件事：虚拟化静默失效（内层拿到无界高度，730 行全渲染）+ 两个滚动响应者争纵向手势。**RN 只在 dev console 打一条 warning，CI 全绿、typecheck 绿、e2e 也可能绿**（web 视口高、行少）。
9. **Android MUST 显式传 `stickySectionHeadersEnabled={true}`**（plan D-UI-1）——该 prop **只在 iOS 默认为 true**。只在 iOS sim / web 验会漏掉「表头滚走了」。
10. **Δ 与 σ 距离 MUST 由同一个 `absDelta` 派生**（plan D-UI-3）——两处各算各的（一处取 vendor Δ、一处拿 spot/K/IV 反算）**不会红**，但会在部分行对不上，而 mockup review 定案「显 |Δ| 真值」之后这种不自洽就藏不住了。`|Δ| ∈ {0,1}` 时 `Φ⁻¹` 发散 ⇒ 两列**同时**留空，不允许一列有一列无。
11. **财报打标 MUST 按 `(标的, 到期日)` 分组算一次再贴回行**（plan D-UI-4）——逐行算不会红，但同一标的同一到期日会出现「一行标跨财报、另一行标不跨」的矛盾（mockup 原数据实撞）。打标函数签名**不接受合约级输入**是这条的结构保证。
12. **超 vendor 前向视野的到期日落「无日期」不落「不跨」**（FR-026/FR-034）——vendor 财报视野约 6 个月而本片采到 LEAPS，远月腿天然无财报数据。渲成「不跨财报」是**编造了一个未知事实**，且不会红。
13. **档位系数禁字面量**（`check-optionsdesk-rule-constants.ts`，PR 门 `gate-checks` **无条件全扫**）——`apps/server/src/optionsdesk/` 下**除 `anchor.rules.ts` 外**任何 `.ts` 都不得出现 `0.8` / `0.6` / `1.2`。本片 T005/T006/T027 正住在该目录且满屏 W=0.8V / 1.2V 语义 —— 抄字面量 = PR 红。**本片新增的六个档位边界（15/10/5、2/1/0.6）同样一律具名常量**，虽然探针不扫它们。
14. **`marketdata/*.rules.ts` 在 optionsdesk 是 ESLint disallow**（ADR-0053 绊线，plan D-ARCH-1）——本片派生全落 optionsdesk 自己的 `*.rules.ts`；spot 直接取快照行里 vendor 给的标的价，**不走复权换算**。想在 server 端拼复权序列 = `nx lint server` 红，**别改 allowlist 绕过**。
15. **shim `/healthz` 绿 ≠ 新端点在**（046 Guardrail 6 的教训，本片 4 个新端点）——`us_equity_bar` 首跑 7/7 全 404 就是被不含 `/kline` 的分支覆盖部署。新维度上线前必须**实打**四个端点各一发。
16. **完整性 ERROR 的触达 MUST NOT 靠 `sync_run` 日报**（FR-046, T025a）——次日日报 = 次晨 09:00 的 `ops/jobs/marketdata-sync-report.sh` 读 `sync_run` 推飞书，而 FR-046 明写「ERROR 触达 MUST NOT 并入次日日报」。盲写会把 ERROR 落进 `SyncRun` stats 就当告警做完了 —— **测试验的是「升不升 ERROR」，验不到「什么时候到人眼前」，所以不会红**。当日触达的唯一载体是 T025a 的独立 timer。🚫 另注：spec 明写「提醒器接入 Alert Engine」属**本片不做**，别顺手接 `alert` ctx。
17. **本片三处「选错不会被机器拦」的测试决定**（通用分类学不复述 —— 改任何测试文件时 `.claude/rules/test-taxonomy-trigger.md` 会逐字自动加载）——① **PG 入口**：T009 用 `setupEmptyDb()`（自己跑 `migrate deploy` 并验其产物），T017/T020/T023/T029 用 `setupIsolatedDb()`；**选错既不红也不慢，只是把被测对象抽掉** ② **真 vendor 复用既有文件与既有门** —— 扩 `marketdata.futu-shim.vendor.spec.ts` + `RUN_MARKETDATA_IT`，**别为同一个 shim 再造 flag / 再开文件** ③ **markets-OFF 断言只能落 `markets-feature-gate.spec.ts`**（见 Path Conventions）。
18. **请求时派生的「今天」恒取 `marketDateFor(['us'], now)`**（T006a；canonical = [`docs/conventions/cross-timezone-date-semantics.md`](../../docs/conventions/cross-timezone-date-semantics.md) §3 归属表 + §4 剩余期限口径）——🚫 禁宿主本地日期、🚫 禁绝对时刻差（会得小数，让 `≤ N 天` 这类带判据在一天之内抖），整数日历日**含周末与节假日**，**到期日当天 = 0**。北京上午 = ET 前一日晚 ⇒ 取错基准 DTE **恒偏 1 天**，而 DTE 正是建仓腿 `DTE ≤ 14` / 收租腿 `DTE ∈ [150, 365]` / FR-048 豁免线 `DTE ≤ 2` 的带判据 —— 边界腿静默进出带，且**永远不会红**。🚨 **价格基准 ≠ DTE 基准是有意为之**：价格来自**上一场 session** 的 EOD 快照、DTE 从**当前 ET 日期**起算，**MUST NOT「修」成快照日基准**（那会系统性多算一天）；代价是同屏必须有显式 `asOf`（与 Guardrail 6 的 `oi_as_of` 同源纪律）。

---

## Phase 1: 地基（schema + 维度注册 + 六个纯函数）🎯

- [X] T001 [Server] **三张 marketdata 新表 + migration**（FR-028/030/034/040, plan D-DATA-4/5）：`schema.prisma` 在 `marketdata` schema 下新增 ① **期权合约**（幂等键 `(市场, 合约代码)`；root / 标的 FK / 到期日 / 行权价 / 认购认沽 / 到期周期 / 结算方式 / `is_standard`；**MUST NOT 存合约乘数**；**MUST NOT 加「是否已到期」状态列**——到期日字段本身是权威判据，双写必 drift）② **期权日快照**（幂等键 `(合约, 交易日, 来源)`；双边报价与档位量 / 全 greeks / IV / OI / 净OI / Vol / 成交额 / 标的 spot / vendor 时间戳 / greeks 完整性标记；**三个独立时点列 `session_date`（归属交易日）· `quote_as_of`（本行报价实际采集时刻）· `oi_as_of`（OI 归属交易日，Guardrail 6）**）③ **财报事件**（幂等键 `(标的, 财报日)`；日期 / 盘前盘后盘中 / 报告期 / eps 实际与预期 / PIT 三件套 `first_seen_at` · `date_changed_at` · 变更前日期）。三表 `@@schema("marketdata")` + `@@map` snake_case + **Decimal 禁 Float**；**`check-server-moat.ts` 的 `MODEL_OWNERSHIP` 声明三表 → `marketdata`**（漏则 optionsdesk 一读就 `moat-unmapped` 硬拒）→ verify: `prisma validate` + `generate` + dev DB `migrate deploy` 无 drift（顶部 `-- migration_refs: specs/047-optionsdesk-chain-leg-picker`）+ **幂等重 deploy** + `nx typecheck server` 绿 + `check-server-moat.ts` exit 0

- [X] T002 [P] [Server] **锚表加水位手选两列 + migration**（FR-017, plan D-UI-5）：`optionsdesk` schema 的锚表加 ① 手选水位档（枚举 `<1/3` · `1/3–2/3` · `≥2/3`，**nullable，`null` = 未选，是常驻分支不是过渡态**）② 设置时刻。🚫 **MUST NOT 给它默认值**——默认任何一档 = FR-017 明禁的「替人做方向性假设」→ verify: `migrate deploy` 无 drift + 幂等重跑 + 新建锚该列为 `null` + `check-server-moat.ts` 仍 0 违规

- [X] T003 [Server] **三个维度 seed + `DIMENSION_KEYS` 注册**（FR-035/035a/036, plan D-DATA-1/D-DATA-10）：migration seed 三行 `SyncDimension`（样板 = `20260731_2230_seed_us_equity_bar_dimension`）—— 链发现 + 逐日快照 + 财报日历，三者 `market_scope={us}`、cron 排在美股收盘后且**快照排在链发现之后**（hard 依赖，FR-031）；`dimension-executor.ts` 的 `DIMENSION_KEYS` 加三项。🚨 **财报维度的 `market_scope` 只是元数据，其工作集是固定前向时间窗序列、不由它推导，更不过锚闸**（Guardrail 2）。🚫 **FR-055**：三个维度全部登记在 **marketdata 名下**，**MUST NOT 把 optionsdesk 注册进 marketdata 的维度注册表 / executor 钩子**（底座依赖业务 = 方向错）；工作集闸继续由 marketdata 侧**反向只读**锚表（沿用 045 的 `anchor-driven-sync-gate.ts`）→ verify: `dimension-executor.spec.ts` 断言三个新 key 在册 + 依赖拓扑断言「快照 after 链发现」+ **FR-055 的机器判据**（⚠️ **判据形态已于 T039 订正，见下方 📌**）+ `nx lint server` 绿（boundaries 单向）+ seed migration 幂等重跑 + `marketdata-sync-report.sh` 逐维解析不炸<br>📌 **FR-055 判据形态订正（2026-08-07 T039）**：本行原写「`rg 'optionsdesk' apps/server/src/marketdata/dimension-executor.ts` 零命中」，**该形态不可用** —— 有 1 处 pre-existing 命中（该文件里一条 045-era 散文注释，`git blame` = `aa098955`，先于本片，描述的正是被认可的反向只读闸），而按 Surgical Edits 那条注释 mention 不删 ⇒ 判据恒红。**改为只扫依赖形态**：`rg -n "from '[^']*optionsdesk|require\([^)]*optionsdesk|Optionsdesk[A-Z]" apps/server/src/marketdata/` 零命中（等价写法与反例自检见 spec FR-055）。真正承重的机器闸是 ESLint `boundaries`（`marketdata → optionsdesk` 已显式 disallow），`rg` 只是廉价二道。

- [X] T003a [Server] **维度数硬编码 fixture 同步**（T003 加三维度的连带回归，无对应 FR —— 纯既有测试台账修复）：T001/T003 把 marketdata 表从 31 → 34 张、`SyncDimension` 从 25 → 28 行、`SyncDependency` 从 25 → 28 条边，13 个既有 IT 文件里把这些数字/清单**写死**当 fixture，于是全量 `nx test server` 打出 24 条假红（另 4 条在 `marketdata.eod-pipeline-core.it.spec.ts`，卡 `earnings_event` 占位 executor，属 **T019** 不在本条范围）。修法**逐处按断言本意分流**：① 断言本意是**钉死清单**（seed 维度序 / 依赖边全集 / 表名全集 / tick fired 序 / 派生执行序）→ **更新为新真值**，保持继续承重；② 断言只是**凑一个数**（`toHaveLength(25)` 只为确认「读到了东西」）→ 改为从 `DIMENSION_KEYS` 派生，下次加维度不再假红。🚫 **MUST NOT 为让它绿而弱化断言**（`>= 25` / 删断言 / `.skip` 一律禁）；🚫 **MUST NOT 借机改动与维度数无关的代码或测试**（Surgical Edits）；🚫 边数**不得**从 `DIMENSION_KEYS` 派生（边与维度非一一对应，28 == 28 是巧合）→ verify: 全量 `nx test server --skip-nx-cache` 红数从 28 降到 **仅剩 `earnings_event` 占位那一族**；**判定手法 = 临时把 `earnings_event` executor 打成 no-op 桩跑一轮，必须全绿**（证明剩余红 100% 是 T019 的、且本条无遗漏），跑完**立即还原桩**（产品代码零 diff）+ `nx lint server` + `nx typecheck server` + `check-server-moat.ts` + `check-test-size.ts` 全绿

- [X] T004 [P] [Server] **档位判定纯函数**（FR-018/022, plan D-SOT-1/D-SOT-2）：`optionsdesk/leg-tier.rules.ts` —— 六个边界值**具名常量导出**（年化 15/10/5、周化 2/1/0.6，Guardrail 13）；`classifyTier(bidRate, basis)` → `好 | 可接受 | 薄 | 死档`；**口径恒为 `bid`、分母恒为准备金 `K − P`**；薄档额外产出该行的 `ask` 口径值供呈现（D-SOT-2 定案）。复杂度 O(1)。🚫 **`ask` MUST NOT 参与判档**→ verify: `leg-tier.rules.spec.ts`（Small）—— 两个口径各四档 + **六个边界值恰好落哪一档确定**（15.0 / 10.0 / 5.0 / 2.0 / 1.0 / 0.6，不得两档都亮）+ 薄档带出 `ask` 值 + 死线与利率环境无关（无任何利率入参）

- [X] T005 [P] [Server] **意图判定矩阵纯函数**（FR-016/021, plan D-SOT-3）：`optionsdesk/intent-matrix.rules.ts` —— **实现生成公式而非九宫格查表**（SoT 明写「改规则先改公式再重渲染，禁逐格手改」）：`m = d − (l − 1)`，`d`：卖put区 0 / 买区 1 / 深买区 2；`m ≥ 1` → 前 `m` 个 1/3 水位档为建仓腿、其后收租从贴ATM侧起步；`m ≤ 0` → 无建仓授权、收租起步深度 `|m|` 档；收租段内每跨一个水位档 Δ 深度加一档（贴ATM侧 → 中度 → 深度，深度为地板）；L3 不走建仓网格（本片恒判收租）。区间映射 `deep_buy→深买 / buy→买 / thin+expensive→卖put / overvalued→不动区`；**不开新仓 ⟺ `overvalued` 或 L4**；**水位为 `null` → 输出「待定」而非任何档位**。复杂度 O(1)。⚠️ **区间系数一律 `import` 自 `anchor.rules.ts`**（Guardrail 13）→ verify: `intent-matrix.rules.spec.ts`（Small）—— **把 SoT 第四章那张 3×3 表逐格作为期望值断言**（L1/L2/L3 × 卖put/买/深买 × 三个水位档，公式对不上表即红）+ `overvalued` 与 L4 恒「不开新仓」+ 水位 `null` 恒「待定」+ `thin` 与 `expensive` 输出相同（同属卖put区）

- [X] T006 [P] [Server] **腿派生纯函数**（FR-003/004/018/041, plan D-API-2/D-UI-3/D-SOT-5）：`optionsdesk/leg-derive.rules.ts` —— ① 周化 / 年化 / 折年（分母 `K − P`；折年**仅作周化行参照**，不作决策变量、不作排序键）② 有效成本 `K − P` 相对 W 的位置 ③ **σ 距离 `σ = −Φ⁻¹(|Δ|)`，`Φ⁻¹` 用 Acklam 有理逼近**（约 20 行纯函数，O(1)，绝对误差 < 1.15e-9，定义域开区间 `(0,1)`；**零新依赖**）④ 活跃度（整数档优先 + 当前候选集内 `OI` 与 `Volume` 各自排名之和取 Top 3，**不用全链 Top-N / OI 中位 / V/OI**）⑤ 成交额 = `Vol × 权利金 × 100`。🚨 **σ 距与 Δ 必须同源**（Guardrail 10）→ verify: `leg-derive.rules.spec.ts`（Small）—— **property 断言：随机 1000 个 `|Δ|` 往返 `σ → |Δ|` 误差 < 1e-6** + `|Δ| ∈ {0,1}` 两列同时返 `null` + 折年与周化在同一行的比例关系 + 活跃度取的是**相对排名**不是绝对阈值 + 候选集只有 1 条时不炸

- [X] T006a [Server] **请求时 DTE 的日期基准（跨时区语义落地）**（FR-041/048, plan D-API-2；canonical = [`docs/conventions/cross-timezone-date-semantics.md`](../../docs/conventions/cross-timezone-date-semantics.md) §3 + §4）：`marketdata/trading-day-gate.ts` 新增 `daysToExpiry({ expiry, now })` —— 基准恒为 `marketDateFor(['us'], now)`（**交易所的今天**），整数日历日含周末与节假日、到期日当天 = 0、已过期为负（🚫 不 clamp，0 已被「当天到期」占用）；`expiry` 只收 `YYYY-MM-DD` 或 `@db.Date` 读出的 UTC 午夜 `Date`，**收带时间的绝对时刻直接抛**（堵 canonical §3 那个「同一函数身兼两职」的陷阱）；`now` 收 instant 而非算好的 `today` 字符串 —— 后者等于把「跟谁的今天」推回给调用方，正是本条要消灭的形态。**落 marketdata 而非 optionsdesk 是硬约束**：消费方跨两侧（T027 / T033 在 optionsdesk，T024 的 `DTE ≤ 2` 豁免线在 `marketdata/option-anomaly.rules.ts`），而 marketdata MUST NOT 依赖 optionsdesk（ADR-0032 单向边界）⇒ 放 optionsdesk 会逼 T024 自己再写一份基准；`trading-day-gate.ts` **不是** `*.rules.ts` ⇒ optionsdesk 可直接 import，不触 Guardrail 14 围栏，**零 allowlist 改动**。🚫 **MUST NOT 改 `DAYS_PER_YEAR`**（`leg-derive.rules.ts` 已取日历年 365，与本条同口径）；🚫 MUST NOT 动采集侧已 ship 的 `marketDateFor(dim.marketScope, input.now)`（那侧口径本就对）。复杂度 O(1)。→ verify: `trading-day-gate.spec.ts`（Small）—— 🚨 **注入 `now` = 北京某日 10:00（= ET 前一日）断言 DTE 走 ET 日期而非上海日期**（缺这条，基准差一天不会有任何东西报错，canonical §6 第 5 问）+ 同一 ET 日内任意时刻 DTE 恒定（禁绝对时刻差的机器判据）+ 到期日当天 = 0 + 周五 → 周一 = 3（跨周末不跳过）+ 已过期为负 + **DST 回拨窗（73 绝对小时）逐 ET 日仍整数递减 1** + 溢出日 / 非法格式抛而非静默 NaN

- [X] T007 [P] [Server] **落库前自洽硬门纯函数**（FR-043/044, plan D-DATA-7）：`marketdata/option-snapshot-guard.rules.ts` —— `bid ≤ ask`；PUT `Δ ≤ 0` / CALL `Δ ≥ 0`；`|Δ| ≤ 1`；**无套利下界 `ask ≥ 内在价值 − 容差`**（Guardrail 1，容差落顶部具名常量）。返回逐行判定 + 违规原因，**不抛异常**（调用方逐行拒绝而非整批回滚）。复杂度 O(n)。→ verify: `option-snapshot-guard.rules.spec.ts`（Small）—— 四条门各一个正例一个反例 + **一条 `bid` 跌破内在价值但 `ask` 未跌破的实值腿必须放行**（这条正是 FR-044 存在的理由，写反了这里就红）+ CALL 与 PUT 的 Δ 符号门方向相反

- [X] T007a [Server] **SC-010 真实样本回放（补上 SC-010 的实装）**（FR-043/044, SC-010, plan Gate 0.1 / D-DATA-7）：plan Gate 0.1 承诺「落库前自洽硬门用**已采的真实样本回放**跑 SC-010 零误拦，**不用合成数据** —— 合成数据造不出『做市商让 bid 跌破内在价值』那几百行」，但 SC 矩阵把 SC-010 记在 T007·T017 名下而**两者的 verify 都是 hermetic**（手写正反例 / mock vendor）⇒ **记账式归属、零实装**。本条补实装：从本机已采样本（`~/futu-screener/eod_snapshots/eod.sqlite` 的 `chain_snapshot`，**3.3 MB sqlite 不入仓**）导出 `checkOptionSnapshotRows` 用得到的**七列** + 一个 session 落 `apps/server/src/marketdata/__fixtures__/`（**CSV 不 JSON**：同批数据 CSV 120 KB / JSON 对象数组 340 KB，且逐行可 diff；字段全是裸数字与合约代码、无引号无逗号 ⇒ `split(',')` 足够，**零新依赖**；导出走 `sqlite3` CLI，不引 sqlite runtime 包）。🚨 **fixture MUST 含「bid 跌破内在价值但 ask 未跌破」的那批实值腿**，且测试**显式断言其条数 > 0** —— 这是整条 task 的意义：没有这条，fixture 哪天被裁成「反正都合规」的一批，上面那句「零误拦」就退化成空洞的真命题而无人知晓。🚫 反向验证（把下界临时换成 `bid`）是**一次性实证**，**MUST NOT 把 bid 口径留在测试代码里**。🚫 `option-snapshot-guard.rules.ts` 文件头记的「2138 行 / 706 违规」是 p3b 分析期的**冻结决策记录**，不回改（本条在 spec 侧注明两者关系即可）→ verify: `option-snapshot-guard.rules.spec.ts`（Small，读同仓 colocate 只读 fixture，同 `portfolio/holdings-xlsx.parser.spec.ts` 先例）—— **2150 行真实样本零误拦**（SC-010）+ 行数断言在册（防裁剪）+ 「bid 跌破 / ask 未跌破」条数 = 702 且 > 0；**一次性反向验证实测**：下界换 `bid` → 同一批当场误拦 **702 行**（全部 `ask_below_intrinsic`），换回即 0，跑完立即还原（产品代码零 diff）

- [X] T008 [P] [Server] **链发现贪心分窗纯函数**（FR-029/032, plan D-DATA-2）：`marketdata/option-chain-window.rules.ts` —— 到期日列表 → **窗口序列（每窗跨度 ≤30 天，窗含首尾到期日本身）**；滚动推进用「上一组末到期日 + 30 天」，**MUST NOT 手算 as-of 链**（E38 定论 2 的纪律）；另出 `gapCheck(发现到的到期日集合, vendor 返回的到期日集合)` → 差集。复杂度 O(n)。→ verify: `option-chain-window.rules.spec.ts`（Small）—— 稀疏远月（5–12 月 8 个到期日）产出 **5 个窗**（p3b 实测基线）+ 密集周期权段每窗不超 30 天 + **窗口首尾相接无缝无叠、并集 = 输入全集**（这条是「腿静默消失」那类 bug 的唯一机器拦截）+ 空输入 / 单到期日 / 恰好 30 天边界

- [X] T009 [Server-IT] **Phase 1 schema IT**（FR-028/028a/030/034/040）（共享 PG · **`setupEmptyDb()`**——本条自己跑 `migrate deploy` 并验证其产物，正是该入口的适用条件；**禁自起 Testcontainers**，Guardrail 17）：`migrate deploy` → 三表 + 锚表两列存在 + 三个幂等键生效（重复插入撞 P2002 = 幂等语义载体）+ **快照三个时点列可各自独立取值**（`oi_as_of ≠ session_date` 的行可落库）+ **合约表无「是否已到期」列**（FR-028a 的反向断言）+ 三行 `SyncDimension` seed 在册 + `check-server-moat.ts` 0 违规。`apps/server/test/integration/optionsdesk-047.schema.it.spec.ts`。**样板 = `optionsdesk-046.schema.it.spec.ts`**

---

## Phase 2: futu-shim 期权链 + 财报端点（FR-039, plan D-SHIM）

- [X] T010 [Shim] **`/option-expirations` + `/option-chain`**（FR-039, plan D-SHIM）：`services/futu-shim/src/futu_shim/app.py` 加两条路由 —— 前者单 code 返全部可得到期日（capability `expiration_date`，60/30s）；后者单 code + 到期日窗返合约静态属性（capability `option_chain`，**10/30s 官方真值，Guardrail 5**），**窗 > 30 天直接 400 拒绝、绝不截断**（照 `/kline` 超 8 页 400 的先例）；`option_type` 默认 `ALL`（Guardrail 3）。protobuf → JSON 映射落 `mappers.py`。→ verify: `services/futu-shim/tests/` pytest —— 窗 31 天返 400 且 body 说明原因 + 限频闸对第 11 次调用返 429 + `Retry-After` + 鉴权缺失返 401（常量时间比对）+ mapper 对非标 root（如 `VICI1`）不丢字段

- [X] T011 [Shim] **`/option-snapshot` + `/earnings-calendar`**：前者批量 codes 返报价 + 全 greeks + IV + OI + 净OI + Vol + 标的 spot + vendor 时间戳（capability `snapshot`，60/30s，**> 400 codes 直接 400 拒绝**）；后者市场级、**≤7 天窗，超窗 400**。→ verify: pytest —— 401 codes 返 400 + 8 天窗返 400 + 限频 429 + greeks 整块缺失的行**照常返回且带完整性标记**（不在 shim 侧丢弃，FR-007 的上游保证）

- [X] T011a [Shim] **`earnings_calendar` 限频按官方值登记**（FR-039, plan D-SHIM）：`services/futu-shim/src/futu_shim/ratelimit.py` 的 `LIMITS` 表补 `"earnings_calendar": (60, 30)` —— 官方原文「接口限制：30 秒内最多 60 次请求；分页请求仅首页计入限频统计」（2026-08-04 直取 `openapi.futunn.com` 复核），照既有条目体例在紧邻处注明原文 + 出处 + 复核日期；同步订正 `/earnings-calendar` docstring 里「本片不改 `ratelimit.py`、留给下一片」那段（补登后即 stale）。它原本落在最严兜底 10/30s = **6x 偏严**，与 `history_kline` 08-01 那次同形状、反方向（偏严只让调用方吃 429 被延迟重入队，不丢数据，故不是事故）。🚫 **只动这一个 capability**：`option_chain` / `snapshot` / `expiration_date` / `history_kline` 等既有档位一个字不改（Guardrail 5）→ verify: pytest —— `LIMITS["earnings_calendar"] == (60, 30)` 且 `!= FALLBACK_LIMIT` + 默认 gate（非注入档位）下 `/earnings-calendar` **第 61 发**才 429、第 11 发仍 200 + 既有档位断言全绿

- [X] T012 [Shim] **`/healthz` 暴露已注册路由集合 + 部署**（FR-039）：`/healthz` 除 `version` 外增 `routes` 数组（**公开、永不触发 OpenD**）；跑 `deploy/install.sh` 部署到港 ECS。🚨 **Guardrail 15：`/healthz` 绿 ≠ 端点在** ⇒ 部署后**逐个实打四个新端点**→ verify: `/healthz.version == 本次 SHA` **且** `routes` 含四个新路径 + 从 77 经隧道对四端点各打一发真请求返 200（非 404）+ pytest 断言 `routes` 与 Flask `url_map` 一致（漏注册即红）<br>📌 **实装归属更正**：`routes` 字段与「`declared ⊆ registered`」那道部署自检闸**不是本片做的**，是 `61e5b7d1`（PR #849，2026-08-03）先落的 —— 本片四条新路由用的都是 `@app.get("/字面量")` 形状，被该闸**自动覆盖，无需同步任何清单**。⚠️ 反过来：若将来用 `@app.post` / `@app.route` 写新端点，`declared` 会**变小而不是变错**，子集比较照样通过 —— 修法是同步 `remote-deploy.sh` ② 的 grep 模式，**绝不是放宽那条守模式的测试**。<br>📌 **shim 已先行拆 PR 上线**（PR #875，squash = `e7a60c1c`）：047 的 shim 子集（T010/T011/T011a）单独提 PR 合入 main 并触发 `deploy-futu-shim.yml` 自动部署，使下游调用方不必等整片 feature 完成。🚨 **该 workflow 是「合入 main 即部署生产」**（`push: branches:[main] paths: services/futu-shim/**`）⇒ 这类 PR 的 **merge 时机 = 部署时机**，不适用「AI 默认接 auto-merge」那条通用约定。

- [X] T013 [Server-Vendor] **真 vendor 探针扩既有文件**（SC-009, plan D-SHIM）：**扩** `apps/server/test/integration/marketdata.futu-shim.vendor.spec.ts`（**别新建文件、别新造 flag**，Guardrail 17）——四个新端点各一发真调用 + **单轮墙钟计时**（12 条锚规模，对照 SC-009 的 15 分钟门）+ 记录链发现实际调用次数（校验「10–14 次/票」的估算）。⚠️ 该门 `RUN_MARKETDATA_IT` 默认 skip ⇒ **数得手工跑一次才有**→ verify: 手工跑一次，把实测调用数与墙钟写进本 task 的 commit message；四端点均返 200 且字段非空

---

## Phase 3: US1 采集 — 链发现 + 逐日快照（P1）

- [X] T014 [P] [Server] **期权链 port + futu-shim adapter**（FR-039, plan D-SHIM）：`marketdata/option-chain.port.ts`（capability-scoped，沿既有 26 port 惯例）+ `futu-option-chain.adapter.ts`（到期日 + 链）；限频 profile 按官方值写进 `futu-shim.constraint-profile.ts`（**`option_chain` 10/30s，Guardrail 5**）；失败语义显式、429 → `budgetExhausted` 延迟重入队不耗 attempts。→ verify: `futu-option-chain.adapter.spec.ts`（Small，mock HTTP）—— 429 映射成 `budgetExhausted` 而非 failure + 400（窗越界）映射成不可重试失败 + 非标 root 照常返回

- [X] T015 [Server] **链发现维度 usecase**（FR-028/028b/029/032/033/035/036/037/038, plan D-DATA-2/3/8）：`marketdata/sync-option-contract.usecase.ts` —— 工作集取**锚白名单**（继承 `need_sync` 采集闸）；每票先取全部到期日 → T008 贪心分窗 → 逐窗调链；**`option_type = ALL`（Guardrail 3）、不设行权价带、不设到期日上限（含 LEAPS）**；落 `is_standard` 判定；**非标照常全采落库**（Guardrail 4）；业务日期按 **us 时区 A′**（`marketDateFor`）；**FR-028b 兜底 seed**：已建锚但 `Instrument` 无行 → 幂等 upsert（**兜底不是主路径**，`universe` 仍是正规通道）；幂等 upsert 同日重跑不产生重复行；跑完做 T008 的 `gapCheck`。→ verify: `sync-option-contract.usecase.spec.ts`（Small，mock port）—— 零锚时对 port 的调用数为 **0** + 新增锚下一轮自动进工作集（无代码改动）+ `option_type` 传的是 `ALL` + gapCheck 有差集时上抛而非静默

- [X] T016 [Server] **快照 port + adapter + 逐日快照维度 usecase**（FR-030/031/032/037/040/043/044, plan D-DATA-3/4/5/7）：`option-snapshot.port.ts` + adapter（≤400 codes 分批）+ `sync-option-snapshot.usecase.ts` —— **hard 依赖链发现**（无合约表即不跑）；工作集 = 该票**到期日 ≥ 当前交易日**的全部合约（FR-028a）；**逐行过 T007 硬门，违规行不入库 + ERROR，已落历史不受破坏**；落库时 `source = eod` · `session_date` = 当前 us 交易日 · `quote_as_of` = 采集时刻 · **`oi_as_of` = 上一交易日**（Guardrail 6）。→ verify: `sync-option-snapshot.usecase.spec.ts`（Small）—— 无合约表时不发请求 + 硬门违规行被拒且其余行照常入库 + **`oi_as_of` 落的是上一交易日而非 `session_date`** + 401 codes 被切成两批 + 同日重跑幂等

- [X] T017 [Server-IT] **链发现 + 快照 IT**（FR-031/032/033/035/036/037/038/043, `setupIsolatedDb()`）：真 PG + mock vendor —— ① 零锚 → 两个维度跑绿、请求数 0、无假红告警（state_branch 21）② 新增锚 → 下一轮自动纳入（SC-005）③ 快照 hard 依赖链发现 ④ 非标合约落库成功（选约层排除留给 T029）⑤ 同日重跑零重复行 ⑥ 业务日期按 us 时区（**跨周五验一次**，防「每周固定丢周五」）⑦ 硬门违规行不入库且历史行不被破坏。`optionsdesk-047.chain-sync.it.spec.ts`

---

## Phase 4: US1 采集 — 财报日历 PIT（P1）

- [X] T018 [P] [Server] **财报日历 port + adapter**（FR-034, plan D-SHIM）：`marketdata/earnings-calendar.port.ts` + `futu-earnings-calendar.adapter.ts`（≤7 天窗）。→ verify: `futu-earnings-calendar.adapter.spec.ts`（Small）—— 窗越界前置拒绝 + 空窗返空数组不报错 + 三态（确认/预估）字段映射

- [X] T019 [Server] **财报维度 usecase + PIT diff**（FR-026/027/034/035a/035b/036/037, plan D-DATA-1/D-DATA-9/D-DATA-8）：`marketdata/sync-earnings-event.usecase.ts` —— 🚨 **不挂锚闸**（Guardrail 2），工作集 = **固定前向时间窗序列**（按 ≤7 天窗覆盖 vendor 可得视野，约 26 次调用/天，与锚数量无关）；**每日重拉整个前向视野**（不是只拉增量窗——PIT diff 要发现的是「已公布的日期被改了」，只拉新窗永远看不到旧窗的改动）；**全市场落库**（`first_seen_at` / `date_changed_at` 只有连续观察才成立）；与前一日 diff → 日期变化时记变更前日期 + 变更时刻 + 进 WARN 复核名单；**标的不在 `Instrument` 表内 → 跳过并计数**，计数上抛作监控信号（**MUST NOT 为规避 FK 改幂等键**）。→ verify: `sync-earnings-event.usecase.spec.ts`（Small）—— **零锚时照常发请求并落库**（FR-035a 反向守卫）+ 锚从 12 增到 100 调用数**不变**（SC-006a）+ 日期变更被记录 + 匹配不上的标的被跳过且计数正确 + 同日重跑幂等

- [X] T019a [Server] **财报窗宽常量按真 vendor 实测收到端点差 6**（FR-034, plan D-SHIM / D-DATA-9）：`marketdata/earnings-calendar.port.ts` 的 `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS` **7 → 6**。🚨 **修的是一个活着的生产缺陷**：2026-08-07 经 77 → wg1 隧道打真 shim 实测 —— 端点差 5 / 6 → **200**；端点差 7 → **502 `NN_ProtoRet_SvrFailed`**；端点差 8 → shim 自己的 400「window too wide」；差 7 在 **08-07 / 09-02 / 10-19 三个相隔一个多月的 start 上 3/3 复现**（不是抖动）。⇒ vendor 原文「与 beginDate 间隔不超过 7 天」说的是**含首尾的 7 天窗**（端点差 ≤ 6），而该常量按**端点差**读、宽了整一天，于是 `planEarningsWindows` 发出的**每一个**窗都恰好差 7 ⇒ 财报采集**窗窗 502**，且 502 映射成瞬时错误会一路重试 / 顺延，**永远不以「参数错」的形状说出来**，只表现为「财报维度一直很慢」。**窗数 26 → 31**（视野 182 天不再被窗宽整除 ⇒ `planEarningsWindows` 末窗**夹紧到视野末端**：越出视野的那几天落在 `loadExistingRows` 取数区间外，会被每日当成「第一次见」重新 diff，PIT 三件套失真且不红）；市场级 60/30 s 限频下 +5 次调用可忽略。📌 **挂账**：shim 侧同名约束 `EARNINGS_MAX_SPAN_DAYS = 7` 同样偏宽（本该在 shim 就 400、现在漏到 vendor 变 502），属**已上线服务**，待**随下次部署单独 PR 收紧**；在此之前 server 侧严于 shim 侧是刻意的。→ verify: `sync-earnings-event.usecase.spec.ts`（Small）—— 窗序列每窗端点差 ≤ **实测值 6**（该判据**蓄意不引用**上述常量：常量是被实测校准的一方）+ 末窗恰好收在视野末端 + 窗数与调用数**由常量派生**（`Math.ceil(视野 / 窗宽)`，常量再变不用改数字）；`futu-earnings-calendar.adapter.spec.ts`（Small）—— 边界窗日期同样由常量派生，超一天仍前置拒绝且零外呼；SC-006a「锚 12 → 100 调用数不变」**仍成立**（窗序列只由业务日期推导）；真端回归锚 `marketdata.futu-shim.vendor.spec.ts`「端点差 7 不可用」**耐久形状不变**（修前不可用因 vendor 502、修后不可用因 adapter 本地前置拒绝，零外呼；vendor 哪天真放宽到 7 才会红）

- [X] T020 [Server-IT] **财报 PIT IT**（FR-026/027/035a/035b, SC-006a, `setupIsolatedDb()`）：真 PG —— ① 零锚 → 该维度照常跑并落库（state_branch 22）② 全市场落库（非白名单标的的行确实在库）③ 连续两日不同日期 → PIT 三件套正确 ④ `Instrument` 表外标的被跳过、FK 未破、计数可读（state_branch 23）⑤ **新建锚的票其财报数据建锚当刻即在库**（FR-038 的更强保证）。`optionsdesk-047.earnings-pit.it.spec.ts`

---

## Phase 5: US1 数据质量四层防线（P1）

- [X] T021 [Server] **完整性核对：逐合约覆盖率**（FR-045, plan D-DATA-6）：`marketdata/option-snapshot-coverage.check.ts` —— **分母 = 上一交易日快照里、到期日 ≥ 当日交易日的合约集**（Guardrail 7）；分子 = 当日实得快照的合约数；**逐票汇总**（指明掉的是哪一票、缺了哪些合约），**MUST NOT 只看全局总数**（PEP 730 行足以盖住 VICI 48 行整票消失）；阈值**配置化，先验起手 100%**；**零锚 / 分母为空 → 判「无对象」不告警**。🚫 **MUST NOT 用交易日历打「今天是大到期日所以放宽」的补丁**（循环信任，044 同款）。复杂度 O(n)。<br>📌 **本 task 的产出是「判定 + 逐票明细 + 结构化 ERROR log」（沿 `alertIfDegraded` 的 log-based alerting 范式），不是触达** —— **触达归 T025a**（Guardrail 16）。→ verify: `option-snapshot-coverage.check.spec.ts`（Small）—— 整票缺席 → ERROR + 一批存续合约无数据 → ERROR + **大到期日次日（上一交易日一批合约当日已到期）→ 不告警**（SC-002 第 ③ 向，假阳性守卫）+ 分母为空 → 不告警 + 阈值可配

- [X] T022 [Server] **两级自动补救**（FR-046/052, plan D-DATA-4/5）：① **当日重试** ② **次日美股盘前窗口（北京 16:00–21:30）兜底重采一次**，补采行落 `source = premarket_backfill` · `session_date` = 被补的那一天 · `quote_as_of` = 实际采集时刻 · **`oi_as_of = session_date`**（盘前 OI 已翻新，正是被补那天的真值，Guardrail 6）；两级都失败才升 ERROR（**触达由 T025a 承载**，Guardrail 16）；**「本日数据来自兜底补采」MUST 留痕 + 告警**（否则「一直靠兜底续命」会被静默掉，FR-052），留痕形态 MUST 是**可被 SQL 读到的行状态**（`source = premarket_backfill` 本身即是），而非只落 log —— 否则 T025a 那条独立进程的探针看不见它。→ verify: `option-snapshot-remediation.spec.ts`（Small）—— 一级成功不进二级 + 二级成功不升 ERROR **但产出降级留痕** + 两级都失败升 ERROR + 补采行的 `source` 与 `oi_as_of` 与正常行**可区分**（**且该区分是 SQL 可查的，不依赖读 log**）

- [X] T023 [Server-IT] **完整性 + 补救 IT**（SC-002 三向 · SC-011 双向, `setupIsolatedDb()`）：真 PG 注入故障 —— ① 整票缺席 → ERROR ② 一批存续合约当日无数据 → ERROR ③ **回放真实大到期日次日 → 不告警** ④ 零锚 → 不告警 ⑤ 收盘后整体失败 + 次日盘前兜底跑通 → 补齐且不升 ERROR **但有痕** ⑥ 两级都失败 → 升 ERROR 且指明哪一票哪一天。**⑤⑥ 两个方向都验才算这道防线成立**（单向验只能证明它会响，证不了它不乱响）。`optionsdesk-047.integrity.it.spec.ts`

- [X] T024 [P] [Server] **异常监控三条**（FR-047/048/049, plan D-ARCH-3）：① **greeks 缺失只在虚值区 WARN**——实值区缺失是数学固有现象（bid 跌破内在价值 ⇒ IV 无解，实测 227/2150 行、99.5% 是深实值腿、虚值区零缺失），**MUST NOT 告警、MUST NOT 计入指标** ② **IV 离群判定结合 DTE**（实测 3/2150 的 >500% 全是 DTE=1 宽价差，属预期）③ **新的非标 root 出现 → WARN 复核名单**（意味着某白名单票发生了并购类公司行为）。→ verify: `option-anomaly.rules.spec.ts`（Small）—— 深实值缺 greeks **不**告警 + 虚值缺 greeks 告警 + DTE=1 的 600% IV 不告警而 DTE=60 的同值告警 + 首见 `VICI1` 类 root 进名单、次日同 root 不重复报

- [X] T024a [Server] **异常监控接线（补 T024 的调用方）+ 「已见过的非标 root」持久化载体**（FR-047/048/049, plan D-ARCH-3）：T024 的 `marketdata/option-anomaly.rules.ts` ship 时**零调用方** —— 三条判据写好了却不生效；且 ③「次日同 root 不重复报」按设计**要求调用方持久化并回传已见过的 root 集合**（`knownNonStandardRoots` 入参 / `newNonStandardRoots` 出参），无调用方时该语义根本不成立。接线点 = `marketdata/sync-option-snapshot.usecase.ts` 的 `collect()`：**本轮全部落库行**累积成一批 → 收尾跑一次 `detectOptionAnomalies` → findings 逐条 `logger.warn`（顺既有 `reportRejected` 的上报形态，**MUST NOT 另造上报通道**）。🚨 **持久化载体不新建表、不加列** —— 已见过的非标 root **从既有两表派生**：`option_contract.is_standard = false` **且** `snapshots: { some: {} }`（该 root 已有过快照行）。⚠️ **只查 `option_contract` 会静默失效**：链发现是快照的 hard 前置（FR-031），同一夜里新 root 早已落合约表 ⇒ 「首见」恒为空、③ 永不触发且永不会红；把记忆钉在**快照历史**上才与判定面同一 population。集合**在本轮落库前取一次** ⇒ 同日重跑（今日行已在库）与次日（昨日行在库）都静默，正是 T024 要的语义。🚫 判定面 = **落库行**而非 vendor 原始行（被硬门拒的行已由 T016 出 ERROR，再进 WARN = 同一件事报两遍，且那些行不会进快照历史 ⇒ 记忆面与判定面就此错位）。🚫 本条是 WARN 线，**不碰** FR-046 的当日触达（Guardrail 16 的载体恒为 T025a）；🚫 **MUST NOT 改 T024 已定的三条口径**（greeks 聚合式至多一条 finding / 整批零可用只出 `greeks_batch_unavailable` / 入参蓄意不收 `greeksComplete` / 实值区缺失既不进 findings 也不进 metrics）→ verify: `sync-option-snapshot.usecase.spec.ts`（Small）补断言 —— 一批含「深实值缺 greeks + 虚值缺 greeks + DTE=1 高 IV + 新非标 root」的行**只**产出 `otm_greeks_unavailable` + `new_nonstandard_root` 两条（实值缺失与短 DTE 高 IV 各自静默）+ **同一 root 第二轮不再报**，且第二轮的 known 集合是由第一轮落的快照行喂回来的（**证明持久化通路真的闭合**，不是测试里手填一个数组）+ 零落库行时零 WARN


- [X] T025 [Ops] **表级探针扩三维度 + 磁盘水位告警**（FR-050/051/052a, plan D-ARCH-2/D-ARCH-4）：`ops/jobs/marketdata-table-health.sql` 加三个新维度的**数据年龄**判据（判据挂**数据**不挂 run；探针**独立于采集进程**运行）；新增磁盘水位判据——**阈值 = 当前可用空间 − (实测日均增长 × 90 天)**，日均增长在数据满 10 个交易日后由探针滚动计算并回写（**MUST NOT 拍百分比**，FR-052a）。🚨 **本片必须同步扩，MUST NOT 等下一片**（M2a 那次漏做、隔日才补）→ verify: 真跑该探针脚本（独立进程，非采集进程内）+ 三个新维度各造一次「跑了但少采一半」看是否亮 + 磁盘判据在人造低余量下亮 + `marketdata-sync-report.sh` 解析不炸

- [X] T025a [Ops] **完整性 ERROR 的「当日触达」载体**（FR-045/046/051, plan D-ARCH-2）：新建 `ops/jobs/marketdata-snapshot-integrity.{sh,sql}` + `ops/jobs/systemd/marketdata-snapshot-integrity.{service,timer}`（**照 `ops/jobs/marketdata-table-health.{sh,sql}` 范式逐条抄结构**）—— `marketdata-snapshot-integrity.sql` 直读 PG 算逐合约覆盖率（**不经 app 进程**：app 整个挂掉、数据自然缺失 → 照样告警）+ `marketdata-snapshot-integrity.sh` 非零退出码 + `systemd/marketdata-snapshot-integrity.service` 走 `nvy-run-reported <label> --on-success silent -- jobs/marketdata-snapshot-integrity.sh`（飞书推送由 wrapper 据退出码统一推，脚本零飞书 I/O）+ `*.timer` **排在当晚采集窗结束后**。<br>🚨 **这条是 FR-046「ERROR 触达 MUST NOT 并入次日日报」的唯一载体**（Guardrail 16）：次日日报 = 次晨 09:00 的 `ops/jobs/marketdata-sync-report.sh` 读 `sync_run`，本 timer 与它**完全解耦**。<br>⚠️ **已知代价（同判据两处实现）**：T021 的 TS 判定要的是**逐票明细 + 可注入故障的 IT**，本条的 SQL 要的是**独立于采集进程**（FR-051）。两者判据必须同源 —— verify 段用同一批人造数据把两边钉在一起。→ verify: 真跑该探针脚本（独立进程）+ **同一批人造缺失数据下，SQL 判定与 T021 的 TS 判定结论逐票一致**（同判据的机器绊线）+ 整票缺席 / 一批存续合约缺失 → 非零退出 + 大到期日次日 → 零退出 + 分母为空 → 零退出 + 探针自身故障（PG 不可达）**也**非零退出（沉默 ≠ 健康，044 病灶形状）

---

## Phase 6: US2 / US3 / US4 读端（P2 / P3 / P4）

- [X] T026 [Server] **财报打标派生**（FR-023/024/025/026/034, plan D-UI-4）：`optionsdesk/earnings-mark.rules.ts` —— 签名 `earningsMark(symbol, expiryDate, legFamily)`，**不接受合约级输入**（Guardrail 11 的结构保证）；调用方**先按到期日分组算一次再贴回该组所有行**；输出四值 —— `覆盖 ✓` / `缓冲不足 +Nd` / `跨财报 ⚠` / `无日期`，**建仓腿恒 `null`（无标）**（`null` 与「无日期」是两个值）；缓冲**只约束「最后利空 → 到期」一侧**；**超 vendor 前向视野 → 「无日期」不是「不跨」**（Guardrail 12）；全部为提醒语义，**零拦截 / 零置灰 / 零禁选**。复杂度 O(n)。→ verify: `earnings-mark.rules.spec.ts`（Small）—— **同一到期日的多条腿必得同一个标**（含死档行，FR-006）+ 建仓腿恒 `null` + 无财报数据 → 「无日期」且可与「已确认不跨」区分 + 到期日 529 天（超视野）→ 「无日期」+ 缓冲判定只看单侧<br>📌 **值域订正（2026-08-07 T039 回写，spec FR-026 / plan D-UI-4 已同步）**：本行原写「输出四值」，**实装是 5 值 + `null`** —— 多出来的是 **`no_cross`「不跨」**（已确认不跨财报，呈现面 = **无 chip 的纯文字**）。四值凑不出验收：FR-026、US4-AS5、`state_branches` 第 12 条三处都要求「无日期」必须可与「**已确认不跨**」区分，而「已确认不跨」在四值里没有自己的值、只能靠留空表达，留空又同时背着「无日期」与「建仓腿无标」。五形态各自的呈现面 = `null`「—」/ `no_cross` 纯文字 / `no_date` 虚线 chip / 其余三值 chip。<br>📌 **两个策略常量同期由 user 拍板并落具名常量**：`EARNINGS_BUFFER_MIN_DAYS = 7`（覆盖 ✓ 与 缓冲不足 的分界，`+Nd` 的 N = **还差几天**）· `RENT_SHORT_MAX_DTE_DAYS = 28`（收租长 / 短腿分界，落 `leg-tab.rules.ts`；⚠️ 与 D-SOT-4 收租 Tab 的 `DTE ∈ [150, 365]` 是两件事，别合并）。

- [X] T027 [Server] **选约表读端点**（FR-002/003/005/008/013/019/041/053/054, plan D-API-1/D-API-2/D-ARCH-1）：`GET /v1/optionsdesk/underlyings/:symbol/legs` —— 一次返**全量适格腿**（已滤非标 FR-008 + 已到期 FR-028a 的 `到期日 > 当日`，**注意与 T021 分母的 `≥` 故意不同，Guardrail 7**），**零分页零 top-N 截断**；每腿带 `basis` / `tier` / `intent` / `earningsMark` / 完整性标记 / 全部派生值（**`earningsMark` 消费 T026 的纯函数 ⇒ 本 task 硬依赖 T026，二者不可并行**）；派生**请求时算**（复用 045 `anchor.rules.ts` 的 W / 四区间 / L 层 / 愿卖锚，**不重写**）；读三张 marketdata 表走 **Q7-B 只读直查 + `// CROSS-CONTEXT-READ: <数据范围 + 只读>` 注释**（`check-server-moat.ts` 机器强制），**MUST NOT `@Inject()` marketdata 的 use case**；**MUST NOT import `marketdata/*.rules.ts`**（Guardrail 14）；区块级 `asOf` + **OI 列单独带 `oi_as_of`**（Guardrail 6）；DTO 的 nullable string 字段 `@ApiProperty` 显式 `type: 'string'`。→ verify: `get-legs.usecase.spec.ts`（Small）—— 非标不出现 + 已到期不出现 + 死档在结果里且排最后 + greeks 缺失行**在结果里**且不判档不着色 + 全量无截断 + `nx lint server` 绿（边界规则）+ `check-server-moat.ts` 0 违规

- [X] T027a [Server][Contract][Mobile] **选约表新鲜度档改由 server 判定**（`state_branches` 第 3 条「快照非当日 → 全表照常 + 陈旧 `asOf`」的判据落地；canonical = [`docs/conventions/cross-timezone-date-semantics.md`](../../docs/conventions/cross-timezone-date-semantics.md) §5）：T027 只下发 `asOf` / `quoteAsOf` / `source`，**没有新鲜度档** ⇒ 客户端要判「陈不陈旧」只剩设备本地日期这一条路，而它对美股**恒为真**（境内用户本地日历已翻页、市场当天尚未收盘）—— 永远为真的告警等于没有告警，T034 因此只能把 `asOf` 渲成恒醒目字，两档做不出来。**判据 100% 复用 046 / `f83e6bf9` 那一套，🚫 MUST NOT 另造平行枚举**：`marketdata/freshness-tier.ts` 的 `FreshnessTier`（`CURRENT / STALE / UNAVAILABLE`）+ `optionsdesk/last-closed-session.ts` 的 `resolveLastClosedSessionForTicker`（内部走 `marketdata/trading-day-gate.ts` 的 `lastClosedSessionCutoff`，**带收盘时刻**）。① [Server] `LegTableView` 加 `lastClosedSession`、`LegTableResponse` 加 `asOfFreshnessTier`（**前缀绑定到区块级 `asOf`** —— 本响应有三个时点，裸名 `freshnessTier` 会被读成判 `quoteAsOf` 或 `oiAsOf`；🚨 `oiAsOf` 归属 T−1 是**定义如此**，拿它判档会恒 STALE）；🚫 MUST NOT 用宿主本地日期 / MUST NOT 用 UTC 日期 ② [Contract] `server:export-openapi`（走 `node dist/main.js`）→ `packages/api-client` regen ③ [Mobile] T034 的区块头 `asOf` 从「恒醒目」改为按 server 档位二分（常态 `text-ink` / 陈旧「数据截至 X · 收盘 · 非当日」走醒目 `text-warn`），⚠️ 降级状态字禁 `--nvy-text-subtle` 用 `text-ink-muted`。→ verify: `get-legs.usecase.spec.ts`（Small）—— 🚨 **注入 `now` = 境内早晨那种「本地已翻页、市场未收盘」的时刻（北京 08-05 08:00 = ET 08-04 20:00）断言当日快照判 `CURRENT` 而非 `STALE`**（缺这条这个 bug 会原样长回来）+ 落后一个交易日判 `STALE` + 日历查不到 fail-open 判 `CURRENT`（宁可漏报一次也不重演「全体恒显已过时」）+ 无快照判 `UNAVAILABLE`；`leg-picker-copy.spec.ts`（Small）—— 三档 × 文案/class 映射穷举 + 陈旧带 `非当日` 后缀 + class 面零 `ink-subtle`

- [X] T028 [P] [Server] **水位手选写端点**（FR-017, plan D-UI-5）：`POST /v1/optionsdesk/anchors/:id/position-bucket`（与 045 `anchors/:id/review` 同形）——三选一枚举，按标的持久化；**DTO 层显式表达「人工输入」语义**（不靠前端记得，M3 接真实水位时由来源标区分）；未选态由 `null` 表达。→ verify: `set-position-bucket.usecase.spec.ts`（Small）—— 非法枚举 400 + 不存在的锚 404 + 重复设置覆盖且更新时刻前进 + 详情 DTO 里该值带「人工输入」标

- [X] T029 [Server-IT] **读端 IT**（FR-005/006/007/008/013/014/016/020/021/041, `setupIsolatedDb()`）：真 PG 造快照 —— ① 当日快照 → 全量腿在结果内、无截断（SC-004 逐条对账：落库行数 vs 可见行数扣除非标与死档位移）② 快照非当日 → 全表照常 + 陈旧 `asOf` ③ 从无快照 → 「链数据未就绪」语义（非空页非错误）④ 非标一行不出现 ⑤ 死档在表内、排最后 ⑥ greeks 缺失在表内、不判档 ⑦ `overvalued` / L4 → 「不开新仓」且腿数据照常全量 ⑧ 某 Tab 零适格腿 → 返空集合而非 404 ⑨ 未选水位 → 意图「待定」且三 Tab 均可取数。`optionsdesk-047.leg-picker.it.spec.ts`

---

## Phase 7: 契约同步（Constitution §V 类型同步链）

- [X] T030 [Contract] **OpenAPI 导出 + api-client regen**（Constitution §V）：`nx run server:export-openapi`（**必走 `node dist/main.js` 正规路径，非 dump 脚本**）→ `packages/api-client` 重新生成 → `apps/mobile` 可 import 新类型。→ verify: `apps/server/openapi.json` diff 只含本片两个端点 + `nx build api-client` 绿 + `nx typecheck mobile` 绿 + nullable string 字段生成的是 `string | null` 而非 objectmap

---

## Phase 8: US2 / US3 / US4 mobile 消费

- [X] T031 [Mobile] **详情屏容器换装：`ScrollView` → `SectionList`**（FR-001/005, plan D-UI-1）：`optionsdesk/underlying-detail-screen.tsx` 的 `ScrollView`（`:69`）换成 `SectionList` —— `ListHeaderComponent` = 046 三块（`AnchorDetailCard` / `IvReadoutBlock` / `PriceZoneChart` **三个组件一行不改**，FR-001）；`section.header` = Tab 栏 + 水位 chip + `asOf` + 表头行（**sticky**）；`section.data` = 腿行；`ListFooterComponent` = 图例 + DTE 两段式提示 + FR-011 页脚「触发 ≠ 开仓 —— 人工终决」。<br>📌 **FR-011 的「常驻」= 区块页脚不可折叠、不随状态消失，不是屏幕常驻** —— 与 046 `thermometer-screen.tsx` 把 FR-019 免责渲在 `ScrollView` **之外**那个范式**不同**（mockup 帧 ①–④ 页脚就在表格下方）。别照抄 046 那条。🚨 **Guardrail 8：全页只留这一个纵向滚动容器**；🚨 **Guardrail 9：显式 `stickySectionHeadersEnabled={true}`**；删掉 046 留的 `optionsdesk-detail-intent-tab-placeholder` 分界块 + 其文案 `optionsdesk-copy.ts:162` 的 `intentTabComingSoon`（本次改动产生的 orphan，必须清）。<br>🚨 **删它会打红 046 的 e2e** —— `apps/mobile/e2e/optionsdesk-detail-thermometer.spec.ts:619` 断言 `getByTestId('optionsdesk-detail-intent-tab-placeholder')).toBeVisible()`。**本 task MUST 同步把那条断言改写成「选约区块已渲染」**，不是绕过、不是删测试。→ verify: `underlying-detail.rules.spec.ts` 扩测 section 组装逻辑（Small）+ **`rg 'ScrollView' underlying-detail-screen.tsx` 只应命中横向那个**（纵向零残留）+ **`rg 'intent-tab-placeholder|intentTabComingSoon' apps/mobile/` 零命中**（orphan 清干净）+ 改写后 `optionsdesk-detail-thermometer.spec.ts` **整条重跑绿**（046 三块无回归）

- [X] T032 [Mobile] **腿行组件 + 横向 offset 同步**（FR-003/005, plan D-UI-1）：`optionsdesk/leg-row.tsx` + `leg-table-header.tsx` —— 12 列 696px、首列（行权价/到期）88px **渲在横向滚动之外 ⇒ 天然钉住**（不依赖 `position: sticky`）；右侧列区在表头与每个数据行各挂一个 `Animated.ScrollView horizontal`，共享同一个 `useSharedValue` offset（`useAnimatedRef` + `scrollTo`）；**方向正交，与纵向 `SectionList` 不争手势**；成本 `O(视口行数)` 不随 730 增长。费率列**随行口径切换主数字**（收租行主显年化 / 建仓行主显周化，折年恒小字副标「参照·不排序」；**MUST NOT 对周化族的行主显折年**）；Δ 列显 **|Δ| 真值**（列头副标「带判据」）；**σ 距与 Δ 由同一个 `absDelta` 来，两列同有同无**（Guardrail 10）。**零新依赖**（reanimated 已装）→ verify: `leg-row.rules.spec.ts`（Small，逻辑：口径选择 / 占位符选择 / 列宽常量）+ 横滑与首列钉住走 T035 e2e

- [X] T033 [Mobile] **三 Tab + 水位 chip + 意图落位**（FR-002/016/017/019/020, plan D-SOT-3/D-SOT-4/D-UI-5）：`optionsdesk/leg-picker-tabs.tsx` + `position-bucket-chips.tsx` + `leg-picker.rules.ts` —— 三 Tab（全腿 / 建仓腿·周化 / 收租腿·年化）**共用同一个 `SectionList`**，切 Tab 只换 `section.data`（**MUST NOT 每 Tab 一个列表实例**）；Tab 成员判据 per plan D-SOT-4（建仓 `|Δ| ∈ [0.40,0.55]` ∧ `DTE ≤ 14`；收租锚轴 `K ≤ W` / 市场轴按矩阵 Δ 档，`DTE ∈ [150,365]`）；排序用**统一档位键**，全腿 Tab 每行标腿族口径徽标；**未选水位 → 停「全腿」+ 显式提示 + 三 Tab 仍全部可进入**；**未选水位时收租腿 Tab 的 Δ 档取三档并集 `0.05–0.40Δ` 并就地注明**（🚫 MUST NOT 静默取某一档）；手选值走 T028 端点持久化并标「人工输入」；**空 Tab 可进入 + 空态文案，面板不隐藏不置灰**。→ verify: `leg-picker.rules.spec.ts`（Small）—— 三 Tab 成员判据边界（恰好 0.40 / 0.55 / 14 天 / 150 天 / 365 天的归属确定）+ 未选水位时收租 Tab 取并集 + 空 Tab 返空集合而非隐藏 + 排序键是档位不是数值

- [X] T034 [Mobile] **档位着色 + 动作四态 + 财报 chip + 数据缺口体系**（FR-003/006/007/009/010/011/013/014/021, plan D-SOT-1/D-SOT-2）：`optionsdesk-copy.ts` 扩文案 + 着色映射 —— 四档色阶（好 `success-soft`/`success` · 可接受 `primary-soft`/`primary` · 薄 `warning-soft`/`warning` · 死档 `surface-sunken`/`tag-gray`），**只着 bid 单元格**（整行着色会糊）；**这四档是费率质量档不是涨跌，页面内 0 处 `--nvy-quote-*`**；动作四态梯度 `挂 OCO`（好/可接受合并）→ `暂不挂`（薄）→ `死档剔除` → `无法判档`（greeks 缺）；**薄档行的费率列同屏显 `ask` 口径值**（D-SOT-2 定案）；死档灰底沉底 + 无动作入口 + **标注列照常打财报标**（FR-006）；greeks 缺失行**不判档不着色、费率列显缺失占位、动作标「无法判档」**；财报 chip 四形态 + 数据缺口体系（虚线 + `surface-sunken`，与红标体系区隔）；陈旧 `asOf` 转醒目「数据截至 X · 收盘」；「链数据未就绪」**说明何时会有**；不动区警示注置顶 + 腿数据照常全量；**枚举 → copy 映射用 `Record<Enum, X>` 非 `Partial<Record>`**（漏 enum 成员即编译红）。⚠️ **降级状态字禁用 `--nvy-text-subtle`**（白底 2.85:1），用 `--nvy-text-muted`。🚫 **FR-012：本片无「选腿 → 创建许愿单」入口** —— 行**不可点**、无 CTA、无选中态、无浮起操作条；动作列是**建议标签不是按钮**（中性 tag：`surface-sunken` 底 + `border-strong` 描边，刻意不做按钮观感）→ verify: `leg-picker-copy.spec.ts`（Small）—— 四档 × 四态映射穷举 + 薄档带 `ask` + greeks 缺失三处处置一致（费率占位 / 不着色 / 动作文案）+ 死档仍有财报标 + `rg -- '--nvy-quote-' apps/mobile/src/optionsdesk/leg-*` 零命中 + **腿行组件树内零 `Pressable` / 零 `onPress` / 零 `accessibilityRole="button"`**（FR-012 的机器判据，e2e 侧由 T035 补一条「点行无任何导航或状态变化」）

- [X] T035 [Mobile-E2E] **US2 / US3 / US4 e2e**（SC-003/SC-004/SC-012 + 27 条 AS 的呈现面, plan D-UI-2）：`apps/mobile/e2e/optionsdesk-chain-leg-picker.spec.ts` —— ① **SC-012**：滚动条长度与逻辑总行数一致 + **可滚到最后一行** + 行数计数条分母 = `data.length`（不是渲染窗口大小）② **US2-AS6**：横向滑动露出隐藏列且首列钉住，**纵向滚动仍在详情页内正常工作**（手势零争用的可验证判据）③ 陈旧 `asOf` / 链数据未就绪 / 零适格腿 / 不动区四个状态帧 ④ **US3-AS2**：未选水位时三 Tab 全部可进入读表 ⑤ **US3-AS3**：水位选择被记住且可看出是人工输入 ⑥ **US4** 四种财报标同屏且同一到期日一致 ⑦ **SC-003**：抽任意一屏零处「无法判断这个数是哪天的」（含 OI 列的独立 `oi_as_of`）。→ verify: `nx run mobile:e2e` 绿；**改共享 hook / util 时跑全 `runtime-smoke` 非单 spec**

- [X] T036 [P] [Mobile-E2E] **markets-OFF 门控断言**（FR-015）：**只能落** `apps/mobile/e2e/markets-feature-gate.spec.ts`（Guardrail 17）——markets 关闭时选约区块随期权台 tab 一并不可达（**路由级 guard，与 045/046 同构**，不在组件内加第二道判断）。→ verify: `playwright.markets-off.config.ts` 那条 job 绿

---

## Phase 9: 收口（两层验证 + 校准 + 全绿门）

- [X] T037 [Contract-Smoke] **契约冒烟 happy-path**（Constitution §V ②）：`apps/mobile/e2e/contract-smoke/optionsdesk-chain-leg-picker.contract.ts` + **在 `run.ts` import 注册** —— 用生成的 `@nvy/api-client` 打 testcontainers 真 server：造一条锚 + 一批快照 → 取选约表（验 URL / method / 序列化 / 响应解封 / 真落库）→ 设水位档 → 复取验持久化。→ verify: `nx run mobile:contract-smoke` 绿

- [X] T038 [Gate] **三项实测校准 + 写回**（spec frontmatter ⏳ · FR-045 · FR-052a, plan D-API-1/D-ARCH-4）：① **perf 档位**——**单跑该 spec**（非 `nx affected` 全量并行门下）取**暖样本**（剔除每进程首请求）实测选约表端点，起手档 `p50 ≤ 150ms / p95 ≤ 300ms`，实测后**写回 spec frontmatter** 并删掉那段 ⏳ 注释 ② **磁盘实测**——重测 prod 77 实际剩余磁盘（p3b 记的 6.7 G 是 08-01 数字，可能已 stale）+ 落一周真数据后量 `pg_total_relation_size` 得单行宽度，回填 T025 的告警阈值 ③ **FR-045 阈值观察窗登记**——起手 100%，登记「至少覆盖一个月度到期日次日」的观察窗，若发现正常态缺行再放阈值**并把成因写回 FR-045**。→ verify: 三项数字进 commit message + spec frontmatter 的 ⏳ 段与 FR-052a 的 🚨 段均已由实测替换

- [X] T039 [Gate] **spec 回写 + 扫描判据 + 全绿门**（FR-042/SC-007/SC-008, plan D-DATA-4/D-SHIM）：① **spec 回写四处**（其中两处已在 analyze 期先行修掉，此处只核验不重做）——(a) V-A 那一行与 FR-046 的 🚩 段按 plan D-DATA-4 改为「已由官方文档 + E32 结清，按已知漂移设计」(b) SC-009 与 Assumptions 的「vendor 限频待核实」按 plan D-SHIM 结清 (c) ✅ 依赖表「完整性告警」的旧措辞「逐票行数比对」→「逐合约覆盖率」**（analyze 已修，核验即可）** (d) ✅ Assumptions「只含认沽」加「呈现面」限定 **（analyze 已修）**；另 **(e) FR-010 补写「薄档行 MUST 同屏显 `ask` 口径值」** —— 该约束是 plan D-SOT-2 期新增的，spec 至今无对应文字，只活在 plan 与 T004/T034 里 ② **SC-007 扫描判据**：`rg` 全仓无「在美股交易时段主动拉起行情网关」的调用、无 `delayed_quotes` ③ **SC-008 扫描判据**：`git diff origin/main -- '**/package.json'` 无 dependencies 新增 ④ 全绿门。→ verify: `nx affected -t lint typecheck test build` 全绿 + `check-test-size.ts` + `check-server-moat.ts` + `check-optionsdesk-rule-constants.ts` 三个门 exit 0 + 两条扫描判据零命中

  ⟨**2026-08-07 收口实况**⟩

  **① spec 回写 —— 原列四处 + 实装期新增六项，逐条落地**：<br>(a) ✅ V-A 行加 ✅ 标 + 下方 ⚠️ 块整段换成结清块（官方文档 + E32 已给全答案，「原样补回」在 `OI` 与 greeks 上本就不成立 ⇒ 不退级，改按已知漂移设计）；FR-046 的 🚩 段同步换成 ✅ 段并写明三个时点列的落法。<br>(b) ✅ SC-009 与 Assumptions 的「限频待核实」双双结清：`option_chain` 10/30s 是**官方真值**（不是兜底），顺带查实 `earnings_calendar` 官方 60/30s 而原落兜底 10/30s = 6x 偏严，已由 T011a 补登。<br>(c) ✅ 依赖表「逐合约覆盖率」措辞 —— **核验通过，analyze 期已修，未重做**。<br>(d) ✅ Assumptions「只含认沽」的「呈现面」限定 —— **核验通过，analyze 期已修，未重做**。<br>(e) ✅ FR-010 补写「薄档行 MUST 同屏显 `ask` 口径值」，含「为什么动作列的信息损失必须由费率列补回」的判据与「这不是 `ask` 参与判档的口子」的反向围栏。<br>(f) 🚨 **窗数 26 → 31** 回写 spec Assumptions + plan D-DATA-9（含「vendor 原文的 7 天窗 = 端点差 ≤6」这个根因、三个 start 上 3/3 复现的实测、以及「502 被当瞬时错误重试 ⇒ 永远不以参数错的形状说出来」这条为什么此前没被发现）。<br>(g) 🚨 **财报标四值 → 5 值 + `null`** 回写 spec FR-026 + plan D-UI-4 + tasks T026（多出的是 `no_cross`；写明四值凑不出「无日期可与已确认不跨区分」这条验收）。<br>(h) **两个策略常量**入 spec：FR-024 的 `EARNINGS_BUFFER_MIN_DAYS = 7`（含「`+Nd` 的 N 是还差几天」）· FR-023 的 `RENT_SHORT_MAX_DTE_DAYS = 28`（含「与收租 Tab 的 `DTE ∈ [150, 365]` 是两件事」的防合并注）。<br>(i) **`activityByTab` 三套标记**入 plan D-SOT-5（定案与推导）+ D-API-1（例外指针）+ spec Assumptions 活跃度条 —— 写明 D-SOT-5「Tab 候选集内相对排名」与 D-API-1「Tab 过滤在客户端」起草时对不上，定案 = 端点每腿返三套、server 单点派生、客户端禁重算。<br>(j) **矩阵归属跟着 7 条新 task 核**：SC-010 由记账式 `T007 · T017`（两者 verify 皆 hermetic）改为 **T007a 实装** · `state_branch #3` 与 US2-AS4 补 **T027a** · Edge Case 三条异常监控补 **T024a**（T024 ship 时零调用方）· SC-006a 补 **T019a**。<br>(k) frontmatter `status: tasks-ready → implemented`；三份产出物 `updated_at → 2026-08-07`。

  **② SC-007 零命中**：`delayed_quotes` 全仓命中**全部**是禁令文本 / ToS 记录 / 机械防线断言（`const BANNED = 'delayed_quotes'`）+ 046-era 注释 + spec 自身的红线段，**本片改动面内零命中**；「在美股交易时段主动拉起行情网关」的调用同样零 —— 本分支对 `marketdata.module.ts` 的唯一相关 diff 是一条**反向**注释「标的 spot 由 adapter 并进同一批 codes，**不另配 `QUOTE_PORT` 依赖**」，`QUOTE_PORT` 那行 import 的 `git blame` = `9f473ad9`，先于本片。

  **③ SC-008 零新增运行时依赖**：`git diff origin/main...HEAD -- '**/package.json' 'package.json'` = **零 diff**（本分支对任何 `package.json` 一个字节没改）。⚠️ 两点式 `git diff origin/main` 会显示 `version` 与 `pnpm.overrides` 有差 —— 那是 **main 领先**（release-please 发版 + 安全 override），不是本片引入，故判据取三点式。本片新增的 `__fixtures__/*.csv` 是**测试 fixture 不是依赖**（CSV 走 `split(',')` 解析，零 runtime 包）。

  **④ 全绿门逐项**：`npx nx affected -t lint typecheck test build --base=origin/main` → **EXIT=0**（`Successfully ran targets lint, typecheck, test, build for 4 projects`；日志里的 `✖ N problems (0 errors, N warnings)` 是 lint warning，`ERROR` 行是故障注入测试的预期输出）；`check-test-size.ts` **exit 0**（562 specs / 七条 size 不变量全过）· `check-server-moat.ts` **exit 0**（0 护城河违规）· `check-optionsdesk-rule-constants.ts` **exit 0**（49 个同级 `.ts` 零命中）。📌 已知 flake `marketdata.hk-039.backfill-pacing.it.spec.ts` **本轮未撞到**，无需复跑。

  **⑤ 三条「知道但不改」的挂账均已核实仍在**：① shim 侧 `EARNINGS_MAX_SPAN_DAYS = 7` 偏宽 —— 三处挂账齐全（本文件 T019a 描述 / `earnings-calendar.port.ts:` 常量注释 / `marketdata.futu-shim.vendor.spec.ts:607` 锚用例注释），shim 是已上线服务，收紧要单独 PR + 生产部署 ② 已应用的 migration SQL 注释仍写「≤7 天窗」（`20260804_1139` / `20260804_1155` 两处）—— 🚫 **不改，改动会破坏 checksum** ③ mobile 图例四档边界是 server `TIER_FLOORS_BY_BASIS` 的**手抄镜像**（跨 bounded context 拿不到常量），就地标注仍在 `optionsdesk-copy.ts` ④ 两条只能留真机的验证（`windowSize=21` ≈ 369 行的大规模虚拟化窗口 · a11y `selected` 语义 —— `react-native-web@0.21` 整个不认 `accessibilityState`）仍写在 `optionsdesk-chain-leg-picker.spec.ts` 文件头 38–47 行。

---

## Dependencies & 执行顺序

```text
Phase 1 (T001–T009) ──┬─→ Phase 2 (T010–T013) ──→ Phase 3 (T014–T017) ──→ Phase 5 (T021–T025a)
                      │                        └─→ Phase 4 (T018–T020) ──┘
                      └─────────────────────────→ Phase 6 (T026–T029) ──→ Phase 7 (T030) ──→ Phase 8 (T031–T036) ──→ Phase 9 (T037–T039)
```

- **Phase 1 是全片硬前置**（schema + 五个纯函数），T004–T008 五条可**全并行**（不同文件、零交叉）。
- **Phase 3 与 Phase 4 可并行**（两条独立采集链，只共享 Phase 1 的 schema）；T014 / T018 可并行。
- **Phase 6 只依赖 Phase 1**，不等采集链落地（IT 用造的快照数据，US2「Independent Test」明写「造一批快照数据即可端到端验证，无需真跑 vendor」）⇒ **UI 面可与采集面并行推进**。
- **Phase 6 内部有一条序**：T027（读端）硬依赖 T026（财报打标纯函数），二者**不可并行**（读端 DTO 消费它）。
- **T025a 硬依赖 T021**（同判据两处实现，verify 要把两边钉在一起）且**必须与 T022 同批上线** —— 否则「两级补救跑通了但没人知道」和「ERROR 只落进次日日报」两种静默各占一半。
- **Phase 8 硬依赖 Phase 7**（类型同步链）。
- **T013 / T038 需手工跑**（真 vendor 门默认 skip / prod 只读测量），不进 CI 自动流。

**MVP 边界**：Phase 1 + 2 + 3 + 5 = **US1 完整可交付**（管道 + 防线）。这也是 spec 把 US1 排 P1 的理由 —— 三家 vendor 均无期权 EOD 历史，**UI 晚一周只是晚一周看，管道晚一周就是永久少七天数据**。

---

## Acceptance Scenario 覆盖矩阵（27 条 → task，逐条 1:1）

> 🆕 **本矩阵是 046 实证逼出来的第四层**（per `sdd-authoring.md` 反模式第 ④ 条）：state_branch / Edge Case / SC 三张矩阵的**值域够不到 `## User Scenarios` 里的 Acceptance Scenario**，写在 AS 里的需求会零覆盖**且零告警**（046 US1-AS1「从雷达点进详情」被两轮 analyze 全漏、impl 完才发现）。此处补齐第四层。

| US | AS | 覆盖 task |
| --- | --- | --- |
| US1 | 1 全链落库 + 同日重跑不重复 | T015 · T016 · T017 |
| US1 | 2 一批存续合约缺席 → ERROR 且不被大票掩盖 | T021 · T023 · T025a |
| US1 | 3 整票缺席 → ERROR（逐票汇总） | T021 · T023 · T025a |
| US1 | 4 大到期日次日 → **不**告警 | T021 · T023 · T025a |
| US1 | 5 硬门违规行不入库 + 历史不破坏 | T007 · T016 · T017 |
| US1 | 6 零锚 → 跑绿、请求数 0、无假红 | T015 · T017 · T021 |
| US1 | 7 次日盘前兜底跑通 → 补齐、不升 ERROR、留痕 | T022 · T023 · T025a |
| US1 | 8 两级都失败 → ERROR 且指明哪票哪天 | T022 · T023 · T025a |
| US2 | 1 全部适格腿在表内、无静默截断 | T027 · T029 · T035 |
| US2 | 2 死档默认摊开 / 灰底 / 沉底 / 无动作入口 | T027 · T034 · T029 |
| US2 | 3 greeks 缺失仍在表内 + 标「数据不全」 | T027 · T034 · T029 |
| US2 | 4 快照陈旧 → 全表照常 + 「数据截至 X · 收盘」 | **T027a** · T034 · T035 |
| US2 | 5 从无快照 → 「链数据未就绪」非空页非错误页 | T034 · T035 |
| US2 | 6 横滑看隐藏列 **且纵向滚动仍正常** | T031 · T032 · **T035** |
| US3 | 1 已选水位 + 矩阵输出收租 → Tab 停收租腿 | T005 · T033 · T035 |
| US3 | 2 未选水位 → 停全腿 + 提示，三 Tab 仍可进 | T033 · T035 |
| US3 | 3 选择被记住 + 可看出是人工输入 | T028 · T033 · T035 |
| US3 | 4 零适格腿 Tab 可进入 + 空态，面板不隐藏 | T033 · T029 · T035 |
| US3 | 5 不动区 → 警示置顶 + 腿数据全量 | T005 · T034 · T029 |
| US3 | 6 全腿 Tab 每行标口径 + 排序用档位键 | T033 · T034 |
| US3 | 7 好/可接受合并为「挂 OCO」，靠着色区分 | T034 |
| US4 | 1 长腿缓冲充足 → 「利空出清覆盖 ✓」 | T026 · T035 |
| US4 | 2 缓冲不足 → 「+Nd」且只约束单侧 | T026 · T035 |
| US4 | 3 短腿跨财报 → 「⚠」且仍可选（提醒非拦截） | T026 · T034 |
| US4 | 4 建仓腿无财报标 | T026 · T035 |
| US4 | 5 无财报日 → 「无日期」且可与「不跨」区分 | T026 · T035 |
| US4 | 6 财报日相较昨日变更 → 记 PIT + 进复核名单 | T019 · T020 |

## state_branch 覆盖矩阵（24 条 → task，逐条 1:1）

| # | 分支 | 覆盖 task |
| --- | --- | --- |
| 1 | 有锚 + 当日快照 + 适格腿 → 分档着色渲全量 | T027 · T034 · T029 |
| 2 | 该 Tab 零适格腿 → 可进入 + 空态 + 面板不隐藏 | T033 · T029 |
| 3 | 快照非当日 → 全表照常 + 陈旧 `asOf` | **T027a** · T034 · T029 |
| 4 | 从无快照 → 「链数据未就绪」 | T034 · T029 |
| 5 | 不动区 → 警示置顶 + 腿数据全量 | T005 · T034 · T029 |
| 6 | greeks 缺失 → 留表 + 标「数据不全」 | T006 · T027 · T034 |
| 7 | 死档 → 灰底 / 沉底 / 「死档剔除」 / 无入口 | T004 · T034 · T029 |
| 8 | 非标 → 采集端落库、选约表不出现 | T015 · T027 · T029 |
| 9 | 收租长腿跨财报缓冲充足 → 「覆盖 ✓」 | T026 |
| 10 | 收租长腿缓冲不足 → 「+Nd」 | T026 |
| 11 | 收租短腿跨财报 → 「⚠」 | T026 |
| 12 | 无财报日数据 → 该列可区分于「不跨」 | T026 · T034 |
| 13 | 未选水位 → 停「全腿」+ 提示 | T005 · T033 |
| 14 | 已选水位 → 矩阵三输入齐备 + 标人工输入 | T028 · T033 |
| 15 | 存续合约当日无快照 → 覆盖率跌破 → ERROR | T021 · T023 · T025a |
| 16 | 整票缺席 → ERROR（逐票汇总） | T021 · T023 · T025a |
| 17 | 大到期日次日 → 已到期不进分母 → 不假红 | T021 · T023 · T025a |
| 18 | 当日失败 + 次日兜底成功 → 不升 ERROR 但留痕 | T022 · T023 · T025a |
| 19 | 两级都失败 → ERROR | T022 · T023 · T025a |
| 20 | 硬门违规 → 不入库 + ERROR + 历史不破坏 | T007 · T016 · T017 |
| 21 | 零锚 → 两个 per-code 维度请求数 0、跑绿 | T015 · T017 |
| 22 | 零锚 → 财报维度照常跑并全市场落库 | T019 · T020 |
| 23 | 财报标的不在 `Instrument` → 跳过并计数 | T019 · T020 |
| 24 | 到期日超 vendor 前向视野 → 三态之「无」 | T026 |

## Edge Case 覆盖（9 条 → task）

| Edge Case | 覆盖 task |
| --- | --- |
| 单票腿数极多（PEP 730 行）→ 虚拟化 + **手势争用** | T031 · T032 · T035 |
| 水位无数据面 → 手选 chip，**未选是常驻分支** | T002 · T028 · T033 |
| vendor 当日不可用但次日盘前恢复 → 二级救回 + 留痕 | T022 · T023 · T025a |
| 非标合约 → 采集全采、选约表零出现 | T015 · T027 · T029 |
| 深实值 greeks 整块置 0 → 只虚值区告警 | T024 · **T024a** |
| IV 离群 > 500% → 结合 DTE 判定 | T024 · **T024a** |
| 并购类公司行为 → 新非标 root → 复核名单 | T024 · **T024a** |
| vendor 当日整体不可用 → 缺口经两级补救 | T022 · T023 · T025a |
| US 半日市 → 按交易日历判定而非固定时钟 | T015 · T016 · T017 |

## SC 覆盖（13 条 → task；**故意零覆盖的已写明**）

> per `sdd.md` 反模式：**SC 层是系统性盲区**（人对着 FR 展开 tasks，SC 不产出代码行、没有牵引力；045 实证同一份 tasks 里 FR 37/37 而 SC 仅 6/11）。此处逐条列，预期的零覆盖写明「故意的」。

| SC | 覆盖 task | 备注 |
| --- | --- | --- |
| SC-001 连续 5 个交易日零次「昨天数据没进来且**无人知情**」 | T021 · T023 · **T025a** · **T038** | ⚠️ **「无人知情」那半的载体是 T025a**（当日飞书触达），不是 T021 —— 会不会 ERROR 与 ERROR 到不到人眼前是两件事。「连续 5 日」落 T038 的 prod 观察窗登记，**不作 CI 门**（同 045/046 SC-001 性质） |
| SC-002 完整性三向可证伪 + 零锚不告警 | T021 · T023 · T025a | 第 ③ 向（大到期日次日不告警）是换判据后新增的**假阳性守卫**，缺它只证明会响、证不了不乱响。T025a 侧同三向各验一遍（同判据两处实现的绊线） |
| SC-003 每处读数带可见时点，零处「不知哪天」 | T027 · T034 · T035 | 含 OI 列的独立 `oi_as_of`（Guardrail 6） |
| SC-004 决策带内零静默丢失，逐条可对账 | T027 · T029 | 落库行数 vs 可见行数（扣非标与死档位移） |
| SC-005 新增锚下一轮自动出数据、零代码零 SQL | T015 · T017 | |
| SC-006 两个 per-code 维度对非锚标的请求数 = 0 | T015 · T017 | ⚠️ **MUST NOT 套到财报维度**（市场级接口对它无定义） |
| SC-006a 财报调用数与锚数量无关 + 零锚照常跑 | T019 · **T019a** · T020 | FR-035a 的反向守卫，防 046 FR-027 那类静默不采。⚠️ **T019a 把窗宽 7 → 6（窗数 26 → 31）之后本条仍成立** —— 窗序列只由业务日期推导，与锚数量无关这条性质不受窗宽影响；T019a 的 verify 把它作为回归断言重跑了一遍 |
| SC-007 零盘中实时取数路径 | T039 | 扫描判据：代码内无交易时段主动拉起行情网关的调用、无 `delayed_quotes` |
| SC-008 新增第三方运行时依赖 = 0 | T039 | 扫描判据：`git diff` 无 `package.json` dependencies 新增 |
| SC-009 12 条锚单轮墙钟 ≤ 15 分钟 | **T013** | ⚠️ 载体是**真 vendor 门内计时**（hermetic IT 把 vendor mock 了，计时测的是 mock 往返）；该门恒 skip ⇒ **手工跑一次才有数** |
| SC-010 硬门在真实数据上误拦率 = 0 | **T007a**（实装）· T007（被测纯函数） | 🚨 **归属订正（2026-08-07 T039）**：本行原写 `T007 · T017`，属**记账式归属** —— 两者的 verify **都是 hermetic**（T007 手写正反例 / T017 mock vendor），谁都没跑过真实样本，而 plan Gate 0.1 明写这条「用已采真实样本回放、不用合成数据」。**T007a 才是实装**：2150 行真实样本（`marketdata/__fixtures__/` 的只读 CSV，源自本机已采 sqlite）零误拦，且**显式断言「bid 跌破内在价值但 ask 未跌破」那批 = 702 行 > 0**（防 fixture 哪天被裁成「反正都合规」的一批，使「零误拦」退化成空洞的真命题）。📌 Guardrail 1 与 `option-snapshot-guard.rules.ts` 文件头记的 **2138 行 / 706 违规**是 p3b 分析期的**冻结记录**，与本条的 2150 / 702（导出口径含一个完整 session）并存、不互相回改 |
| SC-011 补救链双向可证伪 | T022 · T023 | 两个方向都验过才算这道防线成立 |
| SC-012 滚动条长度 = 逻辑总行数 + 可滚到最后一行 | T031 · T035 | 📌 「滚动流畅度」**故意不作验收门**（spec 已明标，真机主观计时，与 SC-001 同性质）；T035 仍在真机过一遍手感，不入 CI |

## 故意零覆盖登记（analyze 补，per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

> 不写明的话，下一轮 `/speckit-analyze` 会把它们当缺口再补一遍 task。

| 条目 | 层 | 为什么零 task 是对的 |
| --- | --- | --- |
| 合规红线 ③「落库自用的许可面，本片不扩大分发面」 | 合规红线 | **无代码面** —— 本片零对外暴露、零再分发，是「不做某事」的边界声明。真要有载体只能是「别加导出/分享端点」，而本片压根没有任何对外接口 |
| Assumptions「财报日历体量 = 2–8 万条/年」 | Assumptions | **估算不产出代码**。它的作用是证明「存储不构成反对理由」，容量的可执行面已由 FR-052a → T025 / T038 承载 |
| 依赖表「已就绪」7 条 | 依赖表 | **消费面、本片零改动**。反向守卫已落 T031（046 三组件一行不改）与 T027（复用 045 `anchor.rules.ts` 不重写） |
| Clarifications 24 问 | Clarifications | **决策过程记录**，结论已固化进 FR / plan；矩阵扫 FR 即等于扫它们的结论 |

## 单 PR（Constitution §V）

跨端 feature ⇒ **server impl + IT + shim + api-client regen + mobile 消费 + 两层验证全部同 PR 原子 merge**。PR body 走 `docs/conventions/pr-creation-protocol.md`（模板是 body 唯一权威 source，三 checkbox 缺一 CI 红）。

⚠️ **本片含 shim 部署（T012）** —— shim 在港 ECS、与 server 不同宿主，其部署**先于** server PR merge（否则 server 上线即打 404，`us_equity_bar` 首跑 7/7 全 404 的同款）。T012 的 verify 段的「四端点各实打一发」就是这道序的守卫。
