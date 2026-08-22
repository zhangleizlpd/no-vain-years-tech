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

- [X] T03 [Server] **收紧 `market` 为 NOT NULL + CHECK（contract 步 —— 独立 PR + 单独部署）**（`FR-013`, plan §D0 步 2）：✅ **本条在独立 PR 落地**（分支 `feat/065-anchor-market-contract`）—— 与 065 主 PR 分开，理由见下方「为什么必须分开」。内容：migration `<yyyymmddhhmm>_tighten_anchor_market`（`SET NOT NULL` + `CHECK (market IN ('us','hk'))`，约束名 `ck_anchor_market`）；`schema.prisma` 去掉 `?`；`optionsdesk-065.schema.it.spec.ts` 把三条断言加回来（① NOT NULL 且无默认值；② 直插 `cn` 撞 CHECK；③ **CHECK 值域恰好 = `IMPORTABLE_MARKETS`** —— 逐个市场试插，把「值域成对」变成机器强制），并把 expand 版里那条「不写 market 也 INSERT 得进去」**反转成 NOT NULL**（回滚窗口在此关闭，那条本就该在这一刻红）。🚨 **为什么必须与 expand 分开 PR、分开部署**：prod 回滚只换镜像 tag、**不回退 schema**（`ops/runbook/prod-deploy-rollback.md` §回滚：「image-only 回滚的硬前提 = 向后兼容的 expand-migrate-contract migration；破坏性 forward migration 回滚后旧代码会撞上更新的 schema — 那种发布不能靠本脚本回滚」）。而 migration 在**容器启动时**由 entrypoint 的 `prisma migrate deploy` 应用 ⇒ 同一个 PR 里的两个 migration 会在**同一次部署**里全应用，「单独部署」根本不会发生。⇒ 正确序列：① 合 expand PR → release → deploy → 观察稳定（此间可安全回滚）；② 再合本 contract PR → release → deploy（此后回滚只能回到 ①的镜像，更早的会因不写该列而 INSERT 失败）。🚨 **T02 的跨 ctx 连带已在 expand PR 里解决**（走方案 (a)）：`marketdata.cold-start-060.market-outcome.it.spec.ts` 4 例改用 `orphanAnchorId()` 不再建锚行、`optionsdesk-045.sync-gate.it.spec.ts` 反例从 cn 直插换成 hk 走真 use case —— 这两项**不依赖 CHECK**、独立成立，故留在 expand PR，本 task 落地时无需再动。🚨 **体量实测**：生产调用点 0 处需改（T02 已在写 market）+ 24 处测试 seed 跨 18 文件 —— **均已在 expand PR 里补齐**（可空列写值合法），故本 task 落地时**编译器不会再逼出任何东西**，别以为没红就是漏了。🚨 **Prisma 不建模 CHECK** ⇒ 此后任何 `migrate dev --create-only` 的 diff 都会把 `ck_anchor_market` 误报成待 `DROP CONSTRAINT`，照 diff 粘贴就会静默拆掉它。→ verify: **已绿**。migration `20260822_0918_tighten_anchor_market`；schema IT 4 条在真 PG 上过（NOT NULL 且无默认值 / 直插 `cn` 撞 CHECK / **CHECK 值域恰好 = `IMPORTABLE_MARKETS`** / T01 回填谓词逐字镜像 `parseAnchorTicker`）；expand 版那条「不写 market 也 INSERT 得进去」如期**反转成 NOT NULL**（回滚窗口在此关闭）。`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main` EXIT=0

