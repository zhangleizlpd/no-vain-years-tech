// FR-013 / FR-024 — bottom tab bar registers 4 routes (首页 / 期权台 / 投资 / 我的).
// 图标系统 per portfolio handoff「底部 Tab 图标系统」(2026-05-29)：线性描边 24×24,
// inactive 中性灰 (ink.subtle) / active 品牌蓝实心 (brand[500])，经 ~/ui TabBarIcon。
//
// 高度 + 安全区：**不覆写** tabBarStyle.height。React Navigation v7 bottom-tabs 的高度是
// 平台常量 `49 + insets.bottom`（getTabBarHeight in BottomTabBar.tsx），且**只有「不传数字
// height」时它才会自动叠 insets.bottom**（传数字会短路、丢掉 inset，得自己重算 + 自己补
// paddingBottom）。让库自管高度 + iOS home indicator 安全区，iOS/Android/web 三端一致。
//
// 标签裁切根因（web + CJK）：RN 的 tab label 是 `<Text numberOfLines={1}>`，RN-Web 下
// numberOfLines 会加 `overflow:hidden`；缺显式 lineHeight 时 CJK 字形（满 em 盒、descender
// 长）落在行盒外被裁（necolas/react-native-web#1585）。web 上 insets.bottom=0 → bar 恰好
// 49px，CJK 标签最先溢出，故只在 web 暴露。修法 = 显式 lineHeight > fontSize（~1.3×），
// 含住字形盒 —— 与高度无关，高度从不是问题。

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Tabs, useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FEATURE_MARKETS_ENABLED } from '~/core/feature-flags';
import { AppShellDrawerProvider } from '~/core/app-shell-drawer';
import { tokens } from '~/theme';
import { TabBarIcon, type TabIconName } from '~/ui';
import { CreateOverlay, IDEATION_COPY } from '~/ideation';

// `gated` = markets 功能 family（公开版隐藏，见 ~/core/markets-gate MARKETS_SURFACES）。
// 045 FR-021：「灵感」tab 退位给「期权台」（gated），ideation 路由**留在 (tabs)/ 下**只摘按钮
// （见下方 href:null 的 Tabs.Screen），入口改由全局抽屉菜单承载。
// ideation 仍是 tab 内嵌 stack（列表 index + 详情 [id]）：原「外脑/pkm」转发 stack 退役——它跨
// (tabs)→兄弟 stack 导航，在 Fabric 下触发 react-native-screens view-recycling 重挂崩（SvgView
// already has a parent，screens #3249）。收进 (tabs) 后列表→详情 = 同 navigator 内 push，不再
// 跨 stack 重挂 → 根除崩；这也是 FR-025 要求它别搬家的原因。PKM 知识库 unpark 后再以独立 tab 回归。
const TABS: { name: string; label: string; icon: TabIconName; gated?: boolean }[] = [
  { name: 'index', label: '首页', icon: 'home' },
  { name: 'optionsdesk', label: '期权台', icon: 'optionsdesk', gated: true },
  { name: 'portfolio', label: '投资', icon: 'invest', gated: true },
  { name: 'profile', label: '我的', icon: 'profile' },
];

// ideation「全屏」子屏隐藏底部 tab 栏 + 中央 FAB：① [id] 澄清对话（键盘顶起时输入条紧贴键盘，
// tab 栏在场会多垫高度破坏 ClarifyChatScreen 里 KeyboardStickyView 的 insets.bottom 偏移）；
// ② image-viewer / image-annotate 图片查看/标注（沉浸式全屏，不要 tab 栏与绿色 FAB 抢空间，真机
// Mate50 要求）。列表屏（index）及其余 tab 不受影响。
const IDEATION_FULLSCREEN_ROUTES = ['[id]', 'image-viewer', 'image-annotate'];

const TAB_ICON_SIZE = 24; // 与 TabBarIcon viewBox 一致
const TAB_LABEL_FONT_SIZE = 11; // 比 RN 默认(10)略大、贴近 design handoff；整档可调
const TAB_LABEL_LINE_HEIGHT = 15; // > fontSize，含住 CJK descender —— 修裁切的唯一杠杆

