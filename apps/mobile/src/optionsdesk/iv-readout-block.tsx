// 046 T021 — 个股温度计区块（FR-012 / FR-013 / FR-014 / FR-020 / FR-035 / FR-036）。
//
// 🚨 **FR-035 口径**：标题一律「富途标的聚合 IV」，**禁写 IV30d**（文案在 `optionsdesk-copy.ts`，
//    机械防线在 `underlying-detail.rules.spec.ts`）。
// 🚨 **FR-013**：IVP **先于** 聚合 IV 呈现；vendor 的 IVR（`iv_rank`）只落库不上屏 ——
//    server 的 `select` 根本不取那一列，这里也没有任何 rank 字段可渲染。
// 🚨 **FR-014**：四态**都渲染这一块**。「分位不可算」/「暂无数据」/「读数暂不可用」三句
//    **各自成句不合并**，且**禁回落 0**。
// 🚨 **Guardrail 8**：上面三句降级字用 `text-ink`，**不用最淡档** `text-ink-subtle`
//    （白底实测 2.85:1 不达 WCAG AA）—— FR-014 要的是**显式**呈现不可用。
// 🚨 **Guardrail 9**：分段条外层禁 `overflow:hidden`，见 `ivp-segment-bar.tsx`。
import { Pressable, Text, View } from 'react-native';
import type { UnderlyingIvReadoutResponse } from '@nvy/api-client';

import { IvpSegmentBar } from './ivp-segment-bar';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { alertStatusText, ivReadoutView, type AlertStatus } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.underlyingDetail.ivBlock;

/** 提醒状态徽标底色 —— 三档递进（`Record` 穷举，漏一档即编译红）。 */
const ALERT_TONE: Record<AlertStatus, { box: string; text: string }> = {
  not_crossed: { box: 'bg-surface-sunken', text: 'text-ink-muted' },
  crossed_high: { box: 'bg-warn-soft', text: 'text-ink' },
  crossed_extreme: { box: 'bg-err-soft', text: 'text-err' },
};

export interface IvReadoutBlockProps {
  iv: UnderlyingIvReadoutResponse;
  /** 通往 P7 波动温度计整页（FR-012 全景入口；T023 接真路由）。 */
  onPanorama: () => void;
  testID?: string;
}

export function IvReadoutBlock({
  iv,
  onPanorama,
  testID = 'optionsdesk-detail-iv',
}: IvReadoutBlockProps) {
  const view = ivReadoutView(iv);

  return (
    <View
      className="gap-sm rounded-md border border-line bg-surface px-md py-sm"
      testID={`${testID}-${view.state}`}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-ink">{COPY.title}</Text>
        <Pressable
          onPress={onPanorama}
          accessibilityRole="button"
          accessibilityLabel={COPY.panorama}
          testID={`${testID}-panorama`}
        >
          <Text className="text-xs text-brand-500">{COPY.panorama}</Text>
        </Pressable>
      </View>

      {/* IVP 在前（FR-013）：有值 → 大数字 + 徽标；无值 → 显式降级句（禁 0、禁隐藏本块）。 */}
      <View className="flex-row items-end justify-between">
        {view.ivpText === null ? (
          <Text className="text-base font-semibold text-ink" testID={`${testID}-degraded`}>
            {view.degradedText}
          </Text>
        ) : (
          <View className="flex-row items-baseline gap-xs">
            <Text className="font-mono text-3xl font-bold text-ink" testID={`${testID}-ivp`}>
              {view.ivpText}
            </Text>
            <Text className="text-xs text-ink-muted">{COPY.ivpUnit}</Text>
          </View>
        )}
        {/* FR-036：分位不可算 ⇒ 徽标**不出现**（无 IVP 即无档位）。 */}
        {view.alert === null ? null : (
          <View className={`rounded-full px-sm py-0.5 ${ALERT_TONE[view.alert].box}`}>
            <Text
              className={`text-xs font-semibold ${ALERT_TONE[view.alert].text}`}
              testID={`${testID}-alert-${view.alert}`}
            >
              {alertStatusText(view.alert)}
            </Text>
          </View>
        )}
      </View>

      <IvpSegmentBar ivPercentile={view.ivPercentile} testID={`${testID}-bar`} />

      {/* 聚合 IV 在 IVP 之后（FR-013 呈现顺序）+ 该读数**自己的** asOf（FR-020）。 */}
      <View className="flex-row items-center justify-between">
        <Text className="font-mono text-xs text-ink" testID={`${testID}-aggregate`}>
          {view.aggregateIvText}
        </Text>
        <Text
          className={`text-xs ${view.freshness.tier === 'CURRENT' ? 'text-ink-subtle' : 'text-ink-muted'}`}
          testID={`${testID}-asof-${view.freshness.tier}`}
        >
          {view.freshness.text}
        </Text>
      </View>
    </View>
  );
}
