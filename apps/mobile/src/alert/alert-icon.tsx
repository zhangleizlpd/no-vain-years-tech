// AlertIcon — 021 alert feature 线性图标集，mockup AlertKit `AIcon` path 逐一翻
// react-native-svg（22×22 默认，stroke 1.7 圆角线端，体例对齐 ~/ui/TabBarIcon）。
// 颜色经 props 传 svg（svg 不吃 className）；默认值走 ~/theme token，0 hex 字面量
// （xCircle 灰底/白叉映射 line.strong / surface token，与 mockup 近似色）。
// 非 route 组件 → 落 src/（不进 app/，否则 Expo Router 当 phantom route）。

import React from 'react';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { colors } from '~/theme';

export type AlertIconName =
  | 'alertBell'
  | 'mail'
  | 'search'
  | 'pen'
  | 'trash'
  | 'plusCircle'
  | 'plus'
  | 'check'
  | 'chevron'
  | 'x'
  | 'xCircle'
  | 'badgeCheck';

export interface AlertIconProps {
  name: AlertIconName;
  color?: string;
  size?: number;
  strokeWidth?: number;
}

const outline = (color: string, strokeWidth: number) =>
  ({
    stroke: color,
    strokeWidth,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }) as const;

const RENDER: Record<AlertIconName, (color: string, sw: number) => React.ReactNode> = {
  // 预警铃铛：铃 + 闪电（FR-M07 工具栏 / 014 底栏接通共用）
  alertBell: (c, sw) => (
    <>
      <G {...outline(c, sw)}>
        <Path d="M6 9.5a6 6 0 0112 0c0 4.6 1.8 6.5 1.8 6.5H4.2S6 14.1 6 9.5" />
        <Path d="M10 20a2 2 0 004 0" />
      </G>
      <Path d="M12.4 6.6l-2.7 4.2h2.1l-1 3.1 3.4-4.4h-2.1z" fill={c} />
    </>
  ),
  mail: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M3 7.7a2.2 2.2 0 012.2-2.2h13.6A2.2 2.2 0 0121 7.7v8.6a2.2 2.2 0 01-2.2 2.2H5.2A2.2 2.2 0 013 16.3z" />
      <Path d="M4 7l8 5.5L20 7" />
    </G>
  ),
  search: (c, sw) => (
    <G {...outline(c, sw)}>
      <Circle cx={10.5} cy={10.5} r={6.5} />
      <Path d="M15.5 15.5L21 21" />
    </G>
  ),
  pen: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M4 20l4-1L19 8a2 2 0 00-3-3L5 16z" />
      <Path d="M14.5 6.5l3 3" />
    </G>
  ),
  trash: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />
    </G>
  ),
  plusCircle: (c, sw) => (
    <G {...outline(c, sw)}>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M12 8.5v7M8.5 12h7" />
    </G>
  ),
  plus: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M12 5v14M5 12h14" />
    </G>
  ),
  check: (c) => (
    <G {...outline(c, 2.2)}>
      <Path d="M5 12.5l4.5 4.5L19 6.5" />
    </G>
  ),
  chevron: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M9 5l7 7-7 7" />
    </G>
  ),
  x: (c, sw) => (
    <G {...outline(c, sw)}>
      <Path d="M6 6l12 12M18 6L6 18" />
    </G>
  ),
  // 实底灰圆 + 白叉（搜索框清空钮）；底/叉色走 token 近似 mockup 灰
  xCircle: () => (
    <>
      <Circle cx={12} cy={12} r={9} fill={colors.line.strong} />
      <Path
        d="M8.5 8.5l7 7M15.5 8.5l-7 7"
        stroke={colors.surface.DEFAULT}
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </>
  ),
  badgeCheck: (c, sw) => (
    <G {...outline(c, sw)}>
      <Circle cx={12} cy={12} r={8.5} />
      <Path d="M8.5 12l2.4 2.4 4.6-4.8" strokeWidth={1.9} />
    </G>
  ),
};

export function AlertIcon({
  name,
  color = colors.ink.DEFAULT,
  size = 22,
  strokeWidth = 1.7,
}: AlertIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {RENDER[name](color, strokeWidth)}
    </Svg>
  );
}