- [X] T04 [Server] **市场作用域单点片段 + 分页与计数双落点**（`FR-002`, `FR-003`, `FR-004`, `SC-003`, `state_branches` 1, US1, plan §D1/§D3/§D4）：`get-radar.usecase.ts` 新增单点 SQL 片段 `radarScopeSql(market)`（仿既有 `radarWSql()` / `radarSpotSql()` 的范式与 🚨 注释体例），谓词是**列相等**并走参数绑定；`countBaseSet` 改为 `GROUP BY market` 一次查回全部市场的两个计数（新类型 `RadarCountsByMarket`），新增私有 `scopedCounts()` 把它收敛到当前作用域。🚨 **落地形态与本条原稿的「两处**都从它取**」不同 —— 是「同源不同形」，别照原稿去改**：plan §D4 明确要求计数**一次查全部市场**（FR-016 小圆点与 FR-015 失联告警要的恰恰是**别的**市场那几格），这与 `WHERE market = ?` 互斥 ⇒ 分页用**列相等谓词**（`radarScopeSql`），计数用 **`GROUP BY` 同一列**再按同一个 market 值取那一格。不变式的实体是**两边落在同一列上**，不是「同一个函数被调用两次」。已配一条**反向断言**：计数 SQL MUST NOT 含 `market = `。🚨 **`market` 落 `RadarQuery` 顶层，MUST NOT 放进 `RadarFilter`**（本条原稿写的是「`RadarFilter` / `RadarQuery` 加 `market`」）——放 filter 里会诱导下一个人顺着既有模式只把它接进 `selectPageKeys`，而那正是 §D1 点名要防的错；放顶层让「作用域 ≠ 筛选项」成为类型层面的事实。🚨 **省略 `market` = 不声明作用域 = 全集**（不是默认 us）—— T16 要断言「两个作用域的并集 = 不带作用域时的全集」，默认 us 会让那条断言无从做起；`scopedCounts` 在省略时把所有市场加总，语义与本片之前逐字一致（这也是既有测试零改动的原因）。🚨 **作用域 ≠ 筛选项**：`market` 与 `excluded = false` 同级（进计数、在筛选**之前**入 conditions），与 `lLevels` / `pendingReview` / `belowW` **不同级**（不进计数）；只进分页不进计数 ⇒ 美股页签顶着「今日无解」而列表里一只美股都没跌破，**没有任何断言会红**（061 T019 修的就是同一个坑的前一形态）。→ verify: **已绿**。`get-radar.usecase.spec.ts` +6 条 —— 作用域**同时**出现在分页 SQL（`market = `）与计数 SQL（`GROUP BY market`）且计数**不含** `market = `；market 走参数绑定（`values` 含市场值、`sql` 文本不含）；美股全部跌破 MUST NOT 压掉港股的 `all_idle` + **反向**（同批数据切 us → 非 `all_idle`，证明不是恒 `all_idle`）；省略 market = 全集；作用域指向零锚市场 → 计数落零。fixture 侧两处同步：`anchorRow` 的 `market` **跟随 ticker 派生**（写死 `'us'` 会让作用域断言假绿），计数 fixture 改按市场分组回多行。`optionsdesk-045.radar.it.spec.ts` +2 条（`seedInstrument` / `AnchorFixture` 加 `market`，缺省 us）：hk 作用域只回 hk + **SC-003 并集=全集、交集为空**；美股两只全跌破而港股仍判 `all_idle` + 反向。🚨 **Mutation 自检实测**（不是推理）：注入「作用域不进计数」→ 红 2 条；注入「作用域不进分页」→ 红 2 条。两个方向都确认管道抓得到。`pnpm nx test server` + `lint` + `typecheck` 全 EXIT=0（462 files / 5075 tests，较 T03 +8）

- [X] T05 [Server] **🚨 跌破状态机的否定断言（D2 唯一的机械保护）**（`FR-011`, `SC-005`, plan §D2）：`advanceBreachState()` **函数体零行改动**（已核：`findMany` 仍无 `where`，全表扫），只加一段 🚨 注释说明「为什么整个用例都按市场了，唯独这里不按」——它是全仓**唯一**的 `breachStartedOn` 写者、全表扫、只在首页跑，且锚管理页的复核红标也靠它喂（那一页**不分市场**）；一旦被 scope，用户停在美股页签期间港股锚的跌破状态机整段冻结，而 `breachStartedOn` 的清空是**破坏性、日粒度、不可回补**的。注释里一并记下成本：该方法现在每个页签的首页各跑一次 ⇒ 暴跌日两次全表扫 + 两轮串行条件更新，**这是成本不是正确性问题**（条件更新本身抗竞态），**MUST NOT 靠 scope 它来「优化」**。→ verify: **已绿**。`get-radar.usecase.spec.ts` 加否定断言 —— 塞一只 `hk:00700` 且已跌破 W，请求 **us** 作用域，断言 hk 那行**仍被** `updateMany` 写到（`call.where.id === 8n`）。🚨 **实施时发现原钉子会是假的、已一并修掉**：`buildPrismaMock` 的 `findMany` 原本**无视 `where`**，所以就算有人给状态机扫描加了 `where: { market }`，断言照样全绿 ⇒ 已改成认 `where.market`（无 `where` = 状态机全表扫含 excluded；带 `where.id` = hydrate 只回非 excluded）。**Mutation 实测**：给 `advanceBreachState` 注入 `where: { market: 'us' }` → 红 2 条（本否定断言 + 「excluded 锚状态机照常维护」）

