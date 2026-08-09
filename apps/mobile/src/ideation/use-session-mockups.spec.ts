// @vitest-environment happy-dom
// 037 T011 — session mockup 读列表 hook 纯逻辑 + 接线单测。
// 纯函数（最新版派生 / 视图态判定）直测；hook 接线（fetch-on-open enabled 门 + refetch）mock orval
// 生成 fn（同 use-session-mutations.spec 范式）。渲染 / 状态屏浏览 = T013 Playwright Web e2e。
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionMockupResponse } from './use-session-mockups';

type ListArgs = { query?: { enabled?: boolean } } | undefined;
const captured = vi.hoisted(() => ({
  id: null as string | null,
  opts: undefined as ListArgs,
  refetch: vi.fn(),
  state: { data: undefined as unknown, isPending: true, isError: false },
}));

vi.mock('@nvy/api-client', () => ({
  useMockupListControllerList: vi.fn((id: string, opts: ListArgs) => {
    captured.id = id;
    captured.opts = opts;
    return { ...captured.state, refetch: captured.refetch };
  }),
}));

import { deriveMockupView, selectLatestMockup, useSessionMockups } from './use-session-mockups';

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

describe('selectLatestMockup', () => {
  it('取 versionRank === 1 的版（最新）', () => {
    const items = [mockup({ id: '3', versionRank: 1 }), mockup({ id: '2', versionRank: 2 })];
    expect(selectLatestMockup(items)?.id).toBe('3');
  });

  it('rank 1 不在首位也能命中（防排序假设）', () => {
    const items = [mockup({ id: '2', versionRank: 2 }), mockup({ id: '3', versionRank: 1 })];
    expect(selectLatestMockup(items)?.id).toBe('3');
  });

  it('无 rank 1 命中 → 退回首元素（server 已倒序兜底）', () => {
    const items = [mockup({ id: '5', versionRank: 2 }), mockup({ id: '4', versionRank: 3 })];
    expect(selectLatestMockup(items)?.id).toBe('5');
  });

  it('空列表 → null', () => {
    expect(selectLatestMockup([])).toBeNull();
  });
});

describe('deriveMockupView（屏视图态判定）', () => {
  it('拉取中 → isPending，非 empty/非 error', () => {
    const v = deriveMockupView({ items: undefined, isPending: true, isError: false });
    expect(v).toMatchObject({ isPending: true, isError: false, isEmpty: false, latest: null });
  });

  it('拉取失败 → isError，非 empty（不渲空假态）', () => {
    const v = deriveMockupView({ items: undefined, isPending: false, isError: true });
    expect(v).toMatchObject({ isError: true, isEmpty: false });
  });

  it('拉到空列表 → isEmpty（空态非错误，US1 AC3）', () => {
    const v = deriveMockupView({ items: [], isPending: false, isError: false });
    expect(v.isEmpty).toBe(true);
    expect(v.isError).toBe(false);
    expect(v.latest).toBeNull();
  });

  it('拉到多版 → latest = rank1 + items 全保留（倒序）', () => {
    const items = [mockup({ id: '9', versionRank: 1 }), mockup({ id: '8', versionRank: 2 })];
    const v = deriveMockupView({ items, isPending: false, isError: false });
    expect(v.isEmpty).toBe(false);
    expect(v.latest?.id).toBe('9');
    expect(v.items).toHaveLength(2);
  });

  it('pending 时即便 items 空也不判 empty（态互斥）', () => {
    const v = deriveMockupView({ items: [], isPending: true, isError: false });
    expect(v.isEmpty).toBe(false);
    expect(v.isPending).toBe(true);
  });
});

describe('useSessionMockups（fetch-on-open 接线）', () => {
  it('有 sessionId → enabled=true 拉该 id', () => {
    captured.state = { data: { data: { items: [mockup({})] } }, isPending: false, isError: false };
    const { result } = renderHook(() => useSessionMockups('42'));
    expect(captured.id).toBe('42');
    expect(captured.opts?.query?.enabled).toBe(true);
    expect(result.current.latest?.id).toBe('1');
    expect(result.current.isEmpty).toBe(false);
  });

  it('sessionId=null → enabled=false（不发请求）+ 不转圈（isPending=false）', () => {
    captured.state = { data: undefined, isPending: true, isError: false };
    const { result } = renderHook(() => useSessionMockups(null));
    expect(captured.opts?.query?.enabled).toBe(false);
    // 无 session 即便底层 query.isPending=true（disabled 语义），对外不转圈。
    expect(result.current.isPending).toBe(false);
  });

  it('refetch 透传到底层 query（错误态重试）', () => {
    captured.state = { data: undefined, isPending: false, isError: true };
    captured.refetch.mockClear();
    const { result } = renderHook(() => useSessionMockups('7'));
    expect(result.current.isError).toBe(true);
    result.current.refetch();
    expect(captured.refetch).toHaveBeenCalledOnce();
  });
});
