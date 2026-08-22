---
feature_id: 065-optionsdesk-radar-market-tabs
spec_ref: ./spec.md
status: approved
created_at: '2026-08-19'
updated_at: '2026-08-21'
adr_refs: ['0024', '0032', '0035', '0040', '0043', '0062', '0066']
context7_verified: []
---

# Implementation Plan: 雷达按市场分页签

## Summary *(mandatory)*

给雷达加「美股 / 港股」两个页签，并给 `optionsdesk.anchor` 加一列显式的市场归属。技术核心是**把市场做成查询的作用域而不是叠加筛选项** —— 它必须同时进分页查询与空态计数（否则顶部横幅与列表互相矛盾且无人察觉），同时**绝不能**进跌破状态机的写路径（否则另一市场的复核红标会静默冻结且不可回补）。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

本片**零新依赖**：页签组件手写（约 25 行，见 D7）、SQL 走既有 `Prisma.sql` 片段范式、无新 vendor 接入。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — 除下方 Complexity Tracking 中列出并论证的一处 Principle I 偏离外，本 plan 遵循全部宪法原则。

逐条对照：

| 原则 | 结论 |
| --- | --- |
| I. SDD 流程 | ⚠️ **1 处偏离** —— UI feature 跳过 Mockup 步，已在 Complexity Tracking 论证 |
| II. Test-First TDD | 遵循。每 task 红→绿→typecheck/lint→`[X]`→stage→commit。本片**尤其**要靠这条，见下方「头号验证事实」 |
| III. Atomic Task 30min-2h | 遵循。D0 的两步 migration 天然是两个 task；§2.2 的既存 bug 修复是独立 commit |
| IV. Module Boundary 扁平+贫血+护城河 | 遵循。改动全部落在 `apps/server/src/optionsdesk/` 内，扁平平铺、无新 class、无 repository；**不新增任何跨 ctx 边**（`TRADING_CALENDAR_PORT` 那条既有边不动） |
| V. 类型同步链 Nx-driven / 单 PR | 遵循。server DTO 改动 → `nx` target 链重 gen `packages/api-client` → mobile 消费，**全部同一个 PR** |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 真 boot smoke 覆盖新的查询形状。落点是既有 `apps/server/test/integration/optionsdesk-045.radar.it.spec.ts`（补市场作用域用例：种 us+hk，验 `market:'hk'` 只回 hk **且空态由 hk-only 计数算出**）+ 新建 `optionsdesk-065.schema.it.spec.ts`（验 NOT NULL / CHECK / backfill 正确性 —— 这三样只有真 PG 能验）。
- [x] **Mobile**: P1 两条 user story 各走一遍真会话。US1 走 Playwright Expo Web（切页签 → 请求带 market → 行确实变了）；US2 因 dev 库 12 只锚全 `us`（2026-08-21 复核仍是 12），**港股页签天然是零锚空态**，可直接手验第 4 空态与常驻说明，无需造数据。
- [x] **Evidence**: 本 gate 在 plan 阶段是**承诺 + 落点**，证据于 impl 阶段回填到对应 task 的 commit。落点文件名已在上面点名，不是「到时候再说」。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片不引入任何第三方 package / SDK / 工具（见 Dependencies 表）。页签组件手写而非引库，理由见 D7。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— 本 feature 是 mono-native**。`optionsdesk` 这个 bounded context 于 045 在 mono 内诞生（ADR-0062），从无 Java/Spring 前身，不存在旧 meta-repo 的 class 名 / Maven 坐标 / 目录布局 / `@RequestMapping` 残留。

**Evidence**: `rg -n 'org\.springframework|org\.mapstruct|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk/` → 零命中（impl 起手复跑一次即可）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

实扫 `docs/adr/*.md` 的 Open Questions 段，本片触及的：

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0066 | 「hk 半日市的日历源：主源腾讯是『指数当日有 bar ⟺ 开市』的反推法，结构上给不出半日标记」 | **accepted-as-is** | 本片让港股锚成为一等公民，从而让这个既有缺口**更容易被看见**（港股页签的新鲜度档在半日市当天可能偏一档），但本片**不改日历源**、也不新增依赖它的判据。港股页签上线即空且恒收盘档 ⇒ 影响面为零。接富途 HK 日历是独立 feature |
| ADR-0035 | 「`db:migrate` wrapper 在 prisma generate 出错时如何 graceful rollback」 | **accepted-as-is** | 本片出两个 migration，但**不引入新形态** —— 走的是 ADR-0035 已定的命名与 hard gate。该 Open Question 是工具链层面的，与本片的 schema 改动正交 |
| ADR-0062 | 无 | — | 该 ADR 的 Open Questions 段原文即「无（M1 范围内决策已定）」 |

