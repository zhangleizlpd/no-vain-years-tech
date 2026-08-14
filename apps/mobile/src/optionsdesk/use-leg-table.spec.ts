// @vitest-environment happy-dom
// 053 T007 — 水位写端点成功后的失效必须**覆盖三个视角**（FR-021 / SC-013, Guardrail 2）。
//
// 🚨 这条是本片最容易漏且**屏幕上什么都不会红**的一条：053 起 query key 含 `perspective`，
//    拿带视角的那份 key 去失效只命中一个（甚至一个都不命中）—— 水位 chip 亮了、意图变了，
//    另外两个视角还在用旧口径打推荐标（推荐标是**标的级、不随视角变**），数字与标全都在。
//
// 🚨 **反例探针（证明本断言真的会红）**：把 `legTableQueryPrefix` 改成
//    `getOptionsdeskControllerLegsQueryKey(symbol, { perspective: 'rent' })`，
//    下面「三份全失效」那条立刻红（建仓 / 全腿两份 `isInvalidated` 仍为 false）。
//
// 手法同 `use-anchor-mutations.spec.ts`：mock orval hook 捕获 `onSuccess`，手动触发后断言
// **真 QueryClient 缓存里**的失效结果；不打真网络、不渲染任何组件（本仓测试分层：vitest = 逻辑）。
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

// ⚠️ vi.mock 的 factory 被 hoist 到文件最顶 —— 里面只能碰 vi.hoisted 出来的东西。
const h = vi.hoisted(() => ({
  // orval 生成的 key 工厂逐字镜像：`[url, ...(params ? [params] : [])]`。
  legsKey: (symbol: string, params?: Record<string, unknown>) =>
    [`/api/v1/optionsdesk/underlyings/${symbol}/legs`, ...(params ? [params] : [])] as const,
  captured: {} as { mutation?: { onSuccess?: () => void } },
}));

vi.mock('@nvy/api-client', () => ({
  getOptionsdeskControllerLegsQueryKey: h.legsKey,
  useOptionsdeskControllerLegs: () => ({ isPending: true, isSuccess: false, isError: false }),
  useOptionsdeskControllerPositionBucket: (opts: { mutation?: { onSuccess?: () => void } }) => {
    h.captured = opts;
    return { mutate: vi.fn(), isPending: false, isError: false };
  },
}));

import { useSetPositionBucket } from './use-leg-table';

const SYMBOL = 'US:AAPL';
const OTHER_SYMBOL = 'US:MSFT';
const PERSPECTIVES = ['all', 'build', 'rent'] as const;

function renderWithSeededCache() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 三个视角各一份缓存（键形状 = 真实请求那份：`[url, params]`，params 含 perspective）。
  for (const perspective of PERSPECTIVES) {
    client.setQueryData(h.legsKey(SYMBOL, { perspective }), { data: { perspective } });
  }
  client.setQueryData(h.legsKey(OTHER_SYMBOL, { perspective: 'all' }), { data: {} });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  renderHook(() => useSetPositionBucket(SYMBOL), { wrapper });
  return client;
}

function invalidatedCount(client: QueryClient, symbol: string): number {
  return PERSPECTIVES.filter(
    (perspective) =>
      client.getQueryState(h.legsKey(symbol, { perspective }))?.isInvalidated === true,
  ).length;
}

describe('useSetPositionBucket 的失效面（FR-021）', () => {
  it('水位写成功 ⇒ **三个视角全部**失效（只失效一个 = 另外两个继续用旧口径打推荐标）', () => {
    const client = renderWithSeededCache();
    expect(invalidatedCount(client, SYMBOL)).toBe(0);

    h.captured.mutation?.onSuccess?.();

    expect(invalidatedCount(client, SYMBOL)).toBe(3);
  });

  it('用户停在**建仓**视角时改水位，建仓那份照样失效（SC-013 点名的最易漏路径）', () => {
    const client = renderWithSeededCache();

    h.captured.mutation?.onSuccess?.();

    expect(client.getQueryState(h.legsKey(SYMBOL, { perspective: 'build' }))?.isInvalidated).toBe(
      true,
    );
  });

  it('前缀 key 不越界到别的标的 —— 失效面止于本 symbol', () => {
    const client = renderWithSeededCache();

    h.captured.mutation?.onSuccess?.();

    expect(
      client.getQueryState(h.legsKey(OTHER_SYMBOL, { perspective: 'all' }))?.isInvalidated,
    ).toBe(false);
  });
});
