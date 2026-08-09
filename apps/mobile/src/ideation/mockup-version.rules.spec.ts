// 037 T014 [US2] — 多版切换条纯逻辑单测（倒序 chip / 默认 latest / 日期格式化 / 版本标签 / 选中取版）。
import { describe, expect, it } from 'vitest';

import {
  formatDeliveredAt,
  prepareVersionStrip,
  selectDefaultVersionId,
  selectMockupById,
  versionRankLabel,
} from './mockup-version.rules';
import type { SessionMockupResponse } from './use-session-mockups';

function mockup(over: Partial<SessionMockupResponse>): SessionMockupResponse {
  return {
    id: '1',
    objectKey: 'ideation-mockup/1/1/v.html',
    mockupUrl: 'https://m.example.com/ideation-mockup/1/1/v.html',
    screens: ['空', '加载', '成功'],
    createdAt: '2026-06-27T10:00:00.000Z',
    versionRank: 1,
    ...over,
  };
}

describe('prepareVersionStrip（倒序 chip 视图）', () => {
  it('latest（rank 1）排首位 + 标 isLatest，历史版按 rank 升序在后', () => {
    const strip = prepareVersionStrip([
      mockup({ id: 'v2', versionRank: 2 }),
      mockup({ id: 'v1', versionRank: 1 }),
      mockup({ id: 'v3', versionRank: 3 }),
    ]);
    expect(strip.map((c) => c.id)).toEqual(['v1', 'v2', 'v3']);
    expect(strip[0]).toMatchObject({ id: 'v1', versionRank: 1, isLatest: true, label: '最新' });
    expect(strip[1]).toMatchObject({ id: 'v2', isLatest: false, label: 'v2' });
    expect(strip[2]).toMatchObject({ id: 'v3', isLatest: false, label: 'v3' });
  });

  it('单版 → 一枚 chip（latest）', () => {
    const strip = prepareVersionStrip([mockup({ id: 'only', versionRank: 1 })]);
    expect(strip).toHaveLength(1);
    expect(strip[0]).toMatchObject({ isLatest: true, label: '最新' });
  });

  it('空列表 → 空 chip 数组', () => {
    expect(prepareVersionStrip([])).toEqual([]);
  });

  it('每枚 chip 带交付日期副标签（本地 YYYY-MM-DD）', () => {
    const strip = prepareVersionStrip([
      mockup({ id: 'a', versionRank: 1, createdAt: '2026-06-27T10:00:00.000Z' }),
    ]);
    expect(strip[0]?.deliveredAt).toBe('2026-06-27');
  });
});

describe('versionRankLabel', () => {
  it('rank 1 → 「最新」', () => {
    expect(versionRankLabel(1)).toBe('最新');
  });

  it('rank ≥ 2 → 「v{N}」', () => {
    expect(versionRankLabel(2)).toBe('v2');
    expect(versionRankLabel(5)).toBe('v5');
  });

  it('脏 rank（0 / 非整数）→ 兜底 v?', () => {
    expect(versionRankLabel(0)).toBe('v?');
    expect(versionRankLabel(1.5)).toBe('v?');
  });
});

describe('formatDeliveredAt', () => {
  it('ISO → 本地 YYYY-MM-DD', () => {
    expect(formatDeliveredAt('2026-06-27T10:00:00.000Z')).toBe('2026-06-27');
  });

  it('非法串 → 空串（渲染层省略副标签）', () => {
    expect(formatDeliveredAt('not-a-date')).toBe('');
  });
});

describe('selectDefaultVersionId（默认 latest）', () => {
  it('返 versionRank 1 的 id（默认渲最新）', () => {
    const id = selectDefaultVersionId([
      mockup({ id: 'v2', versionRank: 2 }),
      mockup({ id: 'v1', versionRank: 1 }),
    ]);
    expect(id).toBe('v1');
  });

  it('无 rank 1 命中 → 退回首元素（server 已倒序兜底）', () => {
    const id = selectDefaultVersionId([
      mockup({ id: 'a', versionRank: 2 }),
      mockup({ id: 'b', versionRank: 3 }),
    ]);
    expect(id).toBe('a');
  });

  it('空列表 → null', () => {
    expect(selectDefaultVersionId([])).toBeNull();
  });
});

describe('selectMockupById（切版取记录）', () => {
  const items = [mockup({ id: 'v1', versionRank: 1 }), mockup({ id: 'v2', versionRank: 2 })];

  it('命中选中 id → 返该版（切 renderer uri + 标签行）', () => {
    expect(selectMockupById(items, 'v2')?.id).toBe('v2');
  });

  it('id=null → 退回最新版（默认态）', () => {
    expect(selectMockupById(items, null)?.id).toBe('v1');
  });

  it('id 失效（列表变更）→ 退回最新版（防选中态悬空）', () => {
    expect(selectMockupById(items, 'gone')?.id).toBe('v1');
  });

  it('空列表 → null', () => {
    expect(selectMockupById([], 'v1')).toBeNull();
  });
});
