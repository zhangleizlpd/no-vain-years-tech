import { Prisma } from '../generated/prisma/client.js';
import type { BarPeriod, EodBarPoint } from './marketdata.types.js';

/**
 * marketdata 读侧纯函数 (015 T007, US3/US4)。无 I/O、无 DI — 输入决定输出, 全套 vitest
 * 无 DB 可测。金融数值用 `Prisma.Decimal` (Decimal.js, 零新 dep) 精确计算, 跨边界产出
 * **string** (FR-S08: 禁 Float)。价格类一律 4 位小数 (DailyBar OHLC = Decimal(18,4)),
 * 与 Mock fixture / 详情 / K线序列化口径一致。
 */

/** Decimal 可接受形态: string (端口 DTO) 或 Prisma.Decimal (PG row)。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

/**
 * canonical `market:code` 解析 (报价/详情/K线共用)。非法形态 (无市场段 / 无代码段) → null;
 * 调用方据语境落 no-data (报价) 或 404 (详情/K线), 不在此抛。
 */
export function parseCanonicalSymbol(symbol: string): { market: string; code: string } | null {
  const idx = symbol.indexOf(':');
  if (idx <= 0 || idx === symbol.length - 1) return null;
  return { market: symbol.slice(0, idx), code: symbol.slice(idx + 1) };
}

/**
 * 价格/金额统一 4 位小数 string。null 透传 (缺失维度不报错, detail field coverage)。
 * 重载: 非 null 入参 → 必返 string (省去调用方 `!`); 含 null 入参 → string | null。
 */
export function decimalToString(v: Decimalish): string;
export function decimalToString(v: Decimalish | null): string | null;
export function decimalToString(v: Decimalish | null): string | null {
  return v === null ? null : D(v).toFixed(4);
}

/**
 * 前收算涨跌 (FR-S07)。change = close - prevClose; changePct = change/prevClose*100 (%)。
 * close 或 prevClose 缺 → 双 null (无前收无法算涨跌, 不伪造)。prevClose=0 → change 可算但
 * changePct 置 null (除零保护)。
 */
export function computeChange(
  close: Decimalish | null,
  prevClose: Decimalish | null,
): { change: string | null; changePct: string | null } {
  if (close === null || prevClose === null) return { change: null, changePct: null };
  const c = D(close);
  const p = D(prevClose);
  const change = c.minus(p);
  if (p.isZero()) return { change: change.toFixed(4), changePct: null };
  return { change: change.toFixed(4), changePct: change.div(p).times(100).toFixed(4) };
}

/**
 * 由**官方涨跌幅**反推涨跌额 (3b 终局口径, 015 follow-up)。changePct = 百分数 (理杏仁 ex_rights
 * `change`×100, 已含除权除息调整 → 除权日 ≠ 相邻收盘差)。官方昨收 = close/(1+changePct/100);
 * change = close - 官方昨收。close / changePct 任一缺 → 双 null (无官方值不伪造)。分母为 0
 * (changePct = -100%, 退市归零, 不可能日内发生) → change null。changePct 缺但有 prevClose
 * (未来实时源下发真昨收) → 调用方回退 {@link computeChange}(close, prevClose)。
 */
export function changeFromPct(
  close: Decimalish | null,
  changePct: Decimalish | null,
): { change: string | null; changePct: string | null } {
  if (close === null || changePct === null) return { change: null, changePct: null };
  const c = D(close);
  const pct = D(changePct);
  const denom = D('1').plus(pct.div(100));
  if (denom.isZero()) return { change: null, changePct: pct.toFixed(4) };
  return { change: c.minus(c.div(denom)).toFixed(4), changePct: pct.toFixed(4) };
}

/** 官方昨收 = close/(1+changePct/100) (changePct 百分数)。changePct 缺 / 分母 0 → null。 */
function impliedPrevClose(close: Decimalish, changePct: string | null): Prisma.Decimal | null {
  if (changePct === null) return null;
  const denom = D('1').plus(D(changePct).div(100));
  return denom.isZero() ? null : D(close).div(denom);
}

/** 52 周高低只需 close + tradeDate; 兼容端口 DTO (string) 与 PG row (Decimal)。 */
type CloseBar = { tradeDate: string; close: Decimalish };

