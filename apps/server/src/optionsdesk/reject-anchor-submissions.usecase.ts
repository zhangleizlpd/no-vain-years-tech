import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { AnchorSubmissionStatus } from './anchor-import.rules';

/**
 * 072 批量驳回待审估值。**这是仓里 `REJECTED` 的第一个写者** —— 该状态自 059 建表起就在
 * 值域里, 但没有任何代码写过它 (08-31 直查 prod: REJECTED 恒为 0)。
 *
 * 🚨 **为什么驳回可以批量而采纳不行** (别把两者「对称化」):
 * 驳回**零副作用** —— 不写锚、不发 outbox 事件、不打 vendor、不排冷启动。
 * 采纳每一条都有三个副作用, 且每条都要人过一遍 disposition / asof 闸 / 人工位回落预览,
 * 其中冷启动是**分钟级、worker concurrency=1 的真 vendor 外呼**。
 */

export interface RejectAnchorSubmissionsInput {
  ids: readonly bigint[];
  reviewNote?: string;
}

export interface RejectAnchorSubmissionsResult {
  rejected: number;
  /** 未被驳回的 id (已非 PENDING 或不存在) —— **MUST NOT 静默吞掉**, 见下。 */
  skipped: string[];
}

@Injectable()
export class RejectAnchorSubmissionsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(input: RejectAnchorSubmissionsInput): Promise<RejectAnchorSubmissionsResult> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return { rejected: 0, skipped: [] };

    // `status: 'PENDING'` 这个谓词**就是**幂等性本身: 重放同一批只影响仍待审的行。
    const [updated, survivors] = await this.prisma.$transaction([
      this.prisma.anchorSubmission.updateMany({
        where: { id: { in: [...ids] }, status: 'PENDING' satisfies AnchorSubmissionStatus },
        data: {
          status: 'REJECTED',
          ...(input.reviewNote === undefined ? {} : { reviewNote: input.reviewNote }),
        },
      }),
      this.prisma.anchorSubmission.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true },
      }),
    ]);

    // 🚨 **MUST NOT 把「驳回了 7 条里的 5 条」折成一句 ok**: 另两条是在别的设备上、或被
    //    anchor-approve.sh 处置掉了 —— 人必须知道有行在自己脚下动过。
    const found = new Set(survivors.map((r) => r.id));
    const skipped = ids
      .filter((id) => !found.has(id) || survivors.find((r) => r.id === id)?.status !== 'REJECTED')
      .map((id) => id.toString());

    return { rejected: updated.count, skipped };
  }
}
