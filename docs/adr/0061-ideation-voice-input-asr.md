---
adr_id: ADR-0061
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - 出现 Voice Mode（speech-to-speech 实时语音对话 / 可打断）需求 → 换实时多模态模型 + 双向音频流 + barge-in，本 ADR 的「听写式」边界与 provider/传输决策整体重审（独立新段，如 B2-5）
  - DashScope Qwen3-ASR 中文实测不达预期 / 限流 / 提价 → 切 provider（讯飞 / 豆包），抽象 port 已备，仅换 adapter + 配置
  - 音频需求从「过路转写、仅存 transcript」扩张到「存音频 / 回放 / 与图片多模态结合（B2-3）」→ 触发 [ADR-0045](0045-object-storage-image-upload.md) OSS 上传架构重审
  - server 迁出 Aliyun（换云 / 多云）→ DashScope region / 账号接入重审
  - 用量上台阶（多用户 / 高并发语音会话）→ server WS 代理承载能力（连接数 / 背压 / 成本）重审
---

# ADR-0061: Ideation 语音输入 — 听写式 + DashScope Qwen3-ASR（可换 port）+ server WS 代理实时流式

- Status: Accepted (2026-06-23) · **Amended (2026-06-24)** — 传输决策 §4 由「实时流式 WS 代理」**superseded** 为「HTTP 一次性文件识别」（详见文末 Amendment）
- Deciders: @zhangleizlpd
- Tags: server / mobile / ideation / asr / voice / integrations
- Relates: [ADR-0057](0057-ideation-bounded-context.md)（ideation ctx = 消费方）/ [ADR-0058](0058-server-integrations-layer.md)（ASR port 落 `integrations/` 层，复用 LLM port 范式）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（现有 SSE `reply.hijack()` 传输；本 ADR 的 WebSocket 是**并列新增**传输）/ [ADR-0045](0045-object-storage-image-upload.md)（对象存储上传 — 本 ADR 明确**不触发**）；实施载体 = [B2 拆分 plan B2-2 段](../private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md)

## Context

ideation B2-2「语音输入」段的开工硬前置 = ASR 选型（plan 明列：现仓**零音频基建**——mobile 无 `expo-av`/`expo-audio`，server 无任何 ASR SDK，`integrations/llm` 的 `Msg.content` 是纯字符串）。本 ADR 收口该前置的 tech-compare 结论与架构决策。

调研路径见知识库 vault（`asr-provider-selection` / `voice-input-ux`），关键事实：

1. **业内"语音"分两条产品线**：① 听写式 Dictation（语音→文字落输入框→编辑再发，ASR 转写即可）；② Voice Mode（speech-to-speech 实时对话，需多模态原生模型 + 双向流 + 打断，量级完全不同）。
2. **"两端一等公民（iOS+Android）"淘汰端侧**：iOS 端侧 ASR 可用，但 Android 端侧中文依赖 Google 服务（GMS），**国行设备无 GMS 会退化** → 端侧无法两端一致 → 只能走云端 ASR。
3. **国内云端中文 ASR 四强**（DashScope Qwen3-ASR / 讯飞 / 百度 / 火山豆包）中文准确率全是官方宣称值（97-98%），合规/可达全平 → 决策权重落到**集成成本**。

## Decision

### 1. 范式 = 听写式 Dictation，明确不做 Voice Mode

B2-2 = 语音→文字进输入框→用户编辑后发送。Voice Mode（实时语音对话）是另一个量级（换实时多模态模型 + 双向音频流 + barge-in），**不塞进 B2-2**，未来要做单开独立段（见 sunset）。

交互范式 = **Push-to-talk**（按住说、松手结束，对标微信国民级心智）。具体 UX（partial 实时显示、波形/earcon 反馈、下滑取消、权限点击时申请、落输入框可编辑不自动直发、单段 45-60s）属 feature 级，落 **B2-2 plan.md**，不在本 ADR。

### 2. Provider = DashScope Qwen3-ASR（首选），抽象 port 可换

四家中文准确率同档且均为宣称值（拉不开），DashScope 凭 **复用已有阿里云账号 A + `sk-` Bearer 最简鉴权 + OpenAI-compat 家族** 在 solo-dev 场景集成成本最低 → 首选。
**自测兜底**：真实灵感口述 A/B 自测若不达预期 → 切**讯飞**（中文标杆）/ **豆包**（宣称最高 + 抗噪），仅换 adapter。

### 3. 接入层抽象 = `integrations/asr/` ASR port，照搬 LLM port 范式

