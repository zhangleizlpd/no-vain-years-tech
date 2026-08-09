---
feature_id: 036-ideation-image-annotation
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-25
updated_at: 2026-06-25
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '标注画布依赖原生手势(双指捏合缩放/平移)、图片选取与相机、视图展平截图(Set-of-Mark 烧录)、语音录音——均为原生能力，Web 无对等真实路径。Playwright Expo Web 作 e2e harness：图片选取经 fake picker seam 返确定性 fixture；OSS 直传经 route.fulfill 镜像契约；展平/语音经 seam；验交互骨架(缩略图→查看器→标注画布→落 pin→注记→发送)。原生标注/烧录/上传在 iOS/Android 未冒烟，留真机手动验证；不对用户发布 Web 版。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). 本 feature = 跨端
# (mobile 标注画布 + OSS 直传 + 多模态发送; server integrations/oss 抽取 + IdeaAttachment
# 首建 + Msg 多模态扩展 + 带图轮路由 M3 视觉), 分支为「附件上传 + 标注生命周期 + 多模态发送 + 降级」诸链路.
state_branches:
  - '输入栏图片缩略图点击 → 全屏图片查看器 → 点居中「编辑/标注」→ 进标注画布（双指缩放/平移）'
  - '标注画布上点击图片某处 → 落一个递增编号 pin（1,2,3…）→ 弹该点注记输入（含周边裁切小图块预览）'
  - '单点注记：键盘输入文字 → 保存到该 pin；或点麦克风 → 录音 → 转写 → 文字落该 pin 注记框（复用 035 一次性识别）'
  - '多点标注：多个 pin 各自注记 → 合成「编号 + 注记」结构化标注文字（同编号引用图上 pin）'
  - '发送：标注画布「图 + 编号 pin」展平为单图（Set-of-Mark 烧录）→ 直传 OSS → 拿回 objectKey → 带图轮提交（图片 + 编号合成文字）→ 路由视觉模型 → 助手按既有澄清流程回复'
  - '不打标注直接发送：仅附图（无 pin）→ 展平=原图 → 直传 OSS → 带图轮 + 自由文本 → 视觉模型对焦'
  - '图片选取/相机：申请权限 → 允许则选图带回输入栏暂存缩略；拒绝 → 提示去设置 → 不崩'
  - 'OSS 直传失败（签名/CORS/size 被 OSS 拒/非 2xx）→ 优雅降级：不提交该轮、不脏写对话、一次性「图片上传失败请重试」提示 → 可重试或改纯文字'
  - '上传凭证签发失败（401/未配置 OSS/超时）→ 降级提示，不进入发送、可重试'
  - '视觉模型转写/回复失败（M3 不可达/超时/非 2xx）→ 优雅降级：一次性「对焦失败请重试」提示，不阻断会话、可继续'
  - '标注画布中途取消/返回 → 丢弃本次标注（pin/注记），不上传、不发送、暂存图片保留可重新进入'
  - '会话处于流式澄清回复中（status==streaming）→ 发送/附件入口禁用，不能并发提交（与既有 send→stop 切换互斥）'
---

# Feature Specification: ideation 图片标注 + 多模态结合（B2-3）

