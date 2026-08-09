import { Prisma } from '../generated/prisma/client.js';
import {
  ALERT_CONDITION_META,
  KDJ_OVERBOUGHT_J,
  KDJ_OVERSOLD_J,
  type AlertConditionType,
} from './alert-condition-meta.js';
import {
  boll,
  kdj,
  macd,
  movingAverage,
  newHighLow,
  periodReturnPct,
  rsi,
  volumeRatio,
  type IndicatorBar,
} from './alert-indicator.rules.js';

/**
 * EOD 求值纯函数 (021 T010 + 023 T011, US2; ADR-0043 §4 rules 无副作用)。
 *
 * 职责: 持已取好的数据 (调用方 evaluate-alerts.usecase 按 `conditionDataNeed` 分层取数) ×
 * 有限枚举条件 → 查表式比较 (FR: 不上 AST)。三类数据源 (plan D2):
 *   - noneBar    : 021 价格 4 类 (Decimal 真实成交价口径 D8, 精度逐字节延续 021)
 *   - forwardBars: 价格扩展/成交量/技术指标 (前复权升序数值序列, FR-S05; 量价字段复权不变量)
 *   - fundamental: 估值 10 类 (最新快照行 + staleness ≤3 交易日 gate, plan D4)
 *
 * 命中语义 (spec Clarifications + FR-S02/S04):
 *   - 穿越/事件 (MA/MACD/KDJ 金叉死叉 / NEW_HIGH/LOW / BOLL 突破): 今昨双值边沿判定,
 *     持续满足的非穿越日不命中
 *   - 状态 (RSI/KDJ 超买卖 / 估值 / 换手率 / 量比): 当日值越阈即命中, 每个交易日各判一次 (FR-S10)
 *   - warm-up 不足 / 字段缺失 / staleness 超限 → 该条件不命中 (FR-S06 防御, 不报错)
 * AND 聚合: 全条件命中 → 快照数组 (输入序); 任一不命中 → null (无部分快照)。
 *
 * snapshot 形状 (FR-S08, message.response 同构, 021 零回归): `{type, threshold, actual}`
 * 基线; 023 仅在 param≠0 / 估值携 dataDate 时附加键 → 021 四类 (param 0 / 无 dataDate) 输出
 * 与既有逐字节一致。数值跨边界 string: 021 价格走 Decimal.toFixed(4) (DB Decimal(18,4)
 * 同源精度); 指标走 number.toFixed(4) (SC-002 容差 ≤1%, double 远超)。
 */

/** EOD bar 最小快照 (daily_bar none 口径投影; 021 价格类 + 双模 seam 入参形状)。 */
export interface EodBarSnapshot {
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  prevClose: Prisma.Decimal | null;
}

/** 024 盘中 5min 差分输入 (相邻 tick 价对; 到价类不用; EOD/缺省 → 5min 差分类不命中)。 */
export interface RealtimeDiffInput {
  /** 现 tick 价 (元)。 */
  price: number;
  /** 上一 tick 价 (元); null = 首 tick / 重启无快照 → 不命中 (plan D3 防御)。 */
  prevTickPrice: number | null;
}

/** 估值快照行最小投影 (fundamental_snapshot Decimal → number; 缺失维度 null)。 */
export interface FundamentalRow {
  /** YYYY-MM-DD (快照所属交易日, 进 dataDate 快照)。 */
  date: string;
  peTtm: number | null;
  pb: number | null;
  dividendYield: number | null;
  pePctlY3: number | null;
  pePctlY5: number | null;
  pbPctlY3: number | null;
  pbPctlY5: number | null;
}

/** 一标的一轮的求值输入 (调用方按 conditionDataNeed 选择性填充)。 */
export interface EvaluationInputs {
  /** 021 价格 4 类 + 量类原始口径 (最新 none bar)。 */
  noneBar: EodBarSnapshot;
  /** 前复权升序序列 (窗口/指标/量类; 缺省/不足 → 相关条件 warm-up 不命中)。 */
  forwardBars?: readonly IndicatorBar[];
  /** 最新估值快照 (null/缺省 → 估值条件不命中)。 */
  fundamental?: FundamentalRow | null;
  /** 估值快照 staleness = 交易日距离 (null/缺省/>3 → 估值条件不命中, plan D4)。 */
  fundamentalStaleness?: number | null;
  /** 024 盘中 5min 差分 (相邻 tick 价对; 缺省/EOD → 5min 差分类不命中, plan D3/D4)。 */
  realtimeDiff?: RealtimeDiffInput | null;
}

