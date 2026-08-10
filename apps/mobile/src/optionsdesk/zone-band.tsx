// 045 T023 — 四区间色带（FR-011 / FR-012, plan D12）。
//
// 🚨 **纯 `View` 绘制，不引 SVG**：5 段矩形 + spot 黑点 + W 红圈 + 2 条界线 + 刻度文字，
//    全是 flex 百分比宽 + absolute 定位 + `borderRadius` 的原生能力。`react-native-svg` 虽在库，
//    但在此**零收益**且多一层渲染树。
// 🚨 **Guardrail 9 —— 小尺寸圆禁 dashed 边框**：mockup 2026-08-01 渲染实证「8px 圆 + 1.5px dashed」
//    退化成齿轮/星形。钳制态改**空心点**（`bg-surface` + 2px `border-ink`），同样表达
//    「这不是真实比例位」，且在 8px 尺度下干净可辨。
// 🚨 **轴区内零文字**：刻度文字全部落在色带下方；W 界线标值且红色加粗、V 标在真实位置、
//    **两端不标界线值**（0.6V / 1.2V 只以端帽示意）。
//
// 几何契约（值 → 百分比）在 `zone-band.rules.ts`（vitest 覆盖）；本文件只负责把百分比画出来。
// 视觉 / 渲染验证走 T025 E2E（`~/ui` 与展示组件不写 vitest，per mono 测试分层）。
import { Text, View } from 'react-native';
import type { AnchorResponse } from '@nvy/api-client';

import { formatPriceText } from './price-format.rules';
import {
  BAND_SEGMENTS,
  BAND_V_PCT,
  BAND_W_PCT,
  spotPosition,
  type BandZone,
  type ZoneBandAnchor,
} from './zone-band.rules';

// 版面尺寸（px）。百分比几何靠 style —— className 表达不出动态定位，属 nativewind-mapping
// 反模式清单里「动态计算位移」的允许例外；这里连同尺寸一起集中，免得半 class 半 style 更难读。
const WRAP_HEIGHT = 38;
const BAND_TOP = 3;
const BAND_HEIGHT = 14;
const RING_SIZE = 20;
const DOT_SIZE = 8;
const TICK_LABEL_TOP = BAND_TOP + BAND_HEIGHT + 2;
const TICK_LABEL_WIDTH = 60;

/**
 * 区间 → 底色（`Record` 而非 `Partial<Record>`：漏一个区间即编译红）。宽度来自 rules。
 *
 * 046 T021 起**导出**：标的详情的区间时序画的是同一套五区间、只是纵向（`price-zone-chart.tsx`）。
 * 两处各写一份配色必 drift —— 「色带语义单源」在这里。
 */
export const ZONE_TONE: Record<BandZone, { className: string; opacity: number }> = {
  deep_buy: { className: 'bg-err-soft', opacity: 0.55 },
  buy: { className: 'bg-ok-soft', opacity: 1 },
  thin: { className: 'bg-warn-soft', opacity: 1 },
  expensive: { className: 'bg-surface-sunken', opacity: 1 },
  overvalued: { className: 'bg-surface-alt', opacity: 0.8 },
};

/** 行情不可用时整条色带的降透明度（mockup `.band-na`）。 */
const DIMMED_OPACITY = 0.35;

export interface ZoneBandProps {
  anchor: ZoneBandAnchor & Pick<AnchorResponse, 'w' | 'v'>;
  /** 行前缀；子元素 testID 由此派生（spot 点在钳制态换后缀，供 T025 机械断言）。 */
  testID?: string;
}

export function ZoneBand({ anchor, testID = 'optionsdesk-zone-band' }: ZoneBandProps) {
  const spot = spotPosition(anchor);
  // 行情不可用：色带与 W 红圈照常（锚是自产数据，不依赖行情），只是没有 spot 黑点（FR-017）。
  const dimmed = spot === null;

  return (
    <View style={{ height: WRAP_HEIGHT }} testID={testID}>
      {/* 色带本体：5 段等比例矩形。 */}
      <View
        className="absolute left-0 right-0 flex-row overflow-hidden rounded-xs"
        style={{ top: BAND_TOP, height: BAND_HEIGHT }}
      >
        {BAND_SEGMENTS.map((seg) => (
          <View
            key={seg.zone}
            className={ZONE_TONE[seg.zone].className}
            style={{
              width: `${seg.widthPct}%`,
              height: '100%',
              opacity: dimmed ? DIMMED_OPACITY : ZONE_TONE[seg.zone].opacity,
            }}
          />
        ))}
      </View>

      {/* 2 条界线：W 红色加粗、V 中性（两端帽不标线也不标值）。 */}
      <BoundaryLine pct={BAND_W_PCT} className="bg-err" width={1.5} />
      <BoundaryLine pct={BAND_V_PCT} className="bg-line-strong" width={1} />

      {/* W 位置红圈（FR-012 两个标记之一，恒在 35.67%）。 */}
      <View
        className="absolute rounded-full border-2 border-err"
        style={{
          top: 0,
          left: `${BAND_W_PCT}%`,
          marginLeft: -RING_SIZE / 2,
          width: RING_SIZE,
          height: RING_SIZE,
        }}
        testID={`${testID}-w-ring`}
      />

      {/* spot 黑点（FR-012 另一个标记）；钳制态 = 空心点（Guardrail 9，禁 dashed）。 */}
      {spot ? (
        <View
          className={
            spot.clamped
              ? 'absolute rounded-full border-2 border-ink bg-surface'
              : 'absolute rounded-full bg-ink'
          }
          style={{
            top: BAND_TOP + (BAND_HEIGHT - DOT_SIZE) / 2,
            left: `${spot.pct}%`,
            marginLeft: -DOT_SIZE / 2,
            width: DOT_SIZE,
            height: DOT_SIZE,
          }}
          testID={spot.clamped ? `${testID}-spot-clamped` : `${testID}-spot`}
        />
      ) : null}

      {/* 刻度文字（轴区外）：W 标值且红色加粗，V 标在真实位置。 */}
      <TickLabel
        pct={BAND_W_PCT}
        text={formatPriceText(anchor.w)}
        className="text-err font-bold text-[10px]"
      />
      <TickLabel
        pct={BAND_V_PCT}
        text={`V ${formatPriceText(anchor.v)}`}
        className="text-ink-subtle text-[9px]"
      />
    </View>
  );
}

function BoundaryLine({
  pct,
  className,
  width,
}: {
  pct: number;
  className: string;
  width: number;
}) {
  return (
    <View
      className={`absolute ${className}`}
      style={{ top: BAND_TOP, left: `${pct}%`, marginLeft: -width / 2, width, height: BAND_HEIGHT }}
    />
  );
}

function TickLabel({ pct, text, className }: { pct: number; text: string; className: string }) {
  return (
    <View
      className="absolute items-center"
      style={{
        top: TICK_LABEL_TOP,
        left: `${pct}%`,
        marginLeft: -TICK_LABEL_WIDTH / 2,
        width: TICK_LABEL_WIDTH,
      }}
    >
      <Text className={`font-mono ${className}`} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
