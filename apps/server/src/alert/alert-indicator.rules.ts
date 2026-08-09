/**
 * 023 预警指标计算纯函数 (T009 窗口统计 / T010 递推指标; ADR-0043 §4 rules 无副作用)。
 *
 * 输入 = 前复权后 bar 升序序列 (evaluate-alerts.usecase 经 marketdata `deriveAdjustedBars`
 * (…,'forward') 换算后投影为数值 shape, plan D1/D2)。本文件纯算术 (number/double)——
 * 不依赖 Prisma.Decimal: 指标公式含 EMA 递推 / 样本方差, Decimal 既无收益 (SC-002 容差
 * ≤1%, double 远超) 又拖慢 520 根递推。「金叉/超买」等业务语义在 alert (plan §指标归属)。
 *
 * 职责边界 (沿 021 alert-evaluation.rules 分工): 本文件只产指标值——事件类条件 (穿越/
 * 金叉) 需今昨双值 → 返回 {today, yesterday}; 状态/阈值/穿越的比较留给 alert-evaluation
 * .rules (T011)。
 *
 * 通达信/同花顺口径 (plan D5, SC-002 对照锚; 公式常量留痕见 alert-condition-meta.ts 头)：
 *   MA(C,N)        = 近 N 根 close 算术均值
 *   EMA(X,N)       = (2·X + (N−1)·EMA') / (N+1)，EMA[0]=X[0] (种子自序列首根)
 *   SMA(X,N,M)     = (M·X + (N−M)·SMA') / N
 *   STD(C,N)       = 样本标准差 (除以 N−1)
 *
 * warm-up 契约: 窗口类「前 N 日不含今日」需 N+1 根 (NEW_HIGH(250) 需 251, plan D5);
 * MA(N) 今值需 N 根 / 昨值需 N+1; 递推类种子自首根、结构性最小 2 根 (可判穿越)——历史
 * 充分性 (递推 init 误差) 由调用方读 520 根兜 (plan D5), 本层只保证公式正确性。
 * 不足 → 返回 null (warm-up 不命中, 调用方按条件聚合; 混合预警可算条件照算, spec Edge)。
 *
 * 复杂度: 窗口类 O(window); 递推类 O(n) 单遍 (n = bar 数)。
 */

/** 指标输入 bar 最小投影 (前复权数值序列; tradeDate 升序由调用方保证)。 */
export interface IndicatorBar {
  /** YYYY-MM-DD */
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  volume: number | null;
  turnoverRate: number | null;
}

