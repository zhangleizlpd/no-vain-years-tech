import type { PrismaService } from '../security/prisma.service';
import {
  MONTHLY_EXPIRY_LOOKBACK_DAYS,
  monthlyExpiryCandidates,
  resolveMonthlyExpiries,
} from './leg-mark.rules';

/**
 * 月度到期日查询 —— 判据在 `leg-mark.rules.ts` 的两个纯函数里, 本文件只管**取那段日历**。
 *
 * 🚨 **055 起有两个消费方** (选约表逐腿打标 / 报表逐列打标) ⇒ 从 `get-legs.usecase.ts` 的私有
 * 方法提到这里, 🚫 **MUST NOT 各查一份**: 两处各写一次窗口计算, 窗口不同步时**两边都查得出
 * 日历、都标得出月度链**, 只是同一个到期日在两屏上标得不一样。
 *
 * 📌 提的是**查询**不是判据 —— `monthlyExpiryCandidates` / `resolveMonthlyExpiries` 一字未动,
 * 它们本来就是导出的纯函数。
 */

const MS_PER_DAY = 86_400_000;

/** `@db.Date` 的 UTC 午夜 Date → `YYYY-MM-DD`。 */
export function dateOnlyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
export function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

/**
 * 这批到期日里哪些是**月度到期日** (047 FR-014 / FR-015, plan D-MARK-2)。
 *
 * 🚨 **一次查回整段日历, MUST NOT 逐到期日查** (047 Guardrail 7): 链上到期日几十个, 逐个查是
 * 几十次往返。窗口 = `[最早候选日 − MONTHLY_EXPIRY_LOOKBACK_DAYS, 最晚候选日]`, 下界的外扩量
 * 与假日回退的最大距离**是同一个常量** —— 不同步的话会出现「窗口里没查到、回退逻辑却敢用」的缝。
 *
 * 复杂度: 1 次范围查询 (`(market, date)` 唯一键前缀命中) + `O(m log m)` 排序。
 */
export async function readMonthlyExpiries(
  prisma: PrismaService,
  market: string,
  expiryDates: readonly Date[],
): Promise<Set<string>> {
  const candidates = monthlyExpiryCandidates(expiryDates.map(dateOnlyOf));
  // 空链在检索层就已挡下, 这条是纯函数契约的兜底 —— 零候选就别白发一次查询。
  if (candidates.length === 0) return new Set();

  const from = new Date(
    utcMidnight(candidates[0]).getTime() - MONTHLY_EXPIRY_LOOKBACK_DAYS * MS_PER_DAY,
  );
  // CROSS-CONTEXT-READ: marketdata.trading_day 只读直查 (catalog Q7-B) —— 月度到期日的假日回退
  // 判据取自交易日历, 读法同 `last-closed-session.ts`。零写; marketdata 不知道锚表存在 (方向铁律)。
  const days = await prisma.tradingDay.findMany({
    where: { market, date: { gte: from, lte: utcMidnight(candidates[candidates.length - 1]) } },
    select: { date: true },
  });
  return resolveMonthlyExpiries(
    candidates,
    days.map((day) => dateOnlyOf(day.date)),
  );
}