- [X] T06 [Server] **第 4 空态 + 优先级 + 文案互异**（`FR-008`, `FR-009`, `FR-010`, `state_branches` 4, `state_branches` 5, US2, plan §D5）：`RADAR_EMPTY_STATES` 加 `zero_anchors_in_market`，`RADAR_EMPTY_STATE_MESSAGES` 补文案「这个市场还没有锚 —— 换个市场看看」（有效动作是**切市场**，不是去建锚）；判定顺序：**整库为空优先落既有 `zero_anchors`**（此时「去建锚」才是对的），其次才是市场空。🚨 **判据需要第二维**：`RadarEmptyStateInput` 加 `globalBaseTotal`（全部市场的基础集合锚数，由 T04 的 `countsByMarket` 经新私有 `totalOf()` 求得）——「整库空」与「本市场空」在整库为空时**同时**成立，只靠 `baseTotal` 一个数分不开，而两者的有效动作**相反**。不声明作用域时 `globalBaseTotal === baseTotal` ⇒ 判定退化成 065 之前的三态，语义逐字不变。🚨 服务端这里有天然强制函数：文案表是 `Readonly<Record<RadarEmptyState, string>>`，加了枚举值不补文案即 tsc 红（实测：加 `globalBaseTotal` 后编译器逼出 5 处旧输入）。→ verify: **已绿**。`get-radar.usecase.spec.ts` 文案唯一性从 3 态扩到 **4 态两两互异**（并断言 `texts.length === RADAR_EMPTY_STATES.length`，加枚举不补文案即红），另断言第 4 态文案含「市场」且**不含「建」**、第 1 态含「建」（防有人复制第一条过来）；加**优先级用例**（整库空 ∧ 当前市场空 → `zero_anchors` 而非 `zero_anchors_in_market`）+ 端到端两条（库里有 us 锚而查 hk → 第 4 态；整库空而查 hk → 第 1 态）。`optionsdesk-045.radar.it.spec.ts` 补 `state_branches` 4（港股无锚但库中另有美股锚 → `zero_anchors_in_market`，且断言文案**不等于** `zero_anchors`）与 5（整库无锚 → `zero_anchors`）。⚠️ **本步让 `openapi.json` 漂了**（`optionsdesk.dto.ts:768` 直接用 `RADAR_EMPTY_STATES` 做 `@ApiProperty({ enum })`）—— **刻意留给 T09 一次性 regen**，因为 T09 还要加 `market` 查询参数与多市场计数，先 regen 一次纯浪费

- [X] T07 [Server] **失联市场的告警级留痕**（`FR-015`, `state_branches` 10, plan §D4）：T04 的 `GROUP BY market` 结果里若出现**没有对应页签的市场**，落一条 WARN 日志（含市场值与条数，新私有 `warnUnreachableMarkets()`）。🚫 **MUST NOT 上 UI**（spec Clarifications Q1：此类锚并未从系统失联 —— 锚管理页不分市场、仍完整列出它；雷达是「击球区」视图，不为不受支持市场的锚开后门）。🚨 **实施时发现的判据缺口，必须在 T10 / T14 补上**：服务端**看不见客户端有哪几个页签**，能用的最接近判据是 `IMPORTABLE_MARKETS`。两者在一种场景下会**漏报** —— 新增受支持市场时改了白名单 + `ck_anchor_market`、却忘了给 mobile 加页签，那时服务端认为「受支持」不喊，而用户确实够不到那些锚，**而这恰恰是 FR-015 声称要守的那个场景**。⇒ **mobile 页签集合 MUST 与 `IMPORTABLE_MARKETS` 同源**（从契约取，不是本地再抄一份 `['us','hk']`），同源后本判据才真的等价于 FR-015 原文。已写进函数注释。→ verify: **已绿**。`get-radar.usecase.spec.ts` 用 `vi.spyOn(Logger.prototype, 'warn')` 断言 —— 计数含未知市场（fixture 层造一只 cn 锚，模拟「历史遗留 / 加了市场忘了加页签」；T03 的 CHECK 今天不让它落库，但判据必须对将来那种形态成立）→ WARN **一次**且消息含市场值与条数（`cn=1`）、**不含**受支持市场（`us=`）；只含 us/hk → **零 WARN**（防每次请求都刷日志）；续页不查计数 ⇒ 也不喊

- [X] T08 [Server] **🚨 委托链回归钉（防 059 的委托被改成自己 create）**（`FR-013`, plan §建锚侧收紧）：钉子落 `optionsdesk-059.anchor-import.it.spec.ts`（**与本条原稿点名的文件不同**：`import-anchor-from-model.usecase.spec.ts` 把 `CreateAnchorUseCase` 整个 stub 掉了，观测不到真派生、钉不住这条边；IT 走真 HTTP + 真 PG 才钉得住）加一条断言 —— guest 模型导入**新建**的锚也带上正确的 `market`。**本 task 零 impl 面**：guest 导入今天是委托 `CreateAnchorUseCase.execute()`（059 刻意如此），T02 落地后自动覆盖。这条钉防的是有人日后把委托改成自己 `prisma.anchor.create` —— 那一刻覆盖就断了，而**没有别的东西会红**。→ verify: 该 spec 新增用例绿；断言里显式走导入口而非直调建锚 use case（否则钉不到委托这条边）

