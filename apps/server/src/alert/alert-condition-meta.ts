/**
 * 023 预警条件词表 SoT (ADR-0043 §4 rules/meta 文件：无副作用纯数据 + 纯谓词)。
 *
 * 单源职责：34 type 词表 + 每 type 的 kind / param 白名单 / threshold 值域族 /
 * 单位 / 默认值 / intradayEligible——server 校验 (alert-validation.rules) / 求值
 * (alert-evaluation.rules) 共享；mobile alert-copy.ts 镜像同 shape (跨 app 不直接 import)。
 *
 * 计数沿革：023 落 32 type (plan §词表 SoT 逐项枚举为准，旧「26 词表」为算术笔误)；
 * 024 +2 盘中 5min 类 (PRICE_RISE/FALL_5MIN_OVER) = **34 type**。
 *
 * intradayEligible (024 plan §词表标记)：标记可在盘中 5min tick 即时求值的 type。
 * 仅 PRICE_RISE_TO/PRICE_FALL_TO (到价类，实时价直判) + 2 新 5min 差分类为 true；
 * 其余 30 type 依赖 EOD 日 K / 估值快照，只在 EOD 轮求值，故 false。
 *
 * 带参条件 (plan D3)：param Int sentinel 0 = 无参；带参 kind 的白名单见下方常量。
 * 通达信公式口径 (plan D5，SC-002 对照同花顺锚)：
 *   MACD: DIF = EMA(C,12) − EMA(C,26)；DEA = EMA(DIF,9)
 *   KDJ : RSV = (C−LLV(L,9))/(HHV(H,9)−LLV(L,9))×100；K = SMA(RSV,3,1)，
 *         D = SMA(K,3,1)，J = 3K−2D (K/D 初值 50)
 *   RSI : SMA(MAX(C−LC,0),14,1) / SMA(ABS(C−LC),14,1) × 100 (Wilder 1/N 递推)
 *   BOLL: MID = MA(C,20)；UP/DN = MID ± 2×STD(C,20) (样本标准差)
 */

/** 完整词表 (34)：021 既有 4 type 居首形态不变 (FR-S09)，按 mockup 4 分类分组排序。 */
export const ALERT_CONDITION_TYPES = [
  // ── 价格跟踪 (12)：021 既有 4 + 均线穿越 2 + 新高新低 2 + 累计涨跌幅 2 + 024 盘中 5min 2
  'PRICE_RISE_TO',
  'PRICE_FALL_TO',
  'DAILY_GAIN_OVER',
  'DAILY_LOSS_OVER',
  'MA_CROSS_UP',
  'MA_CROSS_DOWN',
  'NEW_HIGH',
  'NEW_LOW',
  'PERIOD_GAIN_OVER',
  'PERIOD_LOSS_OVER',
  // 024 盘中 5min 差分 (intradayEligible)：相邻 tick 涨/跌幅达阈值即时触发
  'PRICE_RISE_5MIN_OVER',
  'PRICE_FALL_5MIN_OVER',
  // ── 估值 (10)：直比 6 + 分位 4
  'PE_ABOVE',
  'PE_BELOW',
  'PB_ABOVE',
  'PB_BELOW',
  'DIVIDEND_YIELD_ABOVE',
  'DIVIDEND_YIELD_BELOW',
  'PE_PCTL_ABOVE',
  'PE_PCTL_BELOW',
  'PB_PCTL_ABOVE',
  'PB_PCTL_BELOW',
  // ── 成交量 (2)
  'TURNOVER_RATE_OVER',
  'VOLUME_RATIO_OVER',
  // ── 技术指标 (10)：MACD 2 + KDJ 4 + RSI 2 + BOLL 2
  'MACD_GOLDEN_CROSS',
  'MACD_DEATH_CROSS',
  'KDJ_GOLDEN_CROSS',
  'KDJ_DEATH_CROSS',
  'KDJ_OVERBOUGHT',
  'KDJ_OVERSOLD',
  'RSI_OVERBOUGHT',
  'RSI_OVERSOLD',
  'BOLL_BREAK_UPPER',
  'BOLL_BREAK_LOWER',
] as const;
export type AlertConditionType = (typeof ALERT_CONDITION_TYPES)[number];

/** 4 分类 (mockup rail 顺序：价格跟踪/估值/成交量/技术指标)。 */
export const ALERT_CONDITION_CATEGORIES = ['price', 'valuation', 'volume', 'technical'] as const;
export type AlertConditionCategory = (typeof ALERT_CONDITION_CATEGORIES)[number];

/**
 * kind = 参数/阈值形态族 (驱动校验矩阵 + mobile 参数 sheet 变体分发, mockup B1-B6e)：
 * threshold=纯阈值 / ma=周期单选 / window=窗口单选 / daysPct=天数+阈值 /
 * pctile=分位年限+百分位 / rsi=阈值可调有默认 / none=无参直加。
 */
