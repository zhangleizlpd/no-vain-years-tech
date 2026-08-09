---
feature_id: 045-optionsdesk-anchors-radar
spec_ref: ./spec.md
status: drafted
created_at: 2026-08-01
updated_at: 2026-08-01
adr_refs: [ADR-0024, ADR-0030, ADR-0032, ADR-0040, ADR-0043, ADR-0048, ADR-0053]
context7_verified: []
---

# Implementation Plan: 045-optionsdesk-anchors-radar（optionsdesk M1 — 锚管理 + 击球区雷达）

> **PROSE-ONLY**。数据模型 SoT = `apps/server/prisma/schema.prisma`；API 面 SoT = `@nestjs/swagger` 装饰器（code-first）。**不镜像**任一进本文，设计意图写在 Architecture Notes。
> **Spec**: [`spec.md`](./spec.md) ｜ **Mockup baseline**: [`design/handoff.md`](./design/handoff.md)（11 帧）｜ **需求 SoT**: [p1 §5 P1/P6](../../docs/private/plans/2026-07/07-23-sellput-viz-p1-requirements.md) ｜ **跨 ctx 接线 SoT**: [p3b §4.7](../../docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md)

## Summary *(mandatory)*

落地 `optionsdesk` 这个新 bounded context 的**首片**：锚管理（愿买价锚 CRUD + `confidence → L 层 → 单票上限` 两级派生链 + 字段级变更痕迹）与击球区雷达（按距 W 升序、SQL 端排序/筛选 + 游标分页的一屏决策面），外加承载二者的导航改造（期权台 tab 顶替灵感 tab + 全局抽屉）。**零 vendor I/O**：正股行情已由另一 worktree 落进既有 `marketdata.daily_bar`，本片经 Q7-B 只读直查消费；反向由 marketdata 主动读锚表算采集闸。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**零新第三方依赖是硬指标不是巧合** —— SC-009 明写「实现引入的新第三方依赖数 = 0」。两处最可能破防的地方已各自定案：

- **全局抽屉**不引 `@react-navigation/drawer`，复用仓内既有 RN `Modal` 范式（D11）。锚点：`apps/mobile/src/chat/chat-drawer.tsx:162-169` 已实装同形态（Modal + `statusBarTranslucent` + `navigationBarTranslucent`）。
- **四区间色带**不引绘图库，纯 `View` 组合（D12）。锚点：色带 = 5 段矩形 + 2 圆点 + 2 竖线，均为 RN `View` 原生能力；`react-native-svg` 虽在库（`chat-drawer.tsx:34` 已 import）但在此零收益。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

| 原则 | 本片如何满足 |
|---|---|
| **§I SDD** | spec → clarify（两轮 15 问收敛）→ **Mockup**（11 帧，UI feature 强制步已走）→ **plan（本文）** → tasks → analyze → implement，卡点不跳 |
| **§II TDD** | 派生链 / 色带几何 / 回落语义均为纯函数，先测后写；跨 ctx 读与采集闸走 Testcontainers IT。无 bash 侧逻辑（不存在 044 那类 §II 缺口） |
| **§III Atomic** | 每 task 30min-2h + 各自 commit；每 2-3 个强关联 task 一个 clear 检查点批次 |
| **§IV Module Boundary** | 新 ctx **扁平内构**（文件平铺，无 domain/application/infrastructure 层）+ **贫血**（直注 `PrismaService`，无 repository port，无 Domain Class）+ **护城河**（跨 ctx 只读直查 + `CROSS-CONTEXT-READ`，零跨 ctx 写）。6 条注册面见 D1 |
| **§V PR 边界** | 跨端 feature ⇒ server impl + IT + api-client regen + mobile 消费 + 两层验证**全部同 PR 原子 merge** |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（Testcontainers PG）覆盖每个新端点至少一次 —— 锚 CRUD / 复审 / 雷达读端各一条；雷达那条在 IT 内**塞真行 us `Instrument` + `DailyBar`** 验真落库读通（spec 明定的验收方式，不依赖任何 vendor）。
- [x] **Mobile / Web**: 每条 P1 user story 走 golden-path —— US1 建锚改锚、US2 雷达五态、US3 抽屉与 tab 集合。**US3 的 markets OFF 态必须用公开版构建（`EXPO_PUBLIC_FEATURE_MARKETS=false`）真验**，见「风险 1」。
- **Evidence**: 待 impl 期回填（本 gate 在 plan 期声明覆盖面，证据随 tasks ship）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A — 本片零新第三方包 / SDK / 工具**（见 § Dependencies 的两处防破防定案）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** `optionsdesk` 是 2026-07-31 新定名的 context，无 meta-repo（Java/Spring）前身，不存在 stale Java 类名 / Maven 坐标 / Spring `@RequestMapping` 路径面。

本片引用的既有代码锚点已全部 `stat` 实证存在（`eod-backed-quote.adapter.ts` / `marketdata.types.ts` / `marketdata.controller.ts` / `sync-tier-recalc.ts` / `feature-flags.ts` / `chat-drawer.tsx` / `(tabs)/_layout.tsx`），无 stale 引用。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

