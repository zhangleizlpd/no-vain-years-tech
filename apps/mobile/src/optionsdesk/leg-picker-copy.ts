// 047 T034 — 档位着色 / 动作四态 / 财报 chip / 数据缺口体系的**映射层**
// （FR-003/006/007/009/010/011/013/014/021, plan D-SOT-1/D-SOT-2）。
//
// 🚨 **四档是费率质量档不是涨跌** ⇒ 本页零处 `quote-*` 涨跌色。把「好」染成涨绿会让人把
//    档位读成行情方向，而这四档说的是「这一口收多少租」，与标的涨跌毫无关系。
//    机械防线：{@link legPickerClassNames} 吐出本模块**实际用到的每一个 class**，
//    `leg-picker-copy.spec.ts` 对它扫 `quote-` 与 `ink-subtle` 两个禁令。
//
// 🚨 **只着 bid 单元格** —— 整行着色会糊（730 行四色横条铺满，一屏 15 行里没有一行是「安静」的，
//    人反而分不出重点）。行级唯一的着色是**死档的灰底沉底**（FR-006），那是「已出局」的中性灰，
//    不属于四档色阶。
//
// 🚫 **FR-012：动作列是建议标签不是按钮** —— 中性 tag（`surface-sunken` 底 + `border-strong`
//    描边 + 正文/降级字），刻意不做按钮观感。本模块不产出任何饱和底色的「可点」外观。
//
// ⚠️ **降级状态字禁用最淡档 `text-ink-subtle`**（白底实测 2.85:1，不达 WCAG AA）——
//    mockup 段 3 对「无日期」「死档剔除」写的是 `--nvy-text-subtle`，这里**蓄意上调**到
//    `text-ink-muted`（同 046 Guardrail 8）。显式呈现不可用，却渲成最不显眼的字，自相矛盾。
import type {
  LegEarningsMarkResponse,
  LegEarningsMarkResponseMark,
  LegResponse,
  LegResponseTier,
} from '@nvy/api-client';

import { formatAsOfLabel } from '~/format/as-of';
import { formatRatePct, rateCell, type StackedCell } from './leg-row.rules';
import type { LegBlockPriceKind } from './leg-tier-bar.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { FreshnessTier } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

/**
 * 非空的四档（契约的 `tier` 还有一个 `null` = 未判档，见 {@link LEG_TIER_UNJUDGED_TONE}）。
 *
 * 🚨 **档位随视角变**（051 FR-015）—— 本模块的四个映射函数一律**吃档位值、不吃 `leg`**：
 *    档位这一个量就是它们全部所需，多吃一个 `leg` 只会让调用点有第二个地方去取它。
 *    053 起 `leg.tier` **就是本次视角判出来的那一档**（契约把分视角档位映射收窄成标量），
 *    由调用方取一次后传下来。
 */
export type LegTier = NonNullable<LegResponseTier>;

/** 单元格视觉。`container` 为空串 = **不着色**（未判档那一档蓄意留白）。 */
export interface LegCellTone {
  container: string;
  text: string;
}

/**
 * 四档色阶（plan D-SOT-1 / mockup 段 3）。穷举 `Record` —— 档位加一格即编译红。
 * 🚨 四个 `container` 两两不同是硬要求：「好」与「可接受」的动作文案已**合并**为「挂 OCO」，
 *    两档全靠这一处底色区分（FR-010）。
 */
const TIER_TONE: Readonly<Record<LegTier, LegCellTone>> = {
  good: { container: 'bg-ok-soft', text: 'text-ok' },
  acceptable: { container: 'bg-brand-soft', text: 'text-brand-500' },
  thin: { container: 'bg-warn-soft', text: 'text-warn' },
  dead: { container: 'bg-surface-sunken', text: 'text-tag-gray' },
};

/** 未判档（greeks 缺 / 无 bid）：**不着色**。留白本身就是「这行没法判」的呈现。 */
export const LEG_TIER_UNJUDGED_TONE: LegCellTone = { container: '', text: 'text-ink-muted' };

/** bid 单元格的档位色。`tier === null` ⇒ 不着色（FR-007）。复杂度 O(1)。 */
export function legBidTone(tier: LegTier | null): LegCellTone {
  return tier === null ? LEG_TIER_UNJUDGED_TONE : TIER_TONE[tier];
}

/**
 * 行底色。🚨 **只有死档有专属行底**（FR-006 灰底沉底，排序由 server 保证）；
 * 其余档（含未判档）一律常规底 —— 未判档**不沉底也不灰底**，那是死档的处置，两者不同。
 * 复杂度 O(1)。
 */
export function legRowToneClass(tier: LegTier | null): string {
  return tier === 'dead' ? 'bg-surface-sunken' : 'bg-surface';
}