per [ADR-0058](0058-server-integrations-layer.md)，新增 `apps/server/src/integrations/asr/`，结构镜像现有 `integrations/llm/`：

| LLM 层（既有）         | ASR 层（新增）              | 职责                                                         |
| ---------------------- | --------------------------- | ------------------------------------------------------------ |
| `llm-provider.port.ts` | `asr-provider.port.ts`      | 抽象接口（流式转写：音频帧入 → partial/final transcript 出） |
| `deepseek.provider.ts` | `dashscope-asr.provider.ts` | DashScope Qwen3-ASR adapter                                  |
| `fake-llm.provider.ts` | `fake-asr.provider.ts`      | 测试 fake（IT / e2e 无外部依赖）                             |
| `llm.module.ts`        | `asr.module.ts`             | DI 装配 + 按 `ASR_PROVIDER` env 选择                         |

provider 由 `ASR_PROVIDER` 环境变量选择（对齐 LLM `LLM_PROVIDER` 范式）。换厂商 = 加一个 adapter + 改 env，不动 ideation ctx 与 mobile。

### 4. 传输 = 实时流式（`qwen3-asr-flash-realtime`），经 server WebSocket 代理

选**实时流式**而非离线文件识别（`-filetrans`），两个理由叠加：

|                                                           | 实时流式（WS）                  | 离线文件（filetrans）         |
| --------------------------------------------------------- | ------------------------------- | ----------------------------- |
| 音频去向                                                  | WS 帧流式直推（过路不落库）     | **必须先上传 OSS 拿公网 URL** |
| 边说边显示 partial                                        | ✅ 能（业内最佳实践，建立信任） | ❌ 松手后一次性出             |
| 触发 [ADR-0045](0045-object-storage-image-upload.md) 上传 | ✅ **不需要**                   | ❌ 需要                       |

链路 = **client → NestJS server（WS 代理）→ DashScope WS**（方案 A）：

- server 持 DashScope key，client **不直连**、不暴露/下发 token（对齐现有"密钥在后端"范式，否决 client 直连方案 B）。
- WebSocket 是**并列新增**传输：现有 clarify-stream 走 SSE（[ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md) `reply.hijack()`）；语音转写另起 WS 通道，互不替代。
- ASR port（§3）在 server 侧承接：mobile 推音频帧 → server 经 `asr-provider.port` 转发 DashScope → partial/final transcript 回流 mobile 填输入框。

### 5. 不触发 ADR-0045：音频过路不落、仅存 transcript

实时流式下音频仅为 WS 过路帧，**不上 OSS、不持久化**；落库的只有最终 transcript（作 ideation 对话轮）。故本 ADR **不引入 OSS 音频上传架构**（[ADR-0045](0045-object-storage-image-upload.md) 维持其图片 scope 不变）。`Msg.content` 保持纯字符串——transcript 是文本，**不扩 vision/audio 多模态**（那是 B2-3 范围）。

## Consequences

- 新增 `integrations/asr/` port + DashScope adapter + fake；新增 server WebSocket 代理通道；mobile 新增 `expo-audio` 录音 + WS 客户端。
- 换 ASR 厂商 = 加 adapter + 改 `ASR_PROVIDER`，零侵入 ideation ctx / mobile。
- 不碰 ADR-0045 / OSS / `Msg` 多模态，B2-2 范围封闭、可独立 ship。
- 引入对 DashScope 的外部依赖（语音会话期；非常驻）。
- server 多一种传输（WS），运维/可观测需覆盖（连接生命周期、背压、断流降级）。

## Trade-offs

| 短板                                             | 接受理由                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| 中文准确率以宣称值定首选，未第三方实测           | 四家同档拉不开，集成成本才是真分水岭；port 抽象使切换成本极低，自测后可换 |
| WS 是 server 新传输（现仅 SSE），有实装/运维成本 | 换"边说边显示 partial 最佳体验 + 绕开 ADR-0045 OSS 上传"，净省更多        |
| 依赖外部 ASR（DashScope）而非端侧免费            | 两端一等公民下端侧不可行（Android 国行无 GMS）；云端是唯一一致解          |
| 听写式不含语音对话                               | Voice Mode 是独立量级，过早做 = 过度设计；按需单开                        |

## Open Questions