**Evidence**: `rg -n -A6 '^#+ *(Open Questions?|开放问题)' docs/adr/0062-*.md docs/adr/0043-*.md docs/adr/0035-*.md docs/adr/0066-*.md`（2026-08-19 实跑；ADR-0043 无该段）。

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

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable。外部 I/O **split-tx**（禁 tx 内持锁等 HTTP）。→ `../../docs/conventions/server-impl-playbook.md`
- **前端（mobile）**：port 走 **Strangler-Fig**（复用 `~/theme` + `~/ui`、Orval 函数式 hook 非 class、axios 不删）；视觉值一律走 NativeWind class，**禁**字面量 / hex；单元素 className 不超 4 个原子。→ `../../docs/conventions/mobile-impl-playbook.md`

---

## 本 feature 的设计决策（D0–D10）

### D0 — `optionsdesk.anchor` 加 `market` 列

**为什么够格当列**：用锚表自己的落库判据（`schema.prisma` 该 model 头注释的 FR-003a）——「③ **参与 SQL 筛选或排序的生效值** → 落**普通列**、应用层写入时求值」。`lLevelEffective` 就是照这条建的（它存在的唯一理由是「雷达筛选主维度，必须能被 WHERE 直接过滤」）。market 从本片起要进 `WHERE` 与 `GROUP BY`，**同一条判据、同一个体例**。

**为什么这次不是「双写必 drift」**：仓内有明确的反向先例 —— `option_contract` 禁止「加是否已到期状态列」，理由是「`expiry_date` 本身就是权威判据，再存一份即双写必 drift」。本片不同之处有三，缺一不可：

1. **`ticker` 建后不可变**（`UpdateAnchorRequest` 无该字段；全仓无第二处写 `ticker`）⇒ 这一对值写一次、此后永不各自演化，drift 没有发生的时间窗。
2. **写入侧单点求值**：由 `parseAnchorTicker` 一处派生。🚨 **MUST NOT 用 DB 生成列** —— 同 `lLevelEffective` 的既有理由，且生成列会把解析表达式塞回 SQL，正是本列要消灭的东西。
3. **DB 层 CHECK 兜底**，值域与 `anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS` 成对（改一处必改另一处，写进列注释）。

**不加索引**：锚表上限约 1000 行，且两市场基数为 2 —— 该文件既有判断是「撒 B-tree 是 cargo cult / 净噪声，提速的正确姿势是表达式索引」。本片不推翻它。

**migration 必须分两次部署**（ADR-0035 + prod 回滚只换镜像 tag、**不回退 DB schema**）：

| 步 | migration 内容 | 应用代码 | 回滚安全性 |
| --- | --- | --- | --- |
| **1（expand + backfill）** | 加可空 `market`；同 migration 内按 ticker 前缀回填 | 写路径开始派生并写入；读路径**仍不依赖它** | 回滚到旧镜像 ⇒ 旧代码不写该列、列可空 ⇒ 照常工作 |
| **2（contract）** | `SET NOT NULL` + `CHECK` | 雷达读路径切到按列过滤 | 只能回滚到步 1 的镜像（它已在写该列）。**MUST NOT 越过步 1 回滚** |

🚨 步 1 的回填按 ticker 前缀切分，是**一次性**的，与「运行时不做字符串解析」不矛盾。前提是取证已确认表内无畸形 ticker（2026-08-21 复测 **prod 库**：16 行全部 well-formed `us:*`，0 畸形；dev 库 12 行同形）。判据用的是 `parseAnchorTicker` + `IMPORTABLE_CODE_PATTERN` + 32 字符上限三样合起来，不是肉眼扫前缀。若将来有畸形行，步 2 的 CHECK 会**在迁移期失败**而不是在运行期静默算错 —— 这正是要的。

### D1 — `market` 是**作用域**不是**筛选项**（本片最容易做错的一处）

`get-radar.usecase.ts` 里已有两类条件，语义不同：

| 类别 | 现有成员 | 进分页查询 | 进空态计数 |
| --- | --- | --- | --- |
| **作用域**（基础集合的定义） | `excluded = false` | ✅ | ✅ |
| **筛选**（在基础集合上再筛） | 生效 L 层 / 待复审 / 跌破 W | ✅ | ❌ |

