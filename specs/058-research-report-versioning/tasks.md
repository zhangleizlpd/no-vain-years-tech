---
feature_id: 058-research-report-versioning
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-16'
updated_at: '2026-08-16'
---

# Tasks: 058-research-report-versioning（研报归档 —— 同标的多版本与元数据回声）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: 回改 [`ADR-0065`](../../docs/adr/0065-research-report-private-object-storage.md) §1（跨 ctx 面 0 → 1）
**Branch**: `058-research-report-versioning`
**前身**: 057 已 ship 的投递通道；057 把「同标的多版本 Version+1」明写为后续 feature，本片就是它

> **T005 编号留空**：原「latest 判定」task 于 2026-08-16 第二轮澄清删除（服务端不再判定 / 回显「最新」），残留的回显字段并入 T004。**幸存 task 编号不重排** —— 与 spec 的 FR / SC 编号同一策略。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan A-x）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Contract]` / `[Ops]` / `[Docs]`。本片**零 mobile**（guest 走裸 curl，不经 `@nvy/api-client` 运行时）⇒ 无 `[Mobile]` / `[Contract-Smoke]`。
- 本片**不新增端点、不新增依赖、不新增 env、不新增对外错误码**，改的全部是既有 `POST /v1/research/reports` 的行为与响应体。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| DB（改：两个唯一键） | `apps/server/prisma/schema.prisma` · `apps/server/prisma/migrations/<YYYYMMDD_HHMM>_<desc>/` |
| 纯函数（改：加 1 个） | `apps/server/src/research/research-report.rules.ts` |
| 业务（改：幂等键 / 取号 / 名称 / 回显） | `apps/server/src/research/ingest-research-report.usecase.ts` |
| 响应 DTO（改：4 → 8 字段） | `apps/server/src/research/research-ingest.response.ts` |
| 端点（改：`@ApiResponse` 描述） | `apps/server/src/research/research.controller.ts` |
| IT（新建 1 个 / 改 2 个） | `apps/server/test/integration/research-058.versioning.it.spec.ts` · `research-057.{schema,report-ingest}.it.spec.ts` |
| 契约产物 | `apps/server/openapi.json` · `packages/api-client/src/` |
| 决策留痕 | `docs/adr/0065-research-report-private-object-storage.md` |
| guest 能力目录（改：投递研报那节） | `services/guest-proxy/capabilities/capabilities.md` |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/research/` 下 **MUST NOT** 建任何子目录；本片不新建文件，全是改既有的。
⚠️ `research-ingest-rejected.exception.ts` **本片不动** —— 不新增任何对外错误码（plan A2）。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **放宽后的幂等键 `map:` 不能省**。省了 Prisma 生成默认名 `research_report_uploader_kind_uploader_ref_symbol_content_hash_key` = **66 字符**，超 PG 标识符 63 上限，schema 校验期就红。同 model 另两个键都显式给了 `map:`（plan A1）。
2. **catch `P2002` 后必须分辨撞的是哪个唯一键** —— 表上两个键含义相反：幂等键撞了 = 重复投递（走幂等分支），取号键撞了 = 并发争用（重试）。**判别方式 = 重查一次幂等键**：查到行 = 重复投递，查不到 = 取号争用。🚨 **不要用 `meta.target`** —— 该字段在 PG 连接器下常返回**约束名**而非列名数组，且随 Prisma 版本 / adapter 变形（`create-anchor.usecase.ts:96` 专门写结构化 `isP2002` 并注明「Prisma 7 兼容」就是这个原因）。重查法与其形态无关，范式已在 `create-anchor.usecase.ts:244-250` 落地（plan A2）。
3. **`NEVER` 用 Serializable / `FOR UPDATE` 做取号**（server-impl-playbook 明令，004 实证偏索引 SSI 72/100 假冲突）。READ COMMITTED + 唯一约束 + 有界重试足够。也**不涉及** `P2034`——那是 Serializable 场景专属。
4. **取号的 `MAX(version)` 查询 `WHERE` 必须带全 `(uploaderKind, uploaderRef, symbol)` 三列**。漏 uploader 两列 = 版本线串到别的投递方头上（FR-003 / FR-011）；漏 `symbol` = 同一投递方的不同标的共用一条线。**这条有测兜底**（state_branch 6 会红），但写的时候先想清楚比事后看红点便宜。
5. **`MAX(version)` 查询不要过滤 `status`** —— 未完成行照常占号（FR-024）。过滤掉它们会把一个被占的号重新发出去，撞取号唯一键。
6. **`instrumentName` 的 `@ApiProperty` 必须显式写 `type: 'string'`**。不写 `type` 时 orval 生成 objectmap 而非 `string | null`，**typecheck 全绿、lint 全绿、CI 无一处会红**，只在 mobile 侧用到时才发现类型是错的（仓内 012 已踩）。`check-api-property-nullable.ts` 是这条的机器闸。
7. **跨 ctx 读 `instrument` 必须挂 `// CROSS-CONTEXT-READ:` 注释**，否则 `check-server-moat.ts` Check 1 直接拒 commit。且**只读、绝不写**；**不 DI** marketdata 的任何 use case（catalog Q7-C 禁列）。
8. **`instrument` 的 Prisma 复合键访问器是 `market_code`**（`@@unique([market, code], map: "uk_instrument_market_code")`，已 grep 验真）—— 写成 `market_code_unique` 之类是 TS 编译期就红，但写成 `findFirst({ where: { market, code } })` 不红却走不上唯一索引。
9. **名称读取整段 `try/catch`，任何异常 → 按 `null` 走**。fail-open 是 FR-014 / FR-015 的硬要求；漏了 catch 的表现是**一次已经写进 OSS 的成功投递被判失败**，而投递方没有 `GET` 可以自查，只会重投。
10. **改了 response DTO 必须跑两步**：`nx run server:export-openapi` → `nx affected -t generate`。只跑第二步是拿 stale `openapi.json` regen，且 `git status` 干净、CI 全绿（`api-client:generate` 无 `dependsOn`）。
11. **057 既有 IT 先原样跑拿真实红点，再逐条判该改还是该留** —— 幂等键加了 `symbol` 维度，凡「同投递方 + 同字节」的断言都可能隐含旧语义。**不要凭读代码预判要改哪几条**；改过的断言必须在 commit message 里写明「057 的哪条语义被 058 有意改写」，否则日后会被当成回归。
12. **migration 目录名走 `YYYYMMDD_HHMM_snake_case` 体例**（同 `20260815_2226_create_research_report_table`）。机器闸是 **lefthook 的 `migration-naming-check` job**（`lefthook.yml:94`，inline shell，正则 `^[0-9]{8}_[0-9]{4}_[a-z][a-z0-9_]*$`，权威是 ADR-0035 §1）—— **`scripts/checks/` 下没有同名脚本，别去那里找**。省事的做法是用 wrapper `pnpm db:migrate "<verb obj>"`，它自动前置时间戳。
13. **`capabilities.md` 里去重那条现在有一半是错的** —— 原文（「投递研报」→「四件会让你白跑的事」那节）写「`symbol` / `title` / `reportDate` 都不在键里」，本片起 `symbol` **进键了**。不改就是该文件第四例「想当然写错」（前三例：envsubst 三份拷贝 / 403 不是 405 / 换标题会变新的一份）。🚨 **落点是 `capabilities.md` 不是 `SKILL.md`** —— main #75 已把端点清单整段搬过去、改由 `/capabilities` 运行时下发，skill 退化为薄壳；`make-guest-bundle.sh` 的 Gate C 会拦住任何写回 skill / README 的端点名。