/** 待求值条件 (AlertCondition row 最小投影; 023 带 param, threshold nullable per schema D3)。 */
export interface EvaluableCondition {
  type: string;
  param: number;
  threshold: Prisma.Decimal | null;
}

/** 命中快照元素 (AlertTrigger.conditionsSnapshot Json 元素形状, message.response 同构)。 */
export interface ConditionHitSnapshot {
  type: string;
  /** Decimal string; 穿越/无参类型 null。 */
  threshold: string | null;
  actual: string;
  /** 023: param≠0 才携带 (021 四类 param 0 → 省略, 旧消息兼容)。 */
  param?: number;
  /** 023: 仅估值条件携带快照日 (FR-S01)。 */
  dataDate?: string;
}

const HUNDRED = new Prisma.Decimal(100);
/** 估值快照陈旧容忍上限 = 3 交易日 (plan D4 / Clarify Q3)。 */
const STALENESS_MAX_TRADING_DAYS = 3;

/** 021 价格基线 4 类 (只需 noneBar; FR-S09 零回归路径)。 */
const BASELINE_PRICE_TYPES = new Set<string>([
  'PRICE_RISE_TO',
  'PRICE_FALL_TO',
  'DAILY_GAIN_OVER',
  'DAILY_LOSS_OVER',
]);

/** 024 盘中 5min 差分 2 类 (相邻 tick 涨跌幅; 需 realtimeDiff 数据源, EOD 无意义)。 */
const REALTIME_DIFF_TYPES = new Set<string>(['PRICE_RISE_5MIN_OVER', 'PRICE_FALL_5MIN_OVER']);

/**
 * 条件取数分类 (调用方按此决定每标的取哪些数据源, plan D2/D3)。
 * valuation → fundamental; 021 四类 → noneBar; 024 5min 差分 2 类 → realtime; 余 → forwardBars。
 * 未知 type → noneBar (求值时仍 default 不命中, 双重防御)。
 *
 * 注 (024 设计取舍): 到价类 (PRICE_RISE/FALL_TO) 仍归 `noneBar` — 盘中由 evaluate-intraday UC
 * 把实时价喂入 noneBar 单点 (high=low=close), EOD 喂收盘价, 两模同走 evaluatePrice 零改 (T009
 * 已落+绿)。仅 5min 差分类需「相邻 tick 价对」这一**新数据形态** → 独立 `realtime` 源, 保持
 * conditionDataNeed 数据源 1:1 映射 + 021 零回归零间接。
 */
export function conditionDataNeed(
  type: string,
): 'noneBar' | 'forwardBars' | 'fundamental' | 'realtime' {
  const meta = ALERT_CONDITION_META[type as AlertConditionType] as
    | (typeof ALERT_CONDITION_META)[AlertConditionType]
    | undefined;
  if (meta === undefined) return 'noneBar';
  if (meta.category === 'valuation') return 'fundamental';
  if (BASELINE_PRICE_TYPES.has(type)) return 'noneBar';
  if (REALTIME_DIFF_TYPES.has(type)) return 'realtime';
  return 'forwardBars';
}

/** snapshot 构造: param 0 / 无 dataDate → 不写键 (021 形状逐字节延续)。 */
function snap(
  c: EvaluableCondition,
  actual: number | Prisma.Decimal,
  dataDate?: string,
): ConditionHitSnapshot {
  return {
    type: c.type,
    threshold: c.threshold === null ? null : c.threshold.toFixed(4),
    actual: actual.toFixed(4),
    ...(c.param !== 0 ? { param: c.param } : {}),
    ...(dataDate !== undefined ? { dataDate } : {}),
  };
}