export const ALERT_CONDITION_KINDS = [
  'threshold',
  'ma',
  'window',
  'daysPct',
  'pctile',
  'rsi',
  'none',
] as const;
export type AlertConditionKind = (typeof ALERT_CONDITION_KINDS)[number];

/**
 * threshold 值域族 (FR-S07)：price/positive >0；percent ∈(0,100]；pctile ∈[0,100]；
 * rsi ∈(0,100)。price 与 positive 谓词同形但错误码分流 (021 ALERT_PRICE_* 沿用)。
 */
export const THRESHOLD_FAMILIES = ['price', 'percent', 'positive', 'pctile', 'rsi'] as const;
export type ThresholdFamily = (typeof THRESHOLD_FAMILIES)[number];

/** param sentinel：无参条件 param 必为 0 (plan D3，PG 唯一约束 NULL 不去重故弃 NULL)。 */
export const NO_PARAM_SENTINEL = 0;

/** 均线周期白名单 (FR-S02)。 */
export const MA_PERIODS = [5, 10, 20, 60, 120, 250] as const;
/** 新高新低窗口白名单 (FR-S02)。 */
export const WINDOW_DAYS = [60, 120, 250] as const;
/** 累计涨跌幅天数白名单 (FR-S02)。 */
export const PERIOD_DAYS = [3, 5, 10] as const;
/** 估值分位回看年限白名单 (FR-S01)。 */
export const PCTL_YEARS = [3, 5] as const;

/** 技术指标固定参数 (FR-S04 除 RSI 阈值外不开放自定义；公式见文件头)。 */
export const INDICATOR_PARAMS = {
  MACD: { fast: 12, slow: 26, signal: 9 },
  KDJ: { n: 9, k: 3, d: 3 },
  RSI: { n: 14 },
  BOLL: { n: 20, k: 2 },
} as const;

/** KDJ 超买/超卖 J 值固定界 (FR-S04：J>100 超买 / J<10 超卖，spec 为准非 mockup J<0)。 */
export const KDJ_OVERBOUGHT_J = 100;
export const KDJ_OVERSOLD_J = 10;

export interface AlertConditionMeta {
  type: AlertConditionType;
  category: AlertConditionCategory;
  kind: AlertConditionKind;
  /** 空数组 = 无参 (param 必为 sentinel 0)；非空 = param 必在表内。 */
  paramWhitelist: readonly number[];
  /** null = 禁带 threshold (none/ma/window kind)。 */
  thresholdFamily: ThresholdFamily | null;
  /** 阈值单位 (mobile sheet 后缀)；无阈值/无单位 = null。 */
  unit: string | null;
  /** 仅 rsi kind：新建 sheet 预填默认 (FR-S04 70/30)。 */
  defaultThreshold?: number;
  /** 024：可在盘中 5min tick 即时求值 (到价 2 + 5min 差分 2)；其余 type EOD-only。 */
  intradayEligible: boolean;
}

function meta(
  type: AlertConditionType,
  category: AlertConditionCategory,
  kind: AlertConditionKind,
  paramWhitelist: readonly number[],
  thresholdFamily: ThresholdFamily | null,
  unit: string | null,
  defaultThreshold?: number,
  intradayEligible = false,
): AlertConditionMeta {
  return {
    type,
    category,
    kind,
    paramWhitelist,
    thresholdFamily,
    unit,
    defaultThreshold,
    intradayEligible,
  };
}

