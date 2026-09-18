// 085 T008 — 交易账户持仓页 · 展示币种档位 / 每页签一格状态 / 汇率行出没 / 降级标判定的纯逻辑单测。
//
// 渲染与交互（选择器展开、切档重排、汇率行与降级标上屏）走 Playwright e2e（T011 / T015），不在这里。
//
// 🚨 对 `@nvy/api-client` 只 `import type`：mobile vitest 解析不到它的运行时入口，
//    import 生成的枚举常量对象会让整个 spec 0 用例却 exit 1（同 083 该文件头注释）。
// 📌 fixture 只用合成值；本片零金额断言 ⇒ 无汇率数字。
import type { BrokerPositionGroupResponse, BrokerPositionListRowResponse } from '@nvy/api-client';
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  DISPLAY_CURRENCIES,
  defaultCurrencyForMarket,
  degradedRowLabel,
  groupIncompleteLabel,
  initialCurrencyState,
  selectCurrency,
  showFxRateLine,
} from './display-currency.rules';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions.displayCurrency;

/** 降级判定只读这两个字段，fixture 按 `Pick` 造，避免整行 20 余字段的噪声。 */
type RowMark = Pick<BrokerPositionListRowResponse, 'degraded' | 'displayCurrency'>;
type GroupMark = Pick<BrokerPositionGroupResponse, 'aggregateComplete'>;

/** 深走一棵文案子树收集全部字符串叶子（函数叶子另行喂样例参数）。O(n)，n = 节点数。 */
function collectStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object') return [];
  return Object.values(node).flatMap(collectStrings);
}

/** 本片新增文案的全部**成串**形态：静态叶子 + 每个函数各喂一组样例参数。 */
function newCopyStrings(): string[] {
  return [
    ...collectStrings(COPY),
    COPY.selector('CNY'),
    COPY.fxRatePair('HKD', 'CNY'),
    COPY.fxRate(COPY.fxRatePair('HKD', 'CNY'), '0.9500', '09-16 21:09'),
    COPY.rowOriginalCurrency('HKD'),
  ];
}

