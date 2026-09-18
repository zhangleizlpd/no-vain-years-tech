// @vitest-environment happy-dom
// 085 T009 — 持仓列表 query 的**币种维度**（FR-009 / SC-004，plan §D1）。
//
// 🚨 这条「踩了不会红」：query key 少了币种维度，切档照样发请求、屏幕照样重绘 —— 只是两档
//    共用一份缓存，切回去命中的是**另一档的数据**，而两份数据长得一样合理（都是金额）。
// 🚨 第二条同样静默：params 的**键序**决定 axios 的查询串顺序，而 083 既有 e2e 用的是
//    `'**/api/v1/optionsdesk/broker-positions?market=*'` 这个 glob（`optionsdesk-trading-account.spec.ts:69`）
//    —— 把 `displayCurrency` 排到 `market` 前面，那条 mock 直接不再命中，083 的 e2e 会以
//    「请求被 abort」的形态红在别处，根因看不出来。
//
// 手法同 `use-leg-table.spec.ts` / `use-anchor-mutations.spec.ts`：mock orval 生成的 hook 与 key
// 工厂（key 工厂逐字镜像 `[url, ...(params ? [params] : [])]`），不打真网络、不渲染组件。
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ⚠️ vi.mock 的 factory 被 hoist 到文件最顶 —— 里面只能碰 vi.hoisted 出来的东西。
const h = vi.hoisted(() => ({
  /** orval 生成的 key 工厂逐字镜像（`packages/api-client/src/generated/optionsdesk/optionsdesk.ts`）。 */
  positionsKey: (params?: Record<string, unknown>) =>
    ['/api/v1/optionsdesk/broker-positions', ...(params ? [params] : [])] as const,
  /** 每次 render 时生成 hook 实际收到的 params（键序保留）。 */
  calls: [] as Record<string, unknown>[],
  refetch: () => Promise.resolve(),
}));

vi.mock('@nvy/api-client', () => ({
  getBrokerAccountControllerPositionsQueryKey: h.positionsKey,
  useBrokerAccountControllerPositions: (params: Record<string, unknown>) => {
    h.calls.push(params);
    return {
      data: undefined,
      isPending: true,
      isError: false,
      isRefetching: false,
      refetch: h.refetch,
    };
  },
}));

import { useTradingAccountPositions } from './use-trading-account-positions';

/** 渲染一次 hook，返回它交给生成 query 的 params。 */
function paramsOf(market: 'us' | 'hk', displayCurrency: 'USD' | 'HKD' | 'CNY') {
  h.calls.length = 0;
  renderHook(() => useTradingAccountPositions(market, displayCurrency));
  const params = h.calls[0];
  if (params === undefined) throw new Error('生成 hook 未被调用');
  return params;
}

describe('useTradingAccountPositions · query key 的币种维度（FR-009 / SC-004）', () => {
  it('① 同市场不同币种 ⇒ 两份独立缓存；切回已取过的档 ⇒ 同一份 key（命中缓存）', () => {
    const hkd = h.positionsKey(paramsOf('hk', 'HKD'));
    const cny = h.positionsKey(paramsOf('hk', 'CNY'));
    const hkdAgain = h.positionsKey(paramsOf('hk', 'HKD'));

    // 少了币种维度这条会红：两档会得到逐字相同的 key。
    expect(hkd).not.toEqual(cny);
    // 切回已取过的档 ⇒ key 与第一次逐字相同 ⇒ react-query 命中缓存（SC-004 靠这个）。
    expect(hkdAgain).toEqual(hkd);
  });

  it('② 市场维度仍然独立（两市场 × 同币种 ⇒ 两份 key）', () => {
    expect(h.positionsKey(paramsOf('us', 'CNY'))).not.toEqual(
      h.positionsKey(paramsOf('hk', 'CNY')),
    );
  });

  it('③ params 恰为 { market, displayCurrency } 且 market 在前（083 e2e 的 `?market=*` glob）', () => {
    const params = paramsOf('hk', 'CNY');

    expect(params).toEqual({ market: 'hk', displayCurrency: 'CNY' });
    // 🚨 键序即查询串序：`displayCurrency` 排到前面会让 083 既有 e2e 的 URL glob 不再命中。
    expect(Object.keys(params)).toEqual(['market', 'displayCurrency']);
  });
});
