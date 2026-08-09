/**
 * Outbox 消费侧契约 (平台层, ADR-0033 的消费补全)。
 *
 * 历史: outbox 长期只有发布侧 (OutboxPublisher 写表) + cron placeholder (只标 published
 * 不分发)。agent-bridge (第 9 ctx) 是首个真消费方 → 此处补 IoC 消费抽象: 消费方实现
 * OutboxSubscriber + 在 OnModuleInit 自注册进 OutboxSubscriberRegistry; cron relay 按
 * eventType 分发。security 平台层只持本接口, **不静态依赖任何业务 ctx** (维持 base-layer
 * 单向边界 — 业务 ctx → security, 反向靠 IoC 注册表)。
 */

/** 单条 outbox 事件投递给消费方的载荷 (cron relay → subscriber)。 */
export interface OutboxEventDelivery {
  /** outbox_event 主键 (uuid) — 消费方据此幂等去重 (relay 是 at-least-once)。 */
  sourceEventId: string;
  /** ADR-0033 envelope.data (业务 payload, 不含 metadata)。 */
  data: Record<string, unknown>;
}

/** Outbox 事件消费方。 */
export interface OutboxSubscriber {
  /** 关注的事件类型 (= 生产方 publish 的 eventType 字面量, 主题契约)。 */
  readonly eventType: string;
  /**
   * 处理一条事件。**必须幂等** (relay at-least-once, 同一事件可能重投)。
   * 抛错 → cron 不标该事件 published, 下轮重投。
   */
  handle(delivery: OutboxEventDelivery): Promise<void>;
}