/** 021 价格 4 类 (Decimal 算术, 边界等号不被浮点污染; 口径 plan D7 全含等号)。 */
function evaluatePrice(c: EvaluableCondition, bar: EodBarSnapshot): ConditionHitSnapshot | null {
  if (c.threshold === null) return null; // 021 四类必带阈值; 缺失按不可判防御
  switch (c.type) {
    case 'PRICE_FALL_TO':
      return bar.low.lessThanOrEqualTo(c.threshold) ? snap(c, bar.low) : null;
    case 'PRICE_RISE_TO':
      return bar.high.greaterThanOrEqualTo(c.threshold) ? snap(c, bar.high) : null;
    case 'DAILY_GAIN_OVER':
    case 'DAILY_LOSS_OVER': {
      if (bar.prevClose === null || bar.prevClose.isZero()) return null; // 新上市/除零 → 不命中
      const pct = bar.close.minus(bar.prevClose).div(bar.prevClose).mul(HUNDRED);
      if (c.type === 'DAILY_GAIN_OVER') {
        return pct.greaterThanOrEqualTo(c.threshold) ? snap(c, pct) : null;
      }
      return pct.lessThanOrEqualTo(c.threshold.negated()) ? snap(c, pct) : null;
    }
    default:
      return null;
  }
}

/**
 * 024 盘中 5min 差分 (相邻 tick 涨跌幅, plan D3.3): (现价−上一tick价)/上一tick价×100。
 * 涨超 ≥t / 跌超 ≤−t (方向区分, FR-003)。首 tick / 无快照 / 上一tick价≤0 → 不命中
 * (FR-003 防御, 与「数据缺失不命中」一致)。actual = pct (number.toFixed(4), 同指标 number 口径)。
 */
function evaluateRealtimeDiff(
  c: EvaluableCondition,
  diff: RealtimeDiffInput | null | undefined,
): ConditionHitSnapshot | null {
  if (c.threshold === null || diff == null) return null;
  const { price, prevTickPrice } = diff;
  if (prevTickPrice === null || prevTickPrice <= 0) return null; // 首 tick / 重启 / 除零防御
  const t = c.threshold.toNumber();
  const pct = ((price - prevTickPrice) / prevTickPrice) * 100;
  const over = c.type === 'PRICE_RISE_5MIN_OVER' ? pct >= t : pct <= -t;
  return over ? snap(c, pct) : null;
}

/** 今/昨 close (穿越类边沿判定用; 不足 → null)。 */
function closesPair(bars: readonly IndicatorBar[]): [number | null, number | null] {
  const len = bars.length;
  return [len >= 1 ? bars[len - 1].close : null, len >= 2 ? bars[len - 2].close : null];
}

/** 价格扩展 (均线穿越 / 新高低 / 累计涨跌幅; 前复权序列)。 */
function evaluatePriceExtension(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const t = c.threshold === null ? null : c.threshold.toNumber();
  switch (c.type) {
    case 'MA_CROSS_UP':
    case 'MA_CROSS_DOWN': {
      const ma = movingAverage(bars, c.param);
      const [todayClose, yClose] = closesPair(bars);
      if (ma === null || ma.yesterday === null || todayClose === null || yClose === null) {
        return null; // 昨收<昨MA ∧ 今收≥今MA → 上穿 (下穿对称)
      }
      const crossed =
        c.type === 'MA_CROSS_UP'
          ? yClose < ma.yesterday && todayClose >= ma.today
          : yClose > ma.yesterday && todayClose <= ma.today;
      return crossed ? snap(c, todayClose) : null;
    }
    case 'NEW_HIGH':
    case 'NEW_LOW': {
      const nh = newHighLow(bars, c.param); // 今高>前N日高 (今低<前N日低)
      if (nh === null) return null;
      if (c.type === 'NEW_HIGH') return nh.todayHigh > nh.priorHigh ? snap(c, nh.todayHigh) : null;
      return nh.todayLow < nh.priorLow ? snap(c, nh.todayLow) : null;
    }
    case 'PERIOD_GAIN_OVER':
    case 'PERIOD_LOSS_OVER': {
      const pct = periodReturnPct(bars, c.param); // 涨 ≥t / 跌 ≤−t
      if (t === null || pct === null) return null;
      const over = c.type === 'PERIOD_GAIN_OVER' ? pct >= t : pct <= -t;
      return over ? snap(c, pct) : null;
    }
    default:
      return null;
  }
}

