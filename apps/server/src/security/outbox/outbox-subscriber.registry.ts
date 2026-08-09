import { Injectable } from '@nestjs/common';
import type { OutboxEventDelivery, OutboxSubscriber } from './outbox-subscriber.port.js';

/**
 * Outbox 消费方注册表 (平台层, security base layer)。消费方 (任意业务 ctx) 在 OnModuleInit
 * 调 register() 自注册; OutboxEventCronPublisher relay 时按 eventType dispatch。
 *
 * IoC: security 只持 OutboxSubscriber 接口, 不静态 import 任何业务 ctx → 维持 base-layer
 * 单向边界 (业务 ctx → security)。单例 (SecurityModule 内), cron publisher 与各 subscriber
 * 共享同一实例 (export + import 传递)。
 */
@Injectable()
export class OutboxSubscriberRegistry {
  private readonly byType = new Map<string, OutboxSubscriber[]>();

  register(subscriber: OutboxSubscriber): void {
    const list = this.byType.get(subscriber.eventType) ?? [];
    list.push(subscriber);
    this.byType.set(subscriber.eventType, list);
  }

  /**
   * 分发一条事件给所有匹配 eventType 的 subscriber。无匹配 → no-op (事件无消费方,
   * cron 仍标 published)。任一 subscriber 抛错 → 向上抛 (cron 不标 published, 下轮重投)。
   */
  async dispatch(eventType: string, delivery: OutboxEventDelivery): Promise<void> {
    const subs = this.byType.get(eventType) ?? [];
    for (const s of subs) {
      await s.handle(delivery);
    }
  }
}
