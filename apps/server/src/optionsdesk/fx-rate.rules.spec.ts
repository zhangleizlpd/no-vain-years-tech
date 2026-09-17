import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { FX_PAIRS, type FxPair } from './fx-rate.port';
import { decodeGbk, invertRate, parseSinaFx, parseTencentFx } from './fx-rate.rules';

/**
 * 085 T001 FX 解析纯函数 (FR-002 / FR-006; plan D3; state_branches 8, 9)。
 *
 * 🚨 **夹具汇率一律合成值**: 真实值 `0.8549` (HKD→CNY) 含子串 `0.8` ⇒ 会被
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 当场判成「档位系数外溢」
 * (该不变量的扫描面含 `*.spec.ts`, 刻意不排除)。同理 `0.6` / `1.2` 也不得出现。
 */

/** 请求的三对 —— 与 port 的 {@link FX_PAIRS} 同一份, 不另抄字面量。 */
const ALL_PAIRS: readonly FxPair[] = FX_PAIRS;

/** 合成汇率 (一眼可辨不是真值; 逐个避开 `0.8` / `0.6` / `1.2`)。 */
const SYNTHETIC_RATE: Record<FxPair, string> = {
  USDCNY: '7.1500',
  HKDCNY: '0.9500',
  USDHKD: '2.5000',
};

/**
 * 腾讯 `wh` 响应一行 —— `~` 分隔 22 字段, 形态照 plan §D3 的字段位对照表
 * (样本 `whUSDCNY`, plan 作者 2026-09-17 09:48:11 实拉)。
 *
 * 🚨 `f10` 蓄意给一个**与 `f3` 不同**的值: 取错价格位 (f10 / f11) 的实现在「稳态下 f10 == f3」
 * 的夹具上会**照样绿** —— 定向变异 c 靠这个差值才红。
 */
function tencentLine(
  pair: FxPair,
  name: string,
  fields: { f3: string; f5?: string; f10?: string; f11?: string },
): string {
  const seg = new Array<string>(22).fill('0');
  seg[0] = '310';
  seg[1] = name;
  seg[2] = pair;
  seg[3] = fields.f3;
  seg[5] = fields.f5 ?? '20260917094811';
  seg[10] = fields.f10 ?? '9.9999';
  seg[11] = fields.f11 ?? '3.3333';
  return `v_wh${pair}="${seg.join('~')}";`;
}

/**
 * 新浪 `fx_s<pair>` 响应一行 —— `,` 分隔, 只有 `idx3` 被消费。
 * `idx1` / `idx2` / `idx8` 给**互不相同的诱饵值**: 取错字段的实现必须在此当场红
 * (EVIDENCE: `idx8` 与腾讯 `f3` 不吻合且会摆动 —— plan 作者 2026-09-17 补测)。
 */
function sinaLine(
  pair: FxPair,
  fields: { idx3: string; idx1?: string; idx2?: string; idx8?: string },
): string {
  const seg = new Array<string>(12).fill('0');
  seg[0] = '20260917094811';
  seg[1] = fields.idx1 ?? '5.5555';
  seg[2] = fields.idx2 ?? '4.4444';
  seg[3] = fields.idx3;
  seg[8] = fields.idx8 ?? '3.3333';
  return `var hq_str_fx_s${pair.toLowerCase()}="${seg.join(',')}";`;
}

/** vendor 中文名 —— 形态取自 plan §D3 字段位对照表的样本行 (`f1` 段)。 */
const TENCENT_NAME: Record<FxPair, string> = {
  USDCNY: '美元人民币',
  HKDCNY: '港币人民币',
  USDHKD: '美元港币',
};

/**
 * `美元人民币` 的 GBK 字节。
 * Node 的 `TextEncoder` 只出 UTF-8 ⇒ 按字节写死; 取值由 `TextDecoder('gbk')` 反向穷举核对得出,
 * 本文件 ⑦ 那条断言本身就是它的回归 (解错了当场不等)。
 */
