import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { LEASE_SECONDS } from './agent-queue.constants.js';

/**
 * P1.4 ack: 心跳续租。worker 处理长任务时定期 ack, 把租约往后推, 防租约到期被误判
 * 丢失而重投递。仅 `status='claimed'` 可续 (pending/done/failed 不可)。租约用 DB now()
 * 计算 (与 claim 同源, 避免应用/DB 时钟漂移)。
 *
 * 返回新租约到期; 事件不存在 / 非 claimed → null (controller 404)。
 */
@Injectable()
export class ExtendLeaseUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(eventId: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ lease_expires_at: Date }[]>`
      UPDATE "agent_queue_event"
      SET lease_expires_at = now() + ${LEASE_SECONDS} * interval '1 second',
          updated_at = now()
      WHERE id = ${eventId}::uuid AND status = 'claimed'
      RETURNING lease_expires_at;
    `;
    return rows[0]?.lease_expires_at ?? null;
  }
}
