---
feature_id: 085-optionsdesk-display-currency
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-17'
updated_at: '2026-09-17'
---

# Tasks: 085-optionsdesk-display-currency（交易账户展示币种切换）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)

**一句话**：optionsdesk 自持 FX 取数链（腾讯 `wh` 主 + 新浪 `fx_s` 备 → FallbackChain → 进程内单格缓存 + single-flight）→ `list-broker-positions` 在分组聚合**之前**逐行折算、降级行金额置 `null` ⇒ 复用 083 既有「市值无效排末」白拿降级组沉底 → mobile 屏级每页签一格状态 + 下拉式选择器。**零 schema 变更、零新依赖、零新 use case、零跨 ctx 面变化**；跨端单 PR。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx; plan Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红→绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Server]` / `[Server-IT]` / `[Contract]`（OpenAPI 导出 + api-client 重生成）/ `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]`。本片无 `[Shim]` / `[Docs]` / `[Ops]`（零 shim 改动、零上游文档订正；**零 Ops task 是蓄意的**，理由见文末「蓄意零覆盖」）。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起，对应 `spec.md:18-38`）。
- **FR / SC 一律逐条枚举，不用范围记法**。

## Path Conventions

| 用途 | 路径 |
|---|---|
| FX port（新） | `apps/server/src/optionsdesk/fx-rate.port.ts`（ctx 内 port + DI token） |
| FX 解析纯函数（新） | `apps/server/src/optionsdesk/fx-rate.rules.ts`（+ 同名 `.spec.ts`） |
| FX 双源 adapter（新） | `tencent-fx.adapter.ts` · `sina-fx.adapter.ts` · `fx-rate-fallback-chain.adapter.ts`（+ `.spec.ts`） |
| FX 缓存装饰器（新） | `fx-rate-cache.adapter.ts`（+ `.spec.ts`） |
| FX 拒绝壳（新） | `refusing-fx-rate.adapter.ts`（mock 档绑它；立意照 `marketdata/refusing-collection.adapter.ts`，**跨 ctx 不可 import**，另落一份） |
| 折算规则（新） | `display-currency.rules.ts`（+ 同名 `.spec.ts`） |
| 读 use case（改） | `list-broker-positions.usecase.ts`（`findMany` 与 rows 落点 `:250`；`buildPositionGroups` 调用点） |
| 分组聚合（只读不改） | `broker-position-display.rules.ts`（`signedSum` `:116-117` · `compareGroups` null 排末 `:190-205`） |
| controller / DTO（改） | `broker-account.controller.ts`（query）· `broker-account.dto.ts`（**nullable 标量必显式 `type`**） |
| 模块装配（改） | `optionsdesk.module.ts`（按 `marketdataConfig.kind` 绑 FX port） |
| config（改） | `apps/server/src/config/marketdata.config.ts`（`live` 分支加两个带 `.default()` 的 FX baseUrl，形态照 `eastmoneyClistBaseUrl` `:21` / `tencentCalendarBaseUrl` `:24`） |
| env 守门（改） | `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`（`:67`；带 `.default()` 的可选 key **不进 `.env.example`**，per `config-env-sync` rule §归属判定 2） |
| Server IT（新） | `apps/server/test/integration/optionsdesk-085.display-currency.it.spec.ts`（隔离库 `apps/server/test/_support/isolated-db.ts` `setupIsolatedDb`） |
| 契约产物（regen） | `apps/server/openapi.json` + `packages/api-client/src/generated/` |
| mobile 规则（新） | `apps/mobile/src/optionsdesk/display-currency.rules.ts`（+ spec） |
| mobile 选择器（新） | `apps/mobile/src/optionsdesk/currency-selector.tsx` |
| mobile 屏 / 列表（改） | `trading-account-screen.tsx`（D7 状态；分段条件渲染 `:46-52`）· `trading-account-positions.tsx`（`PositionsMeta` `:241` · `COL` 常量 `:64-69` · `CARET` `:73` · 行级徽标 `:448-454` —— mockup 称 `.chip`，RN 侧无此名，实体是 `row.expired` 的 `self-start rounded-sm bg-warn-soft px-1`） |
| mobile 数据 hook（改） | `use-trading-account-positions.ts`（query key 常量 `:16` 加币种维度） |
| mobile 标记判定（改） | `trading-account-positions.rules.ts` |
| mobile 文案（改） | `optionsdesk-copy.ts`（**083 既有 `tradingAccountPositions` 段内**新增；不并入 081 的 `tradingAccount` 段（`trading-account.rules.spec.ts:46-50` 会当场红）。`marketValueLabel` 体例 `:1472-1474`） |
| mobile e2e（改） | `apps/mobile/e2e/optionsdesk-trading-account-positions.spec.ts`（083 三臂形态 `:616` / `:652` / `:1346`） |
| 契约冒烟（改） | `apps/mobile/e2e/contract-smoke/optionsdesk-trading-account.contract.ts` |

## Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **只读**：本片零写路径、零事务、零 schema 变更、零 migration（汇率不落库，plan D4）。
2. **金额一律 `Prisma.Decimal`，出边界一律 string**；不经 Number 中转。
3. **数字字面量避开 `0.8` / `0.6` / `1.2` 三个子串** —— `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 扫 `apps/server/src/optionsdesk/` 下**除 `anchor.rules.ts` 外的全部 `.ts`，含 `*.spec.ts`**（`:620-625`，刻意不排除 spec）。⇒ **fixture 的 HKD→CNY 汇率不得用真实值 `0.8549`**；用一眼可辨的合成值（如 `0.9500` / `2.5000`）。`1.2` 出现在任何汇率或倍数 fixture 里同样当场红。
4. **`displayCurrency` 不进任何 `where`** —— 它只影响呈现，不得成为第二条数据路径（账号隔离仍在既有查询条件里）。
5. **取数时刻走 ingestion time**（`capturedAt`，绝对时刻，ADR-0066 第二条轴）⇒ 出 ISO UTC 由 mobile 按设备本地展示；optionsdesk 侧不裸用 `Intl.DateTimeFormat`（`check-time-semantics` Rule B 当场红）。
6. **API 同步链两步分别跑**：`pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`；**漏第一步是静默的**（`api-client:generate` 无 `dependsOn`，会拿上一版 json 重生成、产物逐字节相同、CI 全绿），`api-contract.md:56-67`。
7. **mobile 🚫 `Intl.NumberFormat`**（`format/compact-amount.ts` 文件头硬纪律，Hermes 上 Intl 支持不确定）；币种一律**三字母代码**，不用货币符号。
8. **mobile 不自算汇率或折算** —— 折算全在 server（`check-optionsdesk-rule-constants` 不变量 #8 已在扫客户端自算默认值）。
9. **跨 ctx 不可 import**：FX 解析器不复用 `alert/realtime-quote.rules.ts`（股票 88 字段 vs FX 22 字段，且 eslint `boundaries` 拦，ADR-0053）；拒绝壳不 import `marketdata/refusing-collection.adapter.ts`。两处均**照写法另落一份**，并存是已知状态。
10. **新文件首跑带 `--skip-nx-cache`**（`implement-task-closure.md`）。

## Tasks

### Server 基础：FX 取数链

