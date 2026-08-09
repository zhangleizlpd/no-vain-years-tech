---
feature_id: 009-profile-image-upload
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-05-31'
---

# Tasks: 009-profile-image-upload（头像 + 主页背景图 上传 / 显示 / 查看大图 — Aliyun OSS client 直传 PostObject）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `009-profile-image-upload`

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）
- `[USx]` = 仅 user-story 阶段 task 带；Setup / Foundational / Polish 不带
- 层 = `[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Verify]` / `[Deploy]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：server = Testcontainers IT + 单元 spec 红→绿（`nx test server` cwd=apps/server，per memory `testcontainers_spec_run_via_nx_cwd`）；mobile 纯逻辑（PostObject policy / upload hook 错误映射）= vitest helper-level；选图/换图/显示/查看屏 = typecheck/lint + **Playwright Expo Web e2e**（= 每 US Independent Test 验收，per mono 测试分层 logic=vitest·UI=Playwright；native `expo-image-picker` 选图路径无 web e2e，SC-006 缺口显式标注）
- 无 task-meta JSON（**manual 模式**，per 004/006/007/008 + orchestrator 暂不用）
- 凭证原语 = **PostObject policy**（server 0 OSS SDK，Node `crypto` 签名；uuid=`crypto.randomUUID()`）；client 裸 `FormData` POST 直传
- Metro 相对 import **extensionless**（ESLint 已拦，per memory `metro_web_cannot_resolve_js_extension_imports`）

## Path Conventions

- server：`apps/server/src/account/`（**扁平平铺**，无 domain/application/infra 子目录，per ADR-0043）；config `apps/server/src/config/oss.config.ts`（镜像 `sms.config.ts`）；schema `apps/server/prisma/schema.prisma`；IT `*.it.spec.ts`
- 契约：`apps/server/openapi.json`（`nx run server:export-openapi`）→ `packages/api-client`（`nx affected -t generate`）
- mobile 入口：`apps/mobile/app/(app)/(tabs)/profile.tsx`（002 hero noop 钩子）+ `apps/mobile/app/(app)/settings/account-security/index.tsx`（007 资料卡占位行）
- mobile app-local：`apps/mobile/src/profile-image/`（新 feature 目录，落点按 [fe-directory-structure](../../docs/conventions/fe-directory-structure.md)：upload hook / 选图分叉 / action sheet / 查看大图 Modal）；复用 `~/core/api/use-me`、`~/theme`、`~/ui`、`~/settings/primitives`
- e2e：`apps/mobile/e2e/`（seed-authed `addInitScript` + zustand-persist `nvy-auth`；mock API `_support/api-mock.ts`，**必 mock refresh-token 端点** per memory `authed_business_401_triggers_refresh_interceptor`；仿 `account-security-refactor.spec.ts`）

---

## Phase 1: Setup — mobile 新依赖（阻塞所有 mobile US）

- [X] T001 [Mobile] `expo install expo-image-picker expo-image-manipulator expo-image`（+ web 裁剪 `pnpm add react-easy-crop` 仅 web 条件引入；可选 `expo install expo-file-system` 仅当需上传进度，per plan D6）——**`expo install` 取 SDK54 对齐版**（apps/mobile，per memory `expo_install_fix_partial_node_modules`：装后 `pnpm install --frozen-lockfile` + `prisma generate`）；**impl 前 context7 grounding** `expo-image-manipulator`（新 `useImageManipulator` context API vs 旧 `manipulateAsync`）+ `expo-image` API 形态 → 回填 `plan.md` frontmatter `context7_verified`（Gate 0.2 Q4）

## Phase 2: Foundational — server OSS infra + schema（阻塞 US1/US2 server + mobile 消费）

- [X] T002 [Server] `apps/server/prisma/schema.prisma` Account 加 `avatarUrl String? @map("avatar_url")` + `backgroundImageUrl String? @map("background_image_url")`（可空，存 OSS public-read base URL，镜像既有 `displayName`/`bio` 可空列；安全 expand 无 contract）→ `nx run server:prisma-migrate`（dev）+ `prisma generate`
- [X] T003 [P] [Server] `apps/server/src/config/oss.config.ts`（镜像 `sms.config.ts`）：Zod 校验 env `OSS_REGION` / `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`（凭证治理 per ADR-0037：最小权限 RAM 子账号、secret 不入码/日志/走部署 env）+ 导出 `ossPublicBaseUrl()` = `https://<bucket>.<region>.aliyuncs.com`。**同 task 加 `apps/server/.env.example` 的 `OSS_*` 契约块 + 本地 `apps/server/.env` 对齐**（否则 `check-env-sync` lefthook 拦 commit —— .env.example 键须在 .env 存在）。env 值/部署侧配置见 `docs/private/plans/2026-05/05-31-oss-provisioning-runbook.md`
- [X] T004 [Server] `apps/server/src/account/oss-policy.ts`（纯函数，零-class，Node `crypto`）：`buildPostObjectCredential({ accountId, target, contentType, maxBytes, ttlMs })` → policy `{ expiration, conditions:[ {bucket}, ['starts-with','$key',`${target}/${accountId}/`], ['in','$content-type', IMAGE_WHITELIST], ['content-length-range',0,maxBytes] ] }` → base64 + HMAC-SHA256(V4) 签名；`objectKey=`${target}/${accountId}/${crypto.randomUUID()}/img``；`IMAGE_WHITELIST=['image/jpeg','image/png','image/webp']`。`oss-policy.spec.ts` 红→绿（policy conditions 逐字段 / key 含 accountId+uuid 防枚举 / 签名确定性 / maxBytes·ttl 生效）

