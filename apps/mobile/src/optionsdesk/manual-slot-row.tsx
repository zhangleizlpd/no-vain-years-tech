// 045 T022 — 三处人工位（V / L 层 / 单票上限）的统一呈现单元（mockup 帧 ⑦⑧）。
//
// FR-032 四条在这一个组件里全部落地：
//  ① **显式动作** —— 人工值只能由用户点「人工调整」再确认写入，系统不代为设置；
//  ② **同屏标明临时语义 + 派生值** —— 「人工调整 · 将回落」+「下次上游刷新将回落为 <派生值>」；
//  ③ **一键撤销** —— 「撤销」直接 PATCH `null`，立即回落到派生值，不必等上游刷新；
//  ④ 变更痕迹由 server 侧同 tx 落库（T008），前端无需额外动作。
//
// 🚨 Guardrail 10：人工值**恰好等于**派生值时**仍标记为人工态** —— server 的判据是「人工列非
//    null」而非值比较，前端照此显示。别自作聪明按值相等隐藏标记，否则痕迹里「这个值是谁设的」丢失。
//
// 为什么不做成 RHF 字段而是即时 PATCH：改 L 层会沿两级链冲掉单票上限的人工值（FR-035 ②③），
// 回落结果由 server 求值，要求「同屏立即可见」—— 写回后读 server 的真值，比在本地表单态里猜可靠。
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '~/theme';
import { Spinner } from '~/ui';
import { manualSlotHint } from './anchor-form.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.anchorForm;

/** L 层档位（生效 L 层的值域，与 server enum 一致）。 */
export const L_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;

export interface ManualSlotRowProps {
  /** testID / payload 键的判别式。 */
  slot: 'v' | 'lLevel' | 'positionCap';
  label: string;
  /** 生效值的展示串（人工态时 = 人工值）。 */
  effectiveText: string;
  /** 人工态判据 = server 的「人工列非 null」，**不是**值比较（Guardrail 10）。 */
  isManual: boolean;
  /** 回落目标的展示串，如「模型值 166.00」/「映射档 L2」/「按生效 L 层派生的 25%」。 */
  derivedLabel: string;
  /** 未处于人工态时的跟随说明，如「跟随 confidence 派生」。 */
  followsLabel: string;
  /** 编辑器形态：数值输入 / L 档四选一。 */
  editor: 'numeric' | 'lLevel';
  busy?: boolean;
  /** `null` = 撤销（PATCH 人工列为 null）。 */
  onApply: (value: string | null) => void;
}

export function ManualSlotRow({
  slot,
  label,
  effectiveText,
  isManual,
  derivedLabel,
  followsLabel,
  editor,
  busy,
  onApply,
}: ManualSlotRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const apply = (value: string | null) => {
    setEditing(false);
    setDraft('');
    onApply(value);
  };

  return (
    <View
      className={`py-sm gap-xs ${isManual ? 'bg-brand-soft rounded-sm px-sm' : ''}`}
      testID={`optionsdesk-manual-${slot}`}
    >
      <View className="flex-row items-center justify-between gap-sm">
        <Text className="text-sm text-ink-muted">{label}</Text>
        <View className="flex-row items-center gap-sm">
          <Text className="text-base font-mono text-ink">{effectiveText}</Text>
          {busy ? <Spinner size={13} tone="muted" /> : null}
        </View>
      </View>

      {isManual ? (
        <>
          {/* FR-032 ② —— 临时语义标记 + 同屏派生值。文案含「将回落」是硬要求。 */}
          <View className="flex-row items-center justify-between gap-sm">
            <Text className="text-xs text-brand-500" testID={`optionsdesk-manual-badge-${slot}`}>
              {COPY.manualBadge}
            </Text>
            <Pressable
              onPress={() => apply(null)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${COPY.manualUndo}`}
              testID={`optionsdesk-manual-undo-${slot}`}
            >
              <Text className="text-xs text-brand-500 px-sm">{COPY.manualUndo}</Text>
            </Pressable>
          </View>
          <Text className="text-xs text-ink-muted" testID={`optionsdesk-manual-hint-${slot}`}>
            {manualSlotHint(derivedLabel)}
          </Text>
        </>
      ) : (
        <View className="flex-row items-center justify-between gap-sm">
          <Text className="text-xs text-ink-subtle">{followsLabel}</Text>
          {editing ? null : (
            <Pressable
              onPress={() => setEditing(true)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${COPY.manualSet}`}
              testID={`optionsdesk-manual-set-${slot}`}
            >
              <Text className="text-xs text-brand-500 px-sm">{COPY.manualSet}</Text>
            </Pressable>
          )}
        </View>
      )}

      {editing ? (
        <View className="gap-xs" testID={`optionsdesk-manual-editor-${slot}`}>
          {editor === 'lLevel' ? (
            <View className="flex-row gap-sm">
              {L_LEVELS.map((lv) => (
                <Pressable
                  key={lv}
                  onPress={() => apply(lv)}
                  accessibilityRole="button"
                  accessibilityLabel={lv}
                  testID={`optionsdesk-manual-option-${slot}-${lv}`}
                  className="border border-line rounded-full px-md py-xs"
                >
                  <Text className="text-sm text-ink">{lv}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View className="flex-row items-center gap-sm">
              <TextInput
                value={draft}
                onChangeText={setDraft}
                keyboardType="decimal-pad"
                placeholder={COPY.manualPlaceholder}
                placeholderTextColor={colors.ink.subtle}
                accessibilityLabel={`${label} ${COPY.manualSet}`}
                testID={`optionsdesk-manual-input-${slot}`}
                className="flex-1 bg-surface-sunken rounded-md px-md h-10 text-base text-ink"
              />
              <Pressable
                onPress={() => apply(draft.trim())}
                disabled={draft.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel={COPY.manualConfirm}
                testID={`optionsdesk-manual-confirm-${slot}`}
              >
                <Text className="text-sm text-brand-500 px-sm">{COPY.manualConfirm}</Text>
              </Pressable>
            </View>
          )}
          <Pressable
            onPress={() => {
              setEditing(false);
              setDraft('');
            }}
            accessibilityRole="button"
            accessibilityLabel={COPY.manualCancel}
            testID={`optionsdesk-manual-cancel-${slot}`}
          >
            <Text className="text-xs text-ink-subtle">{COPY.manualCancel}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
