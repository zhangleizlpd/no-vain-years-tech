---
feature_id: 059-anchor-model-import
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-16'
updated_at: '2026-08-17'
---

# Tasks: 059-anchor-model-import（锚的模型导入通道 —— 给 045「模型 import」补上调用方与 API 面）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0062`](../../docs/adr/0062-optionsdesk-bounded-context.md)（期权台 ctx）+ [`ADR-0065`](../../docs/adr/0065-research-report-private-object-storage.md)（guest 通道范式，本片复用其鉴权形状）
**Branch**: `059-anchor-model-import`
**设计源**: `docs/private/plans/2026-08/08-16-anchor-model-import-{master,p1-api-channel}.md`（本机私有，未公开）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan §x）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Contract]` / `[Ops]`。本片**零 mobile** ⇒ 无 `[Mobile]` / `[Contract-Smoke]`（调用方是隧道内的裸 curl / 脚本，不经 `@nvy/api-client`）。`[Ops]` = guest-proxy 通道，走**另一条部署链**（`deploy-guest-proxy.yml`；上线顺序见文末）。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 模型 import patch（改：键集 7→9） | `apps/server/src/optionsdesk/anchor-cascade.ts` |
| 导入校验纯函数（新建） | `apps/server/src/optionsdesk/anchor-import.rules.ts` |
| 导入 use case（新建） | `apps/server/src/optionsdesk/import-anchor-from-model.usecase.ts` |
| guest 端点（**新建**，见文末偏离登记 ①） | `apps/server/src/optionsdesk/optionsdesk-guest.controller.ts` |
| 待审提交 use case（新建） | `apps/server/src/optionsdesk/submit-anchor-from-guest.usecase.ts` |
| DTO / module（改） | `apps/server/src/optionsdesk/{optionsdesk.dto,optionsdesk.module}.ts` + `apps/server/src/openapi.config.ts`（沿用既有 `guest-upload-token` scheme，见偏离 ③） |
| guest 鉴权（改：类注释订正） | `apps/server/src/security/{guest-upload-auth.guard,guest-upload-auth.rules}.ts` |
| 配置（改：token 归属与「为什么只有一把」的决策注释） | `apps/server/src/config/guest-upload.config.ts` |
| 边界注册 | `scripts/checks/check-server-moat.ts`（`MODEL_OWNERSHIP`） |
| DB | `apps/server/prisma/schema.prisma`（`optionsdesk` schema 已存在，**不加 namespace**） |
| IT | `apps/server/test/integration/optionsdesk-059.anchor-import.it.spec.ts` |
| guest 通道 | `services/guest-proxy/{nginx/futu-shim-guest.conf.template,capabilities/capabilities.md,docker-compose.guest.yml,nvy-guest-proxy.env.example,render-env.sh,verify-guards.sh}` |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/optionsdesk/` 下 **MUST NOT** 建任何子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **绝对不要复用 `UpdateAnchorUseCase` 做模型导入** —— 三个雷：① 它没有 `confidenceSource` 字段，翻不了 `'model'`；② 它走 `cascadeOnManualConfidenceChange`（路径 ③，**不冲 `vManual`**），而模型 import 该走 `cascadeOnModelImport`（路径 ①，三处人工位一并回落）；③ 🚨 **最致命**：`update-anchor.usecase.ts:131-134` 对 `confidence_source==='model'` 的锚**拒改 confidence**，⇒ 首日导入把来源写成 `'model'` 后，**次日再导入同一只锚会被自己的门控 400 掉**。这条踩了当天不会红（首日全绿），第二天才炸。
2. **`buildModelImportPatch` 的返回键集封闭是核心契约，不许在调用侧 spread 补字段** —— `{ ...patch, asof, method }` 会把两个模型写的列放到封闭键集**之外**，下一个人加列会照抄那个位置，单点就此失效。要加就加进函数里（T001）。
3. **`CreateAnchorUseCase` 的 `source` 参数默认是 `'manual'`** —— 建锚路径必须**显式传 `'model'`**（`confidenceSource` 与 `source` 是两个独立参数，都要传）。漏传的表现是锚建出来了、痕迹却记成人工，而没有任何断言会红。
4. **noop 短路必须在算差异报告之前** —— 顺序反了会先 `buildImportFallbackReport` 再发现不用写，白算一遍且日志里出现「回落了」的假信号。
5. **`proxy_set_header` 是整组覆盖** —— nginx 新 location 里只要出现一条，server 级那三条对本 location **全部失效**，必须整组抄（`/research-report` 旁边的原文注释就是这个坑）。
6. ~~**两把 token 不能混**~~ → **收口改为一把**（偏离 ③）：三条 mono location 都注入 `GUEST_UPLOAD_TOKEN`。⚠️ 由此**服务端对直写 / 提交无可判之据**，「只有本人可直写」整条判据只剩 nginx `/anchor-import` 的 `$anchor_write_allowed` 那三行 —— 删了 / 改错它，任何访客都能直写锚，而**服务端不会红、日志也不会响**。唯一的回归钉是 `verify-guards.sh` 闸 8d，且 owner / other 两侧都要真跑。
7. **新表不登记 `MODEL_OWNERSHIP` 会被 `moat-unmapped` 硬拒** —— 且报错信息指向探针不指向你的表，第一次撞会以为探针坏了。
8. **`check-optionsdesk-rule-constants.ts` 对整个 `optionsdesk/` 扫小数字面量** —— 新建的 `anchor-import.rules.ts` 里若要写阈值，先确认该值不在从 `anchor.rules.ts` 派生的禁用集内；能用整数表达就别写小数。
9. **`deploy/install.sh` 的 Gate A 机器校验「capabilities 目录声明的端点集 ↔ nginx 实际放行集」相等** —— 只改一边会在部署时才炸。`openclaw-skill/SKILL.md` **不动**（薄壳，能力清单运行时拉）；`guest-bundle/README.md` 按 Gate C **不得**写入新端点。
10. **api-client regen 是两步，漏第一步完全静默** —— `nx run server:export-openapi` → `nx affected -t generate`。`api-client:generate` 无 `dependsOn`，漏了第一步 orval 会拿上一版 json regen，`git status` 干净、lint/typecheck/test/build 全绿、CI 无一处会红（057 T011 实证）。
11. **DTO 校验只加新端点** —— 既有 `CreateAnchorRequest` / `UpdateAnchorRequest` 一个字段都不动（spec 契约：045 与 mobile 零变化）。手滑给既有 DTO 加 `@Min/@Max` 会让 App 侧既有请求开始 400。
12. **`optionsdesk` 的 PG schema 已存在** —— 新表只是往里加一张，**不要**动 `schema.prisma:9` 的 `schemas` 数组（那是 057 建新 ctx 时才要做的事）。

