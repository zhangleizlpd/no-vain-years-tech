---
feature_id: 057-research-report-guest-ingest
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-15'
updated_at: '2026-08-15'
adr_refs: ['0065', '0045', '0043', '0032', '0041', '0040', '0026']
context7_verified: []
---

# Implementation Plan: 研报库 guest 投递入口

## Summary *(mandatory)*

立第 11 个 bounded context `research`，实装 [PRD §3.8 研报库](../../docs/prd/portfolio/portfolio-master-prd.md) 的第一个 use case：wg2 隧道内的访客经 openclaw skill 投递个股 PDF 研报，server 中转落账号 C 私有 OSS，元数据落 PG。

三条主线：① **平台层零新签名代码** —— 复用 `buildPostObjectCredential` 的 V4 PostObject 表单签名，server 自行组 FormData POST（跨账号可用性 + RAM 作用域 + 云侧体积闸已在 Phase 0 三条断言实证）；② **鉴权入口分叉、业务与平台层不分叉** —— guest 面 guard 落 `security/`，与将来 app 面共用同一个 usecase，uploader 做 discriminated union；③ **通道与服务两层各自独立拒绝读取动作**，不依赖「服务端恰好没实现」。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None | N/A | N/A |

**零新依赖**。刻意不引 `ali-oss`：仓内 OSS 能力是手写 V4 签名（`oss-policy.ts:1` 只 import `node:crypto`），`oss.module.ts` 与 `oss-policy.ts` 两处 doc-comment 均明写零-SDK；引入它只用得上 1% 能力，却要付 Trivy HIGH+ 阻塞面与 `pnpm --prod --legacy deploy` 的 prune-后-才-fatal 风险面。`FormData` / `Blob` / `fetch` 全走 Node 22 内建（undici），非 polyfill。

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.

逐条：

1. **§ I SDD** — 本 feature `web_compat: na`、零 UI ⇒ 无 mockup 步（Constitution v1.4.0 § I：后端 use case 无此步）。`specify → clarify（3 问，已记 spec `## Clarifications`）→ plan` 链完整，未跳步。
2. **§ II TDD** — 红点可先定位：`oss-policy.spec.ts` 既有断言在加 key leaf 参数后必须**逐字节不变**（回归护栏）；新增的 FormData 序列化断言（末段须为 `name="file"`）在实现前必红。DB / guard / controller 三层各有先红的断言，见 § 任务切分意图。
3. **§ III Atomic task** — 见 § 任务切分意图，展开为 `tasks.md` 的 **15 条**，每条 30min-2h 可独立 commit。
4. **§ IV Module boundary** — 新增 `research` 叶子 ctx，**跨 ctx 面为 0**（`symbol` 存 `market:code` 裸串，不 join `marketdata.instrument`）。guard 落 `security/`（平台基座，ADR-0041 先例 = `WorkerAuthGuard` 从 `agent-bridge/` 上提）。文件平铺无层子目录；无充血 Domain Class / Entity Mapper；usecase 直注 `PrismaService` 读写自己 ctx 的表。`ObjectStoragePort` 属 ADR-0043 port 三分法第三类（外部服务留 port），落 `integrations/oss/`。
5. **§ V 类型同步链** — 新增 controller + DTO + swagger 装饰器 ⇒ **必跑** `nx run server:export-openapi` + `nx affected -t generate`。**无 mobile 侧**（guest 走裸 curl，不经 `@nvy/api-client`），故无跨端两层验证要求；但 openapi/client regen 仍是硬步骤（漏跑完全静默，CI 无一处会红）。**PR 边界 = 单 PR**，符合 §V 字面。上线顺序见 § D-9。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke 覆盖改动面。新增 `apps/server/test/integration/research-057.report-ingest.it.spec.ts`（`setupIsolatedDb()` + fake `ObjectStoragePort` + **OSS config 走 `useValue` DI override 而非 `process.env`**）；schema 产物另起 `research-057.schema.it.spec.ts` 用 `setupEmptyDb()`。
- [x] **Mobile / Web**: N/A —— `web_compat: na`，零 UI 改动，无 user story 落客户端。
- **Evidence**: DI override 的必要性有既有实证 —— `apps/server/test/integration/accounts.upload-credential-009.it.spec.ts:11-19` 记着 `@nestjs/config` 会跨独立 `Test` DI 容器缓存 `ossConfig` provider，前一次 AppModule boot（OSS env 未设）会把本 IT 毒化成 `unconfigured` → 期望 201 实得 503。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**部分 N/A** —— 不引入任何第三方 package（见 Dependencies 表），故无 package 层 6Q。但**确实新接一个 vendor 面**（账号 C 的 OSS），已在 Phase 0 用真实凭证打真 bucket 实证，三条断言全绿：

