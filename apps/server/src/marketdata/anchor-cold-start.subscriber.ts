import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OutboxSubscriberRegistry } from '../security/outbox/outbox-subscriber.registry.js';
import type {
  OutboxEventDelivery,
  OutboxSubscriber,
} from '../security/outbox/outbox-subscriber.port.js';
import { MarketdataSyncQueue } from './marketdata-sync.queue.js';

/**
 * 主题契约: optionsdesk 建锚事务内 publish 的 eventType。
 *
 * 🚫 **两端各持同一字面量, 不 import 对方** —— optionsdesk 与 marketdata 是两个平级业务
 * ctx (ADR-0032), 为一个字符串建 import 边等于把「异步解耦」重新焊死成编译期依赖。
 */
export const ANCHOR_CREATED_EVENT = 'optionsdesk.anchor-created';

/**
 * 锚首建冷启动的 **outbox 消费方** (060 T008, plan §D2)。形态照抄
 * `agent-bridge/enqueue-requirement.subscriber.ts` (本仓首个 outbox 消费方)。
 *
 * 🚨 **只做「校验 + 入队」, 绝不同步跑采集。** outbox relay 是
 * `@Cron(EVERY_10_SECONDS)` 单线, 一次链 + 快照采集是**分钟级** ⇒ 在这里同步跑会把 relay
 * 整条顶住, 卡的是**所有 ctx 的事件**, 不只本片。
 *
 * ## 🚨 两类失败的处置方向**相反**, 写成一条会各错一半
 *
 * | 失败 | 处置 | 为什么 |
 * |---|---|---|
 * | payload 形状不符 (毒丸) | `logger.error` + **return, 不抛** | 抛了 relay 每 10s 重投同一条, 永久卡死且挡住后面所有事件 |
 * | 入队失败 (Redis 不可达等基建故障) | **抛** | 那不是毒丸, 下轮重投正是正确处置; 吞掉会把事件标 published 而冷启动**永远丢失** |
 *
 * ## 幂等
 *
 * relay 是 at-least-once, `delivery.sourceEventId` 可用于去重 —— 本片**蓄意不用**。重复投递
 * 由 job 的**起手复判**吸收 (判据是「该标的在目标交易日的数据在不在」,
 * 见 `anchor-cold-start.usecase.ts`): 一处判据同时管住「重复投递」与「常规轮已采」两种情形,
 * 在这里再加一道 `sourceEventId` 去重就是同一件事的第二处判据。
 */
@Injectable()
export class AnchorColdStartSubscriber implements OutboxSubscriber, OnModuleInit {
  private readonly logger = new Logger(AnchorColdStartSubscriber.name);
  readonly eventType = ANCHOR_CREATED_EVENT;

  constructor(
    private readonly syncQueue: MarketdataSyncQueue,
    private readonly registry: OutboxSubscriberRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** 复杂度: O(1) —— 一次形状校验 + 一次入队, 毫秒级 (见类注释的「绝不同步跑采集」)。 */
  async handle(delivery: OutboxEventDelivery): Promise<void> {
    const { anchorId, ticker } = delivery.data;
    // `anchorId` 在生产侧是 `bigint`, 过 JSON 信封只能是十进制串 —— 收到数字就是契约漂移,
    // 放行的话精度丢在 `Number` 上, 而 PK 错行是**不报错**的那类坏。
    if (
      typeof anchorId !== 'string' ||
      !/^\d+$/.test(anchorId) ||
      typeof ticker !== 'string' ||
      ticker === ''
    ) {
      // 契约漂移 (生产方 payload 形状不符) → 跳过 + ERROR log, **不抛** (否则 cron 卡死重投毒丸)。
      this.logger.error(
        `malformed ${ANCHOR_CREATED_EVENT} data, skipped: ${JSON.stringify(delivery.data)}`,
      );
      return;
    }

    // 入队失败**不 catch** —— 交回 relay 重投 (见类注释的失败分类表)。
    await this.syncQueue.enqueueColdStart({ anchorId, ticker });
  }
}
