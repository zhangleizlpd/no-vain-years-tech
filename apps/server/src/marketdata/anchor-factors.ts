import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import {
  buildFactorEventTerms,
  decideFactor,
  type FactorCorporateAction,
} from './factor-event-terms.rules.js';

/**
 * 复权因子锚定的**数据平面** —— 从四张表取原始行 → 纯函数算条款 → 判定 → upsert。
 *
 * 日常增量 (`DimensionExecutor.anchorNewFactorVersion`) 与全量回填
 * (`rebuildFactorChains`) 共用本函数，保证两条路径对同一事件给出**同一结果**
 * （旧口径下两者窗口不同曾导致同一事件算出 1.0403 vs 2.0373，见 PR #764）。
 *
 * 🚨 **本路径零 vendor 外呼**。旧口径必须拉 vendor 已复权序列来反推跃变，因而受
 * 「拉多长窗口」摆布；换成事件条款法后所有输入都在本地库里（none 日线 + 公司行动 +
 * 股本变动 + 配股），窗口退化为纯粹的「重算哪些事件」的成本参数，不再影响正确性。
 * 附带效果：回填不再受 vendor 限频/熔断约束，也不再需要 backfill pacer。
 */

/** 除权日往前取 bar 的余量（要拿到除权日**前一交易日**，需覆盖长假/停牌）。 */
const PREV_BAR_LOOKBEHIND_DAYS = 30;

export interface FactorAnchorScope {
  instrumentId: bigint;
  /** 只重锚 ≥ 该除权日的事件；null = 全史重锚（回填）。 */
  fromExDate: string | null;
}

export interface FactorAnchorResult {
  /** 落库行数（含 needs_review 的 1 值行 —— 它们也要留痕，不静默丢事件）。 */
  anchored: number;
  /** 其中判定为待审的行数。 */
  needsReview: number;
}

