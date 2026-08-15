---
feature_id: 057-research-report-guest-ingest
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-15'
updated_at: '2026-08-15'
---

# Tasks: 057-research-report-guest-ingest（研报库 guest 投递入口 —— 单向收集箱，只写不读）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: 本片新增 `ADR-0065`（amend [`ADR-0045`](../../docs/adr/0045-object-storage-image-upload.md) 两条被否决项）
**Branch**: `057-research-report-guest-ingest`
**PRD 源**: [`portfolio-master-prd.md`](../../docs/prd/portfolio/portfolio-master-prd.md) §3.8 研报库（本片是它的第一个 use case）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环（Constitution §II）。
- 层级：`[Server]` / `[Contract]` / `[Ops]` / `[Docs]`。本片**零 mobile** ⇒ 无 `[Mobile]` / `[Contract-Smoke]`（guest 走裸 curl，不经 `@nvy/api-client`）。`[Ops]` = guest-proxy 与宿主编排，走**另一条部署链**（`deploy-guest-proxy.yml`；上线顺序见文末 § 单 PR 与上线顺序）。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 签名器（改：加 key leaf 参数） | `apps/server/src/integrations/oss/oss-policy.ts` |
| 对象写入 port + 适配器（新建 3 个） | `apps/server/src/integrations/oss/{object-storage.port,oss-post-object.adapter,fake-object-storage.adapter}.ts` |
| 平台 module（改：注释 + export） | `apps/server/src/integrations/oss/oss.module.ts` |
| guest 鉴权（新建 2 个） | `apps/server/src/security/{guest-upload-auth.guard,guest-upload-auth.rules}.ts` |
| 配置（新建 2 个） | `apps/server/src/config/{research-oss.config,guest-upload.config}.ts` |
| 业务 ctx（新建目录） | `apps/server/src/research/` |
| 边界注册 | `apps/server/eslint.config.mjs` · `scripts/checks/check-server-moat.ts` · `apps/server/src/app.module.ts` · `apps/server/src/security/throttler-skip-buckets.ts` · `docs/conventions/business-naming.md` |
| DB | `apps/server/prisma/schema.prisma`（`schemas` 数组当前 **8 项**） |
| IT | `apps/server/test/integration/research-057.{schema,report-ingest}.it.spec.ts` |
| 真 vendor（默认 skip） | `apps/server/test/integration/research-oss.vendor.spec.ts` |
| guest 通道 | `services/guest-proxy/{nginx/futu-shim-guest.conf.template,docker-compose.guest.yml,nvy-guest-proxy.env.example,render-env.sh,verify-guards.sh}` |
| guest skill | `services/guest-proxy/openclaw-skill/SKILL.md` |