p3b §4.7 注册面第 6 条**点名**要求新 ADR 含两条显式复审记录，逐条判定如下（两条 trigger 原文已核）：

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| **ADR-0048** | sunset_trigger #2：「出现必须**server 端强一致同步读** marketdata 的场景（下单校验需实时价、不能容忍最终一致）→ 跨层方向假设失效，重审」 | **accepted-as-is** | **未命中**：本片 spot 一律走 `last_close` + 显式 asOf（FR-036），盘中实时已明确推迟；读是 Q7-B 最终一致只读直查，非强一致同步读。**命中条件写进新 ADR 作绊线** = P3 许愿单触发判定需实时价，或盘中实时 spot 上线 |
| **ADR-0053** | sunset_trigger #2：「**第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`** → 重审是否升级为共享 package 而非继续点对点放行」 | **accepted-as-is** | **未命中**：本片**不 import** `marketdata/*.rules.ts`。雷达 spot = 最新未复权收盘价（与既有 `eod-backed-quote.adapter.ts` 读 `adjust:'none'` 同口径），只取单点不取序列 ⇒ 用不到 `deriveAdjustedBars` 前复权换算。**命中条件作绊线** = 将来雷达/详情要画历史序列需读时复权 |

**Evidence**: 新 ADR-0062（`docs/adr/0062-optionsdesk-bounded-context.md`）随首个 impl PR 落地，须含 7Q 逐条判定 + 跨 ctx 面清单（每条标 Q7-B）+ 上表两条复审记录。编号已核（现最大 ADR-0061）。

## Architecture Notes *(mandatory)*

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

### 🚨 Impl Guardrails（并发 / 前端 — 详版见 mono conventions）

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable。同 ticker 并发建锚撞唯一约束时 catch **P2002**。scheduler 逐行独立 tx。→ `../../docs/conventions/server-impl-playbook.md`
- **前端（mobile）**：锚表单走 **RHF + zodResolver** 4 铁律（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）；复用 `~/theme` + `~/ui`（design token 直搬**不重设计**）；**mutation 必失效对应 list query key**（建锚/删锚/改 list-visible 字段 → 失效雷达与锚列表 key，否则列表陈旧到重启）。→ `../../docs/conventions/mobile-impl-playbook.md`
- **安全**：本片无 PII / 无凭据 / 无反枚举面（单用户自有策略资产），相关条目 N/A。

---

## 触点清单

**Server**（新 ctx，扁平内构）

| 文件 | 动作 |
| --- | --- |
| `apps/server/src/optionsdesk/optionsdesk.module.ts` | **新** — ctx 根 module |
| `optionsdesk.types.ts` / `optionsdesk.dto.ts` | **新** — DTO + swagger 装饰器承载面 |
| `anchor.rules.ts` | **新** — 纯函数：W / 四区间 / L 层映射 / 单票上限 / 愿卖锚（档位常量具名、单点可改，FR-030） |
| `create-anchor.usecase.ts` / `update-anchor.usecase.ts` / `delete-anchor.usecase.ts` / `review-anchor.usecase.ts` | **新** — 写侧（含痕迹落库 + 生效 L 层求值） |
| `list-anchors.usecase.ts` / `get-anchor.usecase.ts` / `get-radar.usecase.ts` | **新** — 读侧（雷达含游标分页 + SQL 端筛选 + 跨 ctx 读行情） |
| `sync-anchor-quote.ts` | **新** — `lastClose` / `lastCloseDate` 单向投影（跨 ctx 只读直查 `marketdata.daily_bar`，D4/D5） |
| `optionsdesk.controller.ts` | **新** — REST + swagger（API SoT） |
| `prisma/schema.prisma` + 1 migration | **新** schema `optionsdesk` + 2 表（D2） |
| `apps/server/eslint.config.mjs` | 改 — 新元素 + 新 from 规则 + **11 条既有规则各加一项**（D1-3） |
| `scripts/checks/check-server-moat.ts` | 改 — `MODEL_OWNERSHIP` 登记新表 + `BUSINESS_CTX` 加 `optionsdesk` |
| `apps/server/src/marketdata/anchor-driven-sync-gate.ts` | **新** — 反向读锚表重算 `needSync`（D7） |
| `apps/server/src/marketdata/dimension-executor.ts` | 改 — 前置步骤挂上重算（与 `SyncTierRecalc` 并列） |
| `docs/conventions/business-naming.md` / `docs/adr/0062-*.md` | 改 / **新** |

**Mobile**

| 文件 | 动作 |
| --- | --- |
| `apps/mobile/src/optionsdesk/**` | **新** — 雷达屏 / 锚列表屏 / 锚表单屏 / 色带组件 / copy / hooks |
| `apps/mobile/app/(app)/(tabs)/optionsdesk.tsx` | **新** — tab 落地屏（雷达）+ `MarketsRouteGuard` |
| `apps/mobile/app/(app)/optionsdesk/**` | **新** — 二级页 stack（锚管理 / 锚表单），照 `portfolio/` 先例 |
| `apps/mobile/app/(app)/(tabs)/_layout.tsx` | 改 — TABS 集合变更 + ideation 转 `href:null` + FAB 槽心连带（D10） |
| `apps/mobile/src/ui/app-drawer.tsx` | **新** — 抽屉通用容器（自 `chat-drawer.tsx` 抽骨架，D11） |
| `apps/mobile/src/chat/chat-drawer.tsx` | 改 — 改为消费通用容器，chat 特有内容留本地 |
| `apps/mobile/src/core/markets-gate.tsx` | 改 — `MARKETS_SURFACES` 登记三处受控面（D14） |
| `apps/mobile/src/ui/` 图标 | 改 — 新增期权台 `TabIconName` |
| `packages/api-client/**` | regen（Constitution §V 类型同步链） |

