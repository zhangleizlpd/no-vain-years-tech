import type { Prisma } from '../generated/prisma/client';
import { daysToExpiry } from '../marketdata/trading-day-gate';
import type { BrokerMarket } from './broker-code.rules';

/**
 * 083 交易账户页**持仓列表展示**纯函数: 过滤 + 分组 + 组值 + 全序排序 + 到期判定
 * (plan D3–D6; FR-001 / FR-003 / FR-004 / FR-005 / FR-006 / FR-011 / FR-021)。
 * 无 I/O、无 DI (ADR-0043 §4)。
 *
 * 🚨 **🚫 复用 `broker-scope.rules.ts` 的 `inBrokerScope`**: 它对未解析行恒返回 true (同步侧
 * 「不丢弃」语义), 展示侧语义相反 —— 未解析行只计数不展示; 且展示恒按「只锚标的」, 与
 * `BROKER_SYNC_SCOPE` 无关 (plan D3)。
 *
 * 金额一律 `Prisma.Decimal` (沿 optionsdesk rules 既有纪律); 组头行数阈值、名称拼接等展示判定
 * 在 mobile 规则函数, 不在这里。
 */

/** 展示所需的最小行形状; 调用方的行可带更多字段, 原样透传。 */
export interface PositionDisplayRow {
  /** 持仓行 db id —— 组内全序的兜底键。 */
  id: bigint;
  market: BrokerMarket;
  /** 券商原始代码。 */
  code: string;
  /** 判定出的正股 ticker; 未解析 ⇒ `null`。 */
  underlyingTicker: string | null;
  /** 连接的人读标签 (🚫 用 `brokerCode` —— 同券商两个连接会完全相同)。 */
  connectionLabel: string;
  /** 期权才有 (`expiry` 为交易所当地 `YYYY-MM-DD`); 正股 ⇒ `null`。 */
  option: { expiry: string } | null;
  marketValue: Prisma.Decimal | null;
  unrealizedPl: Prisma.Decimal | null;
  currentPrice: Prisma.Decimal | null;
  openedAt: Date | null;
}

export type DisplayedPositionRow<R extends PositionDisplayRow> = R & { expired: boolean };

export interface PositionGroup<R extends PositionDisplayRow> {
  underlyingTicker: string;
  /** 组内排序第一的正股行现价; 无正股 ⇒ 锚现价; 仍无 ⇒ `null` (plan D5)。 */
  underlyingPrice: Prisma.Decimal | null;
  /** 组内非空市值带符号求和; 全空 ⇒ `null`。 */
  groupMarketValue: Prisma.Decimal | null;
  /** 组内非空持仓盈亏带符号求和; 全空 ⇒ `null`。 */
  groupUnrealizedPl: Prisma.Decimal | null;
  rows: DisplayedPositionRow<R>[];
}

export interface BuildPositionGroupsInput<R extends PositionDisplayRow> {
  /** 该账号该市场的全部持仓行, 顺序不限。 */
  rows: readonly R[];
  /** 锚表全部行 (含 `excluded`) 的 ticker 集合。 */
  anchoredTickers: ReadonlySet<string>;
  /** ticker → 锚现价 (`resolveAnchorSpot(...).price`); 缺键同 `null`。 */
  anchorSpots: ReadonlyMap<string, Prisma.Decimal | null>;
  now: Date;
}

export interface PositionGroupsResult<R extends PositionDisplayRow> {
  /** 未解析正股的持仓条数 (不展示, 由 mobile 出提示)。 */
  unresolvedCount: number;
  groups: PositionGroup<R>[];
}

