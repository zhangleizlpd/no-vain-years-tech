---
feature_id: 035-ideation-voice-input
modules: [ideation]
owners: ['@zhangleizlpd']
status: implemented
created_at: 2026-06-23
updated_at: 2026-06-24
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'

# 前端 Web 兼容性 (per ADR-0027). 值域: full | stub | untested | na.
web_compat: untested
web_compat_notes: '语音录音 + 麦克风权限是原生能力，Web 无对等真实路径。无 partial、无 WS。Playwright Expo Web 作 e2e harness：录音经 fake recorder seam（`__NVY_ASR_RECORDER_E2E__` 返确定性 fixture）驱动，HTTP transcribe 经 `route.fulfill` 返 `{text}`（hermetic mock = 契约镜像）；验交互骨架（点 mic → 录音面板 → ✓ 确认 → 文本回填可编辑框 / ✗ 取消零副作用 / 降级 toast）。原生录音在 iOS/Android 未冒烟；不对用户发布 Web 版。'

# AI agent 协作摩擦观察 (per ADR-0024 amend).
agent_friction_observed: false

# 状态机分支穷举 (per ADR-0040 multi-layer test gate). 本 feature = 跨端（mobile 整段录音 nitro-sound + HTTP 上传；server integrations/asr/ + 普通 REST 端点 POST /api/v1/ideation/asr/transcribe）, 分支为「录音生命周期 + 一次性识别 + 降级」诸链路.
state_branches:
  - '点 mic → 申请/已有录音权限 → 进入录音面板（波形随声起伏）→ 点 ✓ 确认 → processing → 整段一次性识别 → transcript 回填输入框（可编辑，不自动发送）'
  - '录音面板点 ✗ 取消 → 零副作用：不产生 transcript、输入框不被改写、不留音频、草稿不变'
  - '首次使用：点击 mic 时申请麦克风权限 → 用户允许 → 进入录音；用户拒绝 → 提示去设置开启 → 不录音、不崩'
  - '✓ 确认后 transcript 为空（静音/未识别）→ 不回填、给“未识别到语音”轻提示 → 会话不受影响'
  - '单段录音达 60s 时长上限 → 自动停止并按 ✓ 确认处理已录内容 → 提示已达上限'
  - '录音中来电/切后台 → 安全停录、按取消处理（无 partial 可收，丢弃本段）→ 释放麦克风、不卡录音中假态'
  - '录音中离开澄清屏/会话切换 → 安全停录、按取消处理（目标输入框已不在场，丢弃本段）→ 释放麦克风'
  - 'ASR 转写失败（DashScope 不可达/超时/鉴权失败/非 2xx）→ 优雅降级：丢弃本段、一次性“转写失败请重试或改用键盘”提示 → 不阻断会话，可继续文字/再次语音'
  - '输入框已有用户手敲文字 → transcript 插入光标处（无焦点则追加末尾），既有内容保留不覆盖（录音中输入框仍可编辑）'
  - '会话处于流式澄清回复中（status==streaming）→ mic 按钮禁用，不能并发起录（与既有 send→stop 切换互斥）'
---

# Feature Specification: ideation 语音输入（听写式 · B2-2）