- [ ] T001 [Server] **`fx-rate.port.ts` + `fx-rate.rules.ts`：GBK 解码与双源解析纯函数**（FR-002, FR-006; plan D0, D3; state_branches 8, 9; US1/US3）：新建 ctx 内 port（token + interface，返回 `{ pair, rate: Prisma.Decimal, capturedAt }[]`）与解析纯函数文件。`fx-rate.rules.ts` 导出：`decodeGbk`（照 `alert/realtime-quote.rules.ts` 写法**另落一份**，不跨 ctx import）· `parseTencentFx(text, requestedPairs)`（`~` 分隔 22 字段，取 **`f3`**；不取 `f10`（更新瞬间滞后约 40s）、不取 `f11`（语义未定））· `parseSinaFx(text, requestedPairs)`（`,` 分隔取 **`idx3`**）· `invertRate(d)`（反向币对取倒数，P3 实证反向三对全 MISS）。**三条解析契约**：① 请求 N 对必须回 N 对，**少一对即抛**（与 `alert/` 的「部分命中不算失败」刻意相反 —— 静默少一对会让那一屏悄悄走降级路径）② 哨兵 `v_pv_none_match="1"` **显式挡**（不当成一个 symbol：PoC 实证既有股票解析器的正则会把它解出来、靠 `length <= 32` 静默跳过 ⇒ 照抄会得到「零汇率但不报错」）③ `f3` / `idx3` 不可 `Decimal` 解析即抛 → verify: `pnpm nx test server src/optionsdesk/fx-rate.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 三对齐全的腾讯响应 ⇒ 解出 3 条、`f3` 值逐字正确 ② 请求 3 对、响应只含 2 对 ⇒ **抛**（branch 8 的前置）③ 响应为哨兵 `v_pv_none_match="1"` ⇒ **抛**，不解出 symbol（branch 8）④ `f3` 为空串 / 非数字 ⇒ 抛 ⑤ 新浪响应 ⇒ 取 `idx3`，且 `idx1` / `idx2` / `idx8` **不被消费**（那三个是买卖价一族、会摆动）⑥ 反向币对 ⇒ `invertRate` 往返误差 < 1e-9 ⑦ GBK 字节 ⇒ 中文名正确解码不乱码；定向变异：a. 去掉 N 对校验改为「回几条算几条」→ ② 红 · b. 去掉哨兵挡 → ③ 红 · c. 取 `f10` 代替 `f3` → ① 在 `f3 ≠ f10` 的样本上红（留档）

- [ ] T002 [Server] **双源 adapter + FallbackChain + `capturedAt` 口径**（FR-002, FR-006, FR-007; plan D3, D5; state_branches 8; US1/US3）：新建 `tencent-fx.adapter.ts`（主，`https://qt.gtimg.cn/q=wh<FROM><TO>`，走 `VendorHttpClient` + `TENCENT_PROFILE`）· `sina-fx.adapter.ts`（备，`https://hq.sinajs.cn/list=fx_s<from><to>`，**必带 `Referer: https://finance.sina.com.cn`** —— 漏了 403，`alert/sina-realtime.adapter.ts:7` 已记同一事实）· `fx-rate-fallback-chain.adapter.ts`（编排，照 `alert/realtime-quote-fallback-chain.adapter.ts:39-42`：节点抛 → 记 warn 平移下一节点，**全败抛**，由 use case catch 成降级态；不照搜索链返空）。三个币对固定 `USDCNY` / `HKDCNY` / `USDHKD`，反向取倒数；不做**链式交叉**（如 `USD→HKD` 用 `USDCNY ÷ HKDCNY` 算 —— 腾讯三角不闭合约 0.057% 且三对时间戳可差 2 分钟，交叉出的数字任何源都没直接给过）。**`capturedAt` 一律取我们自己的采集时刻**（plan D5）：vendor 的 `f5` / 新浪时间戳**只进日志作 `EVIDENCE:` 证据**，🚫 作为该汇率的时效 —— 实测 `f5` 可一路推进而 `f3` 纹丝不动，照直写就是拿新时间戳给旧数字背书。注释按 `comment-provenance.md` 标 `EVIDENCE:`（腾讯裸 curl 无 Referer / 无 UA 即返有效数据，2026-09-17 实拉；不写成「必须带 Referer + 浏览器 UA」，那条原记录已被实测推翻） → verify: `pnpm nx test server src/optionsdesk/tencent-fx.adapter.spec.ts src/optionsdesk/sina-fx.adapter.spec.ts src/optionsdesk/fx-rate-fallback-chain.adapter.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 腾讯正常响应 ⇒ 三对齐出 ② 腾讯抛 ⇒ 平移新浪、记 warn，结果来自新浪 ③ 两源全败 ⇒ **抛**（不返空数组；branch 8 的前置）④ 新浪请求头含 `Referer` ⑤ **喂两次响应：vendor 时间戳推进而汇率值不变** ⇒ 两次 `capturedAt` **不同**（是我们的采集时刻，不是 `f5`）⑥ 反向对 `CNYHKD` ⇒ 由 `HKDCNY` 取倒数得出，不直接请求反向码 ⑦ 无任何交叉计算路径（断言 `USDHKD` 不由另两对相除得出）；`RUN_FX_VENDOR_IT` 门控块（默认 skip，per `testing.md` §4 步 4）校真字段：22 字段 / `f3` 可解析 / 新浪 `idx3` / 反向三对 MISS；定向变异：a. `capturedAt` 改取 `f5` → ⑤ 红 · b. 全败改为返空 → ③ 红 · c. 去掉新浪 `Referer` → ④ 红且真 vendor 块 403（留档）

