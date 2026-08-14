import { useLocalSearchParams } from 'expo-router';

import { ChainReportScreen } from '~/optionsdesk';

// 055 标的链分析报表。薄 route —— 屏体在 ~/optionsdesk。整栈 markets 门控在 optionsdesk/_layout
// （SC-009：开关关闭时本深链随整栈被拦，🚫 屏内不另写判定）。
export default function OptionsdeskChainReportScreen() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  return <ChainReportScreen symbol={symbol ?? ''} />;
}
