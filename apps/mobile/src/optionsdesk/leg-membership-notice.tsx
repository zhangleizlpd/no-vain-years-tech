// 064 T010 — 成员变化提示（FR-021 / SC-009, plan §D9, mockup 帧 ⑧）。
//
// 🚨 **判据没变，是数变了** —— 但用户可能正盯着某一行准备下单，所以那一行的消失必须是他
//    **看得见且解释得通**的事件，而不是一次无声的重排。
//
// 🚨 **中性条而非品牌色**（Guardrail 9）：品牌蓝归**档位**（一种状态），这条是一次**瞬时告知**。
//    🚫 更不许用 `--nvy-info` —— 本 DS 里它就是 `--nvy-primary`，用了会和实时档撞脸。
//
// 🚫 **差集不在这里算**：进出条数由 `use-leg-table` 持有的上一轮合约码集合算出（服务端无状态、
//    不持有「这个客户端上一轮看到了哪些腿」），本组件只呈现。
import { Pressable, Text, View } from 'react-native';

import type { LegMembershipChange } from './leg-query.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;

export interface LegMembershipNoticeProps {
  /** 本轮的进出；🚨 调用方在 `null` 时**整条不渲染**（无变化的提示只是噪点）。 */
  change: LegMembershipChange;
  onDismiss: () => void;
}

/** 成员变化条。复杂度 O(1)。 */
export function LegMembershipNotice({ change, onDismiss }: LegMembershipNoticeProps) {
  return (
    <View
      className="flex-row items-center gap-sm border-b border-line bg-surface-sunken px-md py-xs"
      testID="optionsdesk-detail-leg-membership"
    >
      <Text className="text-[10px] text-ink-muted">{COPY.membershipLead}</Text>
      {/* 🚨 为零的那一半**不渲染** ——「0 条已不满足」是句废话，还会把真有变化的那半挤淡。 */}
      {change.entered > 0 ? (
        <Text className="text-[10px] text-ink" testID="optionsdesk-detail-leg-membership-entered">
          {COPY.membershipEntered(change.entered)}
        </Text>
      ) : null}
      {change.left > 0 ? (
        <Text className="text-[10px] text-ink" testID="optionsdesk-detail-leg-membership-left">
          {COPY.membershipLeft(change.left)}
        </Text>
      ) : null}
      {/* ⚠️ 关闭键用 `text-ink-muted` 而非最淡档 —— mockup 探针实测 `--nvy-text-subtle` 在这里
          只有 2.59 对比度，而它还是个可点 affordance（同 046 Guardrail 8）。 */}
      <Pressable
        className="ml-auto px-1"
        accessibilityRole="button"
        accessibilityLabel={COPY.membershipDismiss}
        onPress={onDismiss}
        testID="optionsdesk-detail-leg-membership-dismiss"
      >
        <Text className="text-[11px] text-ink-muted">×</Text>
      </Pressable>
    </View>
  );
}