- NestJS + Fastify 下 WebSocket 代理的具体实装（`@nestjs/platform-ws` / 原生 ws；与 Fastify adapter 兼容性）→ B2-2 plan/impl 期定。
- `asr-provider.port.ts` 接口签名（流式音频帧编码 / 采样率 / partial-final 事件模型 / 错误与降级语义）→ B2-2 plan 细化。
- DashScope realtime WS 鉴权与连接复用细节、断流/超时降级（转写失败 → 提示重录，不阻断会话）。
- `expo-audio` 录音帧格式与 DashScope 入参对齐（采样率 / 编码）。
- DashScope Qwen3-ASR token 计价（~25 token/秒音频）真实 ¥/小时 → 控制台核实。

## References

- [ADR-0057](0057-ideation-bounded-context.md)（ideation ctx）/ [ADR-0058](0058-server-integrations-layer.md)（integrations 层）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（SSE 传输）/ [ADR-0045](0045-object-storage-image-upload.md)（对象存储上传，本 ADR 不触发）
- [B2 拆分 plan（B2-2 段）](../private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md)
- 选型调研留迹（local vault）：`~/knowledge-vault/topics/asr-provider-selection.md` + `voice-input-ux.md`

---

## Amendment (2026-06-24) — 传输由「实时流式 WS」改为「HTTP 一次性文件识别」

> 上文 §4「传输 = 实时流式 WS 代理」+ §5「WS 过路帧」+ §交互「partial 实时显示 / 下滑取消」为**冻结决策记录**，下列 amendment 取代之；范式（§1 听写式）、provider（§2 DashScope，可换 port）、port 抽象（§3 `integrations/asr/`）、不触发 ADR-0045（§5 音频不落、仅存 transcript）**均保持有效**。载体 = [一次性识别 Replan](../private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md)。

### 翻案根因（实测）

上一轮「文字逐字复读」故障经逐层判别（排除传输 / 排除模型 / 排除语速）定根因 = **`@mykin-ai/expo-audio-stream` 采集劣化**（疑其 `data16kHz` 重采样在华为 Android 上有问题）。关键证据 = **WeChat A/B**：同一人同样慢语速，WeChat 录音（正常录音器，48kHz AAC）→ qwen 同步 → 干净；@mykin（16kHz）→ 复读，**唯一变量 = 录音器**。实时 WS 与 HTTP 整段两路对同一段 @mykin 音频产出同样复读 → 锅不在传输。

### 修复 + 配套简化

| 项       | 原决策（§4/§5/交互，superseded）                                                       | 2026-06-24 amendment                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 录音库   | `expo-audio`（plan 期翻案为 `@mykin-ai/expo-audio-stream`）                            | 退役 `@mykin` → **`react-native-nitro-sound`**（老牌 recorder-player 官方继任，文件录制 m4a/aac + metering）。**不用 `expo-audio`**：SDK54 Android 零字节录音（#39646）+ metering 卡 -160dB（#37241）                                                                                                                |
| 传输     | 实时流式 `client → server WS 代理 → DashScope WS`（`qwen3-asr-flash-realtime`）        | **HTTP 一次性文件识别**：整段录音 base64 上传普通 REST 端点 `POST /api/v1/ideation/asr/transcribe`（`JwtAuthGuard`）→ server 拼 `data:<mime>;base64,<b64>` data-URL → DashScope `qwen3-asr-flash` **compatible-mode `/chat/completions` 同步识别** → 一次性返回 `{text}`。server 用 Node 22 全局 `fetch`（零新依赖） |
| 端口签名 | 流式 `transcribe(AsyncIterable, opts): AsyncIterable<AsrEvent>`（partial/final/error） | 一次性 `transcribeOneShot(audio: Uint8Array, opts:{mimeType;lang?}): Promise<string>`（空串=静音；throw=失败）                                                                                                                                                                                                       |
| 交互     | partial 实时显示 + push-to-talk 长按 + 下滑取消                                        | Manus 式：点 mic → 录音面板（波形）→ ✓ 确认 / ✗ 取消 → processing → transcript 回填**可编辑**框（不自动发，无 partial）                                                                                                                                                                                              |
| 音频去向 | WS 过路帧                                                                              | base64 瞬态字节，服务端只包裹拼 data-URL，**永不落库**（§5 音频不落仍有效，base64 上传 ≠ OSS 持久化）                                                                                                                                                                                                                |

### Go/No-Go（已验绿）

G-1 已用 WeChat m4a 当场跑通服务端路径（m4a base64 → `qwen3-asr-flash` compatible-mode 同步 → 「我想做一个登录带验证码的那个工具」干净无复读）。换 nitro-sound 后华为真机复测（与 WeChat 同属正常录音器，预期干净）作 impl 收尾闭环。下线整条 WS 流式链路（`@fastify/websocket` + `@mykin` 删除）为本 amendment 的**大删**，PR auto-merge OFF。