> 第二轮删掉的两条 guardrail：**「latest 查询时点必须在翻 `COMMITTED` 之后」**（判定本身没了）与 **「503 撞码」**（不新增错误码了）。它们是本片原先最难写对的两处 —— 随需求一起消失，不是靠纪律扛住的。

---

## Phase 1: Schema（阻塞其余）🎯

- [X] T001 [Server] **两个唯一键 + migration**（`FR-019`, `FR-025`, `FR-026`, plan `A1`）：`schema.prisma` 的 `ResearchReport` —— 幂等键 `@@unique([uploaderKind, uploaderRef, contentHash], map: "uk_research_report_uploader_content")` **放宽**为 `@@unique([uploaderKind, uploaderRef, symbol, contentHash], map: "uk_research_report_uploader_symbol_content")`（🚨 `map:` 不能省，Guardrail 1）；**新增** `@@unique([uploaderKind, uploaderRef, symbol, version], map: "uk_research_report_version_line")`（它不是给查询用的，是并发取号的机器保证）。**零新列** —— `version` 057 已建，`instrumentName` 刻意不落列（`FR-017`）。同步改 model 上方那段 doc-comment：「`version` 本片恒初值 —— 留列不实装规则」这句**本片作废**，改成新语义并注明 058。**不另建查询索引**（本片已无「按线查最新」的查询）。→ verify: 新建 `research-058.versioning.it.spec.ts`，用 `setupEmptyDb()` 跑 `migrate deploy` 后断言 ① 查 `pg_indexes`：两个新唯一约束存在、旧的 `uk_research_report_uploader_content` 已消失 ② 灌 3 行 057 形态数据（各自 `(uploaderKind, uploaderRef, symbol)` 唯一、`version` 全为 1），断言插入成功且 `version` 保持 1（state_branch 16 / `SC-007`）③ **本次 migration 的 `.sql` 文件里 grep 不到 `UPDATE` 与 `ALTER COLUMN`** —— 「版本号被改写」在结构上不可能，这比跑一遍数据更强 ④ `prisma migrate diff` 非空

## Phase 2: 规则纯函数

- [X] T002 [P] [Server] **`splitSymbol` 纯函数**（`FR-016`, plan `A4`）：`research-report.rules.ts` 加 `splitSymbol(symbol) → { market, code }`（归一后的 `market:code` 拆两段，供 T006 查 `instrument` 用；**不要**在 usecase 里 inline 一个 `split(':')`，rules 层才是本模块业务不变量的落点 per ADR-0043）。无 I/O 无 DI。→ verify: colocate 单测，含**反例** —— 对未归一输入（`00700.HK`）的行为要与 `normalizeSymbol` 的契约对齐、不得静默返回半成品；`market` / `code` 各自的边界（空段、多个 `:`）有断言

## Phase 3: 业务（同一文件，顺序执行）

