---
feature_id: 036-ideation-image-annotation
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-25'
updated_at: '2026-06-25'
---

# Tasks: 036-ideation-image-annotation（ideation 图片标注 + 多模态结合 · B2-3 最重段）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `036-ideation-image-annotation` | **设计源**: [B2-3 plan (velvety-pike)](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md)（D1-D3 + 9 facts）+ [ADR-0045](../../docs/adr/0045-object-storage-image-upload.md)（OSS 直传）+ [ADR-0058](../../docs/adr/0058-server-integrations-layer.md)（平台层）+ [mockup](./design/)（代码是真相源，不逐 pixel 同步）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带（Setup/Foundational/Polish 不带）；层 = `[Spike]` / `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（pin reducer / 合成文字 / 坐标映射 / 错误映射）= vitest 无 DB；server 端点 + UC = **Testcontainers PG+Redis + fake-llm/fake-oss**（`overrideProvider`，`nx test server <file>`，cwd=apps/server）；真 M3 视觉 / 真 OSS 直传 IT 走 **env-gated**（默认 skip）；mobile 纯逻辑 = vitest，UI·render·a11y·手势 = Playwright Expo Web e2e（图片选取/展平/ASR 经 seam，OSS+turn 经 `route.fulfill`）
- 无 task-meta JSON（**manual 模式**，per 004-035）
- 🚨 **接 stub，不重建骨架**：B1（[032](../032-ideation-prd-clarify/spec.md)）SSE 澄清闭环 + B2-1（[033](../033-ideation-multimodal-input-shell/spec.md)）输入栏 chrome（含图片暂存/缩略 + `imageSendComingSoon` 占位）+ B2-2（[035](../035-ideation-voice-input/spec.md)）一次性 ASR 已 ship。本 feature **只把图片占位接成真功能**（直传 + 标注 + 多模态发送），**不动**澄清骨架与既有 turn/SSE/纯文本路径
- 🚨 **OSS 凭证 = 平台 integration（D3，ADR-0058 同构 `integrations/llm|asr`）**：`buildPostObjectCredential`+`oss-policy` 从 `account/` 上移 `integrations/oss/`，**参数化** key-prefix+size（去硬绑 `avatar|background` target 枚举）；account 改消费、**对外 EP 契约零变**；ideation 同源消费、**不碰 account 表**（护城河 §IV.2）。⚠️ **触及 account/ = 平台抽取非 account 行为变更 → PR 明确标注**（stop-signal #4）
- 🚨 **`IdeaAttachment` 首建附件表（ADR-0035 expand）**：只存**烧录图 ossKey** + `annotationsJson`（贫血 Json，pin 坐标+注记编号，无 mapper / 无 Domain Class）+ `kind('image')`，`@@schema("ideation")`，归属随 session accountId；**不存原图**（clarify 决策）。反枚举：他人 sessionId → 字节级一致 404（FR-013）
- 🚨 **`Msg` 多模态向后兼容铁律（fact #4）**：`content` 由 `string` 扩为 `string | MsgPart[]`（`{type:'text'}|{type:'image_url'}`），`toApiMessages` 透传数组；**纯文本路径传 string = 旧形状，行为零回归**（SC-005，既有 032/035 IT+e2e 必绿）
- 🚨 **视觉路由 + send-once（facts #1/#2/#3 + FR-015）**：带图轮强制 `model:'minimax'`（M3 视觉，`clarify-turn.usecase.ts:482` 当前 `'pro'`）；纯文本仍 `'pro'`（DeepSeek 视觉 API 未开放）；`RoutingLlmProvider` 不改。**图只随它那一轮注入 `image_url`**，后续纯文本轮组上下文 **MUST NOT** 重注历史图
- 🚨 **SoM 烧录 + 唯一新依赖（D2 / R2）**：`react-native-view-shot` `captureRef` 把「图 + 编号 pin」展平为单图（否决 skia，见 research.md）。**发送时仅纳入有注记的 pin**（空 pin 既不烧录也不计入合成文字，FR-006 严格 1:1）。⚠️ **新原生依赖 → app rebuild + PR 列 SoM 选型理由**（stop-signal #2）
- 🚨 **新 EP 进 OpenAPI**：api-client **DOES regen**（凭证签发 fn + 带图 turn 字段）；mobile **必须**调生成 fn，**禁手写** fetch/axios（凭证签名后的 PostObject 直传除外 = 复用 profile-image `executeUpload`）
- **单 PR（per Constitution §V）**：`feat(ideation)` —— server（oss 平台抽取 + IdeaAttachment + Msg 多模态 + 凭证 EP + 带图 turn）+ 真 server IT + api-client regen + mobile 消费（上传 + 查看器 + 画布 + 注记 + 烧录发送）+ 两层验证全原子 merge

