import type { DailyBarItem } from '@nvy/api-client';

// K 线几何折算（014 US4 / FR-M04·NFR）。015 EP4 `DailyBarItem`（OHLCV string）→ SVG 坐标。
// 渲染层（kline-chart.tsx）不可单测（per memory playwright rngh longpress drivable —— SVG/手势
// 非确定）；故价/量→坐标映射、抽样降采样（年 K 多年）、十字光标命中、OHLC legend 取值全落本
// 纯函数模块 + vitest 兜底。涨红跌绿（close>=open=up）；色由 component 取 quote token，本模块只出
// 'up'/'down' 方向。仅 `import type`（编译期擦除）→ spec 无须 mock @nvy/api-client。

export type CandleDirection = 'up' | 'down';

/** 解析后的数值蜡烛（OHLC 必有效；volume 缺失 → 0；prevClose 缺失 → null）。 */
export interface Candle {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number | null;
}

/** 图表画布尺寸 + 内边距（component 传入，默认锚 mockup KLineChart）。 */
export interface ChartDims {
  width: number;
  mainH: number; // 主图（蜡烛）高
  volH: number; // 成交量副图高
  padR: number; // 右价格轴留白
  padT: number; // 主图顶留白
  padB: number; // 底日期轴留白
  gap: number; // 主图与量副图间距
}

/** 默认尺寸（锚 mockup：width328/mainH214/volH60/padR46/gap22/padT8/padB18）。 */
export const DEFAULT_CHART_DIMS: ChartDims = {
  width: 328,
  mainH: 214,
  volH: 60,
  padR: 46,
  padT: 8,
  padB: 18,
  gap: 22,
};

/** 单蜡烛 SVG 几何（主图蜡烛 + 量副图柱）。坐标系 y 向下。 */
export interface CandleGeometry {
  index: number;
  x: number; // 中心 x（影线 + 量柱中心）
  bodyX: number; // 实体左 x
  bodyW: number; // 实体宽
  bodyY: number; // 实体顶 y
  bodyH: number; // 实体高（≥1）
  wickY1: number; // 影线高点 y（high）
  wickY2: number; // 影线低点 y（low）
  volY: number; // 量柱顶 y
  volBarH: number; // 量柱高
  direction: CandleDirection;
}

export interface PriceTick {
  value: number;
  y: number;
}
export interface DateTick {
  index: number;
  label: string;
  x: number;
}

/** 完整图表几何（component 一次取齐：蜡烛 + 价轴 + 日期轴 + 价格区间 + 量基线）。 */
export interface ChartGeometry {
  candles: CandleGeometry[];
  priceTicks: PriceTick[];
  dateTicks: DateTick[];
  hi: number;
  lo: number;
  baselineY: number; // 量副图基线 y（量柱底）
}

/** tradeDate（YYYY-MM-DD）→ 轴短标签：day/week → MM-DD；month 及以上 → YYYY-MM。 */
export function barLabel(tradeDate: string, period: string): string {
  const parts = tradeDate.split('-');
  if (parts.length < 3) return tradeDate;
  const [y, m, d] = parts;
  return period === 'day' || period === 'week' ? `${m}-${d}` : `${y}-${m}`;
}

/**
 * 解析 015 bars（string OHLCV）→ 数值蜡烛。OHLC 任一非数 → 丢该 bar（防御脏数据）；
 * volume null/非数 → 0；prevClose null/非数 → null。tradeDate 升序沿用 server 序。
 */
export function parseBars(items: DailyBarItem[]): Candle[] {
  const out: Candle[] = [];
  for (const it of items) {
    const open = Number.parseFloat(it.open);
    const high = Number.parseFloat(it.high);
    const low = Number.parseFloat(it.low);
    const close = Number.parseFloat(it.close);
    if (Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) {
      continue;
    }
    const v = it.volume == null ? NaN : Number.parseFloat(it.volume);
    const pc = it.prevClose == null ? NaN : Number.parseFloat(it.prevClose);
    out.push({
      tradeDate: it.tradeDate,
      open,
      high,
      low,
      close,
      volume: Number.isNaN(v) ? 0 : v,
      prevClose: Number.isNaN(pc) ? null : pc,
    });
  }
  return out;
}

/**
 * 等距降采样到 ≤ maxBars（年 K 多年防过密，NFR）。length ≤ maxBars → 原样返回；否则按步长抽样，
 * **必含首尾**（保区间端点）。maxBars < 2 视为 2（至少首尾）。
 */
export function downsample(candles: Candle[], maxBars: number): Candle[] {
  const cap = Math.max(2, Math.floor(maxBars));
  const n = candles.length;
  if (n <= cap) return candles;
  const out: Candle[] = [];
  const step = (n - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) {
    const c = candles[Math.round(i * step)]; // 索引 ∈ [0,n-1]（i·step ≤ n-1）→ 必有值
    if (c) out.push(c);
  }
  return out;
}

