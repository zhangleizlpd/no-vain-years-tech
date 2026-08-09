import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddWatchlistItemRequest } from './add-watchlist-item.request';

// 013 T007: add-item 请求 DTO 浅校验 (market 词表 / code 非空≤16) — 无 DB。
describe('AddWatchlistItemRequest validation', () => {
  const validate = (body: unknown) =>
    validateSync(plainToInstance(AddWatchlistItemRequest, body)).map((e) => e.property);

  it('合法 cn/hk/us → 通过', () => {
    expect(validate({ market: 'cn', code: '600519' })).toEqual([]);
    expect(validate({ market: 'hk', code: '00700' })).toEqual([]);
    expect(validate({ market: 'us', code: 'AAPL' })).toEqual([]);
  });

  it('market 非法 → 校验失败 (→ 400 FORM_VALIDATION)', () => {
    expect(validate({ market: 'jp', code: '600519' })).toContain('market');
  });

  it('code 空 / 超长 → 校验失败', () => {
    expect(validate({ market: 'cn', code: '' })).toContain('code');
    expect(validate({ market: 'cn', code: 'X'.repeat(17) })).toContain('code');
  });
});
