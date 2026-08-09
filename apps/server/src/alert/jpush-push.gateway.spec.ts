import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JpushPushGateway } from './jpush-push.gateway.js';
import { ALERT_PUSH_CHANNEL_ID, type PushSendInput } from './push-gateway.port.js';

const INPUT: PushSendInput = {
  registrationId: 'reg-abc-123',
  title: '预警触发',
  body: '招商银行 跌至 30.00 预警价（今日最低 29.80）',
  triggerId: 42n,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('JpushPushGateway (022 T002, HTTP mock)', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let gateway: JpushPushGateway;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    gateway = new JpushPushGateway('app-key', 'master-secret');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('POSTs /v3/push with Basic auth + plan §payload 形态 (snapshot)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { msg_id: '134123478', sendno: '0' }));

    const result = await gateway.send(INPUT);

    expect(result.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.jpush.cn/v3/push');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('app-key:master-secret').toString('base64')}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      platform: ['android'],
      audience: { registration_id: ['reg-abc-123'] },
      notification: {
        android: {
          alert: '招商银行 跌至 30.00 预警价（今日最低 29.80）',
          title: '预警触发',
          channel_id: ALERT_PUSH_CHANNEL_ID,
          extras: { triggerId: '42' },
        },
      },
      options: { time_to_live: 86400 },
    });
  });

  it('5xx → retryable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: 1030, message: 'Internal error' } }),
    );
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('retryable');
  });

  it('网络异常 (fetch reject) → retryable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('retryable');
    expect(result.detail).toContain('fetch failed');
  });

  it('429 限流 (error code 2002) → retryable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: 2002, message: 'Rate limit exceeded' } }),
    );
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('retryable');
  });

  it('RegID 无效 (400, error code 1011) → invalid_target', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 1011, message: 'cannot find user by this audience' } }),
    );
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('invalid_target');
    expect(result.detail).toContain('1011');
  });

  it('其他 4xx (如 1004 鉴权失败) → retryable 兜底 (有限重试后 FAILED 留痕, 绝不误删 binding)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 1004, message: 'Authen failed' } }),
    );
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('retryable');
    expect(result.detail).toContain('1004');
  });

  it('4xx 响应体非 JSON → retryable 兜底', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway html', { status: 400 }));
    const result = await gateway.send(INPUT);
    expect(result.kind).toBe('retryable');
  });
});
