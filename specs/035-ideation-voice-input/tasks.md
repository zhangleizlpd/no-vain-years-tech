---
feature_id: 035-ideation-voice-input
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-23'
updated_at: '2026-06-24'
---

# Tasks: 035-ideation-voice-input（ideation 语音输入 · 听写式 B2-2 · 一次性文件识别）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `035-ideation-voice-input` | **设计源**: [ADR-0061](../../docs/adr/0061-ideation-voice-input-asr.md)（传输经 2026-06-24 amendment 翻案）+ [一次性识别 Replan](../../docs/private/plans/2026-06/06-24-ideation-voice-oneshot-replan.md) + [mockup](./design/)（实时帧为历史留痕，代码是真相源）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Spike]` / `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（reducer / 波形归一化）= vitest 无 DB；transcribe 端点 + 端口 = **Testcontainers PG+Redis + fake-asr provider**（`overrideProvider(ASR_PROVIDER)`，`nx test server <file>`，cwd=apps/server）；真 DashScope IT 走 **env-gated**（`RUN_ASR_SYNC_IT`，默认 skip）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e（录音经 fake recorder seam，HTTP transcribe 经 `route.fulfill`）
- 无 task-meta JSON（**manual 模式**，per 004-034）
- 🚨 **接 stub，不重建骨架**：B1（[032](../032-ideation-prd-clarify/spec.md)）SSE 澄清闭环 + B2-1（[033](../033-ideation-multimodal-input-shell/spec.md)）输入栏 chrome（含 mic stub）已 ship，本 feature 只把 mic 接成真功能，**不动**澄清骨架与既有 turn/SSE 路径
- 🚨 **ASR 端口 = 平台 integration**（ADR-0058 同构 `integrations/llm`）：transcribe UC 注入 `ASR_PROVIDER` port（与 `LLM_PROVIDER` 同类 platform infra，无护城河注释要求）；**不 import chat**
- 🚨 **HTTP 一次性传输（Replan §1）**：普通 Nest controller `POST /api/v1/ideation/asr/transcribe`（`@UseGuards(JwtAuthGuard)`，标准 Guard 链，非 raw WS）；server→DashScope 用 **Node 22 全局 `fetch`（零新 server 依赖）** 打 compatible-mode `/chat/completions`；既有 clarify SSE（`reply.hijack`）**不动**，REST transcribe 端点并列新增
- 🚨 **音频不落（Replan §端到端音频格式 / ADR-0061 §5）**：整段录音 base64 上传后服务端只 base64 包裹拼 data-URL 转发，**瞬态字节、永不落库、不上 OSS、无 `IdeaAttachment`**；transcript 经**既有** `POST /ideation/sessions/{id}/turns` 落库（与键盘等价，FR-004/SC-006）。**不触发 ADR-0045，不扩 `Msg` 多模态**
- 🚨 **降级严格分流（FR-007/008/009）**：转写失败/超时/非 2xx（provider throw）→ ProblemDetail + toast「转写失败」，**不崩会话**；静音空 transcript（`{text:''}`）→ 不回填 +「未识别到语音」；60s 上限 → client 计时主动 ✓ 确认按一次性识别处理
- 🚨 **合并插入（FR-010）**：transcript 插入输入框**当前光标处**（无焦点追加末尾），既有文本不覆盖（`insert-at-cursor.ts` 复用不改）；录音中输入框**仍可编辑**（无 partial 机器写入）
- 🚨 **REST 端点进 OpenAPI**：api-client **DOES regen**（`ideationControllerTranscribe`）；mobile **必须**调生成 fn，**禁手写** fetch/axios
- 🚨 **大删 + 新原生依赖（Replan §4 / R-B/R-C/R-D）**：下线整条 WS 流式链路 + 删 `@fastify/websocket`/`@mykin-ai/expo-audio-stream`（删 dep 前 grep 确认孤儿）；加 `react-native-nitro-sound`（新原生模块 → app.config 麦克风串 + dev-client 重 prebuild）。**PR 必 flag 大删 + 真 key + 真机 → auto-merge OFF、建议人工合并**
- **单 PR（per Constitution §V）**：`feat(ideation)` —— server（asr 端口 + transcribe controller + provider）+ 真 server IT + api-client regen + mobile 消费（录音 + 上传 + UI）+ 两层验证全原子 merge

## Path Conventions

