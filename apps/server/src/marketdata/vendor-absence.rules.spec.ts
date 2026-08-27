import { describe, it, expect } from 'vitest';
import {
  VENDOR_STRING_NULL_SENTINEL,
  normalizeQuoteSide,
  strOrNullSentinelAware,
  tradedPriceOrNull,
  INDISTINGUISHABLE_ZERO_FIELDS,
} from './vendor-absence.rules.js';

/**
 * vendor 缺失语义归一化 单测 (#172, Small —— 纯函数零 I/O)。
 *
 * 🚨 本文件盯的是「**盲写会踩、且踩了不会红**」的那一类:
 * ① `(price, size)` **成对**才判缺失 —— 单看 price 会误杀合法零价买盘 (OPRA Binary Spec
 *    明写「Zero in the bid price field represents a valid Bid Price」)。反臂在下面
 * ② 不一致形态 (`price=0 ∧ size>0` 等) **原样保留 + 报 inconsistent**, 不猜、不丢行 ——
 *    它是「哨兵理论破裂」的唯一信号, 归一掉就等于把警报器拆了
 * ③ 归一化后 price 与 size **同进同退** —— 只 null 掉 price 会留下一个「没有价但有量」
 *    的自相矛盾行, 比原状更难查
 */

describe('normalizeQuoteSide', () => {
  describe('🚨 缺失: (price, size) 同时为 0 才算', () => {
    it('(0, 0) → absent, price 与 size 双双落 null', () => {
      // 富途用 (price=0, vol=0) 表示「这一侧没有挂单」—— 实测 523 + 185395 行零例外。
      expect(normalizeQuoteSide(0, 0)).toEqual({ price: null, size: null, form: 'absent' });
    });

    it('字符串形态的 0 同样认 (vendor 数值列偶发下发字符串)', () => {
      expect(normalizeQuoteSide('0', '0')).toEqual({ price: null, size: null, form: 'absent' });
      expect(normalizeQuoteSide('0.00', '0')).toEqual({ price: null, size: null, form: 'absent' });
    });

    it('两侧都没下发 (null/undefined) → 也是 absent', () => {
      expect(normalizeQuoteSide(null, null)).toEqual({ price: null, size: null, form: 'absent' });
      expect(normalizeQuoteSide(undefined, undefined)).toEqual({
        price: null,
        size: null,
        form: 'absent',
      });
    });
  });

  describe('🚨 反臂: 零价 + 有量 = 合法报价, MUST NOT 当缺失', () => {
    it('(0, 5) → 原样保留, 判 inconsistent 而**不是** absent', () => {
      // OPRA Binary Spec: 「Zero in the bid price field represents a valid Bid Price」。
      // 写成 `if (price === 0) return null` 会在这一档静默吃掉真实报价 —— 且不会红。
      const r = normalizeQuoteSide(0, 5);
      expect(r.price).toBe('0');
      expect(r.size).toBe('5');
      expect(r.form).toBe('inconsistent');
    });

    it('(2.4, 0) → 有价无量, 同样原样保留 + inconsistent', () => {
      const r = normalizeQuoteSide(2.4, 0);
      expect(r.price).toBe('2.4');
      expect(r.size).toBe('0');
      expect(r.form).toBe('inconsistent');
    });

    it('单边缺失 (price 有 / size 没下发) → inconsistent, 不猜', () => {
      expect(normalizeQuoteSide(2.4, null).form).toBe('inconsistent');
      expect(normalizeQuoteSide(null, 5).form).toBe('inconsistent');
    });

    it('负价 → inconsistent (不可能的真实报价, 但不丢行)', () => {
      const r = normalizeQuoteSide(-1, 3);
      expect(r.price).toBe('-1');
      expect(r.form).toBe('inconsistent');
    });
  });

  describe('正常报价原样透传', () => {
    it('(2.4, 60) → quoted, 两个值都不动', () => {
      expect(normalizeQuoteSide(2.4, 60)).toEqual({
        price: '2.4',
        size: '60',
        form: 'quoted',
      });
    });

    it('非有限数走既有的 numToString 语义 → null', () => {
      // NaN / Infinity 是**传输形态**的坏值, 与业务语义的「没有」不同源, 但归宿同样是 null。
      expect(normalizeQuoteSide(Number.NaN, Number.NaN).form).toBe('absent');
    });
  });
});

