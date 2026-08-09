import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';

export type CompletionOutcome = 'SUCCESS' | 'FAILURE';

/**
 * P1.4 result: worker 回传终态。`claimed → done` (SUCCESS) / `failed` (FAILURE) + 存产物。
 * 仅 `status='claimed'` 可终态化 (updateMany WHERE status='claimed' = 幂等闸: 重复 result
 * 第二次 count=0 → 404; 也挡未 claim / 已终态的乱序回传)。result JSON 经 Prisma 类型化
 * updateMany 落库 (非 $queryRaw, JSON 落库更地道)。
 *
 * 返回是否命中 (false → controller 404)。
 */
@Injectable()
export class CompleteEventUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    eventId: string,
    outcome: CompletionOutcome,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await this.prisma.agentQueueEvent.updateMany({
      where: { id: eventId, status: 'claimed' },
      data: {
        status: outcome === 'SUCCESS' ? 'done' : 'failed',
        doneAt: new Date(),
        ...(result !== undefined ? { result: result as Prisma.InputJsonValue } : {}),
      },
    });
    return res.count > 0;
  }
}