- server（改/新）：`apps/server/src/integrations/asr/`（`asr-provider.port.ts` CHANGE / `dashscope-asr.provider.ts` REWRITE / `fake-asr.provider.ts` REWRITE / `asr.module.ts` / `asr.config.ts` 复用 dashscope 分支）+ `apps/server/src/ideation/asr-transcribe.{controller,usecase,request,response}.ts`（new）+ `ideation.module.ts`（CHANGE）
- mobile（改/新）：`apps/mobile/src/ideation/` 的 `use-ideation-voice.ts`（REWRITE nitro 录音）/ `asr-upload.ts`（new）/ `ideation-voice-reducer.ts`（REWRITE）/ `use-ideation-recording.ts`（REWRITE 编排）/ `IdeationWaveform.tsx`（new）/ `waveform-normalize.ts`（new）/ `insert-at-cursor.ts`（复用不改）/ `ClarifyChatScreen.tsx`（CHANGE InputBar）
- e2e：`apps/mobile/e2e/ideation-voice.spec.ts`（REWRITE，fake recorder seam + `route.fulfill`）；contract-smoke `apps/mobile/e2e/contract-smoke/ideation-asr.contract.ts`（REWRITE，HTTP）
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**

---

## Phase 0: Spike — 华为真机 nitro-sound 录制 + metering（G-1 剩余闭环，已完成）

**Goal**：@mykin 正栽在该机型 → 任何录音库换前必在出事机型实证。Spike 录 m4a + metering → 打 qwen 同步验干净。

- [X] T001 [Spike] [Mobile] **nitro-sound 华为真机录 m4a + metering + G-1 验证**（**已完成**，历史留痕）：华为 CET-AL00 dev-client 实测 `react-native-nitro-sound` 录 m4a/aac + `currentMetering` 振幅连续帧；G-1 WeChat A/B 已绿（WeChat m4a base64 → `qwen3-asr-flash` compatible-mode 同步 → 干净无复读；@mykin 16kHz 输入 → 复读，唯一变量 = 录音器 → 锅在 @mykin 采集）。结论：换 nitro-sound 即干净，新架构端到端可用

## Phase 1: Server — integrations/asr 平台端口重写（一次性，ADR-0058 同构）

**Goal**：`asr-provider.port.ts` 改一次性 `transcribeOneShot`；dashscope provider 改 `fetch` compatible-mode；fake provider 改 `FakeAsrConfig`；复用 config dashscope 分支。

- [X] T002 [Server] **asr 端口 + dashscope/fake provider 重写 + config（无新 env）**：`asr-provider.port.ts`（CHANGE）保留 `ASR_PROVIDER` token，新增 `transcribeOneShot(audio: Uint8Array, opts: {mimeType:string; lang?:'zh'}): Promise<string>`（空串=静音；throw=失败），**删** 流式 `transcribe()`/`AsrEvent`/`AsrTranscribeOptions`；`dashscope-asr.provider.ts`（REWRITE）删全部 realtime WS 代码（EventQueue/pumpAudio/session.update.commit/idle timer/`/tmp/asr-cap.pcm` dump），改 Node 22 全局 `fetch` 打 `POST .../compatible-mode/v1/chat/completions`，`model:'qwen3-asr-flash'`，content `{type:'input_audio', input_audio:'data:<mime>;base64,<b64>'}`，Bearer key，解析 `choices[0].message.content`，非 2xx/超时/vendor → 抛泛化 `Error('asr-failed')`（**key/header/body 不入日志**），空白→`''`；`fake-asr.provider.ts`（REWRITE）`FakeAsrConfig {text?;fail?;failReason?}`，`transcribeOneShot` 返 `config.text ?? ''` 或 `fail` 抛；`asr.config.ts` 复用 dashscope 分支（无新 env）。**验**：vitest（fake 正常/静音空/error；dashscope mock `fetch` 验 endpoint/`model`/data-URL/`Bearer` 不入日志/解析/错误泛化/空→'') + `nx run server:lint`（boundaries：integrations 不依赖业务 ctx）+ `check-env-sync` 绿

## Phase 2: Server — transcribe controller + DTO + usecase + module

**Goal**：普通 Nest REST 端点 `POST /api/v1/ideation/asr/transcribe`（`JwtAuthGuard`）+ 贫血 usecase + module 接线（移除 WS UC/Route）。

