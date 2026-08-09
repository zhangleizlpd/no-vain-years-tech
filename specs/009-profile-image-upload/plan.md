---
feature_id: 009-profile-image-upload
spec_ref: ./spec.md
status: implemented
created_at: '2026-05-31'
updated_at: '2026-06-01'
adr_refs: ['0024', '0026', '0032', '0035', '0037', '0043', '0045']
orchestrator_compat: '>=0.1.0'
context7_verified:
  # T001 impl-gate (Gate 0.2 Q4) — 2026-06-01, /expo/expo sdk-54 via context7
  - 'expo-image-manipulator@~14.0.8: 用 imperative ImageManipulator.manipulate(uri).resize({width}).renderAsync()→ref.saveAsync({format:SaveFormat.WEBP,compress})（非 hook useImageManipulator，async 流不可用 hook）；SaveFormat.WEBP=webp；manipulateAsync 已 deprecated'
  - 'expo-image@~3.0.11: <Image source={{uri,cacheKey}} contentFit="cover" />；cacheKey 在 ImageSource 上（缩略分尺寸缓存键）'
  - 'expo-image-picker@~17.0.11: launchImageLibraryAsync/launchCameraAsync(options{mediaTypes,allowsEditing,aspect,quality})；requestMediaLibraryPermissionsAsync（web 为 no-op）'
---

# Implementation Plan: 009-profile-image-upload（头像 + 主页背景图 上传 / 显示 / 查看大图 — Aliyun OSS client 直传 PostObject）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `009-profile-image-upload`

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（per 004/006/007/008 先例）。
> 架构基线 = **[ADR-0045](../../docs/adr/0045-object-storage-image-upload.md)**（Aliyun OSS / client 直传 / public-read / OSS IMG / 选图分叉·上传统一）。本 plan **收敛 ADR-0045 的 6 个 Open Question**（见 § ADR-0045 Open Questions 收敛），凭证原语 = **PostObject policy**。承接 007（头像 / 主页背景图占位行已在 main）+ 002（profile hero noop 钩子）。完整调研 + 三方案取舍见 [`docs/private/plans/2026-05/05-31-image-upload-spec-adr-align-and-plan.md`](../../docs/private/plans/2026-05/05-31-image-upload-spec-adr-align-and-plan.md)。

## Summary _(mandatory)_

把 002 profile hero 与 007 资料卡的「头像 / 主页背景图」从 noop / disabled 占位翻为**可上传 / 显示 / 查看大图**的真实闭环。架构 = **client 直传 Aliyun OSS（PostObject 表单直传），后端只签发一次性 scope 受限凭证 + 不碰图片字节**：

1. **凭证签发（server，account ctx）**：authed 用户发起换图 → 后端用 Node `crypto` 算 **PostObject policy**（base64 policy + HMAC-SHA256 V4 签名），policy 内 `starts-with $key` 锁本账号 key 前缀 + `in $content-type` 限图片白名单 + `content-length-range` 限 size + `expiration` 短时效 → 返回 `{ host, objectKey, fields }`，**后端 0 OSS SDK、0 图片字节代理**。
2. **直传 + 落库（client + server）**：client 选图（web/app 分叉）→ resize/compress → `FormData` POST 直传 OSS（web/app 统一）→ 用 `objectKey` 调 confirm 端点 → 后端校验 key 属本账号前缀 + 落 `avatarUrl` / `backgroundImageUrl`（public-read URL，覆盖旧值）→ GET /me 回读。
3. **显示 + 查看大图（mobile）**：落库后 002 hero + 007 资料卡经 OSS public-read URL 显示真实图（缩略走 `?x-oss-process=image/resize` 即时派生）；action sheet「查看」全屏看原图（P2）。

**关键集成 / 回归点**：002 hero 的 `onAvatarPress` / `onBackgroundPress` 当前 = `noop`（`profile.tsx` L298/L314，已留 `accessibilityHint="点击更换"`），本 feature 翻为 action sheet 触发；007 资料卡「头像」「主页背景图」行当前 = `<Row disabled />`（`account-security/index.tsx` L48/L67），翻 active + 右侧缩略。改这两处会触动 007 的 e2e 占位断言（D-gate，见 § 测试与回归）。

## API Contracts _(mandatory)_

