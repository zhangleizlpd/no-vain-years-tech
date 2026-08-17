---
feature_id: 059-anchor-model-import
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-16'
updated_at: '2026-08-16'
adr_refs: ['0032', '0035', '0041', '0043', '0046', '0062', '0065']
context7_verified: []
---

# Implementation Plan: 锚的模型导入通道

## Summary *(mandatory)*

给 045 早已设计好但**零生产调用方**的「模型 import」路径（`anchor-cascade.ts` 三个纯函数）补上调用方与 API 面：新增一条 by-ticker 的导入端点（无锚则建、有锚则按模型语义刷新）+ 一条他人提交待审端点，经既有 guest-proxy 通道暴露，授权在通道层按访客身份分流。**零新依赖、零新 vendor、零跨 ctx 面**。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

> 显式 no-op 声明。本片全部落在既有栈内：NestJS controller + DTO（`class-validator` 已装）、Prisma 新表、既有 `GuestUploadAuthGuard`、既有 `anchor-cascade.ts` 纯函数、guest-proxy nginx 配置。
>
> 📌 **初版方案曾要引 `unpdf`（PDF 解析）并改云侧 RAM 策略**，随「估值流程本就产出锚字段、不需要从 PDF 反推」这一输入而整体作废（见 `docs/private/plans/2026-08/08-16-anchor-model-import-p2-pdf-backfill.md` 的「已否决路径」表）。记在这里是为了让后续 reviewer 知道**零依赖是设计结果而非疏漏**。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

逐条核：

| 原则 | 判定 |
|---|---|
| **I. SDD**（禁跳步） | specify → clarify（4 问已答，`status: clarified`）→ 本 plan。**无 UI ⇒ 无 Mockup 步**（Constitution §I 明示后端 use case 无此步） |
| **II. Test-First TDD** | 每 task 红→绿→typecheck/lint→`[X]`→stage→commit。新端点的 state_branch 覆盖见 Gate 0.1 |
| **III. Atomic Task 30min-2h** | tasks 阶段按「纯函数扩展 / use case / 表+migration / 端点+DTO / IT / 通道配置」切，每条独立可 commit |
| **IV. Module Boundary** | **本片零跨 ctx**：新 use case 与新表全在 `optionsdesk/`，只读写自有表。扁平平铺、贫血 row、无 repository、无 Domain Class。`GuestUploadAuthGuard` 落 `security/`（平台层，per ADR-0041），optionsdesk 单向 import —— 与 research 挂它的方式逐字同构 |
| **V. 类型同步链** | 新端点 → swagger 装饰器 → `nx run server:export-openapi` → `packages/api-client` regen。**本片无 mobile 消费面**（零 UI），故无 mobile 两层验证；单 PR 内完成 server + regen |

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 两个新端点各自在 Testcontainers 真 PG 下走通（`optionsdesk-059.*.it.spec.ts`）。spec 的 18 条 `state_branches` **逐条**对应 `it()` 块（Testing Invariants 第 3 条 EXHAUSTIVE BRANCHING）。
- [x] **Mobile / Web**: **N/A** — 本片零前端面（spec `web_compat: na`），无 user-facing 屏可走。
- [x] **Evidence**: 待 impl 阶段填 IT commit。**验收硬条件**：`anchor.count()` 在提交端点用例中必须零变化；「第二天再 import 同一锚不被 400」必须有独立 `it()`（那是最容易漏且后果最重的一条）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** — 本片不引入任何第三方 package / SDK / tool（见 Dependencies 表的 explicit no-op）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** 本片不触碰任何自 meta-repo 迁入的代码或文档：`optionsdesk` 是 2026-08 新建的第 10 bounded context（ADR-0062），`security/guest-upload-auth.guard.ts` 是 2026-08 随 057 新建，guest-proxy 是 2026-08 新建的 service。无 Java 类名 / Maven 坐标 / Spring 路径可漂。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| **ADR-0062** | sunset_trigger #5：「锚的估值口径从人工录入转为模型批量产出**且需自建估值管线** → 重审是否拆 `valuation` 子 ctx（**本 ADR 把「模型 import」按外部输入处理，不建管线**）」 | **accepted-as-is** | **判据的排除条款正好覆盖本片**：估值管线在本机（仓外），本片只做「外部输入」的接收面，一行估值计算都不落 server。这正是 ADR 作者预见并已定性的形态 ⇒ 不触发拆 ctx。⚠️ 若将来把估值计算搬进 server，该 trigger 即刻成立 |
| **ADR-0062** | sunset_trigger #3：「出现第二个消费锚表的 ctx」 | **accepted-as-is** | 不触发 —— 新端点与新 use case 仍在 optionsdesk 内，锚表消费方数量不变（本 ctx + marketdata 采集闸那条反向 Q7-B） |
| **ADR-0065** | 「已否决方案」表：「给投递方发系统账号 token 走标准口子 → `JwtAuthGuard` 是全站鉴权面…= 把持仓 / 交易记录 / 自选 / **期权锚** / chat 会话全部给他」 | **mitigated** | 见下方专段 —— 本片**不违反**该决策（我们恰恰不用 `JwtAuthGuard`），但改变了它的一条前提（「通道 = 纯单向收集箱」）。缓解 = 通道按认证结果分流（**单层**；服务端第二把 token 曾作为第二道缓解实装、收口时驳回，理由与代价见 Architecture Notes §2） |
| **ADR-0046** | 「是否把『单行 conditional UPDATE 谓词不得碰他行』做成机械 check？暂留 CR 人工把关」 | **accepted-as-is** | 本片的更新走 `updateMany where {id}` + affected-count，谓词只碰目标行，落在该 ADR 已覆盖的范式内。不新增触发升机械层的信号 |
| **ADR-0035** | 「`db:migrate` wrapper 的 graceful rollback」/「`local-personal.ts` 分散 vs 集中」 | **accepted-as-is** | 与本片无关：本片 migration 是纯 expand（单条 `CREATE TABLE`），无破坏性变更、无回滚需求；不涉及 seed 策略 |