- [X] T003 [US1] [US3] [Server] **transcribe controller + request/response DTO + usecase + module 改**：`apps/server/src/ideation/asr-transcribe.request.ts`（ADD `{audioBase64:string; mimeType:string}`，class-validator+swagger，`mimeType` `@IsIn(['audio/aac','audio/mp4','audio/wav','audio/mpeg'])`，`audioBase64` `@MaxLength(~14MB)`）+ `asr-transcribe.response.ts`（ADD `{text:string}` 非 null）+ `asr-transcribe.usecase.ts`（ADD `TranscribeAsrUseCase` 贫血，`@Inject(ASR_PROVIDER)` → `Buffer.from(b64,'base64')` → `transcribeOneShot(bytes,{mimeType})`，无 Prisma/tx）+ `asr-transcribe.controller.ts`（ADD `POST /api/v1/ideation/asr/transcribe`，`@UseGuards(JwtAuthGuard)`+`@ApiBearerAuth()`+`@ApiTags('ideation')`+`@HttpCode(200)`，provider 错误 → ProblemDetail ADR-0038 降级）+ `ideation.module.ts`（CHANGE 加 controller+usecase，**移除** `IdeationAsrWsUseCase`+`IdeationAsrWsRoute`，ASR fake 工厂改新 `FakeAsrConfig` 形状）。**验**：随 T004 IT（Guard 走真 DI lifecycle，per Testing Invariants，不单测隔离）；usecase 纯逻辑（b64→bytes→provider）`asr-transcribe.usecase.spec.ts` vitest 可单测

## Phase 3: Server — 真 IT（state_branches 全覆盖）

- [X] T004 [US1] [US3] [Server-IT] **transcribe 端点 state_branches 全覆盖 IT**：`apps/server/test/integration/ideation-asr-transcribe.it.spec.ts`（全 boot Fastify + Testcontainers PG+Redis + `overrideProvider(ASR_PROVIDER)` 注 fake-asr）覆盖：JWT（有效 200 / 无效 401）+ base64 `{audioBase64,mimeType}` → `{text}`（fake 注 text）+ 静音（fake 空 → `{text:''}`）+ 失败（fake fail → ProblemDetail 降级码，会话不受影响）+ DTO 校验（非法 mimeType 400 / 超 `@MaxLength` 413/400）+ **env-gated 真 DashScope IT**（`RUN_ASR_SYNC_IT`：真打 `qwen3-asr-flash` compatible-mode 喂 G-1 样本 m4a 验真转写无复读，默认 skip）

## Phase 4: Contract — export-openapi + api-client regen

- [X] T005 [US1] [Contract] **export-openapi + api-client regen → ideationControllerTranscribe**：per `.claude/rules/api-contract-trigger.md`：`env -u OSS_*` + 显式 dev `DATABASE_URL`/`REDIS_URL` 跑 `pnpm nx affected --target=generate`（export-openapi → orval `api-client:generate`）→ 生成 `ideationControllerTranscribe` 类型化 fn。**验**：`nx run server:export-openapi` openapi.json 含新 POST path；`packages/api-client/src/` 出现 `ideationControllerTranscribe`；typecheck 绿

## Phase 5: Mobile — 录音 hook + 上传 + reducer + 编排 + 波形（纯逻辑可与 server 并行）

**Goal**：nitro 录音 hook + base64 上传调生成 fn + 一次性状态机 + 编排 + 波形组件 + 归一化纯函数。依赖 T005（生成 fn）于上传环节。

- [X] T006 [P] [US1] [US3] [Mobile] **依赖切换 + 录音 hook + 上传 + reducer + 编排 + 波形 + vitest**：`package.json`（CHANGE）加 `react-native-nitro-sound`(+peer `react-native-nitro-modules`)，`app.config` 加 `NSMicrophoneUsageDescription`/Android `RECORD_AUDIO`（删 `@mykin-ai/expo-audio-stream`、`@fastify/websocket` 见 T010 grep 后删）；`use-ideation-voice.ts`（REWRITE）nitro `startRecorder(undefined,audioSet,true)`+`addRecordBackListener(e=>e.currentMetering)`+`stopRecorder()`，surface `requestPermission()`（拒不 throw）/`start(onMeter)`/`stopAndGetUri()`/`cancel()`，e2e seam `globalThis.__NVY_ASR_RECORDER_E2E__`；`asr-upload.ts`（ADD）文件→base64（`expo-file-system`）→调**生成 fn** `ideationControllerTranscribe({audioBase64,mimeType:'audio/aac'})`→`{text}`；`ideation-voice-reducer.ts`（REWRITE）`idle→requesting-perm→recording→processing→filled→error`（删 cancel-armed/drag），保留 mutex/interrupt=cancel/60s cap=auto-✓，纯 reducer vitest；`use-ideation-recording.ts`（REWRITE）点 mic→权限→recording（metering 喂波形 shared value）；✓→stopAndGetUri→asr-upload→`insert-at-cursor`（复用不改）合并+设光标，空→降级 'empty'；✗→cancel 零副作用；错误→降级 'transcribe'；保留 onDegrade 3 态/60s 计时/AppState interrupt=cancel/unmount teardown；`IdeationWaveform.tsx`（ADD）SVG bars+reanimated shared values，props `{levels;active}`，`accessibilityLabel`；`waveform-normalize.ts`（ADD）`normalizeMeter(db):number`+vitest（不渲染组件）。**验**：vitest（reducer 转移全态 / normalizeMeter 边界）+ typecheck

