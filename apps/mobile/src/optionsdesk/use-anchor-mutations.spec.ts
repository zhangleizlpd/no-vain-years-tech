// @vitest-environment happy-dom
// 锚 mutation wrapper 单测 —— 锁住「任一写动作成功即失效**雷达与锚列表两个** query key」这条接线。
// 漏失效的后果：列表 / 雷达常驻挂载（staleTime 30s + refetchOnWindowFocus:false）无触发器重取，
// 陈旧到 App 重启（mobile-impl-playbook § 8）。手法同 ideation/use-session-mutations.spec.ts：
// mock orval hook 捕获 onSuccess，手动触发后断言失效 key；不打真网络。
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

type Slot = 'create' | 'update' | 'remove' | 'review';
type CapturedOpts =
  | { mutation?: { onSuccess?: (data?: unknown, variables?: { id: string }) => void } }
  | undefined;

// ⚠️ vi.mock 的 factory 被 hoist 到文件最顶 —— 里面只能碰 vi.hoisted 出来的东西。
const h = vi.hoisted(() => ({
  LIST_KEY: ['/api/v1/optionsdesk/anchors'],
  getOneKey: (id: string) => [`/api/v1/optionsdesk/anchors/${id}`],
  captured: {} as Record<string, unknown>,
}));

vi.mock('@nvy/api-client', () => {
  const stub = (slot: Slot) => (opts: unknown) => {
    h.captured[slot] = opts;
    return { mutateAsync: vi.fn(), isPending: false };
  };
  return {
    getOptionsdeskControllerListQueryKey: () => h.LIST_KEY,
    getOptionsdeskControllerGetOneQueryKey: h.getOneKey,
    useOptionsdeskControllerCreate: stub('create'),
    useOptionsdeskControllerUpdate: stub('update'),
    useOptionsdeskControllerRemove: stub('remove'),
    useOptionsdeskControllerReview: stub('review'),
  };
});

import { RADAR_QUERY_KEY } from './radar.rules';
import {
  useCreateAnchor,
  useDeleteAnchor,
  useInvalidateAnchorQueries,
  useReviewAnchor,
  useUpdateAnchor,
} from './use-anchor-mutations';

function renderWithSpiedClient<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(hook, { wrapper });
  return { result, spy };
}

function expectBothKeysInvalidated(spy: { mock: { calls: unknown[][] } }) {
  expect(spy).toHaveBeenCalledWith({ queryKey: h.LIST_KEY });
  // 🚨 065 T12: 雷达那一半取 `RADAR_QUERY_KEY`（`useRadar` 实际用的前缀），**不是** orval
  //    工厂 —— 后者与雷达的 key 无共同前缀，写成它这几条断言会全绿而失效从未发生过。
  expect(spy).toHaveBeenCalledWith({ queryKey: [...RADAR_QUERY_KEY] });
}

describe('use-anchor-mutations（写动作共置失效）', () => {
  // ── 065 T12: 病根的直接判据（先于 e2e 红） ──────────────────────────────────
  it('🚨 失效用的雷达 key 与 `useRadar` 实际用的 key **共享前缀**（否则从未失效过雷达）', () => {
    const { result, spy } = renderWithSpiedClient(() => useInvalidateAnchorQueries());
    result.current();

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    // `useRadar` 的 key 由 `radarQueryKey(market, filters)` 铸造，前缀恒是 `RADAR_QUERY_KEY`。
    // react-query 的 invalidate 走**前缀匹配** ⇒ 失效侧必须发出这个前缀，否则永远命中不到。
    // 此前发的是 orval 的 `['/api/v1/optionsdesk/radar']` —— 与它无任何共同前缀。
    expect(keys).toContainEqual([...RADAR_QUERY_KEY]);
  });

  it('useInvalidateAnchorQueries：一次调用失效锚列表 + 雷达两个 key', () => {
    const { result, spy } = renderWithSpiedClient(() => useInvalidateAnchorQueries());
    result.current();
    expectBothKeysInvalidated(spy);
  });

  it('useInvalidateAnchorQueries：带锚 id 时**连带失效单条详情** key', () => {
    const { result, spy } = renderWithSpiedClient(() => useInvalidateAnchorQueries());
    result.current('42');
    expectBothKeysInvalidated(spy);
    expect(spy).toHaveBeenCalledWith({ queryKey: h.getOneKey('42') });
  });

  it.each([
    ['useCreateAnchor（建锚 → 两处行数变）', useCreateAnchor, 'create'],
    [
      'useUpdateAnchor（改 V/confidence/excluded → 两处 list-visible 字段变）',
      useUpdateAnchor,
      'update',
    ],
    ['useDeleteAnchor（删锚 → 两处行数变）', useDeleteAnchor, 'remove'],
    ['useReviewAnchor（复审 → 逾期红标变）', useReviewAnchor, 'review'],
  ] as const)('%s：onSuccess 失效两个 key', (_name, hook, slot) => {
    const { spy } = renderWithSpiedClient(() => hook());
    const onSuccess = (h.captured[slot] as CapturedOpts)?.mutation?.onSuccess;
    expect(onSuccess).toBeTypeOf('function');
    onSuccess?.(undefined, { id: '42' });
    expectBothKeysInvalidated(spy);
  });

  // 🚨 表单屏（`useOptionsdeskControllerGetOne`）的 key 不在 list / radar 前缀下 —— 改锚 /
  // 复审后不失效它，人工位置值与撤销就「同屏不回落」（FR-032 ③ / FR-035 ②③ 失效）。
  it.each([
    ['useUpdateAnchor（三处人工位置值 / 撤销）', useUpdateAnchor, 'update'],
    ['useReviewAnchor（复审推进 next_review / 解红标）', useReviewAnchor, 'review'],
  ] as const)('%s：onSuccess 用 variables.id 连带失效单条详情', (_name, hook, slot) => {
    const { spy } = renderWithSpiedClient(() => hook());
    const onSuccess = (h.captured[slot] as CapturedOpts)?.mutation?.onSuccess;
    onSuccess?.(undefined, { id: '7' });
    expect(spy).toHaveBeenCalledWith({ queryKey: h.getOneKey('7') });
  });

  it.each([
    ['useCreateAnchor（建锚时还没有 id）', useCreateAnchor, 'create'],
    ['useDeleteAnchor（详情行已删，无详情可刷）', useDeleteAnchor, 'remove'],
  ] as const)('%s：不失效任何单条详情 key', (_name, hook, slot) => {
    const { spy } = renderWithSpiedClient(() => hook());
    const onSuccess = (h.captured[slot] as CapturedOpts)?.mutation?.onSuccess;
    onSuccess?.(undefined, { id: '42' });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: h.getOneKey('42') });
  });
});