- [X] T003 [Server] **幂等键放宽接入 + 057 既有 IT 连带处理**（`FR-019`~`FR-022`, plan `A1`, `A6`）：`ingest-research-report.usecase.ts` 的 `findUnique` 从 `uploaderKind_uploaderRef_contentHash` 改为带 `symbol` 的复合键。效果：同标的同字节仍幂等（**057 行为逐字节不变**，含未完成态就地续做）；同字节 + 不同标的各自成行且**复用同一 `objectKey`**（`buildCredential` 由 `contentHash` 单独导出，本片不动）。配额口径不变 —— 两行各自全额计入（`FR-022`，057「蓄意高估」不变）。🚨 **先原样跑 `research-057.{schema,report-ingest}.it.spec.ts` 拿真实红点再改**（Guardrail 11）。→ verify: `research-058` IT 覆盖 state_branch 3 / 4 / 5 / 6 / 15；其中 **5 必须断言两行不同 `id`、`symbol` 各自正确、`objectKey` 逐字节相同**；057 IT 全绿（改过的断言在 commit message 里逐条说明为何是有意改写）

- [X] T004 [Server] **版本号取号 + 并发 + 回显字段**（`FR-001`~`FR-003`, `FR-006`, `FR-008`~`FR-010`, `FR-023`~`FR-027`, plan `A2`, `A5`）：建 PENDING 行时取号 —— `MAX(version) + 1 WHERE (uploaderKind, uploaderRef, symbol)`（🚨 三列一个都不能少、且**不过滤 `status`**，Guardrail 4 / 5），带号 `create`。catch **`P2002`** 后**重查一次幂等键**判别（Guardrail 2）：查到 → 走幂等分支；查不到 → 重算重试，上限 **3 次**；耗尽直接抛（**不新增对外错误码**，落既有 500 兜底，plan A2）。未完成行**占号且续做保留原号**（`FR-024`）。🚨 **NEVER Serializable / `FOR UPDATE`**（Guardrail 3）。同时把 `IngestResearchReportResult` 加上 `title` / `reportDate` / `version` —— 一律取自 `row`（落库值），**不是** `input`（请求参数），幂等命中路径同理（`FR-008` / `FR-010`）；`reportDate` 以 `YYYY-MM-DD` 字符串出，不出 ISO datetime。→ verify: `research-058` IT 覆盖 state_branch 1 / 2 / 6 / 7 / 8 / 9 / 10 / 11 / 17；其中 **7 必须是真并发**（`Promise.all` 两发不同字节同线，不是串行两次），断言两个 `version` 互不相同且集合恰为 `{n+1, n+2}`；**8 用故意失败的 fake storage 制造未完成行**，再投第三份，断言它拿到 `n+2` 而不是复用被占的 `n+1`；**6 是 `FR-011` 的落点** —— 投递方 A 在标的 S 下已有 3 版，B 首投同标的，断言 B 拿到 `version: 1`（版本线不串、也不透露 A 投过几份）；2 用两份日期倒序的文件断言**都被接受且照常 +1**（`FR-006`：日期不参与任何判定）；17 在 T001 灌的既有行之上新投，断言得到 2 而非 1

- [X] T006 [Server] **标的名称 Q7-B 只读 + fail-open**（`FR-012`~`FR-018`, `FR-028`, `FR-029`, plan `A4`）：usecase 内 `this.prisma.instrument.findUnique({ where: { market_code: { market, code } }, select: { name: true } })`（Guardrail 8），**上方必须挂** `// CROSS-CONTEXT-READ: 投递应答回显标的名称需 marketdata.instrument 的 name (只读, Q7-B per ADR-0065 复审)`（Guardrail 7）。`market` / `code` 由 `splitSymbol`（T002）从 **`row.symbol`**（归一后并最终落库的那个）拆出，**不是** `input.symbol`（`FR-016`）。🚨 **新建与幂等命中两条路径都要查** —— `FR-012` 是无条件的，`FR-016` 的括号本身就在推理「幂等命中时该按哪个 symbol 查」，说明名称在该路径上必须有。把查询只接在 create 分支、dedup 分支回 `undefined`，是**现有判据一条都照不到**的漏法（`state_branch` 11 / `FR-010` / US2-AS-3 枚举幂等回显时只列 标题 / 日期 / 版本号，**不含名称**）。整段 `try/catch`，任何异常 → `null` + `logger.warn`（带 symbol + 错误摘要），**投递照常成功**（Guardrail 9）。不按上市状态过滤（`FR-018`）。**不做任何比对、不给「投对了」判断**（`FR-029`）。→ verify: `research-058` IT 覆盖 state_branch 12 / 13 / 14；**12 必须包含一条已退市标的**（`delistDate` 非空）断言照常回显；**14 用注入式故障**（`vi.spyOn(prisma.instrument, 'findUnique')` 抛 —— 该手法仓内已有先例 `research-057.report-ingest.it.spec.ts:329`）断言响应体与 13 的「找不到」**逐字节相同**且 HTTP 仍 201；**另单列一条幂等命中断言**（不在 17 条 `state_branches` 里 —— 它是 FR × 响应路径的交叉盲区）：同投递方 + 同标的 + 同字节重投，断言 `instrumentName` 与首投**逐字节相同**、不是 `undefined`；另跑一次 `pnpm tsx scripts/checks/check-server-moat.ts` 绿，**再故意删掉那行注释确认探针真的红**，加回后复绿（反例，别留恒真闸）

