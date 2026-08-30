import { afterEach, describe, expect, it } from 'vitest';
import { optionsdeskConfig } from './optionsdesk.config';

describe('optionsdeskConfig (069 T006, clarify Q3)', () => {
  const KEYS = ['OPTIONSDESK_MARCH_PHI_TIER', 'OPTIONSDESK_MARCH_MODE'] as const;
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('零 env ⇒ 默认 good / phi (默认值真相只在 schema 一处)', () => {
    for (const key of KEYS) delete process.env[key];
    expect(optionsdeskConfig()).toEqual({ marchPhiTier: 'good', marchMode: 'phi' });
  });

  it('显式合法值原样生效', () => {
    process.env.OPTIONSDESK_MARCH_PHI_TIER = 'acceptable';
    process.env.OPTIONSDESK_MARCH_MODE = 'theta';
    expect(optionsdeskConfig()).toEqual({ marchPhiTier: 'acceptable', marchMode: 'theta' });
  });

  it('空串不是缺失 ⇒ boot 抛 (env-file 未加载的静默陷阱, 镜像 marketdata 纪律)', () => {
    process.env.OPTIONSDESK_MARCH_PHI_TIER = '';
    expect(() => optionsdeskConfig()).toThrow();
  });

  it('值域外 (含大小写拼错) ⇒ boot 抛', () => {
    process.env.OPTIONSDESK_MARCH_MODE = 'Theta';
    expect(() => optionsdeskConfig()).toThrow();
  });
});
