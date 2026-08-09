// 046 T022 — 波动温度计屏（P7）纯函数（FR-015/016/017/018/019/035/036, plan D9）。
// 屏与子件只做接线，判定全在这里（体例同 T021 `underlying-detail.rules.ts`）。
// 渲染 / 交互 / a11y 走 T024 Playwright e2e —— 本仓测试分层 vitest=logic / Playwright=UI。
//
// 🚨 **不呈现 regime 读数**（FR-015 📌，2026-08-03 拍板）—— vault §8 未给 N/X 的机械判据，
//    且把它定性为「波动连续谱 + 温度计的极致读数 + 人判 + 无 gate」。mockup 帧⑦ 画了
//    `regime N`，**别照抄回来**；server DTO 里也没有该字段。本文件的视图键面是防回归。
// 🚨 **FR-017 指针不可回落 0** —— 指数不可得时 {@link VixGaugeView.pointerAngle} 恒 `null`。
//    指针停在 0 会被读成「极度平静」，那是**错误信息**而不是缺失信息。
// 🚨 **FR-016 比值只在同基准上成立** —— 基准判定在 server（两侧 asOf 不同日就不算），
//    前端**不补算**：四态里只有 `available` 出数值，其余三态零值面。
// 🚨 **IVP 档位复用 T021 常量**（`IVP_TIER_BOUNDARIES` / `ivReadoutView`）—— 25/70/90 一套
//    阈值两处消费，MUST NOT 在本片另立第二套（FR-036）。
import type {
  ThermometerResponse,
  ThermometerUnderlyingRowResponse,
  UsIndexReadoutResponse,
  UsIndexReadoutResponseState,
  VvixVixRatioResponse,
  VvixVixRatioResponseState,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  freshnessOf,
  ivReadoutView,
  toFinite,
  type Freshness,
  type IvReadoutView,
} from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.thermometer;

// ═══════════════════ ① 表盘几何（FR-015） ═══════════════════

/**
 * 半圆量程。VIX 历史极值 82.69（2020-03-16），量程取 60 —— 超量程钳到最右端而不是
 * 把整条刻度稀释掉（>60 已属「数年一遇」，落在最右端本身就是正确读数）。
 */
export const VIX_GAUGE_MIN = 0;
export const VIX_GAUGE_MAX = 60;

/** 档位分界（FR-015：平静 `<20` / 抬升 `20–30` / 高波 `>30`）。 */
export const VIX_CALM_MAX = 20;
export const VIX_ELEVATED_MAX = 30;

export const VIX_TIERS = ['calm', 'elevated', 'high'] as const;

export type VixTier = (typeof VIX_TIERS)[number];

/** 半圆：左端 180°、正上 270°、右端 360°（SVG 屏幕坐标系，y 轴向下）。 */
const GAUGE_FROM_DEG = 180;
const GAUGE_TO_DEG = 360;

/** 值 → 指针角（度）。越量程钳到端点，绝不产生半圆外的指针。复杂度 O(1)。 */
export function gaugeAngle(value: number): number {
  const clamped = Math.min(VIX_GAUGE_MAX, Math.max(VIX_GAUGE_MIN, value));
  const ratio = (clamped - VIX_GAUGE_MIN) / (VIX_GAUGE_MAX - VIX_GAUGE_MIN);
  return GAUGE_FROM_DEG + ratio * (GAUGE_TO_DEG - GAUGE_FROM_DEG);
}

/** 值 → 档。分界值 20 / 30 **都归「抬升」**（平静是严格 `<20`、高波是严格 `>30`）。O(1)。 */
export function vixTier(value: number): VixTier {
  if (value > VIX_ELEVATED_MAX) return 'high';
  if (value >= VIX_CALM_MAX) return 'elevated';
  return 'calm';
}

export interface GaugeArc {
  tier: VixTier;
  fromDeg: number;
  toDeg: number;
}

