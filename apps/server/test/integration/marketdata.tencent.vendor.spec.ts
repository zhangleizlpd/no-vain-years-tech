import { describe, it, expect } from 'vitest';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { TENCENT_PROFILE } from '../../src/marketdata/tencent.constraint-profile';
import { TencentCalendarAdapter } from '../../src/marketdata/tencent-calendar.adapter';

/**
 * 腾讯指数日历源 adapter 真 vendor IT (044 T004, env-gated, 默认 skip)。
 *
 * 目的: 打真腾讯 ifzq kline, **校真 mock 单测无法覆盖的 vendor 契约**: `data.<key>.day[]`
 * 结构 / 响应 key 回显 (`usDJI` → `us.DJI`) / 三市场 symbol (`sh000001`/`hkHSI`/`usDJI`)
 * 是否仍返正确交易日集 / 节假日是否正确缺席 / **`limit` 分片规约在真端是否零丢失**
 * (FR-016)。adapter 的 MARKET_INDEX_SYMBOL + 分片规约在此被证实或证伪。
 *
 * 🚨 **这是本 feature 的回归网**: 东财源被定向下线时**无声无息**、潜伏 2 天才被发现 —— 本
 * 套件固化「腾讯还活着且数据还对」的可执行断言, 防其重蹈覆辙时同样无声。
 *
 * **默认 skip** (env-gated, 沿 RUN_MARKETDATA_IT 范式): 公开端点无 SLA, CI / 常规
 * `nx affected` 不跑, 不触真 vendor。
 *
 * **本地启用**:
 *   RUN_MARKETDATA_IT=true pnpm nx test server -- marketdata.tencent.vendor
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';
const BASE = process.env.TENCENT_CALENDAR_BASE_URL ?? 'https://web.ifzq.gtimg.cn';
const DAY_MS = 86_400_000;

describe.skipIf(!RUN_MARKETDATA_IT)('腾讯指数日历源真 vendor IT (env-gated, 默认 skip)', () => {
  const adapter = new TencentCalendarAdapter(new VendorHttpClient(TENCENT_PROFILE), BASE);
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  it('cn 上证综指: 区间返交易日集 (含 07-13 周一, 排除 07-11/12 周末) + servedBy=tencent', async () => {
    const { dates, servedBy } = await adapter.fetchTradingDates('cn', '2026-07-01', '2026-07-14');
    expect(servedBy).toBe('tencent'); // 自报家门 (降级可观测, FR-014)
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => iso.test(d))).toBe(true);
    expect(dates).toContain('2026-07-13'); // 周一交易日
    expect(dates).not.toContain('2026-07-11'); // 周六
    expect(dates).not.toContain('2026-07-12'); // 周日
  }, 30_000);

  it('hk 恒生指数: 交易日集正确跳过港股节假日 (07-01 特区成立日缺席, 07-02 在)', async () => {
    const { dates } = await adapter.fetchTradingDates('hk', '2026-06-25', '2026-07-07');
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => iso.test(d))).toBe(true);
    expect(dates).toContain('2026-07-02');
    expect(dates).not.toContain('2026-07-01'); // 香港特别行政区成立日 (港股休市)
  }, 30_000);

  it('us 道琼斯: 响应 key 回显 us.DJI 仍解析正确 + 跳过美股节假日 (07-03 独立日观察日缺席)', async () => {
    // 🚨 请求 `usDJI` → 响应 key `us.DJI` (Guardrail 3): 若 adapter 按请求参数查 key,
    // 此处必静默返空 → 下面 length > 0 断言即报警。
    const { dates } = await adapter.fetchTradingDates('us', '2026-06-25', '2026-07-07');
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => iso.test(d))).toBe(true);
    expect(dates).toContain('2026-07-06');
    expect(dates).not.toContain('2026-07-03'); // Independence Day (observed, 美股休市)
  }, 30_000);

  it('日常 30 天窗 (单片) → 交易日数在合理区间 (行为零变, 不被 limit 截断)', async () => {
    const { dates } = await adapter.fetchTradingDates('cn', '2026-06-17', '2026-07-16');
    // 30 自然日 ≈ 20-22 个 A 股交易日 (PoC 实测 20)。被截断 (limit 传错) → 远低于此。
    expect(dates.length).toBeGreaterThanOrEqual(15);
    expect(dates.length).toBeLessThanOrEqual(23);
    expect(dates).toContain('2026-06-17');
  }, 30_000);

  it('🚨 宽区间分片真调 (10yr → 3 片): 零丢失 / 零重复 / 片间无缝 (FR-016 / SC-008)', async () => {
    // 3653 自然日 → 3 片 (1800+1800+53)。若无分片而单片直发 limit=3653 → 真端返
    // `{"code":0,"msg":"param error","data":[]}` → adapter throw (Guardrail 4) → 本例红。
    const { dates } = await adapter.fetchTradingDates('cn', '2016-07-16', '2026-07-16');

    // ① 规模: 10yr × ~243 交易日/年 ≈ 2430。任一片丢失 → 掉到 ~1600 以下。
    expect(dates.length).toBeGreaterThan(2000);
    expect(dates.every((d) => iso.test(d))).toBe(true);
    // ② 零重复 (片间由构造零重叠)。
    expect(new Set(dates).size).toBe(dates.length);

    // ③ 片间无缝: 排序后最大相邻间隔 ≤ 20 天 (最长休市 = 春节 ~11 天)。整片丢失会留下
    //    1800 天的空洞 → 此断言是分片拼接零丢失的**结构性证明**。
    const sorted = [...dates].sort();
    let maxGapDays = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        (Date.parse(`${sorted[i]}T00:00:00Z`) - Date.parse(`${sorted[i - 1]}T00:00:00Z`)) / DAY_MS;
      if (gap > maxGapDays) maxGapDays = gap;
    }
    expect(maxGapDays).toBeLessThanOrEqual(20);

    // ④ 首尾片均有数据 (覆盖真的到边)。
    expect(sorted[0].startsWith('2016-07')).toBe(true);
    expect(sorted[sorted.length - 1].startsWith('2026-07')).toBe(true);
  }, 120_000);
});