## Phase 4: 契约

- [X] T007 [Server] **响应 DTO 4 → 8 字段 + `@ApiResponse` 描述**（`FR-008`~`FR-011`, plan `A5`）：`research-ingest.response.ts` 在既有 4 个字段（`reportId` / `symbol` / `objectKey` / `deduplicated`）之上加 `title` / `reportDate` / `version` / `instrumentName`(nullable)。🚨 **`instrumentName` 的 `@ApiProperty` 必须显式 `type: 'string'`**（Guardrail 6）。`research.controller.ts` 的 201 `@ApiResponse` description 同步说明新语义（尤其「幂等命中时回显的是库中那条」这句 —— 它是 `FR-010` 对外的唯一说明面）。**不动 503 那条描述** —— 本片不新增错误码。→ verify: `pnpm tsx scripts/checks/check-api-property-nullable.ts` 绿；**故意去掉那个 `type: 'string'` 确认它真的红**，加回后复绿

- [X] T008 [Contract] **OpenAPI 导出 + api-client 重生成**（Constitution §V, plan `A7`）：`nx run server:export-openapi` → `nx affected -t generate`。**两步都要跑，无一行覆盖**（Guardrail 10）。mobile 不消费该端点 ⇒ 本步是纯 types 同步，不应产生任何 mobile 改动。→ verify: `git status` 显示 `apps/server/openapi.json` 的 `ResearchIngestResponse` schema 含 4 个新字段且 `instrumentName` 是 `string | null` 而非 objectmap；`packages/api-client` 产物同步；`apps/mobile` 零改动

## Phase 5: 决策留痕与投递方文档

- [X] T009 [P] [Docs] **ADR-0065 复审段**（plan `Gate 0.4`, `A9`）：追加 `## 复审记录 — 2026-08-16`（体例照 [ADR-0048](../../docs/adr/0048-marketdata-portfolio-cross-layer-dependency.md) 的复审段）：**跨 ctx 面 0 → 1**。必须写明三点 —— ① 原 §1 的两条理由**只有第二条被放宽**：「会拒绝合法的新标的」对**只读回显**完全不适用（查不到只回空、不拒绝），被放宽的只有「引入 Q7-B 依赖」；② 选 Q7-B 而非 Q7-A 的依据 = 同表同字段先例（`alert/evaluate-alerts.usecase.ts:168`，ADR-0052 §3）+ 摊销判据（读频率 = 每次投递一次且被 2 次/分限频卡死、读时计算 = 一次索引单行查找 ⇒ **无摊销对象**，判据同 ADR-0048 复审）；③ 升 A 的 trigger。**原 §1 正文冻结不回改**（仓内惯例：历史决策留痕，只加复审段）。→ verify: ADR governance checklist 过 + `pnpm tsx scripts/checks/check-convention-orphan.ts` 无孤儿；`apps/server/eslint.config.mjs:58` 那句把 research 标为「叶子」的注释同步加一行注明「import 意义上仍是叶子；数据面有一条 Q7-B 只读，见 ADR-0065 复审」

- [X] T010 [Ops] **`capabilities.md` 四处**（`FR-004`, `FR-012`~`FR-018`, `SC-008`, plan `A8`）：① **去重那条的键变了** —— 现在是「你 + **标的** + 文件字节」，原文「`symbol` / `title` / `reportDate` 都不在键里」有一半是错的（Guardrail 13）；② **「`symbol` 投错在本通道内不可逆」整段改写** —— 本片起「用正确 symbol 重投同一份文件」即可补救，这是 US3 的用户可见价值，不写进目录等于没交付；③ 响应体新字段 + 两句规则：**「版本号最大的那份就是最新，而你刚投的这份就是最大的那份」**（`FR-004` 的唯一落点 —— 服务端不回这个信息，规则只活在这份文档里）与「拿到 `deduplicated: true` 时回显的是**库里那条**的值」；④ 🚨 **`instrumentName` 盲区告警** —— 名称对上**只证明**「不是投成了另一家公司」，**不证明市场选对了**：两地上市的 A/H 在目录里同名（`cn:601318` 与 `hk:02318` 都叫「中国平安」，prod 已查证）。不写死这条，回显会制造虚假的安全感，**比没有回显更危险**；⑤ **「投之前：`symbol` 必须有据」那节补一致性指针** —— 该节原话「这条链上一层校验都没有」与新增的名称回显自相矛盾，补几行说明回显是**事后弱信号**、不替代取值纪律，且抓不出市场选错（同 ④）。**错误码表不动**（本片零新错误码），**零新端点路径**。→ verify: `services/guest-proxy/make-guest-bundle.sh` 出包绿（出包自证会 `grep -qE '__FILL_|TODO|FIXME'`，新文案别撞这三个串；Gate C 会拦端点名写回 skill / README）；只读比对 `nginx/futu-shim-guest.conf.template` 的 `location =` 集合与 `capabilities.md` 端点表集合相等（= `install.sh` Gate A 的判据，**本机不跑 `install.sh`**，它是宿主上的部署脚本）；`npx prettier --check` + `npx markdownlint-cli2` 绿
  > 📌 **落点搬迁（2026-08-16，随 main #75 并入）**：本条原先改的是 `services/guest-proxy/openclaw-skill/SKILL.md`（commit `fd7c983d`）。#75 把端点清单整段搬进 `capabilities/capabilities.md` 并改由 `/capabilities` 运行时下发，skill 退化为薄壳 ⇒ 合并时 SKILL.md 整体取 main 版本，四处文案已按新归属重新落地在 `capabilities.md`。**内容照交不误，只是换了文件** —— 故本条保持 `[X]`。