🚨 **文件平铺**（ADR-0043）—— `apps/server/src/research/` 下 **MUST NOT** 建 `domain/` / `application/` / `infrastructure/` / `web/` 任何子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **别照抄 `main.ts:62-77` 的 `onRoute` bodyLimit 范式** —— 它对 multipart **完全无效**。`@fastify/multipart/index.js:52` 是 `fileSize: options.limits?.fileSize || fastify.initialConfig.bodyLimit`，而 `main.ts:58` 已显式给了 2MB ⇒ 路由级 bodyLimit **根本不参与**（025 holdings 用 2MB 文件跑在 1MB 默认 bodyLimit 下即实证）。唯一正确解是调用点 `req.file({ limits: { fileSize } })`；`index.js:264` 的 `deepmergeAll(..., opts)` 是**深合并**，覆盖 `fileSize` 的同时**保留**全局 `files: 1`（别重复声明）。
2. **`FST_REQ_FILE_TOO_LARGE` 在 `toBuffer()` 抛，不在 `req.file()` 抛** —— 照抄 `apps/server/src/portfolio/holdings-import.controller.ts:180-186` 的 catch 位置。写错位置的表现是超限请求 500 而不是 413。
3. **OSS 表单的 `file` 字段必须最后 append，且必须是带 `type` 的 `Blob`** —— OSS 忽略 `file` 之后的字段；part 的 Content-Type 来自 Blob 的 `type`，传裸 `Buffer` 会让 part 无 content-type ⇒ policy 的 `$content-type` 不满足 ⇒ **403，而且报错完全不指向这里**。另：**不要手设 fetch 的 `Content-Type` header**，要让 undici 自己生成带 boundary 那条。
4. **签名顺序是 `toBuffer` → 签 → POST，不能反** —— `content-length-range` 上界要在签名时确定，而字节数只有 `toBuffer()` 后才知道。上界用**固定常量**，别用 `[len, len]` 精确锁（把 off-by-one 变成生产事故）。
5. **IT 里 OSS config 必须走 `useValue` DI override，不能走 `process.env`** —— `@nestjs/config` 会跨独立 `Test` DI 容器缓存 provider，前一次 AppModule boot（env 未设）会把本 IT 毒化成 `unconfigured` ⇒ 期望 201 实得 503。既有实证见 `apps/server/test/integration/accounts.upload-credential-009.it.spec.ts:11-19`。
6. **新 ctx 要改的是「既有 12 条 `from` 规则的 disallow 数组」，不只是加自己那条** —— `eslint.config.mjs` 漏一处 = 静默给对方开一条到 `research` 的边（ADR-0062 §1 记过）。加完必须**故意写一行跨 ctx 写来验它真的红**，别留恒真闸。
7. **nginx 新 location 里只要写一条 `proxy_set_header`，server 级那三条就全部失效** —— 必须整组抄，且 Authorization 换成 `Bearer ${GUEST_UPLOAD_TOKEN}`。照抄 `FUTU_SHIM_TOKEN` 不是安全洞（server 401 fail-closed）但**排障方向完全错**：看到的是「这个 guest token 不对」，真因是代理少改一行。
8. **`NGINX_ENVSUBST_FILTER` 正则漏加新键的表现是恒 401 且看不出哪错** —— nginx 起得来、日志正常，但配置里留着字面量 `${GUEST_UPLOAD_TOKEN}`。改 `docker-compose.guest.yml:52`。
9. **`render-env.sh` 的新 token 走 `FUTU_SHIM_TOKEN` 那套（`: "${X:?}"` + perl 替换），不是 `__FILL_GUESTn_TOKEN__` 自动发现路径** —— 后者是给 per-guest token 用的、会 `openssl rand` 现生成，而这个 token 必须与 mono 侧 SOPS 里的值**一致**，现生成就永远对不上。
10. **`SKILL.md` 的 frontmatter `description` 不改 = 新能力对模型完全不可见** —— description 是模型加载 skill 的唯一依据，正文写再好也没用。但 **slug `nvy-futu-kline` 保持不改**（`FORCE=1 install-skill` 靠它原地升级，改了会新旧两份并存）。
11. **`make-guest-bundle.sh` 的出包自证会 `grep -qE '__FILL_|TODO|FIXME'`，注释明写「故意严到会误伤散文」** —— 新文案里别出现这三个串。
12. **四层体积天花板要显式排序，让 multipart 那层先跳闸** —— nginx `client_max_body_size`（413 + HTML 页，server 日志什么都没有，最难诊断）> multipart `fileSize`（`FST_REQ_FILE_TOO_LARGE`，唯一能给干净 ProblemDetail 的）< OSS `content-length-range`。nginx 与 OSS 设 N + slack，multipart 设 N。
13. **`schemas` 数组当前是 8 项不是 10** —— `schema.prisma:9`。另注意 `agent-bridge` 的表落在 `public`（与 business-naming「DB schema = `<module>`」不一致，是既有偏差），`research` 建**独立 namespace**。

---

## Phase 1: 平台层（阻塞其余）🎯

- [X] T001 [Server] **`buildPostObjectCredential` 加可选 key leaf 参数**（`FR-001`, plan `D-2`）：`oss-policy.ts:126` 现硬编码 `` `${keyPrefix}${uuid}/img` ``（Phase 0 实测 key 确为 `research/<uuid>/img`）。加可选入参（默认 `'img'`），使研报可传 `'report.pdf'` 之类语义化 leaf。→ verify: `oss-policy.spec.ts` **既有断言逐字节不变**（三个既有 caller 的行为回归护栏）+ 新增一条显式 leaf 的用例 + 一条省略 leaf 时仍为 `/img` 的用例

