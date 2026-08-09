// @vitest-environment happy-dom
// 会话 mutation wrapper 单测 —— 锁住「create / generateBrief 成功即失效会话列表」这条接线
// （列表常驻挂载不自动重取的修复核心；详见 use-session-mutations 顶注）。手法：mock orval mutation
// hook 捕获传入的 onSuccess，手动触发后断言失效列表 key；不打真网络、不依赖真 useMutation 行为。
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const LIST_KEY = ['/ideation/sessions'];

type CapturedOpts = { mutation?: { onSuccess?: () => void } } | null;
const captured = vi.hoisted(() => ({
  create: null as CapturedOpts,
  brief: null as CapturedOpts,
}));

vi.mock('@nvy/api-client', () => ({
  getSessionControllerListQueryKey: () => LIST_KEY,
  useSessionControllerCreate: vi.fn((opts: CapturedOpts) => {
    captured.create = opts;
    return { mutateAsync: vi.fn(), isPending: false };
  }),
  useBriefControllerGenerate: vi.fn((opts: CapturedOpts) => {
    captured.brief = opts;
    return { mutateAsync: vi.fn(), isPending: false };
  }),
}));

import {
  useCreateSession,
  useGenerateBrief,
  useInvalidateSessionList,
} from './use-session-mutations';

function renderWithSpiedClient<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(hook, { wrapper });
  return { result, spy };
}

describe('use-session-mutations（会话 mutation 共置失效）', () => {
  it('useCreateSession：onSuccess 失效会话列表 key（新会话即时入列）', () => {
    const { spy } = renderWithSpiedClient(() => useCreateSession());
    const onSuccess = captured.create?.mutation?.onSuccess;
    expect(onSuccess).toBeTypeOf('function');
    onSuccess?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
  });

  it('useGenerateBrief：onSuccess 失效会话列表 key（converge 状态徽标即时回显）', () => {
    const { spy } = renderWithSpiedClient(() => useGenerateBrief());
    const onSuccess = captured.brief?.mutation?.onSuccess;
    expect(onSuccess).toBeTypeOf('function');
    onSuccess?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
  });

  it('useInvalidateSessionList：共享原语，直接调用即失效列表 key（create/generateBrief wrapper + SSE turn 终态复用）', () => {
    const { result, spy } = renderWithSpiedClient(() => useInvalidateSessionList());
    result.current();
    expect(spy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
  });
});