/** 成交量 (换手率原始口径 / 量比=今量/前5日均量)。 */
function evaluateVolume(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const t = c.threshold === null ? null : c.threshold.toNumber();
  if (t === null) return null;
  if (c.type === 'TURNOVER_RATE_OVER') {
    const tr = bars.length >= 1 ? bars[bars.length - 1].turnoverRate : null;
    return tr !== null && tr >= t ? snap(c, tr) : null;
  }
  if (c.type === 'VOLUME_RATIO_OVER') {
    const vr = volumeRatio(bars, 5);
    return vr !== null && vr >= t ? snap(c, vr) : null;
  }
  return null;
}

/** MACD 金叉死叉 (昨 DIF≤DEA ∧ 今 DIF>DEA → 金叉; 死叉对称)。 */
function evaluateMacd(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const m = macd(bars);
  if (m === null || m.dif.yesterday === null || m.dea.yesterday === null) return null;
  const crossed =
    c.type === 'MACD_GOLDEN_CROSS'
      ? m.dif.yesterday <= m.dea.yesterday && m.dif.today > m.dea.today
      : m.dif.yesterday >= m.dea.yesterday && m.dif.today < m.dea.today;
  return crossed ? snap(c, m.dif.today) : null;
}

/** KDJ 金叉死叉 (K 与 D 穿越) / 超买超卖 (J>100 / J<10 状态)。 */
function evaluateKdj(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const v = kdj(bars);
  if (v === null) return null;
  if (c.type === 'KDJ_OVERBOUGHT') return v.j.today > KDJ_OVERBOUGHT_J ? snap(c, v.j.today) : null;
  if (c.type === 'KDJ_OVERSOLD') return v.j.today < KDJ_OVERSOLD_J ? snap(c, v.j.today) : null;
  if (v.k.yesterday === null || v.d.yesterday === null) return null;
  const crossed =
    c.type === 'KDJ_GOLDEN_CROSS'
      ? v.k.yesterday <= v.d.yesterday && v.k.today > v.d.today
      : v.k.yesterday >= v.d.yesterday && v.k.today < v.d.today;
  return crossed ? snap(c, v.k.today) : null;
}

/** RSI 超买超卖 (阈值可调, 默认 70/30; 状态语义)。 */
function evaluateRsi(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const t = c.threshold === null ? null : c.threshold.toNumber();
  const r = rsi(bars);
  if (t === null || r === null) return null;
  const over = c.type === 'RSI_OVERBOUGHT' ? r.today >= t : r.today <= t;
  return over ? snap(c, r.today) : null;
}

/** BOLL 突破上轨/跌破下轨 (昨收在轨内 ∧ 今收出轨, 穿越事件)。 */
function evaluateBoll(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const b = boll(bars);
  const [todayClose, yClose] = closesPair(bars);
  if (b === null || b.upper.yesterday === null || b.lower.yesterday === null) return null;
  if (todayClose === null || yClose === null) return null;
  const broke =
    c.type === 'BOLL_BREAK_UPPER'
      ? yClose <= b.upper.yesterday && todayClose > b.upper.today
      : yClose >= b.lower.yesterday && todayClose < b.lower.today;
  return broke ? snap(c, todayClose) : null;
}

/** 技术指标分发 (MACD/KDJ/RSI/BOLL 各内聚子求值器)。 */
function evaluateTechnical(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  if (c.type === 'MACD_GOLDEN_CROSS' || c.type === 'MACD_DEATH_CROSS') return evaluateMacd(c, bars);
  if (c.type.startsWith('KDJ_')) return evaluateKdj(c, bars);
  if (c.type === 'RSI_OVERBOUGHT' || c.type === 'RSI_OVERSOLD') return evaluateRsi(c, bars);
  if (c.type === 'BOLL_BREAK_UPPER' || c.type === 'BOLL_BREAK_LOWER') return evaluateBoll(c, bars);
  return null;
}