## Phase 3: User Story 1 — 上传凭证签发（P1）[Server]

**Independent Test**（spec US1，Testcontainers）：authed 请求头像/背景图凭证 → 返回 scope 到本账号 `<target>/<accountId>/` 前缀 + content-type 白名单 + size 上限 + 短时效的一次性凭证；缺/失效 token → 401；同账号高频 → 429 + `Retry-After`。

- [X] T005 [US1] [Server] `apps/server/src/account/issue-upload-credential.usecase.ts`（account ctx 扁平，直注 `PrismaService` + `OssConfig`）：findUnique(accountId) → phone-null 视 not-found → `isActive` 纵深防御 → 校验 `target∈{avatar,background}` + `contentType∈IMAGE_WHITELIST`（非法→`BadRequestException`）→ `buildPostObjectCredential(...)` 返回 `{ host, objectKey, expiresAt, fields }`（**不写 DB、不碰字节**）+ `issue-upload-credential.request.ts`（`IssueUploadCredentialRequest`：`@IsIn(['avatar','background']) target` + `@IsString() contentType`）+ controller `account-profile.controller.ts` 注入 + `@Post('me/profile-image/upload-credential')`（镜像 008 `@Patch('me/gender')` 的 `@SkipThrottle`+`@Throttle({'me-patch':{...}})`+`@ApiResponse` 200/400/401/429）。`issue-upload-credential.usecase.spec.ts`（单元 mock prisma：ACTIVE 签发 / not-active / not-found / 非法 target·contentType 400）+ `*.it.spec.ts` Testcontainers（SC-001：policy 逐字段断言含本账号前缀+白名单+size+短时效 / 缺 token 401 / 限流 429 声明在位）。**禁 lifecycle mock**（复用既有 authed 守卫）

## Phase 4: User Story 2 — 确认落库 + GET me 扩字段（P1）[Server + Contract]

**Independent Test**（spec US2，Testcontainers）：authed 提交合法 object key（属本账号前缀）→ 200、`avatarUrl`/`backgroundImageUrl` 持久化、GET me 回读；越权前缀/非法 key → 4xx 不落库；缺 token → 401。