`market` 属**第一类**。空态计数驱动顶部横幅；只进分页不进计数 ⇒ 美股页签顶着「今日无解」而列表里一只美股都没跌破，**没有任何断言会红**（061 T019 修的就是同一个坑的前一形态，该函数的 doc comment 讲的正是这件事）。

**落地**：新增单点 SQL 片段（仿既有 `radarWSql()` / `radarSpotSql()` 的范式与 🚨 注释体例），两处**都从它取**。让「两处必须一致」成为结构约束而非纪律。

### D2 — 🚨 `market` **绝不能**进跌破状态机的写路径

`advanceBreachState()` 是全仓**唯一**的 `breachStartedOn` 写者，全表扫，只在首页跑一次；锚管理页的复核红标也靠它喂。

一旦被 scope：**用户停在美股页签期间，港股锚的跌破状态机整段冻结**。`breachStartedOn` 的清空是破坏性的、日粒度、**不可回补**。

现状**零机械保护** —— `get-radar.usecase.spec.ts` 整个文件里没有一个非 us ticker（fixture 恒 `us:AOS`，唯一 override 是 `us:PEP`）。有人「为了一致性」把 market 顺手串进去，现有测试照样全绿。

⇒ ① 该方法函数体**零行改动** + 加 🚨 注释说明「为什么整个用例都按市场了，唯独这里不按」（这条违反直觉，不写注释下一个人一定会去『修』它）；② 补一条**否定断言**测试（塞 hk 锚、请求美股作用域，断言 hk 那行**仍被**写）。

**成本要写明**：该方法现在每个页签的首页各跑一次 ⇒ 暴跌日两次全表扫 + 两轮串行条件更新。条件更新本身抗竞态（affected-count 裁决），所以这是**成本不是正确性问题** —— 明确记录，防止有人靠 scope 它来「优化」。

### D3 — SQL 谓词按列相等，DTO 加值域校验

**留档：两个被否掉的做法**（防止有人在 D0 落地前先动手）：

1. `ticker LIKE 'us:%'` —— 它**匹配 `us:`**（空 code），而 `parseAnchorTicker` 判该串非法 ⇒ SQL 与 TS 对同一行的市场归属不一致；且 market 若不做值域校验，`_` / `%` 是 LIKE 元字符。
2. 退一步的按分隔符切分取首段 —— 在 `us:` 上给 `us`、而 `parseAnchorTicker` 给 `null`，两边归属依旧不一致。

⇒ D0 的列把这一整类问题消掉：谓词是**列相等**（走参数绑定），SQL 端不再做任何字符串解析；两端一致性由「写入时单点派生 + CHECK」在**写侧**保证，而不是在每条读查询里重新赌一次。

DTO 侧仍要值域校验（`@IsIn` 取 `IMPORTABLE_MARKETS`）—— 它挡的是**入参**，与列的 CHECK 挡的**存量**是两件事，不可互相替代。

🚨 **多段代码的 canonical 形态是 `us:BRK.B`（点，不是冒号）**，必须进派生逻辑的测试。两件事别混：`parseAnchorTicker` 只按**首个**冒号切、code 段原样保留（故 `us:BRK:B` 在它那里能解析出 `code = 'BRK:B'`），但建锚要复用的 `assertImportableTicker` 会用 `IMPORTABLE_CODE_PATTERN`（`^[A-Z0-9][A-Z0-9.]*$`，**不含冒号**）把它拒掉。仓内证据：`anchor-import.rules.spec.ts` 正面断言 `us:BRK.B` 不抛；research ctx 把 `BRK.B.US` 归一成 `us:BRK.B`。全仓唯一说「code 侧可含冒号」的是 `marketdata/anchor-driven-sync-gate.ts` 自持的宽松解析器 —— 那是另一个 ctx 刻意分开的三行，**不是建锚判据**。

### D4 — 空态计数改为一次查全部市场

比「只查当前市场」严格更优：同一次扫描、同一个片段，换来三样东西 ——

1. 当前页签的作用域计数（D1 要的）；
2. **FR-016 的小圆点**：否则会出现「美股页签说『今日无解，空仓是常态』，而港股有跌破 W 的锚，且零信号」。叠加「全 app 零轮询 + 缓存 30 秒 + 底部 Tab 常驻不 unmount + 默认落美股」，港股那侧一整个 session 可能根本没被取过；
3. **FR-015 的失联检测**：结果里出现一个没有对应页签的市场，就是有锚在雷达上不可达 ⇒ 落一条告警级日志（**不上 UI**，见 spec Clarifications）。

