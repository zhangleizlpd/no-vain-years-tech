import { describe, it, expect } from 'vitest';
import { StaticCalendarAdapter } from './static-calendar.adapter.js';
import { STATIC_CALENDAR_COVERAGE } from './static-calendar.data.js';

/**
 * L2 静态离线日历 adapter 单测 (044 T006)。
 *
 * 🚨 **本文件的重心 = Guardrail 7**: 请求区间**未被静态表覆盖范围完全包含 → throw**,
 * 禁返空、**禁返「已覆盖的那部分」**。判据是「**完全包含**」而非「有交集」——
 * 返部分 = 缺失日被当成非交易日 = 静默毒饵 ⇒ **静态层自己就成了第二个 push2delay**。
 *
 * 对照组: 「区间被覆盖但内部确无交易日」(如春节整周) → **返空数组是合法的**, 非 error
 * (port 契约)。「返空」在两种语境下一对一错, 故两者必须成对断言。
 */
const adapter = new StaticCalendarAdapter();

describe('StaticCalendarAdapter', () => {
  describe('命中区间 → 返正确日历', () => {
    it('cn 区间内 → 返该区间交易日 + servedBy=static', async () => {
      const r = await adapter.fetchTradingDates('cn', '2026-03-02', '2026-03-06');
      expect(r.dates).toEqual([
        '2026-03-02',
        '2026-03-03',
        '2026-03-04',
        '2026-03-05',
        '2026-03-06',
      ]);
      expect(r.servedBy).toBe('static');
    });

    it('结果不含周末，且严格落在请求闭区间内', async () => {
      const r = await adapter.fetchTradingDates('hk', '2026-03-02', '2026-03-13');
      expect(r.dates).toHaveLength(10); // 两个完整交易周
      for (const d of r.dates) {
        expect(d >= '2026-03-02').toBe(true);
        expect(d <= '2026-03-13').toBe(true);
      }
    });

    it('🚨 Half Day 计为交易日: hk 2026-02-16 在结果内、cn 同日不在（探针日）', async () => {
      const hk = await adapter.fetchTradingDates('hk', '2026-02-16', '2026-02-16');
      const cn = await adapter.fetchTradingDates('cn', '2026-02-16', '2026-02-16');
      expect(hk.dates).toEqual(['2026-02-16']);
      expect(cn.dates).toEqual([]);
    });

    it('🚨 063 Phase 2: hk 半日市 = half, 同区间其余交易日 = whole', async () => {
      const r = await adapter.fetchTradingDates('hk', '2026-12-01', '2026-12-31');

      // HKEX 官方年历 2026: 平安夜 + 除夕两天半日市 (12-25 圣诞整天休市, 不在 dates 里)。
      expect(r.sessionKinds['2026-12-24']).toBe('half');
      expect(r.sessionKinds['2026-12-31']).toBe('half');
      expect(r.sessionKinds['2026-12-23']).toBe('whole');
      expect(r.sessionKinds['2026-12-25']).toBeUndefined(); // 休市日没有「场」
    });

    it('🚨 春节除夕 2026-02-16 是 hk 半日市 (它同时也是「Half Day 计为交易日」那条的探针日)', async () => {
      const r = await adapter.fetchTradingDates('hk', '2026-02-16', '2026-02-16');
      expect(r.sessionKinds).toEqual({ '2026-02-16': 'half' });
    });

    it('cn 全年零半日市 ⇒ 区间内每天都是 whole (A 股除夕直接休市, 不半开)', async () => {
      const r = await adapter.fetchTradingDates('cn', '2026-12-01', '2026-12-31');
      expect(new Set(Object.values(r.sessionKinds))).toEqual(new Set(['whole']));
    });

    it('🚨 sessionKinds 的 key 恰为 dates —— 非交易日不出现 (它没有「场」)', async () => {
      const r = await adapter.fetchTradingDates('hk', '2026-02-13', '2026-02-20');
      expect(Object.keys(r.sessionKinds).sort()).toEqual([...r.dates].sort());
    });

    it('🚨 Connect 陷阱探针日: 2026-07-01 cn **有**、hk 无（Connect 关闭 ≠ 市场休市）', async () => {
      const cn = await adapter.fetchTradingDates('cn', '2026-07-01', '2026-07-01');
      const hk = await adapter.fetchTradingDates('hk', '2026-07-01', '2026-07-01');
      expect(cn.dates).toEqual(['2026-07-01']);
      expect(hk.dates).toEqual([]);
    });

    it('区间被覆盖但内部确无交易日（春节）→ 返空数组，**不** throw（对照 Guardrail 7）', async () => {
      const r = await adapter.fetchTradingDates('cn', '2026-02-17', '2026-02-19');
      expect(r.dates).toEqual([]);
      expect(r.servedBy).toBe('static');
    });
  });

  describe('🚨 Guardrail 7 — 覆盖范围外必须 throw（判据 = 完全包含，非有交集）', () => {
    it('完全在覆盖之后（2027 整窗）→ throw，禁返空', async () => {
      await expect(adapter.fetchTradingDates('cn', '2027-03-01', '2027-03-31')).rejects.toThrow(
        /覆盖/,
      );
    });

    it('完全在覆盖之前（2025 整窗）→ throw，禁返空', async () => {
      await expect(adapter.fetchTradingDates('hk', '2025-03-01', '2025-03-31')).rejects.toThrow(
        /覆盖/,
      );
    });

    it('🚨🚨 部分重叠 — 跨年窗 2026-12-20..2027-01-20 → throw 而非返「2026 的那部分」', async () => {
      await expect(adapter.fetchTradingDates('cn', '2026-12-20', '2027-01-20')).rejects.toThrow(
        /覆盖/,
      );
    });

    it('🚨🚨 部分重叠（左越界）— 2025-12-20..2026-01-20 → throw 而非返「2026 的那部分」', async () => {
      await expect(adapter.fetchTradingDates('hk', '2025-12-20', '2026-01-20')).rejects.toThrow(
        /覆盖/,
      );
    });

    it('部分重叠时错误信息带请求区间与覆盖区间（年更漏跑要一眼可诊断）', async () => {
      await expect(adapter.fetchTradingDates('cn', '2026-12-20', '2027-01-20')).rejects.toThrow(
        /2026-12-20\.\.2027-01-20/,
      );
    });
  });

  describe('边界年份（闭区间两端恰好贴合 → 放行）', () => {
    it('恰好整年 2026-01-01..2026-12-31 → 放行（不因贴边误判越界）', async () => {
      const r = await adapter.fetchTradingDates('cn', '2026-01-01', '2026-12-31');
      expect(r.dates.length).toBeGreaterThan(200);
      expect(r.servedBy).toBe('static');
    });

    it('覆盖首日 / 末日单日窗 → 放行', async () => {
      await expect(
        adapter.fetchTradingDates(
          'hk',
          STATIC_CALENDAR_COVERAGE.from,
          STATIC_CALENDAR_COVERAGE.from,
        ),
      ).resolves.toMatchObject({ servedBy: 'static' });
      await expect(
        adapter.fetchTradingDates('hk', STATIC_CALENDAR_COVERAGE.to, STATIC_CALENDAR_COVERAGE.to),
      ).resolves.toMatchObject({ servedBy: 'static' });
    });

    it('越界一天（2025-12-31 起）→ throw', async () => {
      await expect(adapter.fetchTradingDates('cn', '2025-12-31', '2026-06-30')).rejects.toThrow(
        /覆盖/,
      );
    });
  });

  describe('us 请求行为（静态表蓄意不含 us）', () => {
    it('us → throw（禁返空让 us 日历静默漏填）', async () => {
      await expect(adapter.fetchTradingDates('us', '2026-03-01', '2026-03-31')).rejects.toThrow(
        /us/,
      );
    });

    it('未知市场 → throw', async () => {
      await expect(adapter.fetchTradingDates('jp', '2026-03-01', '2026-03-31')).rejects.toThrow(
        /不支持市场/,
      );
    });
  });

  describe('非法输入', () => {
    it('非 YYYY-MM-DD → throw（禁字符串比较静默误判覆盖）', async () => {
      await expect(adapter.fetchTradingDates('cn', '2026/03/01', '2026-03-31')).rejects.toThrow(
        /日期/,
      );
    });

    it('from > to → throw', async () => {
      await expect(adapter.fetchTradingDates('cn', '2026-03-31', '2026-03-01')).rejects.toThrow(
        /区间/,
      );
    });
  });
});
