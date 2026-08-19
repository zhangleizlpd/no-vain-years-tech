// 064 T008 — 区块级档位条（FR-009/FR-010/FR-011, plan §D10, mockup 帧 ①②③④⑤）。
//
// 🚨 **判定全在 `leg-tier-bar.rules.ts`**（vitest 覆盖），本文件只做接线与版面 ——
//    同 `LegRow` / `MarketBadge` 的分工范式。
//
// 🚨 **它与区块头那一行各答一个问题，MUST NOT 合并**：区块头（`LegBlockHeader`）答「库内快照
//    属于哪个业务日、新不新鲜」，本条答「这一批报价是实时还是收盘、时点几时、为什么不是实时」。
//    064 起两者在实时档下**不再同值**（前者仍是交易日，后者是此刻的时刻），折叠成一条必丢其一。
//    📌 **例外只有一格**（2026-08-19 收尾）：收盘档 + 当期时两个问题的答案**同值同义**，
//    区块头那一行不渲染、由本条独说（判定在 `LegBlockHeader` 的 `duplicatesTierBar`）。
//    这不是合并 —— 陈旧 / 无时点 / 实时三态区块头照渲，它们各自带着本条给不出的信息。
//
// 🚫 **表格骨架一行不改**（053 + 056 定稿）：本条是叠加在 Tab 行与 12 列表头之间的新元素，
//    视角 Tab / 冻结列 / 11 列横滑 / 条件抽屉一个字都不动。
import { Pressable, Text, View } from 'react-native';

import { Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { legQuoteTier, type LegBlockPriceKind, type LegQuoteTierInput } from './leg-tier-bar.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

export interface LegTierBarProps extends LegQuoteTierInput {
  /** 区块级档位；契约未到手 ⇒ `null`（落显式「未就绪」，**不默认成收盘档**）。 */
  priceKind: LegBlockPriceKind | null;
  /**
   * 手动刷新（064 T009）。🚫 **无自动轮询**（spec Assumption）⇒ 推进时点全靠人。
   * 📌 与下拉刷新是**同一个操作的两个入口**：RN Web 的 `RefreshControl` 没有下拉行为，
   *    只留手势的话 web 侧根本够不到这条路径。
   */
  onRefresh: () => void;
}

/** 档位条。复杂度 O(1)。 */
export function LegTierBar({
  priceKind,
  quoteAsOf,
  eodRowCount,
  realtimeDegrade,
  phase,
  onRefresh,
}: LegTierBarProps) {
  const view = legQuoteTier({ priceKind, quoteAsOf, eodRowCount, realtimeDegrade, phase });
  const busy = view.variant === 'busy';
  return (
    <View
      className={`flex-row items-center gap-xs border-b border-line px-md py-xs ${view.container}`}
      testID="optionsdesk-detail-leg-tier"
    >
      {/* 圆点只是档位色的一个视觉锚 —— 语义由紧邻的档位名承载（🚫 不做成纯几何符号，
          那连「这是什么」都要查图例，同 051 FR-014b 对两个 badge 的裁定）。 */}
      {/* 在途时圆点让位给转圈 —— 「正在取」是过程，静态点表达不了它。 */}
      {busy ? (
        <Spinner size={10} tone="muted" />
      ) : (
        <View className={`h-1.5 w-1.5 rounded-full ${view.dotClass}`} />
      )}
      <Text
        className={`text-[11px] font-semibold ${view.nameClass}`}
        testID="optionsdesk-detail-leg-tier-name"
      >
        {view.name}
      </Text>
      {/* 🚨 限定语在时点**前面**：跟在后面会被读成「这批取于 X 之后」。 */}
      {view.note === null ? null : (
        <Text className="text-[10px] text-ink-muted" testID="optionsdesk-detail-leg-tier-note">
          {view.note}
        </Text>
      )}
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
      {/* 🚨 在途时禁用 —— 一次未完成时不接受下一次，刷新天然串行（spec「不另设刷新节流」）。 */}
      <Pressable
        className="ml-auto rounded-sm border border-line px-1.5"
        accessibilityRole="button"
        accessibilityLabel={COPY.refreshCta}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onRefresh}
        testID="optionsdesk-detail-leg-tier-refresh"
      >
        <Text className={`text-[10px] ${busy ? 'text-ink-muted' : 'text-brand-500'}`}>
          {COPY.refreshCta}
        </Text>
      </Pressable>
    </View>
  );
}