- [X] T006 [US2] [Server] `apps/server/src/account/confirm-profile-image.usecase.ts`（account ctx 扁平，直注 `PrismaService` + `OssConfig`）：body `{target, objectKey}` → **校验 `objectKey.startsWith(`${target}/${accountId}/`)`**（不符→`BadRequestException`，防越权写他人，FR-S03）→ `publicUrl=`${ossPublicBaseUrl()}/${objectKey}`` → `account.update({where:{id},data:{ [target==='avatar'?'avatarUrl':'backgroundImageUrl']: publicUrl }})`（覆盖旧值，anemic row 返回）+ `confirm-profile-image.request.ts`（`ConfirmProfileImageRequest`：`@IsIn target` + `@IsString() objectKey`）+ controller `@Patch('me/profile-image')`（throttle + `@ApiResponse` 200/400/401/429）。**HEAD 校验（必做，D3，用户 2026-05-31 拍板）**：落库前 HEAD `publicUrl`（public-read 免签）确认对象**真存在** + content-type 合白名单，未命中 / 类型不符 → 拒不落库（防 confirm 未真上传的 key → 落坏 URL）；探针**接口化注入**（如 `ObjectExistsProbe`，IT 可 stub，不真打 OSS）。`confirm-profile-image.usecase.spec.ts`（单元：本账号前缀 + HEAD 命中→落库 / 越权前缀→拒 / HEAD 未命中→拒 / 覆盖旧值 / not-active）+ `*.it.spec.ts`（SC-002：合法 key + HEAD 命中→200+持久化、越权 key→4xx 不落库、HEAD 未命中→拒、缺 token→401；HEAD 探针走测试边界 stub 不真打 OSS）
- [X] T007 [US2] [Server] GET /me 扩字段（IT 红→绿）：`get-account-profile.usecase.ts` select `avatarUrl,backgroundImageUrl`（扩 `*Result`）+ `account-profile.response.ts` `AccountProfileResponse` 加两 `@ApiProperty({ nullable:true, type:'string' })` + controller 各 `return {...}`（getProfile / updateDisplayName / updateBio / updateGender / confirmProfileImage）补两字段；IT 断言已设账号 GET /me 回读两 URL、未设为 null（FR-S04）
- [X] T008 [US2] [Contract] `nx run server:export-openapi`（产 `apps/server/openapi.json` 含 EP1/EP2 + GET 扩字段）→ `pnpm nx affected -t generate --base=origin/main`（`packages/api-client` regen）→ 确认 mobile 可 import typed 凭证/confirm/GET hook（Constitution V，server+regen+mobile 同 PR）

## Phase 5: User Story 3 — 更换头像 / 背景图（P1）[Mobile]

**Independent Test**（spec US3，web Playwright）：点头像/背景图 → action sheet「更换」→ `<input type=file>` 注入测试图 → 裁剪 → mock 凭证 + mock OSS PUT/POST + mock confirm 200 → profile hero 显示真实图（非 emoji）。native = 设备/手动（SC-006 缺口）。

