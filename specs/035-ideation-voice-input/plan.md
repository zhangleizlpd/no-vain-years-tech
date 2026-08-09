---
feature_id: 035-ideation-voice-input
spec_ref: ./spec.md
status: drafted
created_at: 2026-06-23
updated_at: 2026-06-24
adr_refs: ['0024', '0027', '0038', '0040', '0043', '0045', '0055', '0057', '0058', '0061']
context7_verified: []
---

# Implementation Plan: ideation 语音输入（听写式 Dictation · B2-2 · 一次性文件识别）

## Summary *(mandatory)*

把 B2-1（033）留下的 mic stub「即将开放」接成真功能：点 mic → 整段录音（波形）→ ✓ 确认 → 一次性文件识别 → transcript 落框可编辑后发送（走既有 turn 端点，与键盘等价）。技术路径 = mobile `react-native-nitro-sound` 录 m4a/aac（metering → 波形）→ ✓ → base64 上传**新 REST 端点** `POST /api/v1/ideation/asr/transcribe`（`{audioBase64, mimeType}`）→ server 拼 `data:<mime>;base64,<b64>` data-URL → 经**新 `integrations/asr/` 端口**（镜像 `integrations/llm` ADR-0058 范式）调 DashScope `qwen3-asr-flash` **compatible-mode 同步识别** → 返回 `{text}` → 回填可编辑输入框。**音频为瞬态字节（base64 包裹、过路不落、永不落库）、仅 transcript 经既有 turn 端点落库**（不触发 ADR-0045，不扩 `Msg` 多模态）。**无 WS、无流式、无 partial。**

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| **`react-native-nitro-sound`**（+ peer `react-native-nitro-modules`）（mobile）| 整段文件录制 m4a/aac + `meteringEnabled` 振幅（驱动波形）；Nitro/JSI、autolinking | 老牌 `react-native-audio-recorder-player` 官方继任（稳定性优先）。**不用 `expo-audio`**：SDK54 上 Android 零字节录音（#39646）+ metering 卡 -160dB（#37241/#36953），正中「可靠录音+波形」要害；`react-native-audio-api`(Software Mansion) metering 需自算 + 与本仓 worklets 0.5.1 冲突 → 否决。新原生依赖走 prebuild（Replan Decisions 表）|
| Node 22 全局 `fetch`（server）| server → DashScope compatible-mode `/chat/completions` 同步识别 | **无新 server 依赖** — Node 22 内置 undici `fetch`（Replan §1）|
| `react-native-svg` + `react-native-reanimated`（mobile，**均已装**）| 自绘波形（metering 驱动 bars + shared value）| 零新依赖，复用现仓（Replan Decisions 表）|
| ~~`@mykin-ai/expo-audio-stream`~~（mobile）| ~~实时 16kHz PCM dual-stream 采集~~ | **退役删除**：实测定根因 = 其采集劣化致逐字复读（WeChat A/B 证），换正常录音器即干净（Replan Context）。删前 grep 确认仅 `use-ideation-voice.ts` 引用 |
| ~~`@fastify/websocket`~~（server）| ~~Fastify 5 raw WS 代理~~ | **退役删除**：传输由 WS 流式改 HTTP 一次性，无 WS 通道。grep 确认仅 ASR 用 → 删 dep（Replan §4）|

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles。

> ✅ **§I Mockup gate — 已满足**：7 状态帧 mockup 经 Claude Design（MCP 直驱）落 `design/voice-input.dc.html` + `_ds/` + `handoff.md` + `all-states-snapshot.png`，全复用 NVY token 零新增配色，Playwright 渲染自验通过。clarify→**mockup**→plan 链完整。

- **§II TDD**：每 task 红→绿。server transcribe 端点 + ASR 端口走真后端 IT（**fake-asr provider** 经 DI `overrideProvider(ASR_PROVIDER)` 注入，Testcontainers PG+Redis，无外部依赖）；mobile 逻辑 vitest（录音状态机 reducer / 波形归一化纯函数）；UI Playwright Expo Web e2e（录音经 fake recorder seam，HTTP transcribe 经 `route.fulfill` 返 `{text}`）。
- **§III Atomic task**：30min-2h 拆（asr 端口+provider 重写 / transcribe controller+DTO+usecase / module 改 / 真 IT / api-client regen / mobile 依赖切换+录音 hook / 上传 / reducer / 编排 hook / 波形组件+归一化 / InputBar 重接 / e2e seam+Playwright+contract-smoke / 删死 WS 栈 / 各层测试）。
- **§IV Module Boundary（扁平+贫血+护城河）**：
  - ASR 经新 `integrations/asr/` **platform 端口**（`ASR_PROVIDER` DI，与 `LLM_PROVIDER` 同类 platform integration，**非他业务 ctx**，无护城河注释要求 per ADR-0058）。
  - transcribe controller + usecase 落 `apps/server/src/ideation/`（消费方），**扁平**平铺、无层子目录；**不写库**（音频不落，transcript 走既有 turn 端点）→ 无 Prisma 表写、无 repository。
  - **不 import chat**。