| # | Method | Path | Auth | 说明 | trace FR |
|---|---|---|---|---|---|
| **EP1**（新增）| POST | `/api/v1/accounts/me/profile-image/upload-credential` | bearer | body `{ target: 'avatar'\|'background', contentType: string }` → 200 `{ host, objectKey, expiresAt, fields:{ key, policy, signature, OSSAccessKeyId, 'x-oss-...' } }`；后端算 PostObject policy（scope 到 `<target>/<accountId>/<uuid>/` 前缀 + content-type 白名单 + content-length-range + 15min expiration）；ACTIVE 守卫 + 非法 contentType → 400；缺 token → 401；超限 → 429。`issue-upload-credential.usecase.ts`（account ctx）| FR-S02, FR-S05, FR-S06 |
| **EP2**（新增）| PATCH | `/api/v1/accounts/me/profile-image` | bearer | body `{ target: 'avatar'\|'background', objectKey: string }` → 200 返更新后 profile（含 `avatarUrl`/`backgroundImageUrl`）；后端校验 `objectKey` **starts-with `<target>/<accountId>/`**（防越权写他人）+ **HEAD OSS 确认对象存在/类型（必做，D3）** → 落对应字段（覆盖旧值）；key 越权 / 非法 → 4xx 不落库；缺 token → 401。`confirm-profile-image.usecase.ts`（account ctx）| FR-S03, FR-S05, FR-S08 |
| **EP3**（既有，扩展响应）| GET | `/api/v1/accounts/me` | bearer | 复用 002/007/008；`AccountProfileResponse` **新增 `avatarUrl: string \| null` + `backgroundImageUrl: string \| null`**（`get-account-profile.usecase` select 两列）| FR-S04, FR-C04, FR-C06 |

- **契约同步链（Constitution V，active）**：EP1/EP2 新端点 + EP3 扩响应 → `nx run server:export-openapi` → `packages/api-client` regen（`pnpm nx affected -t generate`）→ mobile 消费 typed hook。**server impl + api-client regen + mobile 消费同 PR**（per [api-contract](../../docs/conventions/api-contract.md)）。
- **限流**（FR-S06）：EP1 + EP2 复用既有 `@nestjs/throttler` per-account bucket（沿用 002/007/008 `me-patch` 范式；上传重试可能略频，可单设 `image-upload` bucket，阈值留 impl 微调）；超限 429 + `Retry-After`；限流在加载账号前消费。
- **后端 0 图片字节代理**（SC-007）：EP1 仅返回签名串、EP2 仅收 `objectKey` 字符串 —— CI / review 断言无后端图片上传 / 代理路径（无 multipart body parser 接图片）。
- **⚠️ 签名原语 = OSS V4（OSS4-HMAC-SHA256），非上表 EP1 草拟的 V1 `fields`**（impl 实证修正，2026-06-01）：上表 `fields:{ key, policy, signature, OSSAccessKeyId, ... }` 是 V1 形态，已 provision 的 bucket（`mbw-profile-images`/`cn-shanghai`）只接受 V4，V1 串会 403 SignatureDoesNotMatch。真实 `fields` = `{ key, policy, x-oss-signature-version:'OSS4-HMAC-SHA256', x-oss-credential, x-oss-date, x-oss-signature(hex), success_action_status:'200' }`（V4 三件套同入 policy.conditions + 表单）；签名 = 4 层 HMAC-SHA256 派生 → hex；region 双形态（host 带 `oss-` 前缀 / credential scope 用裸 region）。详 `oss-policy.ts` doc + memory `reference_aliyun_oss_postobject_v4_signature`。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