**Evidence**: `grep -ln "Open Question" docs/adr/*.md` + 逐个核对 `sunset_trigger` frontmatter。**无需 ADR amend / 新 ADR** —— 上表全部 accepted 或 mitigated，无 escalated。

#### ADR-0065 那条的详细核对（本 Gate 最重的一项）

ADR-0065 反对的是**给投递方一个能过 `JwtAuthGuard` 的宽口子**，理由是那会把全部 authed 面（含期权锚）一次性交出去。本片做的是**再开一个窄口子**：专用端点 + 既有的 `GuestUploadAuthGuard`（通道 token、零用户 principal、不设 `request.user`），`JwtAuthGuard` 一行不碰。⇒ **该决策不仅未被违反，还被本片强化了一次**（又一个业务能力选择了窄口子而非宽口子）。

但有一条前提确实变了：`guest-upload-auth.guard.ts` 的注释写着「投递方只有『往收集箱里放东西』这一个权限」。本片之后，**经该 guard 的请求里出现了能改业务数据的一类**。处理：

1. **对其他访客而言，「单向收集箱」性质原样成立** —— 他们的请求被通道分流到提交端点，落的是待审表，锚表零变化。ADR-0065 §4 对投递方仍然完整。
2. **服务端能否独立拒绝** —— 曾按「第二把 token」实装以满足 §4「通道与服务两层各自独立拒绝」，**收口时驳回**（见 Architecture Notes §2）：那第二把与第一把同宿主同文件同 SOPS blob，是共命的假第二层。⇒ 明示接受**授权闸的唯一支点是 nginx 配置**这一状态，代价与唯一的回归钉同段列明。
3. **`guest-upload-auth.guard.ts` 的类注释需同步更新**，把「只有放东西这一个权限」改成准确表述，并指向本片。**注释与实际能力不符比没有注释更危险。**

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

### 🚨 Impl Guardrails（并发 / 安全）