## API Client

- [X] T09 [Contract] **查询 DTO 加 market + 响应带多市场计数 + api-client 重 gen**（`FR-001`, `FR-002`, `FR-016`, plan §D3/§D4/§D6）：① `optionsdesk.dto.ts` 的 `RadarQueryDto` 加 `market` + `@IsIn([...IMPORTABLE_MARKETS])`；🚨 **`@ValidateIf` 的条件是「或」不是「带 cursor 才校验」**：写成 `@ValidateIf(o => o.cursor != null)` 有个洞 —— 不带 cursor 时 `?market=jp` 会被**静默放过**；正确条件是 `o.market !== undefined || o.cursor != null`（给了就必须在白名单内，带游标没给就 `@IsIn(undefined)` 失败 ⇒ 400）。这是 D6 撤销「market 编进游标」后的**全部**替代保护。② 响应加 `RadarMarketCountResponse` + `RadarResponse.marketCounts`；`RadarPage` 同步暴露 `marketCounts`（**续页恒为空**，注释已写明客户端 MUST NOT 在续页读它）。🚨 **计数用数组不用 map** —— OpenAPI 的 map 形态会让 orval 生成 `{ [k: string]: unknown }`（012/023/024/025 那族 objectmap 回归），数组则生成具名 item 类型；已配一条直接查 openapi schema 的断言（`type === 'array'` ∧ 无 `additionalProperties`）。🚨 **响应里的 `market` 是裸 `string` 不是 enum** —— 值域校验只属于入参；响应侧声明 enum 会让 FR-015 那种「库里真有不受支持市场的锚」变成契约撒谎。③ `optionsdesk.controller.ts` radar handler 透传（**不进 filter**）；④ regen `openapi.json`（走 canonical `nx export-openapi server` = `node dist/main.js`，**不是** `dump.mjs`）+ `nx run api-client:generate`（🚨 `nx generate api-client` 会撞 nx 内置代码生成器命令，必须用 `run` 形式）。🚫 **MUST NOT 把 market 编进游标** —— 已判过度设计。→ verify: **已绿**。`optionsdesk.controller.spec.ts` **新增 7 条 radar 用例**（该文件此前**零条** radar 测试，且**此前没有 override `GetRadarUseCase`** —— 真 use case 拿只有 `account.findUnique` 的 prismaStub 一跑就炸，已一并补上 override）：`?market=us` 抵达 use case 且 `filter.market` 为 undefined；`?market=jp` → **400** 且 use case 未被调用；带 `cursor` 不带 `market` → 400；**带 cursor 且带 market → 200**（正向那半条，防把翻页整个挡死）；两者都不带 → 200 且 market 为 undefined；`marketCounts` 回全部市场（请求 us 仍回 hk 那格）；schema 是数组非 objectmap。`pnpm nx run-many -t typecheck lint test -p server mobile api-client` EXIT=0（server 462 files / 5091 tests；mobile 114 files / 1761 tests）

## Mobile

