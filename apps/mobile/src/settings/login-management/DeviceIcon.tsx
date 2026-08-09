// DeviceIcon — 5 形态 stroke-outline SVG (PHONE / TABLET / DESKTOP / WEB / UNKNOWN),
// 24×24, stroke 1.75, ink-muted default. Ported from legacy app; @nvy/design-tokens → ~/theme.
//
// 非 route 组件 → 落 src/ (不进 app/, 否则 Expo Router 当 phantom route)。

import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { colors } from '~/theme';

export type DeviceKind = 'PHONE' | 'TABLET' | 'DESKTOP' | 'WEB' | 'UNKNOWN';

// SVG stroke props don't accept className; pull from theme tokens so the hex
// literal doesn't live in component source (NativeWind-mapping compliance).
const STROKE = colors.ink.muted;

interface IconProps {
  size?: number;
  color?: string;
}

const base = (color: string, w = 1.75) => ({
  stroke: color,
  strokeWidth: w,
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export function DeviceIcon({ kind, size = 24, color = STROKE }: { kind: DeviceKind } & IconProps) {
  const p = base(color);
  switch (kind) {
    case 'PHONE':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x="7" y="2.5" width="10" height="19" rx="2" {...p} />
          <Path d="M10 18.5 L14 18.5" {...p} />
        </Svg>
      );
    case 'TABLET':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x="3.5" y="3.5" width="17" height="17" rx="2" {...p} />
          <Path d="M10 17.5 L14 17.5" {...p} />
        </Svg>
      );
    case 'DESKTOP':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x="2.5" y="4" width="19" height="12" rx="1.5" {...p} />
          <Path d="M9 20.5 L15 20.5 M12 16.5 L12 20.5" {...p} />
        </Svg>
      );
    case 'WEB':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx="12" cy="12" r="9" {...p} />
          <Path d="M3 12 L21 12 M12 3 C15 6.5 15 17.5 12 21 M12 3 C9 6.5 9 17.5 12 21" {...p} />
        </Svg>
      );
    case 'UNKNOWN':
    default:
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x="3.5" y="3.5" width="17" height="17" rx="3" {...p} />
          <Circle cx="12" cy="12" r="1.25" fill={color} stroke={color} />
        </Svg>
      );
  }
}

export default DeviceIcon;
