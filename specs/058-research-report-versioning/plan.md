---
feature_id: 058-research-report-versioning
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-16'
updated_at: '2026-08-16'
adr_refs: ['0065', '0052', '0048', '0043', '0040', '0038', '0032']
context7_verified: []
---

# Implementation Plan: 研报归档 —— 同标的多版本与元数据回声

## Summary *(mandatory)*

在 057 已 ship 的投递通道上实装版本规则与元数据回声：幂等键从「投递方 + 内容指纹」放宽为「投递方 + 标的 + 内容指纹」，`version` 列由恒 1 变为「该(投递方,标的)线上的投递序号」，201 应答从 4 个字段扩到 9 个。

三条主线：① **版本号在建行时取、靠新增唯一键挡并发**（`MAX+1` insert 撞 P2002 有界重试，不上 Serializable）；② **「最新」按 `reportDate` 查询派生、只看 COMMITTED**，不落列（落列在并发下会出现两条 latest）；③ **标的名称走 Q7-B 只读直查 + fail-open**，research 由此从「跨 ctx 面 = 0」变为 1，需回改 ADR-0065。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**零新依赖**。名称读取走既有 `PrismaService`；版本号取号与并发重试走 Prisma 既有的 `P2002` 错误形态（`apps/server/src/marketdata/sync-universe.usecase.ts` 等处已有同形态 catch，不新引 retry 库）。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

- **I. SDD**：spec → clarify（3 问已答）→ 本 plan → tasks，`status` 已随阶段翻 `clarified`。
- **II. Test-First**：每个 task 先红后绿；spec 的 21 条 `state_branches` 逐条对应 IT `it()` 块。
- **III. Atomic Task**：见 tasks 阶段，每条 30min–2h 且独立 commit。
- **IV. Module Boundary（扁平 + 贫血 + 护城河）**：全部改动落在 `apps/server/src/research/` 扁平层，无新 class、无 Repository。唯一的跨 ctx 面是 `instrument` 只读直查，走 catalog Q7-B 逃生口 + `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` 强制），**不** DI marketdata 的任何 use case。
- **V. 类型同步链**：改了 response DTO ⇒ `nx run server:export-openapi` + `nx affected -t generate` 同 PR 内跑，见 A7。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 新增 `apps/server/test/integration/research-058.versioning.it.spec.ts`（Testcontainers 起真 PG，沿用 `research-057.report-ingest.it.spec.ts` 的 harness），覆盖 `state_branches` 全部 21 条。本片**不新增端点**，改的是既有 `POST /v1/research/reports` 的行为与响应体 ⇒ 057 那条 real-boot smoke 的覆盖面自动延续，无新裸端点遗漏风险。
- [x] **Mobile / Web**: N/A —— 本片零前端面（`web_compat: na`），投递方是隧道内的 CLI agent。
- **Evidence**: 既有 harness = `apps/server/test/integration/research-057.report-ingest.it.spec.ts`；本片产物在 tasks 的 IT task 落地。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**Evidence**: N/A —— 本片零新第三方包 / SDK / 工具（见上方 Cargo-cult 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- **Evidence**: N/A —— feature 是 mono-native（057 本身就是 mono 内新建的第 11 个 context，无 meta-repo 前身）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0065 §1 | 「立第 11 个 bounded context `research`，**跨 ctx 面为 0**」—— 明写不做到 `marketdata.instrument` 的依赖，理由是「校验会拒绝合法的新标的，且引入本可避免的 Q7-B 依赖」 | **mitigated（回改原 ADR，不新开）** | 本片给 ADR-0065 追加 `## 复审记录 — 2026-08-16`（体例照 ADR-0048）：跨 ctx 面 0 → 1；并写明**原 ADR 的两条理由只有第二条被放宽** —— 「会拒绝合法新标的」对**只读回显**完全不适用（查不到只回空、不拒绝），被放宽的只有「引入 Q7-B 依赖」，依据是 ADR-0052 已有同表同字段先例 + ADR-0048 的摊销判据。原 §1 正文按仓内惯例**冻结不回改**，只加复审段。 |

