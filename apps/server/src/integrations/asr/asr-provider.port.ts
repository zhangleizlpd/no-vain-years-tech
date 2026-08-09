/**
 * AsrProvider port (035 T002, plan §Architecture Notes #1; 一次性文件识别 Replan §3) —
 * ideation 语音输入 (听写式 dictation, B2-2) 的 ASR vendor I/O 抽象。
 *
 * external vendor I/O 是 ADR-0043 允许的 port/adapter 场景 (sms / push / llm / codeindex
 * 同款,非自有表 repository),归 integrations 平台层 (ADR-0058 第三位租户,紧随 llm/codeindex)。
 * provider-agnostic: DashscopeAsrProvider 是生产绑定 (Node 22 全局 `fetch` 打 DashScope
 * compatible-mode chat-completions 一次性识别),FakeAsrProvider 是 IT/e2e 确定性替身。
 * transcribe UC 注入 `ASR_PROVIDER` 端口即可 (FR-013),二期换厂商 (讯飞/豆包) 仅加 adapter +
 * 改 `ASR_PROVIDER`,不动调用方。
 *
 * 🚨 **一次性文件识别 (非流式)**: 整段录音字节一次喂入,得整段 transcript 字符串。下线了旧版
 * realtime WS 流式 (`transcribe()` AsyncIterable + `AsrEvent` 帧) —— 真正治复读的是退役
 * @mykin 换 nitro-sound 录音器,一次性 HTTP 文件识别是配套的 UX/架构简化 (Replan §1)。
 *
 * 测试用真 DI 容器 override 此 token 注入 FakeAsrProvider,不 jest.mock
 * (per plan Architecture Notes「NO LIFECYCLE MOCKING」)。
 */

/** DI token — transcribe UC 注入 `AsrProvider` 接口而非具体类 (便于 IT override)。 */
export const ASR_PROVIDER = Symbol('ASR_PROVIDER');

/**
 * 一次性转写选项。
 * - `mimeType` — 音频容器 MIME (`audio/aac` / `audio/mp4` / `audio/wav` / `audio/mpeg`),
 *   provider 拼进 data-URL `data:<mime>;base64,<b64>` 透传 vendor (vendor 自检容器)。
 * - `lang`     — 识别语言,缺省中文 (qwen3-asr 多语,本 feature 仅中文)。
 */
export interface AsrTranscribeOneShotOptions {
  mimeType: string;
  lang?: 'zh';
}

export interface AsrProvider {
  /**
   * 一次性转写: 吃整段录音字节 `audio` (任意被接受的容器, 见 `opts.mimeType`),返整段
   * transcript 文本。**静音 / 未识别到语音 → 返空串 `''`** (调用方落「未识别到语音」降级,
   * FR-008);超时 / 非 2xx / vendor 错误 → **throw 泛化 Error** (调用方 catch → ProblemDetail
   * 「转写失败」降级, FR-007/009;error 不含 vendor 细节 / 不含 key, plan §Impl Guardrails)。
   */
  transcribeOneShot(audio: Uint8Array, opts: AsrTranscribeOneShotOptions): Promise<string>;
}