- [X] T011 [Server] **五层判据覆盖自审 + 补漏**（plan `Testing Invariants` EXHAUSTIVE BRANCHING）：对 `research-058.versioning.it.spec.ts` 做**逐条 grep 交叉核对**，不靠通读（per `sdd-authoring.md` 反模式 ④）：17 条 `state_branches` 各自在 IT 里有对应 `it()`；FR(28) / SC(7) / Acceptance Scenario(12) / Edge Case(5) 四层各跑一次零命中扫描。⚠️ **矩阵的值域够不到 AS 层** —— 本片有 **2 条**需求只写在 US2 的 Acceptance Scenario 里（**AS-4** = 名称对不上时投递方当场发现；**AS-5** = 新标的无名称不应被当作错误信号），不在 `state_branches` 中，扫描必须显式覆盖 AS 层（046 实证：写在 AS 里的需求会零覆盖**且零告警**）。
⚠️ **五层判据都是「按需求」切的，切不出「同一条需求 × 两条响应路径」** —— 已知一处：`FR-012`（找得到就回显名称）无条件适用于新建与幂等命中两条路径，但十七条 `state_branches` 里描述幂等回显的第 11 条只枚举了 标题 / 日期 / 版本号。⇒ 扫描时对**每一个回显字段**都问一遍「幂等命中那条路上有没有断言」，别只扫需求编号（该断言已落 T006）。→ verify: 下方覆盖矩阵每行都有 task 号且 IT 里能 grep 到；`nx test server --skip-nx-cache` 全绿
**结果**：五层实测条数与所记一致（17 / 28 / 7 / 12 / 5）；扫出 **3 处真零覆盖**（US1-AS-3 = FR-003 跨标的半 · US2-AS-4 = SC-008 · FR-017）+ **1 处标签缺失**（FR-002）⇒ 补 4 条 `it()`（25 → 29）+ 3 处标题补号，**零业务实现改动**；4 条「故意零覆盖」逐条复核仍成立。详见下方 § 自审。

## Dependencies

```
T001（schema）
  └─→ T003（幂等键接入）─→ T004（取号 + 回显字段）─→ T006（名称）
        │                                              │
T002（纯函数）[P] ──────────────────────────────────────┘
                                                       └─→ T007（DTO）─→ T008（契约）

T009（ADR）[P] ── 与 T001-T008 无文件冲突，随时可做
T010（skill）── 依赖 T004 / T006 / T007 的最终字段名
T011（覆盖自审）── 最后，依赖全部
```

**并行窗口**：`T002` 与 `T001` 可并行（不同文件）；`T009` 全程可并行。其余顺序执行 —— `T003` / `T004` / `T006` 全部改同一个 usecase 文件，强行并行只会制造 merge 冲突。

## 判据覆盖矩阵（`state_branches` 17 条 → task）

| # | state_branch（摘要） | Task |
| --- | --- | --- |
| 1 | 首次投递 → v1 | T004 |
| 2 | 同线投不同文件 → 接受 + 版本 +1；日期不参与判定 | T004 |
| 3 | 同标的同字节重投（已完成）→ 幂等 | T003 |
| 4 | 同标的同字节重投（未完成）→ 续做 | T003 |
| 5 | 同字节 + 不同标的 → 各自成行 + 复用对象 | T003 |
| 6 | 不同投递方 + 同标的同字节 → 各留一行、各自 v1 | T003 · T004 |
| 7 | 并发两份 → 版本号不重复不空洞 | T004 |
| 8 | 对象写入失败停未完成 → 号被占用不重用 | T004 |
| 9 | 续做 → 保留原号 | T004 |
| 10 | 应答回显落库的标题 / 日期 | T004 · T007 |
| 11 | 幂等命中 → 回显库中那条 | T004 |
| 12 | 目录中找得到 → 回显名称；退市照回 | T006 |
| 13 | 目录中找不到 → 无名称、不拒绝 | T006 |
| 14 | 名称查询失败 → 与「找不到」不可区分 | T006 |
| 15 | 多版本 → 各自计入配额 | T003 |
| 16 | 上线前既有记录 → 保持可用、号不被改写 | T001 |
| 17 | 既有线上新投 → 建立在既有之上 | T004 |

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **五层**判据。下表条数与命中数**全部是 T011 实时 grep 的实测值**（2026-08-16），不是抄的历史数字 —— 数法一并写出，便于下一个人原样验算：