export const ALERT_CONDITION_META: Record<AlertConditionType, AlertConditionMeta> = {
  // ── 价格跟踪 (到价 2 类盘中可即时判定 → intradayEligible)
  PRICE_RISE_TO: meta('PRICE_RISE_TO', 'price', 'threshold', [], 'price', '元', undefined, true),
  PRICE_FALL_TO: meta('PRICE_FALL_TO', 'price', 'threshold', [], 'price', '元', undefined, true),
  DAILY_GAIN_OVER: meta('DAILY_GAIN_OVER', 'price', 'threshold', [], 'percent', '%'),
  DAILY_LOSS_OVER: meta('DAILY_LOSS_OVER', 'price', 'threshold', [], 'percent', '%'),
  MA_CROSS_UP: meta('MA_CROSS_UP', 'price', 'ma', MA_PERIODS, null, null),
  MA_CROSS_DOWN: meta('MA_CROSS_DOWN', 'price', 'ma', MA_PERIODS, null, null),
  NEW_HIGH: meta('NEW_HIGH', 'price', 'window', WINDOW_DAYS, null, null),
  NEW_LOW: meta('NEW_LOW', 'price', 'window', WINDOW_DAYS, null, null),
  PERIOD_GAIN_OVER: meta('PERIOD_GAIN_OVER', 'price', 'daysPct', PERIOD_DAYS, 'percent', '%'),
  PERIOD_LOSS_OVER: meta('PERIOD_LOSS_OVER', 'price', 'daysPct', PERIOD_DAYS, 'percent', '%'),
  // 024 盘中 5min 差分 (无参 / percent (0,100] / intradayEligible)
  PRICE_RISE_5MIN_OVER: meta(
    'PRICE_RISE_5MIN_OVER',
    'price',
    'threshold',
    [],
    'percent',
    '%',
    undefined,
    true,
  ),
  PRICE_FALL_5MIN_OVER: meta(
    'PRICE_FALL_5MIN_OVER',
    'price',
    'threshold',
    [],
    'percent',
    '%',
    undefined,
    true,
  ),
  // ── 估值 (求值比对 fundamental_snapshot 最新行 + staleness ≤3 交易日, plan D4)
  PE_ABOVE: meta('PE_ABOVE', 'valuation', 'threshold', [], 'positive', '倍'),
  PE_BELOW: meta('PE_BELOW', 'valuation', 'threshold', [], 'positive', '倍'),
  PB_ABOVE: meta('PB_ABOVE', 'valuation', 'threshold', [], 'positive', '倍'),
  PB_BELOW: meta('PB_BELOW', 'valuation', 'threshold', [], 'positive', '倍'),
  DIVIDEND_YIELD_ABOVE: meta('DIVIDEND_YIELD_ABOVE', 'valuation', 'threshold', [], 'percent', '%'),
  DIVIDEND_YIELD_BELOW: meta('DIVIDEND_YIELD_BELOW', 'valuation', 'threshold', [], 'percent', '%'),
  PE_PCTL_ABOVE: meta('PE_PCTL_ABOVE', 'valuation', 'pctile', PCTL_YEARS, 'pctile', '%'),
  PE_PCTL_BELOW: meta('PE_PCTL_BELOW', 'valuation', 'pctile', PCTL_YEARS, 'pctile', '%'),
  PB_PCTL_ABOVE: meta('PB_PCTL_ABOVE', 'valuation', 'pctile', PCTL_YEARS, 'pctile', '%'),
  PB_PCTL_BELOW: meta('PB_PCTL_BELOW', 'valuation', 'pctile', PCTL_YEARS, 'pctile', '%'),
  // ── 成交量 (none 口径直用, plan D8；FR-S07 仅 ≤0 拒 → positive 族，换手率可 >100%)
  TURNOVER_RATE_OVER: meta('TURNOVER_RATE_OVER', 'volume', 'threshold', [], 'positive', '%'),
  VOLUME_RATIO_OVER: meta('VOLUME_RATIO_OVER', 'volume', 'threshold', [], 'positive', '倍'),
  // ── 技术指标 (穿越=事件语义 D6；KDJ/RSI 超买卖=状态语义 FR-S10)
  MACD_GOLDEN_CROSS: meta('MACD_GOLDEN_CROSS', 'technical', 'none', [], null, null),
  MACD_DEATH_CROSS: meta('MACD_DEATH_CROSS', 'technical', 'none', [], null, null),
  KDJ_GOLDEN_CROSS: meta('KDJ_GOLDEN_CROSS', 'technical', 'none', [], null, null),
  KDJ_DEATH_CROSS: meta('KDJ_DEATH_CROSS', 'technical', 'none', [], null, null),
  KDJ_OVERBOUGHT: meta('KDJ_OVERBOUGHT', 'technical', 'none', [], null, null),
  KDJ_OVERSOLD: meta('KDJ_OVERSOLD', 'technical', 'none', [], null, null),
  RSI_OVERBOUGHT: meta('RSI_OVERBOUGHT', 'technical', 'rsi', [], 'rsi', null, 70),
  RSI_OVERSOLD: meta('RSI_OVERSOLD', 'technical', 'rsi', [], 'rsi', null, 30),
  BOLL_BREAK_UPPER: meta('BOLL_BREAK_UPPER', 'technical', 'none', [], null, null),
  BOLL_BREAK_LOWER: meta('BOLL_BREAK_LOWER', 'technical', 'none', [], null, null),
};

/** 词表查 meta (调用方持 AlertConditionType 时的类型安全入口)。 */
export function metaOf(type: AlertConditionType): AlertConditionMeta {
  return ALERT_CONDITION_META[type];
}

/** threshold 值域谓词 (per family，NaN/Infinity 一律拒)。O(1)。 */
export function isThresholdInRange(family: ThresholdFamily, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (family) {
    case 'price':
    case 'positive':
      return value > 0;
    case 'percent':
      return value > 0 && value <= 100;
    case 'pctile':
      return value >= 0 && value <= 100;
    case 'rsi':
      return value > 0 && value < 100;
  }
}