/**
 * 持仓行 → 展示分组。入参不被原地修改。
 *
 * - 过滤: `underlyingTicker === null` ⇒ 计入 `unresolvedCount`; ∉ 锚集 ⇒ 丢弃。
 * - 分组键 `underlyingTicker`; 多连接各自成行, 不合并。
 * - 组内: 正股段在前、期权段在后; 段内 `openedAt` 升序 (null 段尾) → `code` → `connectionLabel` → `id`。
 * - 跨组: `|groupMarketValue|` 降序 (null 排末, 0 按 0 排) → ticker 升序。
 * - 每行附 `expired`: 期权 `daysToExpiry < 0` (基准 = 该行市场的交易所今天, 到期日当天不算); 正股恒 false。
 *
 * 复杂度 O(n log n): 过滤与分组单次扫描 O(n), 组内排序合计 O(n log n), 跨组排序 O(g log g) (g ≤ n)。
 */
export function buildPositionGroups<R extends PositionDisplayRow>({
  rows,
  anchoredTickers,
  anchorSpots,
  now,
}: BuildPositionGroupsInput<R>): PositionGroupsResult<R> {
  let unresolvedCount = 0;
  const byTicker = new Map<string, DisplayedPositionRow<R>[]>();
  for (const row of rows) {
    const ticker = row.underlyingTicker;
    if (ticker === null) {
      unresolvedCount += 1;
      continue;
    }
    if (!anchoredTickers.has(ticker)) continue;
    const displayed: DisplayedPositionRow<R> = { ...row, expired: isExpired(row, now) };
    const bucket = byTicker.get(ticker);
    if (bucket === undefined) byTicker.set(ticker, [displayed]);
    else bucket.push(displayed);
  }

  const groups: PositionGroup<R>[] = [];
  for (const [ticker, groupRows] of byTicker) {
    groupRows.sort(compareRowsInGroup);
    const firstStock = groupRows.find((r) => r.option === null);
    groups.push({
      underlyingTicker: ticker,
      underlyingPrice:
        firstStock !== undefined ? firstStock.currentPrice : (anchorSpots.get(ticker) ?? null),
      groupMarketValue: signedSum(groupRows.map((r) => r.marketValue)),
      groupUnrealizedPl: signedSum(groupRows.map((r) => r.unrealizedPl)),
      rows: groupRows,
    });
  }
  groups.sort(compareGroups);
  return { unresolvedCount, groups };
}

/**
 * 到期判定只用 `daysToExpiry` (交易所今天为基准) —— 🚫 北京日期: 北京凌晨 = 美东前一天,
 * 按北京日期会把「今天到期、仍可交易」的美股合约提前标成已到期。导出给持仓详情读端 (与列表同口径)。
 */
export function isExpired(row: PositionDisplayRow, now: Date): boolean {
  if (row.option === null) return false;
  return daysToExpiry({ expiry: row.option.expiry, now, exchange: row.market }) < 0;
}

function signedSum(values: readonly (Prisma.Decimal | null)[]): Prisma.Decimal | null {
  let sum: Prisma.Decimal | null = null;
  for (const v of values) {
    if (v !== null) sum = sum === null ? v : sum.plus(v);
  }
  return sum;
}

/** 按码元比较 —— 不用 `localeCompare`, 结果与运行环境 locale 无关。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 升序, `null` 排末。 */
function compareOpenedAt(a: Date | null, b: Date | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

function compareRowsInGroup(a: PositionDisplayRow, b: PositionDisplayRow): number {
  const segment = (a.option === null ? 0 : 1) - (b.option === null ? 0 : 1);
  if (segment !== 0) return segment;
  return (
    compareOpenedAt(a.openedAt, b.openedAt) ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.connectionLabel, b.connectionLabel) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function compareGroups(
  a: PositionGroup<PositionDisplayRow>,
  b: PositionGroup<PositionDisplayRow>,
): number {
  const av = a.groupMarketValue;
  const bv = b.groupMarketValue;
  if (av !== null && bv !== null) {
    const byAbsDesc = bv.abs().comparedTo(av.abs());
    if (byAbsDesc !== 0) return byAbsDesc;
  } else if (av !== null) {
    return -1;
  } else if (bv !== null) {
    return 1;
  }
  return compareStrings(a.underlyingTicker, b.underlyingTicker);
}
