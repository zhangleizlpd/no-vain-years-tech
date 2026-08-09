import { describe, it, expect } from 'vitest';
import {
  assertObjectKeyOwnership,
  deriveVersionRank,
  mockupKeyPrefix,
  normalizeScreens,
} from './mockup.rules';

describe('mockup.rules / mockupKeyPrefix', () => {
  it('组装本 (accountId, sessionId) 产物前缀根 (尾随斜杠)', () => {
    expect(mockupKeyPrefix(42n, 101n)).toBe('ideation-mockup/42/101/');
  });
});

describe('mockup.rules / assertObjectKeyOwnership', () => {
  it('objectKey 落在本 (accountId, sessionId) 前缀内 → true', () => {
    expect(assertObjectKeyOwnership('ideation-mockup/42/101/uuid/index.html', 42n, 101n)).toBe(
      true,
    );
  });

  it('前缀根本身 (含尾斜杠) 之后任意 key → true', () => {
    expect(assertObjectKeyOwnership('ideation-mockup/42/101/a.html', 42n, 101n)).toBe(true);
  });

  it('谎报他 account 前缀 → false (防越权)', () => {
    expect(assertObjectKeyOwnership('ideation-mockup/99/101/x.html', 42n, 101n)).toBe(false);
  });

  it('谎报他 session 前缀 → false (防混淆代理)', () => {
    expect(assertObjectKeyOwnership('ideation-mockup/42/999/x.html', 42n, 101n)).toBe(false);
  });

  it('前缀子串攻击 (accountId 是另一 id 子串) 不命中 → false', () => {
    // 420 不是 42 的合法前缀 (尾斜杠把边界钉死)。
    expect(assertObjectKeyOwnership('ideation-mockup/420/101/x.html', 42n, 101n)).toBe(false);
  });

  it('完全不相干前缀 (他 ctx key) → false', () => {
    expect(assertObjectKeyOwnership('ideation/42/uuid/img', 42n, 101n)).toBe(false);
  });
});

describe('mockup.rules / normalizeScreens', () => {
  it('全字符串数组 → 原样保留', () => {
    expect(normalizeScreens(['空态', '加载', '成功'])).toEqual(['空态', '加载', '成功']);
  });

  it('空数组 → 空数组', () => {
    expect(normalizeScreens([])).toEqual([]);
  });

  it('非数组 (null) → 兜底空数组', () => {
    expect(normalizeScreens(null)).toEqual([]);
  });

  it('非数组 (object) → 兜底空数组', () => {
    expect(normalizeScreens({ screens: ['x'] })).toEqual([]);
  });

  it('非数组 (string) → 兜底空数组', () => {
    expect(normalizeScreens('空态')).toEqual([]);
  });

  it('数组含非字符串元素 → 丢弃非字符串, 保留字符串', () => {
    expect(normalizeScreens(['空态', 1, null, '成功', { a: 1 }, undefined])).toEqual([
      '空态',
      '成功',
    ]);
  });
});

describe('mockup.rules / deriveVersionRank', () => {
  it('按 createdAt 倒序派生 1-based rank (最新 = 1), 与入参一一对位', () => {
    const rows = [
      { createdAt: new Date('2026-06-01T00:00:00Z') }, // 最旧
      { createdAt: new Date('2026-06-03T00:00:00Z') }, // 最新
      { createdAt: new Date('2026-06-02T00:00:00Z') }, // 中间
    ];
    // 最新(idx1)=1, 中间(idx2)=2, 最旧(idx0)=3
    expect(deriveVersionRank(rows)).toEqual([3, 1, 2]);
  });

  it('已倒序入参 (createdAt desc) → [1,2,3]', () => {
    const rows = [
      { createdAt: new Date('2026-06-03T00:00:00Z') },
      { createdAt: new Date('2026-06-02T00:00:00Z') },
      { createdAt: new Date('2026-06-01T00:00:00Z') },
    ];
    expect(deriveVersionRank(rows)).toEqual([1, 2, 3]);
  });

  it('单条 → [1]', () => {
    expect(deriveVersionRank([{ createdAt: new Date('2026-06-01T00:00:00Z') }])).toEqual([1]);
  });

  it('空数组 → []', () => {
    expect(deriveVersionRank([])).toEqual([]);
  });

  it('同 createdAt → 按入参出现序稳定打 tie', () => {
    const ts = new Date('2026-06-01T00:00:00Z');
    const rows = [{ createdAt: ts }, { createdAt: ts }, { createdAt: ts }];
    expect(deriveVersionRank(rows)).toEqual([1, 2, 3]);
  });
});