### D5 — 第 4 个空态，外加两件必须同时做的事

新增「该市场还没有锚」。**优先级**：整库为空时仍落既有的「整库还没有锚」（此时「去建锚」才是对的）。

🚨 **移动端必须同时改成强制穷举**，否则建了状态却发错按钮：`radarViewState` 现在是 if 链不是 switch，服务端加第 4 个值后它**照样编译**，且会 fall through 到「筛选无结果」分支 —— 渲染出**正确文案 + 一个什么都不做的「清除筛选」按钮**（当时根本没选筛选）。截图里看着完全合理。改成 `Record<NonNullable<...EmptyState>, RadarViewState>`，正是 `mobile-impl-playbook` 已有的规则（enum→copy 映射用 `Record` 非 `Partial<Record>`），只是这处没用上。

服务端侧有天然强制函数：文案表是 `Readonly<Record<EmptyState, string>>`，加了枚举值不补文案即 tsc 红。

### D6 — 撤销「market 编进游标」，代之以三行的校验

原方案想把 market 编进 keyset 游标并拒绝不匹配。**判定为过度设计**：游标不透明且服务端铸造、客户端从不构造；market 进 query key 后每次切页签都会重置分页参数 ⇒ **跨市场游标这个状态在 app 里不可达**。而该文件其他每条护栏（tiebreaker / NULLS LAST / 禁 OFFSET）防的都是**系统自己会产生**的状态。真正危险的那个变体是「第 2 页悄悄没应用作用域」，那由 D1 挡住，不是靠游标。

代价侧还有：破坏游标编解码、既有 OpenAPI 示例串失效、部署瞬间所有在途游标作废。

**代之以**：DTO 上 `@ValidateIf` —— **带游标时 market 必填**。买到「不声明作用域就不许翻页」，不动 token 格式。

### D7 — 页签组件在 optionsdesk 本地新建

- ❌ **不跨 feature import `~/alert` 的那个 tab 组件**：`apps/mobile/src/optionsdesk/*` 今天只 import `~/core` `~/format` `~/theme` `~/ui`；全仓跨 feature 边只有 `core→ideation` / `core/api→auth` / `wechat→auth`，**全是 infra/shell，从无 sibling 的展示组件**。且它没有 `testID`，而 `react-native-web` 丢弃 `accessibilityState` ⇒ 选中态断言不了、反向断言还是**假绿**；加 `testID` 就得改共享组件、再添第 4 个 consumer。
- ❌ **不在本次上提 `~/ui`**：仓内已登记「统一这几家等分 Tab 是独立重构」。只搬一个不是那次统一（另几家形态不同：带徽标 / 带尾部入口），反而会跟真正的统一撞车。
- ✅ **新建本地组件**（约 25 行，等分 + 底部短横条 + 自带 `testID` + 支持小圆点）。它是第 6 家等分 Tab，往已登记的债上再加一笔 —— **明知故犯**，理由是外科手术式改动优先于顺手重构。

🚨 **标签不要复用 `marketBadgeLabel`**：它签名是 `(code, market='cn')`、**code 优先**，cn 分支从 code 反推（传空 code + `'cn'` 会得到 `深A`）。那是**标的**徽标不是**市场**名，只是恰好在 us/hk 两个市场上对。市场名走 `optionsdesk-copy.ts` 的本地常量，用双字「美股 / 港股」（spec Clarifications Q4）。

### D8 / D9 — 默认页签与筛选的跨页签行为

- 默认「美股」，会话内记忆，**不**自动跟随当前开市市场（会让「我刚才在哪个页签」不可预测，且在开/收盘时刻自己翻页）。
- 筛选**跨页签保留**（是镜头不是每页签独立状态）。若切过去该市场无锚满足，落「筛选无结果」+ 清除入口，语义正确且自解释。今天没有任何东西观察这个行为，**必须用测试钉住**。

### D10 — 顺带交付 061 FR-010 欠的那半条

061 FR-010 要求「该市场不支持实时」**被显式表达**，但全仓 `rg '不支持实时'` **零 UI 文案命中**（2026-08-21 复核：3 处命中全部是代码注释 —— contract-smoke 2 处 + anchors-radar e2e 1 处）—— 061 只在采集层兑现了（fail-closed adapter + 排除出熔断计数），UI 层从未兑现。港股专属页签是这件事第一次成为**常驻**用户可见事实。

