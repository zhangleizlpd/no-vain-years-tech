import { useLocalSearchParams, useRouter } from 'expo-router';

import { OPTIONSDESK_THERMOMETER_ROUTE, UnderlyingDetailScreen } from '~/optionsdesk';

// 标的详情（上半）。薄 route —— 屏体在 ~/optionsdesk。整栈 markets 门控在 optionsdesk/_layout。
//
// 🚨 `onPanorama` 是**必填 prop**：T021 刻意不在屏内自造路由串（温度计路由常量归 T023），
//    全景入口的目标由**路由层**注入 —— 这里是它唯一的注入点。
export default function OptionsdeskUnderlyingDetailScreen() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const router = useRouter();
  return (
    <UnderlyingDetailScreen
      symbol={symbol ?? ''}
      onPanorama={() => router.push(OPTIONSDESK_THERMOMETER_ROUTE)}
    />
  );
}