- [ ] T003 [Server] **`fx-rate-cache.adapter.ts`：进程内单格 + single-flight + 失败不入缓存**（FR-002, FR-009; plan D4; state_branches 18; US1）：新建缓存装饰器，照 `marketdata/futu-market-state.adapter.ts:132-182`。**一格存三对**（P1 实证单请求取全三对 ⇒ 天然单键语义）；不引入 Map / LRU / 淘汰策略。**single-flight**：冷缓存下 N 个并发同时 miss，纯 TTL 缓存在那一瞬间完全不设防（`:147-150`）。**失败不入缓存**（`:164`）：一次抖动会把降级态钉死整个 TTL，而降级是用户可见的。**不加 jitter**（`:129-130`：jitter 防的是「多键同秒集体过期」，单键上加它只是照抄形状）。**TTL 取 60s 量级**常量（有据：3.5 分钟采样内 CNY 两对零变化、`USDHKD` 变 1 次 ⇒ 分钟级）；常量旁注明**外汇 24h 交易、没有「下一个刷新窗」可锚** ⇒ 用固定秒数，不照抄 `get-quotes.usecase.ts:22` 的「TTL 锚到下次 EOD」 → verify: `pnpm nx test server src/optionsdesk/fx-rate-cache.adapter.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 第一发打 vendor、第二发（TTL 内）⇒ **不打**（调用计数 1）② TTL 过期后 ⇒ 再打 ③ **失败不入缓存**：注入一次失败后下一发 ⇒ **真打** vendor（调用计数 +1，不在整个 TTL 内复读失败）④ **single-flight**：冷缓存下并发 4 发 ⇒ vendor 调用计数**恰为 1**、四个 caller 拿到同一结果 ⑤ 缓存命中时 `capturedAt` 为**首次采集**时刻（不随读取移动）⑥ 缓存未命中且取数进行中 ⇒ 调用方可区分「加载中」与「已失败」（branch 18 的前置）；定向变异：a. 去掉 single-flight → ④ 红（计数 4）· b. 失败也写入缓存 → ③ 红 · c. `capturedAt` 改为每次读取时刻 → ⑤ 红（留档）

- [ ] T004 [Server] **config 两个 FX baseUrl + `ALLOWLIST` 登记 + module 按 `kind` 装配（mock 档拒绝壳）**（FR-002; plan D3, D4, Complexity Tracking; US1）：`config/marketdata.config.ts` 的 **`live` 分支**加两个带 `.default()` 的 baseUrl（`tencentFxBaseUrl` → `https://qt.gtimg.cn`、`sinaFxBaseUrl` → `https://hq.sinajs.cn`），形态与注释体例照同文件 `eastmoneyClistBaseUrl`（`:21`）/ `tencentCalendarBaseUrl`（`:24`）—— **同 vendor 不同 host ⇒ 独立 baseUrl，共享 profile / 限频**。两者**有 `.default()` ⇒ 归 `check-env-sync.ts` 的 `ALLOWLIST`（`:67`），不进 `.env.example`**（per `config-env-sync` rule §归属判定 2：默认值真相留在 `.config.ts`）；ALLOWLIST 条目旁按该文件体例写一行注释说明归属理由。新建 `refusing-fx-rate.adapter.ts`：**调用即抛**的拒绝壳，立意照 `marketdata/refusing-collection.adapter.ts`（**跨 ctx 不可 import，另落一份**）。`optionsdesk.module.ts` 按 `marketdataConfig.kind` 绑 FX port：`live` ⇒ 缓存装饰器包 FallbackChain；**`mock` ⇒ 拒绝壳**（本地 dev 与 IT 不得真打腾讯）。**`OptionsdeskModule.imports` 不变、`apps/server/eslint.config.mjs` 零改动** —— FX 住本 ctx，不经 marketdata、不读其表、不注其 port（ADR-0062 四条 trigger 一条未命中） → verify: `pnpm nx run server:typecheck` 绿；`pnpm tsx scripts/checks/check-env-sync.ts` exit 0；`pnpm tsx scripts/checks/check-server-moat.ts` exit 0（本片零新表，`MODEL_OWNERSHIP` 无需改，确认仍绿）；`pnpm nx test server src/optionsdesk/refusing-fx-rate.adapter.spec.ts --skip-nx-cache` 先红 → 绿，臂：① `mock` 档调用 FX port ⇒ **抛**且错误信息点明「本地 dev 不打真 vendor」② `live` 档 ⇒ 绑到缓存装饰器 ③ `git diff --stat apps/server/src/optionsdesk/optionsdesk.module.ts` 的 `imports` 段无改动 ④ `git diff apps/server/eslint.config.mjs` 为空；定向变异：mock 档改绑真 adapter → ① 红（留档）

### US1：折算与读端点（P1 · MVP）

- [ ] T005 [Server] **`display-currency.rules.ts`：逐行折算 + 降级判定 + 组聚合置 null**（FR-002, FR-003, FR-004, FR-006, FR-008, FR-012; plan D2, D6; state_branches 6, 7, 8, 9, 10, 11, 12, 13; US1/US3）：新建纯函数文件，**本片正确性的核心**。导出 `convertRows(rows, { target, rates })` ⇒ 逐行：**选定币种 = 该行原币种 ⇒ 直出原值、不进折算路径**（FR-008，避免乘 1 的舍入差）；可折算 ⇒ 金额类（单行市值、单行持仓盈亏）按 `Prisma.Decimal` 折算，**价格类（现价 / 成本价 / 行权价）一律不折**（FR-003）；**降级**（所需汇率不可用 ∨ 该行 `currency` 为 `null`）⇒ 金额类置 **`null`** + 标出该行原币种。**降级组的机械处理是本片最关键的复用**：置 `null` 后喂给既有 `buildPositionGroups`，`signedSum`（`broker-position-display.rules.ts:116-117`，非空带符号求和 / 全空 ⇒ null）与 `compareGroups`（`:190-205`，`|groupMarketValue|` 降序 → **null 排末**）**自动**实现 FR-006「不混入求和」与 FR-012「降级组沉底」，**零新排序键、零改既有比较器**。⚠️ **必须显式实现的一条**：含降级行但**也有**可折算行的组，其 `groupMarketValue` 是非 null 的部分和 ⇒ 不会被 null 分支沉底 ⇒ **组只要含降级行就把两个聚合值都置 `null`**，让「沉底」与「不完整标记」由同一个判定驱动（否则会出现「标了不完整却没沉底」）。🚫 **把「陈旧」判成降级**（plan D6：在岸 CNY 盘前会给数小时前的值，判成不可用会让盘前整屏退回原币种；**本片不设陈旧阈值** —— 没有阈值就没有「阈值定错导致整屏降级」这一类失效面）。复杂度：逐行折算 O(n)，分组与排序仍 O(n log n)（注释写明） → verify: `pnpm nx test server src/optionsdesk/display-currency.rules.spec.ts --skip-nx-cache` 先红 → 绿（fixture 汇率用合成值，**避开 `0.8` / `0.6` / `1.2` 子串**，见 Guardrail 3），臂：① **选定币种 = 原币种 ⇒ 直出**：断言输出 Decimal **字符串逐字相同**（`toFixed` 比较，**不是** `.equals()` 数值相等）**且**折算函数调用次数为 **0**（spy）（branch 6；FR-008）② 选定 ≠ 原 ∧ 汇率可用 ⇒ 金额类折算、**价格类三项逐字不变**（branch 7；FR-003）③ 汇率不可用 ⇒ 该行金额类为 `null` + 标原币种，**输出不含任何折算数字**（branch 8）④ 该行 `currency` 为 `null` ⇒ 同 ③（branch 9）⑤ 组内各行可折算 ⇒ 先逐行折算再聚合，组市值 / 组盈亏为选定币种（branch 10）⑥ **组聚合不许混入降级行**：组内 2 行可折算 + 1 行降级 ⇒ 组市值**恰等于前两行折算值之和**、且组标不完整（branch 11；把第三行原币种值也加进去会得到一个不同但「看起来合理」的数）⑦ 全部组可完整折算 ⇒ 折算前后**组顺序逐项相同**（branch 12；同屏同币种 ⇒ 等比例缩放；SC-002）⑧ **降级组沉底要能区分「根本没实现沉底」**：构造「A 组可完整折算、折算后市值**小**」+「B 组含降级行、原币种市值**大**」⇒ 断言 **A 排在 B 前**（branch 13；若实现把降级组的 `groupMarketValue` 留成原币种裸和，B 会因绝对值大而排前 —— 两种实现都排得出顺序、都不会红）⑨ 降级组之间及组内各行**保持原有相对顺序**（FR-012）⑩ **陈旧不触发降级**：喂一个远早于当前的 `capturedAt` ⇒ **照常显示折算值**并保留时刻（不降级；spec Edge Case）；定向变异：a. 选定=原币种时改走「乘以 1」路径 → ① 红（`.equals()` 断言在此**不会**红，故必须用逐字与 spy）· b. 组内含降级行时只置 `marketValue` 不置 `unrealizedPl` → ⑥ 红 · c. 降级组的 `groupMarketValue` 留原币种裸和 → ⑧ 红 · d. 陈旧判为降级 → ⑩ 红（留档）

