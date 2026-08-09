// 028 T007 — 会话列表 hook 纯逻辑单测（vitest=logic，per 测试分层）。
// hook 编排（useInfiniteQuery / mutation / invalidate）走 Playwright + contract-smoke；
// 本文件只测可单测纯逻辑：多页 cursor 累加拼接（不重不漏）+ 翻页参数推导 + 搜索态切换。
// mock @nvy/api-client（dist entry 在 vitest 不可解析；runtime hook 仅编排不触达纯函数）。
import { describe, expect, it, vi } from 'vitest';
import type { ConversationListResponse } from '@nvy/api-client';

vi.mock('@nvy/api-client', () => ({
  useConversationControllerList: vi.fn(),
  useConversationControllerRename: vi.fn(),
  useConversationControllerRemove: vi.fn(),
  conversationControllerList: vi.fn(),
  getConversationControllerListQueryKey: vi.fn(() => ['/api/v1/chat/conversations']),
}));

import {
  CONVERSATIONS_QUERY_KEY,
  getNextCursorParam,
  mergeConversationPages,
} from './use-conversations';

const page = (items: { id: string }[], nextCursor?: string | null): ConversationListResponse => ({
  items: items.map((i) => ({
    id: i.id,
    title: `会话 ${i.id}`,
    model: 'deepseek-chat',
    updatedAt: '2026-06-14T00:00:00.000Z',
  })),
  nextCursor,
});

describe('mergeConversationPages — 多页 cursor 累加拼接', () => {
  it('空页集 → 空列表', () => {
    expect(mergeConversationPages([])).toEqual([]);
  });

  it('单页直出', () => {
    const merged = mergeConversationPages([page([{ id: 'a' }, { id: 'b' }])]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('多页按页序拼接（不漏），保持页内序', () => {
    const merged = mergeConversationPages([
      page([{ id: 'a' }, { id: 'b' }], 'c2'),
      page([{ id: 'c' }, { id: 'd' }], 'c3'),
      page([{ id: 'e' }]),
    ]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('跨页 id 重复 → 去重保留首见（不重）', () => {
    // cursor 复合 (updatedAt,id)，边界数据 / 失效重取可能令同 id 跨页重现；去重兜底。
    const merged = mergeConversationPages([
      page([{ id: 'a' }, { id: 'b' }], 'c2'),
      page([{ id: 'b' }, { id: 'c' }]),
    ]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('getNextCursorParam — 翻页参数推导', () => {
  it('有 nextCursor → 返回该 cursor（继续翻页）', () => {
    expect(getNextCursorParam(page([{ id: 'a' }], 'cursor-2'))).toBe('cursor-2');
  });

  it('nextCursor 为 null → undefined（无更多页）', () => {
    expect(getNextCursorParam(page([{ id: 'a' }], null))).toBeUndefined();
  });

  it('nextCursor 缺省 → undefined（无更多页）', () => {
    expect(getNextCursorParam(page([{ id: 'a' }]))).toBeUndefined();
  });
});

describe('CONVERSATIONS_QUERY_KEY — 失效目标键', () => {
  it('mutation 成功后 invalidate 用的稳定前缀键', () => {
    expect(CONVERSATIONS_QUERY_KEY).toEqual(['conversations']);
  });
});
