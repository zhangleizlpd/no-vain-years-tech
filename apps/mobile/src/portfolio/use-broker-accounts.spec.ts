// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrokerAccountItem, BrokerAccountListResponse } from '@nvy/api-client';

// Mock orval portfolio hooks + query-key so the real axios chain never loads.
// queryData drives the GET projection; bind/delete the mutations. The QueryClient
// cache (seeded per-test) backs optimistic removal + rollback.
const h = vi.hoisted(() => ({
  QK: ['/api/v1/portfolio/broker-accounts'] as const,
  bindAsync: vi.fn(),
  deleteAsync: vi.fn(),
  queryData: undefined as unknown,
  isPending: false,
  isError: false,
}));

vi.mock('@nvy/api-client', () => ({
  getBrokerAccountsControllerListQueryKey: () => h.QK,
  useBrokerAccountsControllerList: () => ({
    data: h.queryData,
    isPending: h.isPending,
    isError: h.isError,
    refetch: vi.fn(),
  }),
  useBrokerAccountsControllerBind: () => ({ mutateAsync: h.bindAsync, isPending: false }),
  useBrokerAccountsControllerDelete: () => ({ mutateAsync: h.deleteAsync, isPending: false }),
}));

import {
  bindErrorMessage,
  deleteErrorToast,
  removeAccount,
  useBrokerAccounts,
} from './use-broker-accounts';

const item = (id: string, over: Partial<BrokerAccountItem> = {}): BrokerAccountItem => ({
  id,
  brokerCode: 'zxzq',
  brokerName: '中信证券',
  clientNo: '31192466',
  isDefault: false,
  createdAt: '2026-06-02T00:00:00.000Z',
  ...over,
});

const defaultItem = (accountId: string): BrokerAccountItem => ({
  id: accountId,
  brokerCode: null,
  brokerName: '默认账户',
  clientNo: null,
  isDefault: true,
  createdAt: null,
});

const resp = (accounts: BrokerAccountItem[]): AxiosResponse<BrokerAccountListResponse> =>
  ({
    data: { accounts },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  }) as AxiosResponse<BrokerAccountListResponse>;

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
  const { result } = renderHook(() => useBrokerAccounts(), { wrapper });
  return { client, result };
}

describe('removeAccount (纯函数, 不可变)', () => {
  it('剔除目标 id 行, 不改其他行 + 不 mutate 原对象', () => {
    const prev = resp([defaultItem('100'), item('200'), item('300')]);
    const next = removeAccount(prev, '200');
    expect(next.data.accounts.map((a) => a.id)).toEqual(['100', '300']);
    // 原对象未被 mutate
    expect(prev.data.accounts.map((a) => a.id)).toEqual(['100', '200', '300']);
    expect(next).not.toBe(prev);
  });
  it('id 不存在 → 原样返回(长度不变)', () => {
    const prev = resp([defaultItem('100'), item('200')]);
    expect(removeAccount(prev, '999').data.accounts).toHaveLength(2);
  });
});

describe('bindErrorMessage (纯函数, 409 dup vs 400 校验 vs 网络错分流)', () => {
  it('409 BROKER_ACCOUNT_DUPLICATE → 行内重复文案', () => {
    expect(bindErrorMessage(axErr(409, 'BROKER_ACCOUNT_DUPLICATE'))).toBe(
      '该券商账户已绑定，请勿重复添加',
    );
  });
  it('400 FORM_VALIDATION → 校验文案', () => {
    expect(bindErrorMessage(axErr(400, 'FORM_VALIDATION'))).toBe('客户号有误，请检查后重试');
  });
  it('409 无 code → 按 status 兜底为重复文案', () => {
    expect(bindErrorMessage(axErr(409))).toBe('该券商账户已绑定，请勿重复添加');
  });
  it('400 无 code → 按 status 兜底为校验文案', () => {
    expect(bindErrorMessage(axErr(400))).toBe('客户号有误，请检查后重试');
  });
  it('5xx / 非 axios → 网络文案兜底', () => {
    expect(bindErrorMessage(axErr(500))).toBe('网络异常，请重试');
    expect(bindErrorMessage(new Error('boom'))).toBe('网络异常，请重试');
  });
});

describe('deleteErrorToast (纯函数, 限流 vs 通用删除失败分流)', () => {
  it('429 / RATE_LIMIT_EXCEEDED → 网络文案', () => {
    expect(deleteErrorToast(axErr(429))).toBe('网络异常，请重试');
    expect(deleteErrorToast(axErr(429, 'RATE_LIMIT_EXCEEDED'))).toBe('网络异常，请重试');
  });
  it('400 默认不可删 / 404 / 5xx → 删除失败文案', () => {
    expect(deleteErrorToast(axErr(400, 'DEFAULT_ACCOUNT_NOT_DELETABLE'))).toBe('删除失败，请重试');
    expect(deleteErrorToast(axErr(404))).toBe('删除失败，请重试');
    expect(deleteErrorToast(new Error('boom'))).toBe('删除失败，请重试');
  });
});

describe('useBrokerAccounts (hook 行为)', () => {
  beforeEach(() => {
    h.bindAsync.mockReset();
    h.deleteAsync.mockReset();
    h.isPending = false;
    h.isError = false;
    h.queryData = undefined;
  });

  it('绑定成功 → POST 携 {data:{brokerCode,clientNo}} + invalidate 列表 (FR-M03)', async () => {
    h.queryData = resp([defaultItem('100')]);
    h.bindAsync.mockResolvedValueOnce(item('200'));
    const { client, result } = setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await act(async () => {
      await result.current.bind('zxzq', '31192466');
    });
    expect(h.bindAsync).toHaveBeenCalledWith({
      data: { brokerCode: 'zxzq', clientNo: '31192466' },
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: h.QK });
  });

  it('绑定失败 → 抛出交 screen 分流(不吞错)', async () => {
    h.queryData = resp([defaultItem('100')]);
    h.bindAsync.mockRejectedValueOnce(axErr(409, 'BROKER_ACCOUNT_DUPLICATE'));
    const { result } = setup();
    await expect(
      act(async () => {
        await result.current.bind('zxzq', '31192466');
      }),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });

  it('删除成功 → 乐观移除目标行 (FR-M06)', async () => {
    h.queryData = resp([defaultItem('100'), item('200'), item('300')]);
    h.deleteAsync.mockResolvedValueOnce(undefined);
    const { client, result } = setup();
    await act(async () => {
      await result.current.remove('200');
    });
    expect(h.deleteAsync).toHaveBeenCalledWith({ id: '200' });
    const cached = client.getQueryData(h.QK) as AxiosResponse<BrokerAccountListResponse>;
    expect(cached.data.accounts.map((a) => a.id)).toEqual(['100', '300']);
    expect(result.current.errorToast).toBeNull();
  });

  it('删除失败 → cache 回滚原态 + errorToast', async () => {
    const prev = resp([defaultItem('100'), item('200')]);
    h.queryData = prev;
    h.deleteAsync.mockRejectedValueOnce(axErr(400, 'DEFAULT_ACCOUNT_NOT_DELETABLE'));
    const { client, result } = setup();
    await act(async () => {
      await result.current.remove('200');
    });
    expect(h.deleteAsync).toHaveBeenCalledOnce();
    // 回滚: 200 行恢复
    const cached = client.getQueryData(h.QK) as AxiosResponse<BrokerAccountListResponse>;
    expect(cached.data.accounts.map((a) => a.id)).toEqual(['100', '200']);
    expect(result.current.errorToast).toBe('删除失败，请重试');
  });
});
