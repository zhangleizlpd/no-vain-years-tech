import { describe, expect, it } from 'vitest';

import { marketBadgeLabel } from './market-badge.rules';

// 自 alert/target-select.helpers.spec 随函数提升迁入；logic-only（per mono 测试分层）。

describe('marketBadgeLabel', () => {
  it('688/689 → 科创', () => {
    expect(marketBadgeLabel('688570')).toBe('科创');
    expect(marketBadgeLabel('689009')).toBe('科创');
  });

  it('300/301 → 创业', () => {
    expect(marketBadgeLabel('300750')).toBe('创业');
    expect(marketBadgeLabel('301236')).toBe('创业');
  });

  it('920/8x/4x → 北交（920 = 2025 起京市新段）', () => {
    expect(marketBadgeLabel('920375')).toBe('北交');
    expect(marketBadgeLabel('832000')).toBe('北交');
    expect(marketBadgeLabel('430047')).toBe('北交');
  });

  it('6x → 沪A', () => {
    expect(marketBadgeLabel('603305')).toBe('沪A');
    expect(marketBadgeLabel('600519')).toBe('沪A');
  });

  it('其余（0x 深市主板/中小板）→ 深A', () => {
    expect(marketBadgeLabel('000725')).toBe('深A');
    expect(marketBadgeLabel('002230')).toBe('深A');
  });

  it('非 cn 市场按 market 直标（hk→港 / us→美），不走代码段', () => {
    expect(marketBadgeLabel('00700', 'hk')).toBe('港');
    expect(marketBadgeLabel('AAPL', 'us')).toBe('美');
  });
});
