import { describe, expect, it } from 'vitest';
import {
  BACKFILL_RETRY_CAP_MS,
  RECONCILE_MAX_ATTEMPTS,
  RECONCILE_SLOT_MINUTES,
  RETRY_SPACING_MS,
  decideBackfillAfterInfraFailure,
  decideReconcile,
  type ReconcileInput,
} from './broker-sync-slot.rules';

/**
 * `broker-sync-slot.rules.ts` 纯单测 (082 T009, plan D9; FR-009 / FR-010 / FR-011;
 * state_branches 17, 18, 20, 21, 22, 23, 26, 27, 28, 29)。
 *
 * 入参 `clock` 是调用方用 `exchangeClock` 算好的交易所当地读数 ⇒ 这里直接构造读数, 不涉时区。
 * 夏令时前后 09:10 ET 都读作 `minutesOfDay = 550` 由 `session-clock.spec.ts` (T004 ④ ⑤) 钉住。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   a. 改坏: 失败次数判据 `>= RECONCILE_MAX_ATTEMPTS` 改 `>` → (2026-09-14 实跑) 1 failed | 14 passed —— 只有 ⑥ 红
 *   b. 改坏: 窗口起点固定为 `clock.date − 7` (不看上次成功日) → (2026-09-14 实跑) 1 failed | 14 passed —— 只有 ⑧ 红
 *   c. 改坏: 补齐重试上限比较 `>=` 改 `>` → (2026-09-14 实跑) 1 failed | 14 passed —— 只有 ⑪ 红
 *   三次均还原后 `cmp` 与备份逐字节相同, 15/15 绿
 *   复跑: pnpm nx test server src/optionsdesk/broker-sync-slot.rules.spec.ts --skip-nx-cache
 */

const NOW = new Date('2026-09-14T13:30:00.000Z');
const MIN = 60_000;

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    market: 'us',
    clock: { date: '2026-09-14', minutesOfDay: 550 },
    dayStatus: 'trading',
    todaysRuns: { succeeded: 0, failed: 0, lastFailedAt: null },
    lastSucceededTradingDate: '2026-09-11',
    now: NOW,
    ...overrides,
  };
}

describe('常量 (plan D9; spec Clarifications 第 1 / 5 条)', () => {
  it('时点 = 交易所当地 09:10 / 09:05; 至多 4 次尝试; 间隔 15 min; 补齐上限 24 h', () => {
    expect(RECONCILE_SLOT_MINUTES).toEqual({ us: 9 * 60 + 10, hk: 9 * 60 + 5 });
    expect(RECONCILE_MAX_ATTEMPTS).toBe(4);
    expect(RETRY_SPACING_MS).toBe(15 * MIN);
    expect(BACKFILL_RETRY_CAP_MS).toBe(24 * 60 * MIN);
  });
});

describe('decideReconcile — 到点 / 日历 / 当日结果', () => {
  it('① 美股 549 分 ⇒ skip, 550 分 ⇒ run (branch 20)', () => {
    expect(decideReconcile(input({ clock: { date: '2026-09-14', minutesOfDay: 549 } }))).toEqual({
      action: 'skip',
      reason: 'before-slot',
    });
    expect(decideReconcile(input()).action).toBe('run');
  });

  it('① 港股按自己的时点: 544 分 ⇒ skip, 545 分 ⇒ run', () => {
    const hk = (minutesOfDay: number) =>
      decideReconcile(input({ market: 'hk', clock: { date: '2026-09-14', minutesOfDay } }));
    expect(hk(544)).toEqual({ action: 'skip', reason: 'before-slot' });
    expect(hk(545).action).toBe('run');
  });

  it('② non-trading ⇒ skip (branch 21)', () => {
    expect(decideReconcile(input({ dayStatus: 'non-trading' }))).toEqual({
      action: 'skip',
      reason: 'non-trading',
    });
  });

  it('🚨 ③ unknown (日历未覆盖) ⇒ run, 不当作非交易日 (branch 22)', () => {
    expect(decideReconcile(input({ dayStatus: 'unknown' })).action).toBe('run');
  });

  it('④ 本交易日已成功 ⇒ skip (branch 23)', () => {
    const todaysRuns = { succeeded: 1, failed: 0, lastFailedAt: null };
    expect(decideReconcile(input({ todaysRuns }))).toEqual({
      action: 'skip',
      reason: 'already-succeeded',
    });
  });
});

