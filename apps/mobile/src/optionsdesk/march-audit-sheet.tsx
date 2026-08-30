// 069 T009 — 每 K 审计弹层（FR-014/FR-016, mockup 帧③④⑤ baseline; plan D5）。
//
// 🚨 **MUST 走 RN `Modal` 渲到 root 层**（同 `leg-criteria-sheet.tsx` 那条：屏内 absolute
//    overlay 够不到同级 Tab 栏）。sheet 高度由内容撑开，🚫 无确定高度容器里禁裸 `flex-1`。
//
// 🚨 **本文件零判定**：内容组装全在 `march-audit.rules.ts`（vitest 覆盖），文案全在
//    `optionsdesk-copy.ts` march 段 —— 这里只做接线与版面。
//
// 🚨 **两类空态是诚实空态不是错误**（FR-016）：中性灰、无错误红、无重试按钮 —— 「没有值得锁
//    的期限」是判决结果，不是一次失败的请求。
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { LegMarchStrikeResponse } from '@nvy/api-client';

import {
  marchAuditSheetView,
  type MarchAuditBlockContext,
  type MarchFamilyKind,
} from './march-audit.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.march;

/**
 * 家族 → 左缘色条 class（表达层分组，见 `MARCH_FAMILY_OF_CATEGORY` 头注）。
 * 🚨 全家族蓄意避开 ok 绿与 err 红（FR-016 语气纪律）：清链 = 中性强（报价几何）、行军 = brand
 * （判据主线）、可成交 = accent（该看看的流动性信号）、边界 = 中性弱（参照语义）。
 */
const FAMILY_BAR_CLASS: Readonly<Record<MarchFamilyKind, string>> = {
  chain_clean: 'border-l-line-strong',
  march: 'border-l-brand-400',
  tradability: 'border-l-accent',
  boundary: 'border-l-line',
};

export interface MarchAuditSheetProps {
  /** 被点开的那个 K 的行军块；调用方保证非 null 才渲本组件。 */
  strikeView: LegMarchStrikeResponse;
  /**
   * 070：链级口径与行军模式（题头口径行 / 模式标示的唯一来源）。
   * 🚨 **必填** —— 缺省会让离线弹层静默丢掉口径行（FR-003），故让漏接线在编译期就红。
   */
  block: MarchAuditBlockContext;
  onClose: () => void;
}

/** 每 K 审计弹层。复杂度 O(档数)。 */
export function MarchAuditSheet({ strikeView, block, onClose }: MarchAuditSheetProps) {
  const view = marchAuditSheetView(strikeView, block);
  if (view === null) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable
          className="flex-1"
          accessibilityLabel={COPY.closeA11y}
          onPress={onClose}
          testID="optionsdesk-march-audit-backdrop"
        />
        <View
          className="max-h-[85%] gap-sm rounded-t-lg bg-surface px-md pb-md pt-sm shadow-sheet"
          testID="optionsdesk-march-audit-sheet"
        >
          {/* ── 题头：K + 判决 chip（+ 推荐档读数）──────────────────────── */}
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-ink">{view.title}</Text>
            <Text
              className={`rounded-sm border px-1 text-[10px] ${
                view.verdict === 'recommended'
                  ? 'border-brand-400 bg-brand-soft font-semibold text-brand-600'
                  : 'border-line-strong text-ink-muted'
              }`}
              testID="optionsdesk-march-audit-verdict"
            >
              {view.verdictLabel}
            </Text>
            {view.recommendedLabel !== null ? (
              <Text
                className="font-mono text-xs font-semibold text-brand-600"
                testID="optionsdesk-march-audit-recommended"
              >
                {view.recommendedLabel}
              </Text>
            ) : null}
          </View>

          {/* ── 070 口径行：这一梯的判决建立在哪一天的收盘上（FR-003）────────
              🚨 收盘档才渲：13 类逐条目因此**不加**昨收尾缀，口径在题头一次说清（FR-004）。 */}
          {view.basisLine !== null ? (
            <Text className="text-[11px] text-ink-muted" testID="optionsdesk-march-audit-basis">
              {view.basisLine}
            </Text>
          ) : null}

          {/* ── 净链小结 + φ 只读读数（数值全来自契约，零本地计算）──────── */}
          <Text
            className="font-mono text-[10px] text-ink-muted"
            testID="optionsdesk-march-audit-summary"
          >
            {view.summaryLine}
          </Text>
          {view.phiLine !== null ? (
            <Text
              className="font-mono text-[10px] text-ink-muted"
              testID="optionsdesk-march-audit-phi"
            >
              {view.phiLine}
            </Text>
          ) : null}
          {/* ── 070 θ 模式被动标示（FR-009）：默认 φ 态恒不渲 ⇒ 零噪音；
              入口只在 server 配置，🚫 这里 MUST NOT 出现任何切换控件。 */}
          {view.modeLine !== null ? (
            <Text
              className="font-mono text-[10px] text-ink-muted"
              testID="optionsdesk-march-audit-mode"
            >
              {view.modeLine}
            </Text>
          ) : null}

          {/* ── 两类诚实空态（中性灰，非错误组件）───────────────────────── */}
          {view.emptyText !== null ? (
            <Text className="text-xs text-ink-muted" testID="optionsdesk-march-audit-empty">
              {view.emptyText}
            </Text>
          ) : null}

          {/* ── 家族色条逐档行（FR-014：每档恰一条原因 + 数值证据）────────── */}
          <ScrollView className="max-h-96">
            <View className="gap-1">
              {view.rows.map((row) => (
                <View
                  key={row.key}
                  className={`flex-row items-center gap-2 border-l-2 py-0.5 pl-2 ${FAMILY_BAR_CLASS[row.family]}`}
                  testID={`optionsdesk-march-audit-row-${row.key}`}
                >
                  <Text className="w-16 font-mono text-[10px] text-ink-muted" numberOfLines={1}>
                    {row.dteLabel}
                  </Text>
                  <Text className="flex-1 text-[11px] text-ink" numberOfLines={2}>
                    {row.text}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