## Phase 1: 纯函数与契约扩展（阻塞其余）🎯

- [X] T001 [P] [Server] **`buildModelImportPatch` 键集 7 → 9**（`FR-002`, `FR-009`, plan §3）：`anchor-cascade.ts` 的 `AnchorModelImportInput` 与 `AnchorModelImportPatch` 各加 `asof: Date` / `method: string`，函数体透传。JSDoc「7 列」改「9 列」，🚨 那段（Guardrail 11 = 三个禁列必须缺席）**一字不动**。→ verify: `anchor-cascade.spec.ts` 三条既有 `not.toContain` 断言（`nextReview` / `lastReviewedOn` / `breachStartedOn`）**全绿不改**；**新增一条 exact-key-set 正向断言** `expect(Object.keys(patch).sort()).toEqual([...9 键].sort())` —— 现有三条只防已知坏键，防不住「有人又加了第 10 个键」，这条把「键集封闭」从散文变成机器检查

- [X] T002 [P] [Server] **`anchor-import.rules.ts` 导入校验纯函数**（`FR-003`, `FR-004`, `FR-005`, plan §7）：新建。`assertImportableTicker`（canonical `market:code`，market ∈ `{us, hk}`；**大小写 / 前缀 / 后缀式一律拒而非归一** —— 导入方是程序，收到 400 就该改自己的输出，静默归一会掩盖上游 bug）+ `assertImportableConfidence`（落在 10 分制量表内）+ 市场白名单常量。无 I/O 无 DI。⚠️ **不要复用 research 的 `normalizeSymbol`**（ESLint boundaries 硬拦，且语义不同：那个是「随手写的都收」，这个是「不规范就拒」）。→ verify: colocate 单测，**每条都配反例**：`AOS`（无冒号 → 拒，注释写明失败形态是「建锚成功但永远无行情」）/ `PEP.US`（后缀式 → 拒）/ `us:pep`（小写 → 拒）/ `cn:600519`（市场越界 → 拒）/ `confidence=999`（越界 → 拒，**必须是可捕获的校验失败而非让它穿透到 PG 变 numeric overflow**）/ `confidence=10` 与 `confidence=0`（边界闭区间 → 放行）。跑 `pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts` 绿（Guardrail 8）

## Phase 2: 鉴权与配置

- [X] T003 [P] [Server] **第二把 token + guard 参数化 + 类注释订正**（`FR-010`, `FR-015`, plan §2）：`guest-upload.config.ts` 加 `ANCHOR_IMPORT_TOKEN`（同 `.min(32).nullable()` 形状），过 `/config-add` 落九位置（`.env.example` / `.env.production` / sops / `docker-compose.tight.yml` / `vitest.config.ts` `test.env` 等）。`GuestUploadAuthGuard` 改为**参数化认哪把 token**（保持 constant-time 比对 / fail-closed / 零 user principal / 裸 401 不泄原因四条不变），**不复制第二份 guard**。🚨 **类注释必须同步改** —— 现写「投递方只有『往收集箱里放东西』这一个权限」，本片后不再准确（注释与实际能力不符比没有注释更危险，plan Gate 0.4 记）。→ verify: `pnpm tsx scripts/checks/check-env-sync.ts` 全 Check 绿；`guest-upload-auth.guard.it.spec.ts` 扩为**两把 token 各三态**（对 / 错 / 缺）—— 走**真 DI 容器** `Test.createTestingModule(...)`，**MUST NOT** `new GuestUploadAuthGuard()`（Testing Invariants 第一条）；断言「缺失」与「不符」响应体**逐字节相同**（`state_branch` 15 / 16）；再断言**拿提交 token 打直写 guard 必须失败**（Guardrail 6 的回归钉）
  > ⚠️ **本 task 的 token 部分已在收口时整体回退（偏离 ③）**：现状 = 一把 token + 普通 `@Injectable()` guard，`ANCHOR_IMPORT_TOKEN` 与交叉反例均已删除。留下来的是「类注释订正」这一半。

## Phase 3: 数据面

- [X] T004 [Server] **`AnchorSubmission` model + migration + moat 登记**（`FR-011`, plan §6）：`optionsdesk` schema 加表（**不动 `schemas` 数组**，Guardrail 12）：`submitter` / `ticker` / `v` / `asof` / `method` / `confidence` / `note?` / `status`（三态 `PENDING` \| `CONSUMED` \| `REJECTED`）/ `createdAt` / `updatedAt`。贫血 row + `@map` snake_case。**索引只建 PK** —— 日均个位数，`status` 上撒 B-tree 是 cargo cult（同 `research_report` migration 自己写的「按真实查询形状建才对」），把这条判据写进 migration 注释。`check-server-moat.ts` 的 `MODEL_OWNERSHIP` 加 `anchorSubmission: 'optionsdesk'`（Guardrail 7）。migration 纯 expand（`CREATE TABLE`）⇒ 单 PR 合规。→ verify: `pnpm db:migrate` 绿；`pnpm tsx scripts/checks/check-server-moat.ts` 绿，**再故意把 `MODEL_OWNERSHIP` 那行注释掉，确认探针真的红**，恢复后复绿（反例，别留恒真闸）；IT 断言表与三态约束真实存在