**扫描方式**：`rg -n 'marketdata\.instrument|跨 ctx 面' docs/adr/*.md` —— 除 ADR-0065 外命中的 ADR-0048 / ADR-0052 均是**为本片提供先例**而非被本片影响，无需改动。

**Evidence**: ADR-0065 amend 在本 feature 分支内完成，见 tasks 的 ADR task。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).
>
> ⚠️ **本片对 Moat 有一处受控例外**：`marketdata.instrument` 的**只读**直查（A4）。它走 catalog **Q7-B 逃生口**，必须挂 `// CROSS-CONTEXT-READ:` 注释（`check-server-moat` Check 1 硬拦），且**只读、绝不写**。除此之外 Moat 全程适用。

#### A1 — Schema：两个唯一键，零新列

- 幂等键放宽：`@@unique([uploaderKind, uploaderRef, contentHash])` → **`@@unique([uploaderKind, uploaderRef, symbol, contentHash])`**（FR-019）。这是**放宽**，不会拒绝任何既有行。
- 取号键新增：**`@@unique([uploaderKind, uploaderRef, symbol, version])`**。它不是给查询用的，是**并发取号的机器保证**（FR-025）——不建它，`MAX+1` 就只是一句祈祷。
- **零新列**：`version` 列 057 已建（`@default(1)`）；`instrumentName` **刻意不落列**（FR-017 实时读）。⇒ 迁移只动索引。
- 迁移安全性：现有 3 行 `version` 全为 1，且各自 `(uploaderKind, uploaderRef, symbol)` 下均只有一行 ⇒ 新唯一键**无冲突**，无需数据回填。迁移目录名走 `YYYYMMDD_HHMM_` 前缀体例（同 `20260815_2226_create_research_report_table`）。
- **不另建 `latest` 查询索引**：A3 的查询过滤列是 `(uploaderKind, uploaderRef, symbol)`，恰好是新取号唯一键的**最左前缀**，直接可用；排序在几行的结果集上做，量级可忽略。对齐 057「不预先给 symbol 撒 B-tree、按真实查询形状建才对」的取舍。

#### A2 — 取号与并发：建行时取，撞 P2002 有界重试

- 取号时点 = **建 PENDING 行时**（FR-023，clarify Q1）。`SELECT MAX(version) + 1 WHERE (uploaderKind, uploaderRef, symbol)` → 带着这个号 `create`。
- 并发保护 = **新唯一键 + catch P2002 → 重算重试**，上限 **3 次**。🚨 **NEVER Serializable、NEVER `FOR UPDATE`** —— server-impl-playbook 明令（004 实证偏索引 SSI 72/100 假冲突）。本片走 READ COMMITTED + 唯一约束足够。
- ⚠️ **只 catch P2002**：不走 Serializable ⇒ 不涉及 P2034 那半（playbook 里 P2002+P2034 双形态是 Serializable 场景专属）。但 catch 时要**分辨撞的是哪个唯一键** —— 幂等键（A1 第一条）撞了说明是重复投递、应走幂等分支；取号键撞了才是并发争用、才重试。两者混淆会把重复投递变成 3 次无谓重试后报错。
- 未完成行**占号且可续做**（FR-024）：续做路径直接复用既有行的 `version`，**不重新取号**。
- **重试耗尽的对外表现（clarify Deferred #1，本 plan 定死）**：返回 **503 + `code: RESEARCH_VERSION_CONTENTION`**。选 503 是因为它天然带「稍后重试」语义，且**重投是安全的**（要么命中幂等、要么拿新号）。
  🚨 **不能只靠 503 这个数字** —— 057 的 503 已被 `RESEARCH_STORAGE_NOT_CONFIGURED` 占用，而那个的正确动作是**停手**。两者必须靠 ProblemDetail 的 `code` 区分（ADR-0038 契约），skill 文案与错误码表同步补这一行（A8）。
  实际概率：限频每分钟 2 次 ⇒ 三次连撞近乎不可能；本条是**契约完备性**而非性能考量。

