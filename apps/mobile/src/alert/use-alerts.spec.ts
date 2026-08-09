import { describe, expect, it, vi } from 'vitest';
import type { AlertListResponse, AlertResponse } from '@nvy/api-client';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';

// 纯函数单测：mock @nvy/api-client（dist entry 在 vitest 不可解析；orval runtime hook
// 仅编排用，被测纯函数不触达）。镜像 use-watchlist-items.spec 体例。
vi.mock('@nvy/api-client', () => ({
  useAlertsControllerListAll: vi.fn(),
  useAlertsControllerListForInstrument: vi.fn(),
  useAlertsControllerCreateBatch: vi.fn(),
  useAlertsControllerUpdate: vi.fn(),
  useAlertsControllerDeleteBatch: vi.fn(),
  getAlertsControllerListAllQueryKey: vi.fn(() => ['/v1/alert/alerts']),
  getAlertsControllerListForInstrumentQueryKey: vi.fn((market: string, code: string) => [
    `/v1/alert/instruments/${market}/${code}/alerts`,
  ]),
}));

import { ALERT_COPY } from './alert-copy';
import {
  alertErrorToast,
  applyToggleOptimistic,
  groupAlertsByInstrument,
  NOTE_MAX_CODE_POINTS,
  noteCodePointCount,
} from './use-alerts';

const alert = (over: Partial<AlertResponse>): AlertResponse => ({
  id: '1',
  market: 'cn',
  code: '603305',
  conditions: [{ type: 'PRICE_FALL_TO', param: 0, threshold: '13.0000' }],
  frequency: 'DAILY',
  note: null,
  enabled: true,
  createdAt: '2026-06-06T12:00:00.000Z',
  ...over,
});

const listRes = (alerts: AlertResponse[]): AxiosResponse<AlertListResponse> =>
  ({ data: { alerts } }) as AxiosResponse<AlertListResponse>;

const problem = (status: number, code: string): AxiosError =>
  new AxiosError('boom', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { type: 'about:blank', title: 't', status, code },
  });

describe('alertErrorToast — 失败分流（013 体例）', () => {
  it('FORM_VALIDATION → 校验文案', () => {
    expect(alertErrorToast(problem(400, 'FORM_VALIDATION'))).toBe(ALERT_COPY.errorToast.validation);
  });

  it('ALERT_NOT_FOUND → 不存在文案（404 反枚举展示同款）', () => {
    expect(alertErrorToast(problem(404, 'ALERT_NOT_FOUND'))).toBe(ALERT_COPY.errorToast.notFound);
  });

  it('RATE_LIMIT_EXCEEDED / 裸 429 → 限流文案', () => {
    expect(alertErrorToast(problem(429, 'RATE_LIMIT_EXCEEDED'))).toBe(
      ALERT_COPY.errorToast.rateLimit,
    );
  });

  it('其余（网络/未知）→ 网络文案', () => {
    expect(alertErrorToast(new Error('offline'))).toBe(ALERT_COPY.errorToast.network);
  });
});

describe('applyToggleOptimistic — 乐观启停 patch（不可变，cache 安全）', () => {
  it('仅 patch 目标 id，余者原样，顺序不变', () => {
    const prev = listRes([alert({ id: '1' }), alert({ id: '2', code: '600519' })]);
    const next = applyToggleOptimistic(prev, '1', false);
    expect(next.data.alerts.map((a) => [a.id, a.enabled])).toEqual([
      ['1', false],
      ['2', true],
    ]);
    expect(prev.data.alerts[0]!.enabled).toBe(true); // 原对象未被改写
  });

  it('id 不在列表 → 结构不变', () => {
    const prev = listRes([alert({ id: '1' })]);
    expect(applyToggleOptimistic(prev, '999', false).data.alerts[0]!.enabled).toBe(true);
  });
});

describe('groupAlertsByInstrument — 屏 5 分组（first-seen 序）', () => {
  it('按 market:code 聚组，组序 = 首见序，组内序 = 输入序', () => {
    const a1 = alert({ id: '1', code: '603305' });
    const a2 = alert({ id: '2', code: '600519' });
    const a3 = alert({ id: '3', code: '603305', enabled: false });
    const groups = groupAlertsByInstrument([a1, a2, a3]);
    expect(groups.map((g) => g.code)).toEqual(['603305', '600519']);
    expect(groups[0]!.alerts.map((a) => a.id)).toEqual(['1', '3']);
    expect(groups[0]!.market).toBe('cn');
  });

  it('空列表 → 空组', () => {
    expect(groupAlertsByInstrument([])).toEqual([]);
  });
});

describe('noteCodePointCount — 备注计数（plan D10，与 server 同口径）', () => {
  it('Unicode code point 计：emoji/生僻字算 1', () => {
    expect(noteCodePointCount('低吸观察')).toBe(4);
    expect(noteCodePointCount('😀')).toBe(1); // surrogate pair ≠ 2
    expect(noteCodePointCount('𠮷野家')).toBe(3);
  });

  it('22 字边界与上限常量', () => {
    expect(NOTE_MAX_CODE_POINTS).toBe(22);
    expect(noteCodePointCount('注'.repeat(22))).toBe(22);
    expect(noteCodePointCount('注'.repeat(23))).toBe(23);
  });
});