/** 四档 → 动作文案。好 / 可接受**合并**（FR-010）。 */
const ACTION_BY_TIER: Readonly<Record<LegTier, string>> = {
  good: COPY.actionPlaceOco,
  acceptable: COPY.actionPlaceOco,
  thin: COPY.actionHold,
  dead: COPY.actionDead,
};

/**
 * 动作四态（FR-010）。`tier === null` 收敛为「无法判档」——
 * 📌 它同时覆盖 **greeks 缺失**与**无 bid** 两种成因：两者都是「没有可信的判档输入」，
 *    对使用者是同一件事（这一口不知道值不值），分两句只会让窄列更难读。
 * 复杂度 O(1)。
 */
export function legActionLabel(tier: LegTier | null): string {
  return tier === null ? COPY.actionUnjudgeable : ACTION_BY_TIER[tier];
}

/** 🚫 中性 tag —— `surface-sunken` 底 + `border-strong` 描边，**刻意不做按钮观感**（FR-012）。 */
export const LEG_ACTION_TAG_CLASS = 'rounded-sm border border-line-strong bg-surface-sunken px-1';

/** 「挂 OCO」是唯一的正文色（去做）；其余三态一律降级字。⚠️ 禁用最淡档。O(1)。 */
export function legActionTextClass(tier: LegTier | null): string {
  return legActionLabel(tier) === COPY.actionPlaceOco ? 'text-ink' : 'text-ink-muted';
}

/**
 * 费率列 —— 在 T032 的 {@link rateCell} 之上叠一层：**薄档同屏带出 `ask` 口径值**（D-SOT-2）。
 *
 * 🚨 **薄档的周化行由 `ask` 顶掉折年参照**（副标只有一格，56px 列放不下两条）。取舍理由：
 *    折年是 FR-004 明写的「参照 · 不作排序键」，而 `ask` 值是 D-SOT-2 的 MUST —— SoT 的尴尬区
 *    实为「按 `ask` 二分」，没有 `ask` 那一格人根本套不出结论。且薄档行本就标「暂不挂」，
 *    折年在这一行的参照价值最低。
 * 📌 其余档的 `askRate` 契约上恒 `null`（`ask` MUST NOT 参与判档），故这里也不会误带。
 * 复杂度 O(1)。
 */
export function legRateCell(
  leg: Pick<LegResponse, 'basis' | 'weeklyRate' | 'annualizedRate' | 'greeksComplete' | 'askRate'>,
  tier: LegTier | null,
): StackedCell {
  const base = rateCell(leg);
  if (tier !== 'thin') return base;
  const ask = formatRatePct(leg.askRate, leg.basis);
  return ask === null ? base : { primary: base.primary, secondary: COPY.rateAskRef(ask) };
}

// ═══════════════ 钉住列的两个标：贴合（推荐）+ 月（月度链） ═══════════════

/**
 * 钉住列的三个标（051 FR-014a：推荐标随行权价、月度链标随到期日；064 起「收」标随行权价）。
 * 📌 `eod` 是 064 的行级档位标 —— **复用这套既有载体**，🚫 不新建组件、🚫 不新开一列
 *    （mockup overflow 探针实证：挂进 bid/ask 列会把报价块顶出 7px）。
 */
export type LegStickyBadge = 'fit' | 'monthly' | 'eod' | 'band';

/**
 * 两个标的**共用载体**（FR-014b）—— 8px 描边短文字标。两者只在描边色上分权重，
 * 🚫 MUST NOT 让其中一个退化成纯几何符号：认不认得出与视觉权重是两回事。
 */
export const LEG_STICKY_BADGE_BASE = 'rounded-sm border px-0.5 text-[8px] text-ink-muted';

/**
 * 描边色 = 两个标唯一的差别。
 * 🚨 推荐标**蓄意避开 ok / success 绿系**（FR-011a）—— 绿会被读成「建议买入」，而它说的只是
 *    「Δ 贴合当前意图」；取 tag 调色板的 purple，与四档色阶不撞。月度链标取中性描边（更弱）。
 */
export const LEG_STICKY_BADGE_BORDER: Readonly<Record<LegStickyBadge, string>> = {
  fit: 'border-tag-purple',
  monthly: 'border-line',
  // 064 行级档位标：中性强描边（mockup `.eodchip` 逐值）。🚨 **蓄意不上 warning 色** ——
  // 「这一行是收盘值」是事实陈述不是告警，告警底色留给区块条的未就绪那一档。
  eod: 'border-line-strong',
  // 068 带外横档标：中性弱描边 —— 「预测带外」是参照语义不是问题行，权重低于「收」。
  band: 'border-line',
};

// ═══════════════ 财报 chip：五形态 + null，三个「无标」不许合并 ═══════════════