- [X] T009 [P] [US3] [Mobile] `apps/mobile/src/profile-image/use-profile-image-upload.ts`：封统一上传流 —— 选图（**`Platform.OS` 分叉**：native `expo-image-picker` `launchImageLibraryAsync`/`launchCameraAsync`（`allowsEditing`+`aspect:[1,1]` 头像 / 宽幅背景，`aspect` 仅 Android、iOS 恒方形）；web `<input type=file accept=image/*>` + `react-easy-crop`，web 不显示拍照/不依赖权限·cancel 回调）→ resize/compress（native `expo-image-manipulator` WEBP+compress / web canvas `toBlob`）→ 调 EP1 拿 `{host,fields,objectKey}` → 组 `FormData`（先 append `fields.*`、**`file` 字段最后**）→ `fetch(host,{method:'POST',body})` 直传（native `{uri,name,type}` / web Blob）→ 调 EP2 confirm → invalidate `/me`；**忙态单源 `isUploading`**（重复触发忽略，FR-C03）；失败友好提示 + profile **不脏写**（FR-C07）；client 先拦非图片/超 size（FR-C08）。逻辑 vitest 红→绿（错误映射 / 忙态锁 / FormData 字段序 / confirm 仅在直传成功后调）
- [X] T010 [US3] [Mobile] 入口接线：`apps/mobile/app/(app)/(tabs)/profile.tsx` `onAvatarPress`/`onBackgroundPress` 从 `noop`（L298/L314）→ 开 action sheet「更换/查看/取消」（轻量自建，跨端用既有 Modal/底部卡范式，不引组件库；**仅翻钩子+渲染源不重设计 hero 布局**）；`apps/mobile/app/(app)/settings/account-security/index.tsx` 头像（L48）/ 主页背景图（L67）行 `disabled`→active（`onPress` 开 sheet）+ 右侧缩略槽；**更新 header 注释归属 008→009**
- [X] T011 [US3] [Mobile-E2E] `apps/mobile/e2e/profile-image-upload.spec.ts` US3 段（seed authed + **mock refresh-token** + mock EP1 凭证 + mock OSS host POST + mock EP2 confirm 200）：点头像 → action sheet「更换」→ `<input type=file>` 注入测试图 → 裁剪 → 上传 → hero 显示真实图（非 👤 emoji）；web 不显示「拍照」。`getByRole` 收窄避叠屏双命中（per memory `playwright_expo_stacked_screen_locator_collision`）

## Phase 6: User Story 4 — profile 显示真实头像 / 背景图（P1）[Mobile]

**Independent Test**（spec US4，web Playwright）：seed `/me` 含 `avatarUrl`/`backgroundImageUrl` → hero 渲染真实图（非 emoji/占位）；007 资料卡头像/背景图行显缩略；null → 回落 002 emoji/占位（不回归）。

- [X] T012 [US4] [Mobile] 显示接入：`profile.tsx` hero 头像/背景图 + `account-security/index.tsx` 资料卡两行用 `expo-image` `<Image>` 渲染 `useMe()` 的 `avatarUrl`/`backgroundImageUrl`；缩略 append `?x-oss-process=image/resize,m_lfit,w_200,h_200/format,webp/quality,q_80` + `cacheKey` 分尺寸缓存（FR-C04）；**null 回落 002 既有 emoji/占位**（不回归，FR-C06）
- [X] T013 [US4] [Mobile-E2E] `profile-image-upload.spec.ts` 显示段（seed `/me` 含/不含 url）：含 url → hero + 007 资料卡渲染真实图/缩略；null → 回落 002 emoji/占位（断言不 crash、不回归）

## Phase 7: User Story 5 — 查看大图（P2）[Mobile]

**Independent Test**（spec US5，web Playwright）：seed 已设图 → action sheet「查看」→ 全屏展示原图、可返回；未设图「查看」处理合理。

- [X] T014 [US5] [Mobile] action sheet「查看」→ 全屏 Modal + `expo-image` + 已在的 `react-native-reanimated` pinch-zoom（**零新依赖**，plan D7）展示当前原图；未设图时「查看」置灰/不提供（impl 定）。`apps/mobile/src/profile-image/image-viewer.tsx`
- [X] T015 [US5] [Mobile-E2E] `profile-image-upload.spec.ts` 查看段：seed 已设图 → 点「查看」→ 全屏展示原图 → 返回回原页

## Phase 8: 回归 + Polish & Verify