- [ ] T006 [Server-IT] **读端点接线：可选 query + 响应汇率信息 + 降级态 catch**（FR-001, FR-002, FR-003, FR-004, FR-006, FR-007, FR-008, FR-009, FR-011, FR-012, FR-013; plan D1, D2, D5; state_branches 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20; US1/US2/US3）：`list-broker-positions.usecase.ts` 在 `:250` 拿到 rows 之后、调 `buildPositionGroups` **之前**接入 T005 逐行折算；`broker-account.controller.ts` 的 `GET /api/v1/optionsdesk/broker-positions` 加**可选** query `displayCurrency ∈ USD | HKD | CNY`，**缺省 = 该 market 的原币种**（⇒ 老客户端行为逐字节不变，SC-006 的机械保障）。响应：顶层加参考汇率信息（币对 / 汇率值 / **我们的 `capturedAt`** / 是否可用），行加「是否已折算 + 呈现币种」，组加「聚合是否完整」。FX 全源失败 ⇒ **catch 成降级态**（整屏走原币种 + 标注），不让端点 500。**`displayCurrency` 不进任何 `where`**（Guardrail 4）。DTO **nullable 标量必显式 `type`**（否则生成类型退化成 `{ [key: string]: unknown } | null`）。不新增端点、不新增 use case（ADR-0043 复审线 30，当前 24 个 use case 不变） → verify: `pnpm nx test server test/integration/optionsdesk-085.display-currency.it.spec.ts --skip-nx-cache` 先红 → 绿（`Test.createTestingModule({ imports: [OptionsdeskModule] })` + `setupIsolatedDb`，经 HTTP 注入带真 JWT 调 controller，直接 prisma 种 `broker_*` / `anchor` 行；**FX port 是唯一允许的 test double**，不 mock `PrismaService`），臂：① **SC-006 逐字段比对**：同一夹具下**不带** `displayCurrency` 与带「该市场原币种」两次响应**逐字节相同**（branch 1, 2；这是「上线前后一致」唯一可机器化的形态）② us 页签缺省 ⇒ USD、各行即原值、**响应不含汇率信息**（branch 1, 14）③ hk 页签缺省 ⇒ HKD、同上（branch 2, 14）④ `displayCurrency=CNY` ∧ 汇率可用 ⇒ 金额类折算、价格类仍原币种、**响应含汇率值与 `capturedAt`**（branch 7, 15）⑤ FX port 注入失败 ⇒ **端点仍 200**、整屏降级为原币种并标注、不 500（branch 8）⑥ 某行 `currency` 为 `null` ⇒ 该行降级（branch 9）⑦ 组内含降级行 ⇒ 两个聚合值均标不完整且未混入求和（branch 11）⑧ 降级组沉底、可完整折算组在前（branch 13）⑨ 全可折算时折算前后组顺序相同（branch 12）⑩ 账号无任何持仓 ⇒ 200 + 空组 + 汇率信息字段形态合法（branch 20；选择器可用性的服务端半）⑪ **`displayCurrency` 不进 `where`**：同一账号两种币种请求 ⇒ 返回的**行集合与 id 逐条相同**，仅呈现字段不同 ⑫ 非法 `displayCurrency`（如 `JPY` / 空串）⇒ 400，不静默落默认 ⑬ 汇率取数进行中 ⇒ 响应可区分「加载中」与「已失败」（branch 19 的服务端半）；定向变异：a. 折算挪到 `buildPositionGroups` **之后** → ⑦⑧ 红（先聚合再折算会把降级行原币种值混进 `signedSum`）· b. `displayCurrency` 加进 `where` → ⑪ 红 · c. 缺省改为恒 `USD` → ①③ 红 · d. FX 失败改为上抛 → ⑤ 红（留档）

- [ ] T007 [Contract] **OpenAPI 导出 + api-client 重生成**（FR-002, FR-007; plan Constitution §V, Guardrail 6; US1/US2/US3）：**两步分别跑**：`pnpm nx run server:export-openapi` → `pnpm nx affected -t generate`（🚫 只跑第二步 —— `api-client:generate` 无 `dependsOn`，漏第一步会拿上一版 json 重生成、产物逐字节相同、CI 全绿，`api-contract.md:56-67`）。核对新增的 `displayCurrency` query 与响应新字段可被 mobile import → verify: `git diff --stat apps/server/openapi.json packages/api-client/src/generated/` **非空**；`grep -n 'displayCurrency' apps/server/openapi.json` 有命中；`pnpm nx run mobile:typecheck` 绿；`pnpm tsx scripts/checks/check-api-property-nullable.ts` exit 0；**nullable 标量字段在生成类型里是 `string | null` 而非 `{ [key: string]: unknown } | null`**（逐个新字段核，per `reference_api_contract_pitfalls`）

### US2：不改变默认视图，切换是临时的（P1）

- [ ] T008 [P] [Mobile] **`display-currency.rules.ts`（mobile）+ 文案段**（FR-001, FR-005, FR-006, FR-007, FR-011, FR-013; plan D0, D7, D9; state_branches 1, 2, 3, 4, 5, 14, 15, 20; US2/US3）：新建 `apps/mobile/src/optionsdesk/display-currency.rules.ts`：导出 `DISPLAY_CURRENCIES = ['USD','HKD','CNY']`（档位值域，不设「原币种」档 —— 单市场下与该市场币种档显示逐字相同）· `defaultCurrencyForMarket(market)` ⇒ `us → 'USD'` / `hk → 'HKD'`（FR-011）· `initialCurrencyState()` ⇒ `Record<'us'|'hk', DisplayCurrency>` 各自为其市场原币种（D7 **每页签一格**）· `showFxRateLine({ market, current })`（仅在展示币种 ≠ 该市场原币种时为真，FR-007 / FR-011）· `degradedRowLabel(row)` / `groupIncompleteLabel(group)`（标记判定，两个聚合值**都要标**）。`optionsdesk-copy.ts` 在 **083 既有 `tradingAccountPositions` 段内**新增 key（币种档位标签、参考汇率行、加载中、降级行标、组不完整标、选择器 a11y 名）；**不并入 081 的 `tradingAccount` 段**（`trading-account.rules.spec.ts:46-50` 断言该段全部字符串不含「暂无 / 空仓 / 无数据」，并进去当场红）。措辞照 mockup：**「参考汇率」** + 时刻，不写「实时」/「可用于结算」（FR-007）；币种一律三字母代码（`市值（USD）` 体例 `:1472-1474`），不用货币符号 → verify: 新建 `display-currency.rules.spec.ts` 先红 → 绿（`pnpm nx test mobile`），臂：① `defaultCurrencyForMarket('us')` ⇒ `USD`、`('hk')` ⇒ `HKD`（branch 1, 2）② `initialCurrencyState()` ⇒ 两格各自为原币种（branch 1, 2）③ 改一格 ⇒ **另一格不变**（branch 4；FR-005 各记各的）④ 切页签只读另一格、不写任何格（branch 3）⑤ `showFxRateLine` 在 币种=原币种 时为假（branch 14）、≠ 时为真（branch 15）⑥ 档位值域恰三档且不含「原币种」（FR-001）⑦ 降级行标含该行原币种三字母代码 ⑧ 组不完整标**两个聚合值都返回**（FR-006；只标一列会让人以为另一列完整）⑨ 文案段穷举：新增 key 全部非空且无货币符号（`¥` / `$` 零命中）⑩ `git diff origin/main -- apps/mobile/src/optionsdesk/trading-account.rules.spec.ts` 为空且该 spec 仍绿；定向变异：a. 状态形状改为单格（非每页签一格）→ ③ 红 · b. 文案并入 `tradingAccount` 段 → 081 的 `trading-account.rules.spec.ts` 红（留档后还原）

