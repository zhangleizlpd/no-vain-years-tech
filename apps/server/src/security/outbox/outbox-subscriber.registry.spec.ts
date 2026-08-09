import { describe, it, expect, vi } from 'vitest';
import { OutboxSubscriberRegistry } from './outbox-subscriber.registry';
import type { OutboxSubscriber } from './outbox-subscriber.port';

function fakeSub(
  eventType: string,
  handle = vi.fn().mockResolvedValue(undefined),
): OutboxSubscriber {
  return { eventType, handle };
}

describe('OutboxSubscriberRegistry', () => {
  const delivery = { sourceEventId: 'e1', data: { foo: 'bar' } };

  it('dispatch 只路由到匹配 eventType 的 subscriber', async () => {
    const reg = new OutboxSubscriberRegistry();
    const matched = fakeSub('type.a');
    const other = fakeSub('type.b');
    reg.register(matched);
    reg.register(other);

    await reg.dispatch('type.a', delivery);

    expect(matched.handle).toHaveBeenCalledWith(delivery);
    expect(other.handle).not.toHaveBeenCalled();
  });

  it('同 eventType 多 subscriber 全部触发', async () => {
    const reg = new OutboxSubscriberRegistry();
    const s1 = fakeSub('type.a');
    const s2 = fakeSub('type.a');
    reg.register(s1);
    reg.register(s2);

    await reg.dispatch('type.a', delivery);

    expect(s1.handle).toHaveBeenCalledOnce();
    expect(s2.handle).toHaveBeenCalledOnce();
  });

  it('无匹配 subscriber → no-op (不抛)', async () => {
    const reg = new OutboxSubscriberRegistry();
    await expect(reg.dispatch('type.none', delivery)).resolves.toBeUndefined();
  });

  it('subscriber 抛错 → 向上抛 (cron 据此不标 published)', async () => {
    const reg = new OutboxSubscriberRegistry();
    reg.register(fakeSub('type.a', vi.fn().mockRejectedValue(new Error('boom'))));
    await expect(reg.dispatch('type.a', delivery)).rejects.toThrow('boom');
  });
});