- **§V 单 PR + 类型链**：跨端单 PR —— server（asr 端口 + transcribe controller + DashScope provider）+ 真后端 IT + **api-client regen**（新增 REST 端点 → orval 生成 `ideationControllerTranscribe`）+ mobile 消费（录音 + 上传 + UI）+ 两层验证（`[Mobile-E2E]` hermetic + `[Contract-Smoke]` HTTP `{text}` 契约）原子 merge。**REST 端点进 OpenAPI → 本 feature api-client DOES regen**（per `.claude/rules/api-contract-trigger.md`，mobile 必调生成 fn、禁手写 fetch）。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [ ] **Server**: 真后端 IT（PG+Redis via Testcontainers + **fake-asr provider** 经 `overrideProvider(ASR_PROVIDER)`）覆盖 transcribe 端点：JWT 鉴权（有效 200 / 无效 401）+ base64 → `{text}` 正常路径 + 降级（fake fail → ProblemDetail / 静音空 → `{text:''}`）至少各一次。transcript 落库走既有 turn 端点契约冒烟（已有套件覆盖文字路径）。tail 留 env-gated `RUN_ASR_SYNC_IT` 真 DashScope 块（= G-1）。
- [ ] **Mobile / Web**: 每条 P1/P2/P3 user story golden-path 走 Playwright Expo Web（录音经 fake recorder seam，HTTP transcribe 经 `route.fulfill`）：点 mic → 录音面板+波形 → ✓ → processing → transcript 落框 → 编辑发送；✗ 取消零副作用；权限拒绝去设置；降级 toast。**真机录音**（华为 dev-client）实测 nitro-sound 录 m4a + metering 在 Spike + impl 收尾各一次。
- [ ] **Evidence**: impl 产出 `apps/server/test/integration/ideation-asr-transcribe.it.spec.ts` + `apps/mobile/e2e/ideation-voice.spec.ts` + `apps/mobile/e2e/contract-smoke/ideation-asr.contract.ts`（打 testcontainers 真 server 验 HTTP `{text}` 契约）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

填（本 plan 引入 `react-native-nitro-sound` + DashScope ASR 外部服务；server 用 Node 22 全局 `fetch` 零新依赖）。

| # | Question | Answer |
|---|---|---|
| Q1 | Long-term maintenance signals? | `react-native-nitro-sound` = 老牌 `react-native-audio-recorder-player` 官方继任（Nitro/JSI，活跃）；server `fetch` = Node 22 内置（零依赖）；DashScope = 阿里云商业服务（账号 A 既用于 SMS）|
| Q2 | Could an already-installed tool cover this? | 否（录音）。**已弃 `expo-audio`**（SDK54 Android 零字节录音 #39646 + metering 卡 -160dB #37241）。波形/上传复用已装的 `react-native-svg`+`reanimated`+`expo-file-system`。server `fetch` 零新依赖 |
| Q3 | Compatibility (NestJS/Prisma/Expo/pnpm/Nx)? | nitro-sound 走 autolinking + prebuild（新原生模块，需 dev-client 重 prebuild + 麦克风权限串）；server transcribe = 普通 Nest controller（`JwtAuthGuard` 走标准 Guard 链），与 platform-fastify 无兼容问题 |
| Q4 | LLM training-data coverage? | nitro-sound API ≈ 老牌 recorder-player（Claude 熟）；DashScope `qwen3-asr-flash` compatible-mode `/chat/completions` 形态 = OpenAI-compat（Claude 熟），Replan 已用 WeChat A/B 实测请求形态 |
| Q5 | Decoupling cost? | ASR 经 `integrations/asr/` 端口隔离 → 换厂商（讯飞/豆包）= 加 adapter + 改 `ASR_PROVIDER`；HTTP 一次性传输与 provider 解耦 |
| Q6 | Risk surface (license/CN/CVE)? | 全 CN 可达（DashScope 北京区，与 server 同 Aliyun，备案合规）；token 后端持有不下发（FR-014）；体积上限 `@MaxLength` + 60s cap 防超 10MB；无已知 CVE 阻塞 |