## Phase 6: Mobile — ClarifyChatScreen InputBar 重接（US1 核心 + US2 取消 + US3 降级）

**Goal**：mic stub → 点录音面板（波形 ✓/✗）+ processing spinner + 可编辑回填 + 4 态 + degrade toast + a11y。依赖 T006。

- [X] T007 [US1] [US2] [US3] [Mobile] **InputBar 重接（点 mic → 波形面板 ✓/✗ → processing → 可编辑回填）**：`ClarifyChatScreen.tsx`（CHANGE，替 `:584-593` stub）删 `RecordingStrip`+partial 显示+`Gesture.Pan`/长按+pan+`onPanY`+partial 驱动 `editable=false`；加 点 mic（普通 `Pressable` onPress）→ 录音面板 `<IdeationWaveform active>`+✓（右）/✗（左）→ ✓ → `<Spinner>`（ui/）processing → transcript 经 insert-at-cursor 回填可编辑框（不自动发，FR-003/010）；✗ → cancel 零副作用（FR-005）；4 态 idle|recording|processing|error + `<ErrorRow>` + 三态 degrade toast（`转写失败，请重试或改用键盘`/`未识别到语音`/`已达单段上限（60 秒）`，FR-007/009）；流式态 mic disabled（FR-011）；mic/✓/✗ a11y label。**验**：纯映射（`Record<Reason,Copy>` 穷举）vitest；交互·render·a11y 走 T008 e2e

## Phase 7: 验证（e2e seam + Playwright + contract-smoke + 删死代码 + PR gate）

- [X] T008 [US1] [US2] [US3] [Mobile-E2E] **e2e seam + hermetic UI e2e（语音主干）**：实装 seam `globalThis.__NVY_ASR_RECORDER_E2E__`（web/无真录音器时 `start()`/`stopAndGetUri()` 返确定性 fixture，「仅真模块缺失时启用、生产 bundle 无 `__NVY_*`」铁律）；`apps/mobile/e2e/ideation-voice.spec.ts`（REWRITE，Playwright Expo Web，HTTP transcribe 经 `route.fulfill` 返 `{text:'<fixture>'}` = 契约镜像）验：开会话 → 点 mic 见录音面板+波形 → ✓ → processing → transcript 落框可编辑 → 编辑后发送（走既有 turn SSE）→ ✗ 取消零副作用（草稿不变）→ 权限拒去设置提示 → `route.fulfill` 注 5xx/abort 触发降级 toast（会话继续）。注：Web 无真麦克风 → seam 驱动；真机录音由 T001 Spike + 收尾兜底
- [X] T009 [US1] [Contract-Smoke] **HTTP 契约冒烟**：`apps/mobile/e2e/contract-smoke/ideation-asr.contract.ts`（REWRITE，node 层，testcontainers 真 server + `ASR_PROVIDER=fake` env 注入）：登录 → 类型化 client POST `ideationControllerTranscribe({audioBase64,mimeType})` → 断言 200 `{text}` + 无 JWT 401 → 验契约对齐（path/鉴权/序列化）。落 `nx run mobile:contract-smoke`（本地 `MARKETDATA_PROVIDER=mock` 显式）
- [X] T010 [Mobile] [Server] **删死 WS 栈（单独 flag 的 commit）**：grep 确认孤儿后删 —— Server：`ideation-asr-ws.route.ts`、`ideation-asr-ws.usecase.ts`、`ideation-asr-ws.rules.ts`(+spec)、`@fastify/websocket` 注册+dep；Mobile：`ideation-asr-ws-client.ts`、`ideation-asr-ws-parse.ts`、`ideation-voice-frame.ts`(+spec，PCM 解码死)、`RecordingStrip`、`@mykin-ai/expo-audio-stream` dep。**删 dep 前 grep 确认零其它引用**（stop-signal #2 孪生）。**验**：`nx affected -t lint typecheck test build` 绿（无悬空 import）；本 task 单独 commit 明确 flag 删除规模
- [X] T011 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + boundaries 0 violation（asr 经 `ASR_PROVIDER` port、不 import chat、不碰他 ctx 表、transcribe UC 不写库）+ `[Contract-Smoke]` 绿 + spec `status: planned→implemented` + tasks.md `[X]` 全同步 + PR body 3 checkbox 部署 gate + **flag「大删整条 WS 流式链路（R-B）+ 新原生依赖 nitro-sound 需 dev-client 重 prebuild（R-D）+ 真 `DASHSCOPE_API_KEY` 接线 + 真机录音验证 = 部署/发版前置；auto-merge OFF、建议人工合并」**