/**
 * 价格扩展 / 成交量 / 技术指标 (前复权数值序列) — 按 meta 分类预派发到内聚子求值器。
 * 指标纯函数不足窗口 → null (warm-up); 穿越类今昨双值边沿判定。
 */
function evaluateForward(
  c: EvaluableCondition,
  bars: readonly IndicatorBar[],
): ConditionHitSnapshot | null {
  const category = ALERT_CONDITION_META[c.type as AlertConditionType]?.category;
  if (category === 'volume') return evaluateVolume(c, bars);
  if (category === 'technical') return evaluateTechnical(c, bars);
  return evaluatePriceExtension(c, bars); // price 扩展 (021 四类已被 conditionDataNeed 排除)
}

/**
 * 估值 10 类 (最新快照 + staleness gate)。无快照 / staleness null|>3 / 字段 null → 不命中。
 * 命中携 dataDate = 快照日 (FR-S01)。
 */
function evaluateValuation(
  c: EvaluableCondition,
  fundamental: FundamentalRow | null | undefined,
  staleness: number | null | undefined,
): ConditionHitSnapshot | null {
  if (c.threshold === null || fundamental == null) return null;
  if (staleness == null || staleness > STALENESS_MAX_TRADING_DAYS) return null; // plan D4
  const t = c.threshold.toNumber();

  /** 直比族: value 越阈即命中 (ABOVE ≥ / BELOW ≤, 含等号)。 */
  const direct = (value: number | null, above: boolean): ConditionHitSnapshot | null => {
    if (value === null) return null;
    return (above ? value >= t : value <= t) ? snap(c, value, fundamental.date) : null;
  };

  switch (c.type) {
    case 'PE_ABOVE':
      return direct(fundamental.peTtm, true);
    case 'PE_BELOW':
      return direct(fundamental.peTtm, false);
    case 'PB_ABOVE':
      return direct(fundamental.pb, true);
    case 'PB_BELOW':
      return direct(fundamental.pb, false);
    case 'DIVIDEND_YIELD_ABOVE':
      return direct(fundamental.dividendYield, true);
    case 'DIVIDEND_YIELD_BELOW':
      return direct(fundamental.dividendYield, false);
    case 'PE_PCTL_ABOVE':
      return direct(c.param === 5 ? fundamental.pePctlY5 : fundamental.pePctlY3, true);
    case 'PE_PCTL_BELOW':
      return direct(c.param === 5 ? fundamental.pePctlY5 : fundamental.pePctlY3, false);
    case 'PB_PCTL_ABOVE':
      return direct(c.param === 5 ? fundamental.pbPctlY5 : fundamental.pbPctlY3, true);
    case 'PB_PCTL_BELOW':
      return direct(c.param === 5 ? fundamental.pbPctlY5 : fundamental.pbPctlY3, false);
    default:
      return null;
  }
}

/** 单条件求值: 命中 → snapshot; 不命中/不可判 → null。按 conditionDataNeed 派发数据源。 */
function evaluateCondition(
  c: EvaluableCondition,
  inputs: EvaluationInputs,
): ConditionHitSnapshot | null {
  switch (conditionDataNeed(c.type)) {
    case 'noneBar':
      return evaluatePrice(c, inputs.noneBar);
    case 'forwardBars':
      return evaluateForward(c, inputs.forwardBars ?? []);
    case 'fundamental':
      return evaluateValuation(c, inputs.fundamental, inputs.fundamentalStaleness);
    case 'realtime':
      return evaluateRealtimeDiff(c, inputs.realtimeDiff);
  }
}

/**
 * AND 聚合求值: 全部命中 → snapshot 数组 (输入序); 任一不命中 (含空条件) → null。
 * 复杂度 O(n × 指标 O(window|序列)); V1 条件数 ≤4, 窗口 ≤520 → 微秒级 (SC-004 余量充足)。
 */
export function evaluateAlertConditions(
  conditions: readonly EvaluableCondition[],
  inputs: EvaluationInputs,
): ConditionHitSnapshot[] | null {
  if (conditions.length === 0) return null;
  const hits: ConditionHitSnapshot[] = [];
  for (const c of conditions) {
    const hit = evaluateCondition(c, inputs);
    if (hit === null) return null;
    hits.push(hit);
  }
  return hits;
}
