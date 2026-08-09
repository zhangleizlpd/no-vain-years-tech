import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { TranscribeAsrUseCase } from './asr-transcribe.usecase.js';
import type { AsrProvider } from '../integrations/asr/asr.module.js';

/**
 * 035 T003 TranscribeAsrUseCase 单测 (纯逻辑) — b64 解码 + 端口转发 + 降级分流。
 * 端口替身 = vi.fn 桩 (vendor 边界, 非 lifecycle class); 真 DI 装配走 T004 IT。
 */

function makeUseCase(provider: Pick<AsrProvider, 'transcribeOneShot'>): TranscribeAsrUseCase {
  return new TranscribeAsrUseCase(provider as AsrProvider);
}

describe('TranscribeAsrUseCase', () => {
  it('decodes base64 to bytes and forwards mimeType + zh lang to the port', async () => {
    const spy = vi.fn().mockResolvedValue('你好');
    const uc = makeUseCase({ transcribeOneShot: spy });

    const audio = Buffer.from([1, 2, 3, 4]);
    const result = await uc.execute(audio.toString('base64'), 'audio/aac');

    expect(result).toBe('你好');
    expect(spy).toHaveBeenCalledTimes(1);
    const [bytes, opts] = spy.mock.calls[0] as [Uint8Array, { mimeType: string; lang?: string }];
    expect(Buffer.from(bytes).equals(audio)).toBe(true);
    expect(opts).toEqual({ mimeType: 'audio/aac', lang: 'zh' });
  });

  it('returns empty string transparently (静音 — not an error)', async () => {
    const uc = makeUseCase({ transcribeOneShot: vi.fn().mockResolvedValue('') });
    await expect(uc.execute(Buffer.from([0]).toString('base64'), 'audio/aac')).resolves.toBe('');
  });

  it('maps port throw to 503 ASR_TRANSCRIBE_FAILED (no vendor detail leaked)', async () => {
    const uc = makeUseCase({
      transcribeOneShot: vi.fn().mockRejectedValue(new Error('asr-failed')),
    });

    await expect(uc.execute('AAA=', 'audio/aac')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    try {
      await uc.execute('AAA=', 'audio/aac');
    } catch (err) {
      const body = (err as ServiceUnavailableException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body.code).toBe('ASR_TRANSCRIBE_FAILED');
      expect(body.message).not.toContain('asr-failed'); // 底层 reason 不外泄
    }
  });
});
