---
feature_id: 033-ideation-multimodal-input-shell
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-22
updated_at: 2026-06-23
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: 'mobile UI 重构 + 图片选择/拍照（系统相册 picker + 相机，复用现有 expo-image-picker）；附件面板为 root RN Modal（bottom-sheet）。原生 picker/相机/权限行为在 iOS/Android 未冒烟；Playwright Expo Web 作 e2e harness（picker 走 mock）；不对用户发布 Web 版。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). 本 feature 为 mobile UI + 本地图片暂存（无后端/无持久化）, 分支为输入栏 + 附件面板交互态.
state_branches:
  - '输入栏文本为空/纯空白 + 无附件 -> 发送按钮禁用 -> 不可发空 turn（保持既有校验）'
  - '输入栏有文本 + 非流式 -> 点发送（按钮栏内）-> 发起澄清轮（既有 SSE 流式行为不回退）'
  - '澄清流式进行中 -> 发送按钮切为停止 -> 点停止 abort（既有 027/030 split-tx stopped 语义保留）'
  - '文本随输入自增长（初始约 2 行 -> 至约 5 行上限）-> 达上限后文本区内部滚动 -> 按钮栏不被挤出、布局不抖'
  - '软键盘弹起 -> 两区布局整体避让上移 -> 文本区与按钮栏均不被遮挡（KeyboardAvoidingView 保留）'
  - '点 + 按钮 -> 打开附件面板（摄像头 / 图片 / 添加文件 / 选择代码库 入口；本段不内嵌实时照片条）'
  - '点 图片 -> 拉起系统相册 picker（expo-image-picker 多选）-> 选定 -> 所选图以本地缩略图带回输入区预览'
  - '点 摄像头 -> 请求相机权限 -> 拍照 -> 所拍图以本地缩略图带回输入区预览'
  - '相册/相机权限被拒 -> 引导去系统设置 -> 不崩、不进入选图/拍照（受限态由系统 picker 自身处理）'
  - '输入区已带回缩略图 -> 点缩略图上的 × -> 移除该附件（不影响已输入文本与其它附件）'
  - '已带回 >=1 缩略图 + 点发送 -> 文本照常发送；图片本段不随消息发送 -> 显式「图片发送即将开放」提示（不静默丢弃）-> 真正随消息上传/发送 defer B2-3'
  - '点 添加文件 / 选择代码库 / 麦克风 -> 「即将开放」toast -> 不触发能力/权限/导航（注：「选择代码库」stub 已于 034 接地接线后 superseded —— 入口改开 RepoPicker，picker 行为见 034；本分支现仅覆盖 添加文件 / 麦克风 两 stub）'
  - '附件面板打开 -> 点遮罩/下滑/系统返回 -> 关闭回到输入栏（不丢已输入文本与已带回缩略图）'
---

# Feature Specification: ideation 多模态输入 UI 壳（B2-1）

> 🎯 **[流程 — 统一 mockup-first（per [sdd.md](../../docs/conventions/sdd.md)）]**
> **mobile-only** feature（零 server / Prisma / api-client / **新依赖**改动；图片选择/拍照复用现有 `expo-image-picker`）。流程：`spec → /speckit-clarify → mockup（design/，input-composer.dc.html 7 帧为 baseline）→ plan（含完整 UI 段）→ tasks → impl`。impl 单 PR（`feat(ideation)`，纯 mobile）。验证落 **`[Mobile-E2E]` hermetic UI e2e**（Playwright Expo Web，picker 走 mock）单层；**无 `[Contract-Smoke]` / server IT**（零 server 改动）。
>
> 📐 **[范围 SoT]** 本 feature = ideation **B2 多模态阶段第 1 段（B2-1）**，详见 [B2 拆分 plan](../../docs/private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md)。**交付 = 输入栏 chrome 重构 + 附件面板 + 「图片类」选择/拍照到本地预览**：图片（系统相册 picker 多选）+ 摄像头（拍照）→ 带回输入区本地缩略图预览（可 × 移除）。**显式 defer**：附件 OSS 上传 + 随消息发送(vision) + 图片标注 + **sheet 内嵌实时照片画廊**（需 `expo-media-library`）→ **B2-3**；语音录制/ASR（麦克风）→ **B2-2**；「选择代码库」拉 catalog + `idea_session.repo` 写入 → **B2-4**；「添加文件」未排期 stub。本段**不动 SSE 澄清闭环**（B1 已 ship，per [032](../032-ideation-prd-clarify/spec.md)），**不引入任何 server / 新依赖**。

## Clarifications