> Server **0 新 runtime 依赖**（PostObject 签名 = Node built-in `crypto` HMAC-SHA256；objectKey uuid = `crypto.randomUUID()`；`@nestjs/throttler` 已在）。Mobile 引入选图 / 处理 / 显示链 5 个包（首个图片上传 feature，无既有等价）。**新依赖一律 `expo install <pkg>`（非 `pnpm add`）取 SDK-54 对齐版本**（per memory: expo install --fix 残缺 / SDK-54 漂移已修 #183）。

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| `expo-image-picker` | native 选图（相册 / 相机 + `allowsEditing`/`aspect` 裁剪，`aspect` 仅 Android、iOS 恒方形）| [docs.expo.dev/versions/latest/sdk/imagepicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/) — SDK54 内置，managed 兼容，无手写原生码 |
| `expo-image-manipulator` | native resize/compress（`?.resize().saveAsync({format,compress})`；**新 `useImageManipulator` context API vs 旧 `manipulateAsync` 形态须 impl 期 context7 grounding**）| [docs.expo.dev/versions/latest/sdk/imagemanipulator](https://docs.expo.dev/versions/latest/sdk/imagemanipulator/) |
| `expo-image` | public-read URL 显示 `<Image>` + `cacheKey` 分尺寸缓存（缩略走 OSS `?x-oss-process`）| [docs.expo.dev/versions/latest/sdk/image](https://docs.expo.dev/versions/latest/sdk/image/) |
| `react-easy-crop` | **web-only** JS 裁剪（`<input type=file>` 后自由 aspect）；`Platform.OS==='web'` 条件引入，native 不打包 | [npmjs.com/package/react-easy-crop](https://www.npmjs.com/package/react-easy-crop) — web-DOM only，已确认不支持 RN-native |
| `expo-file-system`（**可选**）| native 上传进度（`uploadAsync`/`createUploadTask`）；若仅需无进度上传则 **RN `fetch` + `FormData {uri,name,type}` 零此依赖** | [docs.expo.dev/versions/latest/sdk/filesystem](https://docs.expo.dev/versions/latest/sdk/filesystem/) — 进度需求未定则不引 |
| `react-native-reanimated` / `expo-crypto` | 查看大图 pinch-zoom / （如需）随机 —— **已在 deps（~4.1.7 / ^15.0.9）**，0 新增 | `apps/mobile/package.json` L54 / L36 实证 |

**Gate 0.2 — Vendor 6Q（新增 5 mobile 包）**：

| # | Question | Answer |
|---|---|---|
| Q1 长期维护 | expo-* 官方一方包随 SDK 维护；react-easy-crop 125k+ wk-dl、活跃 | ✅ |
| Q2 既有等价 | 无 —— 首个图片上传 feature，mono 无既有选图 / 裁剪 / OSS 上传设施（grep 实证） | 无替代 |
| Q3 栈兼容 | expo-image-picker/manipulator/image/file-system = Expo SDK54 一方包、managed/EAS 兼容、**无手写原生码**（区别于 STS 方案的 `aliyun-oss-react-native` 原生模块 —— PostObject 正因此避开）；react-easy-crop web-only、`Platform.OS` 门 | ✅ |
| Q4 LLM 覆盖 | expo-* API 训练覆盖好但 SDK54 有 **API 形态漂移**（expo-image-manipulator context API / expo-file-system File 类）→ **impl 期 context7 grounding 必做**（填 frontmatter `context7_verified`）| ⚠️ impl-gate |
| Q5 解耦成本 | 上传层封一个 `useProfileImageUpload` hook + 选图层 `Platform.OS` 分叉，替换选图/裁剪库 < 1 天 | 低 |
| Q6 风险面 | 全 MIT / 国内可用；react-easy-crop web-only 不入 native bundle；无已知 CVE | 低 |

**Evidence**: package.json grep（server 0 新 deps / mobile 缺 5 包 / reanimated+crypto+throttler 已在）+ 调研 doc `docs/private/plans/2026-05/05-31-image-upload-spec-adr-align-and-plan.md`（阿里云 OSS 官方 docs + Expo 官方 docs）。**context7_verified 待 impl 期补**（expo-image-manipulator / expo-file-system / expo-image API 形态）。

## Constitution Check _(mandatory)_

通过，无违反。

| 原则（`.specify/memory/constitution.md`） | 状态 | 备注 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ | spec ✅ → clarify ✅（2026-05-30 记入 spec `## Clarifications`）→ plan（本）→ tasks → analyze → implement |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ | server：Testcontainers IT 红绿（凭证 policy 逐字段断言 / confirm 前缀校验 + 越权拒 / 落库 + GET 回读 / 401 / 429，cwd=apps/server `nx test server` per memory `testcontainers_spec_run_via_nx_cwd`）；upload-credential policy 构造 + key 命名 + `confirm` 前缀校验为纯函数 → vitest（`account.rules.spec.ts` 扩 / 新 `oss-policy.spec.ts`）；mobile：Playwright Expo Web e2e（web 换图全链，mock 凭证 + OSS POST + confirm）。native picker 路径 = 设备 / 手动（SC-006 缺口显式标注） |
| III. Atomic 30min-2h + 独立 commit | ✅ | server + api-client regen + mobile **同 PR**（Constitution V），分多 commit |
| IV. Module Boundary（扁平 + 贫血 + 护城河） | ✅ | `avatarUrl`/`backgroundImageUrl` = **account ctx 核心字段**（直改 account 表 row → account 模块，无跨 context）；两 use case 直注 `PrismaService`、读写自己 ctx 表、**无 Moat 跨界**；PostObject 签名 = 纯函数 helper（`oss-policy.ts`，Node crypto，无 class / 无 Repository / 无 Entity Mapper，per ADR-0043）。**bounded-context 落点 = account**（见 § ADR-0045 OQ6 + Operation Catalog 待补行）|
| V. 类型同步链 Nx-driven | ✅（active） | EP1/EP2 新端点 + EP3 扩响应 → openapi 变 → api-client regen → mobile 消费 typed，**同 PR** |

## Architecture Notes _(mandatory)_

> ⚠️ ADR-0043「Flat + Anemic + Moat」强制：所有 server 文件平铺 `apps/server/src/account/`，无 `domain/`/`infrastructure/` 子目录；数据 = 贫血 Prisma row（`@map` snake_case）；无 Repository / Entity class；不写 `tx.<otherTable>.*`。

### Server（account ctx，2 端点 + 2 字段 + OSS policy helper）

- **Schema（expand，per ADR-0035）**：`apps/server/prisma/schema.prisma` Account 加 `avatarUrl String? @map("avatar_url")` + `backgroundImageUrl String? @map("background_image_url")`（可空，存 OSS public-read base URL，**镜像既有 `displayName`/`bio` 可空列范式**）。`migrate dev` 产 migration（纯加两可空列 = 安全 expand，无 contract 阶段）。
- **OSS 配置（新 `oss.config.ts`，镜像 `sms.config.ts`）**：env 注入 `OSS_REGION`（如 `oss-cn-hangzhou`）/ `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` —— **凭证治理 per [ADR-0037](../../docs/adr/0037-security-credentials-governance.md)**（最小权限 RAM 子账号、仅 `oss:PutObject` on bucket 前缀；secret 不入码、不入日志、走部署 env）。public base URL 模板 = `https://<bucket>.<region>.aliyuncs.com`。
- **`oss-policy.ts`（新，纯函数，零-class，Node `crypto`）**：`buildPostObjectCredential({ accountId, target, contentType, maxBytes, ttlMs })` → 构造 policy JSON `{ expiration, conditions: [ {bucket}, ['starts-with','$key',`${target}/${accountId}/`], ['in','$content-type', IMAGE_WHITELIST], ['content-length-range', 0, maxBytes] ] }` → base64 → HMAC-SHA256(V4) 签名 → 返回 `{ host, objectKey, fields }`。`objectKey = `${target}/${accountId}/${crypto.randomUUID()}/img`` —— `<accountId>` 段让 policy 锁本账号、`<uuid>` 断 public-read 跨账号枚举（ADR-0045 OQ3）。`IMAGE_WHITELIST = ['image/jpeg','image/png','image/webp']`。**不引 `ali-oss`**（PostObject 仅需 crypto）。
- **`issue-upload-credential.usecase.ts`（新，account ctx 扁平）**：直注 `PrismaService` + `OssConfig`；`findUnique`(accountId) → phone-null 视 not-found → `isActive` 纵深防御 → 校验 `target ∈ {avatar,background}` + `contentType ∈ IMAGE_WHITELIST`（非法 400）→ `buildPostObjectCredential(...)` 返回。**不写 DB、不碰字节**。`maxBytes` 头像 / 背景图可不同（如 5MB），常量留 impl。
- **`confirm-profile-image.usecase.ts`（新，account ctx 扁平）**：直注 `PrismaService` + `OssConfig`；body `{target, objectKey}`；**校验 `objectKey.startsWith(`${target}/${accountId}/`)`**（不符 → `BadRequestException`，防越权写他人，FR-S03）；**HEAD `https://<bucket>.../objectKey`（public-read 免签）确认对象存在 + content-type 合白名单（必做，D3 —— 防 confirm 未真上传的 key 落坏 URL；不存在 / 类型不符 → 拒不落库）**；`publicUrl = `${ossBaseUrl}/${objectKey}`` → `prisma.account.update({ where:{id}, data:{ [target==='avatar'?'avatarUrl':'backgroundImageUrl']: publicUrl } })` → anemic row 返回。覆盖语义（旧 URL 直接覆盖）；**旧 object v1 不删**（FR-S08，留 OSS Lifecycle 后续）。
- **DTO**：`IssueUploadCredentialRequest`（`@IsIn(['avatar','background']) target` + `@IsString() contentType`）；`ConfirmProfileImageRequest`（`target` + `@IsString() objectKey`）。response DTO：凭证响应 `UploadCredentialResponse`（host/objectKey/expiresAt/fields）。
- **Controller**：`account-profile.controller.ts` 注入两 use case + `@Post('me/profile-image/upload-credential')` + `@Patch('me/profile-image')`（镜像 008 `@Patch('me/gender')` 的 throttle + `@ApiResponse` 200/400/401/429 套装 + `@SkipThrottle`/`@Throttle`）。
- **GET /me 扩字段**：`get-account-profile.usecase.ts` select `avatarUrl,backgroundImageUrl`（扩 `*Result`）；`AccountProfileResponse` 加两 `@ApiProperty({ nullable:true, type:'string' })`；controller 各 `return {...}` 补两字段。
- **Bounded context（per [server-bounded-context-catalog](../../docs/conventions/server-bounded-context-catalog.md)）**：Q1 直改 account 表核心字段 → **account ctx**；凭证签发虽是「签名」但为**自身 profile 资产专用**（非通用 platform 凭证）→ 留 account（ADR-0045 OQ6 倾向）。**ship 时必加 Operation Catalog 2 行**（issue-upload-credential / confirm-profile-image，context=account，propagation=none，source PR）。无跨 context import，无 Moat。
- **测试**：`oss-policy.spec.ts`（policy conditions 逐字段 / key 命名含 accountId+uuid / 签名确定性）+ `issue-upload-credential.usecase.spec.ts`（mock prisma：ACTIVE 签发 / not-active / 非法 target/contentType 400 / not-found）+ `confirm-profile-image.usecase.spec.ts`（前缀符 + HEAD 命中 → 落库 / 越权前缀 → 拒 / HEAD 未命中 → 拒 / 覆盖旧值）+ `*.it.spec.ts` Testcontainers（凭证 policy 断言 / confirm 落库 + GET 回读 / 越权 4xx / 401 / 429）。**HEAD 校验（必做）在 IT 走测试边界 mock（注入可 stub 的 object-exists 探针，不真打 OSS）**。**禁 lifecycle mock**（复用既有 authed 守卫，无新 Guard/Filter）。

### Mobile（hero 接线 + 资料卡翻 active + 换图 / 显示 / 查看大图）

- **入口接线**：
  - `profile.tsx`：`onAvatarPress` / `onBackgroundPress` 从 `noop`（L298/L314）→ 打开 action sheet（**仅翻钩子 + 渲染源，不重设计 hero 布局**，per spec Assumptions / 占位 UI 4 边界）。
  - `account-security/index.tsx`：头像（L48）/ 主页背景图（L67）行从 `<Row disabled />` → active（`onPress` 开 action sheet）+ 右侧缩略（`value` 槽放 `<Image>` 或缩略 URL）。**header 注释当前挂「008 资料编辑」名下 → 更新归属到 009**。
- **action sheet**（FR-C01）：「更换」/「查看」/「取消」（参考设计图二）。轻量自建（RN `ActionSheetIOS` web 无等价 → 跨端用既有 Modal/底部卡范式，落点 impl；不引新组件库）。
- **选图层分叉**（`Platform.OS`，FR-C02）：
  - native：`expo-image-picker` `launchImageLibraryAsync` / `launchCameraAsync`（`allowsEditing:true` + `aspect:[1,1]` 头像 / 宽幅背景；**`aspect` 仅 Android、iOS 裁剪恒方形** → 背景图宽幅 iOS 不在 picker 内强裁，显示端 framing 兜，per spec Edge Case）；权限 `requestMediaLibraryPermissionsAsync`/`requestCameraPermissionsAsync`（native-only）。
  - web：`<input type=file accept=image/*>` + `react-easy-crop`（自由 aspect）；**不显示「拍照」、不依赖权限 / cancel 回调挂 UI**（web cancel 不可靠，FR-C02）。
- **resize/compress**（FR-C03）：native `expo-image-manipulator`（resize + `SaveFormat.WEBP` + compress）；web canvas `toBlob('image/webp', q)`。
- **上传层统一**（FR-C03，PostObject）：封 `useProfileImageUpload(target)` hook —— 选图 → resize/compress → 调 EP1 拿 `{host, fields, objectKey}` → 组 `FormData`（先 append `fields.*`、**`file` 字段必须最后**）→ `fetch(host, {method:'POST', body:formData})` 直传（native file=`{uri,name,type}` / web=Blob）→ 成功调 EP2 confirm(`objectKey`) → invalidate `/me`。**忙态单源**（`isUploading`，重复触发忽略，FR-C03）；失败友好提示且 **profile 不脏写**（落库仅在 confirm 成功后，FR-C07）。client 先行拦截非图片 / 超 size（与后端 policy 互为兜底，FR-C08）。
- **显示**（FR-C04/C06）：`expo-image` `<Image source={{ uri }}>`；缩略（hero 头像 / 007 资料卡行）append `?x-oss-process=image/resize,m_lfit,w_200,h_200/format,webp/quality,q_80` + `cacheKey` 分尺寸缓存；hero 背景大图用原图或更大派生。**null 回落 002 既有 emoji / 占位**（不回归，FR-C06）。
- **查看大图**（P2，FR-C05）：action sheet「查看」→ 全屏 Modal + `expo-image` + `react-native-reanimated` pinch-zoom（**零新依赖**，reanimated 已在）；未设图时「查看」置灰 / 不提供（impl 定）。
- **gender/bio 等既有 profile 字段不动**；`avatarUrl`/`backgroundImageUrl` 读经 `useMe()`（单一真相源，与 008 一致，不入 store）。
- **Metro `.js` 陷阱**：新文件相对 import extensionless（ESLint 已拦，per memory）。

### 测试与回归（关键）

- **007 e2e 回归**（must-check，D-gate）：`apps/mobile/e2e/account-security-refactor.spec.ts` 若硬断言「头像 / 主页背景图」行 disabled + `tap({force:true})` 无导航 → 本 feature 翻 active 后**必须同步更新**（从「验无导航」改「→ 开 action sheet」），否则 007 e2e 红。impl 前先 `rg 'force:true|头像|主页背景图' apps/mobile/e2e/account-security-refactor.spec.ts` 核对。
- **新 web e2e**（`apps/mobile/e2e/profile-image-upload.spec.ts`，seed authed + per 007 范式）：点头像 → action sheet「更换」→ `<input type=file>` 注入测试图 → 裁剪 → **mock EP1 凭证 + mock OSS PostObject host(POST) + mock EP2 confirm 200** → 断言 hero 显示真实图（非 👤 emoji）。显示用例：seed `/me` 含 `avatarUrl`/`backgroundImageUrl` → 断言 hero + 007 资料卡渲染真实图 / 缩略；null → 回落占位。查看大图：点「查看」→ 全屏。
  - **必 mock refresh-token 端点**（per memory `authed_business_401_triggers_refresh_interceptor`）：EP1/EP2 是 authed 业务，401 会触发 003 refresh 拦截器 retry-once，不 mock → clearSession 误跳 /login。
  - **Stack 叠屏 locator 陷阱**（per memory `playwright_expo_stacked_screen_locator_collision`）：用 `getByRole` 收窄 + scope 到目标屏。
  - **SC-006 覆盖缺口显式标注**：native `expo-image-picker` 选图 / 相机 / 原生裁剪为设备 / 手动验证（无 web e2e），spec/plan 明记（不假装 web e2e 覆盖 native picker）。
- **Verify**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `generate` 契约链 + `runtime-smoke`）+ server IT 绿 + web e2e 绿。本地跑 runtime-smoke 前先杀 `:3000` 父进程（per memory `nx_serve_respawns_3000_poisons_seed_e2e`）；nx affected 前 `pnpm install --frozen-lockfile` + `prisma generate`（per memory `expo_install_fix_partial_node_modules`）。

## ADR-0045 Open Questions 收敛 _(本 plan 核心 — Gate 0.4)_

| ADR-0045 OQ | 决策 | 理由 |
|---|---|---|
| **OQ1** 凭证原语 | **PostObject policy** | 唯一同时强约束 key前缀+content-type+size+TTL 四项（OSS 服务端校验）；client 零 SDK / 零原生模块（裸 FormData POST，web+RN 统一，Expo-managed 友好）；server 仅 Node crypto 签名、0 OSS SDK。STS 不卡 type/size 且 RN 需原生模块；signed-PUT 不卡 size |
| **OQ2** 自定义域名 + ICP + CDN | **v1 用 OSS 默认 endpoint** | `https://<bucket>.<region>.aliyuncs.com` `<Image>` 内嵌可用，0 备案 / 0 CDN 装配；自定义域名 / CDN 需 ICP 备案 → 推迟（对齐客户端部署备案节奏） |
| **OQ3** bucket 布局 / key 命名 | **单 bucket 多前缀** `avatar/`+`background/`；key=`<target>/<accountId>/<uuid>/img` | bucket 数不计费 / 不影响性能；`<accountId>` 让 policy 锁本账号、`<uuid>`(crypto.randomUUID) 断 public-read 跨账号枚举 |
| **OQ4** 防滥用 | policy `content-length-range`(size)+`in $content-type`(白名单)+15min `expiration`；端点复用 `@nestjs/throttler`；referer 白名单 | size/type 由 OSS 服务端拒（字节不达后端）；referer = **best-effort 兜底**（可伪造，允许空 referer for native），与 public-read 公开语义一致 |
| **OQ5** DB 字段 | `avatarUrl` + `backgroundImageUrl`（Account 可空列，anemic + `@map`）| 自描述、与 main UI copy `homeBackground='主页背景图'` 语义一致；已回写 ADR §OQ5 |
| **OQ6** bounded context | **account 自签** | 为自身 profile 资产签发（非通用 platform 凭证），直改 account 表字段 → account ctx（catalog Q1）；未来多 blob 消费者出现再评估抽 security 共享 infra |

> Gate 0.1 Integration Smoke：server 真启 Testcontainers IT 覆盖 EP1/EP2 + web golden-path Playwright（见 § 测试与回归）。Gate 0.3 Legacy Delta：N/A — mono-native feature，无 Java/meta-repo 迁移痕。

## Open Decisions Resolved（plan→tasks gate review — ⚠️ 请 review）

| # | 决策 | 结论 | gate? |
|---|---|---|---|
| **D1** 凭证原语 | STS / signed-PUT / PostObject | **PostObject**（用户已确认；见 OQ1）| ⚠️ resolved |
| **D2** 端点形态 | 4 端点(头像/背景各一) vs target-param 2 端点 | **target-param 2 端点**（EP1 凭证 + EP2 confirm，`target:'avatar'\|'background'`）—— 流程仅前缀 / aspect 不同，DRY；2 use case 镜像 update-gender 结构 | ⚠️ resolved |
| **D3** confirm 是否 HEAD 校验对象存在 | 信任 client confirm vs HEAD 确认 | **必做 HEAD**（用户 2026-05-31 拍板）：confirm 前 HEAD `publicUrl`（public-read 免签）确认对象真存在 + content-type 合白名单，未命中 / 类型不符 → 拒不落库；防 confirm 未真上传的 key → 落坏 URL。探针接口化（IT 可 stub） | ✅ resolved |
| **D4** maxBytes / TTL 常量 | — | TTL **15min**；maxBytes 头像 / 背景可不同（建议各 5MB）；content-type 白名单 `jpeg/png/webp` —— 常量入 `oss-policy.ts`/config | resolved |
| **D5** 007 e2e 回归 | — | **必核对** `account-security-refactor.spec.ts` 头像/背景图占位断言（翻 active 后改断言）| ⚠️ resolved |
| **D6** 上传 transport | `expo-file-system` vs RN `fetch`+FormData | **优先 RN `fetch`+`FormData{uri,name,type}`（零额外依赖）**；需上传进度 UI 才引 `expo-file-system` —— impl 按 FR-C03 忙态需求定 | resolved |
| **D7** 查看大图库 | 新库 vs 零依赖 | **零新依赖**：`expo-image` + Modal + 已在的 `react-native-reanimated` pinch-zoom；不够再评估 `@likashefqet/react-native-image-zoom` | resolved |
| **D8** 旧 object 清理 | 删 vs 不删 | **v1 不删**（覆盖只更 DB URL；量小成本可忽略）；后续 OSS Lifecycle（`*/archive/*` 前缀或 tag）—— 仅记选项不实装（FR-S08）| resolved |
| **D9** bounded context | account vs security | **account**（见 OQ6）；Operation Catalog 加 2 行 | resolved |
| **D10** gender/displayName mockup drift | — | 视觉精确值 / action sheet 样式 / 查看大图转场留 mockup 回填（类 1 UI，code is truth）；参考设计图二 = 历史留痕不逐 pixel 同步 | resolved |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| — | — | — |

**Note**：2 个可空列（镜像 displayName/bio）+ 2 个端点（凭证签发 + confirm，镜像 update-gender 结构）+ 1 个纯函数 OSS policy helper（Node crypto，0 OSS SDK）+ mobile 选图/上传/显示链（5 新依赖，全 managed 无原生码）。无跨 context、**server 0 新 runtime 依赖**。复杂度中（高于 008，因首引图片上传链 + OSS 配置 + web/app 选图分叉）。

## Performance Budget

- EP1 凭证签发：纯 crypto 签名，无 DB 写（仅 findUnique active check）→ p95 < 50ms。
- EP2 confirm：单行 update + **1 次 HEAD OSS（必做，D3）** → 受 OSS HEAD 时延影响（同区 cn-shanghai 低延迟，~10-30ms）；镜像 002/008 profile PATCH p95 100ms + HEAD 往返。
- EP3 GET /me：扩 2 字段不改既有预算。
- 图片字节：**完全不过后端**（client↔OSS 直传）→ 后端带宽 0 增量。缩略派生在 OSS 边即时算（按需，CDN 后续）。

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

建议 tasks.md 层级（server + api-client regen + mobile 同 PR，per Constitution V；每 task 30min-2h + TDD 红绿 + `[X]` flip）：

- `[Server]` schema：Account 加 `avatarUrl`/`backgroundImageUrl` 两可空列 + `migrate dev` → prisma generate
- `[Server]` `oss.config.ts`（env：region/bucket/AK/SK）+ public base URL 模板（per ADR-0037 凭证治理）
- `[Server]` `oss-policy.ts`（buildPostObjectCredential 纯函数 + IMAGE_WHITELIST + key 命名）→ `oss-policy.spec.ts` 红绿
- `[Server]` `issue-upload-credential.usecase.ts` + DTO + controller `@Post('me/profile-image/upload-credential')` → `*.spec.ts` + IT（policy 断言 / active / 400 / 401 / 429）
- `[Server]` `confirm-profile-image.usecase.ts` + DTO + controller `@Patch('me/profile-image')`（前缀校验 + **HEAD 确认对象存在/类型（必做 D3）** + 落库）→ `*.spec.ts` + IT（落库 / 越权拒 / HEAD 未命中拒 / 覆盖 / 回读）
- `[Server]` GET /me 扩 `avatarUrl`/`backgroundImageUrl`：usecase select + `AccountProfileResponse` 加字段 + controller returns 补 → IT 回读断言
- `[Contract]` `nx run server:export-openapi` + `nx affected -t generate`（api-client regen）→ mobile typed hook
- `[Mobile]` `expo install expo-image-picker expo-image-manipulator expo-image`（+ web `react-easy-crop`）+ context7 grounding API 形态 → 填 frontmatter `context7_verified`
- `[Mobile]` `useProfileImageUpload(target)` hook（选图分叉 + resize/compress + PostObject FormData 直传 + confirm + invalidate /me + 忙态单源）
- `[Mobile]` action sheet + hero 接线（`profile.tsx` noop→开 sheet）+ 007 资料卡翻 active + 缩略显示（`account-security/index.tsx`，更新归属注释）
- `[Mobile]` 显示（`expo-image` + OSS IMG 缩略 param + null 回落）+ 查看大图 Modal（P2，零新依赖）
- `[Mobile-E2E]` 更新 007 `account-security-refactor.spec.ts`（占位翻 active）+ 新 `profile-image-upload.spec.ts`（web 换图全链 mock + 显示 + 查看；mock refresh-token）
- `[Verify]`：`nx affected -t lint typecheck test build runtime-smoke generate` 全绿 + server IT + web e2e
- `[Doc]` server-bounded-context-catalog Operation Catalog 加 2 行（issue-upload-credential / confirm-profile-image，account，none）

预估 task 数：~14-17（server 6-7 + contract 1 + mobile 4-5 + e2e 2 + verify/doc 2）。主要风险 = ① 5 新 Expo 依赖 SDK54 API 形态漂移（impl 期 context7 grounding 必做）② 007 e2e 占位断言回归（D5）③ web e2e mock 三段（凭证 + OSS POST + confirm）+ refresh-token mock ④ OSS 凭证 / CORS 配置（部署侧：bucket CORS 允许 web POST + referer 白名单 + RAM 子账号最小权限，非代码但 ship 前置）。

---

**Plan Version**: 1.0.0 | **Created**: 2026-05-31 | **ID-namespace**: US1-5 / FR-S01..S08 / FR-C01..C08 / SC-001..007
