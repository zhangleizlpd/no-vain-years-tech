import { Prisma } from '../generated/prisma/client';
import {
  QUALITY_CEILING_SPOT_RATIO,
  resolveCeilingAxis,
  type LegIntentTab,
} from './leg-recall.rules';

/**
 * 068 (ADR-0068 P2) —— 实时窄召回**第一段**的选码判据: 昨日 Δ 面 (sticky moneyness 查表) →
 * moneyness 包络 + pad → K-梯形窗。窗即召回: 出窗的 K 根本不外呼, 不再是 064 的呈现辅助。
 *
 * 🚨 **判据单点** (ADR-0064 不变量 ③): 窗的全部几何都在本文件, 🚫 adapter MUST NOT 手写包络 /
 * min / 比例。收租帽经 {@link resolveCeilingAxis} (067 axis 单点) —— 本文件自身也不写 `min`。
 */

/** 意图级 |Δ| 带, 闭区间。put 卖方视角取绝对值 (vendor 下发的 put Δ 为负, 本层统一 `abs`)。 */
export interface DeltaBand {
  readonly lower: Prisma.Decimal;
  readonly upper: Prisma.Decimal;
}

/**
 * 建仓/收租两带 + pad —— **2026-08-30 T010 全量回放定稿** (109 锚双期, 判据与分布见 spec
 * §标定实测; 带即规则口径 = user 裁决):
 * · build [0.10, 0.45] —— 窄执行带: 深实值折价接货腿 (|Δ|>0.45) 归离线宽视野, 盘中不进窄表。
 * · rent [0.03, 0.62] —— 上探到成色上界隐含 Δ (贴 min(spot,W)×1.03 的轻实值腿 Δ≈0.5-0.57),
 *   下探过真候选 p01 (0.032); 更深的边缘深虚 (实测仅 4 条 |Δ|<0.024) 蓄意不含。
 * · pad 0.025 —— sticky moneyness 双期漂移零漏的标定值。
 * 🚫 MUST NOT 在第二处出现这些参数 (`check-optionsdesk-rule-constants` #9 形状扫守带对象,
 * pad 子串扫; 调参只改这里)。
 */
export const BUILD_DELTA_BAND: DeltaBand = {
  lower: new Prisma.Decimal('0.10'),
  upper: new Prisma.Decimal('0.45'),
};
export const RENT_DELTA_BAND: DeltaBand = {
  lower: new Prisma.Decimal('0.03'),
  upper: new Prisma.Decimal('0.62'),
};
export const MONEYNESS_PAD_RATIO = new Prisma.Decimal('0.025');

/** 意图 → 带 的唯一映射 (adapter 按请求视角取, 🚫 MUST NOT 在别处再写一份 switch)。 */
export const DELTA_BAND_BY_INTENT: Readonly<Record<LegIntentTab, DeltaBand>> = {
  build: BUILD_DELTA_BAND,
  rent: RENT_DELTA_BAND,
};

/** |Δ| 落带判定 (闭区间) —— 第一段预测与第二段带标共用的**单点**。`O(1)`。 */
export function withinDeltaBand(delta: Prisma.Decimal, band: DeltaBand): boolean {
  const abs = delta.abs();
  return abs.greaterThanOrEqualTo(band.lower) && abs.lessThanOrEqualTo(band.upper);
}

/** 昨日面的一行: (K, 到期日) 的收盘 Δ。`delta = null` = vendor 未给 (部分缺失, 不参与包络)。 */
export interface DeltaFaceRow {
  readonly strike: Prisma.Decimal;
  readonly expiryDate: Date;
  readonly delta: Prisma.Decimal | null;
}

export interface DeltaSurfaceInput {
  /** 昨日面行, **调用方已按意图 DTE 段过滤到期日** (段语义不进本层, 恰好一处在召回常量)。 */
  readonly faceRows: readonly DeltaFaceRow[];
  /** 昨日 `underlyingSpot` —— **只用于 moneyness 折算** (068 Guardrail 3), 🚫 禁当今日窗基准。 */
  readonly previousSpot: Prisma.Decimal;
  /** 今日窗基准 (三级基准链产物), 同时是第二段 recall context 的 spot (同刻同值)。 */
  readonly spot: Prisma.Decimal;
  readonly band: DeltaBand;
  readonly pad: Prisma.Decimal;
  /** 收租视角供 W ⇒ 帽 = axis × (1 + 既有比例); 建仓视角 `null` = 无帽 (FR-003)。 */
  readonly w: Prisma.Decimal | null;
}

