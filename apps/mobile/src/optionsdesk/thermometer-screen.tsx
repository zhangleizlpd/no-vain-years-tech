// 046 T022 — 波动温度计屏 P7（mockup `046-thermometer.dc.html` 帧 ⑦~⑩）。
//
// 自上而下：**常驻免责** → VIX 表盘 → 旁列 VVIX / 比值 → 锚定标的 IVP 列表。
//
// 🚨 **FR-019 免责常驻** —— 「不构成开仓理由」渲在 `ScrollView` **之外**，是**非折叠、
//    非 tooltip** 的真节点：任何滚动位置、任何数据态（loading / 失败 / 零锚）都在。
//    它是纯 UI 呈现，server 满足不了 ⇒ **T024 e2e 是它唯一的机械载体**。
// 🚨 **不呈现 regime 读数**（FR-015 📌，2026-08-03 拍板）—— mockup 帧⑦ 画了 `regime N`，
//    **别照抄回来**；server DTO 里也没有该字段。
// 🚨 **表盘与列表是两条独立的线**（FR-018 / FR-027）：零锚 ⇒ 列表空态但表盘照渲；指数
//    不可得 ⇒ 表盘显式不可用但列表照列。
// 🚨 **Guardrail 8**：降级状态字用 `text-ink` / `text-ink-muted`，**不用最淡档**。
// 🚨 **Guardrail 9**：IVP 分段条外层禁 `overflow:hidden`（见 `ivp-segment-bar.tsx`）。
//
// 判定全在 `thermometer.rules.ts`（vitest 覆盖）；渲染 / 交互 / a11y 走 T024 Playwright e2e。
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useOptionsdeskControllerThermometer } from '@nvy/api-client';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { IvpSegmentBar } from './ivp-segment-bar';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { OPTIONSDESK_ANCHORS_ROUTE } from './optionsdesk-routes';
import { alertStatusText, type AlertStatus } from './underlying-detail.rules';
import { thermometerView, type ThermometerRowView } from './thermometer.rules';
import { VixGauge } from './vix-gauge';

const COPY = OPTIONSDESK_COPY.thermometer;
const IV_COPY = OPTIONSDESK_COPY.underlyingDetail.ivBlock;

/** 行内徽标字色 —— 三档递进（`Record` 穷举，漏一档即编译红）。 */
const ALERT_TONE: Record<AlertStatus, string> = {
  not_crossed: 'text-ink-muted',
  crossed_high: 'text-warn',
  crossed_extreme: 'text-err',
};

