// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketItem, MarketPreferencesResponse } from '@nvy/api-client';

// Mock orval portfolio hooks + query-key so the real axios chain never loads.
// queryData drives the GET projection; mutateAsync the PUT. The QueryClient
// cache (seeded per-test) backs optimistic update + rollback.
const h = vi.hoisted(() => ({
  QK: ['/api/v1/portfolio/market-preferences'] as const,
  mutateAsync: vi.fn(),
  queryData: undefined as unknown,
  isPending: false,
  isError: false,
}));

vi.mock('@nvy/api-client', () => ({
  getMarketPreferencesControllerGetPreferencesQueryKey: () => h.QK,
  useMarketPreferencesControllerGetPreferences: () => ({
    data: h.queryData,
    isPending: h.isPending,
    isError: h.isError,
    refetch: vi.fn(),
  }),
  useMarketPreferencesControllerUpdatePreference: () => ({
    mutateAsync: h.mutateAsync,
    isPending: false,
  }),
}));

import {
  applyToggle,
  marketToggleErrorToast,
  predictMinOneViolation,
  useMarketPreferences,
} from './use-market-preferences';

const core = (code: string, active: boolean): MarketItem => ({
  marketCode: code,
  displayName: code,
  isoCurrency: code,
  group: 'core',
  v1Available: true,
  active,
});

const resp = (markets: MarketItem[]): AxiosResponse<MarketPreferencesResponse> =>
  ({
    data: { markets },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  }) as AxiosResponse<MarketPreferencesResponse>;

const axErr = (status: number, code?: string) => ({
  isAxiosError: true,
  response: {
    status,
    data: code ? { status, title: 'x', code } : undefined,
  },
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(h.QK, h.queryData);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useMarketPreferences(), { wrapper });
  return { client, result };
}

describe('predictMinOneViolation (纯函数)', () => {
  const markets = [core('cn', true), core('hk', false), core('us', false)];

  it('关唯一激活核心市场 → true', () => {
    expect(predictMinOneViolation(markets, 'cn', false)).toBe(true);
  });
  it('多激活时关其一 → false', () => {
    const multi = [core('cn', true), core('hk', true), core('us', false)];
    expect(predictMinOneViolation(multi, 'cn', false)).toBe(false);
  });
  it('开启动作永不违规 → false', () => {
    expect(predictMinOneViolation(markets, 'hk', true)).toBe(false);
  });
  it('关一个本就 inactive 的市场 → false', () => {
    expect(predictMinOneViolation(markets, 'hk', false)).toBe(false);
  });
  it('海外市场不参与 min-1 → false', () => {
    const overseas: MarketItem = { ...core('jp', false), group: 'overseas', v1Available: false };
    expect(predictMinOneViolation([core('cn', true), overseas], 'jp', false)).toBe(false);
  });
});

describe('applyToggle (纯函数, 不可变)', () => {
  it('只翻目标行 active, 不改其他行 + 不 mutate 原对象', () => {
    const prev = resp([core('cn', true), core('hk', false)]);
    const next = applyToggle(prev, 'hk', true);
    expect(next.data.markets.find((m) => m.marketCode === 'hk')?.active).toBe(true);
    expect(next.data.markets.find((m) => m.marketCode === 'cn')?.active).toBe(true);
    // 原对象未被 mutate
    expect(prev.data.markets.find((m) => m.marketCode === 'hk')?.active).toBe(false);
    expect(next).not.toBe(prev);
  });
});

describe('marketToggleErrorToast (纯函数, 422 vs 网络错分流)', () => {
  it('422 MIN_ONE_MARKET_REQUIRED → min-1 文案', () => {
    expect(marketToggleErrorToast(axErr(422, 'MIN_ONE_MARKET_REQUIRED'))).toBe(
      '至少保留一个激活市场',
    );
  });
  it('429 → 限流文案', () => {
    expect(marketToggleErrorToast(axErr(429))).toBe('请求过于频繁，请稍后再试');
  });
  it('5xx / 无 code → 网络文案', () => {
    expect(marketToggleErrorToast(axErr(500))).toBe('网络异常，请重试');
  });
  it('非 axios → 网络文案兜底', () => {
    expect(marketToggleErrorToast(new Error('boom'))).toBe('网络异常，请重试');
  });
});

describe('useMarketPreferences (hook 行为)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset();
    h.isPending = false;
    h.isError = false;
    h.queryData = undefined;
  });

  it('min-1 客户端预判拦截 → 不发 PUT + 设轻提示', async () => {
    h.queryData = resp([core('cn', true), core('hk', false), core('us', false)]);
    const { result } = setup();
    await act(async () => {
      await result.current.toggle('cn', false);
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.hint).toBe('至少保留一个激活市场');
  });

  it('成功 toggle → PUT 携 {market,data.active} + cache 对账为响应全量态 (D7)', async () => {
    h.queryData = resp([core('cn', true), core('hk', false)]);
    const reconciled = resp([core('cn', true), core('hk', true)]);
    h.mutateAsync.mockResolvedValueOnce(reconciled);
    const { client, result } = setup();
    await act(async () => {
      await result.current.toggle('hk', true);
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ market: 'hk', data: { active: true } });
    expect(client.getQueryData(h.QK)).toEqual(reconciled);
    expect(result.current.errorToast).toBeNull();
  });

  it('PUT 失败 → cache 回弹原态 + errorToast', async () => {
    const prev = resp([core('cn', true), core('hk', true)]);
    h.queryData = prev;
    h.mutateAsync.mockRejectedValueOnce(axErr(500));
    const { client, result } = setup();
    await act(async () => {
      await result.current.toggle('hk', false); // 多激活, 不触发 min-1 预判
    });
    expect(h.mutateAsync).toHaveBeenCalledOnce();
    // 回弹: hk 恢复 active=true (非乐观更新的 false)
    expect(client.getQueryData(h.QK)).toEqual(prev);
    expect(
      (client.getQueryData(h.QK) as AxiosResponse<MarketPreferencesResponse>).data.markets.find(
        (m) => m.marketCode === 'hk',
      )?.active,
    ).toBe(true);
    expect(result.current.errorToast).toBe('网络异常，请重试');
  });
});
