import { Prisma } from '../generated/prisma/client.js';

/**
 * 读时换算纯函数 (020 T002, US1, plan D1/D2; 2026-06-05 模型改判后比值口径)。
 *
 * 存储只物化 none 行 + per-event 复权跃变 f_i (AdjustmentFactor, 锚自 vendor backward
 * 跨除权日比值 — T001 实证跨事件比值是 vendor 数据唯一不变量, 绝对水位随查询窗口平移)。
 * 读时累积 `B(t) = ∏ f_i (exDate_i ≤ t)` (首个已存事件前 B=1 约定):
 *   backward(t) = none(t) × B(t)
 *   forward(t)  = none(t) × B(t) / B_latest   (B_latest = 全版本乘积, 不限 bar 窗口)
 * prevClose 跨段边界: t 恰为某版本 exDate → 用前段 B (= 前一交易日所在段, AS-3); 否则同段。
 * 价格字段乘后 `.toFixed(4)` 保持 DailyBar Decimal(18,4) 刻度 (019 推导同款);
 * volume/amount/turnoverRate 直拷。
 *
 * 复杂度: O(n + m log m) (n = bar 数, m = 版本数; bars 升序前提下两指针线性, 版本排序主导)。
 */

/** none 行最小投影 (调用方保证 tradeDate 升序, YYYY-MM-DD 字典序即时序)。 */
export interface AdjustableBarRow {
  /** YYYY-MM-DD */
  tradeDate: string;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  /** 官方涨跌幅 (百分数)。**复权不变量** — forward/backward 与 none 同值, 经 `{...bar}` 直透不 scale。 */
  changePct: Prisma.Decimal | null;
  prevClose: Prisma.Decimal | null;
  volume: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  turnoverRate: Prisma.Decimal | null;
}

/** 因子版本 (AdjustmentFactor 行投影): exDate 处的 per-event 跃变 f_i (> 0)。 */
export interface FactorJumpVersion {
  /** YYYY-MM-DD (除权日 = 版本边界)。 */
  exDate: string;
  factorJump: Prisma.Decimal;
}

const ONE = new Prisma.Decimal(1);

/** 跃变防御: ≤0 / 非法值按 1 (数据破损隔离, 不 throw 不传染后续版本)。 */
function jumpOrOne(v: Prisma.Decimal): Prisma.Decimal {
  return v.isFinite() && v.greaterThan(0) ? v : ONE;
}

/**
 * none 行 × 跃变版本 → forward/backward 派生序列 (none 口径不经此函数, usecase
 * early-return 原查询, SC-A04)。
 */
export function deriveAdjustedBars<T extends AdjustableBarRow>(
  noneBars: T[],
  factorVersions: FactorJumpVersion[],
  adjust: 'forward' | 'backward',
): T[] {
  if (noneBars.length === 0) return [];
  const versions = [...factorVersions].sort((a, b) => a.exDate.localeCompare(b.exDate));

  // B_latest = 全版本乘积 (forward 基准 = 标的当前状态, 含 exDate > bar 窗口的已锚版本)。
  let bLatest = ONE;
  for (const v of versions) bLatest = bLatest.mul(jumpOrOne(v.factorJump));
  const base = adjust === 'forward' ? bLatest : ONE;

  let vi = -1; // 已进入段的版本指针 (versions[vi].exDate ≤ t)。
  let cur = ONE; // B(t) running product。
  let prevSeg = ONE; // B(前一段) — exDate 当日 prevClose 用。
  const scale = (d: Prisma.Decimal, f: Prisma.Decimal) =>
    new Prisma.Decimal(d.mul(f).div(base).toFixed(4));

  return noneBars.map((bar) => {
    while (vi + 1 < versions.length && versions[vi + 1].exDate <= bar.tradeDate) {
      vi++;
      prevSeg = cur;
      cur = cur.mul(jumpOrOne(versions[vi].factorJump));
    }
    const prevFactor = vi >= 0 && versions[vi].exDate === bar.tradeDate ? prevSeg : cur;
    return {
      ...bar,
      open: scale(bar.open, cur),
      high: scale(bar.high, cur),
      low: scale(bar.low, cur),
      close: scale(bar.close, cur),
      prevClose: bar.prevClose === null ? null : scale(bar.prevClose, prevFactor),
    };
  });
}