describe('decideReconcile — 失败重试 (branch 26, 27)', () => {
  it('⑤ 失败 1 次且距今 14 分 ⇒ skip, 15 分 ⇒ run', () => {
    const failedAgo = (minutes: number) =>
      decideReconcile(
        input({
          todaysRuns: {
            succeeded: 0,
            failed: 1,
            lastFailedAt: new Date(NOW.getTime() - minutes * MIN),
          },
        }),
      );
    expect(failedAgo(14)).toEqual({ action: 'skip', reason: 'retry-spacing' });
    expect(failedAgo(15).action).toBe('run');
  });

  it('🚨 ⑥ 失败 4 次 (首次 + 3 次重试用尽) ⇒ skip; 失败 3 次 ⇒ 仍 run', () => {
    const failed = (n: number) =>
      decideReconcile(
        input({
          todaysRuns: { succeeded: 0, failed: n, lastFailedAt: new Date(NOW.getTime() - 60 * MIN) },
        }),
      );
    expect(failed(4)).toEqual({ action: 'skip', reason: 'attempts-exhausted' });
    expect(failed(3).action).toBe('run');
  });
});

describe('decideReconcile — 窗口起点 = min(上次成功日, 今天 − 7 自然日) (branch 28, 29)', () => {
  it('⑦ 上次成功在 3 天前 ⇒ 窗口 7 天', () => {
    expect(decideReconcile(input({ lastSucceededTradingDate: '2026-09-11' }))).toEqual({
      action: 'run',
      windowStart: '2026-09-07',
    });
  });

  it('🚨 ⑧ 上次成功在 12 天前 ⇒ 窗口起点 = 12 天前 (缺口一次补齐)', () => {
    expect(decideReconcile(input({ lastSucceededTradingDate: '2026-09-02' }))).toEqual({
      action: 'run',
      windowStart: '2026-09-02',
    });
  });

  it('⑨ 从未成功 ⇒ 7 天', () => {
    expect(decideReconcile(input({ lastSucceededTradingDate: null }))).toEqual({
      action: 'run',
      windowStart: '2026-09-07',
    });
  });

  it('日历日减法跨月 / 跨年按自然日算', () => {
    const start = (date: string) =>
      decideReconcile(
        input({ clock: { date, minutesOfDay: 600 }, lastSucceededTradingDate: null }),
      );
    expect(start('2026-03-03')).toEqual({ action: 'run', windowStart: '2026-02-24' });
    expect(start('2027-01-05')).toEqual({ action: 'run', windowStart: '2026-12-29' });
  });

  it('clock.date 不是 YYYY-MM-DD ⇒ 抛 (不带着 NaN 日期往下走)', () => {
    expect(() =>
      decideReconcile(input({ clock: { date: '2026/09/14', minutesOfDay: 600 } })),
    ).toThrow(/2026\/09\/14/);
  });
});

describe('decideBackfillAfterInfraFailure — 24 h 上限 (branch 17, 18)', () => {
  it('⑩ 首次尝试距今 23h59m ⇒ pending, nextAttemptAt = now + 15 min', () => {
    const firstAttemptedAt = new Date(NOW.getTime() - (23 * 60 + 59) * MIN);
    expect(decideBackfillAfterInfraFailure({ firstAttemptedAt, now: NOW })).toEqual({
      status: 'pending',
      nextAttemptAt: new Date(NOW.getTime() + 15 * MIN),
    });
  });

  it('🚨 ⑪ 恰好 24h00m ⇒ failed', () => {
    const firstAttemptedAt = new Date(NOW.getTime() - 24 * 60 * MIN);
    expect(decideBackfillAfterInfraFailure({ firstAttemptedAt, now: NOW })).toEqual({
      status: 'failed',
    });
  });
});