| 层 | 实测条数 | 怎么数的 | 058 IT 命中 | 零命中 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `state_branches` | 17 | frontmatter 列表项 | **17** | 无 | 全覆盖 |
| FR | 28 | `**FR-\d{3}**` 去重（FR-005 / FR-007 是删除留下的空号） | 24（+ colocated 2：`rules.spec.ts:89` 的 FR-016、`usecase.spec.ts:498` 的 FR-012） | FR-002 / FR-004 / FR-017 / FR-030 | 1 假阴性补标签 · 1 真补测 · 2 故意 |
| SC | 7 | `**SC-\d{3}**` 去重（SC-002 空号） | 6 | **SC-008** | 真补测 |
| Acceptance Scenario | 12 | US1 4 / US2 5 / US3 3 | 10（其中仅 3 条带显式编号，其余逐条语义核对） | **US1-AS-3** / **US2-AS-4** | 真补测 |
| Edge Case | 5 | `### Edge Cases` 下 bullet | 5 | 无 | 全覆盖 |

五层条数与本节修订前所记**逐个一致**，无 stale 数字需要更正。

### 🚨 先排除的探针假阳性 / 假阴性（不排除就会得出两个相反的错结论）

1. **跨 spec 同号污染（假阳性）**：`research-057.{schema,report-ingest}.it.spec.ts` 与两个 colocated 单测里也有 `FR-0xx` / `SC-0xx` / `state_branch N`，那是 **057 自己的编号**（`state_branch 18` / `20` 超出 058 的 17 条值域即为铁证）。尤其 `usecase.spec.ts:413` 的 `SC-004` = 057 的「五类拒绝码互不相同」，与 058 的 SC-004（元数据回显覆盖率）**同号不同义** ⇒ 一律不计入 058 覆盖。故必须**逐文件**扫，跨文件 union 会把 4 个零命中冲掉 2 个。
2. **只扫编号会漏掉已覆盖项（假阴性）**：FR-002 语义早被 sb2 / sb7 / sb8 三条钉死（+1 单调、并发不重复、含 PENDING 的**全部记录**无空洞），只是 `it()` 标题里没写编号 ⇒ 判定为**标签缺失**，补编号即可，**不新增测试**。
3. **AS 层几乎不带编号**：12 条里只有 3 条被显式标注 ⇒ AS 层不能靠 grep 编号收口，必须逐条读原文对断言。本次两个真缺口都出在这一层。

### 本次补的 4 条 `it()`（全落 `research-058.versioning.it.spec.ts`，**零业务实现改动**；25 → 29 条）

| 补的判据 | 落点 | 断言要害 |
| --- | --- | --- |
| **US1-AS-3 / FR-003（跨标的半）** | T004 describe | 同投递方在标的 A 已 2 版 → 首投标的 B 得 1，且 A 的线不被动 |
| **SC-008 / US2-AS-4** | T006 describe | 归到另一家公司代码下 → 回显名称与研报所述公司不符（当场可发现）；**并把「两地上市 A/H 同名」这个已知盲区钉成机器可见的事实**（`cn:601318` 与 `hk:02318` 回显同名）。两边都逐个钉到字面量而非只写 `a === h` —— 后者在两边都 null 时恒真，会用一条假绿掩盖盲区 |
| **FR-017（实时读那半）** | T006 describe | 目录改名后重投（幂等命中）回显的是**改名后**的值 ⇒ 名称不是投递时点的快照 |
| **FR-017（不落库那半）** | T001 describe | `information_schema.columns` 里含 `name` 的列恰为 `original_filename` ⇒ 表上根本没有可缓存名称的地方 |

另**补 3 处标签**（无新断言）：sb2 / sb8 标题加 `FR-002`；sb12 标题加 `FR-004` 并在 `Object.keys` 全等断言上写明它同时钉住「MUST NOT 回显是否最新」。

### 🚨 最重的一条发现：FR-003 的「跨标的」半在补测前**一条判据都照不到**

`FR-003` = 「不同投递方、**或同一投递方的不同标的**，MUST 各自拥有独立的版本线」，是**一条需求两半**。17 条 `state_branches` 只切出了「不同投递方」那半（sb6），「同一投递方跨标的」那半**只写在 US1-AS-3 里** —— 正是父 agent 预告的第二处「同一需求 × 两条路径」，且比预告的那处更硬。

**反例探针实测**（把取号的 `MAX(version)` WHERE 从 `{ uploaderKind, uploaderRef, symbol }` 删成 `{ uploaderKind, uploaderRef }`，跑全文件）：

- 补测前的 25 条：**全绿** —— 版本线串到别的标的头上，没有任何一条会红。
- 补测后的 29 条：**恰红 1 条**，就是新补的 US1-AS-3，其余 28 条照绿。

⇒ **Guardrail 4 原文「这条有测兜底（state_branch 6 会红）」实测不成立** —— sb6 只兜住 uploader 那两列，`symbol` 那一列此前是裸奔的。该 guardrail 的表述本次不回改（它是写实现时的历史留痕），差异记在这里。

### 交叉检查：每个回显字段 × 幂等命中路径（编号层切不出来的那类）

逐个字段过一遍 dedup 路径，不只扫需求编号：

| 回显字段 | 幂等路径上有无断言 |
| --- | --- |
| `title` / `reportDate` / `version` / `reportId` | sb11 已断言（T004 落） |
| `instrumentName` | 「FR-012 × 幂等命中路径」已断言（T006 落）；本次的 FR-017 改名那条从第二个角度再压同一路径 |
| `symbol` / `objectKey` | **无缺口且不可能有**：`symbol` 自本片起进幂等键 ⇒ 命中即意味归一后相同；`objectKey` 由 `contentHash` 单独导出 ⇒ 同字节必同值。取 `row` 还是取 `input` 在行为上不可区分，无可测差异 |
| `deduplicated` | 它就是路径标记本身，sb3 / sb11 等多处断言 `true` |