- [ ] T009 [Mobile] **`currency-selector.tsx` + 屏级每页签一格状态 + query key 加币种**（FR-001, FR-005, FR-009, FR-011, FR-013; plan D1, D7, D8; state_branches 3, 4, 5, 16, 17, 20; US2）：新建 `currency-selector.tsx`：收起态显示当前币种 + `▾`（复用 083 的 `CARET` 几何符号 `:73`），展开为**右对齐浮层**、三档带勾（mockup 新增 4 类 `.cursel` / `.curmenu` / `.curopt` / `.tick`，取值全部来自既有 `--nvy-*` token，**0 新 token、0 新色**；承载面 `.phone` 需 `position: relative`）；用 RN 内置 `Pressable` + 绝对定位 `View`，不引入新组件库。位置：**并入「同步于 …」行右侧**（`trading-account-positions.tsx:241` 的 `PositionsMeta`，`margin-left: auto` 形态）—— 实测该行余量 234px 放得下，而「参考汇率」行余量仅 83px、列头行高 31px 均放不下；省掉一整条控件行（57px），列表可用高度 542 → 599px。**状态放屏组件 `trading-account-screen.tsx` 的 `useState`，向下传 prop**（D7）：形状为 `Record<'us'|'hk', DisplayCurrency>`（T008）。🚫 **放 `trading-account-store.ts`** —— 083 e2e 双臂实证屏级 `useState` 生命周期**恰好等于** FR-005 要的语义（`:652` 进详情返回**仍保留**「列表屏未卸载」`:661` / `:616` 返回雷达再进**复原**「本屏卸载」`:639` / `:1346` 复证），放 store 会让「离开交易账户页再进入」仍保留上次币种，**直接违反 FR-005 与 SC-005**。**必须放屏组件、不能放列表组件 `TradingAccountPositions`** —— 切分段 positions↔orders 会卸载后者（`trading-account-screen.tsx:46-52` 是条件渲染），放那里切个分段就重置。`use-trading-account-positions.ts:16` 的 query key 常量**加币种维度** ⇒ 切档即取数、切回已取过的档命中缓存（SC-004 靠这个，不靠额外优化）。不改列表既有列宽与字号（`COL` 常量 `:64-69`；SC-007） → verify: `pnpm nx test mobile` 绿 + `pnpm nx run mobile:typecheck` 绿；e2e 臂在 T011 闭环，臂（本 task 的逻辑面）：① query key 含币种维度 ⇒ 两档各自独立缓存 ② 选择器收起态显示当前币种（FR-013）③ `COL` 常量与字号 `git diff` 为空（SC-007）；定向变异：状态改放 `trading-account-store.ts` → T011 的「返回雷达再进入复原」臂红（留档）

### US3：汇率拿不到时不骗我（P2）

- [ ] T010 [Mobile] **汇率行 + 降级行标 + 组「合计不完整」标 + 加载态**（FR-006, FR-007, FR-011, FR-013; plan D8; state_branches 8, 9, 11, 14, 15, 18, 19; US3）：`trading-account-positions.tsx` 接入：**汇率行**仅在展示币种 ≠ 当前市场原币种时出现（`showFxRateLine`，FR-007 / FR-011），显示汇率值 + `capturedAt`（按设备本地展示），措辞「参考汇率」；**加载中显示加载态，不先渲染未折算数字再跳变**（mockup 帧 ④）；**陈旧照常显示 + 标注时刻**，不因陈旧隐藏或清空（spec Edge Case）。**降级行**的币种标用行级徽标（`:448-454` 的 `row.expired` 既有形态；mockup 称 `.chip`，RN 侧无此名，底色 `bg-warn-soft` 是警示语义，币种标需另定底色）。**组级「合计不完整」挂 `.c-mv` 与 `.c-pl` 合计值下方、用 `.num2` 而非 `.chip`** —— 后者带 `align-self: flex-start`，塞进 `align-items: flex-end` 的列会左对齐而数字右对齐、参差不齐；**两列都要标**（FR-006 的「聚合值」是组市值与组持仓盈亏两个，只标一列会让人以为另一列完整）。组头那一行**挂不下**行级标注（390px 机身下名称列只剩约 120px，caret + 组名已占满）。不改列宽或降字号（SC-007） → verify: T011 的 e2e 续臂先红 → 绿；`pnpm nx test mobile` 绿，臂（呈现面，逻辑断言）：① 币种 = 原币种 ⇒ 汇率行**不存在**（branch 14）② ≠ ⇒ 汇率行含汇率值与时刻、文案含「参考汇率」且**不含**「实时」/「结算」（branch 15）③ 降级行带原币种徽标（branch 8, 9）④ 降级组两列**都**出现「合计不完整」（branch 11）⑤ 汇率加载中 ⇒ 加载态可见且**金额位为占位**，无未折算数字（branch 18）⑥ `capturedAt` 远早于当前 ⇒ **照常显示折算值** + 标注时刻（branch 19）；定向变异：a. 只标 `.c-mv` 一列 → ④ 红 · b. 加载中先渲染未折算数字 → ⑤ 红 · c. 陈旧时清空金额 → ⑥ 红（留档）

### E2E · 契约 · 门

- [ ] T011 [Mobile-E2E] **e2e 扩臂：选择器交互 + 切档重算 + 降级与汇率行**（FR-001, FR-006, FR-007, FR-009, FR-011, FR-013; plan D8; state_branches 1, 2, 8, 11, 13, 14, 15, 16, 17, 18, 20; US1/US3）：`e2e/optionsdesk-trading-account-positions.spec.ts` 扩臂（数据全合成，mock `/me` + refresh + 本片端点；e2e 必 mock refresh，per `reference_mobile_test_pitfalls`）。**币种状态的跨屏 / 跨页签语义拆在 T015**（analyze F2）—— 本 task 只覆盖**单屏内**的交互与呈现 → verify: `pnpm nx run mobile:e2e-public` 全绿，臂：① 进入 hk 页签 ⇒ 展示 HKD、无汇率行（branch 2, 14）② 点选择器 ⇒ 展开三档、当前档带勾（branch 16）③ 选 CNY ⇒ 收起、金额即时重算、分组与排序按新币种重排、汇率行出现（branch 17, 15）④ 汇率不可用响应 ⇒ 降级行带原币种标、屏上**无任何 CNY 单位的港股金额**（branch 8；SC-003）⑤ 降级组沉底且两列标「合计不完整」（branch 11, 13）⑥ 汇率加载中 ⇒ 加载态、无未折算数字跳变（branch 18）⑦ 空持仓账号 ⇒ **选择器仍可见可点**（branch 20）⑧ 切档后列表**无二次跳变**（SC-004）⑨ 切档前后列宽与字号断言不变（SC-007）；定向变异：a. 汇率行改为恒显示（不判币种是否等于原币种）→ ① 红 · b. 降级组的两个聚合值不置 null → ⑤ 红（留档）