### Session 2026-06-22

- Q: 未启用入口被点击的「即将开放」反馈形态？ → A: 正常可点，点击弹**轻量 toast「即将开放」**（不置灰、不导航、不触发能力）。
- Q: 澄清流式进行中，`+` 与麦克风（stub）是否随流式态禁用？ → A: **照常可点**，仍只弹「即将开放」toast（不联动禁用）。
- Q: 文本输入区高度行为（图1「保留2行」的精确语义）？ → A: 业内主流 chat composer 范式——**初始/最小约 2 行**，随输入**自增长至约 5 行上限**、超出**内部滚动**，composer docked 不浮动遮挡消息。
- Q: 附件面板视觉风格 + 实时照片画廊在 B2-1 怎么处理？ → A: 采 Image-6 **浅色** iOS 风层级；**把图片选择能力（到本地预览）拉进 B2-1**。
- Q: B2-1 / B2-3 的照片流缝切哪里？ → A: **B2-1 做到「选中→带回输入区本地缩略图预览（可 × 移除）」**；OSS 上传 + 随消息发送(vision) + 标注 defer B2-3。
- Q: `+` 面板各入口哪些功能性、哪些 stub？ → A: **图片 + 摄像头 功能性**；**添加文件 + 选择代码库 + 麦克风 stub「即将开放」**。
- Q: 图片附件实现路径（内嵌实时画廊 vs 系统 picker；是否加 expo-media-library）？ → A: **系统 picker + 相机，无新依赖**——图片走 `expo-image-picker` 系统相册 picker（多选）、摄像头走 `launchCameraAsync`，选/拍完带回本地缩略图；**sheet 内不嵌实时照片条**（Image-6 内嵌画廊需 `expo-media-library`，defer B2-3）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 两区输入栏 + 文本闭环不回退 (Priority: P1)

用户在 ideation 澄清会话里，用重构后的**两区输入栏**撰写模糊初衷：上区是更宽敞的自增长多行文本区（初始约 2 行、长到约 5 行上限后内部滚动），下区是按钮栏（左 `+`、右麦克风 + 发送）。发送移入按钮栏后，用户照常多轮发送文字、AI 流式反问——**文本澄清闭环与 B1 完全一致，不回退**。

**Why this priority**: 输入区是所有多模态能力的载体；必须先把两区布局立住且保证既有文本闭环零回退——是 MVP 底线。

**Independent Test**: 开会话，输入多行文字发送，确认 AI 流式回复正常、停止可用、空文本不可发；输入栏为「文本区 + 按钮栏」两区，发送在按钮栏内且与其它图标按钮同尺寸。

**Acceptance Scenarios**:

1. **Given** 一个 open 态澄清会话, **When** 在文本区输入多行初衷并点按钮栏内发送, **Then** 照常发起澄清轮、AI 流式反问（既有 SSE）。
2. **Given** 澄清流式正在进行, **When** 点该按钮, **Then** 停止生成（abort），半成品 turn 保留。
3. **Given** 文本区为空/纯空白且无附件, **When** 尝试发送, **Then** 发送按钮禁用、不发空 turn。
4. **Given** 文本已自增长到约 5 行上限, **When** 继续输入, **Then** 文本区内部滚动，按钮栏不被挤出、布局不抖。

---

### User Story 2 - 选图/拍照 → 本地缩略图带回（功能性） (Priority: P2)

用户点 `+` 打开附件面板（摄像头 / 图片 / 添加文件 / 选择代码库 四入口）。点**图片**拉起系统相册 picker（可多选）、或点**摄像头**拍照，选/拍定后所选图以**本地缩略图**带回输入区预览，可逐个 × 移除。本段**只到本地预览**——OSS 上传与随消息发送给 AI（vision）在 B2-3。

**Why this priority**: 本段核心可演示增量——「能选图/拍照、能在输入框看到并管理缩略图」，把图片附件捕获链路在端上打通，B2-3 只需补上传 + 发送 + 标注。

**Independent Test**: 点 `+` → 图片 → 系统 picker 选 1-2 张（或摄像头拍 1 张）→ 缩略图出现在输入区且可 × 移除；全程不发起网络上传、不把图片发进对话。

**Acceptance Scenarios**:

1. **Given** 附件面板已开, **When** 点图片 → 系统相册 picker 多选 2 张确认, **Then** 2 张本地缩略图带回输入区预览。
2. **Given** 输入区已带回缩略图, **When** 点某缩略图的 ×, **Then** 仅移除该附件，文本与其它缩略图不受影响。
3. **Given** 点摄像头且相机权限已授予, **When** 拍一张照片确认, **Then** 该照片本地缩略图带回输入区预览。
4. **Given** 已带回 >=1 缩略图, **When** 点发送, **Then** 文本照常发送，图片本段不随消息发送、显式提示「图片发送即将开放」（不静默丢弃）。

