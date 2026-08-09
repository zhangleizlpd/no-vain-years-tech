import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { isBelowW } from './anchor.rules';
import { buildAnchorChange, toAnchorSnapshot } from './anchor-history';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  shanghaiDateOnly,
  toAnchorWriteResult,
  toUtcDateOnly,
  type AnchorRow,
  type AnchorWriteResult,
} from './create-anchor.usecase';

/**
 * 045 US1 — 复审动作 + 逾期 / 复核锚红标语义 (FR-004 / FR-007 / FR-013, plan D14a-3)。
 *
 * 🚨 **FR-013 单一解除动作**: 「复核锚红标」的解除方式**只有**「完成一次定期复审」这一个动作。
 * 系统 MUST NOT 引入独立于定期复审的第二个确认动作 / 确认状态 —— 两者语义完全重叠 (都是
 * 「重新确认估值仍成立」), 只是触发源一个是日历一个是事件 (spec Clarifications 2026-07-31)。
 * 本 usecase 因此**只写两列** `next_review` + `last_reviewed_on`, 无第三个「已确认」标志位。
 *
 * 红标一律是**提醒语义**: 亮着不拦截任何操作、不阻断跳转、不影响该行其余数据的呈现
 * (逾期红标见 FR-004; 复核锚红标见 FR-013)。
 *
 * 🚨 **复审 MUST NOT 清空 `breach_started_on`**: 起点是「本轮跌破」的身份, 清了会被雷达状态机
 * (T013) 在下一次判定时按「新一轮」重置成当日 ⇒ 刚复审完红标立刻重新亮。正确解除路径是把
 * `last_reviewed_on` 推到 **≥ 起点**, 令判据 `最近复审 < 本轮起点` 失配 (见
 * {@link isAnchorReviewFlagOn})。起点只由「spot 回到 W 上方」清空 (FR-013, T013 的活)。
 *
 * 🚨 **复审不改估值**: 不碰 `v` / `confidence` / 人工位 —— 复审 = 确认「估值仍成立」, 要改值走
 * `update-anchor.usecase.ts` (那条路径自带两级链回落语义, 复审不该顺带触发回落)。
 *
 * `source` **硬编码 `manual`** (不像 create/update/delete 那样可传): 模型跑一遍不构成人的确认
 * (FR-035 明令 import MUST NOT 重置 `next_review` / 解除逾期红标) ⇒ 本动作没有 model 变体。
 *
 * 并发: 单行状态转换走 conditional `updateMany` + affected-count (READ COMMITTED),
 * count === 0 ⇒ 读写窗内被并发删除 → 与不存在同折叠 404。**禁** `FOR UPDATE` / Serializable。
 */

/** {@link isAnchorReviewFlagOn} 入参 —— 锚行上参与红标判定的四列 (贫血, 无 Domain Class)。 */
export interface AnchorReviewFlagInput {
  /** 生效 V (= COALESCE(v_manual, v), 由调用方解算, 与 `anchor.rules.ts` 口径一致)。 */
  v: Prisma.Decimal | string;
  /** spot = 最新未复权收盘价投影; `null` = 行情不可用 (FR-017)。 */
  lastClose: Prisma.Decimal | string | null;
  lastReviewedOn: Date | null;
  /** 本轮跌破首次观测日; `null` = 当前不在跌破轮次内。 */
  breachStartedOn: Date | null;
}

/**
 * FR-004 逾期判据: `next_review < 今日`。`null` = 未设复审日 ⇒ 不逾期 (列可空, FR-001)。
 *
 * ⚠️ 与 `create-anchor.usecase.ts` 的 `isOverdueAgainstAsof` 是**两回事**: 那条是 EC-10
 * 「建锚即逾期」(比 `asof`, 录入时点的自洽性), 本条是日历逾期 (比今日, 待复审清单的判据)。
 * 两列都取 `@db.Date` UTC 日界比较, 避免本地时区把「今天」滑成前后一天。
 *
 * 🚨 `today` **MUST 是 {@link shanghaiDateOnly} 求出的用户所在地日期**, MUST NOT 直接传
 * `new Date()` —— 后者会被下面的 `toUtcDateOnly` 折成 **UTC 今天**, 境内 08:00 前慢一天,
 * 于是该红的锚不红 (归属判据见 `cross-timezone-date-semantics.md` §3)。传已归一的值时
 * `toUtcDateOnly` 是幂等的, 保留它只作防御。
 */