## Decisions

### D1 · `optionsdesk` 物理落地与 6 条注册面（首个 impl PR 内一次做齐）

`business-naming.md` 明写「加新模块时 server 目录 + mobile 目录 + prisma schema 必须同时落地」，由 ESLint boundaries + Prisma CI 拦截。p3b §4.7 checklist 逐条落地：

1. **`schema.prisma`**：`schemas` 从 7 项加到 8 项（现值 `["account","alert","chat","ideation","marketdata","portfolio","public"]`），新表各挂 `@@schema("optionsdesk")`。
2. **`eslint.config.mjs`**：`boundaries/elements` 加 `{ type:'optionsdesk', pattern:'src/optionsdesk/**' }`；新增一条 `from:{type:'optionsdesk'}` 的 disallow —— 禁 `auth`/`portfolio`/`alert`/`chat`/`ideation`/`agent-bridge`，**放行 `marketdata`**（唯一合法读边）。
3. 🚨 **把 `optionsdesk` 追加进现有 11 条 from 规则的每个 disallow 数组**（已实证 `grep -c "from: { type:" = 11`）。boundaries 是 `default: allow` ⇒ **漏一处 = 静默给对方开了一条到我们这里的边**。这是最易漏的一条，impl 后用 grep 逐条核。
4. **`check-server-moat.ts`**：`MODEL_OWNERSHIP` 登记新表 owner + `BUSINESS_CTX` 加 `optionsdesk`。漏了则 Check 2 对本 ctx 的跨 ctx 注入**静默失效**，且别人一读我们的表就 `moat-unmapped` 硬拒。
5. **`business-naming.md`** 模块行加 `optionsdesk`。
6. **新 ADR-0062**，含 7Q 逐条判定 + 跨 ctx 面清单 + Gate 0.4 两条复审记录。

> ⚠️ **顺带发现一处既有不一致，mention 不改**：`check-server-moat.ts` 的 `BUSINESS_CTX` 只有 7 项（`auth/account/portfolio/marketdata/alert/chat/ideation`），**缺 `agent-bridge`**，而 boundaries elements 有它 —— 两处清单已不同步。不属本 feature scope；但我们加 `optionsdesk` 时**两处都要加**，别只加一处再制造一次同样的偏差。

### D2 · 两张表，落库边界严格按 FR-003a 分档

判据是「**是否参与 SQL 筛选/排序**」与「**是否带人工状态**」，**不是**变更频次。

| 表 | 承载的设计意图 |
| --- | --- |
| **锚主表** | 身份与事实：`ticker`（canonical `market:code`，**唯一约束** per FR-001）/ `V` / `asof` / `method` / `confidence` + `confidence_source` / `excluded` + `exclude_reason` / `next_review`；**人工位三列**（`V` / L 层 / 单票上限的人工值，带人工状态 ⇒ 是事实不是派生）；**生效 L 层**（参与 SQL 筛选，D3）；`last_close` + `last_close_date`（投影，D4）；**本轮跌破首次观测日**（复核锚红标判据，FR-013 的持久化载体） |
| **变更痕迹表** | 一行 = **一次变更**（改动时间 + 变更字段集 + 改前值 + `source`），非一行一字段 —— FR-031 原文是「本次变更的字段集」，mockup 帧 ⑧ 亦如此呈现。锚 id **不级联删**（FR-031：删锚本身也是一条痕迹） |

**不落库**（请求时算，FR-003a ①）：`W` / 四区间边界 / 愿卖锚两档 / 距 W%。口径仍在演进，物化必 drift。

**档位常量不建表**：L 层映射档（≥9/7–9/3–7/<3）、单票上限档（L1≤25%/L2~5%/L3~2%）、愿卖锚两系数（长持 1.2 / 收租 1.0）、W 系数 0.8 —— 全部落 `anchor.rules.ts` 顶部具名常量即满足 FR-030「配置化、不硬编码档位数值」（可单点改、零散落）。建配置表要配 CRUD 面，Senior Engineer Test 不过。
🚨 **愿卖锚必须是两个独立系数**，MUST NOT 把收租写死为「等于 V」—— 当前两者相等是取值巧合而非定义（FR-003）。

### D3 · 生效 L 层落**普通列**，应用层写入时求值（FR-033）

- **为什么落列**：它是雷达筛选主维度（FR-034 L1–L4 多选），必须能被 `WHERE` 直接过滤；300–500 锚规模下拉全量到客户端再筛直接失效。
- **为什么不是 DB 生成列**：映射算法后续会演进（spec 明说），生成列改算法要 DDL 变更。
- **写入时求值** = 所有影响它的路径（建锚 / 改 confidence / 改 L 层人工位 / 撤销 / 模型 import）在应用层算完再写 ⇒ **映射算法变更时 MUST 提供批量重算路径**（一条 CLI，FR-033 末句）。
- **一致性铁律**：任一时刻每个数只有**一个生效值**（FR-006 末句）。人工位列存「人工值」、生效列存「最终值」，语义不同不冲突；系统 MUST NOT 存第二份生效 L 层或生效上限。

