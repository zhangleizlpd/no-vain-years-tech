import type { AsrProvider, AsrTranscribeOneShotOptions } from './asr-provider.port.js';

/**
 * FakeAsrProvider (035 T002, plan Gate 0.1) — IT/e2e/契约冒烟确定性替身。
 *
 * 真 DashScope 一次性识别非确定 (识别内容随机 / 时延 / 偶发失败),IT 注入本替身得可复现的
 * transcript + 可注入故障,精确驱动 spec state_branches (正常听写 / 静音空 transcript /
 * 转写失败降级)。通过 DI override `ASR_PROVIDER` token 注入 (不 jest.mock,per plan
 *「NO LIFECYCLE MOCKING」)。
 *
 * 编排 (确定性):
 * - `text`       — 返回的 transcript;空串 `''` = 静音空 transcript (FR-008 降级:client 落
 *                  「未识别到语音」)。默认空串。
 * - `fail`       — true → `transcribeOneShot` throw (模拟超时 / 非 2xx / vendor 错误,FR-007/009
 *                  降级:client 落「转写失败」)。
 * - `failReason` — throw 的泛化 Error message (默认 `'asr-failed'`,不含 vendor 细节 / key)。
 */
export interface FakeAsrConfig {
  /** 返回的 transcript;空串 = 静音空 transcript (默认空串)。 */
  text?: string;
  /** true → throw 泛化 Error (模拟转写失败,FR-007/009 降级)。 */
  fail?: boolean;
  /** throw 的泛化 reason (默认 'asr-failed')。 */
  failReason?: string;
}

export class FakeAsrProvider implements AsrProvider {
  constructor(private readonly config: FakeAsrConfig = {}) {}

  transcribeOneShot(audio: Uint8Array, _opts: AsrTranscribeOneShotOptions): Promise<string> {
    void audio; // fake 不读音频内容,仅按 config 回放确定性结果。
    const { text = '', fail, failReason = 'asr-failed' } = this.config;
    if (fail) {
      // 真 provider 失败语义 = throw 泛化 Error (调用方 catch → 降级);不含 vendor 细节 / key。
      return Promise.reject(new Error(failReason));
    }
    return Promise.resolve(text);
  }
}