⇒ 除已知的 `instrumentName` 外，**无同形态的第二处漏网**。

### FR 覆盖（28 条）

T001 → FR-019/025/026 ｜ T002 → FR-016（拆 symbol 的落点）｜ T003 → FR-019~022 ｜ T004 → FR-001~003, FR-006, FR-008~011, FR-023~027 ｜ T006 → FR-012~018, FR-028/029 ｜ T007 → FR-008~011（DTO 面）｜ **T010 → FR-004**（「版本号最大者即最新」的**正向规则**只活在投递方文档里 —— 服务端零实现，故这是它唯一的落点）+ FR-012~018 的对外说明面 ｜ **FR-030** → 见 § 故意零覆盖登记。

**T011 实测修正**（上一行是写 tasks 时的意图，下面是扫出来的实况）：

- **FR-002 → T004**：意图成立，但三条断言（sb2 / sb7 / sb8）都没写编号 ⇒ T011 补标签，无新断言。
- **FR-003 → T004 只落了一半**：sb6 覆盖「不同投递方」，「同一投递方不同标的」那半零覆盖 ⇒ T011 补 US1-AS-3 那条 `it()`（详见上文「最重的一条发现」）。
- **FR-004 → T010 + T011**：它有正反两句。正向（「版本号最大者即最新」）确实只能落文档；**否定句**（MUST NOT 在应答中回显「本次是否最新」）其实可测且已被 sb12 的 `Object.keys(live).sort()` 全等断言钉住 ⇒ T011 把编号补进标题，让这条否定句有据可查。剩余的「MUST NOT 执行判定查询 / MUST NOT 维护持久状态」不可从外部观测，属真·零覆盖，由 code review 承担。
- **FR-017 → T011**：写 tasks 时归在 T006 的 `FR-012~018` 区间里，实测**全仓无任何断言**（只有 impl 注释提到它）⇒ T011 补两条（实时读 + 不落库），是本次唯一一处「区间式归属掩盖了单条零覆盖」。

### SC 覆盖（7 条）

SC-001 → T004（三次应答可判第几版）｜ SC-003 → T003（投错自助补救，0 人工）｜ SC-004 → T007（必填元数据回显覆盖率 100%）｜ SC-005 → T004（并发无重复无空洞）｜ SC-006 → T003（对象份数恒 1）｜ SC-007 → T001（既有记录号被改写 0 条）｜ **SC-008** → T006（回显能抓「投成另一家公司」）**+ T010**（盲区必须写进投递方文档 —— SC-008 后半句本身就是一条交付要求，不是注解）。

**T011 实测修正** —— **SC-008 是 SC 层唯一的零命中**：T006 落的三条名称测试验的是「找得到 / 找不到 / 查失败」三个分支，**没有一条**站在投递方视角验「回显名称与研报所述公司不符 ⇒ 当场发现」，后半句的盲区也只在 T010 的文档里、无机器断言 ⇒ T011 补 1 条 `it()` 同时覆盖两半（SC-008 → T006 · T010 · **T011**）。

### Acceptance Scenario 覆盖（12 条）

写 tasks 时按 US 整段归属（US1 4 条 → T004 ｜ US2 5 条 → T004 / T006 ｜ US3 3 条 → T003）。**T011 逐条核对后的实况**（整段归属掩盖了 2 条零覆盖）：

| AS | 落点 | 状态 |
| --- | --- | --- |
| US1-AS-1 首投 → 第 1 版 | sb1（T004） | 已覆盖 |
| US1-AS-2 第 2 版，与日期无关 | sb2（T004） | 已覆盖 |
| **US1-AS-3 标的 A 已 2 版 → 标的 B 从 1 起** | — | **零覆盖 ⇒ T011 补** |
| US1-AS-4 两方各自计数、不透露对方 | sb6（T004） | 已覆盖 |
| US2-AS-1 回显落库标题 / 日期 | sb10（T004） | 已覆盖 |
| US2-AS-2 标题被损坏时可发现 | sb10（不给 title 走文件名兜底 ⇒ 落库值 ≠ 意图值） | 已覆盖 |
| US2-AS-3 幂等回显库中那条 | sb11（T004，已显式标号） | 已覆盖 |
| **US2-AS-4 名称对不上 → 当场发现** | — | **零覆盖 ⇒ T011 补（= SC-008）** |
| US2-AS-5 新标的无名称不算错误 | sb13（T006，已显式标号） | 已覆盖 |
| US3-AS-1 换标的重投 → 独立记录 | sb5（T003） | 已覆盖 |
| US3-AS-2 只存一份对象 | sb5（T003） | 已覆盖 |
| US3-AS-3 同标的重投幂等 / 超时重投安全 | sb3 + sb4（T003） | 已覆盖 |

⚠️ **AS 层是本次两个真缺口的唯一所在，且两个都零告警** —— 与 046 实证同形态（写在 AS 里的需求不进 `state_branches` 值域，矩阵扫不到）。US1-AS-3 更进一步说明：**AS 层不仅能藏「整条需求」，还能藏「一条 FR 的另一半」**（FR-003 的跨标的半）。