/**
 * 52 周高低 (FR-S07 / detail field coverage): 近 252 个交易日 close 的 max/min。
 * 取末 252 个 (按 tradeDate 降序), 空序列 → 双 null。
 */
export function fiftyTwoWeekHighLow(bars: readonly CloseBar[]): {
  high: string | null;
  low: string | null;
} {
  if (bars.length === 0) return { high: null, low: null };
  const recent = [...bars].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).slice(0, 252);
  let hi = D(recent[0].close);
  let lo = D(recent[0].close);
  for (const bar of recent) {
    const close = D(bar.close);
    if (close.gt(hi)) hi = close;
    if (close.lt(lo)) lo = close;
  }
  return { high: hi.toFixed(4), low: lo.toFixed(4) };
}

/** ISO-8601 周键 `YYYY-Www` (周一为周首, 周四定年)。tradeDate = `YYYY-MM-DD`。 */
function isoWeekKey(tradeDate: string): string {
  const d = new Date(`${tradeDate}T00:00:00Z`);
  const dayMon0 = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dayMon0 + 3); // 平移到本周周四 (ISO 定年日)
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstMon0 = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstMon0 + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** period 分桶键: 同桶的日线聚合为一根。day 直返 tradeDate (一日一桶)。 */
function periodKey(tradeDate: string, period: BarPeriod): string {
  const [y, m] = tradeDate.split('-');
  switch (period) {
    case 'day':
      return tradeDate;
    case 'week':
      return isoWeekKey(tradeDate);
    case 'month':
      return `${y}-${m}`;
    case 'quarter':
      return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
    case 'year':
      return y;
  }
}

const decAdd = (a: string | null, b: string | null): string | null =>
  a === null && b === null
    ? null
    : D(a ?? '0')
        .plus(b ?? '0')
        .toString();

/**
 * K线 period 聚合 (FR-S06): 日线 → 周/月/季/年。每桶: open=首日开、high=区间最高、
 * low=区间最低、close=末日收、volume/amount=区间和; changePct=期间收益 (期末收 vs 桶首日
 * 官方昨收)、prevClose=桶首日官方昨收 (stored ?? 由 changePct 反推, 与 changePct 自洽)、
 * turnoverRate=null (聚合无意义)。tradeDate=桶内末交易日。输入须按 tradeDate 升序 (端口契约);
 * `period='day'` 原样返 (deep copy 防别名, changePct 直透单日官方值)。空序列 → 空数组。
 */
export function aggregateBars(bars: readonly EodBarPoint[], period: BarPeriod): EodBarPoint[] {
  if (bars.length === 0) return [];
  if (period === 'day') return bars.map((b) => ({ ...b }));

  const buckets = new Map<string, EodBarPoint>();
  const firstPrev = new Map<string, Prisma.Decimal | null>(); // 桶首日官方昨收
  for (const bar of bars) {
    const key = periodKey(bar.tradeDate, period);
    const acc = buckets.get(key);
    if (!acc) {
      buckets.set(key, { ...bar });
      // 桶首日昨收: stored 优先 (未来实时源真昨收), 缺则由官方 changePct 反推。
      firstPrev.set(
        key,
        bar.prevClose !== null ? D(bar.prevClose) : impliedPrevClose(bar.close, bar.changePct),
      );
      continue;
    }
    // bars 升序 → 后到的是更晚交易日: 更新末收/末日, 累计区间高低与量。
    acc.high = D(bar.high).gt(D(acc.high)) ? bar.high : acc.high;
    acc.low = D(bar.low).lt(D(acc.low)) ? bar.low : acc.low;
    acc.close = bar.close;
    acc.tradeDate = bar.tradeDate;
    acc.volume = decAdd(acc.volume, bar.volume);
    acc.amount = decAdd(acc.amount, bar.amount);
    acc.turnoverRate = null;
  }
  // 桶级涨跌: 期末收 vs 桶首日官方昨收 (复权不变量在日线层, 聚合层按期间重算)。
  for (const [key, acc] of buckets) {
    const pc = firstPrev.get(key) ?? null;
    acc.prevClose = pc === null ? null : pc.toFixed(4);
    acc.changePct = pc === null ? null : computeChange(acc.close, pc).changePct;
  }
  return [...buckets.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}
