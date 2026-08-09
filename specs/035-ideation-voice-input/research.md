# Phase 0 Research — 035 ideation 语音输入（听写式）

> ⚠️ **2026-06-24 SUPERSEDED（采集 + 传输已翻案）**：本 research 的 **R1**（expo-audio / @mykin 实时 PCM 采集）与 **R2/R3**（DashScope realtime WS 流式 + server WS 代理）描述的是**已下线的实时流式架构**。逐字复读根因经实测定位 = `@mykin-ai/expo-audio-stream` 采集劣化（WeChat A/B + 跨模型 + 跨传输三向排除）。现架构 = `react-native-nitro-sound` 整段录音 → HTTP 一次性文件识别（`qwen3-asr-flash` compatible-mode）。详见 [一次性识别 Replan](../../docs/private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md) + [ADR-0061 2026-06-24 amendment](../../docs/adr/0061-ideation-voice-input-asr.md)。下文 R1–R5 保留为历史决策留痕（代码是真相源）。
>
> 解决 [ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md) 全部 5 个 Open Questions + plan 前置不确定性。grounding 来源：官方 docs（Expo / Alibaba Model Studio）+ 代码 recon。结论喂 plan.md Architecture Notes。

## R1 — mobile 实时音频采集：expo-audio PCM stream（不需自写原生模块）

- **Decision**：mobile 用 **`expo-audio`** 的原生音频流 API 采集实时 PCM（`stream.start()` / `stream.stop()`，`requestRecordingPermissionsAsync()` 申请权限，sample = 原始 PCM/通道）。目标格式 **16kHz 单声道 16-bit PCM**（对齐 DashScope，见 R2）。
- **Rationale**：现仓零音频基建（recon 实证无 expo-av/expo-audio）。`expo-audio` 是 Expo **一等公民 SDK 模块**（Claude 熟、CN 可达、低供应链风险），官方已支持实时麦克风 PCM 流（非仅文件录制），直接满足 ADR-0061「边说边显示 partial」对帧流的需求。
- **Alternatives considered**：
  - `expo-av`（旧，已被 expo-audio 取代，主文件录制）→ 弃。
  - `@mykin-ai/expo-audio-stream`（社区，**dual-stream 含 16kHz ASR 输出 + VAD 友好**）→ **保留为兜底**：若 pinned Expo SDK 的 `expo-audio` 流式 PCM API 不可用/不稳，切此包（成熟、专为 ASR/VAD 设计）。
  - 端侧 ASR → ADR-0061 已淘汰（Android 国行无 GMS）。