- [X] T10 [P] [Mobile] **市场页签组件（新建）+ 文案**（`FR-001`, `FR-016`, US1, plan §D7）：新建 `radar-market-tabs.tsx`（等分 + 底部短横条 + **自带 `testID`** + 支持小圆点），视觉体例**逐字抄同目录的 `leg-picker-tabs.tsx`**（049 T006 视觉换稿 A 那套）。文案落 `optionsdesk-copy.ts` 本地常量，用**双字**「美股 / 港股」。🚨 **页签集合的单点 = 文案表的键**（`RADAR_MARKETS = Object.keys(COPY.marketTabs)`，住 `radar.rules.ts`）——文案表声明成 `satisfies Record<RadarMarket, string>`，于是绑定是**编译期双向**的：server 加受支持市场而没补文案 → `TS1360`；多写一个契约没有的市场 → `TS2353`。**Mutation 实测两向均红**（2026-08-22）。这条闸是 FR-015「加了市场却忘了加页签」在**客户端侧的唯一保护**（服务端那侧判据只能是 `IMPORTABLE_MARKETS`，恰对此场景漏报）；🚫 **MUST NOT 摘掉文案表的 `satisfies`**，那会同时拆掉两侧。⚠️ **与本条原稿的「从生成的 client 类型取」有一处落地偏离**：`Object.values(OptionsdeskControllerRadarMarket)` 是**值**导入，而 mobile 的 vitest 至今只对 `@nvy/api-client` 做过 `import type`（被 erase）；真去解析会撞 `Failed to resolve entry for package "@nvy/api-client"` —— 包的 `exports` 把 `no-vain-years-mono` condition 指向 `src/index.ts`，但 vitest 把 workspace 包 externalize 后走 Node 解析，Node 不认自定义 condition，落到并不存在的 `./dist/index.js`（**已实测**）。为一个常量改整个 mobile 测试基建收益不抵风险 ⇒ 改走编译期绑定，保证同样硬且**红得更早**（tsc 而非运行时）。类型 `RadarMarket` 仍直接取契约（纯类型导入，无此问题）。🚫 **MUST NOT import `~/alert/alert-tab-row`**；🚫 **MUST NOT 本次上提 `~/ui`**；🚫 **MUST NOT 用 `marketBadgeLabel` 当标签**。🚨 小圆点：**圆点位恒占位、只变色，有点时才挂 `testID`** —— 占位让切页签时标签不横跳，条件 `testID` 让 e2e 能同时断「出现」与「不出现」（条件渲染整个圆点会让标签跳约 6px；恒挂 testID 会让反向断言永远绿）。→ verify: **已绿**。视觉值全走 NativeWind class（零字面量 / 零 hex）；**单元素 className ≤ 4 原子**（逐元素核过：`flex-1 items-center py-sm` + 条件 `bg-surface-sunken` = 4；横条 3 + 1 = 4；圆点 3 + 1 = 4；容器 4 / 3 / 1）；选中态**三重编码**（底色 + 底部横条 + 字重），断言不依赖 `accessibilityState`（`react-native-web` 丢弃它）。`radar.rules.spec.ts` +3：集合恰好是文案表的键（改成硬编码数组即红）/ 美股在前（FR-005 前提）/ 文案非空且两两互异。`pnpm nx run-many -t typecheck lint test -p mobile` EXIT=0（114 files / 1764 tests，较 T09 +3）

- [X] T11 [Mobile] **雷达接市场作用域 + 导出 query key 工厂**（`FR-002`, `FR-005`, `FR-006`, `FR-007`, US1, plan §D8/§D9）：`use-radar.ts` —— market 进请求参数**且进 query key**（切页签自然重置 `pageParam`，这正是 D6 判定「跨市场游标不可达」的依据）；`radarQueryKey(market, filters)` 工厂与 `RADAR_QUERY_KEY` 前缀**都落 `radar.rules.ts`**（纯函数、有 vitest 覆盖），`use-radar.ts` re-export 保持 `index.ts` 对外面不变，也让 T12 的 mutation 侧能拿到**同一个**工厂；默认落 `RADAR_MARKETS[0]`（= 美股）、**会话内**记忆（底部 Tab 常驻不 unmount ⇒ `useState` 就够）；🚫 **MUST NOT 依据当前哪个市场开市自动切换**（会让「我刚才在哪个页签」不可预测，且在开/收盘时刻自己翻页）；筛选 state **跨页签保留**（是镜头不是每页签独立状态）。`radar-screen.tsx` 在题头下插页签行；新增 `actionableMarkets`（取 server `marketCounts` 中 `actionableTotal > 0` 的市场，不受当前作用域限制 ⇒ 能回答「**别的**页签有没有值得看的」）。→ verify: **已绿**。`radar.rules.spec.ts` +5 —— key 工厂：同参数同 key / **市场不同则 key 不同**（拿掉 market 后 D6 的判定当场失效，而列表照样渲染、没有别的断言会红）/ 筛选不同则不同且都与 `RADAR_QUERY_KEY` 共享前缀（mutation 失效靠这个前缀命中，T12 的地基）；`SC-002` 落点 —— 只含 hk 行 → 新鲜度文本**不含时刻**（判据用正则查 `\d{2}:\d{2}` 而非比对整句文案，后者随文案编辑就红）+ **反例记录**：不分市场混排时一只美股实时行把整条 bar 拉成时刻粒度（字典序 = 时间序），这条就是「为什么必须按市场分」的机械证据。`pnpm nx run-many -t typecheck lint test -p mobile` EXIT=0（114 files / 1769 tests，较 T10 +5）