> 🎯 **[流程 — 跨端 feature（per [sdd.md](../../docs/conventions/sdd.md)）]**
> **跨端**（mobile 整段录音 + HTTP 上传；server 新增 `integrations/asr/` 层 + 普通 REST 端点 `POST /api/v1/ideation/asr/transcribe`）。impl 走**单 PR**：server impl + 真后端 IT（fake-asr provider，无外部依赖）+ `@nvy/api-client` **regen**（新增 REST 端点 → `ideationControllerTranscribe` 类型化 fn）+ mobile 消费同 PR（per [Constitution §V](../../.specify/memory/constitution.md)）。验证落**正交两层**：① `[Mobile-E2E]` hermetic UI e2e（Playwright Expo Web，录音经 fake recorder seam 驱动 + HTTP transcribe 经 `route.fulfill` 返 `{text}`，验交互骨架）+ ② `[Contract-Smoke]` 契约冒烟（node 层打 testcontainers 真 server，类型化 client POST 验 `{text}` 契约对齐 + 200/401）。
>
> 📐 **[范围 SoT]** 本 feature = ideation **B2-2 语音段**，权威基线 = [ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md)（Accepted 2026-06-23，传输决策 **2026-06-24 amendment** 翻案见下）+ [B2 拆分 plan B2-2 段](../../docs/private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md) + [一次性识别 Replan](../../docs/private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md)。**交付 = 把 B2-1（[033](../033-ideation-multimodal-input-shell/spec.md)）留下的 mic stub「即将开放」接成真功能**：点 mic → 录音面板（波形）→ ✓ 确认 → 整段一次性文件识别 → transcript 落输入框可编辑后发送，作为一条 ideation 对话轮进入既有澄清闭环。**架构（spec 作约束、不重新选型）**：听写式 Dictation（非 Voice Mode）/ Provider = DashScope Qwen3-ASR 经 `integrations/asr/` 可换 port（`ASR_PROVIDER` 选择，讯飞/豆包兜底）/ 传输 = **HTTP 一次性文件识别**（整段录音 base64 上传 → server 拼 data-URL → DashScope `qwen3-asr-flash` 同步识别 → 一次性返回整段文字；server 持 key、client 不直连）/ **音频为瞬态字节、过路不落、仅 transcript 落库**。**显式不触发** [ADR-0045](../../docs/adr/0045-object-storage-image-upload.md)（OSS 上传）、**不扩** `Msg` 多模态。**不动**：B1 已 ship 的 SSE 澄清闭环（[032](../032-ideation-prd-clarify/spec.md)）与 B2-1 输入栏 chrome（[033](../033-ideation-multimodal-input-shell/spec.md)）；既有 SSE 传输不被替代（REST transcribe 端点并列新增）。
>
> ⚠️ **drift 订正**：B2 拆分 plan 第 18 行旧措辞「ASR 集成 + **上传 + `IdeaAttachment` 首建**」中的「上传 + IdeaAttachment」已被 [ADR-0061 §5](../../docs/adr/0061-ideation-voice-input-asr.md) 翻案——音频不落、无 OSS、无附件实体。本 spec 以 ADR-0061 为准，**不纳入** upload / `IdeaAttachment` scope。整段录音 base64 上传 ≠ OSS 持久化：服务端只 base64 包裹拼 data-URL，瞬态字节永不落库（FR-012）。

## Clarifications

### Session 2026-06-24

- **交互范式 pivot（实测复读根治 + 参考 Manus 式 AI chat）**：放弃实时流式 partial 吐字，改为**点 mic → 录音面板（波形先平后随声起伏）→ ✓ 确认 / ✗ 取消 → 整段一次性文件识别（无实时 partial）→ transcript 回填可编辑文本框（不自动发送）**。传输由实时流式 WS 改为 HTTP 一次性文件识别（详见 [一次性识别 Replan](../../docs/private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md) + ADR-0061 §2026-06-24 amendment）。下方 Session 2026-06-23 中「partial 显示在哪里」「下滑取消」两条已**作废**（被本 pivot superseded），保留作冻结决策记录。
- Q: 录音中被系统中断（来电/切后台）时如何收尾？（更新） → A: 因无 partial 可收，中断 = 取消——安全停录、丢弃本段、释放麦克风（按 Replan §3 reducer「interrupt → cancel」定调，不再「按已收 partial 定稿」）。

### Session 2026-06-23

- Q: final transcript 落入输入框时，框内已有用户手敲文字如何合并？ → A: 插入当前光标处（无光标则追加末尾），既有文本一律保留、不覆盖。（仍有效——transcript 合并插入策略不变。）
- Q: ~~录音进行中，实时 partial 转写文字显示在哪里？~~ → ~~A: 直接显示在输入框内~~（**作废**：见 Session 2026-06-24 pivot，无 partial）。
- Q: 录音中被系统中断（来电/切后台）时如何收尾？ → A: 按已收 partial 定稿——即停录并把已转写内容当 final 落入输入框（可编辑），等同提前松手；不丢弃。（**已被 Session 2026-06-24 更新覆盖**：无 partial → interrupt = cancel。）
- Q: 单段录音时长上限取多少？ → A: 60 秒（到限自动停止并按 ✓ 确认处理已录内容）。（仍有效。）

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 点录音、看波形、确认整段识别落框可编辑 (Priority: P1)

