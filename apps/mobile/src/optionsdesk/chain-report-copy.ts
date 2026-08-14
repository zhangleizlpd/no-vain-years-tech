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
import type { ChainReportResponse } from '@nvy/api-client';

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