export function ThermometerScreen() {
  const router = useRouter();
  const query = useOptionsdeskControllerThermometer({ query: { retry: 1 } });
  const data = query.data?.data ?? null;
  const view = data === null ? null : thermometerView(data);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: COPY.title }} />

      {/* 🚨 FR-019 —— ScrollView 之外的常驻节点，滚动 / 降级都盖不掉。 */}
      <View className="bg-warn-soft px-md py-sm" testID="optionsdesk-thermometer-disclaimer">
        <Text className="text-xs text-ink">{COPY.disclaimer}</Text>
      </View>

      <ScrollView
        className="flex-1 bg-surface-sunken"
        contentContainerClassName="gap-sm px-md py-sm"
        testID="optionsdesk-thermometer-scroll"
      >
        {query.isPending ? (
          <View
            className="items-center rounded-md border border-line bg-surface py-lg"
            testID="optionsdesk-thermometer-loading"
          >
            <Spinner size={16} tone="muted" />
          </View>
        ) : view === null ? (
          <View className="gap-sm rounded-md border border-line bg-surface px-md py-sm">
            <ErrorRow text={COPY.loadFailed} />
            <Pressable
              onPress={() => void query.refetch()}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID="optionsdesk-thermometer-retry"
              className="self-center rounded-full border border-line px-md py-0.5"
            >
              <Text className="text-xs text-brand-500">{COPY.retry}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* ── 块 ① VIX 半圆表盘 ──────────────────────────────────────── */}
            <View
              className="items-center gap-sm rounded-md border border-line bg-surface px-md py-md"
              testID="optionsdesk-thermometer-gauge-card"
            >
              <Text className="self-start text-sm font-semibold text-ink">{COPY.gauge.title}</Text>
              <VixGauge view={view.gauge} />
              <Text
                className={`text-xs ${view.gauge.freshness.tier === 'CURRENT' ? 'text-ink-subtle' : 'text-ink-muted'}`}
                testID={`optionsdesk-thermometer-gauge-asof-${view.gauge.freshness.tier}`}
              >
                {view.gauge.freshness.text}
              </Text>
            </View>

            {/* ── 块 ② 旁列 VVIX + 比值（各带各的时点，FR-016 / FR-020） ──── */}
            <View className="flex-row gap-sm">
              <StatCard
                title={COPY.vvix.title}
                valueText={view.vvix.valueText}
                degradedText={view.vvix.degradedText}
                footText={view.vvix.freshness.text}
                testID="optionsdesk-thermometer-vvix"
              />
              <StatCard
                title={COPY.ratio.title}
                valueText={view.ratio.valueText}
                degradedText={view.ratio.noteText}
                footText={
                  view.ratio.basisText === null
                    ? COPY.ratio.normalBand
                    : `${view.ratio.basisText} · ${COPY.ratio.normalBand}`
                }
                testID={`optionsdesk-thermometer-ratio-${view.ratio.state}`}
              />
            </View>

            {/* ── 块 ③ 锚定标的 IVP 列表 ─────────────────────────────────── */}
            <View
              className="gap-sm rounded-md border border-line bg-surface px-md py-sm"
              testID="optionsdesk-thermometer-list"
            >
              <Text className="text-sm font-semibold text-ink">{COPY.list.title}</Text>
              {view.list === 'empty' ? (
                <View
                  className="items-center gap-sm py-md"
                  testID="optionsdesk-thermometer-list-empty"
                >
                  <Text className="text-center text-xs text-ink-muted">{COPY.list.empty}</Text>
                  <Pressable
                    onPress={() => router.push(OPTIONSDESK_ANCHORS_ROUTE)}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.list.goAnchors}
                    testID="optionsdesk-thermometer-go-anchors"
                    className="rounded-full bg-brand-500 px-lg py-sm"
                  >
                    <Text className="text-sm font-semibold text-white">{COPY.list.goAnchors}</Text>
                  </Pressable>
                </View>
              ) : (
                view.rows.map((row) => <IvpRow key={row.ticker} row={row} />)
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** VVIX / 比值的小卡：有值 → 数值；无值 → 显式降级句（**禁 0 冒充**）。 */
function StatCard({
  title,
  valueText,
  degradedText,
  footText,
  testID,
}: {
  title: string;
  valueText: string | null;
  degradedText: string | null;
  footText: string;
  testID: string;
}) {
  return (
    <View
      className="flex-1 gap-xs rounded-md border border-line bg-surface px-md py-sm"
      testID={testID}
    >
      <Text className="text-xs text-ink-muted">{title}</Text>
      {valueText === null ? (
        <Text className="text-sm font-semibold text-ink" testID={`${testID}-degraded`}>
          {degradedText}
        </Text>
      ) : (
        <Text className="font-mono text-xl font-bold text-ink" testID={`${testID}-value`}>
          {valueText}
        </Text>
      )}
      <Text className="text-[10px] text-ink-muted">{footText}</Text>
    </View>
  );
}

/**
 * IVP 单行（FR-018）。
 * 🚨 「分位不可算」行**保留**（只是不出数值、不出徽标、不画位置标记）；
 * 🚨 `excluded` 行**照常列出并带标记**（045 语义：锚 = 采集意愿、excluded = 交易意愿）。
 */
function IvpRow({ row }: { row: ThermometerRowView }) {
  const testID = `optionsdesk-thermometer-row-${row.code}`;
  return (
    <View className="gap-xs border-t border-line-soft pt-sm" testID={testID}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-xs">
          <Text className="font-mono text-sm font-semibold text-ink">{row.code}</Text>
          {row.excluded ? (
            <View className="rounded-full bg-surface-sunken px-sm py-0.5">
              <Text className="text-[10px] text-ink-muted" testID={`${testID}-excluded`}>
                {COPY.list.excluded}
              </Text>
            </View>
          ) : null}
        </View>
        {row.iv.ivpText === null ? (
          <Text className="text-xs font-semibold text-ink" testID={`${testID}-degraded`}>
            {row.iv.degradedText}
          </Text>
        ) : (
          <View className="flex-row items-baseline gap-xs">
            <Text className="font-mono text-lg font-bold text-ink" testID={`${testID}-ivp`}>
              {row.iv.ivpText}
            </Text>
            <Text className="text-[10px] text-ink-muted">{IV_COPY.ivpUnit}</Text>
          </View>
        )}
      </View>

      <IvpSegmentBar ivPercentile={row.iv.ivPercentile} testID={`${testID}-bar`} />

      <View className="flex-row items-center justify-between">
        <Text className="font-mono text-[10px] text-ink" testID={`${testID}-aggregate`}>
          {row.iv.aggregateIvText}
        </Text>
        {/* FR-036：分位不可算 ⇒ 徽标**不出现**（无 IVP 即无档位）。 */}
        {row.iv.alert === null ? null : (
          <Text
            className={`text-[10px] font-semibold ${ALERT_TONE[row.iv.alert]}`}
            testID={`${testID}-alert-${row.iv.alert}`}
          >
            {alertStatusText(row.iv.alert)}
          </Text>
        )}
        <Text
          className="text-[10px] text-ink-muted"
          testID={`${testID}-asof-${row.iv.freshness.tier}`}
        >
          {row.iv.freshness.text}
        </Text>
      </View>

      {row.excludeReasonText === null ? null : (
        <Text className="text-[10px] text-ink-muted" testID={`${testID}-exclude-reason`}>
          {row.excludeReasonText}
        </Text>
      )}
    </View>
  );
}
