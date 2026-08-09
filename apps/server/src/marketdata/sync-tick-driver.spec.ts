import { describe, it, expect } from 'vitest';
import { computeNext } from './sync-tick-driver.js';

// 017 T013 computeNext 纯函数 (vitest 无容器): from-now 语义是 misfire≠backfill 的实现
// 承重点 — 必须基于 now 算下一触发, 与旧 nextFireAt 无关 (宕机多天不逐天补跑, FR-S04)。
describe('017 T013 computeNext (cron-parser + Asia/Shanghai, from now)', () => {
  it('daily 22:00: now 在今日 22:00 (Shanghai) 前 → 今日 22:00 (14:00Z)', () => {
    const next = computeNext('0 0 22 * * *', new Date('2026-06-03T02:00:00Z')); // 10:00 Shanghai
    expect(next.toISOString()).toBe('2026-06-03T14:00:00.000Z');
  });

  it('daily 22:00: now 已过今日 22:00 → 明日 22:00', () => {
    const next = computeNext('0 0 22 * * *', new Date('2026-06-03T15:00:00Z')); // 23:00 Shanghai
    expect(next.toISOString()).toBe('2026-06-04T14:00:00.000Z');
  });

  it('恰在触发时刻: next 严格未来 (不返回 now 自身)', () => {
    const next = computeNext('0 0 22 * * *', new Date('2026-06-03T14:00:00Z')); // 22:00:00 整
    expect(next.toISOString()).toBe('2026-06-04T14:00:00.000Z');
  });

  it('weekly 周一 22:00: 周三的 now → 下周一 (universe 降频形态)', () => {
    const next = computeNext('0 0 22 * * 1', new Date('2026-06-03T02:00:00Z')); // 周三
    expect(next.toISOString()).toBe('2026-06-08T14:00:00.000Z'); // 2026-06-08 = 周一
  });

  it('misfire≠backfill: 无论 nextFireAt 过期多久, 结果只由 now 决定且严格未来', () => {
    // 模拟宕机 3 天后的首 tick: 函数签名不接收旧 nextFireAt — 结构上排除逐天补跑。
    const now = new Date('2026-06-03T02:00:00Z');
    const next = computeNext('0 0 22 * * *', now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.toISOString()).toBe('2026-06-03T14:00:00.000Z'); // 今天 22:00, 非 05-31+1d。
  });

  it('坏 cronExpr → throw (调用方逐行 catch + 结构化告警, 不静默丢维度)', () => {
    expect(() => computeNext('not-a-cron', new Date('2026-06-03T02:00:00Z'))).toThrow();
  });
});
