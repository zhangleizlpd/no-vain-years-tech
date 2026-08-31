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

    // 🚨 **读必须排在写前面**。同一个 `$transaction` 数组里的操作按序执行 ⇒ 把 findMany 排在
    //    updateMany 之后读到的是**更新后**状态,于是「本次刚驳回的」与「上一轮早就驳回的」
    //    在结果里长得一模一样,后者会被误报成本次成功处置 —— 正是 FR-007 明禁的
    //    「折成一句 ok」。判据只能建立在**前置状态**上。
    const [before, updated] = await this.prisma.$transaction([
      this.prisma.anchorSubmission.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, status: true },
      }),
      // `status: 'PENDING'` 这个谓词**就是**幂等性本身: 重放同一批只影响仍待审的行。
      this.prisma.anchorSubmission.updateMany({
        where: { id: { in: [...ids] }, status: 'PENDING' satisfies AnchorSubmissionStatus },
        data: {
          status: 'REJECTED',
          ...(input.reviewNote === undefined ? {} : { reviewNote: input.reviewNote }),
        },
      }),
    ]);

    // 「本次没被驳回的」= 前置状态不是 PENDING 的(含库里根本没有这个 id)。
    // 人必须知道有行在自己脚下动过 —— 它们多半是在别的设备上、或被 anchor-approve.sh 处置掉的。
    const wasPending = new Set(
      before
        .filter((r) => r.status === ('PENDING' satisfies AnchorSubmissionStatus))
        .map((r) => r.id),
    );
    const skipped = ids.filter((id) => !wasPending.has(id)).map((id) => id.toString());

    // ⚠️ 稳态下 `rejected + skipped.length === ids.length`。并发下另一路可能在本 tx 的读与写
    //    之间把某行翻掉 ⇒ 那一条既不在 skipped 也没被计入 rejected。这是**如实反映**,
    //    不去凑数:凑出来的和会掩盖「有行在你脚下动了」这件本该被看见的事。
    return { rejected: updated.count, skipped };
  }
}
