import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { OutboxSubscriberRegistry } from './outbox-subscriber.registry.js';
import { OutboxEventEnvelopeSchema } from './outbox-event-envelope.schema.js';

/**
 * OutboxEventCronPublisher — outbox relay (ADR-0033 消费侧落地, 2026-06-26 起接首个真消费方)。
 *
 * 每轮扫 `outbox_event` 中 `published_at IS NULL` 行 (FIFO, 每批 100) → 解 envelope →
 * 按 eventType 经 OutboxSubscriberRegistry 分发给消费方 → 成功才标 published。dispatch 抛错
 * → 不标 published, 下轮重投 (relay at-least-once; 消费方须幂等)。无消费方的 eventType →
 * dispatch no-op, 仍标 published (fire-and-forget, 维持历史 placeholder 语义)。
 *
 * @Cron EVERY_10_SECONDS: 准实时 relay (入队延迟 ≤ relay 间隔 + worker poll 间隔)。
 * 内部操作幂等且廉价 (扫内部表 + 幂等 dispatch), 全 boot 测试中触发无害 (区别于 marketdata
 * tick 打外部 API 需 env-gate)。单测直调 scan() (不依赖 ScheduleModule)。
 */
@Injectable()
export class OutboxEventCronPublisher {
  private readonly logger = new Logger(OutboxEventCronPublisher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OutboxSubscriberRegistry,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async handleCron(): Promise<void> {
    await this.scan();
  }

  async scan(): Promise<{ scanned: number; published: number }> {
    const unpublished = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });

    let published = 0;
    for (const row of unpublished) {
      try {
        // envelope 解析失败 (历史/非标准 payload) → data 退化空对象, 仍尝试 dispatch
        // (无消费方则 no-op 标 published; 有消费方靠自身校验拒绝)。
        const parsed = OutboxEventEnvelopeSchema.safeParse(row.payload);
        const data = parsed.success ? parsed.data.data : {};
        await this.registry.dispatch(row.eventType, { sourceEventId: row.id, data });
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { publishedAt: new Date() },
        });
        published += 1;
      } catch (e) {
        // dispatch 抛错 → 保持 unpublished, 下轮重投 (subscriber 幂等)。单行隔离不阻 sibling。
        this.logger.error(
          `outbox dispatch failed event=${row.id} type=${row.eventType}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    if (unpublished.length > 0) {
      this.logger.debug(
        `outbox scan: ${unpublished.length} unpublished, ${published} dispatched+published`,
      );
    }
    return { scanned: unpublished.length, published };
  }
}