⇒ 页签下常驻一行说明。注意这**不违反**「界面不为档位另加视觉标记」那条既有纪律 —— 那条管的是**行级**价格档位，这里说的是**市场级能力**，两个量纲。

### 建锚侧收紧（spec FR-013 / FR-014 / FR-017）

**全仓 `prisma.anchor.create` 只有一处**（`create-anchor.usecase.ts`）。其余 7 处 anchor 写全是 `update`/`updateMany`，且没有一处写 `ticker`。

⇒ 派生逻辑与校验**只需落在那一处 INSERT**，两条服务端建锚入口自动都覆盖到 —— guest 模型导入是**委托**同 ctx 的建锚 use case（059 刻意如此），不是自己 `create`。这不是巧合，是那个决定的红利。

🚨 **正因如此，需要一条回归钉**：`import-anchor-from-model.usecase.spec.ts` 断言 guest 导入建出的锚也带上 market。它防的是有人日后把那个委托改成自己 `create` —— 那一刻覆盖就断了，而**没有别的东西会红**。

**错误码命名**：既有那套常量叫 `INVALID_IMPORT_*`，建锚失败报「IMPORT」读起来是错的。**不改 059 的线上错误码**（其 IT 在断言它）；建锚侧另起 `INVALID_ANCHOR_*`，**共用同一个判据函数**。重复的只是错误字符串（无害），判据仍单点（会漂的是那个）。

**前端那一半必须一起改**（否则收紧写端 = 在 UI 上选得到、一提交就 400）：标的选择器消费的搜索端点无 market 过滤（其文件头注释原文「无 market 过滤 ⇒ us 天然可搜」）。处置：**结果照常展示、非白名单项不可选 + 一句原因**。不选「直接过滤掉」，因为搜「茅台」返回空白会让人以为是搜索坏了。

### 顺手修一个既存 bug：雷达的缓存失效链是断的

- 锚 mutation 失效的是 orval 生成的 query key
- 而 `useRadar` 用的是手拼 key

**两者无共同前缀 ⇒ 任何锚的增删改从未失效过雷达**（锚管理列表的失效是好的，那屏用 orval hook；只有雷达是孤儿）。没有任何测试会红 —— 没有一条 e2e 做「改锚 → 回雷达 → 断言行变了」。

本片要往那个 key 里加 market 维度，等于在一具尸体上叠层 ⇒ **同 PR 顺手修**：导出一个 key 工厂，两处都用它。它轻微违反「每行改动可追溯到当次请求」⇒ **单独一个 commit**、message 里写明理由，别夹进市场页签那几个 commit 里。

---

## 🚨 头号验证事实：读侧改动**服务端全程不会红**

`RadarFilter` / `RadarQuery` / 查询 DTO 加的是**可选**字段、空态枚举加的是**成员** —— 全是增量，`nx test server` 从头绿到尾。**下面每条读侧测试都必须主动写，不能指望现有套件兜底。**

两处例外（真强制函数，会自己红，**善用它们**）：

1. 空态文案表 `Readonly<Record<EmptyState, string>>` —— 加枚举值不补文案即红。
2. **D0 步 2 之后**，Prisma 生成物把 `market` 变成 `create` 的必填字段 ⇒ 每一处 `prisma.anchor.create` 与每个构造 `AnchorRow` 的测试 fixture 都 tsc 红。红的位置就是必须补 market 的位置。
   > ⚠️ 连带：`AnchorRow` 加字段 ⇒ 全仓 grep mock 工厂一起补（手写的不会自动镜像）。

### 会静默失效、必须一并改的既有测试

| 位置 | 问题 |
| --- | --- |
| `get-radar.usecase.spec.ts` 的 Guardrail 12 断言 | 只断言 SQL 含基础条件；把作用域加它旁边，测试照过、**根本没断言作用域存在** |
| `get-radar.usecase.spec.ts` 的 T019 计数断言 | 只断言计数 SQL 含基础条件且不含用户筛选；**没有任何东西钉住「作用域在两处都有」**——正是 D1 的不变式 |
| 三处 hermetic radar mock（`optionsdesk-anchors-radar` / `optionsdesk-detail-thermometer` / `optionsdesk-chain-report` 的 e2e） | 读用户筛选参数但会**无视 market**；fixture 全是 `us:*` ⇒ e2e 全绿而 mock 已不再是契约镜像（违反 `.claude/rules/mobile-e2e-hermetic.md`） |
| `optionsdesk-anchors-radar.spec.ts` 的空态用例 | 硬编码 3 个空态与 3 路优先级阶梯 |
| 两处 contract-smoke | 调雷达不带 market；可选参数 ⇒ 绿但零覆盖 |
| `optionsdesk.controller.spec.ts` | **零条 radar 测试**（只覆盖 anchors/review/PIT/auth）⇒ 新查询参数的 controller 接线目前无测试 |