---

### User Story 3 - 权限边界优雅处理 (Priority: P2)

用户在相机/相册权限**被拒**时点摄像头/图片：系统给出明确、不崩的去系统设置引导，绝不白屏或卡死；相册受限(limited)态由系统 picker 自身呈现。

**Why this priority**: 图片能力一旦功能性进 B2-1，权限态就是真实路径——拒绝/受限必须覆盖，否则首个真机用户即踩。

**Independent Test**: 模拟相机/相册权限被拒 → 点摄像头/图片 → 见去设置引导、不崩、不进入选图/拍照。

**Acceptance Scenarios**:

1. **Given** 相机或相册权限被拒, **When** 点摄像头 / 图片, **Then** 显示去系统设置引导，不崩、不进入拍照/选图。
2. **Given** 相册权限受限(limited), **When** 拉起系统相册 picker, **Then** 由系统 picker 呈现受限选择体验，应用侧不崩、可正常带回所选子集。

---

### User Story 4 - 其余入口 stub（添加文件 / 选择代码库 / 麦克风） (Priority: P3)

附件面板的「添加文件」「选择代码库」与按钮栏的麦克风按钮本段为占位——点击弹「即将开放」toast，不触发任何能力/权限/导航。

**Why this priority**: 让这些入口在布局中定形，后续 B2-2（麦克风→录音/ASR）、B2-4（选择代码库→S2 catalog）只在既有槽位接线、不返工动布局。

**Independent Test**: 点 添加文件 / 选择代码库 / 麦克风，确认各弹「即将开放」toast，且不进入任何能力、不请求权限。

**Acceptance Scenarios**:

1. **Given** 处于附件面板或输入栏, **When** 点 添加文件 / 选择代码库 / 麦克风, **Then** 弹「即将开放」toast，不触发能力/权限/导航。

---

### Edge Cases

- **带图无文本时发送**：发送按钮可用性 + 图片不随消息发送的显式提示（per US2 场景 4，「图片发送即将开放」不静默丢弃）。
- **流式进行中点 stub 入口**：发送为停止态；添加文件/选代码库/麦克风 仍可弹「即将开放」。
- **多选上限 / 受限态**：由系统相册 picker 自身控制与呈现（应用侧不另造画廊/上限逻辑）。
- **附件面板打开期间键盘**：打开面板应先收起键盘，避免与 sheet 叠加冲突。
- **被移除的旧入口**：不得出现连接器图标、聊天气泡图标，以及「连接我的电脑 / 添加技能 / 创建网站 / 制作幻灯片 / 创作图像」等项。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 澄清会话输入栏 MUST 为两区布局——上区多行文本输入（**初始/最小约 2 行**、自增长至约 5 行上限、超出内部滚动、docked 不浮动遮挡消息），下区按钮栏。
- **FR-002**: 发送按钮 MUST 位于按钮栏内，图标尺寸 MUST 与 `+` / 麦克风按钮一致。
- **FR-003**: 文本多轮发送、AI 流式反问、停止生成（abort）、空/纯空白不可发送等既有 B1 文本闭环行为 MUST 保持不变（零回退）。
- **FR-004**: 按钮栏 MUST 含 `+`（左）与 麦克风（右、发送之前）按钮。
- **FR-005**: 点 `+` MUST 打开盖于内容之上的附件面板（bottom-sheet），含 摄像头 / 图片 / 添加文件 / 选择代码库 入口（本段不内嵌实时照片条）。
- **FR-006**: 图片入口 MUST 功能性——拉起系统相册 picker（`expo-image-picker`，支持多选）→ 所选图以**本地缩略图**带回输入区预览。
- **FR-007**: 摄像头入口 MUST 功能性——请求相机权限 → 拍照（`expo-image-picker` `launchCameraAsync`）→ 所拍图以本地缩略图带回输入区预览。
- **FR-008**: 输入区已带回的每个附件缩略图 MUST 可单独 × 移除；移除 MUST NOT 影响已输入文本与其它附件。
- **FR-009**: 相机/相册权限请求 + **被拒** MUST 优雅引导（去系统设置）、MUST NOT 崩溃或误导；相册受限(limited)态由系统 picker 自身处理。
- **FR-010**: 添加文件 / 选择代码库 / 麦克风 MUST 为 stub——点击 MUST 弹「即将开放」toast，MUST NOT 触发文件选择/代码库选择/录音/导航等能力。
- **FR-011**: 本段 MUST NOT 上传附件到对象存储、MUST NOT 把图片随消息发送给 LLM（vision）、MUST NOT 提供图片标注；带回缩略图为**本地 client-only 暂存**（无持久化）；带图发送时图片不被传输且 MUST 显式提示「图片发送即将开放」（不静默丢弃）。
- **FR-012**: 附件面板 MUST 可关闭（遮罩 / 下滑 / 系统返回），关闭 MUST NOT 丢失已输入文本与已带回缩略图。
- **FR-013**: 系统 MUST NOT 展示连接器图标、聊天气泡图标，以及「连接我的电脑 / 添加技能 / 创建网站 / 制作幻灯片 / 创作图像」等条目。
- **FR-014**: 本段 MUST NOT 引入 server / Prisma schema / api-client 改动，MUST NOT 新增第三方依赖——图片选择/拍照复用现有 `expo-image-picker`，**不引入 `expo-media-library`**（sheet 内嵌实时照片条 defer B2-3）。

