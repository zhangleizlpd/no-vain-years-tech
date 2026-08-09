import { Redirect, useLocalSearchParams } from 'expo-router';

import { AlertListScreen } from '~/alert';
import { canDrillDown, parseSymbol } from '~/portfolio';

// 个股预警列表动态路由（021 屏 1）。param `symbol` = canonical `cn:603305` → 解析
// market/code（复用 014 parseSymbol）。入口（014 详情铃铛 / 屏 5 下钻）只产合法 cn
// symbol —— 手敲非法 URL / 非 cn 市场 → 回投资 tab（V1 预警仅 A股，无专属占位文案）。
// 屏体在 ~/alert（per fe-directory-structure：app/ 仅薄 route）。
export default function AlertListRoute() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const parsed = typeof symbol === 'string' ? parseSymbol(symbol) : null;

  if (!parsed || !canDrillDown(parsed.market)) {
    return <Redirect href="/(app)/(tabs)/portfolio" />;
  }

  return <AlertListScreen market={parsed.market} code={parsed.code} />;
}