- **并发/事务**：单行状态转换用 conditional UPDATE **affected-count**（`updateMany where {id,<前置>}` → count===1 won / 0 lost，READ COMMITTED）；**NEVER** 单行 `FOR UPDATE` / Serializable（偏索引 SSI 假冲突）。外部 I/O **split-tx**（本片无外部 I/O）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：凭证比较走既有 `isGuestUploadAuthorized`（HMAC constant-time），**NEVER bcrypt**；失败一律裸 401 不泄原因（「未配」与「不符」对外不可区分）。

---

### §1 为什么必须新建 use case 而不复用 `UpdateAnchorUseCase`（三个雷，逐个都是真的）

| 现有 | 雷 |
|---|---|
| `POST /v1/optionsdesk/anchors` | 同 ticker 已存在 → **409 蓄意拒绝**（`create-anchor.usecase.ts:115-123`：「静默 upsert 会覆盖已录的估值结论」）⇒ 每天第二次导入全红 |
| `PATCH /v1/optionsdesk/anchors/:id` | ① 按内部 `anchorId` 寻址，调方拿不到；② `UpdateAnchorPatch` 无 `confidenceSource` 字段 ⇒ 翻不了 `'model'`；③ 🚨 **致命**：首日把 `confidence_source` 写成 `'model'` 后，**次日再导入同一锚会被 `update-anchor.usecase.ts:131-134` 自己的 400 门控拒掉** ⇒ 链路上线第二天静默停止更新已有锚 |
| `resolveManualState` 路径 ③ | 走 `cascadeOnManualConfidenceChange`（只冲 lLevel/positionCap，**不冲 `vManual`**）；模型 import 该走路径 ①（`cascadeOnModelImport`，三处人工位一并回落） |

⇒ 新建 `optionsdesk/import-anchor-from-model.usecase.ts`。**`update-anchor.usecase.ts` 一行不改**，`ANCHOR_CONFIDENCE_READONLY` 门控原样保留（spec 契约：045 spec 与 mobile 一个字不动）。

流程：查 ticker → 无锚走 `CreateAnchorUseCase({ confidenceSource:'model', source:'model' })`（两参已支持）；有锚则**先判全等短路**（见 §4）→ 算差异报告 → `buildModelImportPatch` → `buildAnchorChange(..., 'model')` → 单事务 `updateMany` + affected-count + 痕迹写入。

**「无 by-ticker 写端点」这个摩擦不存在** —— 那是 HTTP 面限制；进程内先按 ticker 查自有表拿 id 即可。**不新增 by-ticker 的 REST 写端点**（会扩大对外写面）。

### §2 通道 token 数量 —— 升级到两把、又在收口时回退成一把

**最终状态：一把。** 直写口与提交口都验既有 `GUEST_UPLOAD_TOKEN`；「只有本人可直写」的判据**只在通道层**（nginx `/anchor-import` 的 `$anchor_write_allowed`）。

这条走过一轮完整往返，三段都留在这里 —— 「为什么不是两把」是后来者一定会重新问一遍的问题：

1. **P1 子 plan 原设计**：两个端点共用 `GUEST_UPLOAD_TOKEN`，靠 nginx 选 upstream 路径分流。
2. **本 plan 升级为两把**（T003 已按此实装并测绿）：理由是 ADR-0065 §4「通道与服务**两层各自独立**拒绝」—— 单把时服务端对两个端点无可判之据，谁绕过代理直连 app 的 loopback 端口就能直写锚。
3. **收口回退成一把**（2026-08-17，user 决策）：驳回理由是**第二把与第一把共命，不构成独立的第二层** ——
   - 两把同出一个 SOPS blob、渲进 guest 机同一个 `/etc/nvy-guest-proxy.env`、落进同一份 nginx conf；读得到其一的位置基本都读得到另一把。
   - 而 (2) 里那个「绕过代理直连 loopback」的位置，因 `docker-compose.guest.yml` 是 `network_mode: host`，恰恰**就是那台 guest 机本机** —— 攻击位置与密钥存放地重合。
   - 残余价值只剩两个窄场景：同机上够得到 loopback 但读不到那个 env 的东西（非特权进程 / 另一个容器），以及本 token 的单独泄漏（日志回显 / 误贴）。不足以抵住「每加一个权限层就多一把 token」在配置面的扩散。

