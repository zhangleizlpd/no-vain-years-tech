---
adr_id: ADR-0045
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - server 迁出 Aliyun(换云 / 多云) → 对象存储选型(§1)整体重审
  - blob 需求从「小图片(头像/背景图 ≤ 数 MB)」扩张到视频 / 大文件 / 分片续传 / PKM 大附件 → 上传架构(§2)重审(直传机制是否需 multipart / 断点续传)
  - 出现需私密化的图片资产(付费内容 / 私密相册 / 非公开 profile) → 访问模型(§3)从 public-read 重审为 private + 签名 GET
  - 出现实质盗链 / 滥用且 referer 防盗链不足 → 访问模型(§3)+ 防滥用约束重审
  - 海外用户低延迟访问成为硬需求 → CDN / 多区域 / 跨云分发(Open Questions)重审
  - OSS 成本 / 可用性 / 合规出现重大变化 → §1 重审
---

# ADR-0045: 对象存储选型 + Profile 图片上传架构 — Aliyun OSS + client 直传(后端签发凭证) + public-read

- Status: Accepted (2026-05-30)
- Deciders: @zhangleizlpd
- Tags: storage / infra / mobile / image-upload

## Context

[007 账号与安全页级重构](../../specs/007-account-security-refactor/spec.md) 把「头像 / 主页背景图」渲染为占位行,其**上传 / 更换能力**显式移出 007、留独立 feature spec(007 Out of Scope)。该独立 spec 落地前,需先锁定**对象存储选型 + 图片上传架构**这一**平台级、跨模块、近不可逆**决策 —— 它是本 mono **首次引入 blob / 对象存储**,且决策可被后续 blob 需求(PKM 附件 / 用户上传内容等)复用,不该埋在单个 feature 的 plan.md 里。

历史定位:

- [002 account-profile](../../specs/002-account-profile/spec.md) CL-003 当初就把**头像收集推迟到 M2+**,理由明确:「avatar 涉及对象存储(OSS bucket / 上传流 / 缩略图),本期聚焦 displayName 单字段闭环」。本 ADR 即关闭该 deferred scope 的**存储与上传架构半边**(UI / 字段 / 交互留 feature spec)。
- [ADR-0026 后端部署拓扑](0026-backend-deployment-topology.md):server 已上线 Aliyun SWAS(已备案,`api.xiaocaishen.me`)。对象存储选型在此既定云生态内做。
- [ADR-0037 安全凭证治理](0037-security-credentials-governance.md):上传凭证签发遵其凭证最小权限 / 短时效原则。

驱动用例 = profile 头像 / 主页背景图(小图片、低频写、公开展示)。本 ADR 的决策**只覆盖存储 + 上传架构**;web/app 选图分叉、image-picker / 裁剪 / 压缩库选型等 **feature 实现细节**属可逆单 consumer 决策,留未来 spec 的 plan.md(007 Out of Scope 已留调研痕)。

## Decision

### 1. 对象存储 = Aliyun OSS(唯一选型)

- profile 图片(及后续 blob)一律存 **Aliyun OSS**。
- 理由:server 已在 Aliyun(SWAS 已备案),**同云同区低延迟 + 国内访问稳定 + 单一云账单 / 凭证体系**;规避 Cloudflare R2 / AWS S3 的境外 egress → 国内访问链路风险(参 [memory: CF Workers→Aliyun ECS 海外路径 525];[ADR-0025](0025-frontend-cloudflare-pages-expo-web.md) 已暴露 CF→国内链路敏感)。
- OSS 提供 S3 风格能力 + 自有 **PostObject / STS / 签名 URL** 直传机制 + **原生 IMG 图片处理**(见 §4),覆盖本场景所需。

### 2. 上传架构 = client 直传 OSS(后端签发短时凭证 / 签名)

- 标准流:**client 选图 → 向后端要一次性上传凭证 / 签名 → client 直传 OSS → client 用最终 object key 通知后端 → 后端校验并把 URL 落 Account**。后端**不代理图片字节**。
- 理由:省后端带宽、可扩展、web/app **上传层统一**(同一「要签名 → 直传 → 通知」流);符合研究确认的现代最佳实践(presigned / 直传优于后端代理,小中文件场景)。后续 PKM 附件等 blob 需求可复用同架构。
- 安全由**签名约束**承载(scope 到 bucket / key 前缀 / content-type / size / 短时效),非靠后端代理把关。具体凭证原语(**STS 临时凭证 vs signed PUT URL vs PostObject policy**)为 Open Question,留 feature spec 定。
- 上传前 client 端 **resize / compress**(native `expo-image-manipulator` / web canvas),压缩后再传,降存储与流量。