/** YYYY-MM-DD 减 n 天（UTC）。 */
function minusDays(dateStr: string, days: number): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** vendor payload 数值字段 → Decimal。缺失/非数值 → null（不抛，交由判定层降级）。 */
function toDecimalOrNull(raw: unknown): Prisma.Decimal | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Prisma.Decimal(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return new Prisma.Decimal(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 从 vendor `content` 文本里提取**标的交易币种的等值金额**。
 *
 * 理杏仁对外币宣派的港股，结构化 `dividend` 字段只给原币，港币等值写在 `content` 的括号里
 * （prod 实测 933 行币种不符中 844 行有此形态）。不解析它 = 这些标的整段历史不复权。
 *
 * 已实证的形态（括号可能是全角）：
 *   `末期息CNY 0.11(HKD 0.119708)`                    → 0.119708
 *   `特别股息CNY 2.1366(相当于HKD 2.553)(可选择CNY或HKD)` → 2.553
 *   `中期息AUD 0.5271(HKD 2.9087)(记录日期: 2022/09/06)`  → 2.9087
 *   `末期息每10股CNY 2.2(每10股HKD 2.503)`             → 2.503 / 10 = 0.2503
 *
 * 🚨 **`每N股` 必须归一**：vendor 的结构化 `dividend` 字段已按每股给（`每10股CNY 2.2` →
 * `0.22`），括号里的等值却保持「每 N 股」口径。不除以 N 会**放大 10 倍**，比不换算更危险。
 *
 * 只认「同一括号内既有币种代码又有数字」的组；`(可选择CNY或HKD)` 无数字、`(相当于CNY 0.04)`
 * 币种不符 —— 都不匹配，安全落空（该行退回 needs_review，不猜）。
 */
export function parseCurrencyEquivalent(content: string, currency: string): Prisma.Decimal | null {
  if (!content || !currency) return null;
  const groups = content.match(/[（(][^）)]*[）)]/g);
  if (!groups) return null;
  for (const g of groups) {
    const amount = new RegExp(`${currency}\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(g);
    if (!amount) continue;
    const per = /每\s*([\d,]+)\s*股/.exec(g);
    const divisor = per ? Number(per[1].replace(/,/g, '')) : 1;
    if (!Number.isFinite(divisor) || divisor <= 0) continue;
    try {
      const v = new Prisma.Decimal(amount[1]).div(divisor);
      if (v.isFinite() && v.greaterThan(0)) return v;
    } catch {
      /* 数字形态异常 → 跳过该组, 继续找下一组 */
    }
  }
  return null;
}

/**
 * vendor payload → 现金派息 + 送转股比条款。
 *
 * 派息优先取与标的交易币种一致的金额；币种不符时回退解析 `content` 里的等值（见
 * `parseCurrencyEquivalent`），仍拿不到才置 null（由判定层降级为 needs_review）。
 */
function toCorporateActionTerms(
  exDate: Date,
  payload: unknown,
  instrumentCurrency: string,
): FactorCorporateAction {
  const p = (payload ?? {}) as Record<string, unknown>;
  // 送转股 = 利润送股 + 公积金转增（理杏仁按**每股**下发）。两个都是 A 股字段，港股不下发
  // → null，份额项改走 EquityChange。二者任一有值即视为有送转（另一个缺失按 0）。
  const fromProfit = toDecimalOrNull(p.bonusSharesFromProfit);
  const fromReserve = toDecimalOrNull(p.bonusSharesFromCapitalReserve);
  const bonusShares =
    fromProfit === null && fromReserve === null
      ? null
      : (fromProfit ?? new Prisma.Decimal(0)).plus(fromReserve ?? new Prisma.Decimal(0));

  const rawCurrency = typeof p.currency === 'string' ? p.currency : null;
  let dividend = toDecimalOrNull(p.dividend);
  let currency = rawCurrency;
  if (dividend !== null && rawCurrency !== instrumentCurrency) {
    const equiv = parseCurrencyEquivalent(String(p.content ?? ''), instrumentCurrency);
    // 解析成功 → 改用等值并把币种标成交易币种（下游守卫随之放行）；失败 → 保持原币,
    // 守卫会把它吞成 null → needs_review, 不按错币种硬算。
    if (equiv !== null) {
      dividend = equiv;
      currency = instrumentCurrency;
    }
  }

  return { exDate: dateOnly(exDate), dividend, bonusShares, currency };
}

/**
 * 同一 exDate 多行 corporate_action → 取权威那行（确定性）。
 *
 * adapter 已按 exDate 聚合，正常每个除权日只有一行。但聚合后 `type` 可能翻转
 * （某日同时有派息与送股 → 整个事件判 `split`），而自然键含 `type` ⇒ upsert 打到新键、
 * **旧 type 的行成为孤儿留在库里**。prod 实测 1 例（cn 600188 `2023-07-17`：陈旧
 * `dividend` 派息 1.23 与新 `split` 派息 4.30 并存）。
 *
 * 🚨 不加这层选择时，`buildFactorEventTerms` 的 `new Map([[exDate, c]])` 是**后写覆盖**，
 * 取哪行取决于 `findMany` 的返回顺序（未指定 `orderBy`）—— 同一份数据可能算出两个不同因子。
 * 判据用「payload 是否带 `rows`」而非「金额谁大」：前者是「本轮 adapter 产出」的确定标记，
 * 后者在 vendor 下调金额时会选错。两行都带/都不带 → 退回按 `id` 取大（后写的那行）。
 */
export function pickPerExDate<T extends { exDate: Date; payload: unknown; id?: bigint }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = dateOnly(r.exDate);
    const cur = best.get(key);
    if (cur === undefined) {
      best.set(key, r);
      continue;
    }
    const rAgg = isAggregated(r.payload);
    const curAgg = isAggregated(cur.payload);
    if (rAgg !== curAgg) {
      if (rAgg) best.set(key, r);
    } else if ((r.id ?? 0n) > (cur.id ?? 0n)) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

/** 本轮 adapter 产出的聚合行标记（`payload.rows` = 原始 vendor 行数组）。 */
function isAggregated(payload: unknown): boolean {
  return Array.isArray((payload as Record<string, unknown> | null)?.rows);
}

/**
 * 对单个标的重锚复权因子。
 *
 * `fromExDate` 之前的既有因子行**原样保留**（本函数只 upsert 判定出的事件，不删不改其余）。
 * 复杂度 O(b + m log m)（b = 窗内 bar 数，m = 事件数）；4 次索引查询 + 每事件 1 次 upsert。
 */
export async function anchorFactorsForInstrument(
  prisma: PrismaService,
  scope: FactorAnchorScope,
  logger?: Logger,
): Promise<FactorAnchorResult> {
  const barFloor = scope.fromExDate
    ? minusDays(scope.fromExDate, PREV_BAR_LOOKBEHIND_DAYS)
    : undefined;
  const exFloor = scope.fromExDate ? new Date(`${scope.fromExDate}T00:00:00Z`) : undefined;

  // 交易币种就近自取, 不把 currency 加进共享 WorkingInstrument —— 那会让全部执行器的
  // 工作集查询都多带一列, 为一条路径的需要放大波及面。
  const [inst, noneRows, caRows, ecRows, alRows] = await Promise.all([
    prisma.instrument.findUnique({
      where: { id: scope.instrumentId },
      select: { currency: true },
    }),
    prisma.dailyBar.findMany({
      where: {
        instrumentId: scope.instrumentId,
        adjust: 'none',
        ...(barFloor ? { tradeDate: { gte: barFloor } } : {}),
      },
      select: { tradeDate: true, close: true, changePct: true },
      orderBy: { tradeDate: 'asc' },
    }),
    prisma.corporateAction.findMany({
      where: {
        instrumentId: scope.instrumentId,
        ...(exFloor ? { exDate: { gte: exFloor } } : {}),
      },
      select: { id: true, exDate: true, payload: true },
    }),
    // 股本变动**不按 fromExDate 收窄**: R 需要「事件前最近一条 capitalization」作分母,
    // 收窄会把那条基准挡在窗外 → R 恒算不出。单标的 ~103 行 (prod 285,873/2,782), 全取无压力。
    prisma.equityChange.findMany({
      where: { instrumentId: scope.instrumentId },
      select: { date: true, capitalization: true, changeReason: true },
      orderBy: { date: 'asc' },
    }),
    prisma.allotmentEvent.findMany({
      where: {
        instrumentId: scope.instrumentId,
        ...(exFloor ? { exDate: { gte: exFloor } } : {}),
      },
      select: { exDate: true, allotmentRatio: true, allotmentPrice: true, currency: true },
    }),
  ]);

  if (!inst) return { anchored: 0, needsReview: 0 }; // 标的已删 → 无事可锚 (不抛)。

  const terms = buildFactorEventTerms({
    currency: inst.currency,
    noneBars: noneRows.map((b) => ({
      tradeDate: dateOnly(b.tradeDate),
      close: b.close,
      changePct: b.changePct,
    })),
    corporateActions: pickPerExDate(caRows).map((c) =>
      toCorporateActionTerms(c.exDate, c.payload, inst.currency),
    ),
    equityChanges: ecRows.map((e) => ({
      date: dateOnly(e.date),
      capitalization: e.capitalization,
      changeReason: e.changeReason,
    })),
    allotments: alRows.map((a) => ({
      exDate: a.exDate ? dateOnly(a.exDate) : null,
      allotmentRatio: a.allotmentRatio,
      allotmentPrice: a.allotmentPrice,
      currency: a.currency,
    })),
  });

  let anchored = 0;
  let needsReview = 0;
  for (const t of terms) {
    const decision = decideFactor(t);
    await prisma.adjustmentFactor.upsert({
      where: {
        instrumentId_exDate: {
          instrumentId: scope.instrumentId,
          exDate: new Date(`${decision.exDate}T00:00:00Z`),
        },
      },
      create: {
        instrumentId: scope.instrumentId,
        exDate: new Date(`${decision.exDate}T00:00:00Z`),
        factorBackward: decision.factorJump,
        source: decision.source,
        status: decision.status,
      },
      update: {
        factorBackward: decision.factorJump,
        source: decision.source,
        status: decision.status,
      },
    });
    anchored++;
    if (decision.status === 'needs_review') {
      needsReview++;
      // 待审逐条留痕: 质量闸只给计数, 定位要靠这里的 reason (哪个事件、两法各算出什么)。
      logger?.warn(
        `factor needs_review: ${JSON.stringify({
          instrumentId: String(scope.instrumentId),
          exDate: decision.exDate,
          reason: decision.reason,
        })}`,
      );
    }
  }
  return { anchored, needsReview };
}