**接受的代价（写明，不留给人自己撞上）**：服务端对「直写」与「提交待审」**没有可判之据**，FR-010 的判据是单层的。这与 FR-010 原文并不冲突（它本就只要求「判据 MUST 在通道层完成」），但比 (2) 弱。连带三处已同步：

- spec `state_branches` ⑫ 由「通道与服务两层各拒一次」改为「判据落在通道层，MUST NOT 依赖服务层再拒一次」；
- server IT 的 ⑫ 改成钉住「不可判」这件事本身（同一 bearer 打两个口都 201），谁把 token 重新拆开它就红；
- **唯一验「只有本人可直写」的地方是 `verify-guards.sh` 闸 8d**，且 owner / other 两种角色都必须真跑（只跑一侧 = 只验半条）。

**要加回第二把的门槛**（单点记在 `apps/server/src/config/guest-upload.config.ts` 顶部）：先证明它与第一把**不共命** —— 另一台宿主 / 另一个 secret store / 另一个渲染管道。共命的第二把只是「看上去两把」，比诚实的一把更坏。token 按**权限层**分、不按端点数分。

实现：`GuestUploadAuthGuard` 是普通 `@Injectable()` guard，读固定的 `guestUploadConfig.token`（T003 那个「参数化认哪把 token」的 mixin 工厂随第二把 token 一并删除）；零用户 principal、constant-time 比对、裸 401 不泄原因三条不变。

🚨 **`guest-upload-auth.guard.ts` 的类注释必须同步改**：原注释称「投递方只有『往收集箱里放东西』这一个权限」，本片后不再准确 —— 而且回退成一把之后**更不准确**（同一把 token 现在也守着直写口）。**注释与实际能力不符比没有注释更危险。**

### §3 `buildModelImportPatch` 键集 7 → 9

加 `asof: Date` / `method: string` 两键。**Guardrail 11 完好** —— 那条契约讲的是三个键的**缺席**（`nextReview` / `lastReviewedOn` / `breachStartedOn`），加两个 model 侧事实列不触及。JSDoc「7 列」改「9 列」，🚨 段一字不动。

**顺手把「键集封闭」从散文升成机器检查**：现有 spec 只有三条 `not.toContain`（防已知坏键），防不住「有人又加了第 10 个键」。追加一条 exact-key-set 正向断言。

**否决的替代**：不扩键集、在 use case 里 `{ ...patch, asof, method }` —— 那把两个模型写的列放到封闭键集**之外**，下一个人加列会照抄那个位置，单点就此失效。

`asof` 缺失时回落研报日期语义由调用方负责；服务端**不回落「今天」**（伪造新鲜度）。

### §4 noop 短路 —— 5 行，但它决定通道好不好用

有锚且 `v` / `confidence` / `asof` / `method` 与现值**全等**时，整个跳过写入，不产生痕迹。

理由：L 层人工位是 spec 契约下**唯一**的人工干预手段，而 `cascadeOnModelImport` 每次都清三处人工位。没有这条短路，重复调用 / 同一轮模型跑两遍 / 估值其实没变，每次都会白白抹掉一次人工判断。有了它，回落只在估值真变时发生 —— 那时冲掉才是正确语义。

### §5 差异报告的持久面 = 既有痕迹表，不建第二份存储

`buildAnchorChange` 产出的痕迹里 `changedFields` 会含被清空的人工位、`beforeValues` 会含其原值 ⇒ 锚变更痕迹**天然就是**差异报告的持久面。响应里的 `fallbackEntries` 只是同一信息的即时呈现。

⚠️ 这一条修正了两份 plan 的不一致（master 契约 6 说「返回并且落库」，P1 只写返回），已在 spec FR-007 钉死为「MUST NOT 为此另建第二份存储」。

### §6 待审表 `optionsdesk.anchor_submission`

贫血 row，三态 `PENDING` / `CONSUMED` / `REJECTED`。migration 纯 expand（`CREATE TABLE`）⇒ 单 PR 合规（ADR-0035 + `.claude/rules/migration-rules.md §2`）。

