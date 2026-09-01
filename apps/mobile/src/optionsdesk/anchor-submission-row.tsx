import { Pressable, Text, View } from 'react-native';
import type { AnchorSubmissionReviewResponse } from '@nvy/api-client';

import { asofBadgeLabel, DISPOSITION_LABEL, submissionFactsLine } from './anchor-submission.rules';
import { underlyingDisplayName } from './underlying-identity.rules';

/**
 * 072 T018 — 待审条目行。两个宿主共用：「我的」审批栏内嵌面板 + 全屏列表（含多选态）。
 *
 * 🚨 行首是**中文名 + 代号**，名字取不到才退回代号 —— 判据走 `underlyingDisplayName`
 * （045 plan D13 的同一处），MUST NOT 拿 ticker 拼假名字：那会让「名字没同步上」与
 * 「这票就叫这个」在屏上分不开。
 */
export interface AnchorSubmissionRowProps {
  item: AnchorSubmissionReviewResponse;
  onPress?: () => void;
  /** 多选态：给了就渲勾选框（`undefined` = 非多选态，整行是入口）。 */
  selected?: boolean;
}

export function AnchorSubmissionRow({ item, onPress, selected }: AnchorSubmissionRowProps) {
  const asofLabel = asofBadgeLabel(item.asofFlag);
  const selectable = selected !== undefined;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.ticker}
      accessibilityState={selectable ? { selected } : undefined}
      testID={`optionsdesk-submission-row-${item.ticker}`}
      className={`flex-row items-start gap-sm rounded-md border p-md ${
        selected ? 'border-brand-500 bg-brand-soft' : 'border-line-soft bg-surface'
      }`}
    >
      {selectable ? (
        <View
          testID={`optionsdesk-submission-check-${item.ticker}`}
          className={`w-5 h-5 mt-1 rounded-full border items-center justify-center ${
            selected ? 'border-brand-500 bg-brand-500' : 'border-line'
          }`}
        >
          {selected ? <Text className="text-xs text-surface">✓</Text> : null}
        </View>
      ) : null}

      <View className="flex-1 gap-xs">
        <View className="flex-row items-center gap-sm">
          {/* 挂 shrink：名字长到挤不下时**它先截**，不把代号顶出屏外。 */}
          <Text className="shrink text-base font-semibold text-ink" numberOfLines={1}>
            {underlyingDisplayName({ name: item.instrumentName, ticker: item.ticker })}
          </Text>
          <Text className="flex-1 text-xs text-ink-muted" numberOfLines={1}>
            {item.ticker}
          </Text>
        </View>

        <Text className="text-xs text-ink-muted" numberOfLines={1}>
          {submissionFactsLine(item)}
        </Text>

        <View className="flex-row flex-wrap items-center gap-xs">
          {/* refresh 走警告色 —— 它会冲掉三处人工位并把 confidence_source 翻成 model。 */}
          <Badge
            text={DISPOSITION_LABEL[item.disposition]}
            tone={item.disposition === 'refresh' ? 'warn' : 'info'}
            testID={`optionsdesk-submission-disposition-${item.ticker}`}
          />
          {asofLabel ? (
            <Badge
              text={asofLabel}
              tone="warn"
              testID={`optionsdesk-submission-asof-${item.ticker}`}
            />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function Badge({ text, tone, testID }: { text: string; tone: 'info' | 'warn'; testID?: string }) {
  const skin = tone === 'warn' ? 'border-warn bg-warn-soft' : 'border-brand-500 bg-brand-soft';
  const ink = tone === 'warn' ? 'text-warn' : 'text-brand-500';
  return (
    <View testID={testID} className={`rounded-sm border px-xs ${skin}`}>
      <Text className={`text-xs ${ink}`}>{text}</Text>
    </View>
  );
}
