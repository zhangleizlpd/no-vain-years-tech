import { Prisma } from '../generated/prisma/client';

/**
 * 082 持仓**开仓时间**推算纯函数 (plan D8; FR-016)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 🚨 口径是**持仓起点**, 不是 FIFO 批次: 按时间顺序累计带符号成交数量, 最后一次「由 0 变非 0」
 * 或「正负翻转」那一笔的成交时间即起点。加仓 / 部分平仓不移动起点; 清仓后重开、多翻空移动起点。
 * 推算净量与券商报告的持仓数量不一致 (拆股、转入转出等成交记录看不见的变化) 或无成交 ⇒
 * 回落首次发现时间, 并标 `fallback` —— 不存在无来源的开仓时间。
 *
 * 数量一律 `Prisma.Decimal` 精确比较 (沿 optionsdesk rules 既有纪律)。期权数量两侧同为「张」
 * (plan D8, POC-1 ③)。
 */

export type BrokerTradeSide = 'BUY' | 'BUY_BACK' | 'SELL' | 'SELL_SHORT';

export interface OpenedAtDeal {
  /** 券商成交号。同一时刻多笔按它排序 (纯数字串按数值)。 */
  dealId: string;
  tradedAt: Date;
  side: BrokerTradeSide;
  /**
   * 成交数量, 方向由 `side` 给出, 本函数取绝对值。
   * EVIDENCE: 成交行 `qty` 恒非负、`deal_id` 全为数字 —— 082 POC-1 原始输出 (2026-09-13) 成交 244 行:
   * `qty < 0` 0 行, `deal_id` 非数字 0 行。
   */
  qty: Prisma.Decimal;
}

export interface OpenedAtInput {
  /** 该持仓合约的库内成交, 顺序不限。 */
  deals: readonly OpenedAtDeal[];
  /**
   * 券商报告的持仓数量, **带符号** (空头为负)。
   * EVIDENCE: 082 POC-1 原始输出 (2026-09-13) `position_side = SHORT` 的持仓 17/17 行 `qty < 0`。
   */
  positionQty: Prisma.Decimal;
  firstSeenAt: Date;
}

export interface OpenedAtResult {
  openedAt: Date;
  source: 'derived' | 'fallback';
}

/** 买入类记正、卖出类记负。 */
const SIDE_SIGN: Readonly<Record<BrokerTradeSide, 1 | -1>> = {
  BUY: 1,
  BUY_BACK: 1,
  SELL: -1,
  SELL_SHORT: -1,
};

const DIGITS_RE = /^\d+$/;

/** 成交号比较: 两侧都是纯数字串且位数不同 ⇒ 位数少的在前 (`'9' < '10'`); 否则字典序。 */
function compareDealIds(a: string, b: string): number {
  if (a.length !== b.length && DIGITS_RE.test(a) && DIGITS_RE.test(b)) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDeals(a: OpenedAtDeal, b: OpenedAtDeal): number {
  return a.tradedAt.getTime() - b.tradedAt.getTime() || compareDealIds(a.dealId, b.dealId);
}

/**
 * 推算开仓时间。复杂度 O(n log n): 排序 O(n log n) + 单次累计 O(n)。入参不被原地修改。
 */
export function resolveOpenedAt({
  deals,
  positionQty,
  firstSeenAt,
}: OpenedAtInput): OpenedAtResult {
  const sorted = [...deals].sort(compareDeals);

  let net = new Prisma.Decimal(0);
  let openedAt: Date | null = null;
  for (const deal of sorted) {
    const prev = net;
    net = net.plus(deal.qty.abs().times(SIDE_SIGN[deal.side]));
    if (net.isZero()) {
      // 平到 0 ⇒ 这段持仓结束; 若之后没有再开, 就没有起点可言。
      openedAt = null;
    } else if (prev.isZero() || prev.isNegative() !== net.isNegative()) {
      // 0 → 非 0 (开仓) 或正负翻转 (多翻空 / 空翻多) ⇒ 新的持仓起点。
      openedAt = deal.tradedAt;
    }
  }

  if (openedAt === null || !net.equals(positionQty)) {
    return { openedAt: firstSeenAt, source: 'fallback' };
  }
  return { openedAt, source: 'derived' };
}
