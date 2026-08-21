---
feature_id: 065-optionsdesk-radar-market-tabs
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-19'
updated_at: '2026-08-21'
---

# Tasks: 065-optionsdesk-radar-market-tabs（雷达按市场分页签）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0043`](../../docs/adr/0043-server-flat-module-paradigm.md)（扁平 / 贫血 / 护城河）+ [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（optionsdesk → marketdata 端口边，本片复用不新增）+ [`ADR-0035`](../../docs/adr/0035-data-layer-governance.md)（migration 治理 + expand/contract）+ [`ADR-0040`](../../docs/adr/0040-multi-layer-test-gate.md)（EXHAUSTIVE BRANCHING）
**Branch**: `065-optionsdesk-radar-market-tabs`

**一句话**：市场从「ticker 前缀里解析出来的东西」升格为**一等列 + 查询作用域**；作用域必须同时进分页与空态计数，且**绝不能**进跌破状态机的写路径。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。**两个例外**（T05 / T08）是纯回归钉，它们本身没有 impl 面，故各自成条。
- 层级：`[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Manual]`。
- 🚨 **FR / SC 一律逐条枚举，禁写 `FR-004~FR-008` 这类范围记法** —— 本仓自审纪律是逐条 `grep`，范围记法会让中间几条每次都被报成零命中。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 锚表 schema（改：加 `market` 列） | `apps/server/prisma/schema.prisma` |
| migration（**新建** ×2） | `apps/server/prisma/migrations/<yyyymmddhhmm>_add_anchor_market/` · `<yyyymmddhhmm>_tighten_anchor_market/` |
| 全仓唯一 anchor INSERT（改） | `apps/server/src/optionsdesk/create-anchor.usecase.ts` |
| 建锚判据（改：加建锚侧错误码，复用既有判据函数） | `apps/server/src/optionsdesk/anchor-import.rules.ts` |
| ticker 解析（**只读复用，勿改**） | `apps/server/src/optionsdesk/anchor.rules.ts` 的 `parseAnchorTicker` —— 🚨 它**不在** `anchor-import.rules.ts` |
| 雷达读端（改：作用域 + 计数 + 空态） | `apps/server/src/optionsdesk/get-radar.usecase.ts` |
| 查询 DTO / 响应 DTO（改） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` |
| controller（改：透传 market） | `apps/server/src/optionsdesk/optionsdesk.controller.ts` |
| 市场页签组件（**新建**） | `apps/mobile/src/optionsdesk/radar-market-tabs.tsx` |
| 雷达屏（改） | `apps/mobile/src/optionsdesk/radar-screen.tsx` |
| 雷达数据源（改：market 进 params + key 工厂） | `apps/mobile/src/optionsdesk/use-radar.ts` |
| 雷达纯函数（改：空态映射强制穷举） | `apps/mobile/src/optionsdesk/radar.rules.ts` |
| 锚 mutation 失效（改：接 key 工厂） | `apps/mobile/src/optionsdesk/use-anchor-mutations.ts` |
| 标的选择器（改：非白名单不可选） | `apps/mobile/src/optionsdesk/ticker-search-picker.tsx` |
| 文案 | `apps/mobile/src/optionsdesk/optionsdesk-copy.ts` |
| 雷达 IT（改：补市场作用域用例） | `apps/server/test/integration/optionsdesk-045.radar.it.spec.ts` |
| schema IT（**新建**） | `apps/server/test/integration/optionsdesk-065.schema.it.spec.ts` |
| 雷达 / 锚 e2e（改） | `apps/mobile/e2e/optionsdesk-anchors-radar.spec.ts` |
| 契约冒烟（改） | `apps/mobile/e2e/contract-smoke/optionsdesk.contract.ts` |

## 🚨 排序铁律（违反会产生不可部署的中间态）

1. **T01 → T02 → T03 顺序不可换**：加可空列 + 回填（T01）必须先于建锚派生写入（T02），后者必须先于收紧 NOT NULL（T03）。**T03 单独部署一次**（prod 回滚只换镜像 tag、不回退 schema，见 plan §D0）。
2. **任何读路径切到 `market` 列必须晚于 T03**（T04 起）。
3. **T09（契约）必须早于所有 `[Mobile]` 消费 task** —— Nx target 依赖链要求 DTO 与 api-client 同 task 重 gen。

---

## Server

- [X] T01 [Server] **锚表加 `market` 列（expand + 回填）**（`FR-013`, plan §D0 步 1）：`schema.prisma` 的 `Anchor` 加**可空** `market String? @db.VarChar(4)`，注释写明三件事 —— ① 落列判据是该 model 头注释的 FR-003a ③「参与 SQL 筛选/排序 → 落普通列、写入时求值」，同 `lLevelEffective` 体例；② 🚨 **MUST NOT 用 DB 生成列**；③ 值域与 `anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS` **成对**，改一处必改另一处。migration 命名 `<yyyymmddhhmm>_add_anchor_market`，同一个 `migration.sql` 内加列 + 按 ticker 首个冒号前缀回填既有行。🚨 **Guardrail：改完 schema 必须 `prisma generate`，包括改了又撤回的情况**（生成物是 gitignored 的独立真相源，`git checkout` 撤不掉它；漂了的表现是「一堆无关测试同时红且形态是工作集为空」）。→ verify: `pnpm --dir apps/server exec prisma generate` 后 `pnpm nx test server` **全绿且零测试改动**（可空列 = 纯 expand，既有代码一行不受影响，这是「本步可独立部署」的硬证据）；migration 在空库单向可用

- [X] T02 [Server] **建锚派生写入 `market` + 市场/形状收紧**（`FR-013`, `FR-014`, `SC-006`, `state_branches` 7, `state_branches` 8, `state_branches` 9, US3, plan §D0/§建锚侧收紧）：① `create-anchor.usecase.ts` 的**全仓唯一** `prisma.anchor.create` 处，用 `parseAnchorTicker`（住 `anchor.rules.ts`，**不在** `anchor-import.rules.ts`）派生 market 并写入（🚨 单点求值，别在第二处再解析一次）；② 同一入口加市场白名单 + ticker 形状校验，**复用** `anchor-import.rules.ts` 已有的判据函数（`isImportableMarket` + 形状检查），新起建锚侧错误码 `INVALID_ANCHOR_MARKET` / `INVALID_ANCHOR_TICKER`。🚫 **MUST NOT 改 059 的 `INVALID_IMPORT_*`**（`optionsdesk-059.anchor-import.it.spec.ts` 在断言它）—— 重复的只是错误字符串（无害），判据仍单点（会漂的是那个）。🚫 **MUST NOT 碰 `import-anchor-from-model.usecase.ts`** —— 它委托本 use case，自动覆盖，见 T05。→ verify: `create-anchor.usecase.spec.ts` 补 —— `us:AOS` 建出的行 `market === 'us'`；`us:BRK.B` → `market === 'us'` 且 `code === 'BRK.B'`（多段代码的 canonical 是**点**）；🚨 `us:BRK:B` 反而**应被拒**（`IMPORTABLE_CODE_PATTERN` 不含冒号），别照旧稿写成受支持；`cn:600519` → 400 且消息含市场值域；`AOS`（无冒号）与 `us:`（空 code）→ 各 400。`pnpm nx test server` 全绿

- [ ] T03 [Server] **收紧 `market` 为 NOT NULL + CHECK（contract 步，单独部署）**（`FR-013`, plan §D0 步 2）：migration `<yyyymmddhhmm>_tighten_anchor_market`：`SET NOT NULL` + `CHECK (market IN ('us','hk'))`；schema 去掉 `?`。🚨 **本步之后 Prisma 把 `market` 变成 `create` 的必填字段** ⇒ 全仓 `prisma.anchor.create` 调用点与每个构造 `AnchorRow` 的测试 fixture / mock 工厂**都会 tsc 红**。**这是本片唯一会自己喊的强制函数，善用它**：红的位置就是必须补 market 的位置，逐个补齐，**别用 `as any` 绕**。**体量实测（2026-08-21 复核）：1 处生产调用点 + 21 处测试 seed，跨 18 个文件** ⇒ 按 1–2h 估，不是 30min。🚨 **T02 实撞的连带，T03 会再撞一次且更硬**：`marketdata.cold-start-060.market-outcome.it.spec.ts` 与 `optionsdesk-045.sync-gate.it.spec.ts` 各有用例**故意**种 `jp:7203` / `cn:600519` / 无冒号 `PEP` 的锚，用来驱动 marketdata 的 fail-closed 早退（`ticker_unresolved` / `session_unregistered` / `market_not_enabled`）。T02 已把它们从走建锚 use case 改成直接 `prisma.anchor.create` 绕闸（写侧拒得对，绕闸是刻意的），但 T03 的 `CHECK (market IN ('us','hk'))` + NOT NULL 会让这些行**在 DB 层根本存不下**。⇒ **动 T03 前先定夺，别默认挑一个**：(a) 这些跨 ctx 用例改为不依赖 anchor 行 —— cold-start 的 ticker 本就是 `run()` 入参、不取自锚行，锚只当 FK；(b) 放宽 CHECK；(c) 其他。🚫 **(b) 会拆掉 FR-013 / SC-003 唯一的结构性保证，默认不选**。🚫 **仍 MUST NOT 拆成两个 task** —— NOT NULL migration 与 fixture 修复分开落地会留下「测试全红」的中间态。🚨 连带 `rg` 一遍全仓手写 mock 工厂（它们不会自动镜像新字段）。🚫 **MUST NOT 与 T01 合并成一个 migration** —— prod 回滚只换镜像 tag、不回退 schema，合并后回滚到旧镜像会因旧代码不写该列而 INSERT 失败（脏回滚）。→ verify: 新建 `apps/server/test/integration/optionsdesk-065.schema.it.spec.ts`（Testcontainers PG，体例照 `optionsdesk-045/046/047/061.schema.it.spec.ts`）断言 —— ① `market` 为 NOT NULL；② 直插 `cn` 违反 CHECK；③ T01 回填后每行 `market` 与 `parseAnchorTicker(ticker).market` 逐行相等（**只有真 PG 能验这三样**）。`pnpm nx test server` + `pnpm nx lint server` 全绿（编译器已把所有调用点逼出来）

- [ ] T04 [Server] **市场作用域单点片段 + 分页与计数双落点**（`FR-002`, `FR-003`, `FR-004`, `SC-003`, `state_branches` 1, US1, plan §D1/§D3/§D4）：`get-radar.usecase.ts` 新增单点 SQL 片段 `radarScopeSql(market)`（仿既有 `radarWSql()` / `radarSpotSql()` 的范式与 🚨 注释体例，说明「两处必须一致，加第三处用法继续从这里取，别复制」），谓词是**列相等**并走参数绑定；`selectPageKeys` 与 `countBaseSet` **都从它取**；`countBaseSet` 改为 `GROUP BY market` 一次查回全部市场的两个计数。`RadarFilter` / `RadarQuery` 加 `market`。🚨 **作用域 ≠ 筛选项**：`market` 与 `excluded = false` 同级（进计数），与 `lLevels` / `pendingReview` / `belowW` **不同级**（不进计数）；只进分页不进计数 ⇒ 美股页签顶着「今日无解」而列表里一只美股都没跌破，**没有任何断言会红**（061 T019 修的就是同一个坑的前一形态）。→ verify: `get-radar.usecase.spec.ts` 补 —— 作用域**同时**出现在分页 SQL 与计数 SQL（两处各断言一次，这条正是 D1 的不变式，现状零覆盖）；market 走参数绑定（`values` 含市场值、`sql` 文本不含）；`GROUP BY` 回来的多市场计数被正确取用。`optionsdesk-045.radar.it.spec.ts` 补：种 us + hk 两只锚，请求 hk 作用域 → **只回 hk**，且**美股全部跌破 W 时 MUST NOT 压掉港股的「全体不动区」判定**（这条抓的就是计数没进作用域）

- [ ] T05 [Server] **🚨 跌破状态机的否定断言（D2 唯一的机械保护）**（`FR-011`, `SC-005`, plan §D2）：`advanceBreachState()` **函数体零行改动**，只加一段 🚨 注释说明「为什么整个用例都按市场了，唯独这里不按」—— 它是全仓**唯一**的 `breachStartedOn` 写者、全表扫、只在首页跑；一旦被 scope，用户停在美股页签期间港股锚的跌破状态机整段冻结，而 `breachStartedOn` 的清空是**破坏性、日粒度、不可回补**的。注释里一并记下成本：该方法现在每个页签的首页各跑一次 ⇒ 暴跌日两次全表扫 + 两轮串行条件更新，**这是成本不是正确性问题**（条件更新本身抗竞态），**MUST NOT 靠 scope 它来「优化」**。→ verify: `get-radar.usecase.spec.ts` 加**否定断言** —— 塞一只 `hk:00700` 且其收盘价已跌破 W，请求 **us** 作用域，断言 hk 那行**仍被** `updateMany` 写到。🚨 现状零覆盖：该 spec 文件里**没有一个非 us ticker**（fixture 恒 `us:AOS`，唯一 override 是 `us:PEP`），有人「为了一致性」把 market 串进去现有测试照样全绿 —— 本 task 就是那颗缺失的钉

- [ ] T06 [Server] **第 4 空态 + 优先级 + 文案互异**（`FR-008`, `FR-009`, `FR-010`, `state_branches` 4, `state_branches` 5, US2, plan §D5）：`RADAR_EMPTY_STATES` 加 `zero_anchors_in_market`，`RADAR_EMPTY_STATE_MESSAGES` 补文案（有效动作是**切市场**，不是去建锚）；判定顺序：**整库为空优先落既有 `zero_anchors`**（此时「去建锚」才是对的），其次才是市场空。🚨 服务端这里有天然强制函数：文案表是 `Readonly<Record<RadarEmptyState, string>>`，加了枚举值不补文案即 tsc 红。→ verify: `get-radar.usecase.spec.ts` 把既有的文案唯一性断言从 3 态扩到 **4 态两两互异**；加**优先级用例**（整库空 ∧ 当前市场空 → `zero_anchors` 而非 `zero_anchors_in_market`）。`optionsdesk-045.radar.it.spec.ts` 补 `state_branches` 4（港股无锚但库中另有美股锚 → `zero_anchors_in_market`）与 5（整库无锚 → `zero_anchors`）

- [ ] T07 [Server] **失联市场的告警级留痕**（`FR-015`, `state_branches` 10, plan §D4）：T04 的 `GROUP BY market` 结果里若出现**没有对应页签的市场**，落一条 WARN 日志（含市场值与条数）。🚫 **MUST NOT 上 UI**（spec Clarifications Q1：此类锚并未从系统失联 —— 锚管理页不分市场、仍完整列出它；雷达是「击球区」视图，不为不受支持市场的锚开后门）。本条守的是「将来新增受支持市场时忘了同步加页签」。→ verify: `get-radar.usecase.spec.ts` 用 logger spy 断言 —— 计数结果含未知市场 → WARN 一次且消息含该市场值；只含 us/hk → **零 WARN**（防每次请求都刷日志）

- [X] T08 [Server] **🚨 委托链回归钉（防 059 的委托被改成自己 create）**（`FR-013`, plan §建锚侧收紧）：钉子落 `optionsdesk-059.anchor-import.it.spec.ts`（**与本条原稿点名的文件不同**：`import-anchor-from-model.usecase.spec.ts` 把 `CreateAnchorUseCase` 整个 stub 掉了，观测不到真派生、钉不住这条边；IT 走真 HTTP + 真 PG 才钉得住）加一条断言 —— guest 模型导入**新建**的锚也带上正确的 `market`。**本 task 零 impl 面**：guest 导入今天是委托 `CreateAnchorUseCase.execute()`（059 刻意如此），T02 落地后自动覆盖。这条钉防的是有人日后把委托改成自己 `prisma.anchor.create` —— 那一刻覆盖就断了，而**没有别的东西会红**。→ verify: 该 spec 新增用例绿；断言里显式走导入口而非直调建锚 use case（否则钉不到委托这条边）

## API Client

- [ ] T09 [Contract] **查询 DTO 加 market + 响应带多市场计数 + api-client 重 gen**（`FR-001`, `FR-002`, `FR-016`, plan §D3/§D4/§D6）：① `optionsdesk.dto.ts` 的 `RadarQueryDto` 加 `market`，配 `@IsIn([...IMPORTABLE_MARKETS])`（挡**入参**，与 T03 的 CHECK 挡**存量**是两件事，不可互相替代）+ `@ValidateIf`：**带 `cursor` 时 `market` 必填**（D6 的便宜替代 —— 买到「不声明作用域就不许翻页」，不动游标 token 格式）；② 响应带回全市场计数供 FR-016 的小圆点；③ `optionsdesk.controller.ts` radar handler 透传；④ 同 task 内跑 Nx target 依赖链重 gen `packages/api-client`。🚫 **MUST NOT 把 market 编进游标** —— 已判过度设计（游标不透明且服务端铸造、客户端从不构造；market 进 query key 后每次切页签都重置分页参数 ⇒ 跨市场游标在 app 里不可达），代价还有破坏编解码 + 既有 OpenAPI 示例串失效 + 部署瞬间在途游标全废。→ verify: `optionsdesk.controller.spec.ts` **新增 radar 用例**（该文件现状**零条 radar 测试**）：`?market=us` 抵达 use case；`?market=jp` → **400**（harness 已跑真 `ValidationPipe`，这条是逼出 `@IsIn` 的那条）；带 `cursor` 不带 `market` → 400。手动 regen 走 canonical 的 `node dist/main.js`，**不是** `dump.mjs`（漂移路径）；`nx affected` 全量门绿

## Mobile

- [ ] T10 [P] [Mobile] **市场页签组件（新建）+ 文案**（`FR-001`, `FR-016`, US1, plan §D7）：新建 `radar-market-tabs.tsx`（约 25 行，等分 + 底部短横条 + **自带 `testID`** + 支持小圆点）。文案落 `optionsdesk-copy.ts` 本地常量，用**双字**「美股 / 港股」。🚫 **MUST NOT import `~/alert/alert-tab-row`** —— `apps/mobile/src/optionsdesk/*` 今天只 import `~/core` `~/format` `~/theme` `~/ui`，全仓跨 feature 边只有 infra/shell 三条，**从无 sibling 的展示组件**；且它没有 `testID`，而 `react-native-web` 丢弃 `accessibilityState` ⇒ 选中态断言不了、反向断言还是**假绿**。🚫 **MUST NOT 本次上提 `~/ui`** —— 仓内已登记「统一这几家等分 Tab 是独立重构」。🚫 **MUST NOT 用 `marketBadgeLabel` 当标签** —— 它签名 `(code, market='cn')` 是 **code 优先**的**标的**徽标（传空 code + `'cn'` 得 `深A`），不是市场名。→ verify: 视觉值全走 NativeWind class（禁字面量 / hex）、单元素 className ≤ 4 原子；选中态**双重编码**（底部横条 + 字重），不依赖 `accessibilityState`

- [ ] T11 [Mobile] **雷达接市场作用域 + 导出 query key 工厂**（`FR-002`, `FR-005`, `FR-006`, `FR-007`, US1, plan §D8/§D9）：`use-radar.ts` —— market 进请求参数**且进 query key**（切页签自然重置 `pageParam`，这正是 D6 判定「跨市场游标不可达」的依据）；导出 `radarQueryKey(market, filters)` 工厂供 T12 复用；默认落 `us`、**会话内**记忆、🚫 **MUST NOT 依据当前哪个市场开市自动切换**（会让「我刚才在哪个页签」不可预测，且在开/收盘时刻自己翻页）；筛选 state **跨页签保留**（是镜头不是每页签独立状态）。`radar-screen.tsx` 在题头下插页签行。→ verify: `radar.rules.spec.ts` 覆盖 key 工厂的稳定性（同参数同 key、市场不同则 key 不同）；`SC-002` 的落点 —— 断言新鲜度聚合函数在**只含 hk 行**的输入上给出交易日粒度而非时刻粒度（今天混排时一只美股实时行就能把整条 bar 拉成实时，这条正是它被修掉的证据）

- [ ] T12 [Mobile] **🚨 修雷达缓存失效链断裂（既存 bug，独立 commit）**（plan §顺手修一个既存 bug）：`use-anchor-mutations.ts` 的失效改用 T11 导出的 `radarQueryKey` 工厂。**病根**：mutation 失效的是 orval 生成的 query key，而 `useRadar` 用手拼 key，**两者无共同前缀 ⇒ 任何锚的增删改从未失效过雷达**（锚管理列表的失效是好的，那屏用 orval hook；只有雷达是孤儿）。🚨 **本 task 单独一个 commit**，message 写明「这是先于本 feature 存在的缺陷，因本片正在改同一个 key 而顺手修」——它轻微违反「每行改动可追溯到当次请求」，别夹进市场页签那几个 commit 里。→ verify: **本 task 自带红绿闭环**（Constitution §II，不外包给 T15）—— 在 `optionsdesk-anchors-radar.spec.ts` 加一条 e2e：建锚 → 返回雷达 → 断言新行可见。**先写它、先看它红**（今天的失效链是断的，它必然红），再改 key 工厂让它绿。另加一条纯逻辑断言：mutation 侧失效用的 key 与 `useRadar` 的 key **共享前缀**（这是病根的直接判据，比 e2e 更早红）

- [ ] T13 [Mobile] **空态映射强制穷举 + 第 4 空态渲染**（`FR-008`, `FR-010`, `SC-004`, US2, plan §D5）：`radar.rules.ts` 的 `radarViewState` 从 if 链改成 `Record<NonNullable<RadarResponseEmptyState>, RadarViewState>` 全映射；`radar-screen.tsx` 为第 4 态渲染**切市场**引导而非建锚 CTA。🚨 **不改会静默出错且看着合理**：if 链在服务端加第 4 个枚举值后**照样编译**，且会 fall through 到「筛选无结果」分支 —— 渲染出**正确文案 + 一个什么都不做的「清除筛选」按钮**（当时根本没选筛选）。这正是 `mobile-impl-playbook` 已有的规则（enum→copy 映射用 `Record` 非 `Partial<Record>`），只是这处没用上。→ verify: `radar.rules.spec.ts` 断言第 4 态映射到**自己的** view state 而**非** `filtered_empty`；把 `Record` 的键故意删一个应 tsc 红（穷举强制生效的证据）

- [ ] T14 [P] [Mobile] **港股能力说明常驻 + 跨页签小圆点 + 选择器收紧**（`FR-012`, `FR-016`, `FR-017`, `SC-006`, `state_branches` 6, `state_branches` 7, `state_branches` 8, US2, US3, plan §D10/§D4/§建锚侧收紧）：① `radar-screen.tsx` 在页签下渲染**常驻一行**「该市场暂不提供盘中实时价」，🚫 **MUST NOT 只在空态下呈现**（港股一旦有了锚说明就消失，而恰恰是有行之后用户才会去读行情时点、才真会把交易日粒度误读成「今天还没开盘」）；这兑现 061 FR-010 欠的 UI 那半条（全仓 `rg '不支持实时'` **零 UI 文案命中**；3 处命中全是代码注释）。注意它**不违反**「界面不为档位另加视觉标记」—— 那条管**行级**价格档位，这里是**市场级能力**，两个量纲。② 非当前页签按 T09 的多市场计数渲染小圆点，🚫 **不带数量**（市场页签上的数字会被读成「该市场有 N 只锚」而非「N 只可动」）。③ `ticker-search-picker.tsx` 非 `IMPORTABLE_MARKETS` 的结果**可见但不可选 + 一句原因**，🚫 **MUST NOT 静默过滤掉**（搜「茅台」返回空白会让人以为搜索坏了）。→ verify: **本 task 自带红绿闭环**（Constitution §II，不外包给 T15），在 `optionsdesk-anchors-radar.spec.ts` 加三组：① **说明常驻** —— 港股页签**有锚时**说明仍在（US2-AS1；只验空态会漏掉「有了锚说明就消失」这个正是要防的形态）；② 非当前页签有可动锚 → 小圆点出现**且不含任何数字**，无可动锚 → 不出现；③ 选择器**双向** —— A 股项可见但不可选且给出原因（US3-AS1），**且 us / hk 项仍可选并能一路建成锚**（US3-AS2）。🚨 第 ③ 组的**正向那半条不可省**：白名单收紧最常见的回归是 over-blocking，一旦误伤会让建锚整条路径不可用，而只测「A 股被挡住」照样全绿

## E2E

- [ ] T15 [Mobile-E2E] **三处 hermetic mock 补 market + 分页 / 空态 / 页签用例**（`FR-001`, `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-010`, `SC-001`, `SC-004`, `state_branches` 2, `state_branches` 3, `state_branches` 4, `state_branches` 5, `state_branches` 6, US1, US2）：① **三处** radar hermetic mock（`optionsdesk-anchors-radar.spec.ts` / `optionsdesk-detail-thermometer.spec.ts` / `optionsdesk-chain-report.spec.ts`）补 market 谓词 —— 🚨 不改它们会 **e2e 全绿而 mock 已不再是契约镜像**（fixture 全是 `us:*`，违反 `.claude/rules/mobile-e2e-hermetic.md`「mock 是契约镜像」）；② `optionsdesk-anchors-radar.spec.ts` 把硬编码的 3 空态与 3 路优先级阶梯扩到 4；③ 新增用例，分四组：

  **(a) 切换与默认**（US1-AS1, US1-AS5, US1-AS6）：点港股 → 请求带 `market=hk` **且行确实变了**（🚫 **不要**断言 `aria-selected`，`react-native-web` 不渲染它）；港股 → 详情 → 返回仍在港股；冷启动落美股。

  **(b) 🚨 分页连续性 —— 本组不可省**（US1-AS2, US1-AS4, Edge Case 3, `FR-004`, `FR-005`）：① 在美股翻到第 2 页后继续下拉，断言**后续页的行全部仍属美股**；② 翻页途中改动行情使排序键变化，断言**不漏行、不重复行**；③ **翻到第 2 页后切到港股，断言回到第一屏**、不接续上一个市场的翻页位置。🚨 **这三条是 plan §D6 撤销「market 进游标」的代价对冲** —— 撤销的唯一依据是「第 2 页悄悄没应用作用域由 D1 挡住」，那就必须有真的翻页断言来证明 D1 确实挡住了，否则等于拆了栏杆又不验地板。

  **(c) 空态入口双向**（US2-AS3, US2-AS4, `SC-004`）：港股零锚（库中另有美股锚）→ 市场文案渲染**且**建锚 CTA 与「清除筛选」按钮**计数均为 0**（抓 T13 的 fall-through）；**整库零锚 → 建锚 CTA 必须出现**。🚨 **两个方向都要断**：`SC-004`「行动入口 100% 可执行」既禁止出现无从执行的入口，也要求该出现的入口确实在；只断前者会让「什么入口都不给」照样绿。

  **(d) 行级粒度与筛选**（US2-AS2, US1-AS3, `SC-001`）：港股 fixture 需显式带收盘档行，断言**行内行情时点是交易日而非时刻**（T11 只覆盖了顶部新鲜度聚合，覆盖不到行内）；筛选跨页签保留。→ verify: `nx run mobile:e2e` 全绿；🚨 改了共享 hook ⇒ 跑**全套** `runtime-smoke` 而非单 spec（blast radius = 整套 e2e）

- [ ] T16 [Contract-Smoke] **契约冒烟带上 market**（`FR-002`, `SC-003`）：`apps/mobile/e2e/contract-smoke/optionsdesk.contract.ts` 与 `optionsdesk-realtime-spot.contract.ts` 调雷达时带 `market`。🚨 现状是**可选参数 ⇒ 绿但零覆盖**，不改的话生成的 client 与真 server 在这个新参数上的对齐从未被验证过。→ verify: `nx run mobile:contract-smoke` 绿；断言**并集性质**（分别取 us 与 hk 两个作用域，两次结果的并集 = 不带作用域时的全集，交集为空）—— 这是 `SC-003` 唯一的端到端落点

## Polish

- [ ] T17 [Manual] **真机 / 窄视口验首屏可视行数**（plan §Complexity Tracking）：本片跳过了 Mockup（Constitution Principle I 的一处已论证偏离），其代价是**顶部 chrome 从 2 层叠到 5 层**（标题 / 市场页签 / 港股说明 / 新鲜度条 / 筛选 chips），列表可视高度被压缩，且 048 的视图 seg 将来还要再插一层。🚨 **web e2e 会系统性漏测这类问题** —— Playwright 视口够高，CI 全绿而真机崩（`mobile-impl-playbook` 明写容器尺寸约束改动须真机或窄视口验）。→ verify: 真机（走 `run-local-env`）或窄视口下截图，记录首屏可动锚的可见行数；若判定拥挤，**回头补 Mockup 或调整层级**，并把结论回写 plan 的 Complexity Tracking

---

## 覆盖自查（analyze 阶段请逐条 `grep` 复核，别信本表的历史数字）

| 维度 | 覆盖情况 |
| --- | --- |
| FR-001 … FR-017 | 全部 17 条各有落点（`FR-003` 在 T04；`FR-011` 在 T05；`FR-015` 在 T07） |
| SC-001 | T15（同页签内行情时点粒度同质） |
| SC-002 | T11（新鲜度聚合在 hk-only 输入上的粒度断言） |
| SC-003 | T04（IT 层）+ T16（端到端并集/交集性质） |
| SC-004 | T13 + T15（空态入口 100% 可执行） |
| SC-005 | **故意不做 30 天用例** —— 它的落点是 T05 的否定断言（作用域 MUST NOT 泄漏进红标判定路径）。analyze 若扫到「SC-005 无对应 task」，那是**预期的**，别补一个 30 天的测试任务 |
| SC-006 | T02（服务端零成功率）+ T14（提交前即可知不可选，**双向**：A 股不可选 ∧ us/hk 仍可选可建成） |
| SC-007 | **故意不量化** —— 本片不引入新数据规模或查询形状，性能预算沿用既有假设，未列 `perf_budgets` |
| `state_branches` 1–10 | 1 → T04；2, 3 → T15；4, 5 → T06 + T15；6 → T14 + T15；7, 8 → T02 + T14；9 → T02；10 → T07 |
| **Acceptance Scenario 13 条** | US1: AS1→T04+T15 · AS2→T11+T15(b) · AS3→T15(d) · AS4→**T15(b)** · AS5→T15(a) · AS6→T15(a)；US2: AS1→**T14**① · AS2→T11+**T15(d)** · AS3→T15(c) · AS4→**T15(c)**；US3: AS1→T14③ · AS2→**T14③正向** · AS3→T02 |

> 📌 **2026-08-19 `/speckit-analyze` 回填**：AS 层单独产出 5 条发现（标准三矩阵扫不到这层，046 实证）。已修：分页连续性无断言（T15-b）、选择器正向回归缺失（T14③）、空态入口只断单向（T15-c）、行级时点粒度无断言（T15-d）、T12/T14 的 verify 曾外包给 T15 违反 Constitution §II（已各自收回红绿闭环）。另修 spec FR-016 的「该市场页签」指代歧义、T03 体量未量化。