- [X] T002 [Server] **`ObjectStoragePort` + fetch 适配器 + fake，并把 Phase 0 PoC 提升为 vendor spec**（`FR-007`, `FR-008`, plan `D-2`）：新建 `object-storage.port.ts`（interface + `Symbol` DI token）/ `oss-post-object.adapter.ts`（组 FormData + POST，照 `account/object-exists.probe.ts` 的 interface+Symbol+fetch 范式）/ `fake-object-storage.adapter.ts`（测试专用，**MUST NOT 注册进 `app.module`**）。适配器返回**三态**结局：确认成功 / 确认被拒 / 无法确定（超时、连接中断、5xx），**不得**把「无法确定」压成「被拒」。同步改 `oss.module.ts` 那句「仅 re-export 签名函数 + DTO 类型」的注释。Phase 0 的 scratchpad PoC 落为 `research-oss.vendor.spec.ts` + `describe.skipIf(!RUN_RESEARCH_OSS_IT)`，env 名登记进 `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`。→ verify: 单测四条且**每条都能真失败** —— ① 解析 multipart boundary 断言最后一段是 `name="file"`（Guardrail 3；mobile 侧同款先例 `use-profile-image-upload.spec.ts:81`）② part 的 Content-Type 为 `application/pdf` ③ 非 200 映射为具名异常且不吞原因 ④ 日志与异常消息**不含** `x-oss-signature`。vendor spec 默认 skip，`RUN_RESEARCH_OSS_IT=1` 时三条断言（写 `research/` 200 / 写前缀外 403 / 超 range 400）复现 Phase 0 结果

## Phase 2: 配置与 ctx 骨架

- [X] T003 [P] [Server] **5 个 env 过 `/config-add` 落九位置 + 两个 config factory**（`FR-009`, `FR-017`, plan `D-7`）：新建 `research-oss.config.ts`（zod discriminated union `'unconfigured' | 'aliyun'`，四凭证 all-or-nothing 门，照 `oss.config.ts`；**独立 `registerAs` namespace，不挤进现有 `ossConfig` 的 union** —— 两个账号、两种 ACL、两种用途）+ `guest-upload.config.ts`（token，`.min(32).nullable()`，照 `agent-bridge.config.ts`）。非密 `RESEARCH_OSS_REGION` / `RESEARCH_OSS_BUCKET` 进 `.env.production` + `.env.example`；三个密钥（`RESEARCH_OSS_ACCESS_KEY_ID` / `RESEARCH_OSS_ACCESS_KEY_SECRET` / `GUEST_UPLOAD_TOKEN`）真值已在 `~/.nvy/secrets.enc.env`（前两个 Phase 0 已填）。⚠️ compose 的 `${VAR:-}` 缺失时喂**空串非 undefined**，映射前在 factory 折叠空串（`blankAsAbsent` 范式，先例 `sms.config.ts`）。→ verify: `pnpm tsx scripts/checks/check-env-sync.ts` Check A–H 全绿 + `vitest.config.ts` `test.env` 占位齐（缺则 server IT boot crash）+ config 单测覆盖「四凭证全空 → `unconfigured`」「填一个 → boot 抛」两分支

- [X] T004 [Server] **`research` ctx 四个机器注册面 + PG schema namespace**（plan `D-1`, Constitution §IV）：`eslint.config.mjs` 加 `research` element + 它自己的 `from` 规则（叶子 ctx，disallow 全部业务 ctx **含 `account`** —— app 侧投递入口接入时 lint 会红，那是「鉴权入口分叉」的显式时刻）+ **既有 12 条 `from` 规则的 disallow 数组各加 `research`**（Guardrail 6）；`check-server-moat.ts` 的 `BUSINESS_CTX` 与 `MODEL_OWNERSHIP` 各加一项；`business-naming.md` 模块清单加 `research/`；`app.module.ts` 注册（`research.module.ts` 先落 ctx 锚，controller / provider 由 T009 接）。`schema.prisma:9` 的 `schemas` 数组从 **8 项加到 9**（Guardrail 13）。⚠️ **原列的第五个注册面「`throttler-skip-buckets.ts` 加桶」经评估后不做** —— 见 § 故意零覆盖登记。→ verify: `nx lint server --skip-nx-cache` + `pnpm tsx scripts/checks/check-server-moat.ts` 绿；**再故意写一行 `prisma.instrument.findMany()` 在 `research/` 里，确认 moat 探针真的红**，删掉后复绿（反例，别留恒真闸）

