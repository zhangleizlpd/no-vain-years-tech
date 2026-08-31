// 投资/行情功能 family 的编译期门控组件 + 受控面清单（单一来源）。
//
// 用法（三形态，按门控点性质选）：
//   - <MarketsGate>…</MarketsGate>            渲染门 —— 隐藏入口（设置页投资 Card 等）。off → 不渲染。
//   - <MarketsRouteGuard redirect="…">…</…>   路由守卫 —— 堵 deep-link（投资/行情屏栈 + 薄路由 + tab 落地屏）。
//                                              off → <Redirect>（沿 app/(app)/alert/[symbol].tsx 同步守卫先例）。
//   - 底部 Tab 按钮：用 FEATURE_MARKETS_ENABLED 直接控 href（见 (tabs)/_layout.tsx；Tabs.Screen
//     的 href:null 只隐按钮，真正不可达靠落地屏的 MarketsRouteGuard）。
//   - 内嵌栏 / 面板（`tab-panel`）：没有自己的路由 ⇒ 门控落在宿主屏的可见性判定
//     （如「我的」三栏的 `~/profile/profile-tabs.rules`）。不渲染 ⇒ 栏内请求一条都不发。
//
// 🔧 新增受控面时：① 在新面落对应门控（Gate / RouteGuard / href）② 在下方 MARKETS_SURFACES 登记。
//    MARKETS_SURFACES 是「这套门控到底盖住了哪些对外面」的唯一清单，review / 合规回归照它走。
import { Redirect, type Href } from 'expo-router';
import type { ReactNode } from 'react';

import { FEATURE_MARKETS_ENABLED } from './feature-flags';

/** 渲染门：enabled 时渲染 children，否则不渲染（隐藏入口）。 */
export function MarketsGate({ children }: { children: ReactNode }) {
  return FEATURE_MARKETS_ENABLED ? <>{children}</> : null;
}

/** 路由守卫：enabled 时渲染 children，否则重定向（堵 deep-link 直达）。 */
export function MarketsRouteGuard({ redirect, children }: { redirect: Href; children: ReactNode }) {
  if (!FEATURE_MARKETS_ENABLED) return <Redirect href={redirect} />;
  return <>{children}</>;
}

/**
 * 受控面清单（SoT）—— 所有受本 flag 门控的「投资/行情」对外面。
 * 新增面在此登记 + 落对应门控。off 态合规回归 e2e（fast-follow）照此清单断言。
 */
export const MARKETS_SURFACES = [
  {
    kind: 'tab-button',
    site: 'app/(app)/(tabs)/_layout.tsx',
    note: '投资 Tab 按钮（href:null 隐藏）',
  },
  { kind: 'tab-screen', site: 'app/(app)/(tabs)/portfolio.tsx', redirect: '/(app)/(tabs)/profile' },
  {
    kind: 'route-stack',
    site: 'app/(app)/portfolio/_layout.tsx',
    redirect: '/(app)/(tabs)/profile',
  },
  { kind: 'route-stack', site: 'app/(app)/alert/_layout.tsx', redirect: '/(app)/(tabs)/profile' },
  // 045 期权台（FR-022 / SC-008）：与投资 tab 同档门控，纯客户端一层 —— server 端点不加第二套
  // （合规目标 = 公开发行的 App 不呈现行情；server 面本就单用户鉴权、无匿名可达面）。
  {
    kind: 'tab-button',
    site: 'app/(app)/(tabs)/_layout.tsx',
    note: '期权台 Tab 按钮（href:null 隐藏）',
  },
  {
    kind: 'tab-screen',
    site: 'app/(app)/(tabs)/optionsdesk.tsx',
    redirect: '/(app)/(tabs)/profile',
  },
  {
    kind: 'route-stack',
    site: 'app/(app)/optionsdesk/_layout.tsx',
    redirect: '/(app)/(tabs)/profile',
  },
  {
    kind: 'entry-card',
    site: 'app/(app)/settings/index.tsx',
    note: '投资设置 Card：证券市场 + 券商账户',
  },
  { kind: 'route', site: 'app/(app)/settings/stock-market.tsx', redirect: '/(app)/settings' },
  { kind: 'route', site: 'app/(app)/settings/broker-accounts.tsx', redirect: '/(app)/settings' },
  {
    kind: 'route',
    site: 'app/(app)/settings/broker-accounts/bind.tsx',
    redirect: '/(app)/settings',
  },
  // 072 T016（FR-011 / SC-005 / sb-19）：「我的」页两个内嵌栏。它们**没有自己的路由** ——
  // 门控是渲染门，判定在 `~/profile/profile-tabs.rules` 的 `visibleProfileTabs`
  // （markets off ⇒ 两栏都不渲染，栏内的请求因此一条都不发）。审批详情等二级页走
  // optionsdesk 栈，已由上面那条 route-stack 的 MarketsRouteGuard 覆盖，不另登记。
  {
    kind: 'tab-panel',
    site: 'app/(app)/(tabs)/profile.tsx',
    note: '「我的」审批栏（锚待审箱内嵌面板）',
  },
  {
    kind: 'tab-panel',
    site: 'app/(app)/(tabs)/profile.tsx',
    note: '「我的」消息栏（预警消息中心内嵌面板）',
  },
] as const;