**索引只建 PK** —— 日均个位数，`status` 上撒 B-tree 是 cargo cult（同 `research_report` migration 自己写的「按真实查询形状建才对」）。

🚨 `scripts/checks/check-server-moat.ts` 的 `MODEL_OWNERSHIP` **必须登记** `anchorSubmission: 'optionsdesk'`，否则 `moat-unmapped` 硬拒（ADR-0062 Consequences 已写明这条）。

**零审核面**：不做审核 UI / 转正 CLI / 审批端点。采纳动作 = 本人用自己的凭证把同样的值重放一次 —— 这保证了 spec FR-012「系统 MUST NOT 存在第二条写锚路径」。

### §7 两个写侧校验洞必须在本片补（仅新端点）

| 洞 | 现状 | 后果 |
|---|---|---|
| **ticker 零格式校验** | `parseAnchorTicker` **未接入任何写路径**；DTO 只有 `@IsString/@MaxLength(32)`；FR-002「禁自由文本」只在客户端实现 | 传 `"AOS"` 会**建锚成功**，随后行情投影静默跳过 ⇒ 永远没有行情的僵尸锚，且与「标的尚未采集」不可区分 |
| **confidence 零值域校验** | 无 `@Min/@Max`，列是 `Decimal(4,2)` | 传 `999` → **PG numeric overflow 500 而非 400** |

⚠️ **只在新端点补**，既有 JWT 端点的 DTO 不动（避免范围蔓延）。既有洞另记 backlog。

### §8 时序：server 侧无 cron，约束落在调用方

本片**不新增任何 `@Cron`**。导入由本地估值流程触发，「必须早于当日采集」是**运维约束不是代码约束**。

之所以成立：`AnchorDrivenSyncGate.recalcSafely()` 是 `factExecutor` 的**前置步骤，在同一次 run 内**（`dimension-executor.ts:834-837`）⇒ 采集轮启动前写的锚，当轮即被 `anchoredCodesByMarket()` 看见。**「建锚后要等下一轮 cron」指的是「不即时生效」，不是「要等次日」。**

实证支撑（prod 只读，2026-08-16）：`us:PDD` 建锚前 `need_sync=false` 且 `daily_bar` **0 行** —— 新 us 标的在开闸前一根日线都没有；三只 hk 标的 `need_sync` 恒 true、日线已有 ⇒ hk 锚不依赖采集轮，建完下一次行情投影即有距 W%。

⇒ 这条约束写进 `quickstart` 性质的调用说明（capabilities 目录），**不写进代码**。

### §9 通道侧（guest-proxy）

照 `location = /research-report` 的五闸形状新增两个 location。⚠️ 三条注意：

1. **`proxy_set_header` 是整组覆盖** —— 出现一条，server 级那三条对本 location 全部失效，必须整组抄（该坑的原文注释就写在 `/research-report` 旁边）。
2. **市场白名单与 server DTO 是两处独立判据，会漂** —— nginx 注释里写明「与 server DTO 同源，改一处必改另一处」，并让 IT 里对 `cn:` 的 400 断言把服务端那侧钉死。
3. **`deploy/install.sh` 的 Gate A** 会机器校验「capabilities 目录声明的端点集 ↔ nginx 实际放行集」相等 ⇒ 两处必须同 PR 改。`openclaw-skill/SKILL.md` **不动**（薄壳，能力清单运行时从 `/capabilities` 拉）；`guest-bundle/README.md` 按 Gate C **不得**写入新端点。

### §10 API 契约与类型链

新端点用 `@nestjs/swagger` 装饰器（code-first SoT，per `docs/conventions/api-contract.md`）→ `nx run server:export-openapi` → `packages/api-client` regen，**同 PR**（Constitution §V）。

⚠️ 本片零 mobile 消费面 ⇒ **无** hermetic e2e、**无** contract smoke（那两层是给跨端 feature 的）。regen 仍要做——生成物 drift 会在下一个 feature 的 typecheck 里炸。

## Complexity Tracking

> Constitution Check 无违规，本表留空。