/**
 * 三段弧（角度由 {@link gaugeAngle} 派生 ⇒ 改阈值时弧与档位判定**不可能脱节**）。
 * 首尾相接覆盖整个半圆，中间无缝无叠。
 */
export const VIX_GAUGE_ARCS: readonly GaugeArc[] = [
  { tier: 'calm', fromDeg: gaugeAngle(VIX_GAUGE_MIN), toDeg: gaugeAngle(VIX_CALM_MAX) },
  { tier: 'elevated', fromDeg: gaugeAngle(VIX_CALM_MAX), toDeg: gaugeAngle(VIX_ELEVATED_MAX) },
  { tier: 'high', fromDeg: gaugeAngle(VIX_ELEVATED_MAX), toDeg: gaugeAngle(VIX_GAUGE_MAX) },
];

export interface Point {
  x: number;
  y: number;
}

/** 极坐标 → 直角坐标（度制）。O(1)。 */
export function polarPoint(cx: number, cy: number, r: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** 圆弧 → SVG `path` 的 `d` 串（顺时针）。跨度 >180° 时置 large-arc 位。O(1)。 */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const from = polarPoint(cx, cy, r, fromDeg);
  const to = polarPoint(cx, cy, r, toDeg);
  const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return [
    `M ${from.x.toFixed(2)} ${from.y.toFixed(2)}`,
    `A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`,
  ].join(' ');
}

// ═══════════════════ ② 指数读数（FR-017 / FR-020） ═══════════════════

export interface IndexReadoutView {
  state: UsIndexReadoutResponseState;
  /** 解析后的收盘值；不可得 ⇒ `null`（**禁回落 0**）。 */
  value: number | null;
  valueText: string | null;
  /** 两个降级态**各自成句**，且都含「显示不可用」；有值 ⇒ `null`。 */
  degradedText: string | null;
  /** 该指数**自己的** asOf —— VIX 与 VVIX 来自两个独立文件，可能不是同一天（FR-020）。 */
  freshness: Freshness;
}

const INDEX_DEGRADED_TEXT: Record<Exclude<UsIndexReadoutResponseState, 'available'>, string> = {
  missing: COPY.gauge.missing,
  read_failed: COPY.gauge.readFailed,
};

/**
 * 指数读数 → 呈现决策。复杂度 O(1)。
 *
 * 🚨 **`available` 但 close 解析不出 ⇒ 退回不可用**，而不是显示 NaN / 0（同 T021 的
 *    `ivReadoutView` 取舍）。
 */
export function indexReadoutView(readout: UsIndexReadoutResponse): IndexReadoutView {
  const value = readout.state === 'available' ? toFinite(readout.close) : null;
  const state: UsIndexReadoutResponseState =
    readout.state === 'available' && value === null ? 'missing' : readout.state;
  return {
    state,
    value,
    valueText: value === null ? null : value.toFixed(2),
    degradedText: state === 'available' ? null : INDEX_DEGRADED_TEXT[state],
    freshness: freshnessOf(readout.asOf, readout.freshnessTier),
  };
}

export interface VixGaugeView extends IndexReadoutView {
  /**
   * 🚨 **FR-017**：不可得 ⇒ `null` ——「不画指针」与「指针停在 0」是两件事，后者会被读成
   * 「极度平静」。渲染侧据此**不画指针**，弧本体照画（量程刻度不依赖当期值）。
   */
  pointerAngle: number | null;
  tier: VixTier | null;
}

/** VIX 读数 → 表盘视图。复杂度 O(1)。 */
export function vixGaugeView(readout: UsIndexReadoutResponse): VixGaugeView {
  const base = indexReadoutView(readout);
  return {
    ...base,
    pointerAngle: base.value === null ? null : gaugeAngle(base.value),
    tier: base.value === null ? null : vixTier(base.value),
  };
}

// ═══════════════════ ③ VVIX/VIX 比（FR-016） ═══════════════════

