// 055 T010 — 标的链分析报表屏（骨架 + 页头）。mockup `055-chain-report-states.dc.html` 帧 ①。
//
// 🚨 **零纵向滚动**（`FR-041`）—— 整屏是一个 `flex` 列容器，**没有 `ScrollView`**。越线时的
//    压缩顺序是**先曲线、再页头**，🚫 网格 MUST NOT 纵向滚（一滚，报表就退化成了另一张
//    逐条阅读的表，而那正是本片要替代的东西）。⚠️ 余量判定 MUST 用**真机**读数（T021）——
//    049 实测 web 185 vs 真机 161dp，用 web 那组会误判一屏余量。
// 🚨 **合规门控自动继承**（`SC-009` / plan `D-UI-1`）—— 本屏落 `app/(app)/optionsdesk/` 二级页
//    栈，`_layout.tsx` 的 `MarketsRouteGuard` 一层管到底，🚫 MUST NOT 在屏内另写一份判定。
// 🚨 **页头的 IV 分位整份复用 046**（`FR-031`）：读数走 `chainReportHeaderView` → `ivReadoutView`，
//    分段条直接用 `IvpSegmentBar`（复用频次 ≥ 2 的既有件），🚫 不新造读数、不新画一条。
//
// 📌 **本 task 只落容器 + 页头**：格值四选一与页脚三计数归 T012、网格与横滑归 T011、
//    IV 期限结构曲线归 T013、五种降级态归 T017。下面的空位是给它们留的，不是漏了。
// 判定全在 `chain-report-copy.ts` / `chain-report-scale.rules.ts`（vitest 覆盖）；
// 渲染 / 交互 / a11y 走 T018 Playwright e2e（本仓测试分层：vitest=logic / Playwright=UI）。
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';

import { ErrorRow, SafeAreaView, Spinner, makeHeaderBackOrParent } from '~/ui';
import { chainReportHeaderView, chainReportTitle } from './chain-report-copy';
import { IvpSegmentBar } from './ivp-segment-bar';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskUnderlyingRoute } from './optionsdesk-routes';
import { useChainReport } from './use-chain-report';

const COPY = OPTIONSDESK_COPY.chainReport;

export interface ChainReportScreenProps {
  /** canonical `market:code`（= 锚 ticker，标的身份）。 */
  symbol: string;
}

export function ChainReportScreen({ symbol }: ChainReportScreenProps) {
  const { report, isPending, isError, refetch } = useChainReport(symbol);
  const header = useMemo(() => (report === null ? null : chainReportHeaderView(report)), [report]);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      {/* web 硬刷新时栈底为空 ⇒ 回落到**该标的详情**（报表入口就在那儿，FR-035）。 */}
      <Stack.Screen
        options={{
          title: chainReportTitle(symbol),
          headerLeft: makeHeaderBackOrParent(optionsdeskUnderlyingRoute(symbol)),
        }}
      />

      <View className="flex-1 bg-surface-sunken">
        {header === null ? null : (
          <View className="gap-1 bg-surface px-md py-sm" testID="chain-report-header">
            <View className="flex-row items-baseline gap-1.5">
              <Text className="text-xs text-ink-muted">{COPY.ivpLabel}</Text>
              {header.iv.ivpText === null ? (
                <Text className="text-sm text-ink">{header.iv.degradedText}</Text>
              ) : (
                <>
                  <Text className="text-xl text-ink">{header.iv.ivpText}</Text>
                  <Text className="text-xs text-ink-muted">{COPY.ivpUnit}</Text>
                </>
              )}
              <View className="flex-1" />
              <Text className="text-sm text-ink">{header.spotText ?? COPY.noValue}</Text>
            </View>

            {/* 🚨 无分位时段带照常画、只是没有标记 —— 绝不落在 0 处（`state_branch` 18）。 */}
            <IvpSegmentBar ivPercentile={header.iv.ivPercentile} testID="chain-report-ivp-bar" />

            {/* 🚨 FR-033：三个时点**各自成句**，🚫 不合并成一个「数据截至」。 */}
            <View className="flex-row gap-md" testID="chain-report-stamps">
              {header.stamps.map((s) => (
                <View
                  key={s.key}
                  className="flex-row gap-0.5"
                  testID={`chain-report-stamp-${s.key}`}
                >
                  <Text className="text-[10px] text-ink-subtle">{s.label}</Text>
                  <Text className="text-[10px] text-ink-muted">{s.value}</Text>
                </View>
              ))}
            </View>

            {header.excludedNotice === null ? null : (
              <Text className="text-[10px] text-warn" testID="chain-report-excluded">
                {header.excludedNotice}
              </Text>
            )}
          </View>
        )}

        {isPending ? (
          <View className="items-center py-lg" testID="chain-report-loading">
            <Spinner size={16} tone="muted" />
          </View>
        ) : null}

        {isError ? (
          <View className="gap-sm px-md py-sm" testID="chain-report-error">
            <ErrorRow text={COPY.loadFailed} />
            <Pressable
              onPress={refetch}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID="chain-report-retry"
              className="self-center rounded-full border border-line px-md py-0.5"
            >
              <Text className="text-xs text-brand-500">{COPY.retry}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
