// 069 T009 — 审计弹层的内容组装纯函数（FR-014/FR-016, mockup 帧③④⑤ baseline）。
// 弹层组件（march-audit-sheet.tsx）只做接线与版面；判定 / 文案组装 / 家族归组全在本文件
//（vitest 覆盖，测试分层：vitest=logic / Playwright=UI）。
//
// 🚨 **一切判定只从契约 `march` 来**（ADR-0064 不变量 ②）：本文件零处对 φ / 净链形状重算，
//    证据 → 文本走 `optionsdesk-copy.ts` 的 13 类格式化单点（server 零拼串, plan Guardrail 6）。
//
// 070 T005 补两行题头（FR-003 口径行 / FR-009 模式标示）—— 同样零判定：口径与模式都是**链级
// 契约字段**原样呈现，🚫 MUST NOT 由 `march` 内容反推「这是不是离线档」。
import type {
  LegMarchAuditResponse,
  LegMarchAuditResponseCategory,
  LegMarchStrikeResponse,
  LegMarchStrikeResponseVerdict,
  LegTableResponseMarchMode,
} from '@nvy/api-client';

import type { LegBlockPriceKind } from './leg-tier-bar.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.march;

/**
 * 四家族（FR-015）→ 弹层左缘色条的分组 kind。
 *
 * 📌 **这是表达层的呈现分组不是第二份判据**（FR-013：灰显/着色/文案归表达层）：类目集合
 * 本身经生成链传导（契约枚举 = server 单点），这里只回答「13 类各画哪根色条」。
 * `Record` 穷举 ⇒ 契约加类而这里漏归组 = 编译红。
 */
export const MARCH_FAMILY_KINDS = ['chain_clean', 'march', 'tradability', 'boundary'] as const;

export type MarchFamilyKind = (typeof MARCH_FAMILY_KINDS)[number];

export const MARCH_FAMILY_OF_CATEGORY: Readonly<
  Record<LegMarchAuditResponseCategory, MarchFamilyKind>
> = {
  crossed_quote: 'chain_clean',
  concave_dominated: 'chain_clean',
  absolute_dominated: 'chain_clean',
  collinear_merged: 'chain_clean',
  fwd_below_phi: 'march',
  decay_rebound_above_beta: 'march',
  decay_above_gamma_cap: 'march',
  tier_floor_failed: 'march',
  qualified_not_stop: 'march',
  stop_oi_below_min: 'tradability',
  ladder_oi_all_below_min: 'tradability',
  band_out: 'boundary',
  quote_missing: 'boundary',
};

/** 弹层逐档一行（FR-014：类目 + 数值证据；家族色条按 {@link MarchFamilyKind} 上色）。 */
export interface MarchAuditRowView {
  /** 行 key（弹层内 DTE 唯一 —— 每档恰一条）。 */
  readonly key: string;
  /** 档标（`90d`；共线除名档追加并入指向）。 */
  readonly dteLabel: string;
  readonly family: MarchFamilyKind;
  /** 类目 + 数值证据的一行文本（13 类格式化单点产物）。 */
  readonly text: string;
}

/** 弹层全部内容 —— 组件按此渲染，零逻辑。 */
export interface MarchAuditSheetView {
  readonly title: string;
  readonly verdict: LegMarchStrikeResponseVerdict;
  readonly verdictLabel: string;
  /** 推荐态的档读数（`180d`）；其余判决恒 `null`。 */
  readonly recommendedLabel: string | null;
  /**
   * 070 口径行（FR-003）：收盘档 ⇒ 「基于 {交易日} 收盘」；实时档 / 时点形态不对 ⇒ `null` 不渲。
   * 这一行是**全弹层的口径承载**，13 类逐条目因此不加昨收尾缀（FR-004）。
   */
  readonly basisLine: string | null;
  /** 净链小结一行（段内/净链/剔/并/标 五计数）。 */
  readonly summaryLine: string;
  /**
   * φ 只读读数（取自审计证据里的 φ / 档界，逐条扫首个有值者；全缺 ⇒ `null` 不渲）。
   * 🚨 θ 模式下恒 `null` —— 那一轮的判据是年化 argmax，把再投资线继续渲在那儿就是两模式混用。
   */
  readonly phiLine: string | null;
  /** 070 模式标示（FR-009）：θ 模式一行；默认 φ 模式恒 `null`（零新元素 = 零噪音）。 */
  readonly modeLine: string | null;
  /** 两类诚实空态文案（FR-016，中性非错误）；推荐态恒 `null`。 */
  readonly emptyText: string | null;
  readonly rows: readonly MarchAuditRowView[];
}