| 断言 | 结果 |
|---|---|
| 写 `research/` 前缀 | **200**（`success_action_status:'200'` 生效，返 200 非 204） |
| 写 `research/` 之外（反例） | **403 AccessDenied** —— RAM 策略作用域恰好卡在前缀上 |
| 超 `content-length-range` | **400 EntityTooLarge** —— 云侧体积闸生效 |

- **Evidence**: PoC 脚本复用生产签名器（非另写算法），T2 会把它提升为 `*.vendor.spec.ts` + `RUN_RESEARCH_OSS_IT` gate（默认 skip，env 名须登记进 `check-env-sync.ts` 的 `ALLOWLIST`）。
- **结论**：账号 C 支持本账号长期 AK ⇒ 无需 STS/AssumeRole（现有签名器不覆盖那套 RPC 签名），D-2 成立。**内网 endpoint 已移出范围**（2026-08-15 owner 定）：上传是入流量、免费，内网只省延迟不省钱，不值多一个 env 过九位置同步闸。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A —— feature is mono-native**。`research` ctx 全新，PRD §3.8 自身标注「独立 PRD（后续起草）」，从未存在于旧 Java/Spring meta-repo。

- **Evidence**: `rg -l 'org.springframework|mbw-.*src/main/java' apps/server/src` → 零命中；PRD §3.8 拆分理由原文为「依赖文件存储 / 导入基础设施（V1 尚无）」，即该能力在旧仓亦未实装。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question / trigger affected | Classification | Mitigation |
|---|---|---|---|
| ADR-0045 | `sunset_trigger` 第 2 条「blob 需求从小图片扩张到大文件 / PKM 大附件 → 上传架构 §2 重审」 | **escalated-to-new-ADR** | 命中。本 feature 的 blob 是 16MB PDF，且 §2 明确否决过「后端代理上传」，而本 feature 正是后端代理 |
| ADR-0045 | `sunset_trigger` 第 3 条「出现需私密化的**图片**资产 → 访问模型 §3 从 public-read 重审为 private + 签名 GET」 | **escalated-to-new-ADR** | 命中（⚠️ 严格讲是**类比命中非字面命中** —— trigger 措辞限定「图片资产」，本 feature 是 PDF。精神完全适用，但 ADR-0065 要写明这处措辞落差，别让后人以为字面对上了） |
| ADR-0045 | `:44` 「凭证原语（STS / signed PUT URL / PostObject policy）为 Open Question，留 feature spec 定」 | accepted-as-is | 本 feature 选 **PostObject policy**，正落在该 Open Question 授权的范围内，不构成推翻 |
| ADR-0043 | port 三分法 | accepted-as-is | `ObjectStoragePort` 属第三类（外部服务），不动既有分类 |

**⇒ 本 PR 内新增 ADR-0065**（现有最大号 0064），内容：新 bounded context `research` + amend ADR-0045 **两条被否决项**（后端代理上传 `:83` / private bucket `:84`）+ 正向 `sunset_trigger`（单文件 > 100MB 或需断点续传 → 重审 header 签名 / SDK）。

> 🚫 **不写反向 sunset_trigger**（「12 个月无第二个 use case 就折叠本 ctx」）。该提议建立在「研报只是一张表」的错误前提上，已被 PRD §3.8 证伪 —— 研报库自评「体量足够独立成篇」，含导入 / 存储 / 阅读器 / 版本化四块。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类**绝对禁止** `new GuestUploadAuthGuard()` 这类隔离单测。本 feature 尤其吃这条 —— guard 的三态（token 对 / 错 / 缺）必须经真 DI 容器验，样板 `apps/server/src/agent-bridge/agent-queue.controller.it.spec.ts:12-25`。
- **MANDATORY INTEGRATION**: 用 `Test.createTestingModule({ imports: [ResearchModule] }).compile()` 装真实 DI。
- **EXHAUSTIVE BRANCHING**: `spec.md` 的 **21 条 `state_branches`** 每条必须在 integration test 里有对应 `it()` 块。
- **反例断言不可省**: 每道闸都要配一条「越界被拒」的断言。只验正路 = 闸看着在、实际恒放行 —— Phase 0 的 403 反例就是这条纪律的实证。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**: 所有文件平铺于 `apps/server/src/research/`，**绝不**生成 `domain/` / `application/` / `infrastructure/` / `web/` 子目录。
> - **Anemic Data & Zero-Class**: 数据即 Prisma row。**绝不**生成 Domain Class / Entity Mapper / 校验 VO class。
> - **No Repositories**: usecase 直注 `PrismaService`。