- [ ] T015 [Mobile-E2E] **e2e 币种状态三臂：跨屏保持 / 离开复原 / 两页签独立**（FR-005, FR-010, SC-005; plan D7; state_branches 3, 4, 5, 21; US2）：**本 task 由 analyze F2 从 T011 拆出**（原 T011 标记臂数 24，超 082 K1 阈值 12）—— 这四臂是 FR-005 / SC-005 的唯一机器化落点，**缺任一臂错误实现都会绿**，单列便于失败定位。同一 e2e 文件续臂，数据全合成 → verify: `pnpm nx run mobile:e2e-public` 全绿，臂：① 切档后**进持仓详情再返回** ⇒ **仍为所选币种**（列表屏未卸载；照 083 T015③b `:652` 形态）② 切档后**返回雷达再进入** ⇒ **复原为该市场原币种**（本屏卸载；照 083 T015③ `:616` 形态；branch 5）③ 在 hk 切 CNY 后**切到 us** ⇒ **us 为 USD**，再切回 hk ⇒ **仍为 CNY**（branch 3, 4）④ 切档后**进持仓详情** ⇒ 详情页金额与价格**仍为原币种**（branch 21；FR-010）；定向变异：a. 状态改放 `trading-account-store.ts` → ② 红（离开该页仍保留上次币种）· b. 状态改单格而非每页签一格 → ③ 红 · c. 详情页也接展示币种 → ④ 红（留档）

- [ ] T012 [P] [Contract-Smoke] **契约冒烟加一条带 `displayCurrency` 的请求**（FR-002; plan Gate 0.1; state_branches 1; US1）：`e2e/contract-smoke/optionsdesk-trading-account.contract.ts` 加一条：用生成的 `@nvy/api-client` 打 testcontainers 真 server，带 `displayCurrency` 请求持仓列表 ⇒ 断言 200 且响应含汇率信息字段（真 server 的 FX port 在冒烟装置里为 mock 档 ⇒ 走降级态，断言**降级形态合法**而非折算值）；补的是 hermetic mock 与 server IT 都覆盖不到的缝（生成 client ↔ 真 server 的契约对齐） → verify: `pnpm nx run mobile:contract-smoke` 本条绿；变异留档：临时把生成 client 的 `displayCurrency` 参数名改错一个字符 ⇒ 本条红（证明真的打到 server 且参数真被消费）

- [ ] T013 [Gate] **真机窄屏核（Mate50 dev-client）**（FR-001, FR-013, SC-007; plan Gate 0.1, D8; state_branches 15, 16, 17）：**web e2e 视口宽松 ⇒ 系统性漏测**（`.claude/rules/mobile-impl-playbook.md` § RN 布局陷阱）—— 选择器嵌在「同步于 …」行右侧，mockup 实测该行余量 234px，**390px 真机上是否溢出只有真机 / 窄视口能判**。按 `run-local-env` skill / `ops/runbook/local-dev.md` 起 dev-client 连本地 Metro，打开交易账户页：① 收起态选择器与「同步于 …」文本**同行不溢出、不换行**（最长币种文案下）② 展开浮层**右对齐、不超出机身、不被列头遮挡**③ 三档可点、选中态勾可见 ④ 切档后金额列（含万缩写最长值）**不溢出、不挤压名称列**、列宽与字号肉眼与切档前一致（SC-007）⑤ 汇率行文案在 390px 下**不换行**⑥ 降级组两列「合计不完整」标**不与数字重叠**⑦ 切档到列表重绘 ≤ 1 秒（SC-004，计 3 次取最大） → verify: 七项结论（通过 / 不通过 + 一句观测）写进 PR body；**截图含真实持仓 ⇒ 只存本机 `specs/085-optionsdesk-display-currency/design/`（gitignored），🚫 贴 PR body / commit / issue**（per `information-boundary`）；任一项不通过**停下回 plan**，不在 impl 内改方案

- [ ] T014 [Gate] **覆盖收口 + 全量门 + 私有数据扫描 + PR**（SC-001, SC-002, SC-003, SC-004, SC-005, SC-006, SC-007）：逐条核对下方五张覆盖预检表（**实时 grep，不抄表内数字**，per `sdd-authoring` 反模式）；spec `status → implementing`、`updated_at` bump；tasks `status → in-progress` → verify: `git fetch origin && pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` 按终态串判定通过（`local-verification.md` §2；输出落文件后 grep `Successfully ran target` / `Failed tasks`，不接 `| tail`，hook 会拦）；`scripts/checks/*.ts` 治理脚本全扫 exit 0（含 `check-server-moat` / `check-test-size` / `check-time-semantics` / `check-identifier-boundary` / `check-api-property-nullable` / `check-optionsdesk-rule-constants` / `check-env-sync` / `check-spec-frontmatters`）+ `check-commit-msg-parseable.ts --range origin/main..HEAD`；私有数据扫描：`git diff origin/main...HEAD` 与 PR 正文对仓外私有清单（`ops/bin/gen-private-values.sh` 产出）逐值子串比对，**命中 0**，真值不写入任何文件 / 命令行 / 日志；`gh-bot pr create` 按 `pr-creation-protocol.md`（`--repo` 显式、body 按模板、3 个 hard-gate checkbox **真跑绿才勾**）；本片**无不可逆变更**（零 migration / 零 secrets / 零删除）⇒ 按 `git-workflow.md` 默认接 auto-merge

## 依赖与并行

```text
T001 → T002 → T003
T001 + T004 → （T004 的 module 装配需 port 已定义）
T002 + T003 + T004 → T006
T005 [P 与 T001-T004 之后的链并行]
T005 + T006 → T007
T007 → T008 [P] → T009 → T010
T009 + T010 → T011 → T015
T007 → T012 [P]
T011 + T015 → T013
全部 → T014
```

- **T001 → T002**：解析纯函数先立，adapter 才有东西调。
- **T002 → T003**：缓存装饰器包的是 FallbackChain。
- **T004 依赖 T001** 的 port 定义（装配需要 token），但与 T002 / T003 的实现细节无关，可在 T001 后随时做。
- **T005 与 FX 链并行**：折算规则只依赖「给定汇率表」这个入参形状，不依赖 FX 怎么取到。
- **T006 是汇合点**：需要 FX 链（T002-T004）与折算规则（T005）都在。
- **T007 → mobile 全部**：mobile 消费生成类型，regen 不完成 typecheck 必红。
- **T009 → T010**：汇率行与降级标挂在选择器已接入的列表上。
- **T011 是 mobile 侧汇合点**：单屏交互与降级呈现的断言需要 T009 的选择器 + T010 的呈现都在。
- **T011 → T015**：同一个 e2e 文件续臂，T015 复用 T011 已铺好的 mock 与夹具；且 T015 的跨屏臂要先有一个能跑通的切档动作。
- **T013 在 T011 + T015 之后**：e2e 两片全绿再上真机，避免把 e2e 能抓的问题留到真机。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> **本表编号 = `spec.md` frontmatter `state_branches` 的行序（`spec.md:18-38`），逐行同序**。