### D4 · `last_close` 单向投影（FR-036）

锚表落 `last_close` + `last_close_date`，**单向**写入；`marketdata.daily_bar` 是唯一真相源，读端 **MUST NOT 反写**。

- **为什么必须投影**：距 W% = `(last_close − 0.8V) / 0.8V`。要让它成为 SQL **可排序**表达式（将来可加表达式索引），两个操作数必须**同表**。跨表 join 到 `marketdata.daily_bar` 排序 = 把跨 ctx 读拖进排序键路径，既慢又把护城河边界拖进查询计划。
- **对外呈现以 `last_close_date` 作 asOf**（FR-016），否则「最长延迟一天」不可验证。
- **写在哪一侧？→ optionsdesk 侧。** marketdata 不知道锚表存在（方向铁律）；我们在自己的同步步骤里从 `daily_bar` 拉最新 bar 回填自己的列，走 Q7-B 只读直查 + `CROSS-CONTEXT-READ` 注释。

### D5 · 跨 ctx 读行情：Q7-B 只读直查（FR-027）

接线面现成、**零新契约**（已逐行核对）：`Instrument(market_code)` → `DailyBar(instrumentId, adjust:'none', 最新 tradeDate)`（`eod-backed-quote.adapter.ts:35-45`，**完全 market-agnostic、零 cn/hk 硬编码**）；`QuoteSnapshot`（`marketdata.types.ts:137-150`）已带 `asOf` / `priceKind` / `hasData` 三件套。us 日线落进既有 `DailyBar` 后读端零改动自动有数（`us_equity_bar` 是纯 seed 无 DDL，#752 已落定）。

- 禁 `@Inject()` marketdata 的 use case（Q7-C 明令禁止）。
- 注释挂**构造器注入参数上方 / prisma 调用上方** —— `check-server-moat.ts` AST 探针只认这两处，挂 import 上方**不被采信**。
- `priceKind` 值域扩一档表示「回落到 EOD 快照」（FR-027）。
- 🚨 **降级态渲染仍是 MUST**：种子 7 票现已有数（prod 实测 16,726 行 / 缺口 0），但新开的第 8 只锚在开闸后首个 cron 跑完前仍是 `hasData=false`。不能因「现在有数」省掉降级路径（FR-017）。

### D6 · 建锚搜票复用既有端点，本片**零新 marketdata 端点**

`GET /marketdata/search`（`marketdata.controller.ts:101`，已实证在库：东财 searchapi 主源 + pg_trgm 本地兜底，无 market 过滤 ⇒ us 天然可搜，无匹配返空 200 不 5xx）。下拉项字段取该端点现有响应形状（`InstrumentSearchResponse`），**impl 期对齐，不新增字段**。FR-002 硬约束：**不接受自由文本**，搜不到即不能建锚、不提供绕过。

### D7 · 采集闸反向：marketdata 侧按锚表重算 `needSync`（FR-028 / FR-029）

**接线点已实证**：`Instrument.needSync`（`schema.prisma:347`）就是采集闸，其注释白纸黑字写着 **「us 新标的由 `SyncUniverseUseCase.upsert` 的 create 分支落 false（无锚不采）」** —— 这个设计早为本 feature 预留，045 是来接上它的。消费点已实证 3 处（`dimension-executor.ts:611` 工作集筛范围、`marketdata-backfill.cli.ts:207/373`）。

实现**逐字照抄** `sync-tier-recalc.ts`（p3b 点名的先例，已逐行读过）：

- **位置**：`marketdata/anchor-driven-sync-gate.ts`，作为维度 executor 的**前置步骤**，与 `SyncTierRecalc` 并列。
- **读法**：`prisma.<锚表>.findMany` + `// CROSS-CONTEXT-READ:` 注释（对照 `sync-tier-recalc.ts:89` 读 `portfolio.watchlist_item`）。
- 🚨 **降级纪律照抄 `:38-41`**：整方法 try/catch 全包，失败只 `logger.warn` + 返 `null`、**不上抛** —— 否则污染 marketdata 的 `SyncRun` 状态（FR-029）。
- 🚨 **禁**把 optionsdesk 注册进 marketdata 的 `SyncDimension` / executor 钩子（方向铁律：底座不依赖业务）。
- **`excluded` 不参与闸判定**（FR-028）：判据严格是「有没有锚」。语义分工 = **锚 = 采集意愿，excluded = 交易意愿**；要彻底停采只能删锚。决定性理由 = 期权 EOD **无跨日补救**，停采造成永久断层。
- ⚠️ **写侧只碰 `needSync` 一列**。该列与 `syncTier` / `lixingerCompanyType` 同属 schema 注释点名的**受保护列**（universe 同步的 update 路径不得覆盖），我们的重算是唯一另一个合法写入点。
- **时序**：建锚 → 下一轮 cron 前置步骤重算 → 纳入工作集。与 SC-003「下一轮后台采集中被自动纳入」一致；**不是**建锚即时生效（即时生效需跨 ctx 写，p3b 已禁）。

