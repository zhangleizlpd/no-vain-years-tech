import { describe, it, expect, vi } from 'vitest';
import { CalendarHitCheck } from './calendar-hit-check.js';

// 019 T013 日历命中检查 (US2/FR-S02, plan D6): source 路由 + 三态防御 (NULL source /
// 未注册 source / checker 异常) 一律按未命中不 throw — 不阻塞其他维度, 下一 tick 重查。
describe('019 T013 CalendarHitCheck (source 路由 + 防御)', () => {
  const dim = (calendarSource: string | null) => ({ dimensionKey: 'test_dim', calendarSource });

  it('已注册 source 命中 → true (checker 收到维度键 + asOf)', async () => {
    const check = new CalendarHitCheck();
    const checker = vi.fn(async () => true);
    check.registerSource('test-source', checker);
    expect(await check.isHit(dim('test-source'), '2026-06-05')).toBe(true);
    expect(checker).toHaveBeenCalledWith('test_dim', '2026-06-05');
  });

  it('已注册 source 未命中 → false (平淡日零组 flow 的判定半)', async () => {
    const check = new CalendarHitCheck();
    check.registerSource('test-source', async () => false);
    expect(await check.isHit(dim('test-source'), '2026-06-05')).toBe(false);
  });

  it('source NULL → 按未命中 (配置残缺防御, 不 throw)', async () => {
    const check = new CalendarHitCheck();
    expect(await check.isHit(dim(null), '2026-06-05')).toBe(false);
  });

  it('未知 source (无注册 checker) → 按未命中 (spec edge case「executor 未注册」同精神)', async () => {
    const check = new CalendarHitCheck();
    expect(await check.isHit(dim('nope-source'), '2026-06-05')).toBe(false);
  });

  it('checker 异常 (端点超时注入) → 按未命中 + 不 throw 不阻塞 (下一 tick 重查)', async () => {
    const check = new CalendarHitCheck();
    check.registerSource('flaky', async () => {
      throw new Error('vendor calendar timeout');
    });
    await expect(check.isHit(dim('flaky'), '2026-06-05')).resolves.toBe(false);
  });
});