/** 价格区间（min low / max high + padRatio 上下留白）；空序列 → {hi:0,lo:0}；全平 → 撑开 ±1。 */
export function priceRange(candles: Candle[], padRatio = 0.06): { hi: number; lo: number } {
  if (candles.length === 0) return { hi: 0, lo: 0 };
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of candles) {
    if (k.high > hi) hi = k.high;
    if (k.low < lo) lo = k.low;
  }
  if (hi === lo) return { hi: hi + 1, lo: lo - 1 };
  const pad = (hi - lo) * padRatio;
  return { hi: hi + pad, lo: lo - pad };
}

/** 十字光标命中：pointer x（图表局部坐标）→ 蜡烛 index（夹到 [0,n-1]）。n=0 → -1。 */
export function hitTestIndex(x: number, dims: ChartDims, n: number): number {
  if (n <= 0) return -1;
  const plotW = dims.width - dims.padR;
  const slot = plotW / n;
  const i = Math.floor(x / slot);
  return Math.max(0, Math.min(n - 1, i));
}

/** OHLC legend 取值：选中蜡烛 + 相对前一根 changePct（首根无前根 → 0/up）+ 方向（close>=open）。 */
export function ohlcLegend(
  candles: Candle[],
  index: number,
): { candle: Candle; changePct: number; direction: CandleDirection } | null {
  const n = candles.length;
  if (n === 0) return null;
  const i = Math.max(0, Math.min(n - 1, index));
  const candle = candles[i]; // i ∈ [0,n-1]（已夹紧）→ 必有值
  if (!candle) return null;
  const prev = i > 0 ? candles[i - 1] : undefined;
  const base = prev?.close ?? candle.close;
  const changePct = base !== 0 ? ((candle.close - base) / base) * 100 : 0;
  return { candle, changePct, direction: candle.close >= candle.open ? 'up' : 'down' };
}

/**
 * 整图几何：蜡烛（影线 + 实体 + 量柱）+ 价轴刻度（gridLines+1 条）+ 日期轴（首/1-3/2-3/尾 4 点）。
 * 价格 y：padT + (hi-p)/(hi-lo)·(mainH-padT)；量 y：mainH+gap+(1-v/vmax)·(volH-4)。
 * 空序列 → 空几何（component 渲染空态）。
 */
export function buildChartGeometry(
  candles: Candle[],
  period: string,
  dims: ChartDims = DEFAULT_CHART_DIMS,
  gridLines = 4,
): ChartGeometry {
  const n = candles.length;
  const baselineY = dims.mainH + dims.gap + dims.volH;
  if (n === 0) {
    return { candles: [], priceTicks: [], dateTicks: [], hi: 0, lo: 0, baselineY };
  }

  const { hi, lo } = priceRange(candles);
  const plotW = dims.width - dims.padR;
  const slot = plotW / n;
  const bw = Math.max(2.2, slot * 0.62);

  let vmax = 0;
  for (const k of candles) if (k.volume > vmax) vmax = k.volume;

  const span = hi - lo || 1;
  const priceY = (p: number) => dims.padT + ((hi - p) / span) * (dims.mainH - dims.padT);
  const volTop = (v: number) =>
    vmax === 0 ? baselineY : dims.mainH + dims.gap + (1 - v / vmax) * (dims.volH - 4);

  const geos: CandleGeometry[] = candles.map((k, i) => {
    const x = slot * (i + 0.5);
    const yO = priceY(k.open);
    const yC = priceY(k.close);
    const top = Math.min(yO, yC);
    const volY = volTop(k.volume);
    return {
      index: i,
      x,
      bodyX: x - bw / 2,
      bodyW: bw,
      bodyY: top,
      bodyH: Math.max(1, Math.abs(yC - yO)),
      wickY1: priceY(k.high),
      wickY2: priceY(k.low),
      volY,
      volBarH: Math.max(0, baselineY - volY),
      direction: k.close >= k.open ? 'up' : 'down',
    };
  });

  const priceTicks: PriceTick[] = Array.from({ length: gridLines + 1 }, (_, i) => {
    const value = lo + (hi - lo) * (i / gridLines);
    return { value, y: priceY(value) };
  });

  const idxs = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const seen = new Set<number>();
  const dateTicks: DateTick[] = [];
  for (const i of idxs) {
    if (seen.has(i)) continue;
    const c = candles[i]; // i ∈ [0,n-1] → 必有值
    if (!c) continue;
    seen.add(i);
    dateTicks.push({ index: i, label: barLabel(c.tradeDate, period), x: slot * (i + 0.5) });
  }

  return { candles: geos, priceTicks, dateTicks, hi, lo, baselineY };
}