- [X] T005 [Server] **`ResearchReport` model + migration**（`FR-006`, `FR-011`, `FR-019`, plan `D-4`）：`research` schema 建表，字段一次留够：`symbol`（`market:code` 裸串，**无 FK**）/ `reportDate` `@db.Date` / `title` / `source`（默认「自研」）/ `version`（本片恒初值）/ `contentHash` / `sizeBytes` / `originalFilename` / `objectKey` / `status`（`PENDING` \| `COMMITTED`）/ **uploader 两列**（`uploaderKind` + `uploaderRef`，承 `{ kind: 'guest', guestName }` \| `{ kind: 'account', accountId }` 的 union）/ `createdAt`。唯一键 `@@unique([uploaderKind, uploaderRef, contentHash])`（spec Clarifications Q1）。→ verify: 新建 `research-057.schema.it.spec.ts` 用 `setupEmptyDb()` 跑 `migrate deploy` 并断言唯一约束与 `research` namespace 真实存在；`prisma migrate diff` 非空

## Phase 3: 业务与端点

- [X] T006 [P] [Server] **`research-report.rules.ts` 纯函数**（`FR-003`, `FR-005`, plan `D-1`）：`normalizeSymbol`（`1698.HK` / `HK.01698` / `hk:1698` / 大小写混杂 → **`hk:01698`**；市场限 `cn|hk|us`，越界抛）—— ⚠️ 本条原写 `→ hk:1698`（去零），2026-08-15 impl 时按仓内 canonical **订正为 5 位补零**：`hk:00700` 形态在仓内出现 241 处（vendor 下发即如此），去零存会让 PRD §3.8 后续「详情页按 `market:code` 列该标的研报」一条都匹配不上，**且不报错**。同理 cn 补到 6 位、us 转大写/ `looksLikePdf`（`%PDF-` 魔数，**基于内容非文件名**）/ `titleFromFilename`（兜底，须能吃掉第二份样例那种 `---<uuid>` 后缀）/ `buildObjectKey`（由 `contentHash` 单独导出，**与投递方无关** —— 这是「不同投递方共享同一对象」成立的机制）。无 I/O 无 DI。→ verify: colocate 单测，含三组**反例**：`hk%3A1698`（百分号编码 → 拒，Guardrail 说明为何方向是 fail-closed）/ `hk:1698,us:PEP`（混市场 → 拒）/ PNG 字节改名 `.pdf`（→ 拒）；外加 `buildObjectKey` 对同字节不同投递方**返回同一 key** 的断言（state_branch 3）

- [ ] T007 [P] [Server] **`GuestUploadAuthGuard` 落 `security/`**（`FR-009`, `FR-015`, plan `D-3`）：照抄 `worker-auth.guard.ts:28` + `worker-auth.rules.ts:21` 范式 —— Bearer 常量 token + `timingSafeEqual` + fail-closed（未配 token 则拒一切）+ 裸 401 不泄原因 + **零用户 principal**（不设 `req.user`）。`openapi.config.ts` 加具名 scheme（`worker-token` 是先例）。→ verify: **真 DI 容器**测三态（token 对 / 错 / 缺）—— `Test.createTestingModule({ imports: [...] }).compile()`，**MUST NOT** `new GuestUploadAuthGuard()`（Testing Invariants 第一条）；断言「缺失」与「不符」的响应体逐字节相同（state_branch 11 / 12）

- [ ] T008 [Server] **`ingest-research-report.usecase.ts`**（`FR-006`, `FR-007`, `FR-007a`, `FR-008`, `FR-010`, plan `D-4`）：写序 = 查唯一键 → 命中 `COMMITTED` 则直接返回既有行（不碰 OSS）→ 命中 `PENDING` 则**就地续做**（重传，成功原地翻 `COMMITTED`，不新增行不报冲突）→ 未命中则写 `PENDING` → `ObjectStoragePort.putObject` → 翻 `COMMITTED`。配额闸：该投递方名下全部记录 `sizeBytes` 之和（**含 `PENDING`；共享对象照常全额计入**；被拒不计），超限拒。`unconfigured` → 503「该能力未启用」。→ verify: 单测（fake port）覆盖 state_branch 1 / 2 / 3 / 5 / 6 / 7 / 8 / 9 / 10 / 18 / 19；其中「无法确定」态断言**不**留 `COMMITTED` 行且**不**对调用方断言失败

