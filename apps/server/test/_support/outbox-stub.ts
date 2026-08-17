import type { OutboxPublisher } from '../../src/security/outbox/outbox-publisher.port';

/**
 * `OutboxPublisher` 的记录式桩 (060 T009)。
 *
 * 手工 `new CreateAnchorUseCase(prisma, …)` 的那几个 IT 验的是**锚自身**的 CRUD / 雷达 /
 * 采集闸, 与建锚事件无关 —— 它们不装 DI 容器, 拿不到真 publisher, 也没有断言它。
 *
 * 桩**记录调用**而不是彻底哑掉: 事件真的发没发, 由 060 的 IT 用真 DI 容器 + 真
 * `outbox_event` 表去验 (「建锚回滚不留 outbox 行」那条只有真表能验)。这里留个可观测面,
 * 是为了让「顺手想确认一下发了没」的人不必再改桩。
 */
export function recordingOutboxPublisher(): OutboxPublisher & {
  calls: { eventType: string; payload: Record<string, unknown> }[];
} {
  const calls: { eventType: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    publish: async (
      _client: unknown,
      eventType: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      calls.push({ eventType, payload });
    },
  };
}
