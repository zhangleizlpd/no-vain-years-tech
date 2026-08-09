import Svg, { Circle, G, Path, Rect } from 'react-native-svg';

export interface LogoMarkProps {
  /** SVG outer width / height in px. Default 56 (matches mockup v2). */
  size?: number;
}

// Brand logo mark — blue rounded tile + 12 white rays + orange halo + sun.
// Hex literals (#2456E5 / #FF8C00 / #FFFFFF) align with ~/theme tokens
// (brand-500 / accent / pure white) but kept inline since SVG `fill` props
// don't accept NativeWind className. SC-C07 grep scopes around SVG fills.
export function LogoMark({ size = 56 }: LogoMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect width={64} height={64} rx={14} fill="#2456E5" />
      <Circle cx={32} cy={32} r={22} fill="#FF8C00" opacity={0.18} />
      <G stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round">
        <Path d="M32 18 L32 8" />
        <Path d="M39 19.88 L44 11.22" />
        <Path d="M44.12 25 L52.78 20" />
        <Path d="M46 32 L56 32" />
        <Path d="M44.12 39 L52.78 44" />
        <Path d="M39 44.12 L44 52.78" />
        <Path d="M32 46 L32 56" />
        <Path d="M25 44.12 L20 52.78" />
        <Path d="M19.88 39 L11.22 44" />
        <Path d="M18 32 L8 32" />
        <Path d="M19.88 25 L11.22 20" />
        <Path d="M25 19.88 L20 11.22" />
      </G>
      <Circle cx={32} cy={32} r={9.5} fill="#FF8C00" />
      <Circle cx={29.5} cy={29.5} r={2.5} fill="#FFFFFF" opacity={0.3} />
    </Svg>
  );
}