const GBK_NAME_USDCNY = Uint8Array.from([
  0xc3, 0xc0, 0xd4, 0xaa, 0xc8, 0xcb, 0xc3, 0xf1, 0xb1, 0xd2,
]);

/** 把一行 ASCII 文本里的中文名换成其 GBK 字节 —— 造一份真 GBK 响应字节。 */
function gbkBytes(line: string, name: string, nameBytes: Uint8Array): Uint8Array {
  const at = line.indexOf(name);
  const encoder = new TextEncoder();
  return Uint8Array.from([
    ...encoder.encode(line.slice(0, at)),
    ...nameBytes,
    ...encoder.encode(line.slice(at + name.length)),
  ]);
}

const TENCENT_ALL_THREE = ALL_PAIRS.map((p) =>
  tencentLine(p, TENCENT_NAME[p], { f3: SYNTHETIC_RATE[p] }),
).join('\n');

const SINA_ALL_THREE = ALL_PAIRS.map((p) => sinaLine(p, { idx3: SYNTHETIC_RATE[p] })).join('\n');

describe('parseTencentFx —— 腾讯 wh 主源 (取 f3)', () => {
  it('① 三对齐全 ⇒ 解出 3 条, f3 值逐字正确 (🚫 f10 / f11)', () => {
    const quotes = parseTencentFx(TENCENT_ALL_THREE, ALL_PAIRS);
    expect(quotes.size).toBe(3);
    for (const pair of ALL_PAIRS) {
      // 逐字比较 (toFixed 定位数), 不是 `.equals()` —— 后者对「解出来是别的字段但数值凑巧」无鉴别力。
      expect(quotes.get(pair)?.rate.toFixed(4)).toBe(SYNTHETIC_RATE[pair]);
    }
  });

  it('① f5 只作证据带出, 不参与判据 (D5: 它是 vendor 刷新记录的时刻, 不是该汇率的生成时刻)', () => {
    const quotes = parseTencentFx(TENCENT_ALL_THREE, ALL_PAIRS);
    expect(quotes.get('USDCNY')?.vendorStamp).toBe('20260917094811');
  });

  it('② 请求 3 对、响应只含 2 对 ⇒ 抛, 且点名缺的那一对 (🚫 回几条算几条)', () => {
    // EVIDENCE: 部分命中 = **静默省略** —— `whUSDCNY,whZZZZZZ,whUSDHKD` 只回 2 条, 无效码那条
    // 直接消失 (plan 作者 2026-09-16 PoC 实拉)。⇒ 与 alert 的「部分命中不算失败」刻意相反:
    // 静默少一对会让那一屏悄悄走降级路径, 而屏幕上一切正常。
    const partial = [
      tencentLine('USDCNY', TENCENT_NAME.USDCNY, { f3: SYNTHETIC_RATE.USDCNY }),
      tencentLine('USDHKD', TENCENT_NAME.USDHKD, { f3: SYNTHETIC_RATE.USDHKD }),
    ].join('\n');
    expect(() => parseTencentFx(partial, ALL_PAIRS)).toThrow(/HKDCNY/);
  });

  it('③ 哨兵 v_pv_none_match="1" ⇒ 抛, 且错误点名哨兵本身', () => {
    // 🚨 断言**错误信息点名哨兵**而不是只断言「抛」: 去掉哨兵挡之后, 少一对校验同样会抛 ——
    // 只断言抛的话定向变异 b 会静默幸存, 而真实后果是「零汇率但不报错」(那正是照抄既有股票
    // 解析器会得到的形态: 它的正则把 `pv_none_match` 当成一个 symbol 解出来, 再靠字段数静默跳过)。
    expect(() => parseTencentFx('v_pv_none_match="1";', ALL_PAIRS)).toThrow(/pv_none_match/);
  });

  it('③ 哨兵与有效行同时出现 ⇒ 仍抛 (哨兵挡是无条件的, 不是「解不出东西时的兜底」)', () => {
    const mixed = `v_pv_none_match="1";\n${TENCENT_ALL_THREE}`;
    expect(() => parseTencentFx(mixed, ALL_PAIRS)).toThrow(/pv_none_match/);
  });

  it.each([
    ['空串', ''],
    ['非数字', 'abc'],
    ['只有负号', '-'],
    ['零 (倒数无定义)', '0'],
    ['负值', '-7.1500'],
  ])('④ f3 不可 Decimal 解析 / 非正 (%s) ⇒ 抛', (_label, f3) => {
    const line = tencentLine('USDCNY', TENCENT_NAME.USDCNY, { f3 });
    expect(() => parseTencentFx(line, ['USDCNY'])).toThrow();
  });

  it('④ 字段数不足 (schema drift) ⇒ 抛, 不静默跳过', () => {
    expect(() => parseTencentFx('v_whUSDCNY="310~x~USDCNY";', ['USDCNY'])).toThrow();
  });
});

