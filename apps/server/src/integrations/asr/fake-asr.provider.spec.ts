import { describe, it, expect } from 'vitest';
import { FakeAsrProvider } from './fake-asr.provider.js';

/**
 * 035 T002 FakeAsrProvider 单测 — 一次性识别确定性替身。
 *
 * 覆盖 spec state_branches 的 fake 侧契约: 正常 transcript / 静音空串 / 转写失败 throw。
 * 真 boot/IT 经 DI override 注此替身驱动同样分支 (T004)。fake 不读音频字节,仅按 config 回放。
 */

/** 任意一段录音字节 (fake 不读内容)。 */
const AUDIO = new Uint8Array([1, 2, 3, 4]);
const OPTS = { mimeType: 'audio/aac', lang: 'zh' } as const;

describe('FakeAsrProvider', () => {
  it('returns the scripted transcript text', async () => {
    const provider = new FakeAsrProvider({ text: '你想给行情页加收藏' });
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('你想给行情页加收藏');
  });

  it('returns empty string for 静音/未识别 (default config)', async () => {
    const provider = new FakeAsrProvider();
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('');
  });

  it('returns empty string when text explicitly empty (静音空 transcript)', async () => {
    const provider = new FakeAsrProvider({ text: '' });
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('');
  });

  it('throws generic asr-failed when fail set (转写失败降级)', async () => {
    const provider = new FakeAsrProvider({ fail: true });
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).rejects.toThrow('asr-failed');
  });

  it('throws with custom failReason (no vendor detail leaked)', async () => {
    const provider = new FakeAsrProvider({ fail: true, failReason: 'asr-timeout' });
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).rejects.toThrow('asr-timeout');
  });
});