export type DeltaSurfaceOutcome =
  | {
      readonly kind: 'window';
      /** 进窗 K, 升序去重。「任一到期日预测落带」∩ 收租帽。 */
      readonly windowKs: readonly Prisma.Decimal[];
      /** 段内**全部**到期日, 升序 —— 进窗 K 逐一附带, fwd 阶梯不断链 (FR-002)。 */
      readonly expiries: readonly Date[];
      /** `${K}|${YYYY-MM-DD}` → 第一段预测是否落带 (带外横档的预判面, 终判用同批实时 Δ)。 */
      readonly bandPrediction: ReadonlyMap<string, boolean>;
    }
  | {
      /** 整面零 Δ 读数 (新锚首日 / vendor 整批缺 greeks) ⇒ 显式判 bootstrap, 非异常。 */
      readonly kind: 'bootstrap';
    };

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 昨日 Δ 面 → K-梯形窗。复杂度 `O(n + K×E)` (n = 面行数, K = 行权价档数, E = 到期日数)。
 *
 * 机制 (plan D2): 逐到期日取「|Δ| 落带」的 K 区间 → 折 moneyness (÷ 昨日 spot) → ± pad →
 * 乘今日 spot 得该到期日的 K 界; K 级进窗 = **任一**到期日界内; 进窗 K 附段内**全部**到期日。
 * 某到期日整列无落带行 ⇒ 该到期日不贡献区间 (但仍在 `expiries` 里被附带)。
 */
export function resolveDeltaSurfaceWindow(input: DeltaSurfaceInput): DeltaSurfaceOutcome {
  const { faceRows, previousSpot, spot, band, pad, w } = input;

  const readable = faceRows.filter((r) => r.delta !== null);
  if (readable.length === 0) return { kind: 'bootstrap' };

  // 逐到期日的落带 K 区间 (昨日 K 口径)
  const inBandByExpiry = new Map<string, { lo: Prisma.Decimal; hi: Prisma.Decimal }>();
  for (const row of readable) {
    if (!withinDeltaBand(row.delta as Prisma.Decimal, band)) continue;
    const key = isoDate(row.expiryDate);
    const kept = inBandByExpiry.get(key);
    if (kept === undefined) {
      inBandByExpiry.set(key, { lo: row.strike, hi: row.strike });
    } else {
      if (row.strike.lessThan(kept.lo)) kept.lo = row.strike;
      if (row.strike.greaterThan(kept.hi)) kept.hi = row.strike;
    }
  }

  // moneyness 折算 + pad → 今日 K 界 (每到期日一条)
  const one = new Prisma.Decimal(1);
  const kBoundsByExpiry = new Map<string, { lo: Prisma.Decimal; hi: Prisma.Decimal }>();
  for (const [key, { lo, hi }] of inBandByExpiry) {
    kBoundsByExpiry.set(key, {
      lo: lo.div(previousSpot).times(one.minus(pad)).times(spot),
      hi: hi.div(previousSpot).times(one.plus(pad)).times(spot),
    });
  }

  // K 宇宙 = 面上出现过的行权价 (去重升序); 到期日 = 段内全部 (去重升序)
  const kUniverse = [
    ...new Map(faceRows.map((r) => [r.strike.toString(), r.strike])).values(),
  ].sort((a, b) => a.comparedTo(b));
  const expiries = [
    ...new Map(faceRows.map((r) => [isoDate(r.expiryDate), r.expiryDate])).values(),
  ].sort((a, b) => a.getTime() - b.getTime());

  const bandPrediction = new Map<string, boolean>();
  const predicted: Prisma.Decimal[] = [];
  for (const k of kUniverse) {
    let anyInBand = false;
    for (const expiry of expiries) {
      const bounds = kBoundsByExpiry.get(isoDate(expiry));
      const inBand =
        bounds !== undefined && k.greaterThanOrEqualTo(bounds.lo) && k.lessThanOrEqualTo(bounds.hi);
      bandPrediction.set(`${k.toString()}|${isoDate(expiry)}`, inBand);
      if (inBand) anyInBand = true;
    }
    if (anyInBand) predicted.push(k);
  }

  // 收租帽: K ≤ axis × (1 + 既有比例) —— axis 经 067 单点, 比例经 052 单点, 零第二份
  const cap =
    w === null ? null : resolveCeilingAxis(spot, w).times(QUALITY_CEILING_SPOT_RATIO.plus(1));
  const windowKs = cap === null ? predicted : predicted.filter((k) => k.lessThanOrEqualTo(cap));

  return { kind: 'window', windowKs, expiries, bandPrediction };
}