export interface RatioView {
  state: VvixVixRatioResponseState;
  /** 🚨 只有 `available` 出数值 —— 其余三态零值面（禁拿单侧推算、禁跨日硬除）。 */
  valueText: string | null;
  /** 共同基准日标注；非 `available` ⇒ `null`（没有共同基准可标）。 */
  basisText: string | null;
  /** `available` ⇒ 正常带读法；三个降级态各自成句。 */
  noteText: string;
}

const RATIO_NOTE: Record<Exclude<VvixVixRatioResponseState, 'available'>, string> = {
  basis_mismatch: COPY.ratio.basisMismatch,
  missing: COPY.ratio.missing,
  read_failed: COPY.ratio.readFailed,
};

/**
 * 比值 → 呈现决策（四态）。基准判定在 server（放前端等于每个消费方重实现一次纪律），
 * 本函数只负责「拿到什么态就显什么」。复杂度 O(1)。
 */
export function ratioView(ratio: VvixVixRatioResponse): RatioView {
  const value = ratio.state === 'available' ? toFinite(ratio.value) : null;
  const state: VvixVixRatioResponseState =
    ratio.state === 'available' && value === null ? 'missing' : ratio.state;
  return {
    state,
    valueText: value === null ? null : value.toFixed(2),
    basisText:
      state === 'available' && ratio.basisDate
        ? `${COPY.ratio.basisPrefix}${ratio.basisDate}`
        : null,
    noteText: state === 'available' ? COPY.ratio.normalBand : RATIO_NOTE[state],
  };
}

// ═══════════════════ ④ 锚定标的 IVP 列表（FR-018 / FR-036） ═══════════════════

export interface ThermometerRowView {
  /** canonical `market:code`（列表 key）。 */
  ticker: string;
  /** 展示用 code（解析失败退回原串，不丢信息）。 */
  code: string;
  /** 交易意愿排除 —— **行照常在列表内**，只是带标记（045 语义，与雷达相反）。 */
  excluded: boolean;
  excludeReasonText: string | null;
  /** 复用 T021 的 IV 读数决策（含 FR-036 徽标与「分位不可算」不出徽标）。 */
  iv: IvReadoutView;
}

/** 单行 → 视图。复杂度 O(1)。 */
export function thermometerRowView(row: ThermometerUnderlyingRowResponse): ThermometerRowView {
  return {
    ticker: row.ticker,
    code: row.ticker.split(':')[1] ?? row.ticker,
    excluded: row.excluded,
    excludeReasonText:
      row.excluded && row.excludeReason
        ? `${COPY.list.excludeReasonPrefix}${row.excludeReason}`
        : null,
    iv: ivReadoutView(row.iv),
  };
}

// ═══════════════════ ⑤ 页面合成 ═══════════════════

/** 列表只有两态。**没有「整页空」这一档** —— 零锚时表盘照常（FR-018 / FR-027）。 */
export type ThermometerListState = 'ready' | 'empty';

/**
 * 🚨 **键面穷举** —— 这里塞不进 `regime`（FR-015 📌）。单测拿它做机械防线。
 */
export interface ThermometerView {
  gauge: VixGaugeView;
  vvix: IndexReadoutView;
  ratio: RatioView;
  rows: ThermometerRowView[];
  list: ThermometerListState;
}

/**
 * 温度计响应 → 整页视图。复杂度 O(n)，n = 锚数（无分页，锚表规模上限约 1000）。
 *
 * 🚨 **表盘与列表是两条独立的线**：零锚 ⇒ 列表空态但表盘照渲；指数不可得 ⇒ 表盘降级但
 *    列表照列。两者互不牵连（指数维度不挂锚闸，FR-027）。
 */
export function thermometerView(data: ThermometerResponse): ThermometerView {
  const rows = data.underlyings.map(thermometerRowView);
  return {
    gauge: vixGaugeView(data.vix),
    vvix: indexReadoutView(data.vvix),
    ratio: ratioView(data.vvixVixRatio),
    rows,
    list: rows.length === 0 ? 'empty' : 'ready',
  };
}