---

## Dependencies & 执行顺序

```text
T001(Spike, 已完成) ─────────────────────────────────────────────► （信息前置）
T002(asr 端口+provider 重写) ─► T003(transcribe controller+DTO+usecase+module) ─► T004(IT)
T003/T004 ─► T005(export-openapi + api-client regen) ─► T006 上传环节
T006(mobile 录音+上传+reducer+编排+波形, 纯逻辑可与 T002-T004 并行) ─► T007(InputBar 重接)
T007 ─► T008(hermetic e2e)
T004/T005 ─► T009(Contract-Smoke 真 server HTTP)
T002-T009 ─► T010(删死 WS 栈, 单独 flag commit) ─► T011(PR gate)
```

## 并行机会（per phase）

- **跨 stack 并行**：T006（mobile 录音+reducer+波形，纯逻辑除上传外）不依赖 server runtime → 可与 T002-T004 并行；上传环节（调生成 fn）依赖 T005。
- **Phase 1-3 链**：T002 → T003（依赖端口）→ T004（IT 依赖 controller）顺链。
- **Phase 5-6 链**：T006 → T007（共享 ClarifyChatScreen/reducer，先后）；T008 e2e 收口。
- **删除 T010 放最后**：所有引用切到新路径后再删，避免悬空 import。

## Implementation Strategy（MVP first）

1. **MVP = US1 脊柱**（T002-T004 server transcribe + T005 regen + T006 mobile 录音/上传/编排 + T007 InputBar）：点录 → ✓ → 一次性识别 → transcript 落框 → 发送。过此即 SC-001/002/003（纯语音完成一轮 + processing 指示 + 合理时延 transcript）dogfood 闭环成立。
2. **增量 US2**（T006/T007 内 ✗ 取消 + 权限）：✗ 取消零副作用 + 权限去设置。
3. **增量 US3**（T007 降级 toast + T004 server 降级分支）：失败/静音/上限韧性（SC-004/005）。
4. **收尾**（T008-T011）：e2e + 契约冒烟 + 删死代码 + PR gate。
5. **Clear 检查点批次**（per `.claude/rules/implement-task-closure.md`）：建议批次 =〔T002〕/〔T003-T004〕/〔T005〕/〔T006〕/〔T007〕/〔T008-T009〕/〔T010〕/〔T011〕，每批后停顿提醒 `/clear`。

## 部署 / 发版前置（不在本 impl scope）

- **真 ASR 接线** ✅（2026-06-28 cutover，PR `chore/ideation-asr-prod-cutover`）：`ASR_PROVIDER=dashscope` 已落 `.env.production`；真 `DASHSCOPE_API_KEY`（账号 A）∈ `secrets.enc.env`（035 #564 起在册），经 SOPS 注入 77 prod 容器。落地经 deploy.yml 同套机制手动复放（B2 config gate 过 → `up --force-recreate app`（同 v0.14.0 镜像）→ healthcheck healthy → 公网 `/healthz/live` 绿），并先 `GET compatible-mode/v1/models` 实测 key auth 有效（非仅 zod 非空）。**剩余**：真机端到端录音验证（见下）+ DashScope 计价观测仍 pending。
- **新原生依赖 prebuild**：`react-native-nitro-sound` 是新原生模块 → 需 app.config 麦克风权限串 + dev-client 重 prebuild，否则真机录音失败（web e2e 抓不到，R-D）。
- **真机录音验证**：T001 Spike 已华为真机实测采集+metering+G-1；发版前 iOS/Android dev-client 各走一遍真录音→真 DashScope 一次性识别（对齐 `project_markets_off_compliance_release` 真机验证节奏）。
- **DashScope 计价**：Qwen3-ASR token 计费，控制台核实 ¥/小时（成本观测，非功能门，ADR-0061 Open Q）。