/**
 * chip 形态。`plain` = 无 chip 纯文字（已确认不跨）· `gap` = 虚线 chip（数据缺口体系）·
 * `none` = 占位符（建仓腿按设计无标）。🚨 三者**蓄意分开**（FR-026 / FR-034）。
 */
export type LegEarningsChipVariant =
  | 'covered'
  | 'buffer_short'
  | 'crosses'
  | 'plain'
  | 'gap'
  | 'none';

export interface LegEarningsChip {
  variant: LegEarningsChipVariant;
  label: string;
  /** chip 容器 class；**空串 = 无 chip**（纯文字形态）。 */
  container: string;
  textClass: string;
}

/**
 * 🚨 **数据缺口体系**（沿 046）：`surface-sunken` 底 + **虚线**描边 + 降级字 ——
 * 与红标（错误）体系**蓄意区隔**。它不是错误，是「这一格我们还不知道」。
 */
const GAP_CONTAINER = 'rounded-sm border border-dashed border-line-strong bg-surface-sunken px-1';

const CHIP_BY_MARK: Readonly<Record<LegEarningsMarkResponseMark, LegEarningsChipVariant>> = {
  covered: 'covered',
  buffer_short: 'buffer_short',
  crosses_earnings: 'crosses',
  no_cross: 'plain',
  no_date: 'gap',
};

const CHIP_TONE: Readonly<Record<LegEarningsChipVariant, LegCellTone>> = {
  // 🚨 chip 文字一律用正文色（不用饱和色当文字色），语义靠底 + 描边承载。
  covered: { container: 'rounded-sm border border-ok bg-ok-soft px-1', text: 'text-ink' },
  buffer_short: { container: 'rounded-sm border border-warn bg-warn-soft px-1', text: 'text-ink' },
  // 跨财报用活力橙（accent）而非 err —— 提醒语义、零拦截（FR-025），红标是错误体系的。
  crosses: { container: 'rounded-sm border border-accent bg-accent-soft px-1', text: 'text-ink' },
  plain: { container: '', text: 'text-ink-muted' },
  gap: { container: GAP_CONTAINER, text: 'text-ink-muted' },
  none: { container: '', text: 'text-ink-muted' },
};

/**
 * 财报标 → chip。复杂度 O(1)。
 *
 * 🚨 **本函数不吃档位**（FR-006）：死档行照常打财报标 —— 死档是**费率档**，与到期日 / 财报日
 *    正交，其财报关系本就存在。「死档不打标」在结构上就写不出来，不是靠事后断言守的。
 * 🚨 `null`（建仓腿按设计无标）与 `no_date`（有腿有窗口但不知道财报日）**MUST NOT 合并** ——
 *    前者渲占位符「—」，后者渲虚线 chip。
 */
export function legEarningsChip(mark: LegEarningsMarkResponse | null): LegEarningsChip {
  if (mark === null) {
    return { variant: 'none', label: COPY.noValue, ...toneOf('none') };
  }
  const variant = CHIP_BY_MARK[mark.mark];
  return { variant, label: earningsLabel(mark), ...toneOf(variant) };
}

function toneOf(variant: LegEarningsChipVariant): Pick<LegEarningsChip, 'container' | 'textClass'> {
  const tone = CHIP_TONE[variant];
  return { container: tone.container, textClass: tone.text };
}

/** 五形态的字。穷举 `Record` 派生 —— `buffer_short` 的 `+Nd` 是唯一带参数的那支。 */
function earningsLabel(mark: LegEarningsMarkResponse): string {
  switch (mark.mark) {
    case 'covered':
      return COPY.earningsCovered;
    case 'buffer_short':
      return mark.bufferShortfallDays === null
        ? COPY.earningsBufferShortUnknown
        : COPY.earningsBufferShort(mark.bufferShortfallDays);
    case 'crosses_earnings':
      return COPY.earningsCrosses;
    case 'no_cross':
      return COPY.earningsNoCross;
    case 'no_date':
      return COPY.earningsNoDate;
  }
}

// ═══════════════ 区块级 asOf 的两档呈现（T027a） ═══════════════

export interface LegAsOfLabel {
  text: string;
  className: string;
}

/**
 * 区块头 `asOf` 三档的文字 class（穷举 `Record` —— 档位加一格即编译红）。
 *
 * ⚠️ **降级档禁最淡的 `text-ink-subtle`**（白底实测 2.85:1，不达 WCAG AA），统一用
 *    `text-ink-muted`（同本模块顶部那条纪律）。陈旧档反向**加重**到 `text-warn` + `semibold`：
 *    它是要被看见的告警，不是降级信息。
 */