- [X] T12 [Mobile] **🚨 修雷达缓存失效链断裂（既存 bug，独立 commit）**（plan §顺手修一个既存 bug）：`use-anchor-mutations.ts` 的失效改用 `RADAR_QUERY_KEY`（T11 落在 `radar.rules.ts` 的前缀），并删掉已成 orphan 的 `getOptionsdeskControllerRadarQueryKey` import 与 spec mock。**病根已实证**：mutation 失效的是 orval 生成的 `['/api/v1/optionsdesk/radar']`，而 `useRadar` 的 key 由 `radarQueryKey()` 铸造（前缀 `['optionsdesk','radar']`），**两者无共同前缀**而 react-query 的 invalidate 走前缀匹配 ⇒ 任何锚的增删改**从未失效过雷达**（锚管理列表的失效是好的，那屏用 orval hook；只有雷达是孤儿）。🚨 **本 task 单独一个 commit**，message 写明「这是先于本 feature 存在的缺陷，因本片正在改同一个 key 而顺手修」。→ verify: **红绿闭环两层都实测过，不是推理**。① 纯逻辑断言（比 e2e 更早红）：`use-anchor-mutations.spec.ts` 断言失效发出的 key 里含 `RADAR_QUERY_KEY` 前缀 —— **先加、实测红**（其余 10 条全绿，正是「测试全绿而 bug 一直在」的形态），改实现后绿。② e2e：`optionsdesk-anchors-radar.spec.ts` 新增「改锚后返回雷达，行上的 L 层徽标随之更新」——🚨 **断 L 层徽标而非「新行可见」**（本条原稿写的是建锚）：hermetic mock **不支持 POST /anchors**，而改 L 层同样穿过整条链（PATCH → onSuccess → invalidate → 雷达重取 → 行内徽标变），且 mock 的 `applyAnchorPatch` 会真的改 `lLevelEffective` ⇒ 差异在雷达行上直接可见。证明力相同，路径便宜得多（不必给 mock 补建锚写侧 + 走表单选票流程）。**Mutation 实测**：把失效 key 退回 orval 的那一刻，该条 e2e 精确红而其余 16 条全绿。`pnpm nx run mobile:e2e` 17 passed；`run-many -t typecheck lint test -p mobile` EXIT=0

- [X] T13 [Mobile] **空态映射强制穷举 + 第 4 空态渲染**（`FR-008`, `FR-010`, `SC-004`, US2, plan §D5）：`radar.rules.ts` 的 `radarViewState` 从 if 链改成 `Readonly<Record<NonNullable<RadarResponseEmptyState>, RadarViewState>>` 全映射（`SERVER_EMPTY_STATE_TO_VIEW`）；`RadarViewState` 加 `zero_anchors_in_market`；`radar-screen.tsx` 为第 4 态渲染**只有文案、零按钮**的块（有效动作是切市场，而页签就在这块区域正上方）。🚨 **不改会静默出错且看着合理**：if 链在服务端加第 4 个枚举值后**照样编译**，会 fall through 到 `items.length === 0` 分支 ⇒ 渲染出**正确文案 + 一个什么都不做的「清除筛选」按钮**（当时根本没选筛选）。🚨 判定序保留一处 if：`all_idle` 是 server 四态里**唯一「有行」的**，只有它要让位给前端派生的 `quotes_degraded`；其余（含将来新增的）一律直接透传 —— 空态的新成员几乎必然属于「一行都没有」那类。→ verify: **已绿**。`radar.rules.spec.ts` +3：第 4 态映射到**自己的** view state 而**非** `filtered_empty`；四态各自透传互不折叠；行情降级仍压过 `all_idle` 而**零锚类不让位**（它们说的是「一行都没有」，压根没有行可降级）。**Mutation 实测**：把 `Record` 删一个键 → `TS2741`（穷举强制生效的证据）