/**
 * 070 弹层的**区块级口径上下文**（链级三字段，全部原样来自契约）。
 * 069 既有调用点不传 ⇒ 走 {@link NO_BLOCK_CONTEXT}：无口径行、无模式标示、φ 读数原样。
 */
export interface MarchAuditBlockContext {
  readonly priceKind: LegBlockPriceKind | null;
  /** 链级时点：收盘档 = 交易日 `YYYY-MM-DD`，实时档 = ISO 时刻（064 FR-010「粒度即档位」）。 */
  readonly quoteAsOf: string | null;
  readonly marchMode: LegTableResponseMarchMode;
}

const NO_BLOCK_CONTEXT: MarchAuditBlockContext = {
  priceKind: null,
  quoteAsOf: null,
  marchMode: null,
};

/**
 * 口径行（FR-003）。收盘档且时点解得出交易日才渲，其余一律 `null`。O(1)。
 *
 * 🚨 **形态不对宁可不渲**（同 `formatQuoteSessionDay` 那条）：`new Date('2026-08-28')` 解得出
 * 一个像模像样的时刻，一旦让时分秒渗进这一行，「昨收」就伪装成了「刚才」。此处只取日期部分 ——
 * 🚨 与档位条的短形 `MM-DD` 刻意不同：弹层要的是**可追溯到哪一天**（FR-003），年份不能丢。
 */
function basisLineOf(block: MarchAuditBlockContext): string | null {
  if (block.priceKind !== 'eod_close' || block.quoteAsOf === null) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(block.quoteAsOf)
    ? COPY.basisEodClose(block.quoteAsOf.slice(0, 10))
    : null;
}

/** 尾零收干净的行权价（`92.0000` → `92`）。 */
function trimStrike(raw: string): string {
  return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
}

function rowOf(entry: LegMarchAuditResponse): MarchAuditRowView {
  return {
    key: `${entry.dteDays}`,
    dteLabel:
      entry.mergedIntoDteDays === null
        ? `${entry.dteDays}d`
        : `${entry.dteDays}d → ${entry.mergedIntoDteDays}d`,
    family: MARCH_FAMILY_OF_CATEGORY[entry.category],
    text: COPY.reasons[entry.category](entry.evidence),
  };
}

/**
 * 该 K 的行军块 → 弹层内容（FR-014）。`strikeView = null`（建仓 / 全腿，或该 K 无判决）
 * ⇒ `null` = 无弹层可开（FR-019 的结构保证 —— 入口判定与内容组装同一个来源）。O(档)。
 *
 * 070：`block` 带链级口径与模式（省略 ⇒ 两行皆不渲、φ 读数原样，069 既有调用体例逐字段不变）。
 */
export function marchAuditSheetView(
  strikeView: LegMarchStrikeResponse | null,
  block: MarchAuditBlockContext = NO_BLOCK_CONTEXT,
): MarchAuditSheetView | null {
  if (strikeView === null) return null;
  const isTheta = block.marchMode === 'theta';
  const phiRaw = isTheta
    ? null
    : (strikeView.audits
        .map((entry) => entry.evidence.phi ?? entry.evidence.tierFloor)
        .find((value) => value !== null) ?? null);
  return {
    title: COPY.sheetTitle(trimStrike(strikeView.strike)),
    verdict: strikeView.verdict,
    verdictLabel: COPY.verdicts[strikeView.verdict],
    recommendedLabel:
      strikeView.verdict === 'recommended' && strikeView.recommendedDteDays !== null
        ? `${strikeView.recommendedDteDays}d`
        : null,
    basisLine: basisLineOf(block),
    summaryLine: COPY.chainSummary(strikeView.summary),
    phiLine: phiRaw === null ? null : COPY.phiReadout(phiRaw),
    modeLine: isTheta ? COPY.modeThetaReadout : null,
    emptyText:
      strikeView.verdict === 'no_qualified'
        ? COPY.emptyNoQualified
        : strikeView.verdict === 'untradable'
          ? COPY.emptyUntradable
          : null,
    rows: strikeView.audits.map(rowOf),
  };
}
