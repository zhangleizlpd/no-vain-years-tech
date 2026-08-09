// TabBarIcon — 底部 Tab 图标 × 2 态 (首页/灵感/期权台/投资/我的)，24×24 线性描边。
// 移植自 portfolio handoff bundle (Claude Design「底部 Tab 图标系统」)：inactive 纯
// 描边，active 实心剪影 (invest 例外，保描边 + 半透坐标轴)，stroke-width 2 圆角线端。
// React Navigation 的 tabBarIcon 回调已把 active/inactive tint 解析进 `color`
// (screenOptions tabBarActive/InactiveTintColor)，组件只按 `focused` 选剪影。
//
// 非 route 组件 → 落 src/ (不进 app/，否则 Expo Router 当 phantom route)。

import React from 'react';
import Svg, { Circle, G, Path } from 'react-native-svg';

export type TabIconName = 'home' | 'brain' | 'optionsdesk' | 'invest' | 'profile';

interface TabBarIconProps {
  name: TabIconName;
  focused: boolean;
  color: string;
  size?: number;
}

export function TabBarIcon({ name, focused, color, size = 24 }: TabBarIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {RENDER[name](focused, color)}
    </Svg>
  );
}

const outline = (color: string) =>
  ({
    stroke: color,
    strokeWidth: 2,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }) as const;

const RENDER: Record<TabIconName, (focused: boolean, color: string) => React.ReactNode> = {
  home: (focused, color) =>
    focused ? (
      <Path
        fill={color}
        fillRule="evenodd"
        d="M12 3.4 21.2 11.2H18.4V20.2H13.7V14.4H10.3V20.2H5.6V11.2H2.8L12 3.4Z"
      />
    ) : (
      <G {...outline(color)}>
        <Path d="M4.5 10.8 12 4.3 19.5 10.8" />
        <Path d="M6.6 9.7V19.5H17.4V9.7" />
        <Path d="M10 19.5V14.6H14V19.5" />
      </G>
    ),
  brain: (focused, color) =>
    focused ? (
      <>
        <G stroke={color} strokeWidth={2} strokeLinecap="round">
          <Path d="M9.7 10 7 7.8M14.4 10.2 16.8 8.6M12.25 15.1 12.4 17.6" />
        </G>
        <G fill={color}>
          <Circle cx={12} cy={12} r={3.3} />
          <Circle cx={5.6} cy={6.6} r={2.1} />
          <Circle cx={18.4} cy={7.6} r={2.1} />
          <Circle cx={12.5} cy={19.4} r={2.1} />
        </G>
      </>
    ) : (
      <G {...outline(color)}>
        <Path d="M9.7 10 7 7.8M14.4 10.2 16.8 8.6M12.25 15.1 12.4 17.6" />
        <Circle cx={12} cy={12} r={3.1} />
        <Circle cx={5.6} cy={6.6} r={1.9} />
        <Circle cx={18.4} cy={7.6} r={1.9} />
        <Circle cx={12.5} cy={19.4} r={1.9} />
      </G>
    ),
  // optionsdesk (045 期权台) — 击球区雷达语义：靶环 + 十字准星。inactive 纯描边空心靶心，
  // active 靶心实心 (同 home/profile 的「描边→实心剪影」家族规则；靶环保描边，整圆填成实心
  // 会糊成色块)。与 brain 的散点圆、invest 的折线在 24×24 下互不混淆。
  optionsdesk: (focused, color) => (
    <>
      <G {...outline(color)}>
        <Circle cx={12} cy={12} r={8.2} />
        <Path d="M12 1.9V5M12 19V22.1M1.9 12H5M19 12H22.1" />
      </G>
      {focused ? (
        <Circle cx={12} cy={12} r={3.6} fill={color} />
      ) : (
        <Circle cx={12} cy={12} r={3.2} {...outline(color)} />
      )}
    </>
  ),
  // invest 两态同款描边走势图 (上升折线 + 半透坐标轴)，active/inactive 仅靠 `color` 切。
  invest: (focused, color) => (
    <G fill="none" strokeLinecap="round" strokeLinejoin="round">
      <Path stroke={color} strokeWidth={2} opacity={focused ? 0.4 : 0.45} d="M5 4.5V19H19.5" />
      <Path stroke={color} strokeWidth={2} d="M7.3 14.6 10.7 11 13.2 13.2 17.3 8.6" />
      <Path stroke={color} strokeWidth={2} d="M14.2 8.6H17.3V11.9" />
    </G>
  ),
  profile: (focused, color) =>
    focused ? (
      <G fill={color}>
        <Circle cx={12} cy={8} r={3.9} />
        <Path d="M12 13.4c-4 0-6.9 2.7-6.9 6.6h13.8c0-3.9-2.9-6.6-6.9-6.6Z" />
      </G>
    ) : (
      <G {...outline(color)}>
        <Circle cx={12} cy={8} r={3.6} />
        <Path d="M5.5 20c0-3.7 2.9-6.2 6.5-6.2s6.5 2.5 6.5 6.2" />
      </G>
    ),
};

export default TabBarIcon;
