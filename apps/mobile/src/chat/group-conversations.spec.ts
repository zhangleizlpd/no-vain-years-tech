// 028 T006 — 会话时间分组纯函数单测（vitest=logic，per 测试分层）。
// 纯函数无 DB / 无 React：按 updatedAt（ISO string）分桶 前7天 / 前30天 / 年（倒序）。
// 边界 `≥` 含较近组（plan D5，避免跳组歧义）；组内 updatedAt 倒序。
import { describe, expect, it } from 'vitest';
import { groupConversations, type ConversationItem } from './group-conversations';

// 固定 now = 2026-06-14T12:00:00Z，所有相对偏移以此为锚（可测，不内部 Date.now()）。
const NOW = '2026-06-14T12:00:00.000Z';

/** 从 now 回退 N 天的 ISO string（毫秒级精确，用于边界用例）。 */
function daysAgo(n: number, ms = 0): string {
  return new Date(Date.parse(NOW) - n * 86_400_000 + ms).toISOString();
}

function item(id: string, updatedAt: string): ConversationItem {
  return { id, title: `会话 ${id}`, model: 'deepseek-chat', updatedAt };
}

describe('groupConversations', () => {
  it('空列表 → 空分组', () => {
    expect(groupConversations([], NOW)).toEqual([]);
  });

  it('仅近 7 天 → 单「前 7 天」组', () => {
    const items = [item('a', daysAgo(1)), item('b', daysAgo(3))];
    const groups = groupConversations(items, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('前 7 天');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('跨「前 7 天 / 前 30 天」多组，组序 = 近→远', () => {
    const items = [item('a', daysAgo(2)), item('b', daysAgo(15))];
    const groups = groupConversations(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['前 7 天', '前 30 天']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['b']);
  });

  it('跨年 → 更早按 YYYY 年分组，年份倒序', () => {
    const items = [
      item('recent', daysAgo(1)),
      item('y2025', '2025-08-01T00:00:00.000Z'),
      item('y2024', '2024-03-01T00:00:00.000Z'),
      item('y2025b', '2025-02-01T00:00:00.000Z'),
    ];
    const groups = groupConversations(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['前 7 天', '2025 年', '2024 年']);
    // 2025 组内倒序：8 月先于 2 月
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['y2025', 'y2025b']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['y2024']);
  });

  it('边界恰 7 天 → 含较近的「前 7 天」组（≥ 含较近，plan D5）', () => {
    const groups = groupConversations([item('edge7', daysAgo(7))], NOW);
    expect(groups[0]!.label).toBe('前 7 天');
  });

  it('边界刚过 7 天（7d + 1ms 更早）→ 落「前 30 天」组', () => {
    const groups = groupConversations([item('past7', daysAgo(7, -1))], NOW);
    expect(groups[0]!.label).toBe('前 30 天');
  });

  it('边界恰 30 天 → 含较近的「前 30 天」组（≥ 含较近）', () => {
    const groups = groupConversations([item('edge30', daysAgo(30))], NOW);
    expect(groups[0]!.label).toBe('前 30 天');
  });

  it('边界刚过 30 天（30d + 1ms 更早）→ 落按年组', () => {
    const groups = groupConversations([item('past30', daysAgo(30, -1))], NOW);
    // daysAgo(30, -1) 从 2026-06-14 回退 30 天 ≈ 2026-05-15 → 「2026 年」
    expect(groups[0]!.label).toBe('2026 年');
  });

  it('组内按 updatedAt 倒序（输入乱序也归位）', () => {
    const items = [item('old', daysAgo(5)), item('new', daysAgo(1)), item('mid', daysAgo(3))];
    const groups = groupConversations(items, NOW);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });
});