| # | branch（摘要） | 落点 |
|---|---|---|
| 1 | 进入持仓页 ∧ us ⇒ USD，不折算，不出汇率信息 | T006-①② + T008-①② + T011-①（hk 同构臂）+ T012 |
| 2 | 进入持仓页 ∧ hk ⇒ HKD，同上 | T006-①③ + T008-①② + T011-① |
| 3 | 切换市场页签 ⇒ 该页签自己的当前值 | T008-④ + T015-③ |
| 4 | 在某页签切币种 ⇒ 仅该页签生效 | T008-③ + T015-③ |
| 5 | 离开交易账户页再进入 ⇒ 复原（不持久化） | T015-② |
| 6 | 选定 = 原币种 ⇒ 原值直出，不走折算路径 | T005-① + T006-① |
| 7 | 选定 ≠ 原 ∧ 汇率可用 ⇒ 金额折算、价格类仍原币种 | T005-② + T006-④ |
| 8 | 选定 ≠ 原 ∧ 汇率不可用 ⇒ 降级标注，无折算数字 | T001-②③ + T002-③ + T005-③ + T006-⑤ + T010-③ + T011-④ |
| 9 | 该行币种未知 ⇒ 同「汇率不可用」降级 | T001-②（解析前置）+ T005-④ + T006-⑥ + T010-③ |
| 10 | 组内各行可折算 ⇒ 先逐行折算再聚合 | T005-⑤ + T006-④ |
| 11 | 组内存在降级行 ⇒ 两个聚合值均标不完整，不混入求和 | T005-⑥ + T006-⑦ + T010-④ + T011-⑤ |
| 12 | 跨组排序 ∧ 全部可折算 ⇒ 顺序与原币种下相同 | T005-⑦ + T006-⑨ |
| 13 | 跨组排序 ∧ 存在降级组 ⇒ 沉底，组内保持相对顺序 | T005-⑧⑨ + T006-⑧ + T011-⑤ |
| 14 | 展示币种 = 原币种 ⇒ 不出参考汇率信息 | T006-②③ + T008-⑤ + T010-① + T011-① |
| 15 | 展示币种 ≠ 原币种 ⇒ 显示汇率值及取数时刻，不改列宽字号 | T006-④ + T008-⑤ + T010-② + T011-③⑨ + T013-①⑤ |
| 16 | 点击选择器 ⇒ 展开三档，当前档标选中 | T011-② + T013-②③ |
| 17 | 选中某档 ⇒ 收起，即时重算，聚合与排序重排 | T011-③⑧ + T013-④⑦ |
| 18 | 汇率尚在加载 ⇒ 加载态，不先显示未折算数字 | T003-⑥ + T006-⑬ + T010-⑤ + T011-⑥ |
| 19 | 汇率取数时刻已陈旧 ⇒ 照常显示并标注，不隐藏清空 | T005-⑩ + T010-⑥ |
| 20 | 账号无任何持仓 ⇒ 币种选择器仍可用 | T006-⑩ + T011-⑦ |
| 21 | 进入持仓详情页或订单页 ⇒ 一律原币种 | T015-④ |

## Functional Requirements 覆盖预检

| FR | 落点 |
|---|---|
| FR-001 三档选择器、收起态显当前、非平铺分段 | T008-⑥ + T009-② + T011-②⑦ + T013-①②③ |
| FR-002 金额类四项折算 | T005-② + T006-④ + T007 + T012 |
| FR-003 价格类三项不折算 | T005-② + T006-④ |
| FR-004 聚合排序与显示同一币种口径 | T005-⑦⑧ + T006-⑧⑨（**防御性约束**，见「蓄意零覆盖」） |
| FR-005 不持久化、本次停留保持、两页签各自独立 | T008-③④ + T015-①②③ |
| FR-006 降级行标原币种、组两个聚合值标不完整、不混入求和 | T005-③④⑥ + T006-⑤⑥⑦ + T008-⑦⑧ + T010-③④ + T011-④⑤ |
| FR-007 显示汇率值与取数时刻、措辞为参考汇率 | T002-⑤ + T006-④ + T008-⑤ + T010-①②⑥ |
| FR-008 原币种相同时直出，不引入舍入差 | T005-① + T006-① |
| FR-009 切档即时重算重排，无需手动刷新 | T003（缓存支撑）+ T006 + T009（query key）+ T011-③⑧ |
| FR-010 作用范围限于持仓列表页 | T015-④ |
| FR-011 首次进入某页签为该市场原币种且与上线前一致 | T006-①②③ + T008-①② + T010-① + T011-① |
| FR-012 降级组沉底、保持相对顺序 | T005-⑧⑨ + T006-⑧ + T011-⑤ |
| FR-013 收起态显当前币种、降级行标原币种、不改列宽字号 | T006-⑪（呈现字段）+ T008-⑦ + T009-②③ + T010-③ + T011-⑨ + T013-④ |

## Success Criteria 覆盖预检（SC 是系统性盲区，单列一张）

| SC | 落点 |
|---|---|
| SC-001 100% 金额类以选定币种显示，降级行 100% 带原币种标 | T005-②③④ + T006-④⑤⑥ + T011-④ |
| SC-002 排序与显示大小关系 100% 一致、折算前后组顺序 100% 相同 | T005-⑦ + T006-⑨ |
| SC-003 汇率不可用时错误金额数量为 0 | T005-③ + T006-⑤ + T011-④（屏上「无任何 CNY 单位港股金额」断言） |
| SC-004 切档 1 秒内完成重算重排、无二次跳变 | T009（每档独立 query key）+ T011-⑧ + T013-⑦（真机面） |
| SC-005 再进入两页签各为原币种 100%、停留内保持 100%、跨页签影响 0 次 | T008-③④ + T015-①②③ |
| SC-006 金额数值与排序与上线前 100% 一致（逐字段比对） | T006-①（两次响应**逐字节相同**，唯一可机器化形态） |
| SC-007 列宽与字号 100% 不变 | T009-③（常量 `git diff` 为空）+ T011-⑨ + T013-④ |

## Edge Case 覆盖预检

| Edge Case（摘要） | 落点 |
|---|---|
| 选定币种 = 该行原币种 ⇒ 直出，避免乘 1 舍入差 | T005-①（逐字 + spy 双断言）+ T006-① |
| 同屏各行必然同币种 ⇒ FR-004 是防御性约束 | T005-⑦ + T006-⑨（见「蓄意零覆盖」） |
| 跨组排序遇降级组沉底，不让裸值与折算值比大小 | T005-⑧ + T006-⑧ |
| 汇率加载中不得先渲染未折算数字再跳变 | T003-⑥ + T010-⑤ + T011-⑥ |
| 汇率陈旧仍照常显示并标注时刻，不清空隐藏 | T005-⑩ + T010-⑥ |
| 账号无持仓时选择器仍可用 | T006-⑩ + T011-⑦ |
| 币种 = 原币种时不出汇率信息 | T006-②③ + T010-① + T011-① |
| 进详情再返回不算「离开」，币种不复原 | T015-① |