#### D-1 — 新 bounded context `research`，跨 ctx 面为 0

依据是仓内既成先例，不是 DDD 论证：研报库在 PRD 里与 §3.5 预警管理、§3.6 笔记管理**同级**，而 §3.5 已落成独立 ctx `alert`（6 model）。塞进 `marketdata` 会造成同级板块两套落法。

另两条硬理由：① `marketdata.Announcement`（`schema.prisma:890,899`）的 `instrumentId` 是**必填 FK 且在唯一键内**，行业/宏观研报没有它 ⇒ 那张表结构上不可复用；② marketdata 30 张表共同不变量是「vendor 采集、可 truncate 后重新 backfill」，研报不可重采，放进去会把「该 schema 能否整体重建」的答案从「能」变成「不能」。

**跨 ctx 面 = 0**：`symbol` 存归一后的 `market:code` **裸字符串**，不建到 `marketdata.instrument` 的外键、不做存在性校验（校验会拒绝合法新标的，且引入本可避免的 Q7-B 依赖）。对齐 PRD §3.8「按 market+code 归档」与 `specs/014-stock-detail/spec.md:32`「014 与 015 运行时零跨 ctx，仅共享 `market:code` 逻辑键」。

#### D-2 — 平台层：复用 PostObject 表单签名，server 自行 POST

`integrations/oss/` 现有 `buildPostObjectCredential`（`oss-policy.ts:109`）只签**表单**、无 header 签名、无 GET 签名。本 feature 复用它，server 拿到签名后自己组 `FormData` POST 到 OSS。

四条硬约束：

1. **`objectKey` 硬编码 `/img` 必须参数化** —— `oss-policy.ts:126` 是 `` `${keyPrefix}${uuid}/img` ``，Phase 0 实测 key 确为 `research/<uuid>/img`。加**可选 key leaf 参数**（默认 `'img'`），既有 3 个 caller 字节不变，`oss-policy.spec.ts` 既有断言必须逐字节不变 + 新增 leaf 用例。
2. **签名时序** —— `content-length-range` 上界要在签名时定，字节数只有 `toBuffer()` 后才知道 ⇒ 顺序必须是 `toBuffer` → 签 → POST。上界用**固定常量**，不要 `[len, len]` 精确锁（把 off-by-one 变成生产事故）。TTL 从客户端直传的 15min 压到 **60s**（server 自签自用）。
3. **两条能真失败的断言** —— ① 解析 multipart boundary，断言最后一段是 `name="file"`（`FormData` 是有序 entry list，但本仓已有两次「本机预演形状与生产不一致 ⇒ 测试全绿真环境崩」实证，须有会红的护栏；mobile 侧同款先例 `use-profile-image-upload.spec.ts:81`）；② part 的 Content-Type 来自 **Blob 的 `type`**，必须 `new Blob([buf], { type: 'application/pdf' })` —— 传裸 Buffer 会让 part 无 content-type、policy 不满足、403。**不要手设 fetch 的 `Content-Type` header**，要让 undici 自己生成带 boundary 那条。
4. **有网络 I/O ⇒ 必须留 port** —— 照 `apps/server/src/account/object-exists.probe.ts` 范式（interface + `Symbol` DI token + 默认 fetch 实现 + fake），否则 IT 会真打 OSS。`oss.module.ts` 那句「仅 re-export 签名函数 + DTO 类型」的注释同步改。

**云侧闸是收益不是代价**：本仓的三层体积闸（nginx / multipart / controller）全在我们这侧，policy 的 `content-length-range` 与 content-type 白名单是**唯一一条我们代码有 bug 也绕不过**的闸。Phase 0 已实证它真的会拒（400 EntityTooLarge）。

#### D-3 — 上传能力三层切分：只有鉴权入口分叉

PRD §3.8 明写研报「系统接口拉取**或**用户手动导入」⇒ app 侧入口是已规划的，结构必须一次留够。

