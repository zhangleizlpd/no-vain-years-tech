// 055 T012 — 四种格值的四选一（`FR-010`, `SC-002`, plan `D-API-2`）。
//
// 🚨 **切换只换「读哪一张网格」，🚫 不发请求**（`D-API-2`）—— 四张网格一次返齐。拆请求会让
//    切换先空后填，且四发的 `spot` / `asOf` 可能落在不同批报价上，**骨架会跳**，
//    而骨架恒定正是本片唯一不能出错的东西（`SC-002`）。
// 🚨 **选中态双重编码**（底色 + 底部短横条）承 049 `leg-picker-tabs.tsx` 的取舍：
//    `react-native-web` 不认 `accessibilityState`，e2e 只能靠样式自比较断选中态，
//    两条独立通道让那条断言删一半就会红。
// 📌 **不上提 `~/ui`**：仓内已有两家「等分固定 Tab」（`leg-picker-tabs` / `portfolio/detail-tabs`）
//    与 `~/ui/Tabs` 的横滑 pill Tab 不是一回事；本片是第三家，统一它们是独立重构，登记为债。
import { Pressable, Text, View } from 'react-native';

import { CHAIN_REPORT_BAND_SCALES, type ChainReportMetric } from './chain-report-scale.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

/** 四种格值的呈现顺序（mockup 帧 ①：建仓 → 收租 → 全腿 → 活跃度）。 */
export const CHAIN_REPORT_METRICS = Object.keys(CHAIN_REPORT_BAND_SCALES) as ChainReportMetric[];

export interface ChainReportMetricTabsProps {
  metric: ChainReportMetric;
  onSelect: (metric: ChainReportMetric) => void;
}

export function ChainReportMetricTabs({ metric, onSelect }: ChainReportMetricTabsProps) {
  return (
    <View className="flex-row border-b border-line-soft bg-surface" testID="chain-report-metrics">
      {CHAIN_REPORT_METRICS.map((item) => {
        const on = item === metric;
        return (
          <Pressable
            key={item}
            onPress={() => onSelect(item)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={COPY.metricTabs[item]}
            testID={`chain-report-metric-${item}`}
            className={`flex-1 items-center py-1 ${on ? 'bg-surface-sunken' : ''}`}
          >
            <Text className={on ? 'text-xs font-semibold text-ink' : 'text-xs text-ink-muted'}>
              {COPY.metricTabs[item]}
            </Text>
            <View className={`mt-0.5 h-0.5 w-7 ${on ? 'bg-brand-500' : ''}`} />
          </Pressable>
        );
      })}
    </View>
  );
}
