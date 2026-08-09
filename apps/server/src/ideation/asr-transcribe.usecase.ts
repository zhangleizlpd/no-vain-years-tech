import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ASR_PROVIDER, type AsrProvider } from '../integrations/asr/asr.module';

/**
 * 一次性语音转写 (035 T003, FR-001 / FR-007 / FR-008 / US1 / US3) —— base64 录音 → bytes →
 * `ASR_PROVIDER.transcribeOneShot` → transcript。ideation 叶子 ctx, 直注平台端口 (platform
 * integration, 与 LLM_PROVIDER / CODE_INDEX 同类, 无护城河注释要求 per ADR-0041)。
 *
 * 🚨 贫血 + 无落库 (plan §Impl Guardrails): **无 Prisma / 无 tx** —— 音频是透明瞬态字节,
 * transcript 经既有 turns 端点落库 (与键盘等价, FR-004)。本 UC 只做 b64 解码 + 端口转发 + 降级。
 *
 * 🚨 降级严格分流 (FR-007/008/009, 镜像 RepoCatalogUseCase):
 * - 静音 / 未识别 → 端口返空串 `''` → **原样返回** (200 `{text:''}`, client 落「未识别到语音」)。
 * - 超时 / 非2xx / vendor 错误 → 端口 throw → catch → `ServiceUnavailableException`
 *   (`ASR_TRANSCRIBE_FAILED`) → ProblemDetailFilter 映射 503 RFC 9457 (client toast「转写失败」,
 *   **不崩会话**)。底层错误细节仅入日志, 不外泄 (不回 key / vendor body / stack)。
 */
@Injectable()
export class TranscribeAsrUseCase {
  private readonly logger = new Logger(TranscribeAsrUseCase.name);

  constructor(@Inject(ASR_PROVIDER) private readonly asr: AsrProvider) {}

  async execute(audioBase64: string, mimeType: string): Promise<string> {
    // 透明瞬态字节: b64 → bytes 一次性喂端口 (Buffer 是 Uint8Array 子类, 端口签名兼容)。
    const bytes = Buffer.from(audioBase64, 'base64');
    try {
      return await this.asr.transcribeOneShot(bytes, { mimeType, lang: 'zh' });
    } catch (err) {
      // 转写失败 (超时/非2xx/vendor): 仅记内部日志 (泛化 message, 端口已剥 vendor 细节),
      // 对外只暴露 domain code + 通用 message (不泄 key / 内部状态), 同 RepoCatalogUseCase 范式。
      this.logger.warn(
        `asr transcribe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException({
        code: 'ASR_TRANSCRIBE_FAILED',
        message: '转写失败,请重试或改用键盘',
      });
    }
  }
}