**Evidence**: Replan Decisions 表 + 端到端音频格式段（DashScope 官方 docs / nitro-sound）；G-1 已用 WeChat m4a 实测跑通服务端路径；ASR 选型决策源 = [ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md)（传输经 2026-06-24 amendment 翻案）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature 为 mono-native**（B2-2 语音，无任何旧 meta-repo 迁入代码/路径/类名）。Evidence: `rg -n 'mbw-|org\.springframework|src/main/java' specs/035-ideation-voice-input/` → 无命中（impl 起手复跑）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0061（2026-06-24 amendment）| 传输实装（实时 WS → HTTP 一次性文件识别）| mitigated | Replan §1/§3：普通 Nest controller `POST /api/v1/ideation/asr/transcribe` + `JwtAuthGuard`；server→DashScope 用 Node 22 全局 `fetch` 打 compatible-mode |
| ADR-0061 | `asr-provider.port.ts` 接口签名（编码/采样率/事件/错误降级语义）| mitigated | 见 Architecture Notes §1 端口签名：`transcribeOneShot(audio,opts):Promise<string>`（空串=静音；throw=失败）；m4a/aac base64 → data-URL |
| ADR-0061 | DashScope 鉴权/超时降级 | mitigated（G-1 已实测请求形态）| Bearer key（北京区）、非 2xx/超时 → 抛泛化 Error → ProblemDetail 降级；key 不入日志（FR-014）|
| ADR-0061 | nitro-sound 录音格式与 DashScope 对齐 | mitigated（G-1 WeChat m4a 实测 + Spike 真机复测）| AAC 原生被 DashScope 接受 → 无服务端转码；华为真机 spike 录 m4a + metering 实证 |
| ADR-0061 | Qwen3-ASR token 计价真实 ¥/小时 | accepted-as-is | 非阻塞，impl 控制台核实（成本观测，非功能门）|
| ADR-0045 | 本 feature **不触发**（音频瞬态字节、不落库、无 OSS）| accepted-as-is | 仅 transcript 走既有 turn 端点落库；base64 上传 ≠ OSS 持久化 |
| ADR-0055 | 既有 SSE 传输 | accepted-as-is | REST transcribe 端点并列新增，不替代 clarify-turn SSE |
| ADR-0038 | ProblemDetail 降级码 | accepted-as-is | provider 错误 → ProblemDetail（ADR-0038）让 mobile 落 toast（FR-009）|

**Evidence**: Replan §1/§3 + 端到端音频格式段；G-1 已用 WeChat m4a 实测 compatible-mode 路径跑通；网络/计价为运维与成本观测，不阻塞业务 impl。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock` 隔离单测。用 `Test.createTestingModule({ imports: [...] }).compile()` 装真 DI 容器。transcribe 端点的 fake-asr provider **经 DI `overrideProvider(ASR_PROVIDER)` 注入，非 `new`**。
- **MANDATORY INTEGRATION**: transcribe controller + provider 的鉴权/识别/降级必须在真 Fastify + DI lifecycle 中测（`JwtAuthGuard` 走真 Guard 链，fake-asr 经 `overrideProvider(ASR_PROVIDER)`）。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 每条（点录正常 / ✗ 取消 / 权限拒绝 / 静音空 transcript / 60s 上限 / 转写失败降级 / 合并插入 / 流式态 mic 禁用 / 后台来电中断=取消 / 离屏取消）**必须**有对应 `it()`（server IT 覆盖端点分支，mobile vitest+e2e 覆盖交互分支）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)** — Flat + Anemic + Zero-Class + Moat。新文件平铺于 `apps/server/src/ideation/` 与 `apps/server/src/integrations/asr/`；ASR 端口类型为贫血 DTO；transcribe UC 不写库、不建 repository/domain class。

#### 1. ASR 端口（新 platform integration，ADR-0058 同构）

- 新目录 `apps/server/src/integrations/asr/`，镜像 `integrations/llm`：
  - `asr-provider.port.ts` —— `ASR_PROVIDER` DI token + `AsrProvider` 接口（**一次性**）：
    - `transcribeOneShot(audio: Uint8Array, opts: { mimeType: string; lang?: 'zh' }): Promise<string>`
    - 返回整段 transcript 文本；**空串 = 静音/未识别**；**throw = 失败**（让上层降级）。删除流式 `transcribe()` AsyncIterable + `AsrEvent` / `AsrTranscribeOptions` 类型。
  - `dashscope-asr.provider.ts`（REWRITE）—— 真 provider：删全部 realtime WS 代码；Node 22 全局 `fetch` 打 compatible-mode `POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，`model:'qwen3-asr-flash'`，content item `{ type:'input_audio', input_audio:'data:<mime>;base64,<b64>' }`，Bearer key；解析 `choices[0].message.content` → 文本；非 2xx/超时/vendor 错误 → 抛泛化 `Error('asr-failed')`（**key/header/body 不入日志**，FR-014）；空白 → 返 `''`。ctor 仍 `Extract<AsrConfig,{kind:'dashscope'}>` apiKey-only。
  - `fake-asr.provider.ts`（REWRITE）—— IT/e2e 替身：`FakeAsrConfig { text?:string; fail?:boolean; failReason?:string }`，`transcribeOneShot` 返 `config.text ?? ''` 或 `fail` 时抛（驱动 正常/静音空/失败降级 分支）。
  - `asr.module.ts` —— provider 经 `ASR_PROVIDER` env 选 dashscope/fake（同 `llm.module` 范式，**无默认绑定**，consumer 声明 useFactory）。