| 层 | 是否分叉 | 落法 |
|---|---|---|
| 平台层（签名 + PutObject） | 否 | `integrations/oss/` |
| 业务层（校验 → 落 OSS → 写元数据） | 否，**一个 usecase** | uploader 做 discriminated union：`{ kind: 'guest', guestName }` \| `{ kind: 'account', accountId }` |
| 鉴权入口 | **是，两个 controller** | 本 feature 只实装 guest 面；app 面留给后续 feature，接入时**不需要 migration** |

`GuestUploadAuthGuard` 落 `security/`，照抄 `worker-auth.guard.ts:28` + `worker-auth.rules.ts:21`（Bearer 常量 token + `timingSafeEqual` + fail-closed + 裸 401 不泄原因）。OpenAPI 具名 scheme 定为 **`guest-upload-token`**（与 `openapi.config.ts:19-28` 既有的 `worker-token` 同构命名）。

🚫 **明确否决「给 guest 发系统账号 token 走标准口子」**：`JwtAuthGuard`（`apps/server/src/account/jwt-auth.guard.ts`）是**全站鉴权面**，全部 authed controller 共用它 ⇒ 给 guest 一个能过它的 token = 把持仓 / 交易记录 / 自选 / 期权锚 / chat 会话全部给他。与 guest-proxy「面越小越好、放新端点是显式动作」的设计直接冲突。

#### D-4 — 幂等与一致性

- **唯一键 = (投递方, 内容指纹)**（spec Clarifications Q1）。归档位置由**指纹单独导出**（与投递方无关）⇒ 同一字节在多个投递方名下只占一份存储。
- **写序：DB 写 PENDING → OSS put → DB 翻 COMMITTED**。server 无 `DeleteObject` 权限（RAM 策略只给 `oss:PutObject`）⇒ 孤儿对象清不掉，「查得到」是唯一补救前提。
- **命中 PENDING 则就地续做**（Q2）：重传 → 成功原地翻 COMMITTED，不新增行、不报冲突。同字节写同位置是幂等重写，即便对象上次已传成也无害。
- **配额口径**（Q3）：该投递方名下全部记录字节之和（含 PENDING；共享对象照常全额计入；被拒不计）。**蓄意高估实际占用，方向保守**，一次 `SUM` 即可，不维护去重视图。

#### D-5 — multipart 上限：per-request `req.file({limits})`，**不是** `onRoute` bodyLimit

🚨 **`main.ts:62-77` 的 035 ASR `onRoute` 范式对 multipart 完全无效，不要照抄。** `@fastify/multipart/index.js:52` 是 `fileSize: options.limits?.fileSize || fastify.initialConfig.bodyLimit`，而 `main.ts:58` 已显式给了 2MB ⇒ 路由级 bodyLimit **根本不参与**（025 holdings 用 2MB 文件跑在 1MB 默认 bodyLimit 下即实证）。

正确解是调用点覆盖：`req.file({ limits: { fileSize: RESEARCH_MAX_BYTES } })`。`index.js:264` 的 `deepmergeAll(..., opts)` 把 opts 放最后且是**深合并** ⇒ 覆盖 `fileSize` 的同时**保留**全局的 `files: 1`（好事，须写进注释免得下一个人重复声明）。

**四层体积天花板显式排序**（由外到内）：nginx `client_max_body_size`（413 + HTML 页，server 日志什么都没有，最难诊断）→ multipart `fileSize`（`FST_REQ_FILE_TOO_LARGE`，**唯一能给干净 ProblemDetail 的**）→ OSS `content-length-range`（403/400，最晚）。**让中间那层先跳闸**：nginx 与 OSS 设 N + slack，multipart 设 N，写一条 spec 断言三者大小关系。

⚠️ `FST_REQ_FILE_TOO_LARGE` 在 **`toBuffer()`** 抛而非 `req.file()` —— `holdings-import.controller.ts:180-186` 已处理过，照抄。

#### D-6 — 通道：app 加 loopback 端口，guest-proxy 直连

app 容器无公开端口（`docker-compose.tight.yml:118`），guest-proxy 是 `network_mode: host` ⇒ 够不到 `app:3000`。给 app 加 `ports: ['127.0.0.1:3001:3000']`（端口 **3001** 已定：紧邻容器内 3000，与既有 postgres `127.0.0.1:5432:5432` 的「就近不跳跃」风格一致），照抄 postgres 的既有范式（`docker-compose.tight.yml:47`，含「必须带 `127.0.0.1:` 前缀否则绑 0.0.0.0 暴露公网」的强调注释）。

