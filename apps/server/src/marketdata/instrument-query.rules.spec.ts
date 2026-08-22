import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTRUMENT_STATUS_FILTER,
  INSTRUMENT_BASICS_MAX_CODES,
  INSTRUMENT_CODE_MAX_LENGTH,
  QUERYABLE_MARKETS,
  parseInstrumentCodes,
  parseInstrumentStatusFilter,
  parseQueryableMarket,
} from './instrument-query.rules.js';

/**
 * guest 通道标的查询的输入校验。
 *
 * 🚨 本文件同时是**通道层那份独立文本的对账基准**: nginx 的 `$arg_market` / `$arg_codes`
 * 两道闸与这里的判据必须同口径 (改一处必改另一处), 通道那一半由 `verify-guards.sh` 闸 9
 * 的反例钉住。两边各拒一次、不依赖对方。
 */
describe('instrument-query.rules — market 白名单', () => {
  it('三个市场全放行 (与行情面的 US-only 刻意不同)', () => {
    for (const market of QUERYABLE_MARKETS) {
      expect(parseQueryableMarket(market)).toEqual({ ok: true, market });
    }
  });

  it('缺失 / 空串 → 拒 (market 必填)', () => {
    expect(parseQueryableMarket(undefined).ok).toBe(false);
    expect(parseQueryableMarket('').ok).toBe(false);
  });

  it('大写 (`US`) → 拒, 且报「须小写」而不是「市场越界」', () => {
    // 报后者会让调方去查「美股是不是不支持了」, 而真正要改的是那两个字母的大小写。
    const parsed = parseQueryableMarket('US');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/lowercase/);
  });

  it('未知市场 (`jp`) → 拒', () => {
    expect(parseQueryableMarket('jp').ok).toBe(false);
  });

  it('带 canonical 冒号前缀 (`us:AOS`) → 拒 —— 本端点的 market 是整个值, 不是前缀', () => {
    expect(parseQueryableMarket('us:AOS').ok).toBe(false);
  });
});

describe('instrument-query.rules — status 过滤', () => {
  it('缺省 active —— 枚举口没有 status 字段可区分已退市标的', () => {
    expect(parseInstrumentStatusFilter(undefined)).toEqual({
      ok: true,
      status: DEFAULT_INSTRUMENT_STATUS_FILTER,
    });
    expect(DEFAULT_INSTRUMENT_STATUS_FILTER).toBe('active');
  });

  it('`all` 是显式要全量的唯一写法', () => {
    expect(parseInstrumentStatusFilter('all')).toEqual({ ok: true, status: 'all' });
  });

  it('未知值 → 拒 (不静默回落到缺省)', () => {
    expect(parseInstrumentStatusFilter('listed').ok).toBe(false);
  });
});

describe('instrument-query.rules — codes 解析', () => {
  it('逗号分隔 + 去空白 + 去空段', () => {
    expect(parseInstrumentCodes(' AOS , PEP ,, KO ')).toEqual({
      ok: true,
      codes: ['AOS', 'PEP', 'KO'],
    });
  });

  it('保序去重 —— missing[] 要能与调方发出去的那一批对上', () => {
    expect(parseInstrumentCodes('PEP,AOS,PEP')).toEqual({ ok: true, codes: ['PEP', 'AOS'] });
  });

  it('空 / 全空段 → 拒', () => {
    expect(parseInstrumentCodes(undefined).ok).toBe(false);
    expect(parseInstrumentCodes('').ok).toBe(false);
    expect(parseInstrumentCodes(' , , ').ok).toBe(false);
  });

  it('registry 里真实存在的特殊形态全放行 (2026-08-22 实测 us 侧 112 条)', () => {
    // 🚨 这一条是本文件最重要的断言。照 `/option-snapshot` 那道闸原样抄 `[A-Za-z0-9.,-]`
    //    会把**我们自己枚举口刚发出去的** code 拒掉 —— 那种坏法调方永远查不出原因。
    //    `_` 97 条 / `*` 13 条 / `/` 1 条 / `-` 1 条 / 小写 7 条。
    const real = ['BRK.B', 'WFC_Z', 'YCY_WS', 'BHVN*', 'PSUS/PS', 'SPGIw', '600519', '00700'];
    expect(parseInstrumentCodes(real.join(','))).toEqual({ ok: true, codes: real });
  });

  it('百分号编码 → 拒 (本闸的全部意义)', () => {
    // nginx 的 $arg_* 不解码: `codes=AOS%2CPEP` 在通道层是一个**不含字面逗号**的单段串。
    // 字符集闸先把 `%` 拒掉, 逗号切分才成立。服务端这一份是独立的第二道。
    const parsed = parseInstrumentCodes('AOS%2CPEP');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/percent-encoding/);
  });

  it('冒号前缀 (`us:AOS`) → 拒 —— 批量口收的是裸 code', () => {
    expect(parseInstrumentCodes('us:AOS').ok).toBe(false);
  });

  it('空白 / 控制字符 → 拒', () => {
    expect(parseInstrumentCodes('AO S').ok).toBe(false);
  });

  it('超过 code 列宽 → 拒 (别穿透到 PG 变 22001)', () => {
    expect(parseInstrumentCodes('A'.repeat(INSTRUMENT_CODE_MAX_LENGTH)).ok).toBe(true);
    expect(parseInstrumentCodes('A'.repeat(INSTRUMENT_CODE_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it(`上限 ${INSTRUMENT_BASICS_MAX_CODES} 个: 恰好放行, 多一个拒`, () => {
    const gen = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`).join(',');
    expect(parseInstrumentCodes(gen(INSTRUMENT_BASICS_MAX_CODES)).ok).toBe(true);
    const over = parseInstrumentCodes(gen(INSTRUMENT_BASICS_MAX_CODES + 1));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.message).toMatch(/at most/);
  });

  it('上限按**去重后**计 —— 重复段不该把调方顶出上限', () => {
    const dup = Array.from({ length: INSTRUMENT_BASICS_MAX_CODES + 50 }, () => 'AOS').join(',');
    expect(parseInstrumentCodes(dup)).toEqual({ ok: true, codes: ['AOS'] });
  });
});