- [ ] T009 [Server] **`research.controller.ts`（guest 面）+ module + multipart 上限 + compose loopback 端口**（`FR-001`, `FR-002`, `FR-004`, `FR-012`, plan `D-5`, `D-6`）：`@Controller('v1/research')` + `POST reports`，`@UseGuards(GuestUploadAuthGuard)` + `@ApiBearerAuth('guest-upload-token')` + `@ApiConsumes('multipart/form-data')` + 手写 `@ApiBody` binary schema；三个必填元数据走 **query string**（nginx 的 `$arg_*` 只读得到 query，闸才成立），文件走 multipart 单 part。**`req.file({ limits: { fileSize: RESEARCH_MAX_BYTES } })`**（Guardrail 1），`toBuffer()` 外层 catch `FST_REQ_FILE_TOO_LARGE` → 413（Guardrail 2）。投递方归属取 `X-Guest` header（nginx 无条件覆写 ⇒ **可信作归属、绝不可作授权**）。**不实装任何 GET / PATCH / DELETE**。`docker-compose.tight.yml` 给 app 加 `ports: ['127.0.0.1:3001:3000']`（照 postgres `:47` 范式，**必须带 `127.0.0.1:` 前缀**）并改写那句 `# No public port` 注释。→ verify: `research-057.report-ingest.it.spec.ts`（`setupIsolatedDb()` + fake port + **OSS config 走 `useValue` DI override**，Guardrail 5）覆盖 21 条 `state_branches` 里端点层的全部；含 3MB → 201 与 17MB → 413 两发（证明 Guardrail 1 的解法真的生效）；四层体积天花板的常量大小关系写一条 spec 断言（Guardrail 12）

## Phase 4: 契约与决策留痕

- [ ] T010 [P] [Docs] **ADR-0065**（plan Gate 0.4）：新建 `docs/adr/0065-research-report-private-object-storage.md` —— 立第 11 个 bounded context `research`（依据 = PRD §3.8 与 §3.5→`alert` 先例）+ **amend ADR-0045 两条被否决项**（`:83` 后端代理上传 / `:84` private bucket）+ 正向 `sunset_trigger`（单文件 > 100MB 或需断点续传 → 重审 header 签名 / SDK）。**必须写明**：ADR-0045 那条 trigger 原文限定「私密化的**图片**资产」而本片是 PDF，属**类比命中非字面命中**。🚫 **不写反向 sunset_trigger**（「12 个月无第二个 use case 就折叠 ctx」建立在「研报只是一张表」的错误前提上，已被 PRD §3.8 证伪）。→ verify: ADR governance checklist 过 + `pnpm tsx scripts/checks/check-convention-orphan.ts` 无孤儿 + ADR-0045 正文加一行指向 0065 的 Superseded-in-part 注记

- [ ] T011 [Contract] **OpenAPI 导出 + api-client 重生成**（Constitution §V）：`nx run server:export-openapi` → `nx affected -t generate`。**两步都要跑，无一行覆盖** —— 漏第一步完全静默（`api-client:generate` 无 `dependsOn`，orval 拿上一版 json regen，`git status` 干净、lint/typecheck/test/build 全绿、CI 无一处会红）。→ verify: `git status` 显示 `apps/server/openapi.json` 有变更且含新路径；`packages/api-client` 产物同步；`pnpm tsx scripts/checks/check-api-property-nullable.ts` 绿（nullable 标量的 `@ApiProperty` 必须显式 `type: 'string'`）

---

> ⬆️ 以上是 server 侧；⬇️ 以下是通道侧。**同一个 PR**，但通道侧走另一条部署链，上线顺序见文末。

## Phase 5: guest 通道

