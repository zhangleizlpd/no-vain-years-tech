// 045 T022 — 锚管理列表屏（mockup 帧 ⑤）。二级页，雷达题头 ⚙ 进入；题头左上是**返回箭头**
// 而非汉堡（FR-024，navigator header 自带，屏内不自绘）。
//
// 🚨 Guardrail 12：列表**必须显示 `excluded` 的锚并带 `excludeReason`**（FR-005）—— 与雷达
//    默认把它排除掉的态度**相反**。故这里的 list 查询**不带 `excluded` 参数**（省略 = 全都要）。
// 三态同屏：正常 / 逾期红标（FR-004 行不隐藏、字段照常可读）/ 已排除（灰底 + reason）。
// 筛选 chips **单选**（雷达那处才是多选）。
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useOptionsdeskControllerList, type AnchorResponse } from '@nvy/api-client';

import { todayYmd } from '~/format/as-of';
import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import {
  ANCHOR_FILTERS,
  anchorFilterCounts,
  anchorRowState,
  daysOverdue,
  filterAnchors,
  selectAnchorFilter,
  type AnchorFilter,
} from './anchor-list.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { OPTIONSDESK_ANCHOR_NEW_ROUTE, optionsdeskAnchorEditRoute } from './optionsdesk-routes';
import { formatPriceText } from './price-format.rules';
import { underlyingDisplayName } from './underlying-identity.rules';

const COPY = OPTIONSDESK_COPY.anchorList;

const FILTER_LABEL: Record<AnchorFilter, string> = {
  all: COPY.filterAll,
  pendingReview: COPY.filterPendingReview,
  excluded: COPY.filterExcluded,
};

