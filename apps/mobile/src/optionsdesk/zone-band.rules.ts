// 045 T023 — 四区间色带的**几何契约**（FR-011 / FR-012, plan D12）。纯函数 → vitest。
//
// 🚨 契约是几何与钳制规则，**绘制手段不是**（handoff 原话）：
//   内段 `[0.6V, 1.2V]` 严格等比例铺满 `[7%, 93%]`，两端各留 7% 作示意端帽
//   ⇒ **W = 0.8V 恒在 35.67%、V 恒在 64.33%**（带宽以 V 归一化，与具体票无关）。
//   spot 越界时**钳制到端帽中点**并置 `clamped` —— 不越出色带、也不当真实比例位。
//
// ⚠️ 策略系数（0.6 / 0.8 / 1.2）的**唯一落点是 server `anchor.rules.ts`**（SC-005）。本文件
//    只吃 server 随 `AnchorResponse` 下发的 `zoneFloor` / `zoneCeiling` / `lastClose` **绝对值**，
//    mobile 侧不重算系数；下面的百分比是纯 **UI 版面几何常量**，与策略参数无关。
import type { AnchorResponse, AnchorResponseZone } from '@nvy/api-client';

/** 两端示意端帽各占的宽度百分比。 */
export const BAND_CAP_PCT = 7;
/** 内段左端（= 0.6V 的落点）。 */
export const BAND_INNER_START_PCT = BAND_CAP_PCT;
/** 内段右端（= 1.2V 的落点）。 */
export const BAND_INNER_END_PCT = 100 - BAND_CAP_PCT;

const INNER_SPAN_PCT = BAND_INNER_END_PCT - BAND_INNER_START_PCT;

/** 百分比保留 2 位 —— CSS 精度足够，且让几何断言可精确比较（避开浮点尾巴）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 内段以 V 归一化后跨度 = 0.6V：W = 0.8V 落 1/3 处、V 落 2/3 处。
/** W（愿买价锚）恒定位置：35.67%。红色加粗界线 + 红圈都画在这里。 */
export const BAND_W_PCT = round2(BAND_INNER_START_PCT + INNER_SPAN_PCT / 3);
/** V（估值锚）恒定位置：64.33%。 */
export const BAND_V_PCT = round2(BAND_INNER_START_PCT + (INNER_SPAN_PCT * 2) / 3);

/** spot < 0.6V 时的钳制落点 = 左端帽中点。 */
export const BAND_LEFT_CLAMP_PCT = BAND_CAP_PCT / 2;
/** spot > 1.2V 时的钳制落点 = 右端帽中点。 */
export const BAND_RIGHT_CLAMP_PCT = 100 - BAND_CAP_PCT / 2;

/** 色带 5 段 ↔ server `AnchorResponseZone` 的 5 个区间一一对应。 */
export type BandZone = NonNullable<AnchorResponseZone>;

/**
 * 5 段矩形（顺序 = 深买区端帽 / 买区 / 薄带 / 偏贵 / 高估端帽）。
 * 宽度由端帽宽 + W / V 两条界线切分内段派生，合计 100%。
 */
export const BAND_SEGMENTS: readonly { zone: BandZone; widthPct: number }[] = [
  { zone: 'deep_buy', widthPct: BAND_CAP_PCT },
  { zone: 'buy', widthPct: round2(BAND_W_PCT - BAND_INNER_START_PCT) },
  { zone: 'thin', widthPct: round2(BAND_V_PCT - BAND_W_PCT) },
  { zone: 'expensive', widthPct: round2(BAND_INNER_END_PCT - BAND_V_PCT) },
  { zone: 'overvalued', widthPct: BAND_CAP_PCT },
];

export interface BandPosition {
  /** 距色带左缘的百分比（0–100）。 */
  pct: number;
  /** true = 值越出内段被钳制到端帽内，**位置不代表真实比例**（渲染改空心点，Guardrail 9）。 */
  clamped: boolean;
}

/**
 * 值 → 色带百分比位置。内段线性映射，越界钳到端帽中点。
 * 退化区间（`ceiling <= floor`）或任一入参非有限 → `null`（不编造位置）。
 * 复杂度 O(1)。
 */
export function bandPosition(value: number, floor: number, ceiling: number): BandPosition | null {
  if (!Number.isFinite(value) || !Number.isFinite(floor) || !Number.isFinite(ceiling)) return null;
  if (ceiling <= floor) return null;
  if (value < floor) return { pct: BAND_LEFT_CLAMP_PCT, clamped: true };
  if (value > ceiling) return { pct: BAND_RIGHT_CLAMP_PCT, clamped: true };
  const ratio = (value - floor) / (ceiling - floor);
  return { pct: round2(BAND_INNER_START_PCT + INNER_SPAN_PCT * ratio), clamped: false };
}

/** server 的 Decimal string → number；null / 空 / 非数字 → null。 */
function toFinite(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** 色带只需要锚上这几个字段（按结构子集吃，不绑整个 `AnchorResponse`）。 */
export type ZoneBandAnchor = Pick<AnchorResponse, 'zoneFloor' | 'zoneCeiling' | 'lastClose'>;

/**
 * spot 黑点位置。**行情不可用（`lastClose` 为 null）→ `null`** —— 不画点、不落 0 值
 * （FR-017：色带与 W 红圈照常渲染，锚是自产数据不依赖行情）。
 */
export function spotPosition(anchor: ZoneBandAnchor): BandPosition | null {
  const spot = toFinite(anchor.lastClose);
  const floor = toFinite(anchor.zoneFloor);
  const ceiling = toFinite(anchor.zoneCeiling);
  if (spot == null || floor == null || ceiling == null) return null;
  return bandPosition(spot, floor, ceiling);
}
