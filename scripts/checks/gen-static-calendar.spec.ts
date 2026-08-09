import { describe, expect, it } from 'vitest';
import { assertFullYearCoverage, parseHkexCalendarText } from './gen-static-calendar.js';

/**
 * 🚨 **fixture = 真实 `pdftotext -layout` 输出片段**（poppler 26.07.0 抽 HKEX 2026 Stock
 * Connect 年历，逐字节原样，**非臆造格式**）。列位对齐是本解析器的全部难点 —— 臆造的
 * fixture 会让测试绿而生产错。改 fixture 前先重抽 PDF 核对。
 */

/** Feb 块：HK 2/16 `Half Day`（**交易日**）+ 2/17-19 `Holiday`；SH&SZ 2/16-23 六天 `Holiday`。 */
const FEB_BLOCK = [
  '          Feb               2       3        4        5       6        9    10     11   12    13      16      17      18      19         20       23    24       25    26    27',
  '                           Mon     Tue      Wed      Thu      Fri     Mon   Tue   Wed   Thu   Fri    Mon     Tue     Wed      Thu        Fri     Mon    Tue      Wed   Thu   Fri',
  '       Hong Kong                                                                                    Half Day Holiday Holiday Holiday',
  '  Shanghai & Shenzhen                                                                               Holiday Holiday Holiday Holiday Holiday Holiday',
  '   Northbound Trading                                                                               Closed Closed Closed Closed Closed Closed',
  '   Southbound Trading                                                                               Closed Closed Closed Closed Closed Closed',
].join('\n');

/** Mar 块：整月无假期（四行全空）→ 验「只取工作日」。 */
const MAR_BLOCK = [
  '          Mar               2       3        4        5       6        9    10     11    12   13      16      17      18      19         20       23    24       25    26    27     30   31',
  '                           Mon     Tue      Wed      Thu      Fri     Mon   Tue   Wed   Thu   Fri    Mon     Tue     Wed      Thu        Fri     Mon    Tue      Wed   Thu   Fri   Mon   Tue',
  '       Hong Kong',
  '  Shanghai & Shenzhen',
  '   Northbound Trading',
  '   Southbound Trading',
].join('\n');

/**
 * 🚨🚨 Jul 块 = **Connect 陷阱的真实样本**（plan 实证 4/4）：7-01 港股回归日
 * HK `Holiday` + **SH&SZ 空白（开市）** + Connect 双向 `Closed`。取错行 → cn 凭空丢该日。
 */
const JUL_BLOCK = [
  '           Jul             1         2      3       6       7        8     9    10     13   14     15   16      17       20   21     22   23      24      27       28    29    30      31',
  '                          Wed       Thu     Fri    Mon     Tue      Wed   Thu   Fri   Mon   Tue   Wed   Thu     Fri     Mon   Tue   Wed   Thu     Fri    Mon       Tue   Wed   Thu     Fri',
  '       Hong Kong          Holiday',
  '  Shanghai & Shenzhen',
  '   Northbound Trading     Closed',
  '   Southbound Trading     Closed',
].join('\n');