用户在灵感澄清对话的输入栏，点击麦克风按钮打开录音面板开始说话。面板内有一条波形（先平基线，随声起伏），告知正在录音。用户说完点 ✓ 确认，进入 processing（转写中 spinner），整段录音一次性识别后，完整 transcript 落入输入框。此时用户可像普通键盘输入一样编辑这段文字，确认无误后点发送，文字作为一条用户对话轮进入既有澄清闭环（与键盘输入完全等价）。

**Why this priority**: 这是语音输入的核心价值与最小可用闭环——把口述变成可编辑的需求文字。没有它，B2-2 不成立；有它（即使没有取消/降级），用户已能用语音替代打字描述灵感。

**Independent Test**: 在录音走 fake recorder seam（返确定性 fixture）+ HTTP transcribe 走 mock（`route.fulfill` 返既定 `{text}`）的环境下，点 mic → 见录音面板 + 波形 → 点 ✓ → 见 processing → 见 transcript 落框 → 编辑后点发送 → 该文字作为用户轮进入对话并触发助手澄清回复。

**Acceptance Scenarios**:

1. **Given** 已进入某灵感澄清会话、输入框为空、非流式态，**When** 点击 mic，**Then** 弹出录音面板，波形随声起伏，有正在录音的视觉反馈（波形/计时），输入框保持可编辑。
2. **Given** 正在录音，**When** 点 ✓ 确认，**Then** 录音停止、进入 processing 态（转写中指示），整段识别返回后 transcript 落入输入框且处于可编辑状态，**不**自动发送。
3. **Given** transcript 已在输入框，**When** 用户编辑后点发送，**Then** 编辑后的文本作为一条用户对话轮提交，助手按既有澄清流程回复（与键盘输入路径一致）。
4. **Given** 输入框已有用户手敲的文字，**When** 完成一段语音识别，**Then** transcript 插入当前光标处（无焦点则追加末尾），既有内容保留不被覆盖。

---

### User Story 2 - ✗ 取消 + 首次权限申请 (Priority: P2)

用户说到一半发现说错了，点录音面板上的 ✗ 取消按钮即取消本段：不产生任何 transcript、不改写输入框、不留音频、草稿不变。首次使用语音时，点击 mic 触发系统麦克风权限申请；允许后进入录音，拒绝则提示前往设置开启且不进入录音。

**Why this priority**: 取消是录音交互的标配安全阀（避免误发/错发口述），权限申请是原生录音的硬前置。两者缺失会让 P1 在真实使用中体验受损，但不阻断 P1 的核心闭环，故 P2。

**Independent Test**: ① fake 环境下点 mic 起录 → 点 ✗ 取消 → 校验输入框未变、无 transcript 产生、无 HTTP transcribe 调用；② 模拟权限「拒绝」→ 校验出现去设置提示且未进入录音。

**Acceptance Scenarios**:

1. **Given** 正在录音，**When** 点 ✗ 取消按钮，**Then** 本段被取消——无 transcript、输入框不变、草稿不变、不发起识别请求，有「已取消」反馈。
2. **Given** 首次使用、未授权麦克风，**When** 点击 mic，**Then** 弹出系统权限申请。
3. **Given** 用户拒绝麦克风权限，**When** 再次尝试语音，**Then** 提示前往系统设置开启权限，且不进入录音、不崩溃。

---

### User Story 3 - 转写失败 / 静音 / 超时的优雅降级 (Priority: P3)

当 ASR 链路异常（服务不可达、超时、鉴权失败、非 2xx）、✓ 确认后整段未识别到有效语音（静音/过短）、或单段录音达到时长上限时，系统给出明确轻量提示并安全收尾，绝不阻断会话——用户始终可以改用键盘继续、或重新尝试语音。

**Why this priority**: 健壮性兜底。核心闭环（P1）在理想路径下已可用，但语音依赖外部 ASR 与设备麦克风，异常态必须有定义的、不破坏会话的行为。属体验完善层，故 P3。