## Phase 4: 业务与端点

- [X] T005 [Server] **`import-anchor-from-model.usecase.ts`**（`FR-001`, `FR-002`, `FR-006`, `FR-007`, `FR-008`, `FR-009`, `FR-016`, `SC-003`, `SC-004`, plan §1 / §4 / §5）：按 ticker 查自有表 → **无锚**走 `CreateAnchorUseCase({ …, confidenceSource:'model', source:'model' })`（两个参数都要显式传，Guardrail 3），返 `action='create'` 且 `fallbackEntries=[]`；**有锚**则 ① 先判 `v`/`confidence`/`asof`/`method` 与现值**全等 → `action='noop'`，不写不留痕**（Guardrail 4：这一步必须在算差异报告之前）② `buildImportFallbackReport` ③ `buildModelImportPatch` ④ `buildAnchorChange(..., 'model')` ⑤ 单事务 `updateMany({where:{id}})` + affected-count（`count===0` ⇒ 404，并发删除收敛）+ 痕迹写入。V≤0 复用既有 `assertUsableV`。**禁 `FOR UPDATE` / Serializable**（server-impl-playbook）。→ verify: 单测（fake prisma）覆盖 `state_branch` 1 / 2 / 3 / 5 / 6 / 7 / 11 / 18；**其中「连续两日各导入一次，第二日仍成功」必须有独立 `it()`** —— 那是 Guardrail 1 第 ③ 条的回归钉，也是本片最容易漏且后果最重的一条（首日全绿、次日静默停摆）；另断言 `anchor_change.source === 'model'`、以及 noop 分支下 `anchorChange.create` **零调用**

- [X] T006 [Server] **两个端点 + DTO + module 接线**（`FR-001`, `FR-003`, `FR-004`, `FR-005`, `FR-008`, `FR-011`, `FR-012`, `FR-016`, plan §1 / §6 / §7）：`optionsdesk.controller.ts` 加两个 guest 面端点 —— `POST anchors/model-import`（调 T005 的 use case，`@UseGuards` 认 `ANCHOR_IMPORT_TOKEN`）+ `POST anchors/submissions`（**只写待审表，绝不调 use case、绝不碰锚表** —— 这是 `FR-012`「不存在第二条写锚路径」的实现级保证）。DTO 走 T002 的校验（**只加新 DTO，既有两个一字不动**，Guardrail 11）。`source: 'model'` 在 controller 内**写死**，不从请求体取（`FR-008`：防伪造 provenance）。响应含 `action` 与 `fallbackEntries`（`FR-016`）。`@nestjs/swagger` 装饰器齐（`@ApiBearerAuth` 具名 scheme 照 `guest-upload-token` 先例）。→ verify: 新建 `optionsdesk-059.anchor-import.it.spec.ts` 并**先只落 happy path**（`setupIsolatedDb()`）：两个端点各一条 2xx + 一条鉴权失败，证明接线通了；typecheck / lint 绿（新文件首跑加 `--skip-nx-cache`）。**分支穷举归 T007** —— 见下条为何拆开
  > ⚠️ 两处随后被改：`ticker` 移到 query（偏离 ②）；直写口的 `@UseGuards` 改认 `GUEST_UPLOAD_TOKEN`、`@ApiBearerAuth` 沿用 `guest-upload-token`（偏离 ③）。

- [X] T007 [Server] **18 条 `state_branches` 穷举 IT**（`FR-006`, `FR-007`, `FR-013`, `SC-003`, `SC-004`, `SC-007`, plan §1 / §4 / §5）：把 T006 建好的 `optionsdesk-059.anchor-import.it.spec.ts` 补齐到**每条 `state_branch` 对应一个 `it()`**（Testing Invariants 第三条 EXHAUSTIVE BRANCHING，逐条映射见下方覆盖矩阵）。三条硬断言：① 提交端点跑完 `anchor.count()` 与全部锚字段**零变化**（`state_branch` 13）② 同参重放第二次**零数据变化 + 零 `anchor_change` 行**（`SC-003`）③ 带人工位的锚被导入后，响应 `fallbackEntries` 与 `anchor_change.beforeValues` **逐条对得上**（`SC-004` 的「无一遗漏、无一编造」）。收尾跑既有 optionsdesk IT 全套确认仍绿（`SC-007`）。→ verify: 18/18 分支各有 `it()` 且**每条都能真失败**（逐条注掉对应实现确认变红，别留恒真断言）

  > 🔀 **为什么与 T006 拆开**（Constitution §III atomicity）：端点接线约 1h、18 条分支穷举 IT 约 2h+，合成一条明显超「30min–2h 可独立 commit」。057 的 T009 是同等规模的合并先例，但那条**事后确实膨胀到 29 个 `it()`**；本片选择拆开，代价是 T006 单独 commit 时分支未穷举（由 T007 在同一 PR 内补齐，不存在中间态上线）

## Phase 5: 契约

- [X] T008 [Contract] **OpenAPI 导出 + api-client 重生成**（Constitution §V, plan §10）：`nx run server:export-openapi` → `nx affected -t generate`。**两步都要跑**（Guardrail 10）。→ verify: `git status` 显示 `apps/server/openapi.json` 有变更且含两条新路径；`packages/api-client` 产物同步；`pnpm tsx scripts/checks/check-api-property-nullable.ts` 绿

---

> ⬆️ 以上是 server 侧；⬇️ 以下是通道侧。**同一个 PR**，但通道侧走另一条部署链，上线顺序见文末。

## Phase 6: guest 通道