### 3. 访问模型 = public-read bucket

- profile 头像 / 背景图为**公开展示内容** → bucket **public-read**,图片 URL 直接 `<img src>` / `<Image>` 加载,无需每次签 GET。
- 理由:最简、CDN 友好、与「公开 profile」语义一致;避免 private + 每次签名 GET 的显示链路复杂度。
- 配套:**referer 防盗链**兜底(OSS Referer 白名单)防外站盗链;public-read **只授读**,写仍走 §2 签名上传(公开可读 ≠ 公开可写)。

### 4. 图片派生 = OSS 原生 IMG 处理(不自存多尺寸)

- 缩略图 / resize / 格式转换走 **OSS 图片处理(IMG)** 的 URL 参数即时派生(如 `?x-oss-process=image/resize,w_200`),**不**在后端生成并存多份尺寸。
- 理由:零额外存储 / 零派生代码,展示端按需取尺寸(头像列表小图 / 详情大图同一原图派生)。

### 5. web/app 分叉只在选图层,上传层统一(指针,细节留 feature spec)

- 记录方向(实现细节归未来 spec 的 plan.md):选图层 **app** = `expo-image-picker`(相册 / 相机 + 原生裁剪,注意 `aspect` 仅 Android、iOS 裁剪恒方形)、**web** = `<input type=file accept=image/*>`(无相机 / 无原生裁剪)+ JS 裁剪(如 `react-easy-crop`);**上传层 web/app 统一**走 §2。
- 本 ADR 不锁具体 picker / 裁剪库(可逆、单 consumer)。

## Consequences

正面:

- 单云(Aliyun)统一存储 + 凭证 + 账单;同区低延迟、国内稳定。
- 后端不代理字节 → 带宽 / 算力省,扩展性好;上传架构可复用于未来 blob 需求。
- public-read + OSS IMG → 显示链路极简(直接 `<img>`,按需派生尺寸),无签名 GET / 无自存多尺寸代码。

负面 / 成本:

- 需配 OSS **CORS**(允许 web 直传)+ **Referer 防盗链** + 签名凭证签发端点(新 server 表面)。
- public-read → 图片 URL 可被枚举 / 盗链(referer 防护为兜底,非强隔离);若未来需私密资产须按 sunset_trigger 重审。
- 绑定 Aliyun OSS API / 签名语义(非 S3 SigV4 通用);跨云迁移需改签名层(近不可逆,故立 ADR)。
- 直传架构比后端代理多一次 client↔后端往返(要凭证 + 回调通知),实现略复杂。

## Alternatives Considered

| 方案                              | 否决理由                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare R2 / AWS S3**        | S3 兼容 presigned、免 egress 费,但 CF/AWS 境外 egress → 国内访问链路有 525 / 延迟风险(本仓已撞 CF→Aliyun 525);与 server 所在 Aliyun 跨云增运维 / 凭证面。 |
| **后端代理上传(client→后端→OSS)** | 后端可统一校验 / 处理,但代理图片字节、扩展性差、与现代最佳实践背道;头像低量虽可接受,但首次就立直传架构避免未来 blob 扩张时返工。                          |
| **private bucket + 签名 GET**     | 更私密,但 profile 图本就公开 → 语义不符;每次显示要签、CDN 缓存复杂,无收益。                                                                               |
| **后端生成并存多尺寸缩略图**      | 多份存储 + 派生代码 / 任务;OSS 原生 IMG 即时派生零成本替代。                                                                                              |

## Open Questions(留未来「图片上传」feature spec / plan 收敛)