**Independent Test**: fake provider / HTTP mock 分别注入「错误/超时/非 2xx」「空 transcript（静音）」「触发时长上限」三类响应，校验各自提示文案出现、输入框不被脏写、会话仍可继续下一轮（文字或语音）。

**Acceptance Scenarios**:

1. **Given** 已点 ✓ 进入 processing，**When** HTTP 一次性识别失败（不可达/超时/鉴权/非 2xx），**Then** 丢弃本段并给一次性「转写失败，请重试或改用键盘」提示，会话不阻断。
2. **Given** 录音后未说话即点 ✓，**When** 整段未识别到有效语音（空 transcript），**Then** 不回填、给「未识别到语音」轻提示，会话不受影响。
3. **Given** 持续录音达到单段时长上限（60s），**When** 到达上限，**Then** 自动停止并对已录内容按 ✓ 确认处理，提示「已达单段上限」。
4. **Given** 会话正处于流式澄清回复中（助手回复进行中），**When** 用户尝试点 mic，**Then** mic 按钮禁用、不能并发起录（与既有 send→stop 互斥）。

---

### Edge Cases

- **录音中应用进入后台 / 来电中断**：安全停录、按取消处理（无 partial 可收 → 丢弃本段），释放麦克风；不得卡在「录音中」假态（per FR-015）。
- **网络抖动致 HTTP 识别慢/超时**：processing spinner 持续；超出超时阈值按转写失败降级。
- **极短点按（误触）**：录音面板已打开后立即 ✗ 取消 / 录制时长过短（如 <300ms）→ 视为空段，不发起识别、不提示错误。
- **连续多段语音**：上一段 transcript 已落框后再起一段，新 transcript 按合并策略续接，不互相覆盖。
- **会话切换/退出时正在录音**：离开澄清屏应安全停止录音并释放麦克风，按取消处理，不泄漏录音会话。

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 系统 MUST 在灵感澄清输入栏提供麦克风入口（替换 B2-1 的 mic stub）：**点击 mic 打开录音面板开始录音，面板内提供 ✓ 确认 / ✗ 取消**（非长按 push-to-talk）。
- **FR-002**: 录音过程中系统 MUST 呈现一个**波形面板**（由 metering 振幅驱动，先平基线后随声起伏）告知正在录音；输入框**保持可编辑**（无 partial 机器写入）；transcript 仅在用户点 ✓ 确认后才落入输入框。
- **FR-003**: 点 ✓ 确认后系统 MUST 将整段一次性识别的 transcript 落入输入框并保持可编辑态，且 MUST **不自动发送**。
- **FR-004**: 经语音得到的文本提交后 MUST 与键盘输入的用户对话轮**完全等价**地进入既有澄清闭环（触发助手回复、同样落库为对话轮）。
- **FR-005**: 系统 MUST 提供 **✗ 取消按钮**：点击取消则零副作用——无 transcript、不改写输入框、草稿不变、不留音频、不发起识别请求。
- **FR-006**: 首次使用系统 MUST 在用户触发录音时申请麦克风权限；拒绝时 MUST 给出前往系统设置开启的引导且不进入录音。
- **FR-007**: 当 ✓ 确认后整段未识别到有效语音（静音/过短，空 transcript）时系统 MUST 不回填并给轻量提示，会话不受影响。
- **FR-008**: 系统 MUST 对单段录音设 **60 秒**时长上限，到限自动停止并对已录内容按 ✓ 确认处理（一次性识别）+ 提示。
- **FR-009**: 当一次性识别链路异常（服务不可达/超时/鉴权失败/非 2xx）时系统 MUST 优雅降级：丢弃本段、一次性提示、**不阻断会话**（用户可改键盘或重试语音）。
- **FR-010**: transcript 落入已有内容的输入框时 MUST **插入当前光标处**（无光标焦点则追加到末尾），既有文本一律保留，MUST NOT 静默覆盖用户已敲文字。
- **FR-011**: 会话处于流式澄清回复态时系统 MUST 禁用麦克风入口，防止与既有 send→stop 流式态并发冲突。
- **FR-012**: 系统 MUST **不持久化音频**：整段录音为瞬态字节（base64 上传后服务端只 base64 包裹拼 data-URL 转发，**永不落库**），落库的只有 transcript（作 ideation 对话轮）；MUST NOT 引入 OSS 音频上传或音频附件实体。
- **FR-013**: ASR 能力 MUST 经可替换的抽象接口接入（运行期由配置选择 provider），更换厂商不波及澄清业务与 mobile 端交互。
- **FR-014**: 整段录音 MUST 经由 server 端点（`POST /api/v1/ideation/asr/transcribe`）上传中转到 ASR 服务，客户端 MUST NOT 直连 ASR 厂商或持有/接收其密钥。
- **FR-015**: 离开澄清屏 / 会话切换 / 应用进入后台 / 来电等中断场景，系统 MUST 安全停止录音并释放麦克风、不残留「录音中」假态；因无 partial 可收，所有中断一律**按取消处理**（丢弃本段，per Replan §3 reducer「interrupt → cancel」）。

