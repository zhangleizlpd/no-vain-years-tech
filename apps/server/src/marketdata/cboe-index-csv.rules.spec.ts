import { describe, it, expect } from 'vitest';
import {
  CBOE_CSV_SKIPPED_SAMPLE_LIMIT,
  CBOE_VIX_CSV_HEADER,
  CBOE_VVIX_CSV_HEADER,
  CboeCsvHeaderError,
  parseCboeIndexCsv,
} from './cboe-index-csv.rules';

/** 真文件形态（2026-08-02 在 77 上实拉首尾行核过）：表头 + 逐日行, 零引号 / 零嵌入逗号。 */
const VIX_CSV = [
  CBOE_VIX_CSV_HEADER,
  '01/02/2004,17.96,18.68,17.54,18.22',
  '12/31/2025,15.1000,15.9,14.87,15.02',
].join('\n');

const VVIX_CSV = [CBOE_VVIX_CSV_HEADER, '01/03/2007,80.06', '07/31/2026,92.1'].join('\n');

describe('parseCboeIndexCsv — VIX 五列表头 (FR-025)', () => {
  it('happy path: 逐行出 OHLC, 日期 MM/DD/YYYY → YYYY-MM-DD', () => {
    const result = parseCboeIndexCsv(VIX_CSV, 'VIX');
    expect(result.indexCode).toBe('VIX');
    expect(result.skipped).toBe(0);
    expect(result.rows).toEqual([
      { date: '2004-01-02', open: '17.96', high: '18.68', low: '17.54', close: '18.22' },
      { date: '2025-12-31', open: '15.1000', high: '15.9', low: '14.87', close: '15.02' },
    ]);
  });

  it('数值原样留字符串 —— 不过 Number(), 交给 Decimal 落库 (禁 Float, 禁精度损失)', () => {
    const { rows } = parseCboeIndexCsv(
      `${CBOE_VIX_CSV_HEADER}\n01/02/2004,17.960000000000001,1,2,3`,
      'VIX',
    );
    expect(rows[0]!.open).toBe('17.960000000000001');
  });
});

describe('parseCboeIndexCsv — VVIX 两列表头 (Guardrail 7 / FR-025)', () => {
  it('🚨 只有 CLOSE ⇒ open/high/low 恒为 null, **不是 0**（填 0 = 假事实进库）', () => {
    const { rows, skipped } = parseCboeIndexCsv(VVIX_CSV, 'VVIX');
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { date: '2007-01-03', open: null, high: null, low: null, close: '80.06' },
      { date: '2026-07-31', open: null, high: null, low: null, close: '92.1' },
    ]);
    for (const r of rows) {
      expect(r.open).toBeNull();
      expect(r.open).not.toBe('0');
      expect(r.high).toBeNull();
      expect(r.low).toBeNull();
    }
  });
});

describe('表头校验 —— 表头变了 = vendor 改格式, 报错而非把表头当数据 (plan D6)', () => {
  it.each([
    ['列变多', 'DATE,OPEN,HIGH,LOW,CLOSE,VOLUME'],
    ['列改名', 'DATE,OPEN,HIGH,LOW,SETTLE'],
    ['列顺序变', 'DATE,CLOSE,OPEN,HIGH,LOW'],
    ['退化成 VVIX 形态', CBOE_VVIX_CSV_HEADER],
    ['首行直接是数据行（无表头）', '01/02/2004,17.96,18.68,17.54,18.22'],
  ])('VIX 表头 %s → 抛 CboeCsvHeaderError', (_label, header) => {
    expect(() => parseCboeIndexCsv(`${header}\n01/02/2004,1,2,3,4`, 'VIX')).toThrow(
      CboeCsvHeaderError,
    );
  });

  it('VVIX 表头变了同样抛', () => {
    expect(() => parseCboeIndexCsv(`DATE,VVIX,EXTRA\n01/03/2007,80.06,1`, 'VVIX')).toThrow(
      CboeCsvHeaderError,
    );
  });

  it('🚨 空文件 → 抛错, **不返回 0 行** —— 0 行会被上游当成「今天没数据」静默吞掉', () => {
    expect(() => parseCboeIndexCsv('', 'VIX')).toThrow(CboeCsvHeaderError);
    expect(() => parseCboeIndexCsv('   \n\n', 'VVIX')).toThrow(CboeCsvHeaderError);
  });

  it('BOM / CRLF / 大小写 / 列内空格不算表头变更（这些是传输噪声, 不是 vendor 改格式）', () => {
    // BOM 字面量在源码里是 lint error（`no-irregular-whitespace`）⇒ 按码点构造。
    const csv = `${String.fromCharCode(0xfeff)}date, Open ,HIGH,LOW,close\r\n01/02/2004,17.96,18.68,17.54,18.22\r\n`;
    const { rows, skipped } = parseCboeIndexCsv(csv, 'VIX');
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { date: '2004-01-02', open: '17.96', high: '18.68', low: '17.54', close: '18.22' },
    ]);
  });
});

describe('非法行处置 —— 跳过并计数, 计数随返回值上抛 (禁静默丢, plan D6)', () => {
  it('只有表头 → 0 行 0 跳过（合法的空结果, 与空文件不同）', () => {
    const result = parseCboeIndexCsv(CBOE_VIX_CSV_HEADER, 'VIX');
    expect(result.rows).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it('尾部空行 / 空白行不计入 skipped（是文件换行, 不是坏数据）', () => {
    const result = parseCboeIndexCsv(`${VIX_CSV}\n\n   \n`, 'VIX');
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it.each([
    ['列数少', '01/02/2004,17.96,18.68,17.54'],
    ['列数多', '01/02/2004,17.96,18.68,17.54,18.22,99'],
    ['close 非数值', '01/02/2004,17.96,18.68,17.54,n/a'],
    ['close 空', '01/02/2004,17.96,18.68,17.54,'],
    ['日期格式不对', '2004-01-02,17.96,18.68,17.54,18.22'],
    ['日期不存在（2 月 30 日）', '02/30/2024,17.96,18.68,17.54,18.22'],
    ['月份越界', '13/01/2024,17.96,18.68,17.54,18.22'],
  ])('%s → 该行跳过且 skipped +1, 合法行照常产出', (_label, badLine) => {
    const result = parseCboeIndexCsv(`${VIX_CSV}\n${badLine}`, 'VIX');
    expect(result.skipped).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.skippedSamples).toEqual([badLine]);
  });

  it('VVIX 侧同样计数（close 非数值）', () => {
    const result = parseCboeIndexCsv(`${VVIX_CSV}\n07/30/2026,`, 'VVIX');
    expect(result.skipped).toBe(1);
    expect(result.rows).toHaveLength(2);
  });

  it('OHLC 中任一列非数值 → 整行跳过（不落半行 / 不拿 null 冒充缺列）', () => {
    const result = parseCboeIndexCsv(
      `${CBOE_VIX_CSV_HEADER}\n01/02/2004,x,18.68,17.54,18.22`,
      'VIX',
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('样本只留前 N 条（日志/告警用）, 但 skipped 计数是全量真值', () => {
    const bad = Array.from({ length: CBOE_CSV_SKIPPED_SAMPLE_LIMIT + 3 }, (_v, i) => `bad-${i}`);
    const result = parseCboeIndexCsv([CBOE_VIX_CSV_HEADER, ...bad].join('\n'), 'VIX');
    expect(result.skipped).toBe(bad.length);
    expect(result.skippedSamples).toHaveLength(CBOE_CSV_SKIPPED_SAMPLE_LIMIT);
    expect(result.skippedSamples[0]).toBe('bad-0');
  });
});