export function AnchorListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<AnchorFilter>('all');

  // 不带筛选参数 —— 全量取回后在前端切 chips（锚表规模上限约 1000，server 亦无分页）。
  // 这样切 chip 不打网络，且「已排除」永远在手上（Guardrail 12）。
  const list = useOptionsdeskControllerList();
  const items = useMemo<AnchorResponse[]>(() => list.data?.data.items ?? [], [list.data]);
  const counts = useMemo(() => anchorFilterCounts(items), [items]);
  const rows = useMemo(() => filterAnchors(items, filter), [items, filter]);
  const today = todayYmd();

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: COPY.title,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(OPTIONSDESK_ANCHOR_NEW_ROUTE)}
              accessibilityRole="button"
              accessibilityLabel={COPY.create}
              testID="optionsdesk-anchor-create"
            >
              <Text className="text-xl text-brand-500 px-md">＋</Text>
            </Pressable>
          ),
        }}
      />

      <View className="flex-1 bg-surface-sunken">
        {/* 筛选 chips（单选）。横滑容器包一层 View 约束 frame（NativeWind web 坑）。 */}
        <View className="px-md py-sm">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-sm">
              {ANCHOR_FILTERS.map((f) => {
                const on = filter === f;
                return (
                  <Pressable
                    key={f}
                    onPress={() => setFilter((cur) => selectAnchorFilter(cur, f))}
                    accessibilityRole="button"
                    accessibilityLabel={FILTER_LABEL[f]}
                    accessibilityState={{ selected: on }}
                    testID={`optionsdesk-anchor-filter-${f}`}
                    className={`rounded-full border px-md py-xs ${
                      on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface'
                    }`}
                  >
                    <Text className={`text-sm ${on ? 'text-brand-500' : 'text-ink-muted'}`}>
                      {FILTER_LABEL[f]} {counts[f]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>

        {list.isLoading ? (
          <View className="flex-1 items-center justify-center">
            <Spinner size={16} tone="muted" />
          </View>
        ) : list.isError ? (
          <View className="px-md">
            <ErrorRow text={COPY.loadFailed} />
          </View>
        ) : rows.length === 0 ? (
          // 两种空态不复用文案：零锚（引导建锚）vs 筛选无结果（给清除筛选）。
          <View className="flex-1 items-center justify-center px-xl gap-md">
            {items.length === 0 ? (
              <Text
                className="text-sm text-ink-muted text-center"
                testID="optionsdesk-anchor-empty"
              >
                {COPY.emptyAll}
              </Text>
            ) : (
              <>
                <Text
                  className="text-sm text-ink-muted text-center"
                  testID="optionsdesk-anchor-filter-empty"
                >
                  {COPY.emptyFiltered}
                </Text>
                <Pressable
                  onPress={() => setFilter('all')}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.clearFilter}
                  testID="optionsdesk-anchor-clear-filter"
                >
                  <Text className="text-sm text-brand-500">{COPY.clearFilter}</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : (
          <ScrollView className="flex-1" testID="optionsdesk-anchor-list">
            <View className="px-md pb-lg gap-sm">
              {rows.map((anchor) => (
                <AnchorCard
                  key={anchor.id}
                  anchor={anchor}
                  today={today}
                  onPress={() => router.push(optionsdeskAnchorEditRoute(anchor.id))}
                />
              ))}
            </View>
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

interface AnchorCardProps {
  anchor: AnchorResponse;
  today: string;
  onPress: () => void;
}

function AnchorCard({ anchor, today, onPress }: AnchorCardProps) {
  const state = anchorRowState(anchor);
  const overdueDays = daysOverdue(anchor.nextReview, today);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={anchor.ticker}
      testID={`optionsdesk-anchor-row-${anchor.ticker}`}
      className={`rounded-md border p-md gap-sm ${
        state === 'excluded' ? 'border-line bg-surface-alt' : 'border-line-soft bg-surface'
      }`}
    >
      <View className="flex-row items-center gap-sm">
        {/* 主位 = 标的名（045 plan D13，判据与雷达 / 详情题头共用一份）；名字取不到才退回代号。
            🚨 挂 `shrink`：名字长到挤不下时**它先截**，MUST NOT 把右侧 L 层徽标顶出屏外。 */}
        <Text className="shrink text-base font-semibold text-ink" numberOfLines={1}>
          {underlyingDisplayName(anchor)}
        </Text>
        <Text className="flex-1 text-xs text-ink-muted" numberOfLines={1}>
          {anchor.ticker}
        </Text>
        <View className="border border-line rounded-sm px-xs">
          <Text className="text-xs text-ink-muted">{anchor.lLevelEffective}</Text>
        </View>
      </View>

      {/* 逾期红标 —— 行不隐藏、字段照常可读（FR-004）。 */}
      {anchor.overdue ? (
        <View
          className="self-start border border-err rounded-sm px-xs"
          testID={`optionsdesk-anchor-overdue-${anchor.ticker}`}
        >
          <Text className="text-xs text-err">
            {overdueDays !== null && overdueDays > 0 ? COPY.overdueDays(overdueDays) : COPY.overdue}
          </Text>
        </View>
      ) : null}

      <View className="flex-row flex-wrap gap-md">
        <Field label={COPY.vLabel} value={formatPriceText(anchor.v)} />
        <Field label={COPY.wLabel} value={formatPriceText(anchor.w)} />
        <Field label={COPY.confidenceLabel} value={anchor.confidence} />
        <Field label={COPY.nextReviewLabel} value={anchor.nextReview ?? COPY.noValue} />
      </View>

      {/* FR-005 + Guardrail 12：已排除照常在列，并带 reason。 */}
      {state === 'excluded' ? (
        <View className="gap-xs" testID={`optionsdesk-anchor-excluded-${anchor.ticker}`}>
          <Text className="text-xs text-ink-muted">{COPY.excluded}</Text>
          <Text className="text-xs text-ink-subtle">
            {COPY.excludeReasonPrefix}
            {anchor.excludeReason ?? COPY.noValue}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs text-ink-subtle">{label}</Text>
      <Text className="text-sm font-mono text-ink">{value}</Text>
    </View>
  );
}