### Key Entities _(include if feature involves data)_

- **语音转写段（Transcript segment）**：一次整段录音的一次性识别结果（单一 transcript 文本，无 partial 过程态）。transcript 经用户编辑确认后**转化为既有用户对话轮**落库——本 feature **不新增**独立持久化实体（无音频、无附件）。
- **ideation 对话轮（既有）**：既有澄清闭环的对话单元（[032](../032-ideation-prd-clarify/spec.md)）。语音 transcript 编辑后以与键盘输入相同的方式成为一条用户轮，不改其结构。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户可在澄清对话中**纯靠语音**完成「口述一段灵感 → 识别 → 编辑 → 发送」的完整一轮，无需键盘输入正文。
- **SC-002**: 点 ✓ 确认后用户**即时**看到 processing 指示（转写中 spinner），建立「在处理」的信任反馈；一段 ≤60s 的录音其整段一次性识别在合理时延内返回（不挂死）。
- **SC-003**: 一段约 30 秒的中文口述，点 ✓ 确认到 transcript 落框的一次性识别等待**不超过约几秒**（受网络与音频时长影响，非实时 partial 反馈）。
- **SC-004**: 所有异常态（权限拒绝 / 静音 / 超时上限 / 转写失败 / 流式态并发）均有明确用户可见反馈，且**无任何一种会导致会话卡死或崩溃**——会话在异常后 100% 可继续（键盘或语音）。
- **SC-005**: ✗ 取消的一段录音**零副作用**：不产生 transcript、不改写输入框、不发起识别请求、不在任何存储中留下音频。
- **SC-006**: 经语音提交的对话轮与键盘提交的对话轮在落库与助手响应行为上**无可观察差异**。

## Assumptions

- **架构决策已锁定**：范式（听写式）、provider（DashScope Qwen3-ASR，可换 port）、**传输 = HTTP 一次性文件识别**（整段录音 base64 上传 → server 拼 data-URL → `qwen3-asr-flash` compatible-mode 同步识别；server 代理持 key）、音频为瞬态字节不落仅存 transcript——均依 [ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md)（传输决策经 2026-06-24 amendment 翻案）+ [一次性识别 Replan](../../docs/private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md)，本 spec 不重新选型；具体接口签名 / DTO / 音频格式技术细节落 plan 期。
- **最小录音时长 / 波形归一化参数**等交互参数为 feature 级细节，plan 期定，不在本 spec 固化数值。（合并策略 / 中断收尾 = 取消 / 单段上限 60s 已在 Clarifications 收口。）
- **mobile 录音库选定 `react-native-nitro-sound`**（文件录制 m4a/aac + metering 振幅；退役上一轮 `@mykin-ai/expo-audio-stream`，不用 `expo-audio`——SDK54 录制+metering 有实 bug，详见 Replan Decisions 表）；e2e 在 Web 用 fake recorder seam + HTTP transcribe mock，不依赖真实麦克风。
- **上游已就绪**：B2-1（033）已 ship mic stub 槽位与输入栏 chrome；B1（032）SSE 澄清闭环可用，本 feature 仅在其上接语音入口，不改澄清骨架。
- **Voice Mode（语音对话/打断）、图片标注与多模态（B2-3）、选择代码库接线（已在 S3/034）、音频持久化/回放/OSS** 均显式 out-of-scope。