- **config / env-sync**：**复用 `asr.config.ts` dashscope 分支，无新 env**（`DASHSCOPE_API_KEY` + `ASR_PROVIDER` 已铺）。本地 IT 用 fake，不需真 key。镜像 `sms.config.ts` zod 范式（boot `.parse()`；boot healthy ≠ cred 有效）。

#### 2. transcribe 端点（server 新增 REST 传输，Replan §1）

- **普通 Nest controller，非 raw WS**：`asr-transcribe.controller.ts` —— `POST /api/v1/ideation/asr/transcribe`，`@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()` + `@ApiTags('ideation')` + `@HttpCode(200)`；自有 throttle bucket；无状态（无需 sessionId）。
- **DTO**：`asr-transcribe.request.ts` —— `{ audioBase64:string; mimeType:string }`，class-validator + swagger 仿 `set-session-repo.request.ts`；`mimeType` `@IsIn(['audio/aac','audio/mp4','audio/wav','audio/mpeg'])`；`audioBase64` `@MaxLength(~14MB)`。`asr-transcribe.response.ts` —— `{ text:string }`（非 null，空串=静音；避开 nullable-@ApiProperty 需显式 type 的坑）。
- **usecase**：`asr-transcribe.usecase.ts` —— `TranscribeAsrUseCase`（ADR-0043 贫血），`@Inject(ASR_PROVIDER)` → `Buffer.from(b64,'base64')` → `transcribeOneShot(bytes, {mimeType})`。无 Prisma/tx/落库。
- **module**：`ideation.module.ts`（CHANGE）—— 加 controller + usecase；**移除** `IdeationAsrWsUseCase` + `IdeationAsrWsRoute`；ASR fake 工厂改新 `FakeAsrConfig` 形状。
- **音频格式**：客户端录 m4a/aac mono ~16kHz → base64 → server 拼 `data:<mimeType>;base64,<data>` data-URL 内联。**AAC 原生被 DashScope 接受 → 无服务端转码/无 ffmpeg**。base64-in-JSON 契合现有 OpenAPI/orval 契约（无 multipart）。
- **降级**（FR-009）：provider 错误 → ProblemDetail（ADR-0038）降级码让 mobile 落 toast，**绝不**崩会话；静音空 → `{text:''}`（client 不回填 + 「未识别到语音」）；60s 上限由 client 计时主动 ✓ 确认（server 侧无感）。

#### 3. transcript 入对话轮（复用既有路径）

- transcribe 端点**只返回 transcript 文本到 mobile 输入框**，不写库。用户编辑后**经既有** `POST /api/v1/ideation/sessions/{id}/turns`（`content`）发送 —— 与键盘输入同一 UC/SSE 闭环（FR-004 / SC-006）。server ASR 范围**不碰 ideation 持久化**。

#### 4. mobile 录音 + 上传 + UI