describe('display-currency rules · 档位值域与每市场默认（FR-001 / FR-011）', () => {
  it('① 每个市场的原币种：us ⇒ USD、hk ⇒ HKD（branch 1, 2）', () => {
    expect(defaultCurrencyForMarket('us')).toBe('USD');
    expect(defaultCurrencyForMarket('hk')).toBe('HKD');
  });

  it('② 初始状态两格各自为其市场原币种（branch 1, 2）', () => {
    expect(initialCurrencyState()).toEqual({ us: 'USD', hk: 'HKD' });
  });

  it('⑥ 档位恰三档 USD / HKD / CNY，不含「原币种」档（FR-001）', () => {
    expect(DISPLAY_CURRENCIES).toEqual(['USD', 'HKD', 'CNY']);
    // 「原币种」若混进值域，它与该市场币种档显示逐字相同 ⇒ 屏上两个档位长得一模一样。
    for (const c of DISPLAY_CURRENCIES) {
      expect(c).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe('display-currency rules · 两个页签各记各的（FR-005 / SC-005）', () => {
  it('③ 改一格 ⇒ 另一格不变，且原 state 不被就地改写（branch 4）', () => {
    const initial = initialCurrencyState();
    const next = selectCurrency(initial, 'hk', 'CNY');

    expect(next.hk).toBe('CNY');
    // 🚨 这条是「单格状态」实现的唯一判据：共用一格时 us 会跟着变成 CNY。
    expect(next.us).toBe('USD');
    expect(initial).toEqual({ us: 'USD', hk: 'HKD' });
  });

  it('④ 切页签只读另一格、不写任何格（branch 3）', () => {
    const afterHk = selectCurrency(initialCurrencyState(), 'hk', 'CNY');

    // 切到 us：读 us 那一格 ⇒ 该页签本次未切过 ⇒ 仍是其市场原币种。
    expect(afterHk.us).toBe(defaultCurrencyForMarket('us'));
    // 再切回 hk：读回 hk 那一格 ⇒ 仍是本次所选。读不写 ⇒ 状态逐字未变。
    expect(afterHk.hk).toBe('CNY');
    expect(afterHk).toEqual({ us: 'USD', hk: 'CNY' });
  });
});

describe('display-currency rules · 参考汇率行出没（FR-007 / FR-011）', () => {
  it('⑤ 币种 = 该市场原币种 ⇒ 不出汇率行；≠ ⇒ 出（branch 14, 15）', () => {
    expect(showFxRateLine({ market: 'hk', current: 'HKD' })).toBe(false);
    expect(showFxRateLine({ market: 'us', current: 'USD' })).toBe(false);
    expect(showFxRateLine({ market: 'hk', current: 'CNY' })).toBe(true);
    // 跨市场档位同样算「≠ 原币种」：在 hk 选 USD 也要出汇率行。
    expect(showFxRateLine({ market: 'hk', current: 'USD' })).toBe(true);
  });
});

describe('display-currency rules · 降级标与组不完整标（FR-006 / FR-013）', () => {
  const degradedHkd: RowMark = { degraded: true, displayCurrency: 'HKD' };
  const unknownCurrency: RowMark = { degraded: true, displayCurrency: null };
  const converted: RowMark = { degraded: false, displayCurrency: 'CNY' };

  it('⑦ 降级行标含该行原币种三字母代码；币种未知 ⇒ 专门文案；未降级 ⇒ 无标', () => {
    expect(degradedRowLabel(degradedHkd)).toContain('HKD');
    expect(degradedRowLabel(unknownCurrency)).toBe(COPY.rowCurrencyUnknown);
    // 🚨 券商未回报币种时 MUST NOT 回落任何币种 —— 标里不得出现三档中的任何一个。
    for (const c of DISPLAY_CURRENCIES) {
      expect(degradedRowLabel(unknownCurrency)).not.toContain(c);
    }
    expect(degradedRowLabel(converted)).toBeNull();
  });

  it('⑧ 组不完整 ⇒ 组市值与组盈亏**两个**聚合值都返回标（FR-006）', () => {
    const incomplete: GroupMark = { aggregateComplete: false };
    const label = groupIncompleteLabel(incomplete);

    expect(label).not.toBeNull();
    // 只标一列会让人以为另一列是完整的。
    expect(label?.marketValue).toBe(COPY.aggregateIncomplete);
    expect(label?.unrealizedPl).toBe(COPY.aggregateIncomplete);
    expect(groupIncompleteLabel({ aggregateComplete: true })).toBeNull();
  });
});

describe('display-currency copy · 新增文案（plan D9）', () => {
  it('⑨ 新增 key 全部非空，且零货币符号（一律三字母代码）', () => {
    const strings = newCopyStrings();
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s.trim()).not.toBe('');
      expect(s).not.toMatch(/[¥$￥＄]/);
    }
  });

  it('⑨b 参考汇率措辞：含「参考汇率」，不含「实时」/「结算」（FR-007）', () => {
    const line = COPY.fxRate(COPY.fxRatePair('HKD', 'CNY'), '0.9500', '09-16 21:09');
    expect(line).toContain('参考汇率');
    expect(line).toContain('HKD');
    expect(line).toContain('CNY');
    expect(line).toContain('0.9500');
    expect(line).toContain('09-16 21:09');
    for (const s of newCopyStrings()) {
      expect(s).not.toMatch(/实时|结算/);
    }
  });

  it('⑩ 新增文案住 083 的 tradingAccountPositions 段，081 的 tradingAccount 段一条不含', () => {
    const inPositionsSection = collectStrings(OPTIONSDESK_COPY.tradingAccountPositions);
    const inAccountSection = collectStrings(OPTIONSDESK_COPY.tradingAccount);

    for (const s of collectStrings(COPY)) {
      expect(inPositionsSection).toContain(s);
      // 🚨 并进 081 那段会撞它「不含 暂无 / 空仓 / 无数据」的不变量（`trading-account.rules.spec.ts` 臂 ⑤）；
      //    本臂不依赖那条措辞巧合，直接钉段归属。
      expect(inAccountSection).not.toContain(s);
    }
  });
});