/** 今昨双值 (事件类穿越判定用; yesterday null = 昨值窗口不足 warm-up)。 */
export interface TodayYesterday {
  today: number;
  yesterday: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// T009: 窗口统计 (MA / 新高低 / 累计涨跌幅 / 量比)
// ─────────────────────────────────────────────────────────────────────────────

/** [from, from+count) 区间 close 均值 (count>0 调用方保证)。 */
function meanClose(bars: readonly IndicatorBar[], from: number, count: number): number {
  let sum = 0;
  for (let i = from; i < from + count; i++) sum += bars[i].close;
  return sum / count;
}

/**
 * MA(C,N) 今昨双值 (MA_CROSS_UP/DOWN 用)。len<N → null (今值不可算);
 * len===N → 今值算、昨值 null; len>N → 双值。
 */
export function movingAverage(
  bars: readonly IndicatorBar[],
  period: number,
): TodayYesterday | null {
  const len = bars.length;
  if (period <= 0 || len < period) return null;
  const today = meanClose(bars, len - period, period);
  const yesterday = len >= period + 1 ? meanClose(bars, len - period - 1, period) : null;
  return { today, yesterday };
}

/** 新高低极值: 今日 high/low vs 前 N 日 (不含今日) 极值。warm-up 需 N+1 根。 */
export interface NewHighLow {
  todayHigh: number;
  todayLow: number;
  /** 前 N 日 (不含今日) 最高 high。 */
  priorHigh: number;
  /** 前 N 日 (不含今日) 最低 low。 */
  priorLow: number;
}

/**
 * N 日新高低 (NEW_HIGH/NEW_LOW 用, plan D5「今高 vs 前 N 日 max 不含今日」)。
 * 需 N 根前置 → len ≥ N+1 否则 null (NEW_HIGH(250) 需 251)。比较 (新高=todayHigh>priorHigh)
 * 留给求值层。
 */
export function newHighLow(bars: readonly IndicatorBar[], window: number): NewHighLow | null {
  const len = bars.length;
  if (window <= 0 || len < window + 1) return null;
  const today = bars[len - 1];
  let priorHigh = -Infinity;
  let priorLow = Infinity;
  for (let i = len - 1 - window; i < len - 1; i++) {
    if (bars[i].high > priorHigh) priorHigh = bars[i].high;
    if (bars[i].low < priorLow) priorLow = bars[i].low;
  }
  return { todayHigh: today.high, todayLow: today.low, priorHigh, priorLow };
}

/**
 * N 交易日累计涨跌幅 % (PERIOD_GAIN/LOSS_OVER 用): (今收 − N 日前收)/N 日前收 ×100。
 * 需 len ≥ N+1; N 日前收 ≤0 → null (除零/异常防御)。正负号保留, 阈值方向比较留求值层。
 */
export function periodReturnPct(bars: readonly IndicatorBar[], days: number): number | null {
  const len = bars.length;
  if (days <= 0 || len < days + 1) return null;
  const base = bars[len - 1 - days].close;
  if (base <= 0) return null;
  return ((bars[len - 1].close - base) / base) * 100;
}

/**
 * 量比 (VOLUME_RATIO_OVER 用): 今量 / 前 window 日均量 (默认 5, plan「前 5 日均量」)。
 * 需 len ≥ window+1; 今量或任一前置量 null / 均量 ≤0 → null。
 */
export function volumeRatio(bars: readonly IndicatorBar[], window = 5): number | null {
  const len = bars.length;
  if (window <= 0 || len < window + 1) return null;
  const todayVol = bars[len - 1].volume;
  if (todayVol === null) return null;
  let sum = 0;
  for (let i = len - 1 - window; i < len - 1; i++) {
    const v = bars[i].volume;
    if (v === null) return null;
    sum += v;
  }
  const avg = sum / window;
  if (avg <= 0) return null;
  return todayVol / avg;
}

// ─────────────────────────────────────────────────────────────────────────────
// T010: 递推指标 (MACD / KDJ / RSI / BOLL) — 通达信口径 (plan D5)
// ─────────────────────────────────────────────────────────────────────────────

/** EMA(X,N) 全序列: Y[0]=X[0], Y[i]=(2·X[i]+(N−1)·Y[i−1])/(N+1)。O(n)。 */
function emaSeries(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length);
  const a = (period - 1) / (period + 1);
  const b = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    out[i] = i === 0 ? values[0] : b * values[i] + a * out[i - 1];
  }
  return out;
}

/**
 * SMA(X,N,M) 全序列 (通达信权移平均, M<N): Y[i]=(M·X[i]+(N−M)·Y[i−1])/N。
 * seedPrev = Y[−1] 假想前值 (KDJ 传 50; RSI 传 X[0] 使 Y[0]=X[0])。O(n)。
 */
function smaSeries(values: readonly number[], n: number, m: number, seedPrev: number): number[] {
  const out = new Array<number>(values.length);
  let prev = seedPrev;
  for (let i = 0; i < values.length; i++) {
    out[i] = (m * values[i] + (n - m) * prev) / n;
    prev = out[i];
  }
  return out;
}

/** 取序列末两值为今昨双值 (len≥2 调用方保证)。 */
function lastTwo(series: readonly number[]): TodayYesterday {
  const len = series.length;
  return { today: series[len - 1], yesterday: len >= 2 ? series[len - 2] : null };
}

export interface MacdValue {
  dif: TodayYesterday;
  dea: TodayYesterday;
}

/**
 * MACD (MACD_GOLDEN_CROSS/DEATH_CROSS 用): DIF=EMA(C,fast)−EMA(C,slow), DEA=EMA(DIF,signal)。
 * 金叉=DIF 上穿 DEA (今昨双值比较留求值层)。len<2 → null (无法判穿越)。
 */
