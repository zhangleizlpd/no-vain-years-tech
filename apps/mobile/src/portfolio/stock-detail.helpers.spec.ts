import { describe, expect, it } from 'vitest';
import type { InstrumentQuoteHeader, WatchlistMembership } from '@nvy/api-client';

import {
  canDrillDown,
  detailQuoteDirection,
  formatAsOf,
  formatDetailChange,
  formatDetailChangePct,
  formatDetailPrice,
  formatFractionPct,
  formatLargeAmount,
  formatPercentValue,
  formatRatio,
  membershipMap,
  parsePercentile,
  parseSymbol,
  percentileZone,
  resolveGroupToggle,
  resolveWatchlistToggle,
  watchlistToggleLabel,
} from './stock-detail.helpers';

const qh = (over: Partial<InstrumentQuoteHeader>): InstrumentQuoteHeader => ({
  price: '1680.00',
  change: '12.50',
  changePct: '0.75',
  prevClose: '1667.50',
  asOf: '2026-06-01',
  priceKind: 'eod_close',
  hasData: true,
  fiftyTwoWeekHigh: '1800.00',
  fiftyTwoWeekLow: '1400.00',
  ...over,
});

describe('parseSymbol（canonical market:code 解析）', () => {
  it('cn:600519 → {market:cn, code:600519}', () => {
    expect(parseSymbol('cn:600519')).toEqual({ market: 'cn', code: '600519' });
  });
  it('hk:00700 → {market:hk, code:00700}', () => {
    expect(parseSymbol('hk:00700')).toEqual({ market: 'hk', code: '00700' });
  });
  it('缺冒号 → null', () => {
    expect(parseSymbol('cn600519')).toBeNull();
  });
  it('空 code → null', () => {
    expect(parseSymbol('cn:')).toBeNull();
  });
  it('空 market → null', () => {
    expect(parseSymbol(':600519')).toBeNull();
  });
  it('空串 → null', () => {
    expect(parseSymbol('')).toBeNull();
  });
});

describe('canDrillDown（D9 市场下钻 gate）', () => {
  it('cn → true（A股全维度）', () => {
    expect(canDrillDown('cn')).toBe(true);
  });
  it('hk → true（港股薄数据可进）', () => {
    expect(canDrillDown('hk')).toBe(true);
  });
  it('us → false（016 未同步，gated 占位）', () => {
    expect(canDrillDown('us')).toBe(false);
  });
  it('未知 market → false（保守 gate）', () => {
    expect(canDrillDown('xx')).toBe(false);
  });
});

describe('membershipMap（编辑分组勾选态派生 groupId→itemId）', () => {
  const m = (groupId: string, itemId: string): WatchlistMembership => ({ groupId, itemId });

  it('memberships → groupId→itemId 映射', () => {
    const map = membershipMap([m('1', '10'), m('2', '20')]);
    expect(map.get('1')).toBe('10');
    expect(map.get('2')).toBe('20');
    expect(map.size).toBe(2);
  });
  it('空 memberships → 空 map', () => {
    expect(membershipMap([]).size).toBe(0);
  });
  it('勾选态 = map.has(groupId)（命中=勾，未命中=未勾）', () => {
    const map = membershipMap([m('5', '50')]);
    expect(map.has('5')).toBe(true);
    expect(map.has('9')).toBe(false);
  });
  it('同 groupId 重复 → 取首条 itemId（防御）', () => {
    expect(membershipMap([m('1', '10'), m('1', '11')]).get('1')).toBe('10');
  });
});

describe('detailQuoteDirection（报价 header 涨跌方向，A股 红涨绿跌）', () => {
  it('changePct > 0 → up', () =>
    expect(detailQuoteDirection(qh({ changePct: '0.75' }))).toBe('up'));
  it('changePct < 0 → down', () =>
    expect(detailQuoteDirection(qh({ changePct: '-2.6' }))).toBe('down'));
  it('changePct = 0 → flat', () =>
    expect(detailQuoteDirection(qh({ changePct: '0.00' }))).toBe('flat'));
  it('hasData=false → none', () =>
    expect(detailQuoteDirection(qh({ hasData: false }))).toBe('none'));
  it('changePct=null → none', () =>
    expect(detailQuoteDirection(qh({ changePct: null }))).toBe('none'));
  it('null quote → none', () => expect(detailQuoteDirection(null)).toBe('none'));
});

describe('formatDetail* （价格/涨跌/涨跌幅，缺字段 --）', () => {
  it('price → 2dp 无符号', () => expect(formatDetailPrice(qh({ price: '1680' }))).toBe('1680.00'));
  it('price null → --', () => expect(formatDetailPrice(qh({ price: null }))).toBe('--'));
  it('change 正 → 带 +', () => expect(formatDetailChange(qh({ change: '12.5' }))).toBe('+12.50'));
  it('change 负 → 带 -', () => expect(formatDetailChange(qh({ change: '-3' }))).toBe('-3.00'));
  it('changePct 正 → +x.xx%', () =>
    expect(formatDetailChangePct(qh({ changePct: '0.75' }))).toBe('+0.75%'));
  it('changePct 负 → -x.xx%', () =>
    expect(formatDetailChangePct(qh({ changePct: '-2.61' }))).toBe('-2.61%'));
  it('无数据 → --', () => {
    expect(formatDetailPrice(qh({ hasData: false }))).toBe('--');
    expect(formatDetailChangePct(qh({ hasData: false }))).toBe('--');
  });
});