### D8 · 游标分页 + SQL 端筛选（FR-033 / FR-034）

- **游标 = `(距 W%, 锚 id)` 二元组**，keyset 而非 `OFFSET`。理由（spec 原文）：排序键随 spot 每日变动，`OFFSET` 在翻页期间数据刷新时漏行或重复行，而**漏看一只即等于本功能失效**。
- **tiebreaker 必须有**：距 W% 是浮点会并列，SQL 不保证并列行顺序稳定，无 tiebreaker 则游标跳行 ⇒ 锚 id 升序作唯一 tiebreaker，排序全序可复现。
- **筛选在 SQL 端求值**：生效 L 层（普通列，D3）/ `next_review` 逾期 / 跌破 W（`last_close < 0.8V`，同表表达式 —— D4 的收益兑现处）。
- 前端走**下拉增量加载**，禁页码控件（FR-010；且游标分页天然不支持跳页）。
- **空态三分**（FR-015 + FR-034）：全体不动区（「今日无解，空仓是常态」）/ 零锚（引导建锚）/ **筛选无结果**（「当前筛选无结果」+ 清除筛选）。三者 MUST NOT 复用文案。

### D9 · 人工值 = 临时语义的实现形态（FR-035）

三处人工位（`V` / L 层 / 单票上限）各存人工值列 + 生效值。回落触发路径**恰好三条**，可观测性各不同：

| 路径 | 冲掉什么 | 可观测性要求 |
| --- | --- | --- |
| ① 模型批量 import 刷 `V` / `confidence` | 三处人工值 | **产出差异报告文件**逐条列被回落项，**禁静默回落** |
| ② 人工改 L 层 | 单票上限的人工值 | 同屏立即可见（用户正在该表单内） |
| ③ 手工锚改 `confidence`（仅 `confidence_source=manual`） | 沿两级链冲掉 L 层与单票上限 | 同屏立即可见 |

- **差异报告 = import 脚本产出的报告文件，App 内不做页面**（user 2026-08-01 定）。M1 的 import 走批量脚本。
- **`confidence` 按来源门控**（FR-001）：`model` 只读、`manual` 可改；import 写入时把来源翻 `model` ⇒ 该锚**自动转只读，无需人工干预**。
- **模型 import MUST NOT 重置 `next_review`、MUST NOT 解除逾期红标** —— 复审是人的确认，模型出新值不构成确认；否则模型一跑红标全清、复审机制失效。
- **边界（spec Edge Case）**：人工值**恰好等于**派生值时仍须标记为人工态，不得因值相等而静默视为未调整 —— 否则痕迹里丢失「这个值是谁设的」，PIT 还原分不清 `source`。
- **展示措辞**：凡人工态，同屏 MUST 标明「**人工调整 · 下次上游刷新将回落**」+ 其派生值（FR-032 ②），措辞须表达**临时**语义，与 2026-08-01 前的「永久覆盖」区分。

### D10 · 底部 tab 集合变更 + 灵感转抽屉入口（FR-021 / FR-025 / FR-026）

已逐行读过 `(tabs)/_layout.tsx`，三个实装事实决定做法：

1. **`TABS` 数组**：`ideation` 项换成 `{ name:'optionsdesk', label:'期权台', icon:<新>, gated:true }`。
2. **ideation 路由保留在 `(tabs)/` 下**，单独渲染一个 `href:null` 的 `Tabs.Screen`（照 `create` 占位路由写法），**不移出 tabs**、**不进 `TABS` 数组**（否则参与 FAB 槽心计算）。理由 = FR-025 要求「路由、嵌套 stack 与中央 FAB 新建入口零回归」：**中央 FAB 与 `IDEATION_FULLSCREEN_ROUTES` 的 tab 栏隐藏逻辑都活在 tabs layout 层**，把 ideation 移出 tabs 会同时打掉这两样 = 直接回归。
3. 🚨 **`href:null` 必须留在静态 options 对象里**（该文件已有的血泪注释）：expo-router 在布局期读**静态** `href` 决定 tab 是否渲染，options 用函数形式时 `href` 不被采纳 → **门控失效、tab 在公开版漏出**。而 ideation 恰恰是当前唯一用函数形式 options 的 tab（为动态隐藏 tab 栏）—— 本次它要转 `href:null`，**两者会撞**。impl 须把 `href:null` 走静态对象、tab 栏隐藏另寻落点，并以**公开版构建**真验（见风险 1）。

🚨 **纠正 mockup 帧 ⑪ frame-note 的一处误导（以本 plan 为准）**：那条写「FAB 是 `left:50%` 绝对居中 ⇒ 无需随 tab 数重算」。**那是 mockup 的 CSS 行为，不是实装行为。** 实装 `fabLeftPct` 一直按可见 tab 集合动态计算：

```text
fabLeftPct = (leftVisible + 0.5) / (leftVisible + 1 + rightVisible) × 100
```

- **现状**（TABS = 首页 / 灵感 / 投资ᵍ / 我的）：ON → 50%，**OFF → 62.5%**（灵感不 gated，左侧仍 2 个）。
- **045 后**（TABS = 首页 / 期权台ᵍ / 投资ᵍ / 我的）：ON → 50%，**OFF → 50%**（左右各剩 1 个）。

