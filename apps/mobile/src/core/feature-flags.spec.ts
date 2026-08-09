import { afterEach, describe, expect, it, vi } from 'vitest';

// flag 在 module load 时定值（读 process.env）→ 每例先 stubEnv + resetModules 再动态 import。
async function loadFlag(): Promise<boolean> {
  vi.resetModules();
  const mod = await import('./feature-flags');
  return mod.FEATURE_MARKETS_ENABLED;
}

describe('FEATURE_MARKETS_ENABLED（fail-safe 默认 OFF）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('env 未设 → OFF（忘配 = 公开安全）', async () => {
    vi.stubEnv('EXPO_PUBLIC_FEATURE_MARKETS', '');
    expect(await loadFlag()).toBe(false);
  });

  it('仅显式 "true" → ON', async () => {
    vi.stubEnv('EXPO_PUBLIC_FEATURE_MARKETS', 'true');
    expect(await loadFlag()).toBe(true);
  });

  it('任何非 "true" 值 → OFF（"false" / "1" / "TRUE" / "yes"）', async () => {
    for (const v of ['false', '1', 'TRUE', 'yes', '0']) {
      vi.stubEnv('EXPO_PUBLIC_FEATURE_MARKETS', v);
      expect(await loadFlag()).toBe(false);
    }
  });
});