export function isAnchorOverdue(nextReview: Date | null, today: Date): boolean {
  if (nextReview === null) return false;
  return toUtcDateOnly(nextReview).getTime() < toUtcDateOnly(today).getTime();
}

/**
 * FR-013 复核锚红标: `spot < W ∧ 最近复审日期 < 本轮跌破首次观测日`。
 *
 * 三条边角一并在此单点定义 (雷达读端 T013 与锚读侧 T010 共用同一判据, 不各写各的):
 *
 * 1. **行情不可用** (`lastClose === null`): 「既不推进也不清空本轮起点, 红标维持上一次可判定
 *    的状态」(state_branch) —— `breach_started_on` 非空恰好就是「上一次可判定时 spot 在 W 下」
 *    的持久化证据, 故此时用它代替 spot 比较, 而不是把红标灭掉 (灭掉 = 行情一断红标全清)。
 * 2. **不在跌破轮次内** (`breach_started_on === null`): 红标不亮 —— 即便 spot 刚跌破, 起点也
 *    要等雷达状态机落列后才算「本轮」(建锚时已在 W 下则起点 = 建锚当日)。
 * 3. **从未复审** (`last_reviewed_on === null`): 视为早于任何起点 ⇒ 红标亮。建锚当日会回填
 *    该列 (create-anchor), 故实际只有历史数据才会走到这支。
 *
 * 边界: 「最近复审 **<** 起点」⇒ 同日复审 (复审日 = 起点日) 即解除, 与 `isBelowW` 的
 * 「`spot < W`, 恰好等于不算跌破」同为「取同一侧」纪律 (EC-11)。O(1)。
 */
export function isAnchorReviewFlagOn(input: AnchorReviewFlagInput): boolean {
  if (input.breachStartedOn === null) return false;
  const belowW = input.lastClose === null ? true : isBelowW(input.v, input.lastClose);
  if (!belowW) return false;
  if (input.lastReviewedOn === null) return true;
  return (
    toUtcDateOnly(input.lastReviewedOn).getTime() < toUtcDateOnly(input.breachStartedOn).getTime()
  );
}

@Injectable()
export class ReviewAnchorUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 完成一次定期复审: 推进 `next_review` + 把 `last_reviewed_on` 回填当日。
   *
   * @param nextReview 复审结果推进后的下次复审日; 显式 `null` = 本次不再排下次复审 (列可空)。
   *   **无默认复审周期** —— 策略 SoT 未定义周期档, 自造一个 (「+3 个月」之类) 即违反 FR-030
   *   「代码内零自造参数」, 故由调用方给出。
   */
  async execute(anchorId: bigint, nextReview: Date | null): Promise<AnchorWriteResult> {
    const existing = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as AnchorRow | null;
    if (existing === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }

    // 键集封闭是本动作的核心契约 (FR-013 单一动作 / FR-007 复审只推进日期):
    // 无第三个确认标志位, 且 breach_started_on / v / confidence / 人工位一概不碰。
    const data: Prisma.AnchorUpdateManyMutationInput = {
      nextReview,
      lastReviewedOn: shanghaiDateOnly(new Date()),
    };
    const change = buildAnchorChange(toAnchorSnapshot(existing), data, 'manual');

    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.anchor.updateMany({ where: { id: anchorId }, data });
      if (res.count === 0) {
        throw new NotFoundException('ANCHOR_NOT_FOUND');
      }
      // 值没真变 (同日重复复审且下次日期未动) → 不落噪声痕迹行, 与 update 侧同口径。
      if (change !== null) {
        await tx.anchorChange.create({
          data: {
            anchorId,
            changedFields: [...change.changedFields],
            beforeValues: change.beforeValues,
            source: change.source,
          },
        });
      }
      return (await tx.anchor.findUniqueOrThrow({ where: { id: anchorId } })) as AnchorRow;
    });
    // 新鲜度基准在 tx 外取 (只读、与本次写无因果) —— 别把跨 ctx 读拖进写事务。
    return toAnchorWriteResult(
      row,
      await resolveLastClosedSessionForTicker(this.prisma, row.ticker),
    );
  }
}