**否决走主站 nginx**：`ops/host/nginx/conf.d/mono.conf` 的 http server block `location /` 是 `return 301` ⇒ POST body 直接丢；要走通得在 loopback 上做 TLS 握手 + 证书校验只为绕回同一台机器；且会焊死 `docker-compose.guest.yml:1-9` 刻意分离的两个故障域。

**安全性由既有 iptables 兜住**（`wg2-77.conf.example:57`）：DNAT 规则带 `-d 127.0.0.1` 匹配 ⇒ guest 打 `10.90.0.1:3001` 落 INPUT 被 wg2 catch-all REJECT；即便日后误绑 `0.0.0.0`，`DOCKER-USER -i wg2 -j REJECT` 仍在 FORWARD 前拦。而 guest-proxy 连 loopback 是**本机发起、无 input interface**，不匹配 `-i wg2`。⇒ 这三条推理**必须变成 `verify-guards.sh --from-guest` 的反例断言**，否则将来有人把新端口加进 ACCEPT 规则时没有任何东西会红。

nginx 新 location 五道闸：身份 map（继承）/ `limit_except POST { deny all; }` / 市场闸 `^(cn|hk|us):`（**与行情端点的 US-only 刻意不同，须在注释里写明为何不一样**）/ `client_max_body_size 20m`（= 16MB 上限 + slack，全仓目前零处设置、默认 1m）/ **新开** `limit_req_zone guest_upload:1m rate=2r/m` + `burst=1`（不复用行情那三个 —— 它们的额度是从富途官方限额切的，混用会让传研报吃掉拉期权链的配额）。

**`2r/m` 的算账**（与行情三个 zone 的依据**不同类**，须在模板注释里写明）：行情 zone 护的是**上游 vendor 官方限额**，本 zone 护的是**宿主磁盘** —— `proxy_request_buffering` 默认 on，body 先整份落盘，而模板顶部注释写着「77 的可用磁盘是几个 G 量级」。2r/m × 16MB × burst 1 ⇒ 峰值驻留约 48MB，安全。研报是人工产出物、一天几份，2r/m 对真实用法**毫无束缚**；真正兜住滥用的是 8GB/投递方的配额闸，限频只负责挡住「循环打」这种形态。

🚨 **`proxy_set_header` 是整组覆盖**：新 location 里写一条就丢掉 server 级三条（含 token 置换）⇒ 必须整组抄，且 Authorization 换成 `Bearer ${GUEST_UPLOAD_TOKEN}` —— 照抄 `FUTU_SHIM_TOKEN` 不是安全洞（server 401 fail-closed）但排障方向完全错。

#### D-7 — 配置面：5 个新 env

| key | secret? | 落点 |
|---|---|---|
| `RESEARCH_OSS_REGION` | 否 | `.env.production` + dev `.env.example` |
| `RESEARCH_OSS_BUCKET` | 否 | 同上 |
| `RESEARCH_OSS_ACCESS_KEY_ID` | **是** | `secrets.enc.env`（仓外，带外 scp） |
| `RESEARCH_OSS_ACCESS_KEY_SECRET` | **是** | 同上 |
| `GUEST_UPLOAD_TOKEN` | **是** | 同上 |

独立 `registerAs` namespace（`research-oss.config.ts`），**不挤进现有 `ossConfig` 的 union** —— 两个账号、两种 ACL、两种用途。照 `oss.config.ts` 的 all-or-nothing 门 + `agent-bridge.config.ts` 的 `.min(32).nullable()`。走 `/config-add` skill 一次落九位置，**别手抄**；收尾 `check-env-sync.ts` Check A–H 全绿。

⚠️ compose 的 `${VAR:-}` 在变量缺失时喂容器**空串而非 undefined**，`.optional()` + `.min(1)` 会被空串炸红 ⇒ 映射前在 config factory 折叠空串（`blankAsAbsent` 范式，先例 `sms.config.ts`）。

#### D-8 — guest 侧 skill

canonical = `services/guest-proxy/openclaw-skill/SKILL.md`。

