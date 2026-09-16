import { useLocalSearchParams } from 'expo-router';

import { TradingAccountOrderScreen } from '~/optionsdesk';

// 083 T018 订单详情。薄 route —— 屏体在 ~/optionsdesk。整栈 markets 门控在 optionsdesk/_layout。
export default function OptionsdeskTradingAccountOrderScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  return <TradingAccountOrderScreen id={params.id ?? ''} />;
}