#### A3 — 「最新」判定：查询派生、只看成功记录、时点在翻 COMMITTED 之后

- 判据 = 该线 **`status = 'COMMITTED'`** 记录中 `reportDate` 最大者；同日期取 `version` 大者（FR-004 / FR-005，clarify Q2）。⇒ 一句 `orderBy: [{ reportDate: 'desc' }, { version: 'desc' }]` 取首行即为 latest，tie-break 天然内含，**不需要额外分支**。
- 🚨 **查询时点必须在把本次记录翻成 COMMITTED 之后**。翻之前查，本次记录自己还是 PENDING、会被 `status` 过滤掉，于是永远判不出「我就是最新」。这是本片最容易写反的一处。
- `latest` = （该线首行的 id === 本次记录 id）。非 latest 时把首行的 `reportDate` 一并回给投递方（FR-007）。
- 幂等命中路径**同样要跑这段查询**：回显的 `latest` 必须是**库中此刻的真实状态**，不能沿用该记录当初落库时的状态（Edge Case 已列）。
- **不落 `is_latest` 列**：维护成本之外，并发下会出现两条同时为真或全线为假（spec Assumptions 已记）。

#### A4 — 标的名称：Q7-B 只读直查 + fail-open

- 落点：`ingest-research-report.usecase.ts` 内 `this.prisma.instrument.findUnique({ where: { market_code: { market, code } }, select: { name: true } })`（`@@unique([market, code], map: "uk_instrument_market_code")` ⇒ Prisma 复合键访问器为 `market_code`）。
- 🚨 **必须挂注释**，否则 `check-server-moat` Check 1 硬拦 commit：
  ```ts
  // CROSS-CONTEXT-READ: 投递应答回显标的名称需 marketdata.instrument 的 name (只读, Q7-B per ADR-0065 复审)
  ```
- **不 DI marketdata 的任何 use case / service**（catalog Q7-C 禁列，`check-server-moat` 拦）。不包 SecurityModule 共享读服务 —— 仓内两处真实先例（`alert/evaluate-alerts.usecase.ts:168`、`marketdata/sync-option-contract.usecase.ts:232`）都是 usecase 内直查 + 注释，为一条查询造一层服务是过度设计。
- **fail-open 且不可区分**（FR-014 / FR-015，clarify Q3）：整段读用 `try/catch` 包住，**任何**异常 → 名称按 `null` 走、投递照常成功。查不到与查失败对外**完全一样**；区分只落**服务端日志**（`logger.warn`，带 symbol + 错误摘要）。
- `symbol` 是归一后的 `market:code` 单字符串，查询前要拆成 `market` / `code` 两段 —— 在 `research-report.rules.ts` 加一个纯函数（如 `splitSymbol`）并配单测，**不要**在 usecase 里 inline 一个 `split(':')`（rules 层是本模块业务不变量的落点，per ADR-0043）。
- 名称按**本次应答最终生效的 symbol** 查（FR-016）：幂等命中时用库中那条的 `symbol`，不是请求参数里的那个。

#### A5 — 响应 DTO：4 字段 → 9 字段

`research-ingest.response.ts` 新增 `title` / `reportDate` / `version` / `latest` / `currentLatestReportDate`(nullable) / `instrumentName`(nullable)。

🚨 **两个 nullable 字段的 `@ApiProperty` 必须显式写 `type: 'string'`**：

```ts
@ApiProperty({ type: 'string', nullable: true, description: '…', example: null })
instrumentName!: string | null;
```

不写 `type` 时 orval 会把它生成成 objectmap（`{ [key: string]: unknown }`）而不是 `string | null`——**typecheck 全绿、CI 不报**，只在 mobile 侧用到时才发现类型是错的（仓内已踩过，012）。`reportDate` / `currentLatestReportDate` 用 `YYYY-MM-DD` 字符串回（与请求参数同形），不回 ISO datetime。

