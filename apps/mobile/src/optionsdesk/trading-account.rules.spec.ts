// 081 T001 — 交易账户页值域 / 默认值 / 占位文案单点的纯逻辑单测。
// 渲染与交互（市场页签 / 分段点选、占位卡呈现）走 Playwright e2e，不在这里。
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  DEFAULT_TRADING_ACCOUNT_SELECTION,
  TRADING_ACCOUNT_SEGMENTS,
} from './trading-account.rules';

const COPY = OPTIONSDESK_COPY.tradingAccount;

/** 深走一棵文案子树收集全部字符串叶子。复杂度 O(n)，n = 节点数。 */
function collectStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object') return [];
  return Object.values(node).flatMap(collectStrings);
}

describe('trading-account rules · 值域与默认值', () => {
  it('① 默认选择 = 美股 · 持仓', () => {
    expect(DEFAULT_TRADING_ACCOUNT_SELECTION).toEqual({ market: 'us', segment: 'positions' });
    expect(OPTIONSDESK_COPY.radar.marketTabs[DEFAULT_TRADING_ACCOUNT_SELECTION.market]).toBe(
      '美股',
    );
    expect(COPY.segments[DEFAULT_TRADING_ACCOUNT_SELECTION.segment]).toBe('持仓');
  });

  it('② 分段顺序 = 持仓 / 订单 / 报表', () => {
    expect(TRADING_ACCOUNT_SEGMENTS.map((s) => COPY.segments[s])).toEqual(['持仓', '订单', '报表']);
  });
});

describe('trading-account copy · 占位文案', () => {
  const placeholders = TRADING_ACCOUNT_SEGMENTS.map((s) => COPY.placeholder[s]);

  it('③ 三个占位 title 均含「建设中」', () => {
    for (const p of placeholders) expect(p.title).toContain('建设中');
  });

  it('④ 三个 title 两两互异、三个 body 两两互异', () => {
    expect(new Set(placeholders.map((p) => p.title)).size).toBe(TRADING_ACCOUNT_SEGMENTS.length);
    expect(new Set(placeholders.map((p) => p.body)).size).toBe(TRADING_ACCOUNT_SEGMENTS.length);
  });

  it('⑤ tradingAccount 段全部字符串不含「暂无」「空仓」「无数据」', () => {
    const strings = collectStrings(COPY);
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(/暂无|空仓|无数据/);
    }
  });
});
