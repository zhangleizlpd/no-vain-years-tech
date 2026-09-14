import { afterEach, describe, expect, it } from 'vitest';
import { optionsdeskConfig } from './optionsdesk.config';

describe('optionsdeskConfig (069 T006, clarify Q3)', () => {
  const KEYS = [
    'OPTIONSDESK_MARCH_PHI_TIER',
    'OPTIONSDESK_MARCH_MODE',
    'BROKER_SYNC_SCOPE',
  ] as const;
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('零 env ⇒ 默认 good / phi (默认值真相只在 schema 一处)', () => {
    for (const key of KEYS) delete process.env[key];
    expect(optionsdeskConfig()).toEqual({
      marchPhiTier: 'good',
      marchMode: 'phi',
      brokerSyncScope: 'anchored',
    });
  });

  it('显式合法值原样生效', () => {
    process.env.OPTIONSDESK_MARCH_PHI_TIER = 'acceptable';
    process.env.OPTIONSDESK_MARCH_MODE = 'theta';
    expect(optionsdeskConfig()).toEqual({
      marchPhiTier: 'acceptable',
      marchMode: 'theta',
      brokerSyncScope: 'anchored',
    });
  });

  /**
   * 082 T011 (plan D11; FR-005): `BROKER_SYNC_SCOPE`, 同文件「缺失 → 默认, 非法 (含空串) → boot 抛」。
   *
   * 定向变异 (out-of-test sabotage, testing.md §7.1):
   *   a. 改坏: `.default('anchored')` 换成 `.catch('anchored')` (非法值静默吞成默认) → (2026-09-14 实跑)
   *      2 failed | 6 passed —— ③ ④ 红
   *   还原后 `cmp` 与备份逐字节相同, 8/8 绿
   *   复跑: pnpm nx test server src/config/optionsdesk.config.spec.ts --skip-nx-cache
   */
  describe('brokerSyncScope (082 T011)', () => {
    it('① 缺失 ⇒ anchored', () => {
      delete process.env.BROKER_SYNC_SCOPE;
      expect(optionsdeskConfig().brokerSyncScope).toBe('anchored');
    });

    it('② full ⇒ full', () => {
      process.env.BROKER_SYNC_SCOPE = 'full';
      expect(optionsdeskConfig().brokerSyncScope).toBe('full');
    });

    it('🚨 ③ 空串 ⇒ boot 抛 (不静默当成 anchored)', () => {
      process.env.BROKER_SYNC_SCOPE = '';
      expect(() => optionsdeskConfig()).toThrow();
    });

    it('④ 大小写拼错 `Full` ⇒ boot 抛', () => {
      process.env.BROKER_SYNC_SCOPE = 'Full';
      expect(() => optionsdeskConfig()).toThrow();
    });
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
