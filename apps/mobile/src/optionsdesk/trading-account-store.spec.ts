// 081 T002 — 交易账户页进程内选择 store 的纯逻辑单测（zustand，无 persist）。
// 「离开再进仍记得 / 刷新回默认 / 与雷达互不影响」的导航层证据走 T006 Playwright e2e。
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRADING_ACCOUNT_SELECTION } from './trading-account.rules';
import { useTradingAccountStore } from './trading-account-store';

function selection() {
  const { market, segment } = useTradingAccountStore.getState();
  return { market, segment };
}

beforeEach(() => {
  useTradingAccountStore.setState(DEFAULT_TRADING_ACCOUNT_SELECTION);
});

describe('useTradingAccountStore', () => {
  it('① 初值 = 默认选择（美股 · 持仓）', () => {
    expect(selection()).toEqual(DEFAULT_TRADING_ACCOUNT_SELECTION);
  });

  it('② selectMarket 只改市场，分段不变', () => {
    useTradingAccountStore.getState().selectSegment('orders');
    useTradingAccountStore.getState().selectMarket('hk');
    expect(selection()).toEqual({ market: 'hk', segment: 'orders' });
  });

  it('③ selectSegment 只改分段，市场不变', () => {
    useTradingAccountStore.getState().selectMarket('hk');
    useTradingAccountStore.getState().selectSegment('reports');
    expect(selection()).toEqual({ market: 'hk', segment: 'reports' });
  });

  it('④ 连续交替切换，终态 = 两维各自最后一次选择', () => {
    const { selectMarket, selectSegment } = useTradingAccountStore.getState();
    selectMarket('hk');
    selectSegment('orders');
    selectMarket('us');
    selectSegment('reports');
    selectMarket('hk');
    expect(selection()).toEqual({ market: 'hk', segment: 'reports' });
  });
});