- [X] T009 [Ops] **guest-proxy 两个 location + env 管道 + 能力目录**（`FR-005`, `FR-010`, `FR-013`, `FR-017`, plan §9）：`futu-shim-guest.conf.template` 加 `location = /anchor-import` 与 `= /anchor-submit`。直写口五闸：`limit_except POST { deny all; }` / **授权闸**（本片新增，`FR-010`）—— 🚨 **判据必须 env 化，不得硬编码访客名**：`$guest_name` 的取值在既有 `map` 块里全部来自 envsubst 变量（`"${GUEST1_NAME}"` / `"${GUEST2_NAME}"`），硬写一个名字既脱离配置管道、又把「谁是本人」冻进仓内。⇒ 新增 `map $guest_name $anchor_write_allowed { default 0; "${ANCHOR_OWNER_NAME}" 1; }` + location 内 `if ($anchor_write_allowed = 0) { return 403; }`。**用 `map` 而非 `if` 链**是照 template 顶部那句原话「用 map 而不是 if 链，是为了加第二个访客时只加一行，且日志里能记名字」/ `$arg_ticker !~ "^(us|hk):"` → 400（注释写明「**与 server DTO 同源，改一处必改另一处**」，`FR-005`）/ `client_max_body_size 4k` / **新开** `limit_req_zone guest_anchor rate=6r/m`。提交口同形但去掉授权闸、限频 `2r/m`（与研报同档）、独立 zone（`FR-017`：一方触顶不影响另一方）。**整组三条 `proxy_set_header`**，两个 location 各注入**不同的** token（Guardrail 5 + 6）。配套 —— **两个新变量都要走完整管道，漏一个就在渲染时静默留下 `${...}` 字面量**：`docker-compose.guest.yml` 的 `NGINX_ENVSUBST_FILTER` 加 `ANCHOR_IMPORT_TOKEN` **与 `ANCHOR_OWNER_NAME`** 两个键、`nvy-guest-proxy.env.example` 各加一行 `__FILL_...__` 占位、`render-env.sh` 照 `FUTU_SHIM_TOKEN` 那套加 `: "${ANCHOR_IMPORT_TOKEN:?}"` 与 `: "${ANCHOR_OWNER_NAME:?}"` + 替换。⚠️ token 那个照既有纪律断言长度 ≥ 32；**`ANCHOR_OWNER_NAME` 只需断言非空** —— 它不是秘密（是 `map` 的 key，同 `GUESTn_NAME`），但空值会让授权闸退化成「谁都不许写」，那是 fail-closed 方向、可接受但要能一眼看出。`capabilities/capabilities.md` 加两个端点条目 + 字段说明 + 错误码表 + **「导入须早于当日采集轮」这条运维约束**（plan §8：它是运维事实不是代码约束，故只写在调用说明里）。→ verify: `nginx -t` 过；`render-env.sh` dry-run 产物无 `__FILL_` 与 `${` 残留；**`deploy/install.sh` 的 Gate A 绿**（目录声明的端点集 ↔ nginx 放行集相等，Guardrail 9）
  > ⚠️ **收口后 `ANCHOR_IMPORT_TOKEN` 那一路全部撤除（偏离 ③）**：两个 location 注入**同一把** `GUEST_UPLOAD_TOKEN`；本 task 剩下的新变量只有 `ANCHOR_OWNER_NAME` 一个 —— 它同时也成了「只有本人可直写」的**唯一**判据。

- [X] T010 [Ops] **`verify-guards.sh` 反例断言**（`FR-010`, `FR-013`, `SC-005`）：新增断言，**每条配反例**：无 token 打两个口 → 401 / **他人 token 打 `/anchor-import` → 403**（授权分流的核心护栏）/ 他人 token 打 `/anchor-submit` → 2xx / `GET /anchor-import` → 403（`limit_except` 里干活的是 `deny`，返 403 不是 405 —— 057 真跑证伪过 405）/ `ticker=cn:600519` → 400 / `ticker=AOS` → 400 / 超限频 → 429。⚠️ `check()` 用 `%-46s` 对齐，标签别超 46 字符。→ verify: 本机 `./verify-guards.sh` 全绿；prod 上 `--from-guest` 全绿；**先把新断言跑红再实现**