export function macd(
  bars: readonly IndicatorBar[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdValue | null {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = emaSeries(dif, signal);
  return { dif: lastTwo(dif), dea: lastTwo(dea) };
}

export interface KdjValue {
  k: TodayYesterday;
  d: TodayYesterday;
  j: TodayYesterday;
}

/**
 * KDJ (KDJ_GOLDEN/DEATH_CROSS=金叉死叉事件 / KDJ_OVERBOUGHT(J>100)/OVERSOLD(J<10)=状态):
 * RSV=(C−LLV(L,n))/(HHV(H,n)−LLV(L,n))×100, K=SMA(RSV,3,1), D=SMA(K,3,1), J=3K−2D (K/D 初值 50)。
 * HHV==LLV (平盘极端) → RSV=0 防除零。len<2 → null。
 */
export function kdj(bars: readonly IndicatorBar[], n = 9): KdjValue | null {
  const len = bars.length;
  if (len < 2) return null;
  const rsv = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    let hhv = -Infinity;
    let llv = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      if (bars[j].high > hhv) hhv = bars[j].high;
      if (bars[j].low < llv) llv = bars[j].low;
    }
    rsv[i] = hhv === llv ? 0 : ((bars[i].close - llv) / (hhv - llv)) * 100;
  }
  const k = smaSeries(rsv, 3, 1, 50);
  const d = smaSeries(k, 3, 1, 50);
  const j = k.map((kv, i) => 3 * kv - 2 * d[i]);
  return { k: lastTwo(k), d: lastTwo(d), j: lastTwo(j) };
}

/**
 * RSI(N) (RSI_OVERBOUGHT/OVERSOLD 状态, 默认阈值 70/30):
 * SMA(MAX(C−LC,0),N,1) / SMA(ABS(C−LC),N,1) × 100 (Wilder 1/N 递推, LC=前根 close)。
 * 序列首根无前值 → 涨跌序列自第 2 根起 (520 根读量下首根衰减可忽略, plan D5);
 * SMD==0 (无下跌) → RSI=100。今昨双值需 ≥3 根, 否则 null。
 */
export function rsi(bars: readonly IndicatorBar[], period = 14): TodayYesterday | null {
  const len = bars.length;
  if (len < 3) return null;
  const ups: number[] = [];
  const dns: number[] = [];
  for (let i = 1; i < len; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    ups.push(Math.max(diff, 0));
    dns.push(Math.abs(diff));
  }
  const smu = smaSeries(ups, period, 1, ups[0]);
  const smd = smaSeries(dns, period, 1, dns[0]);
  const rsiSeries = smu.map((u, i) => (smd[i] === 0 ? 100 : (u / smd[i]) * 100));
  return lastTwo(rsiSeries);
}

export interface BollValue {
  mid: TodayYesterday;
  upper: TodayYesterday;
  lower: TodayYesterday;
}

/**
 * BOLL (BOLL_BREAK_UPPER/LOWER=穿越事件): MID=MA(C,N), UP/DN=MID±mult×STD(C,N) (样本标准差 /(N−1))。
 * 今值需 N 根, 昨值需 N+1。len<N → null。
 */
export function boll(bars: readonly IndicatorBar[], period = 20, mult = 2): BollValue | null {
  const len = bars.length;
  if (period <= 1 || len < period) return null;
  // 末根 (今) 必算; 末前根 (昨) 当 len≥period+1 才算。
  const band = (end: number): { mid: number; upper: number; lower: number } => {
    let sum = 0;
    for (let i = end - period + 1; i <= end; i++) sum += bars[i].close;
    const mid = sum / period;
    let sq = 0;
    for (let i = end - period + 1; i <= end; i++) sq += (bars[i].close - mid) ** 2;
    const std = Math.sqrt(sq / (period - 1));
    return { mid, upper: mid + mult * std, lower: mid - mult * std };
  };
  const t = band(len - 1);
  const y = len >= period + 1 ? band(len - 2) : null;
  return {
    mid: { today: t.mid, yesterday: y ? y.mid : null },
    upper: { today: t.upper, yesterday: y ? y.upper : null },
    lower: { today: t.lower, yesterday: y ? y.lower : null },
  };
}
