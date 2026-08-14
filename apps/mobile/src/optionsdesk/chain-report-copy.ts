// 055 T010 — 报表页头的**合成层**（`FR-031` / `FR-033`, `state_branch` 18/21, plan `D-UI-1`）。
// 体例同 `leg-picker-copy.ts`：字串住 `OPTIONSDESK_COPY.chainReport`，这里只做映射。
//
// 🚨 **IV 读数整份复用 046 的 `ivReadoutView`**（`FR-031` 明令 🚫 不新造读数）——
//    四态判定、「禁回落 0」、分段条要不要画标记全在那一份里，本文件**一个都不重判**。
// 🚨 **三个时点各自成句**（`FR-033`）—— 交易所今天 / 报价 / 持仓量，🚫 MUST NOT 合并成
//    一个「数据截至」：报价与持仓量常态下不同日（美股期权 OI 盘前更新），合并之后
//    「活跃度那一格是哪天的」就永远说不清了，**而页头照样渲染得出来**。
// 🚫 **本屏不碰本地时钟** —— 三个业务日全由 server 下发（`FR-033`），`todayYmd()` 在此无
//    合法用途（跨时区语义见 `docs/conventions/cross-timezone-date-semantics.md`）。
import type { ChainReportGateCountsResponse, ChainReportResponse } from '@nvy/api-client';

import type { ChainReportMetric } from './chain-report-scale.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import { ivReadoutView, type IvReadoutView } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.chainReport;

/** 三个时点各自的槽位。`key` 供测试与 `testID` 定位，🚫 不靠下标认人。 */
export type ChainReportStampKey = 'market_date' | 'quote' | 'open_interest';

export interface ChainReportStamp {
  readonly key: ChainReportStampKey;
  readonly label: string;
  /** 已定标的短日期；缺失 ⇒ 「—」（该条**仍在**，🚫 不静默少一条）。 */
  readonly value: string;
}

export interface ChainReportHeaderView {
  /** IV 分位四态（整份复用 046）。 */
  readonly iv: IvReadoutView;
  /** 现价，`null` = 未下发（🚫 MUST NOT 兜 `0.00`，那是编造一个价格）。 */
  readonly spotText: string | null;
  /** 恒三条，顺序即语义：交易所今天 → 报价 → 持仓量。 */
  readonly stamps: readonly [ChainReportStamp, ChainReportStamp, ChainReportStamp];
  /** 锚 `excluded` ⇒ 标记串；否则 `null`（报表照常渲染，用户是主动进来的）。 */
  readonly excludedNotice: string | null;
}

/** `us:ACN` → `ACN · 链分析`；解析不出 market 前缀时原样回退，🚫 不丢标的身份。`O(1)`。 */
export function chainReportTitle(symbol: string): string {
  return `${symbol.split(':')[1] ?? symbol}${COPY.titleSuffix}`;
}

/** `YYYY-MM-DD` → `MM-DD`（页头版面紧，`FR-041` 一屏预算）。形状不符 ⇒ `null`。`O(1)`。 */
function monthDay(ymd: string | null): string | null {
  if (ymd === null) return null;
  const parts = ymd.split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : null;
}

function stamp(key: ChainReportStampKey, label: string, value: string | null): ChainReportStamp {
  return { key, label, value: value ?? COPY.noValue };
}

/** 链级读数 → 页头呈现。`O(1)`。 */
export function chainReportHeaderView(report: ChainReportResponse): ChainReportHeaderView {
  const quoteDay = monthDay(report.asOf);
  return {
    iv: ivReadoutView(report.iv),
    spotText: report.spot === null ? null : formatPriceText(report.spot),
    stamps: [
      stamp('market_date', COPY.stampMarketDate, monthDay(report.marketDate)),
      // 报价那条带「收盘」后缀 —— 本片只有 EOD 快照一种来源（`source` = eod / 盘前回填）。
      stamp(
        'quote',
        COPY.stampQuote,
        quoteDay === null ? null : `${quoteDay}${COPY.quoteClosedSuffix}`,
      ),
      stamp('open_interest', COPY.stampOpenInterest, monthDay(report.oiAsOf)),
    ],
    excludedNotice: report.anchorExcluded ? COPY.excludedNotice : null,
  };
}