- [X] T14 [P] [Mobile] **港股能力说明常驻 + 跨页签小圆点 + 选择器收紧**（`FR-012`, `FR-016`, `FR-017`, `SC-006`, `state_branches` 6, `state_branches` 7, `state_branches` 8, US2, US3, plan §D10/§D4/§建锚侧收紧）：① `radar-screen.tsx` 在页签下渲染**常驻一行**「该市场暂不提供盘中实时价，行情以交易日收盘为准」，🚫 **MUST NOT 只在空态下呈现**；这兑现 061 FR-010 欠的 UI 那半条（此前全仓 `rg '不支持实时'` 在 UI 文案里零命中）。判据是新常量 `MARKETS_WITHOUT_INTRADAY`（`radar.rules.ts`）—— 🚨 **本地常量而非从行数据推断**：说明要常驻，而空态时一行都没有、推不出任何东西；它是 **marketdata 行情能力表的镜像**，与 `IMPORTABLE_MARKETS`（管「能不能建锚」）是**两件事**，新增市场时须一并核对。② 非当前页签的小圆点 —— 数据源是 T09 的 `marketCounts` 经 T11 的 `actionableMarkets`，组件在 T10；🚫 **不带数量**。③ `ticker-search-picker.tsx` 非受支持市场**可见但不可选 + 一句原因**（`disabled` + `accessibilityState` + 就地文案），判据 `isSupportedMarket()` 与页签集合**取同一处**；🚫 **MUST NOT 静默过滤掉**。→ verify: **已绿**（`nx run mobile:e2e` 20 passed）。三组：① **说明常驻** —— 港股页签**有锚时**说明仍在，且美股页签零命中、切换后美股行确实消失（作用域真生效）；② 小圆点 —— 非当前页签有可动锚 → 出现且 `toHaveText('')`（不含任何数字），当前页签自己不渲，切过去后**两侧都不该有**（反向那半条）；③ 选择器**双向** —— A 股项可见、`toBeDisabled()`、原因就地同屏；**且 us 项仍可选并一路建成锚**（填 4 个必填字段 → save → 新锚出现在锚列表）。🚨 **③ 的反向断言不能写成「tap 一下看没反应」**：Playwright 对 disabled 元素的 tap 会一直重试到用例超时（实测 120s），那是假红不是真信号 ⇒ 用 `toBeDisabled()`。🚨 **连带把 `optionsdesk-anchors-radar.spec.ts` 的 radar mock 升级成真契约镜像**（作用域切分 + `marketCounts` + 四态 + POST /anchors）—— 不改的话本组三条根本没有数据源（`marketCounts` 恒 undefined ⇒ 小圆点永不出现）。另两处 mock 归 T15

## E2E

- [X] T15 [Mobile-E2E] **三处 hermetic mock 补 market + 分页 / 空态 / 页签用例**（`FR-001`, `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-010`, `SC-001`, `SC-004`, `state_branches` 2, `state_branches` 3, `state_branches` 4, `state_branches` 5, `state_branches` 6, US1, US2）：

  ① **三处** radar hermetic mock 全部升级成真契约镜像（作用域切分 + `marketCounts` + 四态）：`optionsdesk-anchors-radar.spec.ts`（T14 时已做，另加 keyset 分页 + POST /anchors + 请求记录）/ `optionsdesk-detail-thermometer.spec.ts` / `optionsdesk-chain-report.spec.ts`。🚨 三处 fixture **全是 `us:*`** ⇒ 漏改不会红 —— 正是这类 mock 悄悄失真的典型路径，注释里逐处点名。② 硬编码空态从 3 扩到 4（`EMPTY_STATE_MESSAGES` + 两条优先级 e2e）。

  → verify: **已绿**。`nx run mobile:e2e` **237 passed**（全套）；`nx run mobile:runtime-smoke` **237 passed**（改了共享 hook，blast radius = 整套）；单 spec 25 passed。新增 5 条：

  **(a) 切换与默认**（US1-AS1/AS5/AS6）：冷启动落美股（港股行零命中）→ 点港股**行确实换了**（🚫 不断言 `aria-selected`，`react-native-web` 不渲染它）→ 二级页往返后仍在港股。

  **(b) 分页连续性**（US1-AS2/AS4, Edge Case 3, `FR-004`, `FR-005`）：🚨 **判据从「第一屏有几行」改成「请求序列」**——实测发现 web 的 FlatList 在内容不满一屏时会**立即反复触发 `onEndReached`**，短列表一次性翻到底 ⇒ 行数断言取决于视口高度，是环境相关的假信号（第一版就是这么红的）。改断：首请求无游标 / 至少一次**带游标的续页** / **每一次都带 `market=us`**（续页丢作用域正是 D1 要挡的洞）/ 切页签后第一次请求**不带游标**（= 回第一屏）。UI 侧断集合：5 只美股一只不少、无重复、港股那只**即使距 W% 更靠前也不在**（作用域先于排序）。「翻页途中改排序键」改成「排序键变动后重新分页仍不漏不重」（同一原因：没有可控的「途中」），mock 写的是**真 keyset 而非 offset**，所以这条仍测得到真东西。

  **(c) 空态入口双向**（US2-AS3/AS4, `SC-004`）：港股零锚（库中另有美股锚）→ 第 4 态文案在且**建锚 CTA 与「清除筛选」计数均为 0**（抓 T13 的 fall-through）、文案不等于第 1 态；**反向** —— 整库零锚 → 落 `zero_anchors` 且建锚 CTA **必须出现**，切到港股仍是第 1 态（优先级不可换）。🚨 只断前者会让「什么入口都不给」照样绿。

  **(d) 行级粒度与筛选**（US2-AS2, US1-AS3, `SC-001`）：港股行内行情时点是**交易日**而非时刻（T11 只覆盖顶部聚合，覆盖不到行内）；筛选**跨页签保留**（美股筛 L1 → 空 → 切港股，L1 的港股行仍在）。