⇒ FR-026 要的「随可见 tab 集合重算」**既有实装已满足，本片不改公式**；OFF 态 FAB 从 62.5% 变 50% 是 tab 集合变更的正确连带结果，**不是回归**。mockup 帧 ⑪ 画的 50% 结果对、给的理由错。

### D11 · 全局抽屉：从 `chat-drawer` 抽骨架到 `~/ui`（FR-023 / SC-009）

已逐行读过 `chat/chat-drawer.tsx`。它**不是**通用容器 —— 深度耦合 chat 业务（`useConversations()` / `ConversationList` / `CHAT_COPY` / `currentConversationId` 等 props）。所以「复用」的准确含义是**抽骨架、留业务**：

| 归属 | 内容 |
| --- | --- |
| **抽到 `~/ui/app-drawer.tsx`（通用）** | RN `Modal`（`transparent` + `statusBarTranslucent` + `navigationBarTranslucent` → root 层挂载，遮罩盖住 Tab 栏与状态栏）/ backdrop 淡入 + tap 关 / 面板 `translateX` 滑入（82% 宽）/ swipe-left 关手势 / 安全区内缩 / `onRequestClose` 接 Android 硬件返回 / 关态 unmount |
| **留在 `chat/`（业务）** | 搜索框、会话列表、新建对话及其 copy |
| **App 级抽屉内容** | 品牌头 + **菜单区（本片仅「灵感」一项）** + 用户脚（头像/昵称/齿轮→设置）。挂在 tabs layout 层 |

- **0 新第三方依赖**（SC-009）：`Modal` / `Reanimated` / `gesture-handler` / `safe-area-context` 全在库。**不引 `@react-navigation/drawer`**（spec 已论证：SDK 54 需外装；Drawer 包 Tabs 要动 `(app)/_layout.tsx` 那段专治 web 硬刷新返回按钮的 `unstable_settings` anchor；navigator 级边缘手势还会与后续 P2 选约表横向滑动抢）。
- ⚠️ **`chat-drawer` 重构必须零回归**：它有既有 e2e testID 契约（`chat-drawer` / `-panel` / `-backdrop` / `-search-input` / `-new-conversation` / `-user-name` / `-settings-button`）。抽取时**逐个保留 testID 落点**，否则 chat 的 e2e 整片红。
- ⚠️ 抽取时保留该文件记录的两条硬约束：① **`Animated.View` 上不能挂 NativeWind className**（reanimated#8329 整串被吞），视觉 token 必须下沉到内层 plain View；② 面板宽用百分比时**要包一层 View 约束 frame**。
- **FR-025 已按 user 2026-08-01 决定收窄**为「抽屉**菜单区**只承载灵感一项」—— 品牌头与用户脚是抽屉结构性组成，不计入「菜单入口」。

### D12 · 四区间色带用**纯 View** 绘制，不引 SVG（FR-011）

mockup 用绝对定位百分比表达几何契约：内段 `[0.6V, 1.2V]` 严格等比例、两端各留 7% 作示意端帽 ⇒ **W 恒在 35.67%、V 恒在 64.33%**（带宽以 V 归一化，与具体票无关）。RN 侧：

- **5 段矩形 + 2 圆点标记 + 2 竖线 + 刻度文字** 全是 `View` 原生能力（flex 百分比宽 + absolute 定位 + `borderRadius`）。SVG 在此**零收益**且多一层渲染树。
- **几何与钳制规则是契约，绘制手段不是**（handoff 原话）。契约 = 内段等比例、两端截断为端帽、端帽内 spot 钳制、**轴区内零文字**、W 界线标值且红色加粗、V 标在真实位置、两端不标界线值。
- 🚨 **小尺寸圆上禁用 dashed 边框**（mockup 2026-08-01 渲染实证：8px 圆加 `1.5px dashed` 退化成齿轮/星形）。钳制态用**空心点**（`background: surface` + `2px solid text`）。若真机辨识度不足可改其他非颜色手段（箭头/半点），但**不得**把 spot 画在带外或省略。

### D13 · 雷达行 = 5 字段（user 2026-08-01 定）

FR-010 列举的 5 字段与 mockup 的 6 个（多中文名）冲突，**解法 = 中文名并入「标的标识」算一个字段**：

```text
标的标识（ticker + 中文名） / 距 W% / 四区间色带 / spot / 徽标
```

二者同属「这是哪只票」一个信息维度。**同时删掉 `row-bot` 里 spot 串重复的「· 距 W xx%」**（标题行已有一份）—— 那才是真冗余。FR-010 措辞在 impl PR 内一并澄清。
**徽标顺序纪律**：L 层 → 区间 / 锚逾期 → 复核锚 / 提醒类；MUST NOT 渲染衍生徽标（「达标腿数」「直接买主案」等，FR-014）。

> 📌 **顺带纠正 handoff 的一处加码**：handoff 写「这撞上 SC-002『种子 7 票单屏可读』」并算出「须把行压到 ≤93px」。**SC-002 原文没有「7 票单屏」** —— 它要求的是「首屏 N 条可读 + 每行 ≤5 字段 + 下拉增量加载 + 无页码控件」，N 未指定；且 spec Assumptions 明说首批 ~50 锚、2–3 年 300–500 只，**单屏本就不是设计前提**。⇒ **「压到 ≤93px」不是验收门、本片不做**；真正要满足的「≤5 字段」已由本条解决。

