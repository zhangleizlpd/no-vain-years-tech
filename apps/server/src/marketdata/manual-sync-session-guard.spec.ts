import { describe, it, expect } from 'vitest';
import {
  assertClosedSessionForManualSync,
  ManualSyncSessionNotClosedError,
} from './manual-sync-session-guard';

/**
 * 手动补采时点闸 (2026-08-17 prod 事故) 的纯单测。
 *
 * 🚨 本文件盯的是**两个方向的错**，缺一不可：
 * ① 放行错数 —— 盘前跑收盘口径维度（事故本体）；
 * ② 误拒合法操作 —— 拦了不该拦的维度 / 时刻，那和 ① 一样是 bug，只是方向相反。
 */
describe('assertClosedSessionForManualSync', () => {
  /** ET 09:07 周一 = 北京 21:07 —— 与 2026-08-17 事故时刻同形（距 16:00 收盘还有近 7 小时）。 */
  const PRE_MARKET = new Date('2026-08-17T13:07:00Z');
  /** ET 18:30 周一 = 北京次日 06:30 —— 夜间轮时刻，已收盘。 */
  const AFTER_CLOSE = new Date('2026-08-17T22:30:00Z');

  const snapshot = { dimensionKey: 'option_daily_snapshot', marketScope: ['us'] };

  it('🚨 事故复现: 盘前跑 option_daily_snapshot ⇒ 抛, 且错误里点名维度与市场', () => {
    expect(() => assertClosedSessionForManualSync([snapshot], PRE_MARKET)).toThrow(
      ManualSyncSessionNotClosedError,
    );
    try {
      assertClosedSessionForManualSync([snapshot], PRE_MARKET);
    } catch (err) {
      expect((err as ManualSyncSessionNotClosedError).offenders).toEqual([
        { dimensionKey: 'option_daily_snapshot', market: 'us' },
      ]);
      // 文案要能指路, 否则操作者只知道被拒、不知道该干嘛。
      expect(String((err as Error).message)).toContain('尚未收盘');
      expect(String((err as Error).message)).toContain('option-snapshot-remediation');
    }
  });

  it('收盘后放行 (夜间轮时刻) —— 本闸对正常补采零影响', () => {
    expect(() => assertClosedSessionForManualSync([snapshot], AFTER_CLOSE)).not.toThrow();
  });

  it('收盘瞬间是闭区间: ET 15:59 拒 / 16:00 放', () => {
    expect(() =>
      assertClosedSessionForManualSync([snapshot], new Date('2026-08-17T19:59:00Z')),
    ).toThrow(ManualSyncSessionNotClosedError);
    expect(() =>
      assertClosedSessionForManualSync([snapshot], new Date('2026-08-17T20:00:00Z')),
    ).not.toThrow();
  });

  it('🚫 不受约束的维度即使盘前也放行 —— 误拒合法操作与放行错数同样是 bug', () => {
    // underlying_iv_daily 同为收盘口径, 但落库是 upsert ⇒ 错行下一轮覆盖修正, 无不可逆后果。
    expect(() =>
      assertClosedSessionForManualSync(
        [
          { dimensionKey: 'underlying_iv_daily', marketScope: ['us'] },
          { dimensionKey: 'us_equity_bar', marketScope: ['us'] },
          { dimensionKey: 'universe', marketScope: ['cn', 'hk', 'us'] },
        ],
        PRE_MARKET,
      ),
    ).not.toThrow();
  });

  it('一批里混着受约束与不受约束 ⇒ 只因受约束那个被拒', () => {
    try {
      assertClosedSessionForManualSync(
        [{ dimensionKey: 'us_equity_bar', marketScope: ['us'] }, snapshot],
        PRE_MARKET,
      );
      expect.unreachable('应当抛');
    } catch (err) {
      expect((err as ManualSyncSessionNotClosedError).offenders).toHaveLength(1);
    }
  });

  it('多市场 scope 取最严: 任一市场未收即拒', () => {
    // 北京 21:07 = ET 09:07(us 未收) / 港股当日 21:07 早已过 16:00 收盘。
    expect(() =>
      assertClosedSessionForManualSync(
        [{ dimensionKey: 'option_daily_snapshot', marketScope: ['hk', 'us'] }],
        PRE_MARKET,
      ),
    ).toThrow(ManualSyncSessionNotClosedError);
  });

  it('scope 缺 / 空 ⇒ 视为不受约束, **不崩** (配置缺一列不该变成 CLI 崩了)', () => {
    expect(() =>
      assertClosedSessionForManualSync(
        [
          { dimensionKey: 'option_daily_snapshot', marketScope: [] },
          { dimensionKey: 'option_daily_snapshot', marketScope: null },
        ],
        PRE_MARKET,
      ),
    ).not.toThrow();
  });
});
