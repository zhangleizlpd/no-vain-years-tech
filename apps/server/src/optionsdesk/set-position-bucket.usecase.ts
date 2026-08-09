import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import {
  resolvePositionBucket,
  type PositionBucket,
  type PositionBucketProvenance,
} from './intent-matrix.rules';

/**
 * 047 US3 — 仓位水位档手选写端点 (FR-017, plan D-UI-5)。
 *
 * 水位档在本片**没有数据面** (持仓规模属 M3/M4), 意图矩阵却拿它当第三个输入 ⇒ 用一个三选一手选
 * 控件补齐。与 v1「现金手工录入」同形态的**降级路径**, 不是终态。
 *
 * 🚨 **「人工输入」语义落在契约层, 不靠前端记得**: 写端回的是 {@link resolvePositionBucket} 的
 * 三元组 (档位 + 来源标 + 设置时刻), 读端 (`get-legs.usecase.ts`) 回的是**同一个函数**的输出 ——
 * M3 持仓数据到位后同一字段开始混进真实水位, 靠来源标即可分辨哪些是人填的 (FR-017)。
 *
 * 🚨 **未选态 (`null`) 是常驻分支不是过渡态**, 且**无默认值**: 新建锚的票天然处于未选, 此时意图
 * 判「待定」、三个 Tab 仍全部可取数。本端点只做「选」这一个动作 —— 没有「清空」路径, 因为
 * 「替人挑一档」与「替人撤一档」同属 FR-017 明禁的方向性假设, 而未选是初始态、不是可达动作。
 *
 * 🚨 **蓄意不落 `anchor_change` 痕迹**: 痕迹表是 045 的**估值口径** PIT 机制 (SC-011 还原的是
 * V / W / L 层 / 单票上限 / 愿卖锚), 水位档不在其中; 且本列自带 `position_bucket_set_at` ——
 * 那正是为它设计的来源新鲜度证据 (schema 注释: 「M3 迁移时用它判断人填值的新鲜度」)。把它塞进
 * 痕迹会让 PIT 回放多出一个不参与派生的字段, 与 `last_close` 不进痕迹是同一条纪律。
 *
 * 并发: 单行写走 conditional `updateMany` + affected-count (READ COMMITTED), count === 0 ⇒
 * 读写窗内被并发删除 → 与不存在同折叠 404。**禁** `FOR UPDATE` / Serializable。
 */

export interface PositionBucketWriteResult extends PositionBucketProvenance {
  anchorId: bigint;
  /** canonical `market:code` —— 客户端据此让选约表那一屏失效重取。 */
  ticker: string;
}

@Injectable()
export class SetPositionBucketUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 手选一次水位档 (覆盖式)。
   *
   * @param positionBucket 三选一档位。值域收窄由 DTO 的 `@IsIn(POSITION_BUCKETS)` 在通道层完成
   *   (非法值 400), 本函数只接已收窄的类型 —— **不在此重复一遍字面量**。
   * @param now 设置时刻 (注入以便测试钉住基准)。
   *
   * 🚨 **重复设置同一档也 MUST 推进 `position_bucket_set_at`** —— 这里蓄意**不**照抄
   * `review-anchor.usecase.ts` 的「值没真变就不落痕迹」: 那条是为了不刷噪声痕迹行, 而本列的时刻
   * 记的是「人最后一次确认水位是什么时候」, 再确认一次就是一次新的人工输入, 时刻不前进等于把
   * M3 要用的新鲜度判据变成谎话。
   */
  async execute(
    anchorId: bigint,
    positionBucket: PositionBucket,
    now: Date = new Date(),
  ): Promise<PositionBucketWriteResult> {
    const existing = await this.prisma.anchor.findUnique({
      where: { id: anchorId },
      select: { ticker: true },
    });
    if (existing === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }

    const res = await this.prisma.anchor.updateMany({
      where: { id: anchorId },
      data: { positionBucketManual: positionBucket, positionBucketSetAt: now },
    });
    if (res.count === 0) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }

    // 走读端同一个投影函数, 而不是手拼 `source: 'manual'` —— 两处各写一份就是漂移的起点。
    return { anchorId, ticker: existing.ticker, ...resolvePositionBucket(positionBucket, now) };
  }
}