## Acceptance Scenario 覆盖预检（标准矩阵**够不到**这一层）

| AS | 落点 |
|---|---|
| US1-AS1 切 CNY ⇒ 两页签金额均 CNY、可跨市场比较 | T006-④ + T011-③ |
| US1-AS2 CNY 下组顺序与原币种下相同、排序与显示同口径 | T005-⑦ + T006-⑨ |
| US1-AS3 us 页签 USD ⇒ 市值与原始回报一致、无数值变化 | T005-① + T006-①② |
| US1-AS4 CNY 下现价与成本价仍 USD 并带币种标识 | T005-② + T006-④ |
| US1-AS5 CNY 下进详情 / 订单页 ⇒ 仍原币种 | T015-④ |
| US2-AS1 进 hk 页签 ⇒ HKD、与上线前数值排序完全一致 | T006-①③ + T011-① |
| US2-AS2 币种 = 原币种 ⇒ 无汇率信息、无折算数字 | T006-②③ + T010-① |
| US2-AS3 切 CNY 后离开再进入 ⇒ 复原 | T015-② |
| US2-AS4 切 CNY 后进详情返回 ⇒ 仍 CNY | T015-① |
| US2-AS5 us（USD）切到 hk（本次未切过）⇒ HKD | T008-④ + T015-③ |
| US2-AS6 hk 切 CNY 后切 us ⇒ USD；再切回 hk ⇒ 仍 CNY | T008-③ + T015-③ |
| US3-AS1 HKD→CNY 不可用 ⇒ 各行 HKD 并标注、屏上无 CNY 港股金额 | T006-⑤ + T011-④ |
| US3-AS2 某行券商未回报币种 ⇒ 降级、不被默认成任何币种 | T005-④ + T006-⑥ |
| US3-AS3 组内混合 ⇒ 两个聚合值均标不完整、降级行未混入求和 | T005-⑥ + T006-⑦ + T010-④ |
| US3-AS4 可完整折算组与降级组并存 ⇒ 降级组在后、组内相对顺序不变 | T005-⑧⑨ + T006-⑧ + T011-⑤ |
| US3-AS5 CNY 且汇率可用 ⇒ 页头显汇率值与取数时刻、措辞为参考汇率 | T002-⑤ + T006-④ + T010-② |

**蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：**

- **零 `[Ops]` 上线后验收 task**：本片 7 条 SC **全部可机器化**（见 SC 表，落点全在 rules / IT / e2e / 真机门）。与 083 / 084 的差别在那两片的 SC 含「与券商 App 逐行比对真实持仓」这类只能人工的判据，本片是**纯呈现口径改造、零写路径、零真数依赖**。故意不配 Ops task。
- **FR-004 的排序错位不配专门回归测试**：spec Assumptions 与 `checklists/requirements.md` 判据 1 已定 —— 持仓列表恒按单一市场页签呈现、服务端亦按单市场过滤（`list-broker-positions.usecase.ts` 的 `findMany({ where: { accountId, market } })`）⇒ 同屏各行必然同币种，折算是等比例缩放，「按原币种排序、按折算币种显示」的错位在本 feature 范围内**结构上不可能发生**。它由 T005-⑦ / T006-⑨ 的「折算前后顺序相同」连带钉住；保留 FR-004 是为将来出现跨市场汇总视图时有正确判据。
- **「原币种」档不存在** ⇒ 无对应分支、无 task。单市场下「选 HKD」与「选原币种」显示结果逐字相同（spec Clarifications 已定三档）。
- **新浪 `idx3` 的更新频率**（plan「未能验证的事项」）：放 T002 的 `RUN_FX_VENDOR_IT` 门控块做长窗采样（≥ 30 分钟、跨在岸 CNY 开盘），**是消法不是本片验收门** —— 它只影响**备源**（腾讯全败时才用），且 D5 已把上屏时刻锁在我们自己的 `capturedAt`、不会拿 vendor 时间戳背书。若证实是死字段，则把新浪降为「仅在腾讯失败时提供一个明确标注更旧的值」或整条去掉备源（FR-006 的降级路径本就覆盖「取不到」）。
- **腾讯 CNY 报价偏差是否稳定在 0.08% 量级**：只做过一次同刻对拍，不影响本片用途（看总量，维护者 2026-09-16 已定维持腾讯 + UI 标「参考汇率」）。将来用途升级到任何**结算 / 对账**前必须先补多轮对拍 —— 不在本片范围。
- **`f11` 语义未定** ⇒ **不消费它**，无 task。
- **FR-010 的「订单列表 / 详情页」不配独立断言**（第二轮 analyze F4，结构论证）：折算只发生在 `list-broker-positions.usecase.ts`，即 `broker-account.controller.ts:78` 的列表端点（`:102` 收 `@Query`）。两个详情端点走别的 use case 且都不收 query —— `broker-positions/:id`（`:109` → `getBrokerPosition.execute` `:139`）与 `broker-orders/:id`（`:146` → `getBrokerOrder.execute` `:175`）；mobile 侧也各走独立 query key（`use-trading-account-position.ts:32` / `use-trading-account-order.ts:29`），不复用列表缓存。⇒ 折算路径在结构上够不到任一详情屏，FR-010 自动成立。订单分段目前还是 `PlaceholderCard`（`trading-account-screen.tsx:46-52`），不渲染任何金额。T015-④ 作为持仓详情的防御臂保留，订单详情不另配臂。
- **T004（config + 装配）与 T014（门）不出现在任何覆盖表落点** —— **故意的，不是漏挂**：T004 是接线与环境门控（两个 baseUrl、`ALLOWLIST` 登记、mock 档绑拒绝壳），T014 是全量门与 PR，两者都不承载 spec 层的 `state_branches` / FR / SC / AS，验收全在各自 `→ verify:` 内闭环。⇒ 下轮 analyze **不要**为它们补覆盖表行。

## Implementation Strategy

MVP = **T001 → T007**：到这里 server 侧折算链与契约完整成立，US1 的「金额按选定币种折算、价格类不折、降级不骗人」在 IT 层可独立验收（`SC-006` 的逐字节比对也在此闭环）。US2（T008-T009）补 mobile 选择器与每页签一格状态这条 FR-005 / SC-005 的正确性底线，US3（T010）补降级呈现。T011 汇合单屏交互与降级呈现的 e2e，**T015 单列币种状态三臂**（analyze F2 从 T011 拆出，FR-005 / SC-005 的唯一机器化落点），T012 并行补契约缝，T013 真机窄屏门，T014 收口发 PR。

Clear 检查点批次：`T001-T003` / `T004-T005` / `T006-T007` / `T008-T009` / `T010-T011` / `T015 + T012` / `T013-T014`（每批次后停顿提醒 `/clear`，per Constitution §III）。
