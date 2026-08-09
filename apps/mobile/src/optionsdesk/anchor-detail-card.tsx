// 046 T021 — 锚卡（FR-002 / FR-004 / FR-005）。**只读呈现，MUST NOT 提供锚编辑入口**
// （编辑仍在 045 的锚表单，FR-004）。字段与判定全在 `underlying-detail.rules.ts`。
//
// 🚨 **两个「本片无数据源」字段的恒态**（plan D9，判定在 rules、这里只渲染）：
//    ① 仓位水位恒「未知 · 待接入」—— **禁显 0**（持仓规模属 M3/M4）
//    ② 未持股 ⇒ **愿卖锚行不出现** —— 字段清单里压根没有这一格，不是渲染时藏起来
// 🚨 **Guardrail 8**：逾期 / 人工态这类需要被看见的字**不用最淡档** `text-ink-subtle`。
import { Text, View } from 'react-native';
import type { AnchorResponse } from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  anchorCardFields,
  anchorManualNotices,
  freshnessOf,
  type AnchorCardField,
} from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.underlyingDetail.anchorCard;

export interface AnchorDetailCardProps {
  anchor: AnchorResponse;
  today: string;
  testID?: string;
}

export function AnchorDetailCard({
  anchor,
  today,
  testID = 'optionsdesk-detail-anchor-card',
}: AnchorDetailCardProps) {
  const fields = anchorCardFields(anchor);
  const header = fields.filter((f) => f.slot === 'header');
  const grid = fields.filter((f) => f.slot === 'grid');
  const footer = fields.filter((f) => f.slot === 'footer');
  const notices = anchorManualNotices(anchor);
  // 行情 asOf —— 与 IV 读数的 asOf 是**两个独立**的新鲜度（FR-020），各标各的。
  const quote = freshnessOf(anchor.lastCloseDate, anchor.quoteFreshnessTier);

  return (
    <View className="gap-sm rounded-md border border-line bg-surface px-md py-sm" testID={testID}>
      {/* 题头：愿买价锚大数（= W）+ L 层 / 人工 / 逾期徽标 + 锚 asof。 */}
      <View className="flex-row items-start justify-between">
        <View className="gap-0.5">
          <Text className="text-xs text-ink-muted">{COPY.willingBuyAnchor}</Text>
          <Text className="font-mono text-2xl font-bold text-err" testID={`${testID}-w`}>
            {anchor.w}
          </Text>
        </View>
        <View className="items-end gap-xs">
          <View className="flex-row flex-wrap items-center justify-end gap-xs">
            {header
              .filter((f) => f.key === 'lLevel')
              .map((f) => (
                <View key={f.key} className="rounded-full bg-tag-blue px-sm py-0.5">
                  <Text className="text-xs font-semibold text-white" testID={`${testID}-l-level`}>
                    {f.value}
                  </Text>
                </View>
              ))}
            {fields.some((f) => f.manual) ? (
              <View className="rounded-full border border-line-strong px-sm py-0.5">
                <Text className="text-xs text-ink" testID={`${testID}-manual-badge`}>
                  {COPY.manualBadge}
                </Text>
              </View>
            ) : null}
            {anchor.overdue ? (
              <View className="rounded-full border border-err px-sm py-0.5">
                <Text className="text-xs font-semibold text-err" testID={`${testID}-overdue`}>
                  {COPY.overdueDays(daysOverdue(anchor.nextReview, today))}
                </Text>
              </View>
            ) : null}
          </View>
          {header
            .filter((f) => f.key === 'asof')
            .map((f) => (
              <Text key={f.key} className="text-[10px] text-ink-subtle">
                {f.value}
              </Text>
            ))}
        </View>
      </View>

      {/* 键值网格（两列）。 */}
      <View className="flex-row flex-wrap">
        {grid.map((f) => (
          <GridCell key={f.key} field={f} testID={`${testID}-field-${f.key}`} />
        ))}
      </View>

      {/* FR-004 人工态提示（同屏带出派生值，措辞表达**临时**语义）。 */}
      {notices.map((text) => (
        <Text key={text} className="text-[11px] text-ink-muted" testID={`${testID}-manual-hint`}>
          {text}
        </Text>
      ))}

      {/* 卡底：下次复审（逾期红）+ 行情 asOf。 */}
      <View className="flex-row items-center justify-between border-t border-line-soft pt-xs">
        {footer.map((f) => (
          <View key={f.key} className="flex-row items-baseline gap-xs">
            <Text className="text-xs text-ink-muted">{f.label}</Text>
            <Text
              className={`font-mono text-xs ${f.danger ? 'font-bold text-err' : 'text-ink'}`}
              testID={`${testID}-field-${f.key}`}
            >
              {f.value}
            </Text>
          </View>
        ))}
        <Text
          className={`text-[10px] ${quote.tier === 'CURRENT' ? 'text-ink-subtle' : 'text-ink-muted'}`}
          testID={`${testID}-quote-asof-${quote.tier}`}
        >
          {quote.text}
        </Text>
      </View>
    </View>
  );
}

function GridCell({ field, testID }: { field: AnchorCardField; testID: string }) {
  return (
    <View className="w-1/2 gap-0.5 py-xs">
      <Text className="text-[10px] text-ink-subtle">{field.label}</Text>
      <View className="flex-row items-baseline gap-xs">
        <Text
          className={`font-mono text-sm ${field.danger ? 'font-bold text-err' : 'text-ink'}`}
          testID={testID}
          numberOfLines={1}
        >
          {field.value}
        </Text>
        {field.manual ? (
          <Text className="text-[9px] text-ink-muted">{COPY.manualBadge}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** 逾期天数只做展示（是否红标由 server 的 `overdue` 决定）。体例同 045 锚列表。 */
function daysOverdue(nextReview: string | null, today: string): number {
  if (!nextReview) return 0;
  const diff = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${nextReview}T00:00:00Z`);
  return Math.max(0, Math.round(diff / 86_400_000));
}