describe('strOrNullSentinelAware', () => {
  it(`'${VENDOR_STRING_NULL_SENTINEL}' → null (066 T01 立的规矩, 收编进同一张表)`, () => {
    expect(strOrNullSentinelAware('N/A')).toBeNull();
    expect(strOrNullSentinelAware('n/a')).toBeNull();
    expect(strOrNullSentinelAware('  N/A  ')).toBeNull();
  });

  it('正常字符串 trim 后原样', () => {
    expect(strOrNullSentinelAware('  AM ')).toBe('AM');
  });

  it('空串 / 非字符串 → null', () => {
    expect(strOrNullSentinelAware('')).toBeNull();
    expect(strOrNullSentinelAware(null)).toBeNull();
    expect(strOrNullSentinelAware(42)).toBeNull();
  });
});

describe('tradedPriceOrNull', () => {
  // 判据来源 = 富途官方书面答复 (py-futu-api#258, 2026-08-27), **不是**从数据反推:
  // 「期权成交价恒为正值(最小价位 > 0), 接口返回的 0 一律表示『无最后成交价』,
  //   不存在『真实成交价恰为 0』的情况」。
  it('🚨 0 = 无值 —— 单列判据即可, 不需要伴生字段', () => {
    expect(tradedPriceOrNull(0)).toBeNull();
    expect(tradedPriceOrNull('0')).toBeNull();
    expect(tradedPriceOrNull('0.00')).toBeNull();
    expect(tradedPriceOrNull('-0')).toBeNull();
  });

  it('🚨 反臂: 非零价原样透传 (含极小价, MUST NOT 因为「看着像 0」就吃掉)', () => {
    expect(tradedPriceOrNull(6.74)).toBe('6.74');
    expect(tradedPriceOrNull('8.37')).toBe('8.37');
    // 期权最小价位可以很小 —— 0.01 / 0.0001 都是真价, 归一掉就是静默吃掉真实成交。
    expect(tradedPriceOrNull(0.01)).toBe('0.01');
    expect(tradedPriceOrNull('0.0001')).toBe('0.0001');
  });

  it('带外缺失照旧 null (与 numToString 同口径, 本函数只是多认一个带内哨兵)', () => {
    expect(tradedPriceOrNull(undefined)).toBeNull();
    expect(tradedPriceOrNull(null)).toBeNull();
    expect(tradedPriceOrNull('')).toBeNull();
    expect(tradedPriceOrNull('  ')).toBeNull();
    expect(tradedPriceOrNull(Number.NaN)).toBeNull();
    expect(tradedPriceOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(tradedPriceOrNull('abc')).toBeNull();
  });

  it('🚨 负控制: 它与 normalizeQuoteSide 的判据**故意不同** —— 盘口价单列判会误杀合法零价', () => {
    // OPRA: 「Zero in the bid price field represents a valid Bid Price」⇒ 盘口必须成对判。
    // 成交价没有这条反向约束(官方明说恒为正), 所以才允许单列。两处判据不得互相套用。
    expect(normalizeQuoteSide(0, 5)).toEqual({ price: '0', size: '5', form: 'inconsistent' });
    expect(tradedPriceOrNull(0)).toBeNull();
  });
});

describe('INDISTINGUISHABLE_ZERO_FIELDS', () => {
  it('把「分不出来」的列显式登记, 而不是留白', () => {
    // 🚨 这条断言的价值不在于它验了什么逻辑, 在于**改这张表必须改测试** ——
    // 哪天有人想当然地把 open_interest 也 0→null, 会先在这里撞上。
    // volume / open_interest 的 0 是**合法值**(今天真没成交 / 真没持仓), 且无伴生字段消歧
    // ⇒ vendor 契约层的信息丢失, 本地无解。
    expect([...INDISTINGUISHABLE_ZERO_FIELDS].sort()).toEqual(
      ['open_interest', 'net_open_interest', 'turnover', 'volume'].sort(),
    );
  });
});