describe('formatAsOf（数据新鲜度文案 D10）', () => {
  it('eod_close → 数据截至 X · 收盘', () => {
    expect(formatAsOf(qh({ asOf: '2026-06-01', priceKind: 'eod_close' }))).toBe(
      '数据截至 2026-06-01 · 收盘',
    );
  });
  it('asOf=null → 空串（不渲染）', () => expect(formatAsOf(qh({ asOf: null }))).toBe(''));
  it('无数据 → 空串', () => expect(formatAsOf(qh({ hasData: false }))).toBe(''));
});

describe('formatRatio（昨收/PE/PB 通用比率，缺字段 --）', () => {
  it('默认 2dp', () => expect(formatRatio('9.2')).toBe('9.20'));
  it('PE 1dp', () => expect(formatRatio('25.5', 1)).toBe('25.5'));
  it('null → --', () => expect(formatRatio(null)).toBe('--'));
  it('undefined → --', () => expect(formatRatio(undefined)).toBe('--'));
  it('非数 → --', () => expect(formatRatio('n/a')).toBe('--'));
});

describe('formatPercentValue（股息率，server 已是百分值）', () => {
  it("'1.8' → 1.80%", () => expect(formatPercentValue('1.8')).toBe('1.80%'));
  it('null → --', () => expect(formatPercentValue(null)).toBe('--'));
  it('非数 → --', () => expect(formatPercentValue('--')).toBe('--'));
});

describe('formatLargeAmount（市值 元 → 万亿/亿/万）', () => {
  it('万亿级（mock 茅台 2.135e12）', () =>
    expect(formatLargeAmount('2135000000000.00')).toBe('2.13万亿'));
  it('亿级', () => expect(formatLargeAmount('350000000')).toBe('3.50亿'));
  it('万级', () => expect(formatLargeAmount('25000')).toBe('2.50万'));
  it('万以下保留原值 2dp', () => expect(formatLargeAmount('800')).toBe('800.00'));
  it('null → --', () => expect(formatLargeAmount(null)).toBe('--'));
  it('非数 → --', () => expect(formatLargeAmount('x')).toBe('--'));
});

describe('formatFractionPct（小数 ×100 → 百分比，ROE/毛利率）', () => {
  it("'0.31' → 31.00%（默认 2dp）", () => expect(formatFractionPct('0.31')).toBe('31.00%'));
  it("'0.918' 1dp → 91.8%", () => expect(formatFractionPct('0.918', 1)).toBe('91.8%'));
  it('null → --', () => expect(formatFractionPct(null)).toBe('--'));
  it('非数 → --', () => expect(formatFractionPct('n/a')).toBe('--'));
});

describe('parsePercentile（分位 [0,1] → 0-100 number）', () => {
  it("'0.42' → 42", () => expect(parsePercentile('0.42')).toBe(42));
  it('null → null', () => expect(parsePercentile(null)).toBeNull());
  it('越界 >1 → null', () => expect(parsePercentile('1.5')).toBeNull());
  it('越界 <0 → null', () => expect(parsePercentile('-0.1')).toBeNull());
  it('非数 → null', () => expect(parsePercentile('x')).toBeNull());
});

describe('percentileZone（<30 偏低 / 30-70 适中 / >70 偏高）', () => {
  it('29 → 偏低', () => expect(percentileZone(29)).toBe('偏低'));
  it('50 → 适中', () => expect(percentileZone(50)).toBe('适中'));
  it('71 → 偏高', () => expect(percentileZone(71)).toBe('偏高'));
  it('边界 30 → 适中', () => expect(percentileZone(30)).toBe('适中'));
  it('边界 70 → 适中', () => expect(percentileZone(70)).toBe('适中'));
});

describe('watchlistToggleLabel（底栏星文案，D1 对称翻）', () => {
  it('未自选 → 自选', () => expect(watchlistToggleLabel(false)).toBe('自选'));
  it('已自选 → 已自选', () => expect(watchlistToggleLabel(true)).toBe('已自选'));
});

describe('resolveWatchlistToggle（加·删自选调用映射，窄义仅「自选」组）', () => {
  const wgId = '7'; // 系统「自选」组 id
  it('未自选 → add 落「自选」组', () => {
    expect(resolveWatchlistToggle(false, wgId, new Map())).toEqual({ kind: 'add', groupId: '7' });
  });
  it('已自选 → remove 用 memberships 里自选组 itemId', () => {
    const m = new Map([['7', '70']]);
    expect(resolveWatchlistToggle(true, wgId, m)).toEqual({ kind: 'remove', itemId: '70' });
  });
  it('缺「自选」组 id（groups 未就绪）→ null（不动作）', () => {
    expect(resolveWatchlistToggle(false, null, new Map())).toBeNull();
    expect(resolveWatchlistToggle(false, undefined, new Map())).toBeNull();
  });
  it('已自选却查无 itemId（status 与 groups 暂不一致）→ null（防御）', () => {
    expect(resolveWatchlistToggle(true, wgId, new Map())).toBeNull();
  });
});

describe('resolveGroupToggle（编辑分组单格 加入·移出映射）', () => {
  it('未命中组 → add 加入该组', () => {
    expect(resolveGroupToggle('3', new Map())).toEqual({ kind: 'add', groupId: '3' });
  });
  it('已命中组 → remove 用该组 itemId 移出', () => {
    const m = new Map([['3', '30']]);
    expect(resolveGroupToggle('3', m)).toEqual({ kind: 'remove', itemId: '30' });
  });
  it('勾选态 = membershipByGroup.has(groupId)（驱动单格高亮）', () => {
    const m = new Map([['3', '30']]);
    expect(m.has('3')).toBe(true);
    expect(m.has('9')).toBe(false);
  });
});