- [ ] T012 [Ops] **guest-proxy 新 location + env 管道**（`FR-013`, `FR-014`, `FR-016`, plan `D-6`）：`futu-shim-guest.conf.template` 加 `location = /research-report` —— `limit_except POST { deny all; }`（`FR-013`，两层各拒一次的通道那层）/ 市场闸 `$arg_symbol !~ "^(cn|hk|us):"` → 400（**注释必须写明为何与行情端点的 US-only 刻意不同**）/ `client_max_body_size 20m`（= 16MB 上限 + slack；全仓目前零处设置、默认 1m）/ **新开** `limit_req_zone guest_upload:1m rate=2r/m` + `burst=1`，且注释里**必须写明它与行情三个 zone 不同类** —— 行情 zone 护的是上游 vendor 官方限额，本 zone 护的是**宿主磁盘**（`proxy_request_buffering` 默认 on，body 整份先落盘，模板顶部注释写着「可用磁盘是几个 G 量级」；2r/m × 16MB × burst 1 ⇒ 峰值驻留约 48MB）/ **整组三条 `proxy_set_header`**，Authorization 换 `Bearer ${GUEST_UPLOAD_TOKEN}`（Guardrail 7）/ `proxy_pass http://127.0.0.1:3001/api/v1/research/reports`。配套：`docker-compose.guest.yml:52` 的 `NGINX_ENVSUBST_FILTER` 加新键（Guardrail 8）、`nvy-guest-proxy.env.example` 加 `GUEST_UPLOAD_TOKEN=__FILL_GUEST_UPLOAD_TOKEN__`、`render-env.sh` 按 `FUTU_SHIM_TOKEN` 那套加 `: "${GUEST_UPLOAD_TOKEN:?}"` + perl 替换（Guardrail 9）。→ verify: `nginx -t` 过 + 本机 dry-run `render-env.sh` 产物无 `__FILL_` 与 `${` 残留

- [ ] T013 [Ops] **`verify-guards.sh` 反例断言**（`FR-012`, `FR-013`, plan `D-6`）：新增断言，**每条配反例**：无 token POST → 401 / `GET /research-report` → 405（`limit_except` 生效）/ `symbol=us.PEP` 等非归一写法 → 400 / `symbol=hk%3A1698` 百分号编码 → 400 / 非 PDF → 422（**证明请求真的到了 app 而不是被 nginx 吞了**）/ 超上限 → 413 且能区分是 nginx 还是 server 返的 / `--from-guest` 新增 **loopback 端口在 wg2 地址上不可达**（plan `D-6` 那三条 iptables 推理的落地护栏 —— 没有它，将来有人把新端口加进 ACCEPT 规则时不会有任何东西红）。⚠️ `check()` 用 `%-46s` 对齐，标签别超 46 字符。→ verify: 本机 `./verify-guards.sh` 全绿（29 → 约 35 条）；prod 上 `--from-guest` 全绿（32 → 约 39 条）；**先把新断言跑红再实现**

- [ ] T014 [Ops] **`SKILL.md` 上传章节 + frontmatter description**（`FR-020`, plan `D-8`）：加上传节 —— 端点 / 三个必填 query 参数 / `-F file=@` 形态 / **symbol 的冒号不要 percent-encode**（`$arg_*` 不解码，编码会 400；方向 fail-closed 安全，但不写明模型会反复试错烧限频）/ 限频与体积上限 / 错误码对照表。🚨 **frontmatter `description` 必须改**（现写死「six endpoints」「US stock … or US options …」，不改则新能力对模型完全不可见）；**slug `nvy-futu-kline` 保持不改**（Guardrail 10），正文加一句历史名说明。顺带修既有 drift：把「502 = OpenD 冷启，等 30 秒是正常表现」那条作废口径改掉（#868 起 OpenD 常驻）。→ verify: `make-guest-bundle.sh` 跑通（4 条出包自证含 `__FILL_|TODO|FIXME` 扫描，Guardrail 11）+ 过仓内 skill 片段可跑性机器闸（`bash -n`，per #55）+ guest 机 `FORCE=1 ./setup.sh install-skill` 后 `source-origin.json` 指向 `services/guest-proxy/openclaw-skill`

- [ ] T015 [Ops] **端到端实证**（`SC-001`~`SC-009`）：从 guest 机用两份真实样例 PDF（约 2MB）走完整链路。→ verify: 归档存储与元数据各一份且归属正确（`SC-008`）/ 同文件重投返回同一标识且对象数不增（`SC-003`）/ 五类不合规各自拒绝理由可区分（`SC-004`）/ 读取与列举全被拒（`SC-005`）/ 2MB 端到端 < 30s（`SC-002`）/ **既有 6 条行情端点的原 29 条断言仍全绿**（`SC-009`）

## Dependencies

```
T001 ─┐
      ├─→ T002 ─┐
T003 ─┘         ├─→ T008 ─→ T009 ─→ T011
T004 ─→ T005 ───┤          ↑
T006 ───────────┤          │
T007 ───────────┘──────────┘
T010（可与 T001-T009 任意并行）

—— 合入后等 mono deploy 完成 ——

T012 ─→ T013 ─→ T014 ─→ T015
```