- [X] T011 [Ops] **端到端实证**（`SC-001` ~ `SC-007`, `FR-014`）：从调用侧真跑一轮 —— ① 一条 curl 完成一只标的的导入（`SC-001`）② 同参重放 → `action='noop'`、库内零变化（`SC-003`）③ 带人工 L 层的锚导入有变化的估值 → 返回 `fallbackEntries` 逐条列出被冲项（`SC-004`）④ 他人 token 打直写口 403、打提交口落待审且锚表零变化（`SC-005`）⑤ 坏 ticker / 越界 confidence / cn 市场 各自 400 且原因可区分（`SC-006`）⑥ 既有 App 锚管理能力回归（`SC-007`）⑦ 🚨 **`FR-014` / `SC-002` 的真实证**：在当日锚驱动采集轮**开始之前**导入一只全新 us 标的 → 当轮 `sync_run` 的 `us_equity_bar` / `option_contract` 工作集**含它** → 采集后 `anchor.last_close` 非空。→ verify: 逐条记录实测值（`action` / 耗时 / 库内行数 / 工作集命中）填回本 task

  **实测记录**（2026-08-17，prod 真流量，隧道内两个访客身份各打各的口；标的 = 一次性锚 `us:KO`，⑦ 验完即删）：

  | # | 判据 | 实测 |
  | --- | --- | --- |
  | ① | 一次调用完成导入（`SC-001`） | `action='create'` / **83 ms** / `anchor` 12→13 行 / `anchor_change` +1（`source='model'`、`before_values={}`） |
  | ② | 同参重放（`SC-003`） | `action='noop'` / **23 ms** / `anchor_change` 停在 13 行、`updated_at` 不变 ⇒ **库内零变化** |
  | ③ | 差异报告（`SC-004`） | 两个人工位在位（`l_level_manual='L2'` + `position_cap_manual=0.0200`）时导入 V 50→52 → `action='update'` / **31 ms** / `fallbackEntries` **2 条**：`lLevel L2→L3`、`positionCap 0.02→0.02`（**人工值等于派生值仍照列**，正是 schema 那条不变式）。与痕迹行的 `before_values`（`{v:50, lLevelManual:L2, lLevelEffective:L2, positionCapManual:0.02}`）**逐条对得上**。`next_review` / `last_reviewed_on` 未被触碰（`FR-035`） |
  | ④ | 授权分流两侧（`SC-005`） | 他人打直写口 **403**（同日早前一轮实测）；他人打提交口 **201**，落 `anchor_submission` 首行（`submitter` 取自 `X-Guest`、`status='PENDING'`），而**锚表整表 `md5` 前后一致**（13 行不变、`anchor_change` 不增） |
  | ⑤ | 拒绝原因可区分（`SC-006`） | `ticker=us:ko` → 400 `INVALID_IMPORT_TICKER`；`confidence=11` → 400 `INVALID_IMPORT_CONFIDENCE`（两者均为 app 的 ProblemDetail，带真 `traceId`）；`ticker=cn:600519` → 400 **通道层裸 JSON、够不到 app** ⇒ 三者按「错误码 + 谁返的」双重可分 |
  | ⑥ | App 锚管理回归（`SC-007`） | 同一只锚上在 App 侧改 L 层 / 改单票上限 / 撤销人工位全部正常，痕迹逐行落库且 `source='manual'`；导入后 App 侧读到 V=52 / L3 / 三处人工位已清 |
  | ⑦ | **`FR-014` / `SC-002`** | **纳入工作集已证**（手动触发 `marketdata-trigger` CLI，走与 cron 同一条 worker 路径）：建锚前基线 = 该标的 `daily_bar` **0** 行 / `option_contract` **0** 行 / `need_sync='f'`，上一轮两维度均 `scanned=12 / ok=12`；建锚后当轮 → `us_equity_bar` **`scanned=13 / ok=13`**（23 s）、`option_contract` **`scanned=13 / ok=13`**（4 min 32 s），该标的 `daily_bar` 得 **5** 行、`option_contract` 得 **1014** 行 / **17** 个到期日，`need_sync` **`f`→`t`**。`anchor.last_close` **已落**：`87.7100` / `last_close_date=2026-08-14`，与 `daily_bar` 该日收盘**逐字相同** ⇒ 投影无失真。⚠️ 但它**不由采集轮写**，落的时点与接力关系见下方注 |

  ⚠️ **不要拿既有锚跑这组实证**：导入会把 `confidence_source` 由 `manual` 翻成 `model`，而 `update-anchor.usecase.ts` 对 `model` 来源**拒改 confidence**、且 `UpdateAnchorPatch` 根本没有 `confidenceSource` 字段（能指定它的只有建锚，而同 ticker 建锚蓄意 409）⇒ **App 侧没有回头路**，只能直连 DB 改列。用一次性新锚跑，顺带把 ⑦ 要的「全新 us 标的」一并满足。

  🚨 **⑦ 的判据横跨两个调度器，本 task 行的措辞把它缩写成一句了** —— 「采集后 `anchor.last_close` 非空」读起来像一轮的事，实际是接力：① marketdata 的 `us_equity_bar` 维度（BullMQ job，`0 0 6 * * *`，**可用 `marketdata-trigger` CLI 手动触发**，且该 CLI 刻意绕开交易日闸 =「运维显式意图」）把 bar 采进 `daily_bar`；② optionsdesk 侧的 `SyncAnchorQuoteScheduler`（**进程内 `@Cron`，无 CLI、无端点、无法手动触发**）才把 `daily_bar` 投影成 `anchor.last_close`。⇒ 手动触发只能证到 ①。⚠️ **实证当时 prod 跑的是 `v0.28.0`，那个镜像里投影仍是固定 `0 30 6 * * *`** ⇒ `last_close` 要等次日 06:30 才填；`main` 上已改成每小时 `:30`（`0 30 * * * *`，理由 = 上游按市场分裂，固定时点排不到两个市场之后），随下一次发版上线后这一格会在**一小时内**自然补上。

  ✅ **该预测当日即被实测兑现**：`server-v0.28.1`（含该改动）于 **13:56** 起容器，锚建于 13:17；投影落在**上线后第一个 `:30` tick = 14:30**（`anchor.updated_at = 2026-08-17T06:30:00.234Z`）—— 距上线 34 分钟。⇒ 同一只锚上，`0 30 6 * * *` 会拖到次日、每小时 `:30` 只拖 34 分钟，两种时点策略的差别**在这条实证里直接可见**。**且 ② 属 045 的投影职责，与 059 的导入通道无因果** —— `FR-014` / `SC-002` 的实质（当日新建的锚被**当轮**采集纳入工作集）由 ① 独立证死。

  📌 **顺带兑现了一条挂账的运维核对**：`futu-shim-guest.conf.template` 的 `guest_option_chain` 池注释要求「上线后第一个交易日必须核对那轮 `sync_run` 的墙钟」（该处估算 12–17 分钟、担心顶出 15 分钟的门）。实测：12 只锚那轮 **3 min 38 s**（`id=555`）、13 只锚那轮 **4 min 32 s**（`id=562`）—— 比估算乐观约 3 倍，离门很远。⚠️ 但两轮都**没有访客并发打链**，这个数不能当作「访客满速时也安全」的证据。

## Dependencies

```
T001 ─┐
      ├─→ T005 ─→ T006 ─→ T007 ─→ T008
T002 ─┤          ↑
T003 ─┤          │
T004 ─┘──────────┘

—— 合入后等 mono deploy 完成 ——

T009 ─→ T010 ─→ T011
```