- [X] T16 [Contract-Smoke] **契约冒烟带上 market**（`FR-002`, `SC-003`）：`optionsdesk.contract.ts`（2 处）与 `optionsdesk-realtime-spot.contract.ts`（2 处）调雷达时带 `market`。🚨 现状是**可选参数 ⇒ 绿但零覆盖**，不改的话生成的 client 与真 server 在这个新参数上的对齐从未被验证过。→ verify: **已真跑** —— `RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke` **25/25 passed**（日志实证 `radar?limit=50&market=us` 与 `limit=100&market=hk` 都真的打出去了）。新增 `SC-003` 端到端断言：分别取 us / hk 两个作用域 + 一次不带作用域，断**并集 = 全集**（无遗漏）、**交集为空**（无重复）、各作用域**只回本市场行**（列相等谓词真到 SQL 端）、`marketCounts` **不随作用域收窄**（否则港股有可动锚时美股页签零信号）。🚨 并集断言配了前置 `assert.equal(all.data.hasMore, false)` —— 全集超过一页时比的是两个**被截断**的集合，有这条则锚数超 100 时明确红出来而非静默失真。🚨🚨 **本 task 踩到并记录一次「绿得骗人」**：`nx run mobile:contract-smoke` 首次返回 `EXIT=0` + `Successfully ran target`，但日志只有一行 `RUN_REAL_BACKEND_SMOKE !== 'true' — skipping` —— 整个套件**被 env gate 跳过**，新参数一次都没执行。按退出码汇报就会把 T16 记成「已验证」。⇒ 跑 contract-smoke **必须显式带 `RUN_REAL_BACKEND_SMOKE=true`**，且**必须核对日志里的 `done — N/N passed`**，退出码在这条命令上不构成证据（`docs/conventions/local-verification.md` §3）

## Polish

- [X] T17 [Manual] **真机 / 窄视口验首屏可视行数**（plan §Complexity Tracking）：本片跳过了 Mockup（Constitution Principle I 的一处已论证偏离），其代价是**顶部 chrome 从 2 层叠到 5 层**（标题 / 市场页签 / 港股说明 / 新鲜度条 / 筛选 chips），列表可视高度被压缩。→ verify: **已完成，结论已回写 plan §Complexity Tracking「T17 实测回写」**。测法：Playwright 临时探针（**跑完即删**，未留在 repo），在**港股页签**取证（5 层全叠的最坏情况），8 只港股锚，逐视口量「首屏**完整**可见行数」，并加一轮 CSS 藏掉 065 两层的基线对比。**结果：三档视口一致地 −1 行** —— 360×780 `5→4`、375×667 `4→3`、412×915 `6→5`；层高实测页签 39px / 说明 16px，列表起点 y `135→190`（+55px），行高 116px。**判定：可接受，不回补 Mockup**（净代价恒定 −1 行而非数量级压缩；最紧机型仍剩 3 行，而 `all_idle` 本就是雷达常态、可动锚长期个位数；两层里页签是功能本体、说明仅 16px）。🚨 **红线已记入 plan：再叠一层必须先做减法** —— 048 视图 seg 若按现形态再插约 40px，最紧视口掉到 **2 行**。✅ **真机已复验**（Mate50 dev-client，2026-08-22，明细见 plan §T17 真机复验）：设备 CSS 视口约 **335×738**（override 1088×2400 / density 520），**美股页签首屏 4 行完整可见**，与探针 360×780 吻合、结论不变。同轮真机实证：FR-016 小圆点（切港股后美股页签出现圆点且无数字）· **FR-012 说明在建了 hk 锚之后仍在**（「MUST NOT 只在空态呈现」的正面实证）· 第 4 空态零按钮 · 选择器搜 `00700` 可选并一路建成锚且 DB 落 `market=hk`（T02 派生 + T03 CHECK 端到端）· **T12 失效链修复生效**（建锚后回雷达新锚直接可见）· 港股行降级为「行情不可用」且距 W 呈「—」而非 0。⚠️ 机上原装 standalone 0.12.0（`flags` 无 `DEBUGGABLE`）跑内嵌 JS、无视 Metro，已换成主 worktree 的 dev-client APK（8/14 构建，065 未动原生层故直接复用）

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