🚨 **frontmatter `description` 必须改** —— 现在写死「six endpoints」「US stock … or US options …」，而 **description 是模型加载 skill 的唯一依据**，不改则新能力对模型完全不可见，正文写再好也没用。slug `nvy-futu-kline` **保持不改**（`FORCE=1 install-skill` 靠它原地升级），在正文加一句说明，与现有那条 kline 历史名 note 同款。

正文须写明：三个必填 query 参数 / `-F file=@` 形态 / **symbol 的冒号不要 percent-encode**（`$arg_*` 不解码 ⇒ `hk%3A1698` 撞不上市场闸而 400。方向 fail-closed 安全，但不写明模型会反复试错烧限频）/ 限频与体积上限 / 错误码表。顺带修掉既有 drift（本机装的是 08-04 旧版，只有 kline，且把 502 说成「OpenD 冷启等 30 秒」——该口径 #868 起已作废）。

⚠️ `make-guest-bundle.sh` 的出包自证会 `grep -qE '__FILL_|TODO|FIXME'`，注释明写「故意严到会误伤散文」⇒ 新文案别出现这三个串。

#### D-9 — PR 边界：**单 PR**（符合 Constitution §V 字面），上线有一段可接受的自愈窗口

两条部署链的触发条件**不对称**（2026-08-15 实测 workflow 原文）：

| 链 | 触发 |
| --- | --- |
| `deploy.yml`（mono app） | `workflow_run`（跟在 **Build & Push Image** 完成之后）+ `workflow_dispatch`。**无 push/paths 触发** |
| `deploy-guest-proxy.yml` | `push: branches[main] + paths: services/guest-proxy/**` + `workflow_dispatch` |

⇒ 单 PR 合入时，**guest-proxy 必然先上**（push 立即触发 vs 等镜像构建），nginx 的新 location 会在这段窗口内 `proxy_pass` 到尚不存在的 `127.0.0.1:3001` 而返 502。

**这个窗口是可接受的，理由是它不可见**：新端点在 guest 机人工执行 `FORCE=1 ./setup.sh install-skill`（T014/T015）之前**无人可用**，而那是上线后的手工步骤。既有 6 条行情端点走的是 `${FUTU_SHIM_URL}`，完全不受影响。

⇒ **单 PR**。上线顺序 = 合入 → 等 mono deploy 完成 → 再在 guest 机装 skill。

> **为何不拆两个 PR**：拆分唯一能买到的是消除这段不可见窗口，代价却是违反 §V 的字面规范 + 把「端口 3001」这个值跨 PR 传递（T009 设值 / T012 引用，分在两个 PR 里就成了记忆负担）。收益为零而代价真实。
>
> ⚠️ 本节曾写「两条部署链由 paths 各自触发、无编排」并据此拆两个 PR —— **那是事实错误**（`deploy.yml` 根本没有 paths 触发），2026-08-15 `/speckit-analyze` 逐 workflow 核出并纠正。
>
> ⚠️ **归因仍不完整（2026-08-16 上线后补记）**：本节把「guest-proxy 必然先上」归因于「push 立即触发 vs 等镜像构建」，**漏了占主导的那一半** —— app 侧还要过**两道人工闸**（Release PR 由维护者手合 + `Deploy` job 的 `environment: production` reviewer 审批）。差别不是文字：按前者归因会以为「调触发就能改顺序」，按后者才看得出顺序的下界由人点鼠标的时机决定。跨服务上线顺序的现行 SoT 已移至 [`ops/runbook/deploy-topology.md`](../../ops/runbook/deploy-topology.md)，本节作冻结记录保留。

### 改动面清单

**新建**（`apps/server/src/research/`）：`research.controller.ts`（guest 面）/ `ingest-research-report.usecase.ts` / `research-report.rules.ts`（symbol 归一、`looksLikePdf`、title 兜底、objectKey 组装）/ `research.module.ts` + 各自 `.spec.ts`

**新建**（其他）：`apps/server/src/security/guest-upload-auth.guard.ts` + `guest-upload-auth.rules.ts` / `apps/server/src/config/research-oss.config.ts` + `guest-upload.config.ts` / `apps/server/src/integrations/oss/object-storage.port.ts` + `oss-post-object.adapter.ts` + `fake-object-storage.adapter.ts` / `docs/adr/0065-*.md` / 两个 IT + 一个 vendor spec