- **T001 / T002 / T003 / T004 可全部并行**（不同文件、无相互依赖）。
- **T005 依赖 T001**（键集要先有 `asof` / `method` 才能传）。
- **T006 依赖 T002（DTO 校验）+ T003（guard 参数化）+ T004（待审表）+ T005（use case）**。
- **T007 依赖 T006**（在 T006 建好的 IT 文件上补齐分支）—— 两者同 PR，T006 单独 commit 时分支未穷举属**中间态、不上线**。
- **T009 的 nginx 指向 server 端点路径，由 T006 确定** —— 两者同 PR，但 guest-proxy 部署链会先跑（见文末），故上线后存在一段 502 / 404 自愈窗口。

## 判据覆盖矩阵（`state_branches` 18 条 → task）

| # | 分支 | task |
| --- | --- | --- |
| 1 | 无锚 → 建锚 + 模型来源身份 | T005 · T007 |
| 2 | 有锚且估值有变 → 更新不报冲突 | T005 · T007 |
| 3 | 值全等 → 零写入零痕迹 | T005 · T007（硬断言 ②）|
| 4 | **连续两日各导入 → 第二日仍成功** | T005（独立 `it()`）· T007 |
| 5 | 有人工调整 → 回落且逐条回报 | T005 · T007（硬断言 ③）|
| 6 | 无人工调整 → 清单为空不编造 | T005 · T007 |
| 7 | 不重置复审日期 / 不解除逾期 | T001（键集缺席即保证）· T005 · T007 |
| 8 | 标的写法非规范 → 拒 | T002（纯函数）· T006（DTO 接线）· T007 |
| 9 | 市场不在白名单 → 拒 | T002 · T006 · T007 · T009（通道那层）|
| 10 | 置信度越界 → 拒 | T002 · T006 · T007 |
| 11 | 估值零或负 → 拒 | T005 · T007 |
| 12 | 他人直接写锚 → 判据**单层**落在通道层（偏离 ③）| T009（通道层，唯一判据）· T010（唯一回归钉，owner / other 两侧都要跑）· T007（服务层「不可判」的登记断言）|
| 13 | 他人提交 → 只落待审，锚表零变化 | T004 · T006（实现）· T007（硬断言 ①）|
| 14 | 待审被采纳 → 同一路径落锚 | T006（提交端点不调 use case = 实现级保证）|
| 15 | 凭证缺失 → 拒不泄区别 | T003 |
| 16 | 凭证不符 → 同上 | T003 |
| 17 | 读 / 删 / 列举 → 拒，通道无读取面 | T009 · T010 |
| 18 | 并发删除 → 以不存在收敛，不写孤儿痕迹 | T005（affected-count）· T007 |

**18/18 全覆盖，零遗漏。**

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **5 层**判据：`state_branches`(18) · FR(17) · SC(7) · Acceptance Scenario(13) · Edge Case(8)。**五层全扫**，无差集。

### FR 覆盖（17 条）

| FR | task | FR | task |
| --- | --- | --- | --- |
| FR-001 | T005 · T006 · T007 | FR-010 | T003 · T009 · T010 |
| FR-002 | T001 · T005 | FR-011 | T004 · T006 |
| FR-003 | T002 · T006 · T007 | FR-012 | T006 |
| FR-004 | T002 · T006 · T007 | FR-013 | T006 · T007 · T009 · T010 |
| FR-005 | T002 · T006 · T007 · T009 | FR-014 | **T011**（唯一载体） |
| FR-006 | T005 · T007 | FR-015 | T003 |
| FR-007 | T005 · T007 | FR-016 | T005 · T006 |
| FR-008 | T005 · T006 | FR-017 | T009 |
| FR-009 | T001 · T005 | | |

**17/17**。

### SC 覆盖（7 条）

| SC | task | 备注 |
| --- | --- | --- |
| SC-001 | T011 | 一次调用完成 |
| SC-002 | **T011** | 当轮纳入工作集 —— **唯一验证手段是真跑一轮采集**，无法用 IT 替代 |
| SC-003 | T005 · **T007（硬断言 ②）** · T011 | noop —— 已在 T005 / T007 的 task 行补 `SC-003` 锚，不再只靠本矩阵声明 |
| SC-004 | T005 · **T007（硬断言 ③）** · T011 | 差异报告 100% 列出，且与 `anchor_change.beforeValues` 逐条对得上 |
| SC-005 | T010 · T011 | 他人无法使锚表变化 |
| SC-006 | T002 · T006 · T007 · T011 | 拒绝原因可区分 |
| SC-007 | T007 · T011 | 既有能力零变化（T007 收尾跑既有 optionsdesk IT 全套）|

**7/7**。⚠️ 特别记：`SC-002` 与 `FR-014` 的载体**只有 T011**（真跑一轮采集）——这类「只有口号、没有 IT 载体」的条目正是 `sdd-authoring.md` 点名的系统性盲区，故在此显式标注，**T011 不得被当作可选收尾砍掉**。

### Acceptance Scenario 覆盖（13 条）

- **US1（5 条）** → T005 · T007（AS1–4）· T011（AS5 = 当轮进工作集）
- **US2（4 条）** → T005 · T007（AS1 noop / AS2 差异报告 / AS3 空清单 / AS4 不解除逾期）
- **US3（4 条）** → T003 · T006 · T007 · T010（AS1 拒直写 / AS2 落收件箱 / AS3 同一路径 / AS4 无读取面）

**13/13**。

### Edge Case 覆盖（8 条）

写法不规范 → T002 · T007 ｜ 置信度越界 → T002 · T007 ｜ 估值零负 → T005 · T007 ｜ 市场越界 → T002 · T007 · T009 ｜ 当日多次导入 → T005 · T007 ｜ 并发删除 → T005 · T007 ｜ 凭证缺失 vs 不符 → T003 ｜ 一次导入大量新标的 → T005 · T006（`action` 可见即满足，**蓄意不设上限**）

