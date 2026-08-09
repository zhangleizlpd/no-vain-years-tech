// 035 T006 — 录音振幅归一化纯函数（波形高度驱动；无状态、无 IO，vitest=logic 层）。
//
// nitro-sound `addRecordBackListener` 的 `currentMetering` 是 dBFS 量纲：0 dB = 满刻度峰值，
// 负值越小越安静（iOS 静音回 -160 / -Infinity；Android 取值域相近）。波形条高度需要 [0,1]
// 的线性强度 → 把 [DB_FLOOR, DB_CEIL] 区间线性映射到 [0,1]，区间外钳制。
//
// DB_FLOOR = -60：低于此视作静音（基线平）；人声常态约 -40~-10 dB，-60 给足底噪余量。
// 非有限值（NaN / -Infinity，iOS 静音帧）→ 0（基线），不让波形炸 / 出 NaN。

/** 静音下限（dBFS）：≤ 此值波形归零（基线平）。 */
export const METER_DB_FLOOR = -60;
/** 满刻度上限（dBFS）：≥ 此值波形归一（满高）。 */
export const METER_DB_CEIL = 0;

/**
 * 把 dBFS metering 值归一化到 [0,1]（波形条高度）。复杂度 O(1)。
 *
 * @param db nitro-sound `currentMetering`（dBFS；可能为 -Infinity / NaN，iOS 静音帧）。
 * @returns [0,1]：0 = 静音基线，1 = 满刻度；非有限值与区间外均钳制。
 */
export function normalizeMeter(db: number): number {
  if (!Number.isFinite(db)) return 0; // NaN / ±Infinity（iOS 静音帧）→ 基线。
  if (db <= METER_DB_FLOOR) return 0;
  if (db >= METER_DB_CEIL) return 1;
  return (db - METER_DB_FLOOR) / (METER_DB_CEIL - METER_DB_FLOOR);
}
