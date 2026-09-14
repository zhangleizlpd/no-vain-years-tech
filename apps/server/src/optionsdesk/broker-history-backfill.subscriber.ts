import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { marketdataConfig, type MarketdataConfig } from '../config/marketdata.config';
import { OutboxSubscriberRegistry } from '../security/outbox/outbox-subscriber.registry.js';
import type {
  OutboxEventDelivery,
  OutboxSubscriber,
} from '../security/outbox/outbox-subscriber.port.js';
import { PrismaService } from '../security/prisma.service';

/**
 * 主题契约: 建锚事件的 eventType。**本地字面量**, 生产侧定义在 `create-anchor.usecase.ts:236`
 * (publish 在 `:315`), marketdata 冷启动订阅方另持一份 (`anchor-cold-start.subscriber.ts:15`)。
 * 生产侧常量不导出, 三处相等由 IT ⑦ / ⑧ 让真事件穿过 relay 钉住。
 */
const ANCHOR_CREATED_EVENT = 'optionsdesk.anchor-created';

/**
 * 082 新建锚 → 券商历史补齐的 **outbox 消费方** (plan D10; FR-009 / FR-018; state_branches 15, 32)。
 * 形态照 `marketdata/anchor-cold-start.subscriber.ts`: 同一事件在 registry 里挂两个订阅方, 互不感知。
 *
 * 🚨 **只插待执行记录, 绝不在这里跑补齐。** relay 是全 ctx 共用的单线 cron, 一次全量历史补齐是
 * 分钟级的券商调用 ⇒ 同步跑会顶住所有 ctx 的事件。执行归调度器 (`broker-account.scheduler.ts`, D9)。
 *
 * 🚨 **`nextAttemptAt` 必须写 `now`**: 调度器只认领 `pending ∧ nextAttemptAt ≤ now`, 为 null 的记录
 * 永远不会被执行, 且不报错。窗口列留空 = 调度器按 `'all-history'` 执行; `target` 直接用锚 ticker
 * (本就是 `us:` / `hk:` canonical 形态)。
 *
 * ## 两类失败处置方向相反 (同冷启动订阅方)
 *
 * | 失败 | 处置 | 为什么 |
 * |---|---|---|
 * | 载荷缺 `ticker` / 非字符串 (毒丸) | `logger.error` + return, **不抛** | 抛了 relay 每轮重投同一条, 永久卡死 |
 * | DB 写失败 | **不捕获**, 抛回 relay | 下轮重投正是正确处置; 吞掉 = 事件标 published 而补齐永远丢失 |
 *
 * ## 幂等
 *
 * relay at-least-once ⇒ 同一事件可能重投。唯一键 `(connection_id, source_event_id)` (T010 迁移) +
 * 一条 `createMany({ skipDuplicates })` 原子吸收: 🚫 先查后写 (并发重投时两边都查不到), 🚫 靠捕获
 * `P2002` (那是事务外的第二处判据)。键里必须带连接: 只按事件 ID, 多连接时第二个连接的记录会被静默挡掉。
 */
@Injectable()
export class BrokerHistoryBackfillSubscriber implements OutboxSubscriber, OnModuleInit {
  private readonly logger = new Logger(BrokerHistoryBackfillSubscriber.name);
  readonly eventType = ANCHOR_CREATED_EVENT;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OutboxSubscriberRegistry,
    @Inject(marketdataConfig.KEY) private readonly marketdata: MarketdataConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** 复杂度: 一次读连接表 + 一条批量插入, O(连接数)。 */
  async handle(delivery: OutboxEventDelivery): Promise<void> {
    // FR-018 / branch 32: 开发环境不造任何券商数据, 待执行记录也不插。
    if (this.marketdata.kind === 'mock') return;

    const { ticker } = delivery.data;
    if (typeof ticker !== 'string' || ticker === '') {
      this.logger.error(
        `malformed ${ANCHOR_CREATED_EVENT} data, skipped: event=${delivery.sourceEventId} data=${JSON.stringify(delivery.data)}`,
      );
      return;
    }

    const connections = await this.prisma.brokerConnection.findMany({
      select: { id: true, accountId: true },
      orderBy: { id: 'asc' },
    });
    if (connections.length === 0) return;

    const now = new Date();
    const { count } = await this.prisma.brokerSyncRun.createMany({
      data: connections.map((c) => ({
        accountId: c.accountId,
        connectionId: c.id,
        kind: 'backfill',
        status: 'pending',
        target: ticker,
        sourceEventId: delivery.sourceEventId,
        nextAttemptAt: now,
      })),
      skipDuplicates: true,
    });
    // 🚫 不带 accountId (D12): 只记条数与事件 ID。
    this.logger.log(
      `补齐待执行 +${count}/${connections.length} target=${ticker} event=${delivery.sourceEventId}`,
    );
  }
}