// ═══════════════════ ② 当前格值的读法一行（FR-010 / FR-014） ═══════════════════

/**
 * 格值 → 读法一行（含它自己的时点）。`O(1)`。
 *
 * 🚨 **活跃度的时点跟 `oiAsOf` 而不是区块级 `asOf`**（`FR-014` / `state_branch` 19）——
 * 美股期权 OI 盘前更新，两者常态**不同日**；用 `asOf` 会把「没人碰过」说成今天的事，
 * **而那一行照样印得出来**。两者不同日时把两个时点都说出来，🚫 不藏。
 */
export function chainReportMetricCaption(
  metric: ChainReportMetric,
  report: Pick<ChainReportResponse, 'asOf' | 'oiAsOf'>,
): string {
  const base = COPY.metricCaptions[metric];
  if (metric !== 'activity') return base;
  const oiDay = monthDay(report.oiAsOf);
  if (oiDay === null) return base;
  const quoteDay = monthDay(report.asOf);
  const diff = quoteDay !== null && quoteDay !== oiDay ? COPY.quoteDiffDay(quoteDay) : '';
  return `${base}${COPY.asOfPrefix}${oiDay}${diff}`;
}

// ═══════════════════ ③ 页脚三个互斥计数（FR-034 / SC-006） ═══════════════════

export type ChainReportGateKey = 'premium' | 'row_floor' | 'liveness';

export interface ChainReportGateLine {
  readonly key: ChainReportGateKey;
  readonly label: string;
  readonly count: number;
  /** 🚨 **每条各带自己的分母** —— 分母不同正是这三条不能相加成一个数的原因（`FR-034`）。 */
  readonly denominatorText: string;
}

/** `n / d` 的整数百分比；分母 ≤ 0 ⇒ `null`（🚫 不印 `NaN%`，也不兜 0%）。`O(1)`。 */
function sharePct(count: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((count / denominator) * 100) : null;
}

function gateLine(
  key: ChainReportGateKey,
  label: string,
  count: number,
  denominator: number,
  denominatorLabel: string,
): ChainReportGateLine {
  const pct = sharePct(count, denominator);
  return {
    key,
    label,
    count,
    denominatorText:
      pct === null ? COPY.gateUnit : `${COPY.gateUnit} · ${pct}% ${denominatorLabel}`,
  };
}

/**
 * 三个互斥计数 → 页脚三行。顺序即语义（权利金 → 行下界 → 活性），🚫 MUST NOT 合并。`O(1)`。
 */
export function chainReportGateLines(
  counts: ChainReportGateCountsResponse,
): readonly [ChainReportGateLine, ChainReportGateLine, ChainReportGateLine] {
  return [
    gateLine(
      'premium',
      COPY.gatePremium,
      counts.removedByPremium,
      counts.total,
      COPY.gateDenominatorTotal,
    ),
    gateLine(
      'row_floor',
      COPY.gateRowFloor,
      counts.outsideRowFloor,
      counts.skeleton,
      COPY.gateDenominatorSkeleton,
    ),
    gateLine(
      'liveness',
      COPY.gateLiveness,
      counts.blockedByLiveness,
      counts.withinRows,
      COPY.gateDenominatorWithinRows,
    ),
  ];
}

/**
 * 求和恒等式那一句（`SC-006` 的客户端一半）。`O(1)`。
 *
 * 🚨 **对不上账时返回 `null`（整句不显示）** —— 这句话断言的是一条不变量，而不变量一旦破了，
 * 照原样印出来就是**用界面替错数背书**。三个数照样各自显示，少的只是这一句总结。
 */
export function chainReportGateHint(counts: ChainReportGateCountsResponse): string | null {
  const sum =
    counts.removedByPremium + counts.outsideRowFloor + counts.blockedByLiveness + counts.valued;
  if (sum !== counts.total) return null;
  return COPY.gateHint(counts.valued, counts.total);
}