#### A6 — 057 既有测试的连带影响（先跑再改，别预判）

幂等键加了 `symbol` 维度 ⇒ `research-057.report-ingest.it.spec.ts` 里凡是「同一投递方 + 同字节」的断言都可能隐含了「不管 symbol」的旧语义。**动手顺序**：先原样跑一遍 057 IT 拿到真实红点，再按 058 的 FR 逐条判「这条断言是该改还是该保留」——**不要**凭读代码预判要改哪几条。改动过的断言必须在 commit message 里写明「057 的哪条语义被 058 有意改写」，避免日后被当成回归。

`research-057.schema.it.spec.ts` 若断言了唯一键的具体列集合，同理。

#### A7 — 契约同步链（Constitution §V，不能只跑一半）

改了 controller 的 `@ApiResponse` / response DTO ⇒ **两步都要跑**，没有一行覆盖：

```bash
nx run server:export-openapi   # ① 重写 apps/server/openapi.json —— 只有这步靠人记住
nx affected -t generate        # ② orval regen packages/api-client
```

只跑 ② 是拿 stale `openapi.json` regen，且 **`git status` 干净、CI 全绿、无一处会红**。mobile 不消费该端点（guest 面），所以这步是纯 types 同步，不产生 mobile 改动。

#### A8 — skill 文案（属本片交付物，不是「顺便」）

`services/guest-proxy/openclaw-skill/SKILL.md` 必须同 PR 更新，四处：

1. **去重那条的键变了** —— 现在是「你 + **标的** + 文件字节」。原文写的「`symbol` / `title` / `reportDate` 都不在键里」**从本片起有一半是错的**，不改就是 skill 里第四例「想当然写错」。
2. **「`symbol` 投错在本通道内不可逆」这条要改写** —— 本片起，用正确 symbol 重投同一份文件即可补救。这是 US3 的用户可见价值，不写进 skill 等于没交付。
3. **响应体新字段** + 明确「拿到 `deduplicated: true` 时回显的是库里那条的值」。
4. 🚨 **`instrumentName` 的盲区告警**：名称对上**只证明**「不是投成了另一家公司」，**不证明市场选对了** —— 两地上市的 A/H 在目录里同名（`cn:601318` 与 `hk:02318` 都叫「中国平安」，prod 已查证）。不写死这条，回显会制造虚假的安全感，比没有回显更危险（SC-008 把该盲区写进验收条款本身，就是为了逼出这段文案）。

另加错误码表一行：`503 / RESEARCH_VERSION_CONTENTION`（A2）。

#### A9 — ADR-0065 回改

追加 `## 复审记录 — 2026-08-16` 段，体例照 [ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md) 的复审段：跨 ctx 面 0 → 1，选 Q7-B 的两条依据（同表同字段先例 ADR-0052 §3 / 摊销判据 ADR-0048），以及「原 §1 两条理由只有第二条被放宽」的区分。**原 §1 正文冻结不回改**（仓内惯例：历史决策留痕，只加复审段）。

## Complexity Tracking

> Fill ONLY if Constitution Check reports violations that need justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| 护城河例外：research 直读 `marketdata.instrument`（只读） | 投递方对自己声明的标的零反馈，是 2026-08-16 实测两类错误的共同根因；回显名称是这条**只写**通道里唯一可能的自查手段 | **Q7-A（Outbox 物化视图）**：按 ADR-0048 摊销判据，本片读频率 = 每次投递一次且被 2 次/分限频卡死、读时计算 = 一次索引单行查找 ⇒ **无摊销对象**，事件机器在为不存在的读压力做优化。**Q7-C（DI marketdata use case）**：catalog 禁列，`check-server-moat` 硬拦。**完全不做**：等于放弃 FR-012～FR-018 这一整块用户价值 |