**8/8**。

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

以下三项**故意不实现**，不是遗漏，下次 analyze 不要当缺口补 task：

1. **待审收件箱的审阅面**（列表端点 / 审批端点 / 转正 CLI / App 页面）—— spec Assumptions 明写审阅方式是数据库直连，采纳动作 = 本人用自己的凭证重放一次。真到每天十几条要审时再按真实用量决定形状。
2. **新建锚数上限** —— spec Clarifications 已定「不设」，`FR-016` 明写 `MUST NOT` 设上限；可见性由响应里的 `action` 承担。
3. **估值偏离护栏** —— spec Clarifications 已定「不设」，理由是数由本人流程算出、且大幅重估恰是最该记录的信号；痕迹表已完整记录旧值 → 新值。

另有一项**本片不做但已登记为 backlog**：既有 JWT 端点（`POST /anchors` / `PATCH /anchors/:id`）的 ticker 格式与 confidence 值域校验缺失（`FR-003` 注、plan §7）。本片只补新端点，避免范围蔓延与既有 App 请求行为变化。

## 单 PR 与上线顺序

server 侧（T001–T008）与通道侧（T009–T011）**同一个 PR**，但走两条部署链：

1. PR 合入 → `deploy-guest-proxy.yml`（`paths: services/guest-proxy/**`，**无人工闸，合入即部署**）先跑
2. mono app 部署链后跑

⇒ 存在一段窗口：nginx 已放行新 location 但 server 端点尚未上线 ⇒ 打新端点会 404 / 502。**这是已知且自愈的**（同 057 的先例），不需要额外协调；但 T011 的端到端实证**必须等两条链都完成**再跑。

### 🚨 合入前必须先做的一件事（impl 期实测发现，不是自愈的）

**先在 guest 机上把新 env 备齐，再合 PR** —— 只剩一步（偏离 ③ 把 mono 侧那步消掉了：`GUEST_UPLOAD_TOKEN` 057 就已在 SOPS 里，本片不新增任何 secret）：

1. 77 上重跑 `render-env.sh`（`FORCE=1`，带上 `ANCHOR_OWNER_NAME=<本人的访客名>`），把它渲进 `/etc/nvy-guest-proxy.env`

漏了会怎样：`deploy/install.sh` 的预校验 `nginx -t` **照样过**（未设变量 envsubst 不替换，留下的字面量在语法上合法），但自检 (d) 的残留扫描会看见 `${ANCHOR_OWNER_NAME}` ⇒ **exit 5 自检失败**，配置回滚到上一版。不是静默坏，但会让一次本可以顺的部署红一轮。

⚠️ 而 `ANCHOR_OWNER_NAME` 这个值本身现在**是「只有本人可直写锚」唯一的判据**（偏离 ③）—— 渲错成一个不存在的访客名不会红在部署上，只会让直写口恒 403；渲成某个别人的名字则是反向的静默事故。`render-env.sh` 的自证 ④ 断言它必须等于某个 `GUESTn_NAME`，但断不出「是不是**你**那个」。

⚠️ 那条 envsubst 过滤正则**仓里有三份拷贝**（`docker-compose.guest.yml` / `install.sh` 的 `ENVSUBST_FILTER` / `install.sh` 自检 (d) 的残留扫描），本片三处已同步 —— 057 当年只改了 compose 那份，deploy 当场红在预校验上。

## 本 PR 夹带的两处工具面修复（不是 059 的 task，但必须记）

按 git-workflow「改动溢出本 feature 要先确认是否拆独立改动」，这几处**刻意不拆** —— 它们各自是本 PR 能不能走完流程的前置，拆出去意味着 059 得等它们先合：