// 中央绿色 + FAB（2026-06-25 真机调优）：尺寸 72（原 64 放大）。垂直锚点 = 底边距「安全区底」
// 的恒定呼吸间隙 FAB_BOTTOM_GAP（替代旧「露出栏顶 25%」深沉式 —— 旧式底边落在 insets-5，gesture-nav
// 真机贴死栏底、web（insets=0）更为负值裁掉底边）。12 ≈ 让 72px FAB 半身卡在 49px tab 栏顶边
// （half-in/half-out，业内 center-FAB 标准观感）；三端恒定、独立 insets。首页输入药丸在其上方
// ~一指宽（实测净空 ~50px，不重叠），空槽无 icon/label，FAB 不压任何 tab。
const FAB_SIZE = 72;
const FAB_BOTTOM_GAP = 12; // FAB 底边抬离安全区底的呼吸间隙（三端恒定，web insets=0 也不贴底/裁切）

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const [overlayVisible, setOverlayVisible] = useState(false);

  // 灵感「全屏」子屏（[id] 对话 / image-viewer / image-annotate）隐藏中央 FAB **与底部 tab 栏**：
  // 这些屏无「新建」语义，且 FAB 会盖住底部输入条 / 抢占沉浸式全屏空间。其余 tab / 灵感列表屏
  // 照常（同一 IDEATION_FULLSCREEN_ROUTES 集合，tab 栏那半见下方 screenOptions.tabBarStyle）。
  const segments = useSegments();
  const onIdeationFullScreen =
    segments.includes('ideation') &&
    IDEATION_FULLSCREEN_ROUTES.includes(segments[segments.length - 1] ?? '');

  // 中央绿色 + FAB（FR-001）：root 层 absolute 叠加在 tab 栏「中央空槽」上，**不覆写 tab 栏高度**。
  // 垂直：底边恒定抬离安全区底 FAB_BOTTOM_GAP，FAB 半身露出栏顶（首页输入药丸在其上方实测不重叠）。
  // root overlay（而非 tabBarButton）的理由：tabBarButton 受栏高约束、凸出部分在 Android 落
  // 在父盒外不可点；root overlay 的 Pressable 完整覆盖 FAB，整圆可点。
  const fabBottom = insets.bottom + FAB_BOTTOM_GAP;

  // 水平：FAB 对齐「中央空槽」的槽心。空槽插在 TABS 中点（4 tab → 2 左 2 右）；gating 隐藏的
  // tab（期权台 / 投资，markets off）不占槽位，故按**可见** tab 数算槽心 → markets on=5 槽→50%，
  // off=3 槽→50%（FAB 居其空槽中心，两端 tab 始终均分、不与 FAB 挤）。
  // 🚨 公式按可见集合动态算，**不要**因「两态恰好都是 50%」把它拍成常量：045 前 off 态是 62.5%，
  // 现在两边各少一个 gated tab 才碰巧对称（plan D10 已纠正 mockup 帧 ⑪ 的「固定 50%」误导）。
  const fabSlotMid = Math.ceil(TABS.length / 2);
  const isTabVisible = (t: (typeof TABS)[number]) => !(t.gated && !FEATURE_MARKETS_ENABLED);
  const leftVisible = TABS.slice(0, fabSlotMid).filter(isTabVisible).length;
  const rightVisible = TABS.slice(fabSlotMid).filter(isTabVisible).length;
  const fabLeftPct = ((leftVisible + 0.5) / (leftVisible + 1 + rightVisible)) * 100;

  // tab 渲染序：真 tab 中点插入中央空槽（占位路由 create，撑起 flex 槽位）。
  const tabItems: Array<(typeof TABS)[number] | { spacer: true }> = [
    ...TABS.slice(0, fabSlotMid),
    { spacer: true },
    ...TABS.slice(fabSlotMid),
  ];

  return (
    // 全局抽屉挂在 **tabs layout 层**（045 T021, plan D11）：抽屉本体是 root 层 Modal（遮罩盖住
    // Tab 栏），open 态由 Provider 持有，一级 tab 屏题头的汉堡经 useAppShellDrawer 开它。
    // 首页（chat）例外：其汉堡维持开 chat 会话抽屉，灵感入口以同一组件落在那个抽屉里（方案 C）。
    <AppShellDrawerProvider>
      <View style={{ flex: 1 }}>
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: tokens.colors.brand[500],
            tabBarInactiveTintColor: tokens.colors.ink.subtle,
            // 显式 lineHeight（> fontSize）含住 CJK 字形盒，根治 web 端 overflow:hidden 裁切。
            tabBarLabelStyle: {
              fontSize: TAB_LABEL_FONT_SIZE,
              lineHeight: TAB_LABEL_LINE_HEIGHT,
            },
            // 灵感全屏子屏隐藏 tab 栏（与中央 FAB 同一开关 onIdeationFullScreen）。
            // 🚨 落在**顶层 screenOptions**、不再走 ideation 的 per-screen 函数形式 options：
            // expo-router 的 href shortcut 只对**非函数** options 生效（layouts/TabsClient.js
            // `typeof screen.options !== 'function'`），而 ideation 现在必须带 href:null 摘按钮 ——
            // 函数形式会让 href 被静默丢弃、tab 照常渲染（045 之前它非门控故无碍，现在会翻车）。
            // 顶层是 plain 对象、随 useSegments 重渲染重算，与旧 getFocusedRouteNameFromRoute 等效
            // （tabBarStyle 只有 focused 屏那份生效，离开灵感即恢复）。
            // 不设 tabBarStyle.height —— 交给 RN 的 49 + insets.bottom 自适应三端安全区。
            tabBarStyle: onIdeationFullScreen ? { display: 'none' } : undefined,
          }}
        >
          {tabItems.map((item) => {
            if ('spacer' in item) {
              // 中央空槽：占一个 flex 槽位、非交互（点击交给 root 层 FAB）、a11y 隐藏。
              // 对应占位路由 (tabs)/create.tsx（永不展示，见该文件注释）。
              return (
                <Tabs.Screen
                  key="__fab_spacer"
                  name="create"
                  options={{
                    tabBarButton: () => <View style={{ flex: 1 }} pointerEvents="none" />,
                  }}
                />
              );
            }
            const { name, label, icon, gated } = item;
            const baseOptions = {
              title: label,
              tabBarLabel: label,
              tabBarIcon: ({ focused, color }: { focused: boolean; color: string }) => (
                <TabBarIcon name={icon} focused={focused} color={color} size={TAB_ICON_SIZE} />
              ),
              // markets off → href:null 隐藏 tab 按钮；真正不可达靠 portfolio.tsx 落地屏 MarketsRouteGuard。
              // 🚨 href:null 必须留在**静态 options 对象**里：expo-router 在布局期读静态 href 决定 tab
              // 是否渲染；options 用函数形式时 href 不被采纳 → 门控失效（投资 tab 在公开版会漏出）。
              ...(gated && !FEATURE_MARKETS_ENABLED ? { href: null } : {}),
            };
            // 全部 tab 走**静态** options 对象 —— 函数形式会让 href shortcut 失效（见 screenOptions
            // 注释）。动态项（灵感全屏子屏隐藏 tab 栏）已上移到顶层 screenOptions。
            return <Tabs.Screen key={name} name={name} options={baseOptions} />;
          })}
          {/* 灵感：045 起不占 tab 槽（FR-021），但**路由留在 (tabs)/ 下**（FR-025 零回归：中央 FAB
            与 IDEATION_FULLSCREEN_ROUTES 的 tab 栏隐藏都活在本 layout 层，移出去会一并打掉），
            仅 href:null 摘掉按钮 —— 路由本身照常可达（deep-link / router.push / 抽屉菜单入口）。
            不进 TABS 数组：否则它会参与 FAB 槽心计算。 */}
          <Tabs.Screen name="ideation" options={{ href: null, title: '灵感' }} />
        </Tabs>
        {/* 中央绿色 + FAB —— root 层 absolute 叠加（不占 tab 槽位、不改栏高）。详情屏隐藏（见上注）。 */}
        {onIdeationFullScreen ? null : (
          <Pressable
            onPress={() => setOverlayVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={IDEATION_COPY.fab}
            className="absolute bg-ok items-center justify-center"
            style={{
              width: FAB_SIZE,
              height: FAB_SIZE,
              borderRadius: FAB_SIZE / 2,
              bottom: fabBottom,
              left: `${fabLeftPct}%`,
              marginLeft: -FAB_SIZE / 2,
              borderWidth: 4,
              borderColor: tokens.colors.surface.DEFAULT,
            }}
          >
            <Text
              className="text-white font-light leading-none"
              style={{ fontSize: FAB_SIZE * 0.5 }}
            >
              +
            </Text>
          </Pressable>
        )}
        <CreateOverlay
          visible={overlayVisible}
          onClose={() => setOverlayVisible(false)}
          anchorLeftPct={fabLeftPct}
        />
      </View>
    </AppShellDrawerProvider>
  );
}
