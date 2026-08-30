// 069 T009 — 审计弹层的内容组装纯函数（FR-014/FR-016, mockup 帧③④⑤ baseline）。
// 弹层组件（march-audit-sheet.tsx）只做接线与版面；判定 / 文案组装 / 家族归组全在本文件
//（vitest 覆盖，测试分层：vitest=logic / Playwright=UI）。
//
// 🚨 **一切判定只从契约 `march` 来**（ADR-0064 不变量 ②）：本文件零处对 φ / 净链形状重算，
//    证据 → 文本走 `optionsdesk-copy.ts` 的 13 类格式化单点（server 零拼串, plan Guardrail 6）。
import type {
  LegMarchAuditResponse,
  LegMarchAuditResponseCategory,
  LegMarchStrikeResponse,
  LegMarchStrikeResponseVerdict,
} from '@nvy/api-client';

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
  /** 净链小结一行（段内/净链/剔/并/标 五计数）。 */
  readonly summaryLine: string;
  /** φ 只读读数（取自审计证据里的 φ / 档界，逐条扫首个有值者；全缺 ⇒ `null` 不渲）。 */
  readonly phiLine: string | null;
  /** 两类诚实空态文案（FR-016，中性非错误）；推荐态恒 `null`。 */
  readonly emptyText: string | null;
  readonly rows: readonly MarchAuditRowView[];
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
 * 该 K 的行军块 → 弹层内容（FR-014）。`strikeView = null`（建仓 / 全腿 / 离线，或该 K 无
 * 判决）⇒ `null` = 无弹层可开（FR-019 的结构保证 —— 入口判定与内容组装同一个来源）。O(档)。
 */
export function marchAuditSheetView(
  strikeView: LegMarchStrikeResponse | null,
): MarchAuditSheetView | null {
  if (strikeView === null) return null;
  const phiRaw =
    strikeView.audits
      .map((entry) => entry.evidence.phi ?? entry.evidence.tierFloor)
      .find((value) => value !== null) ?? null;
  return {
    title: COPY.sheetTitle(trimStrike(strikeView.strike)),
    verdict: strikeView.verdict,
    verdictLabel: COPY.verdicts[strikeView.verdict],
    recommendedLabel:
      strikeView.verdict === 'recommended' && strikeView.recommendedDteDays !== null
        ? `${strikeView.recommendedDteDays}d`
        : null,
    summaryLine: COPY.chainSummary(strikeView.summary),
    phiLine: phiRaw === null ? null : COPY.phiReadout(phiRaw),
    emptyText:
      strikeView.verdict === 'no_qualified'
        ? COPY.emptyNoQualified
        : strikeView.verdict === 'untradable'
          ? COPY.emptyUntradable
          : null,
    rows: strikeView.audits.map(rowOf),
  };
}