> 🎯 **[流程 — 跨端 feature（per [sdd.md](../../docs/conventions/sdd.md)）]**
> **跨端**（mobile 标注画布 + 图片直传 + 多模态发送；server 抽 `integrations/oss/` 平台层 + 首建 `IdeaAttachment` + 扩 `Msg` 多模态 + 带图澄清轮路由 MiniMax-M3 视觉）。impl 走**单 PR**：server impl + 真后端 IT（fake-llm/fake-oss，无外部依赖）+ `@nvy/api-client` **regen**（新增图片上传凭证端点 + 带图 turn 字段）+ mobile 消费同 PR（per [Constitution §V](../../.specify/memory/constitution.md)）。验证落**正交两层**：① `[Mobile-E2E]` hermetic UI e2e（Playwright Expo Web，图片选取/展平/语音经 seam，OSS 直传 + turn 经 `route.fulfill` 镜像契约，验交互骨架）+ ② `[Contract-Smoke]` 契约冒烟（node 层打 testcontainers 真 server，类型化 client 验上传凭证签发 scope + 带图 turn 契约对齐 + 多模态 Msg 路由）。
>
> 📐 **[范围 SoT]** 本 feature = ideation **B2-3 段（B2 最后一段、最重）**，权威基线 = [B2-3 plan](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md) + [B2 拆分 plan B2-3 段](../../docs/private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md) + [PRD灵感 master B2 章](../../docs/private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md)。**交付 = 把 B2-1（[033](../033-ideation-multimodal-input-shell/spec.md)）留下的图片「即将开放」stub 接成真功能**：图片直传 OSS → 在图上打点标注（编号 pin + 每点文字/语音注记）→ 「图 + 编号 pin」展平烧录 + 同编号合成文字随消息发给视觉模型对焦需求，作为一条 ideation 对话轮进入既有澄清闭环。
> **架构（spec 作约束、不重新选型，详见 [B2-3 plan](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md) D1-D3）**：① 标注落图 = **Set-of-Mark prompting**（编号标记烧录进图片 + 同编号文字引用，业内视觉 grounding 事实标准 [arXiv 2310.11441](https://arxiv.org/abs/2310.11441)）；② 视觉模型 = **MiniMax-M3**（原生支持 `image_url` 多模态；DeepSeek V4 视觉 API 未开放 → 带图轮强制路由 M3）；③ 图片存储 = **Aliyun OSS 直传**（[ADR-0045](../../docs/adr/0045-object-storage-image-upload.md) PostObject V4 签名，签名工具抽到 `integrations/oss/` 平台层供 account + ideation 共用）。
> **复用**：OSS 直传 4 步流（`profile-image/use-profile-image-upload.ts`）/ 语音一次性识别（[035](../035-ideation-voice-input/spec.md) `transcribeRecording` + `insert-at-cursor`）/ 图片暂存与缩略（[033](../033-ideation-multimodal-input-shell/spec.md) `useIdeationAttachments` + `ThumbChip`）/ 视觉 provider（`integrations/llm/minimax.provider.ts`）。
> **显式不做**：视频/音频附件入对话（音频仍仅转写，[ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md) 不变）/ DeepSeek 视觉（API 未开放）/ 手绘画笔/箭头标注（仅编号 pin + 文字）/ 归档进 PKM（master 未来 seam）。

## Clarifications

### Session 2026-06-25

- Q: 注记输入条左侧「看着像 checkbox」的元素是什么？ → A: 不是 checkbox，是该 pin **周边的图片小截图** + **蓝色编号 badge**（Manus-style 注记行），无勾选语义（已并入 FR-004）。
- Q: 某轮发了图后，后续纯文字轮是否把图重新发给视觉模型？ → A: **否**——图只随它那一轮发（send-once）。业内最佳实践：图 token 昂贵（单图 ≈ 500–4000 词 / 2k–16k token），重发每轮是反模式；依赖助手把视觉要点落进对话文本，后续轮靠文本上下文。（未来若 M3 支持 prompt caching 可再优化，本期不做。）
- Q: 落了 pin 但没写注记的空 pin 发送时如何处理？ → A: **发送时丢弃空 pin**（无注记=无意图）——只烧录 + 列出有注记的 pin，保「图上标记 ↔ 合成文字编号」严格 1:1（SoM 设计 = mark↔caption 配对，悬空标记是噪声）。
- Q: 图片存原图+烧录图还是只存烧录图？ → A: **只存烧录图**（SoM 展平图）+ `annotationsJson` 元数据；原图留用户设备、不上 OSS（ideation 任务态短生命周期、无重编辑场景、省存储与隐私面）。
- Q: pin 数量上限？ → A: **软上限 9**（单字符编号 1-9，badge 可读；超出给轻提示）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 附图 + 在图上打点标注 + 发给视觉模型对焦 (Priority: P1)

用户在灵感澄清对话里附了一张截图（如一个 App 界面、一处风景照），想就图上**具体位置**提需求。点输入栏的图片缩略图进入全屏查看器，点居中「编辑/标注」进入标注画布；在图片上想说事的位置点一下，落下编号 pin「1」，弹出注记框（带该点周边的小图块预览帮自己确认位置），输入「这里的天空颜色改蓝一点」；再在塔的位置点一下落 pin「2」，注记「塔变成红色」。完成后发送——系统把「图 + 编号 pin」展平成一张带标记的图，连同合成的「1：天空改蓝；2：塔变红」文字一起发给视觉模型，助手据图上标记位置与文字给出对焦后的澄清/需求回应，作为一条对话轮进入既有闭环。

**Why this priority**: 这是 B2-3 的核心价值与最小可用闭环——把「指着图说事」变成视觉模型能精确理解的多模态输入。没有它 B2-3 不成立；有它（即使没有语音/多点边角），用户已能用「图 + 点标注」对焦需求。

**Independent Test**: 在图片选取走 fake picker seam（返确定性 fixture 图）+ 展平走 seam（返既定图）+ OSS 直传走 mock（`route.fulfill` 镜像签名/直传契约）+ turn 走 mock（返助手回复）的环境下，缩略图点击 → 查看器 → 编辑 → 在两处落 pin → 各写注记 → 发送 → 验该轮以多模态形态（图 + 编号文字）提交并触发助手回复。

**Acceptance Scenarios**:

1. **Given** 输入栏已带回一张暂存图片缩略、非流式态，**When** 点击该缩略图，**Then** 进入全屏图片查看器，仅显示一个居中「编辑/标注」按钮（无保存/分享）。
2. **Given** 在图片查看器，**When** 点「编辑/标注」，**Then** 进入标注画布，可双指捏合缩放与平移图片。
3. **Given** 在标注画布，**When** 在图片某位置点击，**Then** 该位置落下一个编号 pin（首个为 1，后续递增），弹出该点注记输入，含该点周边裁切小图块预览。
4. **Given** 注记输入打开，**When** 键盘输入文字并保存，**Then** 文字与该编号 pin 绑定。
5. **Given** 已落 ≥1 个带注记的 pin，**When** 点发送，**Then** 「图 + 编号 pin」展平为单图并直传 OSS、成功拿回访问地址后，该轮以「图片 + 同编号合成文字」多模态形态提交，助手按既有澄清流程回复。
6. **Given** 多个 pin 各有注记，**When** 发送，**Then** 合成文字按编号顺序列出各点注记（`1：… 2：…`），与图上 pin 编号一一对应。

---

### User Story 2 - 单点注记用语音转写 (Priority: P2)

用户在某个 pin 的注记里不想打字，点注记框旁的麦克风，说一段话（如「天空颜色可以改得更蓝一点」），录音结束后转写成文字落入该 pin 的注记框，可再编辑后保存。复用 035 的一次性识别能力。

**Why this priority**: 显著提效（口述比打字快），是「在路上捕获初衷」的延续；但非闭环必需（P1 已可键盘输入），故 P2。

**Independent Test**: 在录音走 fake recorder seam + transcribe 走 mock（返既定 `{text}`）下，pin 注记框点麦克风 → 录音面板 → 确认 → transcript 落该 pin 注记框可编辑。

**Acceptance Scenarios**:

1. **Given** 某 pin 注记框打开，**When** 点麦克风并说话后确认，**Then** 整段转写文字落入该 pin 注记框，处于可编辑态，不自动保存离开。
2. **Given** 注记框已有手敲文字，**When** 完成一段语音转写，**Then** transcript 插入光标处（无焦点则追加末尾），既有内容保留不覆盖。
3. **Given** 转写为空（静音/未识别）或失败，**When** 确认/失败返回，**Then** 给轻提示、不改写注记框、可重试或改键盘。

---

### User Story 3 - 仅附图不打标注直接发送 (Priority: P3)

用户只想把整张图发给助手问个泛的问题（不需要点位标注），附图后直接在输入栏写文字发送，图随消息（原图，无 pin 烧录）+ 文字一起进入多模态对焦。

**Why this priority**: 覆盖「整图提问」的轻量路径，复用同一上传 + 多模态发送管线，成本低；非核心标注价值，故 P3。

**Independent Test**: 附图（不进标注画布）→ 输入框写文字 → 发送 → 验该轮以「原图 + 文字」多模态提交并触发助手回复。

**Acceptance Scenarios**:

1. **Given** 输入栏有暂存图、未进标注画布、输入框有文字，**When** 发送，**Then** 原图直传 OSS、该轮以「图 + 文字」多模态提交，助手回复。
2. **Given** 多张暂存图，**When** 发送，**Then** 各图均上传并随该轮提交（顺序与缩略条一致）。

---

### Edge Cases

- **超大/超规格图片**：超过 size 上限或非白名单类型（仅 JPEG/PNG/WebP）→ client 先拦友好提示，不发上传凭证请求；压缩后再传降低体积。
- **OSS 直传非 2xx**（签名过期/CORS/size 被 OSS 服务端拒）→ 不提交该轮、不脏写对话、一次性提示、可重试。
- **上传凭证签发失败**（401/OSS 未配置/超时）→ 降级提示，不进入发送。
- **视觉模型失败**（M3 不可达/超时/非 2xx）→ 一次性「对焦失败请重试」，不阻断会话。
- **标注画布缩放下落点**：缩放/平移状态下落 pin，pin 锚定图片内容坐标（非屏幕坐标），缩放回原始仍落在同一图片位置。
- **取消标注**：标注画布返回/取消 → 丢弃本次 pin 与注记、不上传不发送，暂存图保留可重进。
- **空注记 pin**：落了 pin 但没写注记 → 该 pin 是否随发送计入由 clarify 定（默认：合成文字只列有注记的 pin，空 pin 仍烧录图上标记）。
- **流式中**：助手正在流式回复（status==streaming）→ 发送与附件入口禁用，避免并发提交。
- **他人会话越权**：对非本账号 session 的图片上传/带图轮 → 字节级一致 404（反枚举，沿用既有 session 归属语义）。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 用户 MUST 能点击输入栏的图片暂存缩略图进入该图的全屏查看器；查看器 MUST 仅呈现一个居中的「编辑/标注」入口（不含保存/分享）。
- **FR-002**: 系统 MUST 提供标注画布，支持对图片双指捏合**缩放**与**平移**。
- **FR-003**: 用户 MUST 能在标注画布上点击图片任意位置落下一个**递增编号** pin（首个为 1，软上限 9——达上限给轻提示、不再新增）；pin MUST 锚定到图片内容坐标（缩放/平移后位置稳定）。
- **FR-004**: 每个 pin MUST 可附一段**注记文字**；注记输入条 MUST 采用「**[周边小截图] + [pin 编号 badge] + [文字输入] + [麦克风]**」行式布局（参考 Manus 注记设计，见 design/IMG_1948）：文字前依次是该点**周边裁切小图块**（pin 锚点附近图片局部截图，帮用户确认所标位置——**非** checkbox/开关，无勾选语义）与**蓝色编号 badge**（与图上 pin 编号一致）。
- **FR-005**: 用户 MUST 能用**语音**为某个 pin 注记（复用 035 一次性识别：录音 → 转写 → 文字落该 pin 注记框可编辑，合并策略=插入光标处/追加末尾、不覆盖既有）。
- **FR-006**: 发送带标注的图时，系统 MUST 把「图片 + 各编号 pin 标记」**展平烧录**为单张图片（Set-of-Mark），并 MUST 生成与图上编号**一一对应**的**合成注记文字**（按编号顺序）。发送时 MUST **仅纳入有注记的 pin**——空注记 pin 既不烧录到图上也不计入合成文字（保「图上标记 ↔ 文字编号」严格 1:1）。
- **FR-007**: 图片（带标注的烧录图 / 未标注的原图）MUST 经 **client 直传对象存储**（后端签发 scope 受限的一次性上传凭证、不代理图片字节，per ADR-0045）；凭证 MUST 限定到本账号在 ideation 域的 key 前缀 + content-type 白名单 + size 上限。
- **FR-008**: 系统 MUST 支持把带图的澄清轮以**多模态**形态（图片访问地址 + 文字）提交，并 MUST 把带图轮路由到**支持视觉的模型**；纯文本轮行为 MUST 零回归（沿用既有澄清闭环）。
- **FR-015**: 图片 MUST 仅随**它所属那一轮**发给视觉模型（send-once）——后续纯文字轮组上下文时 MUST NOT 重新注入历史图片（控 token 成本）；助手对带图轮的回应应把关键视觉观察落进文本，使后续轮靠文本上下文延续。
- **FR-009**: 带图澄清轮 MUST 持久化其图片附件引用（与 session/account 归属一致），使会话重载时该轮的图片可重新展示。
- **FR-010**: 用户 MUST 能仅附图（不打标注）连同自由文本直接发送（原图 + 文字多模态）。
- **FR-011**: 所有失败路径（凭证签发失败 / OSS 直传非 2xx / 视觉模型失败 / 权限被拒 / 超规格图片）MUST 优雅降级：一次性友好提示、不脏写对话、可重试或改用纯文字；MUST NOT 暴露 vendor 细节或泄漏凭证。
- **FR-012**: 标注画布取消/返回 MUST 零副作用（不上传、不发送、不改写暂存图与草稿）。
- **FR-013**: 带图操作 MUST 遵循既有会话归属与反枚举语义（他人 session → 字节级一致 404）。
- **FR-014**: 助手正在流式回复（streaming）时，发送与附件入口 MUST 禁用（与既有 send→stop 互斥）。

### Key Entities _(include if feature involves data)_

- **图片附件（IdeaAttachment）**：一条 ideation 会话内随某用户轮提交的图片。归属本会话/本账号；记录**烧录图**（SoM 展平图）的对象存储访问键、类型（图片）、可选的**标注元数据 `annotationsJson`**（各编号 pin 的图片内容坐标 + 注记文字）。**只存烧录图 + 元数据，不存原图**（原图留用户设备）。与会话/轮逻辑关联（关系完整性由用例保证，沿用 ideation 既有无声明 FK 体例）。
- **澄清轮（IdeaTurn，既有）扩展**：用户轮可引用一或多个图片附件 + 携带（标注合成）文字，构成多模态输入。
- **上传凭证（瞬态，非持久实体）**：后端为单次上传签发的 scope 受限对象存储直传凭证（key 前缀 + content-type + size + 短时效）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户能在一次会话内完成「附图 → 在图上打 ≥2 个点标注 → 发送 → 收到基于标注位置的助手回应」完整闭环（P1 happy path 端到端可达）。
- **SC-002**: 图片标注发送时，图上 pin 编号与助手收到的合成文字编号**一一对应**（无错位/漏号），抽检 ≥95% 一致。
- **SC-003**: 上传失败/模型失败等异常路径**不丢失**用户已输入内容、不产生脏对话轮，且均给到一次性可理解提示（覆盖 FR-011 列举的全部失败类型）。
- **SC-004**: 用户为单个 pin 用语音注记，从点麦克风到文字落注记框（mock 转写下）≤ 2 步交互（录音 → 确认），与 035 键盘等价可编辑。
- **SC-005**: 纯文本澄清轮（不带图）行为与本 feature 前完全一致（零回归），既有 032/035 e2e 与 IT 全绿。

## Assumptions

- **视觉模型 = MiniMax-M3**：现仓唯一具备 OpenAI 兼容多模态（`image_url`）的已接入模型；带图轮路由到它。DeepSeek V4 视觉 API 未开放，纯文本轮仍走既有默认模型。（基线决策见 B2-3 plan 事实 #1/#2/#3，非本 spec 重新选型。）
- **标注落图 = Set-of-Mark 烧录**：编号标记烧录进图片 + 同编号文字引用，作为给视觉模型的空间 grounding 手段（业内事实标准）。展平用视图截图能力（库选型已在 plan D2 锁定，spec 不涉具体库）。
- **图片存储 = Aliyun OSS 直传**：沿用 ADR-0045（PostObject V4 + public-read + OSS 即时派生缩略 + 自定义域名内联显示）；签名工具抽到平台层供 account + ideation 共用（account profile 上传契约零回归）。**只存烧录图 + annotationsJson 元数据，不存原图**（业内非破坏式「存原图+导出件」是为重编辑工作流，ideation 任务态短生命周期无重编辑 → 不适用；原图留用户设备）。
- **视觉上下文 send-once**：图只随它那一轮发给 M3，后续轮不重发（控 token；图 token 远贵于文本）。助手把视觉观察落进文本承载后续上下文。未来若 M3 支持 prompt caching 再优化。
- **图片规格**：content-type 仅 JPEG/PNG/WebP；size 上限对齐视觉模型限制（≤10MB）；上传前 client 压缩。
- **音频不落库**：语音注记仅转写（复用 035 一次性识别），音频瞬态不持久化（ADR-0061 不变）。
- **暂存与缩略复用 033**：图片选取/相机/本地暂存缩略沿用 B2-1 既有 hook 与组件，本段在其上接「上传 + 标注 + 多模态发送」。
- **目标平台**：iOS/Android 原生为一等公民；Web 仅作 e2e harness（原生能力无对等真实路径，不发布 Web 版）。

## Dependencies

- 既有：[032 文本澄清闭环](../032-ideation-prd-clarify/spec.md)（SSE 澄清轮）· [033 多模态输入壳](../033-ideation-multimodal-input-shell/spec.md)（图片暂存/缩略/+ sheet）· [035 语音输入](../035-ideation-voice-input/spec.md)（一次性识别复用）。
- 平台：[ADR-0045 对象存储上传](../../docs/adr/0045-object-storage-image-upload.md)（OSS 直传基线）· `integrations/llm` MiniMax-M3 provider · `integrations/oss/`（本段从 account 抽取的签名平台层）。
- 基线 plan：[B2-3 plan](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md)（D1-D3 决策 + 复用锚点 + verification）。
