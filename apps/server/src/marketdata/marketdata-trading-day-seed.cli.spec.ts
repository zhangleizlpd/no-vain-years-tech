import { describe, it, expect } from 'vitest';
import { parseSeedArgs } from './marketdata-trading-day-seed.cli.js';

/**
 * trading-day seed CLI 参数解析单测 (sync-1 S1-T2)。执行本体 (syncRange 落库) 由 Testcontainers
 * IT (marketdata.trading-calendar-sync.it) 校真; 此处只验 argv → SeedArgs 解析 + 校验。
 */
describe('parseSeedArgs', () => {
  it('缺省: markets=cn,hk,us, from=DEFAULT, to 未定 (运行时求今日)', () => {
    expect(parseSeedArgs([])).toEqual({ markets: ['cn', 'hk', 'us'], from: '2015-01-01' });
  });

  it('--from / --to / --markets 全解析', () => {
    expect(
      parseSeedArgs(['--from', '2018-01-01', '--to', '2026-07-14', '--markets', 'cn,hk']),
    ).toEqual({ markets: ['cn', 'hk'], from: '2018-01-01', to: '2026-07-14' });
  });

  it('坏 --from (非 YYYY-MM-DD) → 抛', () => {
    expect(() => parseSeedArgs(['--from', '20180101'])).toThrow(/--from 须为 YYYY-MM-DD/);
  });

  it('坏 --to (非 YYYY-MM-DD) → 抛', () => {
    expect(() => parseSeedArgs(['--to', 'yesterday'])).toThrow(/--to 须为 YYYY-MM-DD/);
  });

  it('空 --markets → 抛', () => {
    expect(() => parseSeedArgs(['--markets', ''])).toThrow(/--markets 不可为空/);
  });
});