## Path Conventions

- server 平台层（新）：`apps/server/src/integrations/oss/`（`oss-policy.ts` MOVE-from-account / `oss-credential.usecase.ts` 或 builder / `oss.module.ts` new）；`apps/server/src/account/oss-policy.ts`（→ re-export 或删，调用切平台层）+ `account/issue-upload-credential.usecase.ts`（CHANGE 消费平台层）
- server ideation（新/改）：`apps/server/src/ideation/` 的 `attachment-credential.{controller,usecase,request,response}.ts`（new）+ `clarify-turn.usecase.ts`（CHANGE 接 image + 路由）+ `clarify-turn.request.ts`（CHANGE 加 `attachmentKeys[]?`+`annotationText?`）+ `ideation.module.ts`（CHANGE）
- server LLM 端口（改）：`apps/server/src/integrations/llm/llm-provider.port.ts`（`Msg.content` union）+ `llm-stream.rules.ts`（`toApiMessages` 透传数组）
- schema：`apps/server/prisma/schema.prisma`（`IdeaAttachment` model）+ migration
- server IT：`apps/server/test/integration/ideation-image-attachment.it.spec.ts`（new）
- mobile（新/改）：`apps/mobile/src/ideation/` 的 `use-ideation-image-upload.ts`（new，复用 profile-image）/ `image-annotate/`（`ImageAnnotateCanvas.tsx` / `AnnotationPin.tsx` / `pin-reducer.ts` / `annotation-compose.ts` / `som-flatten.ts` / `pin-crop-preview.ts` new）/ `ClarifyChatScreen.tsx`（CHANGE，删 `imageSendComingSoon`）/ `ideation-copy.ts`（CHANGE）/ `use-ideation-attachments.ts`（复用/小改）
- mobile 路由（新）：`apps/mobile/app/(app)/(tabs)/ideation/image-viewer.tsx` + `image-annotate.tsx`（Expo Router stack）
- e2e：`apps/mobile/e2e/ideation-image-annotation.spec.ts`（new，fake picker/flatten/ASR seam + `route.fulfill`）；contract-smoke `apps/mobile/e2e/contract-smoke/ideation-image.contract.ts`（new）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL` + `MARKETDATA_PROVIDER=mock`**

---

## Phase 0: Spike — M3 视觉多模态端到端 PoC（env-gated，velvety-pike flagged）

**Goal**：facts #1/#3 已核 M3 原生 `image_url`，但 M3 adaptive 思考 + 视觉的实测延迟/稳定性未验。引库/大改前最小验证多模态 content parts 经 `minimax.provider` round-trip。

- [X] T001 [Spike] [Server] **M3 视觉 round-trip PoC（env-gated，默认 skip）**：最小脚本 / env-gated IT（`RUN_M3_VISION_IT`）喂一张小图 `data:`/public URL + 文字到现有 `minimax.provider.ts`（`model:'MiniMax-M3'`，OpenAI content parts `[{type:'text'},{type:'image_url'}]`）→ 验真返回对焦文本、记录延迟/稳定性。**验**：env-gated 跑通真 M3（需真 key，默认 skip 不入 CI）；结论写 plan/PR（若 M3 视觉延迟/稳定性不可接受 → 停下重评路由）。不阻塞下方 fake-provider 路径

## Phase 1: Foundational — Server `integrations/oss/` 平台层抽取（D3，前置基建，触及 account/）

**Goal**：签名工具上移平台层 + 参数化 key-prefix/size；account 消费、对外契约零变；为 ideation 凭证 UC 铺路。**阻塞所有 US**。

- [X] T002 [Server] **抽 `integrations/oss/` 平台层 + account 改消费（对外契约零变）**：新建 `apps/server/src/integrations/oss/oss-policy.ts`（MOVE `buildPostObjectCredential` + `PostObjectCredentialInput` from `account/oss-policy.ts`），**参数化** `keyPrefix: string` + `maxSizeBytes: number`（**删**硬绑 `target: 'avatar'|'background'` 枚举，改由调用方传前缀）+ `oss.module.ts`（export builder，platform infra 无护城河注释要求 per ADR-0041/0058）；`account/oss-policy.ts` → 薄 re-export 或删（`issue-upload-credential.usecase.ts` CHANGE 改 import 平台层、传 avatar/background 对应 keyPrefix）。**验**：搬移既有 `oss-policy.spec.ts` 到平台层 + 补「参数化 keyPrefix 反枚举对象键」用例（vitest 红→绿）；account `issue-upload-credential` 既有 IT/单测**零改仍绿**（对外契约不变）；`nx run server:lint`（boundaries：account 可依赖 integrations 平台基座；integrations 不依赖业务 ctx）+ `check-env-sync` 绿

## Phase 2: Foundational — Server `IdeaAttachment` 表 + migration（ADR-0035 expand）

**Goal**：首建附件表（只存烧录图 + annotationsJson）。**阻塞 US1/US3 落库**。

- [X] T003 [Server] **`IdeaAttachment` model + migration（expand 首建）**：`apps/server/prisma/schema.prisma` 加 `model IdeaAttachment { id / sessionId / accountId / ossKey / kind('image') / annotationsJson Json? / createdAt }`，`@@schema("ideation")`，snake_case 由 `@map`；生成 migration（纯增表 expand，无破坏列）。**验**：`prisma migrate` 本地起（`env -u OSS_*` + dev URL）apply 成功；migration 走 expand（无 drop/alter 既有）；`nx run server:build` 绿（Prisma client 含 IdeaAttachment）。**贫血**：无 Domain Class / 无 mapper（raw row）

## Phase 3: Foundational — Server `Msg` 多模态扩展（向后兼容，fact #4）

**Goal**：`content` union + `toApiMessages` 透传数组；纯文本零回归。**阻塞 US1/US3 视觉发送**。

- [X] T004 [Server] **`Msg.content` 扩多模态 + `toApiMessages` 透传（纯文本零回归）**：`apps/server/src/integrations/llm/llm-provider.port.ts`（CHANGE `content: string` → `string | MsgPart[]`，`MsgPart = {type:'text';text:string} | {type:'image_url';image_url:{url:string}}`）+ `llm-stream.rules.ts`（CHANGE `toApiMessages`：content 为数组时原样透传 OpenAI content parts，为 string 时维持旧形状）。**验**：`llm-stream.rules.spec.ts` vitest 补「string content → 旧形状不变（零回归）」+「MsgPart[] → 透传 image_url+text part」两组（红→绿）；既有 llm-stream 单测全绿；typecheck 绿（union 不破既有 caller）

## Phase 4: US1 — Server 凭证 EP + 带图 turn 接入（P1 脊柱）

**Story Goal**：附图 + 打点标注 → 上传烧录图 → 带图轮多模态提交 → 路由 M3 对焦。**Independent Test**：fake-oss 签发 + fake-llm 路由下，POST 凭证签发 scope 正确 + 带图 turn 落库（IdeaAttachment + turn 引用）+ 组多模态 Msg 断言 image_url。

- [X] T005 [US1] [US3] [Server] **ideation 图片上传凭证 UC + EP**：`apps/server/src/ideation/attachment-credential.{request,response,usecase,controller}.ts`（new）—— request 空或 `{contentType}`（`@IsIn(['image/jpeg','image/png','image/webp'])`）；UC `IssueIdeaAttachmentCredentialUseCase` 消费 `integrations/oss/` builder，keyPrefix `ideation/<accountId>/`，size ≤10MB（对齐 M3），**校验 session 归属本 account（他人/不存在 → 404 字节级一致，FR-013）**；controller `POST /api/v1/ideation/sessions/{id}/attachments/credential`（`@UseGuards(JwtAuthGuard)`+`@ApiBearerAuth()`+`@ApiTags('ideation')`，失败 → ProblemDetail 降级 FR-011，不泄 vendor/凭证）+ `ideation.module.ts`（CHANGE 加 UC+controller）。**验**：随 T007 IT（Guard 真 DI lifecycle，不单测隔离）；UC 纯归属/前缀逻辑 `attachment-credential.usecase.spec.ts` vitest
- [X] T006 [US1] [US3] [Server] **clarify-turn 接 image + 视觉路由 + send-once**：`apps/server/src/ideation/clarify-turn.request.ts`（CHANGE 加可选 `attachmentKeys: string[]?` + `annotationText: string?`）+ `clarify-turn.usecase.ts`（CHANGE：有 attachmentKeys → 校验 key 归属本 session/account（否则 404）→ 落 IdeaAttachment 引用 + user turn（与既有 turn 落库同 tx）→ 组多模态 Msg（OSS public URL 注入 `image_url` part + `annotationText` 注入 `text` part）→ **强制 `model:'minimax'`**（替 `:482` `'pro'` 仅对带图轮）；**send-once**：组上下文时仅当前轮注入 image，历史轮图 MUST NOT 重注）。纯文本轮 `attachmentKeys` 空 → 行为零回归（`'pro'` + string content）。**验**：随 T007 IT；合成/路由纯逻辑（带图→minimax / 纯文本→pro / send-once 历史不重注）`clarify-turn.usecase.spec.ts` vitest 可断言

## Phase 5: US1 — Server 真 IT（state_branches 全覆盖）

- [X] T007 [US1] [US3] [Server-IT] **凭证签发 + 带图 turn state_branches 全覆盖 IT**：`apps/server/test/integration/ideation-image-attachment.it.spec.ts`（全 boot Fastify + Testcontainers PG+Redis + `overrideProvider(LLM_PROVIDER)` fake-llm + fake/参数化 oss）覆盖 spec `state_branches`：JWT 有效 200 / 无效 401；凭证签发 scope（keyPrefix=`ideation/<accountId>/` + content-type 白名单 + size 上限）；**他人 session 凭证/带图 turn → 404 字节级一致**（反枚举）；带图 turn 落库（IdeaAttachment + turn 引用 + annotationsJson）；**带图 turn 重载查询返回 attachment 引用（FR-009 持久化可重展示）**；多模态 Msg 路由断言（fake-llm 收到 `content` 为数组 + `image_url` + `model:'minimax'`）；**纯文本轮零回归**（string content + `'pro'`，既有澄清闭环不变）；**send-once**（含历史带图轮的多轮会话，新纯文本轮上下文不含历史 image_url）；降级（凭证签发失败 / 路由失败 → ProblemDetail 不脏写、不暴 vendor）。**验**：`nx test server <file>` 全绿 + env-gated 真 OSS/真 M3 分支（`RUN_M3_VISION_IT`/`RUN_OSS_IT` 默认 skip）

## Phase 6: US1 — Contract（export-openapi + api-client regen）

- [X] T008 [US1] [Contract] **export-openapi + api-client regen → 凭证 fn + 带图 turn 字段**：per `.claude/rules/api-contract-trigger.md`：`env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL` 跑 `pnpm nx affected --target=generate`（export-openapi → orval `api-client:generate`）→ 生成凭证签发 fn（如 `ideationControllerIssueAttachmentCredential`）+ clarify-turn 新增 `attachmentKeys`/`annotationText` 字段。**验**：`nx run server:export-openapi` openapi.json 含新 POST path + turn 字段；`packages/api-client/src/` 出现凭证 fn + turn 字段类型；typecheck 绿

## Phase 7: US1 — Mobile 上传接线（删占位，复用 profile-image）

- [X] T009 [P] [US1] [US3] [Mobile] **图片上传 hook（复用 profile-image 4 步流）+ 删 `imageSendComingSoon` 占位**：`apps/mobile/src/ideation/use-ideation-image-upload.ts`（new）复用 `profile-image/use-profile-image-upload.ts` 的 `executeUpload`/`buildUploadFormData`/`mapUploadError`，签名 EP 换**生成的** ideation 凭证 fn（T008），上传前 `expo-image-manipulator` 压缩（≤10MB/webp）；`ClarifyChatScreen.tsx`（CHANGE 删 `:209` `fireToast(imageSendComingSoon)` 占位，发送接真上传；**流式态（status==streaming）禁用附件入口（+/缩略图点击）与发送，与既有 send→stop 互斥，FR-014，沿用 035 流式 gate**）+ `ideation-copy.ts`（CHANGE 删 `imageSendComingSoon` copy 孤儿，grep 确认无其它引用）。**验**：`use-ideation-image-upload` 纯逻辑（错误映射 / 压缩参数 / 调生成 fn）vitest（mock 生成 fn）；交互 + 流式禁用走 T015 e2e；typecheck + lint（无悬空 import）

## Phase 8: US1 — Mobile 图片查看器 + 标注画布（手势 + pin overlay，零新依赖）

- [X] T010 [US1] [Mobile] **图片查看器屏 + 标注画布入口（手势缩放/平移 + 落 pin）**：`apps/mobile/app/(app)/(tabs)/ideation/image-viewer.tsx`（new，全屏暗底 + **仅居中「编辑/标注」**，去保存/分享，FR-001，mockup 帧②）`ThumbChip` 点击导航此屏；`apps/mobile/app/(app)/(tabs)/ideation/image-annotate.tsx` + `image-annotate/ImageAnnotateCanvas.tsx`（new，reanimated+gesture-handler 双指捏合缩放/平移 = 零新依赖 fact #7，FR-002，mockup 帧③）；点击图片落**递增编号 pin**（`AnnotationPin.tsx` SVG/绝对定位 overlay，软上限 9 达限轻提示，FR-003，mockup 帧④）；`pin-reducer.ts`（new，pin 增删 + 编号递增 + 软上限 + **坐标锚图片内容坐标**屏↔图坐标映射，纯函数）；**取消/返回 = 丢弃本次 pin/注记本地态、不上传不发送、暂存图保留可重进（FR-012 零副作用）**。**验**：`pin-reducer.spec.ts` vitest（递增编号 / 软上限 9 / 坐标映射缩放后稳定 / 删除 / 取消丢弃本地态零副作用）+ `coord-map` 边界；手势·render·取消 走 T015 e2e（RNGH 在 web 用 mouse 驱动 per memory，缩放回原仍同位）
- [X] T011 [US1] [Mobile] **单点注记输入行（文字 + 周边裁切预览）**：`image-annotate/` 注记输入行组件（new，FR-004 行式布局 `[周边小图块]+[编号 badge]+[文字输入]+[麦克风]`，mockup 帧④）；`pin-crop-preview.ts`（new，`expo-image-manipulator` crop pin 锚点周边为小图块，纯 UI 预览非模型 payload）；文字键入绑该 pin 注记（pin-reducer 扩注记字段）。**验**：注记绑定 / crop 参数计算纯逻辑 vitest；render·a11y（小图块**非 checkbox** 无勾选语义、badge 编号一致）走 T015 e2e

## Phase 9: US1 — Mobile SoM 烧录 + 多模态发送（唯一新依赖 view-shot）

- [X] T012 [US1] [Mobile] **SoM 烧录（view-shot）+ 合成文字 + 带图轮发送**：`package.json`（CHANGE 加 `react-native-view-shot`，**新依赖 → PR 列 SoM 选型 vs skia 否决理由 + app rebuild**，stop-signal #2）；`image-annotate/som-flatten.ts`（new，`captureRef` 把「图 + 编号 pin overlay」展平为单图 → 交 T009 上传 hook）；`annotation-compose.ts`（new，按编号顺序合成 `annotationText`「1：… 2：…」，**仅纳入有注记的 pin**，空 pin 既不烧录也不计入，FR-006 严格 1:1，纯函数）；发送时组「烧录图 ossKey（attachmentKeys）+ annotationText」调**生成的** clarify-turn fn（带图字段，T008）→ 触发 M3 视觉路由（server T006）；`TurnRow`（`ClarifyChatScreen.tsx`）渲染 user turn 图片缩略（`ossThumbUrl` 复用 `profile-image/oss-image.ts`）。**验**：`annotation-compose.spec.ts` vitest（空 pin 丢弃 / 编号顺序 / 1:1 / 全空→无 attachment）；烧录·发送·渲染走 T015 e2e（web 展平经 seam）；典型坐标→烧录真机验证留收尾兜底

## Phase 10: US2 — Mobile 单点注记语音转写（P2，复用 035）

**Story Goal**：pin 注记框点麦克风 → 录音 → 转写落该 pin 注记框可编辑。**Independent Test**：录音 fake seam + transcribe mock 下，pin 注记麦克风 → 面板 → ✓ → transcript 落该 pin 注记框可编辑。

- [X] T013 [US2] [Mobile] **pin 注记语音转写（复用 035 一次性识别 + insert-at-cursor）**：注记输入行麦克风（T011 行内）接 035 `use-ideation-recording` / `transcribeRecording`（`asr-upload.ts`）→ 录音面板（`IdeationWaveform` + ✓/✗，mockup 帧⑤）→ ✓ transcript 经 `insert-at-cursor`（复用不改）落**该 pin** 注记框（插入光标处/追加末尾、不覆盖，FR-005）；空转写/失败 → 轻提示不改写、可重试或改键盘（FR-005/SC-004）；✗ 取消零副作用。**验**：注记框合并/降级纯映射 vitest；录音·面板·a11y 走 T015 e2e（fake recorder seam + `route.fulfill` transcribe）

## Phase 11: US3 — Mobile 仅附图直发（P3，复用同管线）

**Story Goal**：仅附图（不进标注画布）+ 自由文本直接发送（原图 + 文字多模态）。**Independent Test**：附图不进画布 → 输入框写字 → 发送 → 验「原图 + 文字」多模态提交触发回复。

- [X] T014 [US3] [Mobile] **仅附图直发（原图 + 文字，无 pin 烧录）**：`ClarifyChatScreen.tsx`（CHANGE）暂存图未进标注画布 + 输入框有文字 → 发送：原图（无 pin 展平=原图）经 T009 上传 → 组「attachmentKeys（原图）+ 文字」调生成 clarify-turn fn → M3 路由；多张暂存图各上传随轮提交（顺序与缩略条一致，FR-010）。**验**：发送 payload 组装纯逻辑（无 pin → 原图 ossKey + 文本，多图顺序）vitest；走 T015 e2e happy-path（US3 分支）

## Phase 11.5: FR-009 读侧补全（缺口闭合，2026-06-26 user 定夺「闭缺口」）

**Goal**：FR-009「会话重载时该轮图片可重新展示」当前端到端不满足——`IdeaAttachment` 无 `turnId`（附件只挂会话级、无法关联具体轮）+ `SessionTurnResponse` 读侧 DTO 无附件字段（mobile 重载读不到）。T007 ⑤ 仅在 DB 层验落库、未验读路径。本组补全读侧链路使 FR-009 MUST 端到端达成。**阻塞 T015 ⑦冷重载验证**。

- [X] T018 [Server] **`IdeaAttachment` +turnId（expand）+ 带图 turn 写入关联**：`apps/server/prisma/schema.prisma`（`IdeaAttachment` 加 `turnId BigInt? @map("turn_id")` + 索引，expand 纯增列）+ migration；`clarify-turn.usecase.ts`（CHANGE：同 tx 内拿到新建 user turn 的 id → 写到 attachment `turnId`，关联该轮）。**验**：migration expand apply 成功（`env -u OSS_*` + dev URL）；`clarify-turn.usecase.spec.ts` 补「attachment.turnId = 当轮 user turn id」断言；`nx run server:build` 绿；既有 T006/T007 行为不回归
- [X] T019 [Server] [Server-IT] **get-session 投影 per-turn attachments + DTO 扩字段 + IT 补读侧断言**：`get-session.usecase.ts`（CHANGE：join IdeaAttachment by turnId，每 turn 带 `attachments: {ossKey}[]`）+ `session.response.ts`（`SessionTurnResponse` 加 `attachments` 字段，`@ApiProperty` 数组显式 type，投影函数 `toSessionDetailResponse` 填充）+ `ideation-image-attachment.it.spec.ts`（CHANGE 补「`GET /sessions/{id}` 读侧返回带图轮的 attachment ossKey，他人 session 仍 404」断言，**修正 T007 ⑤ 只验 DB 层的不足**）。**验**：IT 全绿（含新读侧断言）；纯文本轮 `attachments` 为空数组（零回归）；typecheck+lint 绿
- [X] T020 [US1] [Contract] **重跑 export-openapi + api-client regen（SessionTurnResponse.attachments）**：per `.claude/rules/api-contract-trigger.md` 重生 openapi.json + orval → `SessionTurnResponse` 含 `attachments`。**验**：openapi.json `SessionTurnResponse` schema 含 attachments 数组；`packages/api-client/src/` 类型更新；typecheck 绿
- [X] T021 [US1] [Mobile] **TurnRow 重载从 server ossKey 渲染历史带图轮缩略（FR-009 端到端）**：`ClarifyChatScreen.tsx`（CHANGE：`TurnRow` 重载态优先用 server 投影的 `turn.attachments[].ossKey` 经 `ossThumbUrl` 出缩略；发送态仍乐观本地 uri，二者择一不重复）。**验**：重载渲染映射纯逻辑（server ossKey → 缩略 / 无附件轮不渲图 / 乐观态 vs 重载态择一）vitest；冷重载真展示走 T015 ⑦ e2e（`route.fulfill` GET sessions 注 attachments）

## Phase 12: 验证（Mobile-E2E + Contract-Smoke）

- [X] T015 [US1] [US2] [US3] [Mobile-E2E] **e2e seam + hermetic UI e2e（标注主干 + 语音 + 仅附图）**：实装 seam —— 图片选取 `globalThis.__NVY_IMAGE_PICKER_E2E__`（返确定性 fixture 图）/ 展平 `globalThis.__NVY_VIEWSHOT_E2E__`（返既定烧录图）/ ASR `__NVY_ASR_RECORDER_E2E__`（复用 035，「仅真模块缺失时启用、生产 bundle 无 `__NVY_*`」铁律）；`apps/mobile/e2e/ideation-image-annotation.spec.ts`（new，Playwright Expo Web，OSS 直传 + 凭证 + turn 经 `route.fulfill` 镜像契约）验：① US1 缩略图 → 查看器 → 编辑 → 落 ≥2 pin（RNGH mouse 驱动）→ 写注记 → 发送 → user turn 现烧录图缩略 + 助手回复；② US2 pin 注记麦克风 → 面板 → ✓ → transcript 落注记框可编辑；③ US3 仅附图 + 文字直发；④ 取消标注零副作用（暂存图保留）；⑤ 降级（`route.fulfill` 注 5xx/abort → 上传失败/对焦失败 toast，会话继续不脏写）；⑥ 流式态附件/send disabled；⑦ 重载会话 → 历史带图轮缩略仍展示（FR-009 持久化重展示）。注：原生烧录/手势/上传真机留收尾兜底（web 视口宽松 per mobile-impl-playbook）
- [X] T016 [US1] [Contract-Smoke] **契约冒烟（凭证签发 + 带图 turn 真 server）**：`apps/mobile/e2e/contract-smoke/ideation-image.contract.ts`（new，node 层，testcontainers 真 server + fake-llm + 参数化/fake oss）：登录 → 类型化 client 调凭证 fn → 断言 scope（keyPrefix/content-type/size）+ 无 JWT 401 + 他人 session 404 → 调 clarify-turn fn（attachmentKeys+annotationText）→ 断言带图 turn 落库 + 契约对齐（path/鉴权/序列化/响应解封）。落 `nx run mobile:contract-smoke`（本地 `MARKETDATA_PROVIDER=mock` 显式）

## Phase 13: Polish — PR gate

- [X] T017 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + boundaries 0 violation（ideation/account 经 `integrations/oss/` 平台基座消费、不碰他 ctx 表、`Msg` union 不破纯文本）+ `[Contract-Smoke]` 绿 + 既有 032/035 e2e+IT 全绿（纯文本/语音零回归 SC-005）+ spec `status: draft→implemented` + tasks.md `[X]` 全同步 + PR body 3 checkbox 部署 gate + **flag「① 新原生依赖 react-native-view-shot 需 app rebuild（R-D 类）+ SoM 选型理由（否决 skia） ② `integrations/oss/` 平台抽取触及 account/（平台层抽取非 account 行为变更，account 契约零变） ③ 真 OSS bucket/CORS + 真 M3 视觉 key 接线 + 真机标注/烧录/上传验证 = 部署/发版前置；auto-merge OFF、建议人工合并」**

---

## Dependencies & 执行顺序

```text
T001(Spike M3 视觉 PoC, env-gated) ─────────────────────────► （信息前置，不阻塞 fake 路径）