已核实**不会**误伤：`getByRole('tab')` 全仓 101 处**全部带 name 限定**，「美股 / 港股」不与既有 tab 冲突。

### 契约链

改 server DTO ⇒ 必须走 `docs/conventions/api-contract.md` 的 Nx target 依赖链重 gen `packages/api-client`。手动 regen 走 canonical 的 `node dist/main.js`，**不是** `dump.mjs`（那是漂移路径）。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| **Principle I（NON-NEGOTIABLE）：UI feature 跳过 `clarify → Mockup → plan` 的 Mockup 步** | user 于 2026-08-19 明示豁免，理由是本片页面改动小：无新视觉范式（仓内已有 5 家等分 Tab 先例）、无新 design token、无新交互手势；新增的三样（页签行 / 一行静态说明 / 小圆点）都是既有组件形态的组合 | **走 Mockup 不是「更简单的替代」而是更重的流程**，故本行记录的是**豁免的代价**：Mockup 本可暴露的那个具体风险是**顶部 chrome 从 2 层叠到 5 层**（标题 / 市场页签 / 港股说明 / 新鲜度条 / 筛选 chips），列表可视高度被压缩，且将来 048 的视图 seg 还要再插一层。⇒ 缓解措施：impl 阶段**在真机或窄视口**验一次首屏可视行数（`mobile-impl-playbook` 明写这类容器尺寸约束改动**不能只信 web e2e**，Playwright 视口够高会系统性漏测）。若届时判定拥挤，再回补 Mockup 或调整层级 |

### T17 实测回写（2026-08-22，窄视口取证）

**测法**：Playwright 临时探针（跑完即删，未留在 repo），在**港股页签**取证 —— 那才是 5 层全叠的最坏情况（标题 / 市场页签 / 港股说明 / 新鲜度条 / 筛选 chips）。fixture 8 只港股锚，逐视口量「首屏**完整**可见的行数」（行底不越过视口下沿才计数），并加一轮对比：用 CSS 藏掉 065 新增的两层，测同一视口下的基线。

| 视口 | 065 之前 | 065 之后 | Δ |
| --- | --- | --- | --- |
| 360×780（Mate50 逻辑尺寸档） | 5 | **4** | −1 |
| 375×667（iPhone SE，最紧） | 4 | **3** | −1 |
| 412×915（大屏安卓） | 6 | **5** | −1 |

**层高实测**：市场页签 39px · 港股说明 16px · 新鲜度条 24px；列表起点 y 从 **135 → 190**（+55px），行高 116px。55 / 116 ≈ 0.47 行，但因对齐边界效应，三档视口**一致地掉 1 行**。

**判定：当前可接受，不回补 Mockup。** 理由三条：① 净代价是恒定的 −1 行，不是数量级压缩；② 最紧机型仍剩 3 行，而雷达是「击球区」视图 —— `all_idle`（今日无解）本就是常态，可动锚长期是个位数，3 行足够承载首屏决策；③ 新增的两层里，页签 39px 是本 feature 的功能本体（省不掉），说明只占 16px（省了也只回收 0.14 行，不值得牺牲 061 FR-010 欠的那半条 UI）。

🚨 **红线：再叠一层就必须先做减法。** 048 的视图 seg 若按现在的形态再插一行（约 40px），最紧视口会掉到 **2 行** —— 那时首屏已经放不下一次有意义的比较。届时的候选（**不在本片做**）：把新鲜度条与港股说明合并成一行、或让市场级说明可折叠、或把筛选 chips 收进抽屉。

⚠️ **本次是窄视口取证，不是真机**：Mate50 已 ADB 连线，但机上装的是 **standalone 0.12.0**（`flags` 无 `DEBUGGABLE`），会跑内嵌 JS、无视 Metro ⇒ 看不到本片改动；换 dev-client 需跨 keystore `adb uninstall`，会抹掉机上该 app 的本地数据与登录态，故未擅自执行。窄视口是 T17 verify 明列的等价路径；真机复验（含 status bar / 手势条的额外占用）建议在下次装 dev-client 时顺带做一次。
