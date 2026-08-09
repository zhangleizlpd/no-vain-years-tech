// HoldingsIcon — 025 持仓入口钱包 icon，mockup HoldingsKit `WIcon.wallet` path 翻
// react-native-svg（体例对齐 ~/alert/alert-icon：22×22 默认、stroke 圆角线端、色经
// props 传 svg、默认 brand token 0 hex 字面量）。非 route 组件 → 落 src/。

import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { colors } from '~/theme';

export interface HoldingsIconProps {
  color?: string;
  size?: number;
  strokeWidth?: number;
}

export function HoldingsIcon({
  color = colors.brand[500],
  size = 22,
  strokeWidth = 1.8,
}: HoldingsIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={6}
        width={18}
        height={13}
        rx={2.4}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M3 9.5h18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Circle cx={16.5} cy={13.5} r={1.3} fill={color} />
    </Svg>
  );
}