describe('parseSinaFx —— 新浪 fx_s 备源 (取 idx3)', () => {
  it('⑤ 取 idx3; idx1 / idx2 / idx8 不被消费 (那三个是买卖价一族、会摆动)', () => {
    const quotes = parseSinaFx(SINA_ALL_THREE, ALL_PAIRS);
    expect(quotes.size).toBe(3);
    for (const pair of ALL_PAIRS) {
      expect(quotes.get(pair)?.rate.toFixed(4)).toBe(SYNTHETIC_RATE[pair]);
    }
    // 诱饵值一个都不许出现在结果里。
    const parsed = [...quotes.values()].map((q) => q.rate.toFixed(4));
    for (const decoy of ['5.5555', '4.4444', '3.3333']) {
      expect(parsed).not.toContain(decoy);
    }
  });

  it('② 少一对 ⇒ 抛 (解析契约对备源同样成立)', () => {
    const partial = sinaLine('USDCNY', { idx3: SYNTHETIC_RATE.USDCNY });
    expect(() => parseSinaFx(partial, ALL_PAIRS)).toThrow(/HKDCNY|USDHKD/);
  });

  it('④ 无效码 (空 payload) ⇒ 抛, 不当成解出 0 条', () => {
    const empty = ALL_PAIRS.map((p) => `var hq_str_fx_s${p.toLowerCase()}="";`).join('\n');
    expect(() => parseSinaFx(empty, ALL_PAIRS)).toThrow();
  });
});

describe('invertRate —— 反向币对取倒数 (🚫 请求反向码: 实证全 MISS)', () => {
  it('⑥ 往返误差 < 1e-9', () => {
    for (const pair of ALL_PAIRS) {
      const rate = new Prisma.Decimal(SYNTHETIC_RATE[pair]);
      const roundTrip = invertRate(invertRate(rate));
      expect(roundTrip.minus(rate).abs().lessThan(new Prisma.Decimal('1e-9'))).toBe(true);
    }
  });

  it('⑥ 倒数就是 1 / rate (2.5 ⇒ 0.4), 不是任何近似', () => {
    expect(invertRate(new Prisma.Decimal('2.5000')).toFixed(4)).toBe('0.4000');
  });
});

describe('decodeGbk —— GBK 字节解码 (照 alert/realtime-quote.rules.ts 写法另落一份)', () => {
  it('⑦ 中文名正确解码不乱码, 且字段位不被解码移位', () => {
    const line = tencentLine('USDCNY', TENCENT_NAME.USDCNY, { f3: SYNTHETIC_RATE.USDCNY });
    const text = decodeGbk(gbkBytes(line, TENCENT_NAME.USDCNY, GBK_NAME_USDCNY));
    expect(text).toContain(TENCENT_NAME.USDCNY);
    expect(text).not.toContain('�');
    // 🚨 把 GBK 字节按 UTF-8 读是**静默**错法: 数字段照样读得出来, 但中文名里的尾字节落在
    // ASCII 段 (GBK 尾字节值域含 `~` = 0x7E) 时会凭空多出一个分隔符, 把整行字段位往后推。
    expect(parseTencentFx(text, ['USDCNY']).get('USDCNY')?.rate.toFixed(4)).toBe(
      SYNTHETIC_RATE.USDCNY,
    );
  });
});