describe('parseHkexCalendarText', () => {
  describe('🚨 Half Day = 交易日（不是休市）', () => {
    it('HK 2026-02-16 标 `Half Day` → 计入 hk 交易日（误当 Holiday 则每年丢数个交易日）', () => {
      const { hk } = parseHkexCalendarText(FEB_BLOCK, 2026);
      expect(hk).toContain('2026-02-16');
    });

    it('HK 2026-02-17 标 `Holiday` → 不计入 hk 交易日', () => {
      const { hk } = parseHkexCalendarText(FEB_BLOCK, 2026);
      expect(hk).not.toContain('2026-02-17');
    });

    it('SH&SZ 2026-02-16 标 `Holiday` → 不计入 cn（同日 hk 却因 Half Day 计入 → 逐市场独立）', () => {
      const { cn, hk } = parseHkexCalendarText(FEB_BLOCK, 2026);
      expect(cn).not.toContain('2026-02-16');
      expect(hk).toContain('2026-02-16');
    });
  });

  describe('🚨🚨 Connect 行绝不可被误取（Connect 关闭 ≠ 市场休市）', () => {
    it('2026-07-01: HK Holiday + SH&SZ 开市 + Connect 双向 Closed → cn **有**该日、hk 无', () => {
      const { cn, hk } = parseHkexCalendarText(JUL_BLOCK, 2026);
      expect(cn).toContain('2026-07-01');
      expect(hk).not.toContain('2026-07-01');
    });

    it('Jul 全月 cn 无休市 → cn 拿满 23 个工作日（Connect 行若被误取则少 1 天）', () => {
      const { cn } = parseHkexCalendarText(JUL_BLOCK, 2026);
      expect(cn).toHaveLength(23);
    });

    it('Feb SH&SZ 六天 Holiday 与 Connect 六天 Closed 列位不同 → cn 休市日取自 SH&SZ 行', () => {
      const { cn } = parseHkexCalendarText(FEB_BLOCK, 2026);
      // SH&SZ 行 Holiday 覆盖 16/17/18/19/20/23，其余工作日照常开市。
      for (const d of ['02-16', '02-17', '02-18', '02-19', '02-20', '02-23']) {
        expect(cn).not.toContain(`2026-${d}`);
      }
      expect(cn).toContain('2026-02-24');
      expect(cn).toContain('2026-02-13');
    });
  });

  describe('weekdays 完整性锚（两市场皆休市的日子不在 cn/hk 任一）', () => {
    it('Feb 2/17-19 两市场同为 Holiday → 不在 cn 也不在 hk，但**在** weekdays', () => {
      const { cn, hk, weekdays } = parseHkexCalendarText(FEB_BLOCK, 2026);
      for (const d of ['2026-02-17', '2026-02-18', '2026-02-19']) {
        expect(cn).not.toContain(d);
        expect(hk).not.toContain(d);
        expect(weekdays).toContain(d);
      }
    });

    it('weekdays = PDF 列出的全部工作日（Feb 20 个），恒 ≥ cn ∪ hk', () => {
      const { cn, hk, weekdays } = parseHkexCalendarText(FEB_BLOCK, 2026);
      expect(weekdays).toHaveLength(20);
      const union = new Set([...cn, ...hk]);
      // 春节双休 → 并集严格少于工作日数 ⇒ 拿并集当完整性锚会误报（实测全年 253 vs 261）。
      expect(union.size).toBeLessThan(weekdays.length);
      for (const d of union) expect(weekdays).toContain(d);
    });
  });

  describe('只取工作日（PDF 只列 Mon–Fri → 周末天然排除）', () => {
    it('Mar 整月无假期 → 22 个交易日，且不含任何周六/周日', () => {
      const { cn, hk } = parseHkexCalendarText(MAR_BLOCK, 2026);
      expect(cn).toHaveLength(22);
      expect(hk).toHaveLength(22);
      // 2026-03-07 = Sat, 2026-03-08 = Sun —— PDF 根本未列, 解析器无需自算周末。
      expect(cn).not.toContain('2026-03-07');
      expect(cn).not.toContain('2026-03-08');
      for (const d of cn) {
        expect(new Date(`${d}T00:00:00Z`).getUTCDay()).not.toBe(0);
        expect(new Date(`${d}T00:00:00Z`).getUTCDay()).not.toBe(6);
      }
    });
  });

  describe('跨月块解析', () => {
    it('Feb + Mar 两块拼接 → 两月都解析、结果升序、无重复', () => {
      const { cn, hk } = parseHkexCalendarText(`${FEB_BLOCK}\n\n${MAR_BLOCK}`, 2026);
      expect(hk).toContain('2026-02-16');
      expect(hk).toContain('2026-03-02');
      expect(hk).toContain('2026-03-31');
      expect(cn).toEqual([...cn].sort());
      expect(new Set(cn).size).toBe(cn.length);
      // Feb cn 20 工作日 - 6 Holiday = 14; Mar cn 22 全开 → 36
      expect(cn).toHaveLength(36);
    });

    it('三块（Feb + Mar + Jul）→ 各月互不串扰', () => {
      const { cn } = parseHkexCalendarText([FEB_BLOCK, MAR_BLOCK, JUL_BLOCK].join('\n\n'), 2026);
      expect(cn).toHaveLength(14 + 22 + 23);
    });
  });

  describe('结构漂移必须响亮失败（禁静默错解析）', () => {
    it('未知状态词（PDF 新增词汇）→ throw，不静默当成开市', () => {
      const drifted = FEB_BLOCK.replace('Half Day', 'Typhoon ');
      expect(() => parseHkexCalendarText(drifted, 2026)).toThrow(/未知状态词|无法解析/);
    });

    it('年份传错 → 星期标签与真实日历不符 → throw（星期交叉校验兜住月/日错位）', () => {
      expect(() => parseHkexCalendarText(FEB_BLOCK, 2025)).toThrow(/星期/);
    });

    it('星期行与日号行列数不符 → throw', () => {
      const broken = FEB_BLOCK.split('\n');
      broken[1] = broken[1].replace(/\s+Fri$/, '');
      expect(() => parseHkexCalendarText(broken.join('\n'), 2026)).toThrow(/列数|星期/);
    });
  });
});

describe('assertFullYearCoverage', () => {
  it('缺月 → throw（年更只抽到半份 PDF 必须响亮失败）', () => {
    const partial = parseHkexCalendarText(`${FEB_BLOCK}\n\n${MAR_BLOCK}`, 2026);
    expect(() => assertFullYearCoverage(partial, 2026)).toThrow(/月/);
  });
});