### D14 · markets 门控落三处受控面（FR-022 / SC-008）

`markets-gate.tsx` 的 `MARKETS_SURFACES` 是「这套门控盖住了哪些对外面」的**唯一清单**（该文件自带 🔧 注释要求新增受控面必须登记）。本片加三条：

| kind | site | 机制 |
| --- | --- | --- |
| `tab-button` | `app/(app)/(tabs)/_layout.tsx` | `href:null` 隐藏按钮 |
| `tab-screen` | `app/(app)/(tabs)/optionsdesk.tsx` | `MarketsRouteGuard` 堵深链 |
| `route-stack` | `app/(app)/optionsdesk/_layout.tsx` | `MarketsRouteGuard` 堵二级页深链 |

**纯客户端一层，server 端点不加第二套**（FR-022，与既有 markets surfaces 同构）—— 合规目标是「公开发行的 App 不呈现行情」，server 面本就要求单用户鉴权、无匿名可达面。

### D14a · 雷达读端的基础语义与两处占位入口（收拢易漏项）

四条容易在 impl 期漏掉、且漏了不会红的约束：

1. **雷达默认视图 MUST 排除 `excluded = true`**（FR-005）—— 这是读端的基础 `WHERE` 条件，不是筛选项。同一条锚在**锚管理列表仍可见并显示 `exclude_reason`**（两个面对 excluded 的态度相反，别写成一个共用查询）。
2. **`L1 档为空不是校验错误`**（FR-008）：一期估值管道产不出 L1，雷达/锚列表 MUST NOT 因某档位无数据而报错或隐藏该筛选项。**禁**加「L1 必须有票」这类看似合理的校验。
3. **复核锚红标是个状态机，不是一次比较**（FR-013）。判据 = `spot < W ∧ 最近复审日期 < 本轮跌破首次观测日`，配套三条转移：
   - spot 回到 W 上方 → **清空**本轮跌破起点；其后再次跌破按**新一轮**重新触发（同日内反复穿越亦然）。
   - 建锚时 spot 已在 W 之下 → 本轮起点 = 建锚当日。
   - **行情不可用期间既不推进也不清空**，红标维持上一次可判定状态，与「行情不可用」标记一同呈现。
   - 解除方式**只有**完成一次定期复审（FR-007），**MUST NOT** 引入第二个独立确认动作/状态。红标是**提醒语义**，不拦截任何操作或跳转。
4. **两处「即将可用」占位**：雷达行可点进标的详情（FR-018）与题头 🌡 温度计（FR-019）—— 本片二者均不存在，MUST 以**明确的「即将可用」形态**响应，**MUST NOT 静默无反应或崩溃**。题头 ⚙ 是**真入口**（进锚管理），别一起做成占位。

**新鲜度文案复用既有实现**：「数据截至 X · 收盘」沿用既有 `formatAsOf` 体例（handoff 明确「impl 期直接复用，不重写」）—— 避免同一语义在两处各写一份格式化逻辑。

### D15 · 变更痕迹展示位：M1 放锚表单内

FR-031 只要求「痕迹可查 + 可按时点还原」，未规定展示位；handoff 也把帧 ⑦/⑧ 的痕迹段标为「呈现占位」。M1 沿用 mockup（表单底部一段），**不做独立入口** —— 独立入口要新路由 + 新屏 + 分页，超出 M1 最小闭环。表结构（D2）支持将来任意展示形态，改展示位不需要动数据层。

## Testing Invariants（per ADR-0040 + spec 47 条 `state_branches`）

1. **纯函数单测**（vitest 无 DB）：`anchor.rules.ts` 全部派生（W / 四区间 / L 层映射**含 3·7·9 档位边界归属** / 单票上限 / 愿卖锚两系数）；两级链回落语义（三条路径各一组 + 人工值等于派生值仍标记）；色带几何（内段等比例 / 端帽钳制 / **spot 恰好等于 W 的边界与区间归属取同一侧**）；徽标顺序；距 W% 排序含并列 tiebreaker。
2. **Testcontainers PG IT**：锚 CRUD + ticker 唯一约束；生效 L 层写入时求值的一致性（不出现第二份真相）；**游标分页翻页期间数据刷新不漏行/不重复**；SQL 端筛选与游标同时生效；变更痕迹逐条落库 + **删锚后痕迹保留**；PIT 还原与当时显示逐项一致（SC-011）；**塞真行 us `Instrument` + `DailyBar` 验雷达读端返真值**（不碰任何 vendor —— spec 明定的验收方式）。
3. **采集闸 IT**：建锚 → 重算 → `needSync` 开闸；删锚 → 移出且**历史数据不删**；`excluded=true` **仍在**工作集；**锚表读取失败只 warn 不上抛、不污染 `SyncRun`**（FR-029）。
4. **`[Mobile-E2E]` hermetic UI e2e**（Playwright Expo Web）：雷达五态（常态 / 不动区 / 降级 / 零锚 / 筛选无结果）；抽屉开合 + 遮罩盖 Tab 栏 + 硬件返回；一级页汉堡 / 二级页返回箭头；markets ON/OFF 两态 tab 集合与 FAB 位置；**灵感四项能力零回归**（列表 / 详情 / 图片标注 / 中央 FAB 新建，SC-010）。
5. **`[Contract-Smoke]` 契约冒烟**（node 层，`nx run mobile:contract-smoke`）：生成的 `@nvy/api-client` 打 testcontainers 真 server，一条 happy-path（建锚 → 读雷达 → 改 L 层 → 撤销）验契约对齐 + 真落库。
6. **无回归**：`marketdata` 既有 22 维度运行状态零变化（SC-007）；新增表使 schema 表数变化 ⇒ **断言表数/表清单的全景 IT 必破**，照 039-044 先例逐个更新期望值（**仅改既有 IT 期望，不动 045 impl**）。**必跑全 `nx test server`**。

