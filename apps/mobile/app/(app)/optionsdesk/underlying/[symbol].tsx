import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  OPTIONSDESK_THERMOMETER_ROUTE,
  UnderlyingDetailScreen,
  chainReportPrefillOf,
} from '~/optionsdesk';

// 标的详情（上半）。薄 route —— 屏体在 ~/optionsdesk。整栈 markets 门控在 optionsdesk/_layout。
//
// 🚨 `onPanorama` 是**必填 prop**：T021 刻意不在屏内自造路由串（温度计路由常量归 T023），
//    全景入口的目标由**路由层**注入 —— 这里是它唯一的注入点。
//
// 🚨 055 T016：报表下钻的预填**从 query 参数进来**（`FR-038` / `FR-039`）。解析放在 route 层，
//    屏拿到的是一个已判过的 `prefill`（不是下钻 ⇒ `null`）—— 屏因此不关心参数长什么样，
//    而「视角认不出来就整个作废」这条判据只有一处（`chainReportPrefillOf`）。
export default function OptionsdeskUnderlyingDetailScreen() {
  const params = useLocalSearchParams<{ symbol: string } & Record<string, string | string[]>>();
  const router = useRouter();
  return (
    <UnderlyingDetailScreen
      symbol={params.symbol ?? ''}
      prefill={chainReportPrefillOf(params)}
      onPanorama={() => router.push(OPTIONSDESK_THERMOMETER_ROUTE)}
    />
  );
}
