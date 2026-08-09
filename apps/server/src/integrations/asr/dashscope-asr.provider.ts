import { Injectable, Logger } from '@nestjs/common';
import type { AsrConfig } from '../../config/index.js';
import type { AsrProvider, AsrTranscribeOneShotOptions } from './asr-provider.port.js';

/**
 * DashscopeAsrProvider (035 T002, plan §Architecture Notes #1; 一次性文件识别 Replan §3) —
 * 生产默认 `AsrProvider` 实现,Node 22 全局 `fetch` (undici) 打 DashScope **compatible-mode
 * chat-completions** 一次性文件识别,**零新 npm 依赖**。
 *
 * endpoint **`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`(北京区,与
 * Aliyun server 同区,备案合规)**;鉴权 `Authorization: Bearer <DASHSCOPE_API_KEY>`(账号 A 既有
 * sk-);OpenAI-兼容形态。整段录音字节 base64 → 拼 data-URL `data:<mime>;base64,<b64>` 作单条
 * user 消息的 `input_audio` content item 一次性上传,解析 `choices[0].message.content` 得整段
 * transcript(WeChat A/B 实测干净无复读,Replan §G-1)。
 *
 * 降级 (FR-007/009): 超时 / 非 2xx / vendor 错误 / 解析失败 → 抛泛化 `Error('asr-failed')`
 * (调用方 catch → ProblemDetail「转写失败」);**绝不 throw vendor 细节**。空白转写 → 返 `''`
 * (静音,FR-008 调用方落「未识别到语音」)。
 *
 * **key 安全 (plan §Impl Guardrails / FR-014)**: key 经 env 注入、仅拼进 `Authorization` 头,
 * **绝不入日志、绝不回前端、绝不下发客户端**。日志只记泛化降级标识,不记 header / key / body /
 * 音频内容。真连通在部署 PR 真 key 接线时验 (本 feature 业务 IT 全走 fake-asr)。
 */

/** 北京区 compatible-mode chat-completions endpoint (Replan §3)。 */
const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
/** 一次性听写 model (Replan §G-1 实测干净)。 */
const DASHSCOPE_MODEL = 'qwen3-asr-flash';
/** 单次请求超时 (ms) — 60s 上限录音的一次性识别足够裕量;超时即降级 (FR-007)。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** compatible-mode 响应最小形状 (仅取 transcript 文本路径)。 */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

@Injectable()
export class DashscopeAsrProvider implements AsrProvider {
  private readonly logger = new Logger(DashscopeAsrProvider.name);
  private readonly apiKey: string;

  constructor(config: Extract<AsrConfig, { kind: 'dashscope' }>) {
    this.apiKey = config.apiKey;
  }

  async transcribeOneShot(audio: Uint8Array, opts: AsrTranscribeOneShotOptions): Promise<string> {
    // 整段录音 → base64 → data-URL (字符串形态,vendor 自检容器);key 仅入 Authorization 头 (FR-014)。
    const dataUrl = `data:${opts.mimeType};base64,${Buffer.from(audio).toString('base64')}`;
    const body = JSON.stringify({
      model: DASHSCOPE_MODEL,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: dataUrl }] }],
    });

    let res: Response;
    try {
      res = await fetch(DASHSCOPE_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        // Node 22 全局 AbortSignal.timeout — 超时 fetch reject → 下方 catch 降级 (FR-007)。
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 网络 / 超时 / abort — 不记 detail (可能含连接细节),泛化降级 (安全:不泄内部错误)。
      this.logger.error('dashscope-asr request failed — degrading');
      throw new Error('asr-failed');
    }

    if (!res.ok) {
      // 非 2xx (鉴权 / 限流 / vendor 5xx) — 不读 body 入日志 (可能含 vendor 细节),泛化降级。
      this.logger.error(`dashscope-asr non-2xx status=${res.status} — degrading`);
      throw new Error('asr-failed');
    }

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch {
      this.logger.error('dashscope-asr response parse failed — degrading');
      throw new Error('asr-failed');
    }

    const content = json.choices?.[0]?.message?.content;
    // transcript 文本仅 string 形态;非 string (异常 vendor 结构) → 视作空 (静音降级,不崩)。
    return typeof content === 'string' ? content.trim() : '';
  }
}