**改既有**：`oss-policy.ts`（key leaf 参数）/ `oss.module.ts`（注释 + export）/ `openapi.config.ts`（具名 scheme）/ `app.module.ts` / `schema.prisma`（+ `schemas` 数组当前 **8 项**，加第 9）/ `eslint.config.mjs`（新 element + 新 from 规则 + **既有 12 条 from 规则的 disallow 各加一项**）/ `check-server-moat.ts`（`BUSINESS_CTX` + `MODEL_OWNERSHIP`）/ `business-naming.md` / `throttler-skip-buckets.ts` / `docker-compose.tight.yml` / `.env.production` / `.env.example` / `vitest.config.ts` / `services/guest-proxy/{nginx/futu-shim-guest.conf.template,docker-compose.guest.yml,nvy-guest-proxy.env.example,render-env.sh,verify-guards.sh,openclaw-skill/SKILL.md}`

### 任务切分意图（供 `/speckit-tasks`）

下表是 plan 阶段的**意图**；`/speckit-tasks` 已把它展开为 `tasks.md` 的 **15 条**（意图 T9 拆出 controller / compose，T11 拆出 nginx / verify-guards / SKILL / 端到端）。全部落在**同一个 PR**（见 D-9）。

| # | 意图 | 层 |
|---|---|---|
| T1 | `oss-policy.ts` 加可选 key leaf 参数（既有断言逐字节不变 + 新 leaf 用例） | Server |
| T2 | `ObjectStoragePort` + fetch 实现 + fake；PoC 提升为 `*.vendor.spec.ts` + `RUN_RESEARCH_OSS_IT` gate | Server |
| T3 | 5 个 env 过 `/config-add` 落九位置 + 两个 config factory | Server |
| T4 | `research` ctx 五个机器注册面 + PG schema namespace（含跨 ctx 写的**反例**必红） | Server |
| T5 | Prisma model + migration + `research-057.schema.it.spec.ts`（`setupEmptyDb()`） | Server |
| T6 | `research-report.rules.ts` + 单测（`%3A` 编码 / 混市场 / 非 PDF 三组反例） | Server |
| T7 | `GuestUploadAuthGuard` 落 `security/` + 真 DI 三态测试 | Server |
| T8 | usecase：PENDING → put → COMMITTED + 续做 + 配额 | Server |
| T9 | controller + per-request multipart limits + swagger + compose loopback `127.0.0.1:3001:3000` + `research-057.report-ingest.it.spec.ts`（覆盖 21 条 `state_branches`） | Server / Contract |
| T10 | ADR-0065 + `export-openapi` + `nx affected -t generate` | Docs / Contract |
| T11 | guest-proxy 新 location + envsubst 正则 + `render-env.sh` + `verify-guards.sh` 反例断言 + SKILL.md（含 frontmatter description）+ 端到端实证 | Ops |

## Complexity Tracking

| 复杂度来源 | 为何必要 | 更简单的替代为何不够 |
|---|---|---|
| 新增第 11 个 bounded context（5 个机器注册面 + 新 PG schema） | PRD §3.8 与已落成 `alert` ctx 的 §3.5 同级；研报库自评「体量足够独立成篇」（导入 / 存储 / 阅读器 / 版本化四块） | 塞 `marketdata`：`Announcement` 唯一键含必填 `instrumentId` 故不可复用；且会给「可 truncate 重建」的采集底座装上不可重采的用户资产 |
| 两个 controller（本 feature 只实装一个） | PRD §3.8 明写「系统拉取**或**用户手动导入」，app 面已规划 | 单 controller + 系统账号 token：`JwtAuthGuard` 是全站鉴权面，等于把整个 authed API 给 guest |
| PENDING / COMMITTED 两段写 | RAM 策略只给 `oss:PutObject`，孤儿对象清不掉，「查得到」是唯一补救前提 | 单段写：OSS 成功 + DB 失败会留下不可见、不可清、持续吃 40G 配额的孤儿 |
| 上线存在一段 guest-proxy 先于 app 的 502 窗口 | 两条部署链触发条件不对称（push vs `workflow_run`），单 PR 下 guest-proxy **必然先上** | 拆两个 PR 能消掉这段窗口，但窗口本就**不可见**（skill 未重装前无人能用新端点），代价却是违反 §V 字面 + 端口 3001 跨 PR 传递 ⇒ 收益为零 |
| 通道与服务两层各自拒读 | 「服务端没实现」是会被未来某个 PR 悄悄打破的状态 | 只靠服务端不实现：某天有人加了内部 list 端点、路径前缀一样，就直接对 guest 开放了 |
