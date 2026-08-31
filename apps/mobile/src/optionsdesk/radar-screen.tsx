// 045 期权台 tab 落地屏 = 击球区雷达（mockup 帧 ①~④ / ⑩）。
//
// 五态（常态 / 全体不动区 / 行情降级 / 零锚 / 筛选无结果）+ 多选筛选 chips + 下拉增量加载
// + 新鲜度条。判定与文案见 `radar.rules.ts` / server 下发的 `emptyStateMessage`。
//
// 🚨 **每行恰好 5 字段**（plan D13）：标的标识（标的名 + ticker）/ 距 W% / 四区间色带 / spot / 徽标。
//    spot 串**不重复**「· 距 W xx%」—— 标题行已有一份。
//    主位是**标的名**（D13 原文「ticker + 中文名」）；名字取不到才退回代号 —— 判据在
//    `underlying-identity.rules.ts`（锚列表 / 详情题头共用同一份），屏这层不重判。
// 🚨 **SC-002 下拉增量加载，全程无页码控件**（游标分页天然不支持跳页）。
// 🚨 **不渲染顶部四视图 seg**（FR-020：其余三视图依赖期权链数据，本片只交付标的视图，
//    渲染 seg 会造出三个永远空的 Tab）。
// 🚨 三个入口都是**真入口**：⚙ 进锚管理（045）、🌡 直达 P7 波动温度计（046 T023 / FR-021）、
//    **行点击进该票的标的详情**（046 T028 / US1-AS1）。045 那版后两者是灰置 /「即将可用」轻
//    提示 —— 那是**以「详情页与温度计页尚不存在」为前提**的占位，T021/T022 落地后前提失效，
//    页内不再留该占位（机械防线在 `radar.rules.spec.ts`：雷达文案子树深走零命中）。
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';
import type {
  AnchorResponse,
  AnchorResponseLLevelEffective,
  AnchorResponseZone,
} from '@nvy/api-client';

import { DrawerMenuButton } from '~/core/app-shell-drawer';
import { colors } from '~/theme';
import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { RadarMarketTabs } from './radar-market-tabs';
import {
  distanceToWTone,
  radarRowFields,
  type RadarBadge,
  type RadarFilterKey,
  type RadarFreshnessTier,
} from './radar.rules';
import {
  OPTIONSDESK_ANCHOR_NEW_ROUTE,
  OPTIONSDESK_ANCHORS_ROUTE,
  OPTIONSDESK_THERMOMETER_ROUTE,
  optionsdeskUnderlyingRoute,
} from './optionsdesk-routes';
import { useRadar } from './use-radar';
import { ZoneBand } from './zone-band';

const COPY = OPTIONSDESK_COPY.radar;

/** chips 文案。L1–L4 直接用档名；两个布尔维度取业务措辞。 */
const FILTER_LABEL: Record<RadarFilterKey, string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
  pendingReview: COPY.filterPendingReview,
  belowW: COPY.filterBelowW,
};

const L_LEVEL_BADGE: Record<AnchorResponseLLevelEffective, string> = {
  L1: 'bg-tag-blue',
  L2: 'bg-tag-purple',
  L3: 'bg-tag-teal',
  L4: 'bg-tag-gray',
};

const ZONE_BADGE: Record<NonNullable<AnchorResponseZone>, string> = {
  deep_buy: 'bg-err-soft',
  buy: 'bg-ok-soft',
  thin: 'bg-surface-sunken',
  expensive: 'bg-surface-sunken',
  overvalued: 'bg-surface-sunken',
};

/** 新鲜度条底色：当期中性、陈旧 / 不可用转警示（禁静默当实时，FR-016）。 */
const FRESHNESS_TONE: Record<RadarFreshnessTier, string> = {
  CURRENT: 'bg-surface-alt',
  STALE: 'bg-warn-soft',
  UNAVAILABLE: 'bg-warn-soft',
};