- **T001 / T003 / T004 / T006 / T007 / T010 可并行**（不同文件、无相互依赖）。
- **T005 依赖 T004**（schema namespace 要先在 `schemas` 数组里）。
- **T009 依赖 T008**（controller 调 usecase）；`docker-compose.tight.yml` 的 loopback 端口归 T009 —— 与 controller 同 PR 才有意义。
- **T012 的 nginx 指向 `127.0.0.1:3001`，该端口由 T009 在 compose 里发布** —— 两者同 PR，但 guest-proxy 的部署链会先跑（见文末），故上线后存在一段 502 自愈窗口。

## 判据覆盖矩阵（`state_branches` 21 条 → task）

| # | state_branch | 覆盖 task |
| --- | --- | --- |
| 1 | 首次投递成功 | T008, T009, T015 |
| 2 | 同投递方重复同字节 | T008, T015 |
| 3 | 不同投递方同字节 → 各一行、复用对象 | T006（`buildObjectKey`）, T008 |
| 4 | 同标的同日期不同字节 → 各自归档 | T008 |
| 5 | 对象已写但元数据失败 → 留未完成记录 | T008 |
| 6 | 重投撞未完成记录 → 就地续做 | T008 |
| 7 | 续做时对象已存在 → 幂等重写仍成功 | T008 |
| 8 | 对象写入失败 → 不留已完成行 | T008 |
| 9 | 存储未配置 → 报未启用 | T003（config 分支）, T008 |
| 10 | 可达性不确定 → 不断言失败 | T002（三态）, T008 |
| 11 | 凭证缺失 → 拒且不泄原因 | T007 |
| 12 | 凭证不符 → 与 11 不可区分 | T007 |
| 13 | 非 PDF（含改名伪装） | T006, T009, T013 |
| 14 | 超单份上限 | T009, T013 |
| 15 | 缺必填元数据 | T009 |
| 16 | 市场不在白名单 | T006, T012, T013 |
| 17 | 非归一写法 → 归一后落库 | T006, T013 |
| 18 | 超配额 | T008 |
| 19 | 共享对象各计一次配额 | T008 |
| 20 | 尝试读取/列举 → 两层各拒 | T009（服务层不实装）, T012（`limit_except`）, T013 |
| 21 | 非投递动作 → 拒绝 | T012, T013 |

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

spec 共 **5 层**需求载体：`state_branches`（21）/ FR（21，含 FR-007a）/ SC（9）/ Acceptance Scenario（14）/ Edge Cases（7）。**五层全扫**，无差集。

### FR 覆盖（21 条）

T001→FR-001 ｜ T002→FR-007/008 ｜ T003→FR-009/017 ｜ T005→FR-006/011/019 ｜ T006→FR-003/005 ｜ T007→FR-009/015 ｜ T008→FR-006/007/007a/008/010 ｜ T009→FR-001/002/004/012 ｜ T012→FR-013/014/016 ｜ T014→FR-020

**FR-018**（凭证只具写入能力）**零代码覆盖 —— 见 § 故意零覆盖登记**。

### SC 覆盖（9 条）

| SC | 覆盖 task |
| --- | --- |
| SC-001 一条命令完成投递 | T014（skill 文案即交付物）, T015 |
| SC-002 2MB 30 秒内 | T015 |
| SC-003 重复投递只一份 | T008, T015 |
| SC-004 五类拒绝可区分 | T009, T013, T015 |
| SC-005 除投递外无法完成任何动作 | T009, T012, T013, T015 |
| SC-006 泄漏最坏后果限于写垃圾 | **T015 + § 故意零覆盖登记**（判据在 RAM 策略，代码侧无载体；Phase 0 的 403 反例是它的实证） |
| SC-007 吊销单投递方不牵连他人 | **§ 故意零覆盖登记** |
| SC-008 任一研报可回答四问 | T005, T015 |
| SC-009 既有 6 端点零回归 | T013, T015 |

### Acceptance Scenario 覆盖（14 条）