0. **CI 失败可见性**（`vitest.config.ts` 的 `reporters` + `project.json` 去掉 `--reporter=default`）。vitest 的 `github-actions` reporter **只在没有显式配置 reporters 时才自动启用**（[官方文档](https://vitest.dev/guide/reporters)），而本仓 `project.json` 写死 `vitest run --reporter=default`，正好把它关掉了。后果不是「少点标注」而是**失败取不回来**：nx 在 CI 上不转发完整 task 输出、且 `--output-style` 在 CI 被直接忽略（[nrwl/nx#15570](https://github.com/nrwl/nx/issues/15570)，`if (isCI()) return false`，closed as not planned）⇒ job log 里既无 vitest 汇总也无失败块。2026-08-17 实撞：server-test 连红三次、失败文本从 CI 侧完全取不到。annotations 是绕开 nx 输出层的唯一通路。已实测：本地零 workflow 命令噪声，`GITHUB_ACTIONS=true` 下真失败会发出带文件/行号的 `::error`。

1. **`eslint.config.mjs` 补 playwright 输出目录的 ignore**。PR 模板要求的物理验证命令把 `lint` 与 `runtime-smoke` 放进同一个 nx invocation，playwright 边跑边增删 `playwright-test-results`，eslint 的目录遍历撞上去 ⇒ `ENOENT scandir`，**eslint 进程自己崩**（不是报 lint 错）。表现成随机红、单跑又绿。⇒ 不修就没法诚实地勾第一个 checkbox。
2. **IT 日志降级**（`vitest.config.ts` 加 `LOG_LEVEL=error` + `test/_support/quiet-logger.ts` + 抽 `test/_support/run-migrate.ts`）。本地一轮 373KB → **115KB（−69%）**，430 files / 4514 passed 逐项不变。
   🚨 **仓里两套 logger，只有一套听 `LOG_LEVEL`** —— 这是第一版只砍掉一半的原因，记下来免得下次再踩：pino 归 `LoggerModule` 的 `pinoHttp.level`（听 env），而业务代码里 `new Logger(Xxx.name)` 归 Nest 静态 logLevels（不听）。生产靠 `main.ts` 的 `useLogger` 合一，**测试里不合一**（`narrow-boot` 蓄意不注册 `LoggerModule`、无人调 `useLogger`）⇒ 必须两边各压一次。判据表在 `quiet-logger.ts` 顶部。起因是 `server-test` 在 CI 上连续两次红、本地两次全绿，而**失败文本从 CI 侧取不到** —— GitHub 的 job log 端点只回有限窗口（对照过一次成功的跑，同样取不到 ⇒ 端点固有行为）。⇒ 不降噪就没有诊断窗口。
   ⚠️ 残留的 134 行 migrate 树 + 30 行 pino 全在 `runtime-smoke` 段，源头 `scripts/ci/server-boot-smoke.ts` 在 vitest 之外、`test.env` 管不到。**刻意不动**：那个脚本的意义就是「真 app 能不能起来」，日志即证据。要压它是另一笔取舍。

3. **CI 连红四次的真因与两笔连带治理**（2026-08-17）。真因不在 059 的业务代码：本 feature 的 IT 漏了 `REDIS_URL` 占位，而 `redis.config.ts` 的 `url` 是必填 —— **stub 掉 `REDIS_CLIENT` 并不能阻止 `redisConfig` 被实例化** ⇒ DI 期 ZodError ⇒ 整文件 33 个 test 全 skipped。本地四轮全绿是因为 dev shell 里有真 `REDIS_URL` 把缺失盖住了。连带做了两件：
   - **7 处 `process.env.REDIS_URL = 'redis://127.0.0.1:6399'` 收敛成 0** —— 提到 `vitest.config.ts` 的 `test.env`。原先每个 spec 靠作者记得抄一行，第 8 个人忘写就再炸一次；那不是纪律问题，是缺省值缺席。它同时补上了 `config-env-sync` 位置 #4 本就该有的 boot-required 登记。
   - **`scripts/local-verify-as-ci.sh`** —— 按 `.env.example` 的键集把本机泄漏的 server env 全 unset 再跑，判据写进 [`local-verification.md`](../../docs/conventions/local-verification.md) §2/§3。「本地 env 泄漏 → 本地绿 CI 红」这个类会复发，而这次烧了四轮 CI 才定位。

## impl 期偏离登记（与 plan / tasks 原文不一致的三处）

1. **guest 端点另起 `optionsdesk-guest.controller.ts`，没有加进 `optionsdesk.controller.ts`**（tasks 原文写的是后者）。理由：那个 controller 是**类级** `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`，类级 guard 对每条路由生效且**方法上摘不掉**。要塞进去只能把 13 个既有端点的鉴权逐个下放到方法级 —— 为了少建一个文件而动整个 App 的鉴权面，风险与收益不成比例。体例同 `research.controller.ts`（同为 guest 面、同为只写）。
2. **`ticker` 走 query string，其余四个字段走 JSON body**（原设计是整个请求体 JSON）。理由：nginx 的 `$arg_*` **只读得到 query**，T009 那道通道层市场闸（`$arg_ticker !~ "^(us|hk):"`）只有在 ticker 位于 query 时才成立；放进 body 的话 nginx 看不见它，闸退化成摆设。与 057 研报把三项必填元数据放 query 是同一个理由。⚠️ 这处改动是在 T009 写 nginx 时才发现的 —— T006/T008 已经按 body 形状落过一版，随 T009 一并改回并重跑 export-openapi + regen。

3. 🚨 **通道 token 由两把回退成一把**（2026-08-17，user 决策；plan §2 记全过程与驳回理由）。T003 已按「第二把 `ANCHOR_IMPORT_TOKEN` + guard 参数化」实装并测绿，收口时整体回退：两把同出一个 SOPS blob、渲进 guest 机同一个 env 文件、落进同一份 nginx conf ⇒ **共命，不构成独立的第二层**；而它唯一防的「绕过代理直连 loopback」位置，因 guest compose 是 `network_mode: host`，恰恰就是那台 guest 机本机。
   **随之改动**：`ANCHOR_IMPORT_TOKEN` 从九位置全部撤除（含 envsubst 三份正则）· guard 回到普通 `@Injectable()`（mixin 工厂删）· `openapi.config.ts` 撤掉第三个 bearer scheme 并重跑 export-openapi + regen · `render-env.sh` 自证 ③ 的「两把互不相同」判据删除 · guard IT 的交叉反例删除（一把之后它在服务端**不可能成立**，留着是假保证）。
   **代价与其唯一护栏**：spec `state_branches` ⑫ 由「两层各拒一次」改为「判据落在通道层，MUST NOT 依赖服务层再拒一次」；server IT 的 ⑫ 改成钉住「服务层不可判」这件事本身（同一 bearer 打两口都 201），谁把 token 重新拆开它就红；**唯一验「只有本人可直写」的地方是 `verify-guards.sh` 闸 8d**，owner / other 两侧都必须真跑。要加回第二把的门槛（「先证明它与第一把不共命」）单点记在 `guest-upload.config.ts` 顶部。
   **配套入库**：`services/guest-proxy/verify-guards.local-harness.sh` —— 唯一的护栏不能只在「有人想起来手搭环境」时才跑得动。开发机上真模板 + 桩上游（桩 app 逐字节校验 bearer）跑掉闸 8 两种角色，并带 `MUTATE=1|2` 两个互补变异自证它不是恒真探针。它同时把「envsubst 正则三份拷贝键集一致」做成了起手前置 —— 那正是 057 与 059 各漏改过一次的地方。

另有一处**实现细节**在 spec / plan 里没写死、由实现选定并已落成断言：**`noop` 判据把 `confidence_source` 一并算进去**（四个模型事实全等 **且**来源已是 `model` 才算 noop）。理由：手工锚的数字恰好与模型一致时，这次导入**确实改了东西** —— 它把 provenance 翻成 `model`（FR-002 的 MUST）。判成 noop 会让那只锚继续显示「人工来源、可编辑」，与实际写入路径不符。