export function RadarScreen() {
  const router = useRouter();
  const radar = useRadar();

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-surface">
      {/* 题头（tab 无 navigator header，屏内自绘，同 watchlist-main-screen 体例）。
          左上汉堡开全局抽屉（FR-023）。 */}
      <View className="flex-row items-center justify-between border-b border-line-soft px-md py-sm">
        <View className="flex-1 flex-row">
          <DrawerMenuButton testID="optionsdesk-menu-button" />
        </View>
        <Text className="text-base font-semibold text-ink">{OPTIONSDESK_COPY.radarTitle}</Text>
        <View className="flex-1 flex-row justify-end">
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full"
            onPress={() => router.push(OPTIONSDESK_ANCHORS_ROUTE)}
            accessibilityRole="button"
            accessibilityLabel={OPTIONSDESK_COPY.anchorsEntry}
            testID="optionsdesk-anchors-button"
          >
            <GearGlyph />
          </Pressable>
          <Pressable
            className="h-10 w-10 items-center justify-center rounded-full"
            onPress={() => router.push(OPTIONSDESK_THERMOMETER_ROUTE)}
            accessibilityRole="button"
            accessibilityLabel={COPY.thermometer}
            testID="optionsdesk-thermometer-button"
          >
            {/* 046 T023：真入口 ⇒ 去掉 045 的灰置调（`text-ink-subtle` 是「不可点」的视觉信号）。 */}
            <Text className="text-base">🌡</Text>
          </Pressable>
        </View>
      </View>

      {/* 市场页签（065 FR-001）—— 紧贴题头下方，作用域切换是本屏最外层的取数维度。 */}
      <RadarMarketTabs
        market={radar.market}
        onSelect={radar.selectMarket}
        actionableMarkets={radar.actionableMarkets}
      />

      {/* 新鲜度条：每个行情数值都带 asOf 与档位（FR-016）。 */}
      {radar.items.length > 0 ? (
        <View
          className={`flex-row items-center justify-between px-md py-xs ${FRESHNESS_TONE[radar.freshness.tier]}`}
          testID={`optionsdesk-radar-freshness-${radar.freshness.tier}`}
        >
          <Text className="text-xs text-ink-muted">{radar.freshness.text}</Text>
          <Text className="text-xs text-ink-subtle">{COPY.sortLabel}</Text>
        </View>
      ) : null}

      {/* 筛选 chips（**多选**）。🚨 某档无锚不是错误，chips 恒定 6 项、不按数据隐藏（FR-008）。
          横滑容器包一层 View 约束 frame（NativeWind web 坑）。 */}
      <View className="px-md py-sm">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-sm">
            {(Object.keys(FILTER_LABEL) as RadarFilterKey[]).map((key) => {
              const on = radar.selectedFilters.includes(key);
              return (
                <Pressable
                  key={key}
                  onPress={() => radar.toggleFilter(key)}
                  accessibilityRole="button"
                  accessibilityLabel={FILTER_LABEL[key]}
                  accessibilityState={{ selected: on }}
                  testID={`optionsdesk-radar-filter-${key}`}
                  className={`rounded-full border px-md py-xs ${
                    on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface'
                  }`}
                >
                  <Text className={`text-sm ${on ? 'text-brand-500' : 'text-ink-muted'}`}>
                    {FILTER_LABEL[key]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      <View className="flex-1 bg-surface-sunken">
        <RadarBody radar={radar} router={router} />
      </View>
    </SafeAreaView>
  );
}

interface RadarBodyProps {
  radar: ReturnType<typeof useRadar>;
  router: ReturnType<typeof useRouter>;
}

function RadarBody({ radar, router }: RadarBodyProps) {
  if (radar.isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner size={16} tone="muted" />
      </View>
    );
  }
  if (radar.isError) {
    return (
      <View className="px-md pt-md">
        <ErrorRow text={COPY.loadFailed} />
      </View>
    );
  }

  // 零锚 / 筛选无结果：两条文案**由 server 下发**（三态 MUST NOT 复用同一句），前端只配行动入口。
  if (radar.viewState === 'zero_anchors') {
    return (
      <View className="flex-1 items-center justify-center gap-md px-xl">
        <Text className="text-center text-sm text-ink-muted" testID="optionsdesk-radar-empty-zero">
          {radar.emptyStateMessage}
        </Text>
        <Pressable
          onPress={() => router.push(OPTIONSDESK_ANCHOR_NEW_ROUTE)}
          accessibilityRole="button"
          accessibilityLabel={COPY.goCreateAnchor}
          testID="optionsdesk-radar-create-anchor"
          className="rounded-full bg-brand-500 px-lg py-sm"
        >
          <Text className="text-sm font-semibold text-white">{COPY.goCreateAnchor}</Text>
        </Pressable>
      </View>
    );
  }
  // 065 T13 第 4 空态：**只渲文案、零按钮** —— 有效动作是「切市场」，而市场页签就在这块区域
  // 正上方（FR-010）。🚫 MUST NOT 复用「去建锚」CTA：库里已经有锚了，引导建锚会让人以为自己
  // 之前建的锚丢了；也 MUST NOT 落「清除筛选」（当时根本没选筛选，那是 fall-through 的病症）。
  if (radar.viewState === 'zero_anchors_in_market') {
    return (
      <View className="flex-1 items-center justify-center px-xl">
        <Text
          className="text-center text-sm text-ink-muted"
          testID="optionsdesk-radar-empty-market"
        >
          {radar.emptyStateMessage}
        </Text>
      </View>
    );
  }
  if (radar.viewState === 'filtered_empty') {
    return (
      <View className="flex-1 items-center justify-center gap-md px-xl">
        <Text
          className="text-center text-sm text-ink-muted"
          testID="optionsdesk-radar-empty-filtered"
        >
          {radar.emptyStateMessage}
        </Text>
        <Pressable
          onPress={radar.clearFilters}
          accessibilityRole="button"
          accessibilityLabel={COPY.clearFilter}
          testID="optionsdesk-radar-clear-filter"
        >
          <Text className="text-sm text-brand-500">{COPY.clearFilter}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      testID="optionsdesk-radar-list"
      data={radar.items}
      keyExtractor={(a) => a.id}
      renderItem={({ item }) => (
        // T028：进该票的标的详情。`ticker` 是 canonical `market:code`，冒号转义在路由函数内。
        <RadarRow
          anchor={item}
          onPress={() => router.push(optionsdeskUnderlyingRoute(item.ticker))}
        />
      )}
      contentContainerClassName="px-md pb-lg gap-sm"
      refreshControl={<RefreshControl refreshing={radar.isRefetching} onRefresh={radar.refetch} />}
      // SC-002：滚到底自动取下一页 —— **没有任何页码控件**。
      onEndReached={() => {
        if (radar.hasNextPage && !radar.isFetchingNextPage) radar.fetchNextPage();
      }}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        // 全体不动区：行**照常渲染**，只在顶部加提示（非空白页，FR-015）。
        radar.viewState === 'all_idle' ? (
          <View
            className="mb-sm rounded-md border border-line bg-surface-alt px-md py-sm"
            testID="optionsdesk-radar-banner-idle"
          >
            <Text className="text-center text-sm text-ink-muted">{radar.emptyStateMessage}</Text>
          </View>
        ) : null
      }
      ListFooterComponent={
        <Text className="py-sm text-center text-xs text-ink-subtle" testID="optionsdesk-radar-more">
          {radar.isFetchingNextPage
            ? COPY.loadingMore
            : radar.hasNextPage
              ? COPY.loadMore
              : COPY.noMore}
        </Text>
      }
    />
  );
}

interface RadarRowProps {
  anchor: AnchorResponse;
  onPress: () => void;
}

/** 一票一卡。5 字段：标的标识 / 距 W% / 色带 / spot / 徽标（plan D13）。 */
function RadarRow({ anchor, onPress }: RadarRowProps) {
  const fields = radarRowFields(anchor);
  const tone = distanceToWTone(anchor);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={anchor.ticker}
      testID={`optionsdesk-radar-row-${anchor.ticker}`}
      className="gap-sm rounded-md border border-line bg-surface px-md py-sm"
    >
      {/* ① 标的标识（标的名 + ticker 同一维度） + ② 距 W% */}
      <View className="flex-row items-baseline gap-sm">
        {/* 🚨 主位挂 `shrink`：名字长到挤不下时**它先截**，MUST NOT 把距 W% 顶出屏外。 */}
        <Text className="shrink text-base font-bold text-ink" numberOfLines={1}>
          {fields.identity.primary}
        </Text>
        <Text className="flex-1 text-xs text-ink-subtle" numberOfLines={1}>
          {fields.identity.ticker}
        </Text>
        <Text
          className={`font-mono text-sm font-semibold ${
            tone === 'below' ? 'text-err' : tone === 'above' ? 'text-ink' : 'text-ink-subtle'
          }`}
        >
          {fields.distanceToW}
        </Text>
      </View>

      {/* ③ 四区间色带（spot 黑点 / 钳制空心点在组件内） */}
      <ZoneBand anchor={fields.band} testID={`optionsdesk-radar-band-${anchor.ticker}`} />

      {/* ⑤ 徽标 + ④ spot（spot 靠右，串内不重复距 W） */}
      <View className="flex-row flex-wrap items-center gap-xs">
        {fields.badges.map((badge) => (
          <RadarBadgePill key={badge.kind} badge={badge} anchor={anchor} />
        ))}
        <Text className="ml-auto font-mono text-xs text-ink-muted">{fields.spot}</Text>
      </View>
    </Pressable>
  );
}

/** 徽标 pill。逾期用**描边**、复核锚用**实底**，靠形状 + 文案区分（非新色）。 */
function RadarBadgePill({ badge, anchor }: { badge: RadarBadge; anchor: AnchorResponse }) {
  const { box, text } = badgeTone(badge, anchor);
  return (
    <View className={`rounded-full px-sm py-0.5 ${box}`}>
      <Text className={`text-xs font-semibold ${text}`}>{badge.text}</Text>
    </View>
  );
}

function badgeTone(badge: RadarBadge, anchor: AnchorResponse): { box: string; text: string } {
  switch (badge.kind) {
    case 'l_level':
      return { box: L_LEVEL_BADGE[anchor.lLevelEffective], text: 'text-white' };
    case 'zone':
      return { box: anchor.zone ? ZONE_BADGE[anchor.zone] : 'bg-surface-sunken', text: 'text-ink' };
    case 'overdue':
      return { box: 'border border-err', text: 'text-err' };
    case 'review_flag':
      return { box: 'bg-err', text: 'text-white' };
    case 'quote_unavailable':
      return { box: 'bg-surface-sunken', text: 'text-ink-subtle' };
  }
}

// ─────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────

function GearGlyph() {
  return (
    <Svg
      width={21}
      height={21}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={12} cy={12} r={3.2} />
      <Path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.5l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </Svg>
  );
}
