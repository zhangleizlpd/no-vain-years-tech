import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ANCHOR_CREATED_EVENT, AnchorColdStartSubscriber } from './anchor-cold-start.subscriber.js';
import type { MarketdataSyncQueue } from './marketdata-sync.queue.js';
import type { OutboxSubscriberRegistry } from '../security/outbox/outbox-subscriber.registry.js';

const SOURCE_EVENT_ID = '11111111-2222-3333-4444-555555555555';

function delivery(data: Record<string, unknown>, sourceEventId = SOURCE_EVENT_ID) {
  return { sourceEventId, data };
}

function build() {
  const enqueueColdStart = vi.fn(async (_payload: unknown) => ({ id: 'job-1' }));
  const syncQueue = { enqueueColdStart } as unknown as MarketdataSyncQueue;

  const register = vi.fn((_sub: unknown) => undefined);
  const registry = { register } as unknown as OutboxSubscriberRegistry;

  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  return {
    subscriber: new AnchorColdStartSubscriber(syncQueue, registry),
    enqueueColdStart,
    register,
    error,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AnchorColdStartSubscriber (060 T008)', () => {
  it('认的事件类型是 optionsdesk 侧的字面量 (两端各持一份, 无 import 边)', () => {
    const { subscriber } = build();

    expect(ANCHOR_CREATED_EVENT).toBe('optionsdesk.anchor-created');
    expect(subscriber.eventType).toBe(ANCHOR_CREATED_EVENT);
  });

  it('onModuleInit ⇒ 自注册进 OutboxSubscriberRegistry (IoC, security 不反向依赖业务)', () => {
    const { subscriber, register } = build();

    subscriber.onModuleInit();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(subscriber);
  });

  it('合法 payload ⇒ 只入一个 job 就返回 (relay 是单线 cron, 这里同步跑采集会顶住所有 ctx)', async () => {
    const { subscriber, enqueueColdStart, error } = build();

    await subscriber.handle(delivery({ anchorId: '42', ticker: 'us:AAPL' }));

    expect(enqueueColdStart).toHaveBeenCalledTimes(1);
    expect(enqueueColdStart).toHaveBeenCalledWith({ anchorId: '42', ticker: 'us:AAPL' });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ['缺 ticker', { anchorId: '42' }],
    ['缺 anchorId', { ticker: 'us:AAPL' }],
    ['ticker 空串', { anchorId: '42', ticker: '' }],
    ['ticker 非字符串', { anchorId: '42', ticker: 42 }],
    ['anchorId 非十进制串', { anchorId: 'abc', ticker: 'us:AAPL' }],
    ['anchorId 是数字 (BigInt 过 JSON 只能是串)', { anchorId: 42, ticker: 'us:AAPL' }],
  ])('payload 漂移 (%s) ⇒ **不抛** + 零入队 + ERROR log', async (_label, data) => {
    const { subscriber, enqueueColdStart, error } = build();

    // 🚨 方向: 抛了 relay 每 10s 重投同一条毒丸, 永久卡死且挡住**后面所有 ctx 的事件**。
    await expect(subscriber.handle(delivery(data))).resolves.toBeUndefined();
    expect(enqueueColdStart).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('入队失败 (Redis 不可达等基建故障) ⇒ **抛**, 交给 relay 下轮重投', async () => {
    const { subscriber, enqueueColdStart } = build();
    enqueueColdStart.mockRejectedValue(new Error('ECONNREFUSED'));

    // 🚨 全片最容易写反的一处: 吞掉这个错 = 事件被标 published 而冷启动**永远丢失**。
    //    它不是毒丸 —— 下轮重投正是正确处置。
    await expect(
      subscriber.handle(delivery({ anchorId: '42', ticker: 'us:AAPL' })),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('同一 sourceEventId 重投 ⇒ 照样入队两次 (本片蓄意不做 relay 层去重, plan §D2)', async () => {
    const { subscriber, enqueueColdStart } = build();

    await subscriber.handle(delivery({ anchorId: '42', ticker: 'us:AAPL' }));
    await subscriber.handle(delivery({ anchorId: '42', ticker: 'us:AAPL' }));

    // 收敛靠 job 的**起手复判**(判据是「该标的该交易日的数据在不在」), 一处判据同时管住
    // 重复投递与常规轮已采两种情形 ⇒ 这里再加一道 sourceEventId 去重是第二处判据。
    expect(enqueueColdStart).toHaveBeenCalledTimes(2);
  });
});