### Key Entities

- **本地暂存附件（client-only，非持久化）**：用户选/拍后带回输入区的图片，仅以本地 URI + 缩略图形态存在于客户端会话内存态，**不入库、不上 OSS、不进 turn**（持久化/上传在 B2-3）。本段无任何 DB / schema 实体改动。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: B1 文本澄清闭环零回退——既有 ideation 文本流 e2e 100% 仍绿（发送 / 流式 / 停止 / 空校验）。
- **SC-002**: 用户在输入栏一眼可发现并触达 `+`（附件）与麦克风入口（0 额外导航层级）。
- **SC-003**: 选图/拍照带回成功——从 `+` 面板选 >=1 张或拍 1 张后，缩略图在输入区可见且可逐个移除；全程 0 次网络上传、0 次图片入对话。
- **SC-004**: 权限边界 0 崩溃——相机/相册 被拒 态有明确去设置引导，不白屏、不误导。
- **SC-005**: stub 入口（添加文件 / 选择代码库 / 麦克风）点击 1 秒内出「即将开放」反馈，0 次误触发实际能力/权限。
- **SC-006**: 新输入栏在软键盘弹起、文本自增长滚动、附件面板开合、缩略图带回等场景下无遮挡、无溢出、无布局抖动。

## Assumptions

- **「即将开放」反馈形态**已定 = 轻量 toast（见 Clarifications）；toast 视觉在 mockup 阶段细化，复用 `~/ui` 现有原语、不引入新提示库。
- **附件面板**默认 root RN `Modal`（bottom-sheet，浅色 4 入口），参考现有 `ProfileImageActionSheet` 范式；`~/ui` 无通用 BottomSheet 故以 Modal 模拟。
- **图片/拍照复用** `expo-image-picker`（现有依赖，`profile-image` 已用）的 `launchImageLibraryAsync`（多选）/ `launchCameraAsync` + 权限 API；选图纯逻辑（如 `validateImageFile`）可复用，但**不接其上传链路**。
- **不引入 `expo-media-library`**：sheet 内嵌实时照片画廊（mockup frame 3/4/5 的内嵌缩略图条）= B2-3 打磨项，本段以系统 picker 替代。
- **多选上限 / 受限态**交由系统相册 picker 控制，应用侧不另造。
- **图标按钮**抽取统一 `IconButton` 原语供 `+`/麦克风/发送共用（统一尺寸/态/a11y label）。
- **流式态下** stub 入口（添加文件/选代码库/麦克风）仍可点出「即将开放」（无害）。
- **带图发送**的 send 行为（text-only + 图片「即将开放」显式提示）最终交互细节在 plan 阶段定稿（FR-011 已锁不静默丢弃 + 不传输的硬约束）。

## Dependencies

- **B1（032-ideation-prd-clarify）已 ship**：本段在其澄清对话 UI（`ClarifyChatScreen`）上重构输入栏，复用 SSE 流式发送/停止逻辑。
- **`expo-image-picker`（现有依赖）+ `profile-image` 选图逻辑**可复用（仅选图/拍照/权限，不走上传）。
- **后续段接线**（非本段交付）：B2-2 录音/ASR 接麦克风；B2-3 附件 OSS 上传 + 随消息发送(vision) + 图片标注 + sheet 内嵌实时照片画廊（`expo-media-library`）；B2-4「选择代码库」接 S2 索引服务 catalog。