1. **上传凭证原语**:STS 临时凭证 vs signed PUT URL vs PostObject policy —— 三者均 client-直传,选型看 SDK / CORS / 防滥用便利度。
2. **自定义域名 + ICP 备案 + CDN**:OSS 默认 endpoint(`oss-cn-*.aliyuncs.com`)`<img>` 内嵌可用;自定义域名 / CDN 加速需 ICP 备案。v1 是否上自定义域名 / CDN,还是先用默认 endpoint。
3. **bucket 布局 / key 命名**:单 bucket 多前缀(`avatar/` `background/`) vs 多 bucket;key 是否含 accountId / 防猜测随机段。
4. **防滥用**:上传频率限流(复用 throttler)、size / content-type 白名单、签名时效;public-read 盗链 referer 白名单清单。
5. **DB 字段**:Account 加 `avatarUrl` / `backgroundImageUrl`(或独立资产表)—— 属 feature spec/plan(account context,anemic Prisma row per [ADR-0043](0043-server-flat-module-paradigm.md))。字段名由 [009 profile-image-upload spec](../../specs/009-profile-image-upload/spec.md) 定为 `avatarUrl` / `backgroundImageUrl`。
6. **bounded context 落点**:上传凭证签发 use case 归 `account`(profile 资产) vs `security`(凭证签发) —— 按 [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md) 决策(倾向 account:为自身 profile 资产签发,非通用 platform 凭证)。

## Known Issues / 实施修正（2026-06-01，009 实施期发现）

§3「public-read + 默认 endpoint 直接 `<img>` 加载」与 Open Question #2「OSS 默认 endpoint `<img>` 内嵌可用」的**前提被证伪**：

- 阿里云对**中国内地 bucket**（含华东2 上海，2019-09-29 起新建）经**默认域名** `*.oss-cn-*.aliyuncs.com` 访问图片时，强制加 `Content-Disposition: attachment` + `x-oss-force-download: true`（反滥用安全策略，防当免备案图床）。浏览器 `<img>` 拿到「附件」响应无法内联渲染；curl / 服务端 HEAD 探测无视该头（故 confirm / 单测 / Testcontainers IT 全绿，仅真浏览器暴露）。**原生 App（RN Image 走原生网络栈）不受影响 —— 仅 web 受卡。**
- 影响：OQ #2 由「v1 是否上自定义域名」实质收敛为**「内地 bucket 必须绑定自定义域名才能 web 内联显示」**；「先用默认 endpoint」对 web 不成立。
- 解法（不改 §1-4 决策，属实施细节）：bucket 绑定 **ICP 备案** 自定义域名（`img.shintongtech.com`，**网站 ICP 备案 2026-06-19 已通过 + prod 已上线、真机验证内联显示**），显示 URL 改用该域名（默认域名仍用于上传 + V4 签名 scope）。代码侧加可选 `OSS_PUBLIC_BASE_URL`（PR #265，未设回退默认域名）。绑定走 certbot LE + `ossutil put-cname`（自动续期），见 [`ops/runbook/cert-management.md`](../../ops/runbook/cert-management.md)。
- 绑定拓扑（**域名 + OSS 同在账号 B、仅 SWAS 在账号 A**；网站 ICP 备案接入走**账号 B 的 ECS（代号 `app`）**，非账号 A SWAS）+ 配置步骤：[06-01-oss-custom-domain-binding-runbook](../private/plans/2026-06/06-01-oss-custom-domain-binding-runbook.md)（原"跨账号 TXT"假设已作废 —— 域名+OSS 同账号自动加 CNAME）。

## Relationships

- 驱动 / 被引用:[007 account-security-refactor](../../specs/007-account-security-refactor/spec.md)(Out of Scope 留痕指向本 ADR);未来「profile 图片上传」feature spec 将以本 ADR 为 baseline。
- 承接:[002 account-profile](../../specs/002-account-profile/spec.md) CL-003(头像推迟 M2+,因对象存储)。
- 既定语境:[ADR-0026 后端部署拓扑](0026-backend-deployment-topology.md)(Aliyun)/ [ADR-0025 前端 CF Pages](0025-frontend-cloudflare-pages-expo-web.md)(CF→国内链路敏感前例)/ [ADR-0037 安全凭证治理](0037-security-credentials-governance.md)(签名凭证最小权限短时效)/ [ADR-0035 数据层治理](0035-data-layer-governance.md)+[ADR-0043 扁平模块范式](0043-server-flat-module-paradigm.md)(URL 字段落 anemic row)。
