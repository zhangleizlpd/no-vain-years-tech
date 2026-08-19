// 064 T008 — 区块级档位条（FR-009/FR-010/FR-011, plan §D10, mockup 帧 ①②③④⑤）。
//
// 🚨 **判定全在 `leg-tier-bar.rules.ts`**（vitest 覆盖），本文件只做接线与版面 ——
//    同 `LegRow` / `MarketBadge` 的分工范式。
//
// 🚨 **它与区块头那一行各答一个问题，MUST NOT 合并**：区块头（`LegBlockHeader`）答「库内快照
//    属于哪个业务日、新不新鲜」，本条答「这一批报价是实时还是收盘、时点几时、为什么不是实时」。
//    064 起两者在实时档下**不再同值**（前者仍是交易日，后者是此刻的时刻），折叠成一条必丢其一。
//
// 🚫 **表格骨架一行不改**（053 + 056 定稿）：本条是叠加在 Tab 行与 12 列表头之间的新元素，
//    视角 Tab / 冻结列 / 11 列横滑 / 条件抽屉一个字都不动。
import { Text, View } from 'react-native';

import { legQuoteTier, type LegBlockPriceKind, type LegQuoteTierInput } from './leg-tier-bar.rules';

export interface LegTierBarProps extends LegQuoteTierInput {
  /** 区块级档位；契约未到手 ⇒ `null`（落显式「未就绪」，**不默认成收盘档**）。 */
  priceKind: LegBlockPriceKind | null;
}

/** 档位条。复杂度 O(1)。 */
export function LegTierBar({ priceKind, quoteAsOf, eodRowCount }: LegTierBarProps) {
  const view = legQuoteTier({ priceKind, quoteAsOf, eodRowCount });
  return (
    <View
      className={`flex-row items-center gap-xs border-b border-line px-md py-xs ${view.container}`}
      testID="optionsdesk-detail-leg-tier"
    >
      {/* 圆点只是档位色的一个视觉锚 —— 语义由紧邻的档位名承载（🚫 不做成纯几何符号，
          那连「这是什么」都要查图例，同 051 FR-014b 对两个 badge 的裁定）。 */}
      <View className={`h-1.5 w-1.5 rounded-full ${view.dotClass}`} />
      <Text
        className={`text-[11px] font-semibold ${view.nameClass}`}
        testID="optionsdesk-detail-leg-tier-name"
      >
        {view.name}
      </Text>
      {/* 未就绪不渲染时点 —— 「这一步没算出来」不该长得像「算出来是旧的」。 */}
      {view.stamp === null ? null : (
        <Text
          className={`font-mono text-[11px] ${view.stampClass}`}
          testID="optionsdesk-detail-leg-tier-stamp"
        >
          {view.stamp}
        </Text>
      )}
      {view.reason === '' ? null : (
        <Text
          className="flex-1 text-[10px] text-ink"
          numberOfLines={2}
          testID="optionsdesk-detail-leg-tier-why"
        >
          {view.reason}
        </Text>
      )}
    </View>
  );
}