const AS_OF_TONE: Readonly<Record<FreshnessTier, string>> = {
  CURRENT: 'text-xs font-medium text-ink',
  STALE: 'text-xs font-semibold text-warn',
  UNAVAILABLE: 'text-xs font-medium text-ink-muted',
};

/**
 * 区块级 `asOf` 的呈现 —— **常态 vs 陈旧二分**（`state_branches` 第 3 条）。复杂度 O(1)。
 *
 * 🚨 **档位由 server 的 `asOfFreshnessTier` 下发，客户端不自判**（T027a）。判据是「asOf 是否
 *    落后于该市场最近一个已收盘交易日」，要查交易日历 —— 客户端没有。初版拿设备本地日期比，
 *    对美股**恒为真**（美股 08-04 的 EOD 要到北京 08-05 清晨才落库，那时设备已是 08-05）⇒
 *    境内用户看到的每个读数恒显「已过时」，永远为真的告警等于没有告警。**别改回本地比日期。**
 * 🚨 **陈旧 ≠ 不可用**：本函数只管这一行标注，表格照常渲全量腿（FR-013）。
 * 📌 判的是**区块级 asOf**，不是 `oiAsOf` —— 后者归属 T−1 是定义如此（Guardrail 6），
 *    拿同一个档去标 OI 列会恒显陈旧。
 *
 * 🚨 **064 起第三个入参决定这一行说什么**：区块翻实时档之后，本行的 `asOf` 仍是**库内快照的
 *    归属交易日**（OI 与未被覆盖的列出自它），但屏上的报价来自此刻 ⇒ 再说「数据截至 X · 收盘」
 *    就是一句假话，且与档位条上的时刻**同屏对冲**。实时档下改说「快照 X」，收盘档下一字不变。
 *    🚫 MUST NOT 让本行去报此刻的时刻 —— 那是档位条的活，两处报同一个量必 drift。
 */
export function legAsOfLabel(
  asOf: string | null | undefined,
  tier: FreshnessTier,
  blockPriceKind: LegBlockPriceKind | null = 'eod_close',
): LegAsOfLabel {
  // asOf 缺失时无论 server 说什么都渲「无数据时点」—— 绝不渲染「数据截至 null」。
  if (!asOf || tier === 'UNAVAILABLE') {
    return { text: COPY.asOfUnavailable, className: AS_OF_TONE.UNAVAILABLE };
  }
  const label =
    blockPriceKind === 'realtime'
      ? `${COPY.snapshotPrefix}${asOf}`
      : formatAsOfLabel(asOf, 'eod_close');
  return tier === 'CURRENT'
    ? { text: label, className: AS_OF_TONE.CURRENT }
    : { text: `${label}${COPY.asOfStaleSuffix}`, className: AS_OF_TONE.STALE };
}

// ═══════════════ 页脚图例 + class 面机械防线 ═══════════════

export interface LegTierLegendRow {
  tier: LegTier;
  label: string;
  /** 两族边界同屏（跨族 MUST NOT 比数值，故两个口径并列而非二选一）。 */
  bounds: string;
  tone: LegCellTone;
}

/** 四档图例（页脚）。顺序 = 好 → 可接受 → 薄 → 死档（与档位序一致）。 */
export const LEG_TIER_LEGEND: readonly LegTierLegendRow[] = (
  ['good', 'acceptable', 'thin', 'dead'] as const
).map((tier) => ({
  tier,
  label: COPY.tierLabels[tier],
  bounds: COPY.tierBounds[tier],
  tone: TIER_TONE[tier],
}));

/**
 * 本模块**实际会吐到屏幕上**的全部 class 串（配色禁令的机械防线用）。
 *
 * ⚠️ 断言面刻意是**值面而非源码 grep**：Small 档禁磁盘 I/O，且 `quote` / `subtle` 字样合法地
 *    出现在上方警示注释里 —— 文本 grep 必假红，还会诱人删注释来「修绿」。值面还更强：
 *    间接拼出来的 class 也逃不掉。复杂度 O(档数 + 形态数) = O(1)。
 */
export function legPickerClassNames(): string[] {
  const out: string[] = [LEG_ACTION_TAG_CLASS, 'text-ink', 'text-ink-muted', 'bg-surface'];
  for (const tone of Object.values(TIER_TONE)) out.push(tone.container, tone.text);
  for (const tone of Object.values(CHIP_TONE)) out.push(tone.container, tone.text);
  out.push(LEG_TIER_UNJUDGED_TONE.container, LEG_TIER_UNJUDGED_TONE.text);
  out.push(LEG_STICKY_BADGE_BASE, ...Object.values(LEG_STICKY_BADGE_BORDER));
  out.push(legRowToneClass('dead'));
  out.push(...Object.values(AS_OF_TONE));
  return out;
}