Foundational（阻塞 US）:
T002(oss 平台抽取) ─┐
T003(IdeaAttachment 表) ─┼─► T005/T006(US1 server)
T004(Msg 多模态) ─┘

US1 server: T005(凭证 UC+EP) + T006(带图 turn+路由) ─► T007(IT) ─► T008(export-openapi + regen)
US1 mobile: T009(上传接线, 依赖 T008 生成 fn) ─► T010(查看器+画布手势+pin) ─► T011(注记行+裁切) ─► T012(SoM 烧录+发送, 依赖 T008/T009)
  └ T010/T011 的纯逻辑（pin-reducer/坐标/compose）可与 server T002-T007 并行
US2: T013(pin 注记语音, 依赖 T011 注记行) 
US3: T014(仅附图直发, 依赖 T009 上传 + T006 带图 turn)

验证: T012/T013/T014 ─► T015(hermetic e2e) ; T007/T008 ─► T016(contract-smoke)
T002-T016 ─► T017(PR gate)
```

## 并行机会（per phase）

- **Foundational 并行**：T002 / T003 / T004 改不同文件、互不依赖 → 可并行（均阻塞 US1）。
- **跨 stack 并行**：T010/T011 的纯逻辑（pin-reducer / 坐标映射 / annotation-compose）不依赖 server runtime → 可与 T002-T007 并行；上传/发送环节（调生成 fn）依赖 T008。
- **US1 mobile 链**：T009 → T010 → T011 → T012（共享 ClarifyChatScreen / 画布，先后）。
- **US2/US3 增量**：T013（依赖 T011）/ T014（依赖 T009+T006）可在 US1 脊柱后并行接入。

## Implementation Strategy（MVP first）

1. **MVP = US1 脊柱**（T002-T004 foundational + T005-T008 server+regen + T009-T012 mobile）：附图 → 查看器 → 编辑 → 落 ≥2 pin → 写注记 → SoM 烧录上传 → 带图轮路由 M3 → 助手对焦回复。过此即 SC-001/002/003（闭环 + 编号 1:1 + 异常不丢内容）dogfood 成立。
2. **增量 US2**（T013）：pin 注记语音转写（复用 035）。
3. **增量 US3**（T014）：仅附图直发（轻量整图提问）。
4. **收尾**（T015-T017）：hermetic e2e + 契约冒烟 + PR gate。
5. **Clear 检查点批次**（per `.claude/rules/implement-task-closure.md`，每批 ≤5，批后停顿提醒 `/clear`）：建议批次 =〔T001(可选)〕/〔T002-T004 foundational〕/〔T005-T006〕/〔T007〕/〔T008〕/〔T009-T010〕/〔T011-T012〕/〔T013-T014〕/〔T015-T016〕/〔T017〕。

## 部署 / 发版前置（不在本 impl scope）

- **真 OSS 接线**：ideation key 前缀 bucket 策略 + CORS 允许直传（沿用 ADR-0045 account 既有 bucket，平台层参数化前缀）；本 feature 业务 impl + IT/e2e 全走 fake/参数化 oss，真 bucket/CORS 在部署 PR 核。
- **真 M3 视觉接线**：真 MiniMax key + 带图轮真 `model:'MiniMax-M3'` round-trip（T001 Spike env-gated 已验路径）；M3 adaptive 思考 + 视觉延迟/稳定性发版前实测（成本观测）。
- **新原生依赖 rebuild**：`react-native-view-shot` 新原生模块 → dev-client 重 prebuild，否则真机烧录失败（web e2e 经 seam 抓不到）。
- **真机标注验证**：iOS/Android dev-client 各走一遍真图片选取 → 标注 → 烧录 → 真 OSS 上传 → 真 M3 对焦（对齐既有真机验证节奏；坐标/烧录像素精度只有真机能验）。