### Edge Case 覆盖（5 条）

并发重复 → T004 ｜ 未完成占号 → T004 ｜ 既有记录衔接 → T001 ｜ 配额 → T003 ｜ 名称查询挂了 → T006。

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

> **T011 复核结论（2026-08-16）：下列 4 条理由**逐条实证**仍成立，一条都不补 task**（补了就是推翻已定案的取舍）。复核证据附在各行末。新增第 5 行 = FR-004 的不可观测残半。

| 判据 | 为什么零覆盖是对的 |
| --- | --- |
| **FR-030**（本通道保持只写不读，不得演变成查询 / 列举面） | 它是一条**否定式不变量**，本片不新增任何端点 ⇒ 没有可测的正向行为。057 已在两层各落一道机器闸（`limit_except POST` + 服务端零读接口），本片不动那两处 ⇒ 057 的 `verify-guards.sh` 断言即是它的持续护栏。**下次任何人给 `research` 加读端点时，红的是那份脚本，不是本片的 IT。**<br>✅ T011 复核：`research.controller.ts` 全文只有 `@Post('reports')` 一个动词；`nginx/futu-shim-guest.conf.template:281` 的 `limit_except POST { deny all; }` 与 `verify-guards.sh:137`「研报 GET 被拒 → 403」两道闸都还在。 |
| **「迁到 N-1 → 灌数据 → 迁 N」的分步迁移验证** | harness 只有全链 `migrate deploy`（`research-057.schema.it.spec.ts:52` 是 `execFileSync('pnpm exec prisma migrate deploy')`，无 `--to` 之类的分步入口；⚠️ 本行原记 `:44`，T011 实测为 `:52`，已更正）。为 3 行 prod 数据改造 harness 不划算 ⇒ T001 改用两条更强的替代断言：**migration SQL 里 grep 不到 `UPDATE` / `ALTER COLUMN`**（版本号被改写在结构上不可能）+ 灌 057 形态数据验新约束接受。建索引本身对既有数据的冲突性由 **prod 实际形态已核对**兜底（3 行，各自 `(uploaderKind, uploaderRef, symbol)` 下唯一）。 |
| **`perf_budgets`** frontmatter 未设 | 端点被 2 次/分限频卡死，延迟预算无实际意义；057 同样未设。<br>✅ T011 复核：`grep perf_budgets` 在 057 / 058 两份 spec 均零命中，口径一致。 |
| **`[Mobile]` / `[Contract-Smoke]` 层级** | 投递方是隧道内裸 curl 的 CLI agent，不经 `@nvy/api-client` 运行时；T008 只做 types 同步，mobile 零改动。<br>✅ T011 复核：`git diff --stat main...HEAD -- apps/mobile packages/api-client` = `apps/mobile` **零文件**，只有 `packages/api-client` 的 2 个生成文件（+9/−1）。 |
| **`FR-004` 的「MUST NOT 执行判定查询 / MUST NOT 维护持久状态」** | 这两句是**实现内部**的否定式约束，从应答外部不可观测 —— 服务端多跑一次没用的查询、或多存一列状态，对外行为完全一样，没有任何黑盒断言能红。可测的那半（MUST NOT 在应答中回显「是否最新」）已由 sb12 的 `Object.keys` 全等断言承担；余下两句由 code review + 「第二轮删掉这两个字段」的 spec 留痕承担。**不为它造白盒断言** —— 那会把测试钉死在当前实现形态上。 |

## 单 PR

本片全部改动落**同一个 PR**（server + 契约 + ADR + 投递方文案）。nginx / compose / render-env **全不动**，端点集合零变化 ⇒ 通道行为本身不变。但 T010 改的 `capabilities.md` 落在 `services/guest-proxy/**` 下，**会触发第二条部署链**：`deploy-guest-proxy.yml`（push main 且改了该目录即触发，走 `deploy/install.sh` 铺到 `/opt/nvy-guest-proxy` 并 reload nginx）。

⚠️ **唯一的顺序要求**：新文案（T010）描述的是新行为，**server 未上线前它是错的**；而两条链是**同一个 push 并发触发、且顺序恰好是反的** —— `deploy-guest-proxy.yml` 在 push 上直接起跑，`deploy.yml` 要等 `Build & Push Image` 完成才起（`workflow_run`）⇒ **能力目录几乎必然先于 server 上线**。⇒ 合入后盯着 `deploy.yml` 走绿；这段窗口内访客拉到的 `/capabilities` 描述的是尚未上线的行为（会看到旧的 4 字段应答、`symbol` 重投也补救不了）。窗口只有一次构建 + 部署的时长，且投递方是人工触发的低频动作，**可接受，不为它加编排**。

> 这一步**故意不建 task**，登记为**PR 描述里的人工动作**：它发生在 merge 之后，而 task 的完成标记（`[X]`）与代码同 commit 落在 merge 之前 —— 建成 task 只会得到一个永远无法在本 PR 内翻绿的条目。**访客机什么都不用做** —— 他手里那份 skill 是薄壳、不含任何端点清单（main #75），新文案由通道在运行时下发，不存在「通知访客升级」这一步。