- [X] T016 [Mobile-E2E] **007 回归（plan D5）**：`rg 'force:true|头像|主页背景图' apps/mobile/e2e/account-security-refactor.spec.ts` 核对——若硬断言头像/主页背景图行 disabled 占位 + `tap({force:true})` 无导航，本 feature 翻 active 后**必须更新**（改为 `tap()` → 开 action sheet）；不改则 007 e2e 红
- [X] T017 [Deploy] OSS 部署侧配置（非代码，ship 前置）：bucket **CORS** 允许 web `POST`/`PUT`（`AllowedHeader` 含 `Content-Type`、expose `ETag`）+ **Referer 白名单**（`*.<域>` + 允许空 referer for native）+ **RAM 子账号**仅 `oss:PutObject` on bucket 前缀（最小权限 per ADR-0037）+ 部署 env 注入 `OSS_*`（T003）
- [X] T018 [Verify] `pnpm exec nx affected -t lint typecheck test build runtime-smoke generate --base=origin/main` 全绿（含 `generate` 契约链 + `runtime-smoke`；本地跑前先杀 `:3000` 父进程 per memory `nx_serve_respawns_3000_poisons_seed_e2e`；nx affected 前 `pnpm install --frozen-lockfile` + `prisma generate`）+ server IT 绿（`nx test server` cwd=apps/server）+ web e2e 全绿；**SC-007 断言后端 0 图片字节代理**（grep 无 multipart body parser 接图片路径）+ server diff 仅 2 列 + 2 端点 + oss helper（无跨 context import）+ **server-bounded-context-catalog Operation Catalog 加 2 行**（issue-upload-credential / confirm-profile-image，context=account，propagation=none，source PR）

---

## Dependencies & 完成顺序

1. **Phase 1 Setup（T001）= mobile US 前置**：5 新依赖 + context7 grounding；阻塞 T009/T012/T014（mobile）。与 server Phase 2-4 跨栈可并行。
2. **Phase 2 Foundational（T002-T004）= server 前置**：schema + oss.config + oss-policy（纯函数）阻塞 US1（T005）。
3. **Phase 3 US1（T005）**：依赖 T004 policy helper。
4. **Phase 4 US2（T006-T008）**：T006/T007 依赖 T002 schema；T008 契约 regen 依赖 T005+T006+T007 端点就位 → **产 typed hook 供 mobile 消费**（Constitution V）。
5. **Phase 5 US3（T009-T011）**：T009 依赖 T001（deps）+ T008（typed 凭证/confirm hook）；T010 wire 入口（profile.tsx + account-security）；T011 e2e mock 全链。
6. **Phase 6 US4（T012-T013）**：依赖 T008（typed GET /me 含两 url）+ T001（expo-image）；T012 显示接入。
7. **Phase 7 US5（T014-T015）= P2**：依赖 T012 显示就位；不阻塞 P1 闭环。
8. **Phase 8（T016-T018）**：T016 007 回归（T010 翻 active 即触发）；T017 部署侧（与代码并行准备，ship 前必备）；T018 最后全 affected。

**并行机会**：T003（oss.config）与 T002 不同文件可 `[P]`；T009（upload hook）与 server Phase 2-4 跨栈并行；Setup（T001）与 server foundational 并行。e2e（T011/T013/T015）共用 `profile-image-upload.spec.ts`，按 US 分段顺序追加。

## MVP 范围

**最小可交付** = Phase 2-4（server 凭证签发 + confirm 落库 + GET 扩字段 + 契约）+ Phase 1 + Phase 5（US3 换图主路径）+ Phase 6（US4 显示）+ Phase 8 回归/verify。**US5 查看大图（P2）可后置**——不阻塞「上传→显示」核心闭环。

**预估**：18 tasks（setup 1 + server foundational 3 + US1 server 1 + US2 server/contract 3 + US3 mobile 3 + US4 mobile 2 + US5 mobile 2 + 回归/deploy/verify 3）。主风险 = ① 5 新 Expo 依赖 SDK54 API 形态漂移（T001 context7 grounding 必做）② 007 e2e 占位断言回归（T016）③ web e2e mock 三段（凭证+OSS POST+confirm）+ refresh-token mock（T011）④ OSS 部署侧 CORS/referer/RAM 配置（T017，非代码但 ship 前置）⑤ 契约 regen 同步链（T008，Constitution V active）。
