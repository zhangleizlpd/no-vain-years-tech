// 046 T021 — IVP 分段水平条（FR-012 / FR-036）。**纯 `View` 绘制，不引 SVG、不引图表库**
// （SC-007 零新第三方运行时依赖；同 045 `zone-band.tsx` 的取舍 —— 矩形 + 百分比宽 + absolute
// 定位是 RN 原生能力，SVG 在此零收益）。
//
// 🚨 **Guardrail 9 —— 外层禁 `overflow:hidden`**：位置标记（16px）比槽（10px）高，
//    给外层加裁剪会把它**整个吃掉且不报错**。裁剪**只**下沉到内层段容器。
//    mockup baseline 2026-08-02 在两个文件共 6 处踩过这个坑，别重蹈。
//
// 🚨 **段宽与刻度同源** —— 都由 `underlying-detail.rules.ts` 的 25 / 70 / 90 派生（FR-036）。
//    ⚠️ mockup 同组画的刻度标签写的是 `0/50/90/100`，**那是错的**（2026-08-02 analyze 扫出、
//    user 拍板以段宽为准）；照它写会让「提醒状态」整档偏移，且不会红。
//
// 几何与档位判定在 rules（vitest 覆盖）；渲染验证走 T024 E2E（展示组件不写 vitest）。
import { Text, View } from 'react-native';

import { IVP_SEGMENTS, IVP_TIER_BOUNDARIES, type IvpTier } from './underlying-detail.rules';

const WRAP_HEIGHT = 30;
const SLOT_HEIGHT = 10;
const MARK_WIDTH = 3;
const MARK_HEIGHT = 16;
const MARK_TOP = -3;
const TICK_TOP = SLOT_HEIGHT + 4;
const TICK_WIDTH = 24;

/** 档 → 段底色（`Record` 而非 `Partial<Record>`：漏一档即编译红）。 */
const TIER_TONE: Record<IvpTier, { className: string; opacity: number }> = {
  low: { className: 'bg-tag-teal', opacity: 0.55 },
  mid: { className: 'bg-tag-gray', opacity: 0.45 },
  high: { className: 'bg-warn-soft', opacity: 1 },
  extreme: { className: 'bg-err-soft', opacity: 1 },
};

export interface IvpSegmentBarProps {
  /**
   * IVP 值（0–100）。**`null` = 分位不可算 / 暂无数据 ⇒ 不画标记**（段带照常画）——
   * 绝不落在 0 处（FR-014：MUST NOT 回落为 0）。
   */
  ivPercentile: number | null;
  testID?: string;
}

/** T022 波动温度计的 IVP 列表复用同一条（复用频次 ≥ 2 ⇒ 抽件，别在那边重画一遍）。 */
export function IvpSegmentBar({
  ivPercentile,
  testID = 'optionsdesk-ivp-bar',
}: IvpSegmentBarProps) {
  // 位置百分比只在有值时求；越界值钳到 [0,100]。钳制是**无条件兜底** —— 不依赖任何关于
  // vendor 分位值域的假设（本仓没有该值域的实测, 也不需要有: 越界与否都渲染正确）。
  const markPct = ivPercentile === null ? null : Math.min(100, Math.max(0, ivPercentile));

  return (
    // 🚨 外层**不裁剪**（Guardrail 9）。
    <View style={{ height: WRAP_HEIGHT }} testID={testID}>
      {/* 段容器：裁剪在这一层，标记不受影响。 */}
      <View
        className="absolute left-0 right-0 flex-row overflow-hidden rounded-full bg-surface-sunken"
        style={{ top: 0, height: SLOT_HEIGHT }}
      >
        {IVP_SEGMENTS.map((seg) => (
          <View
            key={seg.tier}
            className={TIER_TONE[seg.tier].className}
            style={{
              width: `${seg.widthPct}%`,
              height: '100%',
              opacity: TIER_TONE[seg.tier].opacity,
            }}
          />
        ))}
      </View>

      {markPct === null ? null : (
        <View
          className="absolute rounded-xs bg-ink"
          style={{
            top: MARK_TOP,
            left: `${markPct}%`,
            marginLeft: -MARK_WIDTH / 2,
            width: MARK_WIDTH,
            height: MARK_HEIGHT,
          }}
          testID={`${testID}-mark`}
        />
      )}

      {/* 刻度：与段宽同源的 25 / 70 / 90（元信息档，非降级状态字 ⇒ 可用最淡档）。 */}
      {IVP_TIER_BOUNDARIES.map((tick) => (
        <View
          key={tick}
          className="absolute items-center"
          style={{
            top: TICK_TOP,
            left: `${tick}%`,
            marginLeft: -TICK_WIDTH / 2,
            width: TICK_WIDTH,
          }}
        >
          <Text className="font-mono text-[9px] text-ink-subtle">{tick}</Text>
        </View>
      ))}
    </View>
  );
}