> ⚠️ **`perf_budgets` 是回归探测器不是 SLA**（spec frontmatter 自带注释）。5 条预算均为先验值，**impl 后 MUST 拿真实测数校准一次**，否则会退化成没人回看的拍脑袋数字。

## 风险

1. **`href:null` 与函数形式 options 相撞**（D10-3）：ideation 是当前唯一用函数形式 options 的 tab，本次要给它加 `href:null`，而该文件血泪注释明说函数形式下 `href` 不被采纳。**这是本片最可能静默失败的一处**（公开版 tab 漏出 = 合规问题）→ impl 必须用**公开版构建**（`EXPO_PUBLIC_FEATURE_MARKETS=false`）真验，不能只看 dev。
2. **`chat-drawer` 重构打破 chat e2e**：抽骨架涉及 DOM 结构变化，testID 契约须逐个保住 → 抽取后**跑全 `runtime-smoke` 而非单 spec**（blast radius = 整套 e2e，per mobile-impl-playbook）。
3. **boundaries 第 3 条漏项静默开边**（D1-3）：11 条规则手工逐条加，漏一条不会红、只会静默放宽 → impl 后用 `grep` 核对每条 disallow 数组都含 `optionsdesk`。
4. **`needSync` 是受保护列**：我们成为它的第二个合法写入点。若将来 universe 同步的 update 路径被改动，可能覆盖我们的重算结果 → 在 `anchor-driven-sync-gate.ts` 头部写明这层耦合作为绊线。
5. **新开锚的首日空窗**：第 8 只锚开闸后、首个 cron 跑完前 `hasData=false` → 降级态是 MUST，不能因「种子 7 票现在有数」省掉（D5）。
6. **锚表落地后须与 prod 人工开闸的 7 票对账**（AOS / CPB / LULU / PEP / PSKY / TAP / VICI）：这 7 票的 `needSync` 是人工 SQL 开的，锚表接管后重算结果必须与之一致，否则说明闸逻辑与人工判断有偏差 → 作为 impl 收尾的一次性核对项。

## Out of Scope（继承 spec，另加）

- P2 标的详情 / P3 仓位与许愿单 / P4 持仓 / P5 复盘 / P7 温度计（雷达题头 🌡 仅「即将可用」）。
- 一切期权链数据；期权台内承载「雷达/仓位/持仓/复盘」的顶部 seg（M3 才引入；FR-020 明令本片不渲染 seg 控件）。
- 盘中实时 spot（显式 toggle 形态已定案，推迟到下一阶段）。
- `AnchorProvider` v1 Http 对外服务化（本片零消费方，FR-009）。
- 模型 import 的 App 内差异报告页（D9，脚本报告文件形态）。
- **7 只种子锚的 seed 脚本 / migration 塞数据**（user 2026-08-01 定）：**手工在 App 内建这 7 条锚** —— M1 的锚管理 UI 正是为此而生，为一次性的 7 条数据写 seed 代码不划算（Senior Engineer Test 不过），且手工建锚顺带就把建锚流程走了一遍。⚠️ 这意味着 **T028 的「7 票对账」有前置条件**：对账前你得先手工建好这 7 条锚（FR-008 的「初始白名单」由此满足，spec 只规定了「以这 7 只为初始白名单」、未规定建立方式）。
- 提醒器 / 推送（M4）；底部菜单栏完整规划（user 后续统一做，抽屉只迁灵感一项）。

## Complexity Tracking

> Fill ONLY if Constitution Check reports violations that need justification.

无违规 —— Constitution Check 全绿，无需 justification。

<!-- BEGIN auto-generated: performance-budget (from spec.md frontmatter; do not edit) -->

## Performance Budget

| Endpoint | P95 (ms) | P99 (ms) |
| --- | ---: | ---: |
| `GET /api/v1/optionsdesk/radar` | 50 | 100 |
| `GET /api/v1/optionsdesk/anchors` | 40 | 80 |
| `POST /api/v1/optionsdesk/anchors` | 50 | 100 |
| `PATCH /api/v1/optionsdesk/anchors/{id}` | 50 | 100 |
| `DELETE /api/v1/optionsdesk/anchors/{id}` | 40 | 80 |

_Edit `perf_budgets:` in spec.md frontmatter to change. Regenerate this block with `pnpm tsx scripts/checks/plan-compiler.ts <spec-dir>`._

<!-- END auto-generated: performance-budget -->
