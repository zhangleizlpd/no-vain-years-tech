import { useLocalSearchParams } from 'expo-router';

import { TradingAccountPositionScreen } from '~/optionsdesk';

// 083 T017 持仓详情。薄 route —— 屏体在 ~/optionsdesk。整栈 markets 门控在 optionsdesk/_layout。
export default function OptionsdeskTradingAccountPositionScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  return <TradingAccountPositionScreen id={params.id ?? ''} />;
}