- **录音 hook**（`use-ideation-voice.ts` REWRITE）：`react-native-nitro-sound`（API ≈ 老牌 recorder-player）：`startRecorder(undefined, audioSet, /*meteringEnabled*/true)` + `addRecordBackListener(e=>e.currentMetering)` + `stopRecorder()`。`audioSet` iOS `AVFormatIDKeyType.aac`/`AVSampleRateKeyIOS:16000`/`AVNumberOfChannelsKeyIOS:1`，Android `AudioEncoderAndroid.AAC`/`OutputFormatAndroid.MPEG_4`/`AudioSamplingRateAndroid:16000`（→ m4a/aac）。surface：`requestPermission()`（拒不 throw）/ `start(onMeter:(db:number)=>void)` / `stopAndGetUri()` / `cancel()`。e2e seam = `globalThis.__NVY_ASR_RECORDER_E2E__`（§5 别表）。**Spike 前置**：华为真机实证 nitro-sound 录 m4a + metering（G-1 剩余闭环）。
- **上传**（`asr-upload.ts` ADD）：录音文件 → base64（`expo-file-system` `readAsStringAsync`，确认已装）→ 调**生成 fn** `ideationControllerTranscribe({audioBase64, mimeType:'audio/aac'})` → `{text}`（禁手写 fetch/axios）。
- **状态机**（`ideation-voice-reducer.ts` REWRITE）：`idle → requesting-perm → recording → processing → filled → error`（删 cancel-armed/drag）。保留 mutex（streaming 时禁录）、interrupt（后台/离屏 → cancel）、60s cap（auto-✓）。纯 reducer，vitest。
- **编排 hook**（`use-ideation-recording.ts` REWRITE）：点 mic → 权限 → recording（metering 喂波形 shared value）。✓ → `stopAndGetUri` → `asr-upload` → 文本经 **`insert-at-cursor.ts`（复用不改）** 合并回草稿 + 设光标；空文本 → 降级 'empty'。✗ → `cancel`（零副作用，草稿不动）。错误 → 降级 'transcribe'。删 WS handle / partial 回填 / onPanY / drag 阈值。保留 onDegrade 3 态、60s 计时、AppState interrupt、unmount teardown。
- **波形**（`IdeationWaveform.tsx` ADD）：SVG bars + reanimated shared values，props `{levels:number[]; active:boolean}`，平基线 → 随归一化 metering 起伏；仅 NativeWind token；`accessibilityLabel`。归一化 `normalizeMeter(db):number` 抽纯 fn `waveform-normalize.ts`（ADD）+ vitest（不渲染组件，遵测试分层）。
- **流式互斥**（FR-011）：`status==='streaming'` → mic disabled。
- **中断**（FR-015）：后台/来电/离屏 → 一律 cancel + 释放麦克风（无 partial 可收）。
- **InputBar 接线**（`ClarifyChatScreen.tsx` CHANGE，替 `:584-593` 现 stub）：删 `RecordingStrip` + partial 显示 + `Gesture.Pan`/长按+pan + `onPanY` + partial 驱动的 `editable=false`。加：点 mic（普通 `Pressable` onPress）→ 录音面板 `<IdeationWaveform active>` + ✓（右）/ ✗（左）；✓ → `<Spinner>`（ui/）processing；输入框保持可编辑，成功经 insert-at-cursor 回填。4 态 idle|recording|processing|error + `<ErrorRow>` + degrade toast；mic/✓/✗ a11y label。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发/事务**：本 feature **不写库**（音频不落，transcript 走既有 turn 端点）→ 无新事务/状态转换。transcribe 是单次请求-响应 I/O，非 tx 内。
- **安全**：`DASHSCOPE_API_KEY` 经 env 注入、`Authorization: Bearer`，**client 不直连 DashScope、不下发 token**（FR-014）；**不入日志/不回前端**。transcribe 端点走标准 `JwtAuthGuard` Guard 链。降级提示**不泄露**内部错误（只「转写失败」泛化文案）；体积上限 `@MaxLength` + 60s cap 防超 10MB。
- **前端（mobile）**：复用 `~/theme`+`~/ui`（`IconButton` / `Spinner` / `ErrorRow` 复用）；非表单（RHF 不涉）；hermetic e2e = 契约镜像（fake recorder seam + `route.fulfill` mock `{text}`，禁按测试标志分支）；NativeWind ≤4 原子抽组件（波形面板）。

## Complexity Tracking

> 无 constitution 违背需 justify（§I mockup gate 已满足）。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| （无） | — | — |