- **⚠️ impl 验证锚**：`expo-audio` 流式 PCM API 的可用性**绑定 pinned Expo SDK 版本** → impl 起手第一步必在真机/dev-client 实测拿到 PCM 帧（见 plan「Spike 前置」）；不可用即切兜底包。Cargo-cult 防火墙：不预装兜底包，实测需要才装。
- Source: [Expo Audio (expo-audio) docs](https://docs.expo.dev/versions/latest/sdk/audio/) · [Real-time audio processing with Expo and native code](https://expo.dev/blog/real-time-audio-processing-with-expo-and-native-code) · [@mykin-ai/expo-audio-stream](https://www.npmjs.com/package/@mykin-ai/expo-audio-stream)

## R2 — DashScope Qwen3-ASR realtime WS 协议

- **Decision**：provider 连 **`qwen3-asr-flash-realtime`**，endpoint **`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`（北京区，与 Aliyun server 同区）**；鉴权 `Authorization: Bearer <DASHSCOPE_API_KEY>`（账号 A 既有 `sk-`）；输入音频 **16kHz / 单声道 / 16-bit PCM**；采用**手动模式**（push-to-talk 松手即 commit，对齐听写式；非自由 VAD 长连）；partial（中间结果）+ final 事件回流。**不需时间戳**（Qwen-ASR realtime 本就不返，符合本 feature）。
- **Rationale**：ADR-0061 §2/§4 已选 DashScope realtime；官方文档确认协议为 OpenAI-Realtime 家族（`/api-ws/v1/realtime`），16kHz mono PCM 与 R1 采集目标天然对齐。北京区 endpoint 避免跨境（server 在 Aliyun，备案合规）。
- **Alternatives considered**：离线 filetrans（`-filetrans`）→ ADR-0061 §4 否决（须先上传 OSS 触发 ADR-0045 + 无 partial）；新加坡区 endpoint → 跨境无必要。
- **Open（impl 期控制台核实，非阻塞）**：① 手动 vs VAD 模式的精确 commit 事件名；② 计价 ~25 token/秒音频的真实 ¥/小时（ADR-0061 Open Q）；③ 断流/超时下 DashScope 的错误事件形态 → 映射降级。
- Source: [Build Real-Time Speech Recognition with WebSocket & DashScope](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide) · [Qwen real-time speech recognition](https://www.alibabacloud.com/help/en/model-studio/qwen-real-time-speech-recognition) · [Qwen-ASR-Realtime interaction process](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-interaction-process)

## R3 — WS 传输落 NestJS + Fastify 5（关键架构决策）

- **Decision**：**不**用 `@nestjs/websockets` gateway 装饰器（`@WebSocketGateway`）。改用 **`@fastify/websocket` 插件**直接在底层 Fastify 实例上注册一条 raw WS route（`websocket: true`），桥接进一个 Nest provider/UC 处理握手与帧。client↔server 这一腿用 `@fastify/websocket`；**server↔DashScope 这一腿用 Node 22 内置全局 `WebSocket` 客户端**（undici，零新依赖）。
- **Rationale**：官方 issue 实证 `@nestjs/websockets`(+socket.io) **与 platform-fastify 不兼容**（socket.io 端点不可达）。`@fastify/websocket` 是 Fastify 官方插件，须在 routes **之前** register 才能拦截 upgrade —— 在 `main.ts` / module `onModuleInit` 取 `app.getHttpAdapter().getInstance()` 注册。解 ADR-0061 Open Q「@nestjs/platform-ws / native ws；Fastify 兼容性」。
- **WS 鉴权**：raw fastify WS route **不经 Nest Guard 链**（`JwtAuthGuard` 不自动作用）→ 在 upgrade handler 内**手动校验 JWT**（query param `?token=` 或 `Sec-WebSocket-Protocol`），复用既有 JWT 校验逻辑；校验失败立即 close（4401）。account scope 同 ideation 反枚举。
- **链路与生命周期**：client 开 WS（带 JWT + sessionId）→ server 校验 → server 开到 DashScope 的 WS（持 key）→ client 上行二进制 PCM 帧 **经 ASR port 转发** DashScope → DashScope partial/final 事件回流 server → server 下行 JSON 帧（`partial`/`final`/`error`）给 client。client close / 松手 commit / 错误 / 超时 → 双向清理（关 DashScope WS、释放）。**背压/断流降级**：DashScope 断 → server 发 `error` 帧 + 关闭，client 落降级 toast（FR-009）。
- **Alternatives considered**：半双工（POST 音频分块 + SSE 下行 partial）→ 与 DashScope WS-native realtime 相悖、上行延迟高、ADR-0061 已选 WS；socket.io → 与 Fastify 不兼容。
- **⚠️ 与既有 SSE 并列**：clarify-turn 仍走 SSE `reply.hijack()`（ADR-0055）不动；ASR WS 是**新增并列通道**，互不替代。
- Source: [@fastify/websocket](https://www.npmjs.com/package/@fastify/websocket) · [nestjs/nest#14953 — websockets not compatible with platform-fastify](https://github.com/nestjs/nest/issues/14953) · [NestJS Fastify integration (DeepWiki)](https://deepwiki.com/nestjs/nest/4.1.2-fastify-integration)

## R4 — final transcript 入对话轮 = 复用既有文字发送路径（零新增 server turn 逻辑）

- **Decision**：转写**不另起**对话轮落库逻辑。final transcript（用户编辑后）经**既有** `POST /api/v1/ideation/sessions/{id}/turns`（`ClarifyTurnRequest.content`）发送 —— 与键盘输入**同一路径**（recon 实证：controller → UC 校验非空 → `prisma.ideaTurn.create` → 既有澄清流）。语音侧只负责「把文字填进输入框」，发送与键盘等价（满足 FR-004 / SC-006）。
- **Rationale**：ADR-0061 §5「仅 final transcript 落库作对话轮」+ recon 确认 text-send path 即唯一入口 → 语音零侵入既有 turn/SSE 闭环。**音频不落、无 OSS、无 `IdeaAttachment`**（ADR-0061 §5 翻案旧 plan 措辞）。
- **Consequence**：ASR WS 通道**只产 transcript 文本回流 mobile 输入框**，不写库；落库仍由既有 turn 端点。server 侧 ASR 范围 = WS 代理 + 转写，**不碰 ideation 持久化**。
- Source: 代码 recon（`clarify-turn.usecase.ts` text-send path）+ [ADR-0061 §5](../../docs/adr/0061-ideation-voice-input-asr.md)

## R5 — 契约验证形态（WS 不进 OpenAPI）

- **Decision**：WS 通道**不进 OpenAPI/orval**（非 JSON REST，无法 codegen，recon 实证 SSE 同样手写）。契约 = **server 帧序列化规则 + mobile 手写 WS 客户端解析**双向镜像（仿既有 `ideation-sse.rules.ts` ↔ `ideation-sse-parse.ts`）。`[Contract-Smoke]` 用 **fake-asr provider** 打 testcontainers 真 server 验 WS 握手 + 帧契约（partial/final/error）对齐；真 final transcript 落库走既有 turn 端点的契约冒烟（已有套件覆盖文字路径）。
- **Rationale**：Constitution §V 两层验证；WS 无 codegen → 契约靠双向代码镜像 + fake provider 冒烟兜住「hermetic mock 与 server IT 都覆盖不到的缝」。
- Source: 代码 recon（api-client orval 不覆盖 SSE/WS）+ Constitution §V

## 决策汇总（→ plan.md）

| #   | 决策                                                                                            | 新依赖                                     |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| R1  | expo-audio 实时 PCM 16kHz 采集（兜底 @mykin-ai/expo-audio-stream）                              | **expo-audio**（mobile，新；兜底包仅按需） |
| R2  | DashScope `qwen3-asr-flash-realtime` 北京区 WS，16kHz mono PCM，手动模式                        | 无（Node 内置 WebSocket 客户端）           |
| R3  | `@fastify/websocket` 注册 raw WS route + 手动 JWT 校验；server↔DashScope 用 Node 全局 WebSocket | **@fastify/websocket**（server，新）       |
| R4  | final transcript 复用既有 turn 端点落库；音频不落                                               | 无                                         |
| R5  | WS 契约双向代码镜像 + fake-asr 冒烟（不进 OpenAPI）                                             | 无                                         |