US1-AS1/2 → T008/T009；**US1-AS3（后缀式写法落库为归一形式）→ T006 + T013**（这条是 046 那类「写在 AS 里、三张矩阵都够不到」的典型，显式点名）；US2-AS1/2 → T008；US3-AS1~5 → T006/T009/T013；US4-AS1 → T009/T012；**US4-AS2（通道层独立拒绝，不依赖服务端没实现）→ T012 + T013**（同上，AS 独有）；US5-AS1/2 → T005/T009/T015。

### Edge Case 覆盖（7 条）

孤儿对象可扫出 → T008 ｜ 可达性不确定 → T002/T008 ｜ 未配置 → T003/T008 ｜ 凭证缺失 vs 不符 → T007 ｜ 同标的同日期两份 → T008 ｜ 标的写法多样 → T006 ｜ 百分号编码 → T006/T013

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 条目 | 为何零代码覆盖 |
| --- | --- |
| **FR-018**（系统凭证只具写入能力） | 判据完全在**阿里云 RAM 策略**里，代码侧没有可断言的载体 —— 服务端代码无论怎么写都改变不了凭证的权限。已由 Phase 0 的反例断言实证（写 `research/` 之外 → 403 AccessDenied）。**下次轮换 AK 后必须重跑那条 vendor spec**，这是它唯一的回归防线 |
| **SC-006**（泄漏后读不走研报） | 同上，是 FR-018 的用户侧表述 |
| **SC-007**（吊销单投递方不牵连他人） | 判据在 `render-env.sh` 的 `ROTATE=` 机制与 nginx 的 per-guest map，**属既有已验证设施**（2026-08-04 起在用），本片零改动。若本片改了 `render-env.sh` 的 token 生成路径而误伤该机制，`verify-guards.sh` 的既有断言会红 |
| **`version` 列本片不推进** | PRD §3.8 的「同一标的多版本 Version+1」属后续 feature；本片只留列不实装规则（spec Assumptions 已记） |
| **app 侧投递入口** | 本片 scope A 明确不做；T005 的 uploader 两列已留够，接入时**不需要 migration** |
| **server 侧 throttler 桶**（T004 原列的第五个注册面） | 2026-08-15 实证后放弃。三条理由：① 研报端点只挂 `GuestUploadAuthGuard`、不挂 `ThrottlerGuard`，而本仓**无全局 `APP_GUARD`** ⇒ 新桶不会有任何路由使用；② `throttlers[]` 里多一个桶会让**所有**挂 `ThrottlerGuard` 的既有路由都受它管，需在 **29 个 controller** 各加一行 spread，漏一个即静默误限流；③ 语义上更糟 —— guest-proxy 与 app 同机且其 `proxy_set_header` 组不带 XFF ⇒ `req.ip` 恒 `127.0.0.1`，一个桶会把两个投递方焊在一起，**与 FR-016 / SC-007 直接冲突**。FR-014 的载体是 T012 的 nginx `limit_req_zone`（按 `$guest_name` 分，天然 per-guest）。先例：`agent-bridge`（同为机器对机器 + 自有 token guard）亦零 throttler 接线 |

## 单 PR 与上线顺序

**单 PR**，符合 Constitution §V「一个 feature = 一个分支 = 一个 PR」的字面规范。

两条部署链的触发条件不对称（2026-08-15 逐 workflow 实测）：

| 链 | 触发 |
| --- | --- |
| `deploy.yml`（mono app） | `workflow_run`（跟在 **Build & Push Image** 之后）+ `workflow_dispatch`。**无 push/paths 触发** |
| `deploy-guest-proxy.yml` | `push: branches[main] + paths: services/guest-proxy/**` + `workflow_dispatch` |

⇒ 合入时 **guest-proxy 必然先上**，nginx 新 location 会短暂 `proxy_pass` 到尚不存在的 `127.0.0.1:3001` 而返 502。

**该窗口可接受，因为它不可见**：新端点在 guest 机人工 `FORCE=1 ./setup.sh install-skill`（T014）之前无人可用，而那是上线后的手工步骤；既有 6 条行情端点走 `${FUTU_SHIM_URL}`，完全不受影响。

**上线顺序**：合入 → 等 mono deploy 完成（T009 的 3001 端口生效）→ guest 机装 skill（T014）→ 端到端实证（T015）。

> ⚠️ 本片一度按「两条部署链由 paths 各自触发」拆成两个 PR —— **那是事实错误**（`deploy.yml` 根本没有 paths 触发），2026-08-15 `/speckit-analyze` 逐 workflow 核出并纠正为单 PR。
