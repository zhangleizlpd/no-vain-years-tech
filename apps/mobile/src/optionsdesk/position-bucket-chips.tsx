// 047 T033 — 意图条：意图 chip + 判定依据 + 仓位水位三选一（FR-016/017, plan D-UI-5）。
//
// 🚨 **水位在本片没有数据面** —— 持仓规模属 M3/M4，这三个 chip 是**降级路径**（同 v1「现金手工
//    录入」形态）。故：
//    ① 未选是**常驻分支不是过渡态** —— 显「未选」+ 提示条，🚫 MUST NOT 显 0、MUST NOT 按最
//       保守档静默假设（那是 FR-017 明禁的「替人做方向性假设」）；
//    ② 「人工输入」角标**直接读契约的 `positionBucketSource`**，🚫 MUST NOT 靠前端记「刚才是
//       我点的」—— M3 真实水位接入后同一字段会混进别的来源，靠记忆分不清哪些是人填的；
//    ③ 写端点**只收三值、无「清空」动作** ⇒ 本组件没有取消选择的入口（不是漏做）。
//
// 📌 判定依据小字（`L2 · 买区 · 水位 未选`）把矩阵三输入原样摊开 —— 判定本身在 server，
//    这里只负责让人能核对「凭什么是这个意图」。
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LegTableResponse, SetPositionBucketRequestPositionBucket } from '@nvy/api-client';

import { ErrorRow } from '~/ui';
import {
  LEG_POSITION_BUCKETS,
  bucketLabel,
  intentBasisLine,
  intentLabel,
  isManualBucket,
} from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { useSetPositionBucket } from './use-leg-table';

const COPY = OPTIONSDESK_COPY.legPicker;

export interface PositionBucketChipsProps {
  /** canonical `market:code` —— 写成功后按它失效选约表（意图 / Δ 档 / 活跃度全跟着变）。 */
  symbol: string;
  /**
   * 锚 id（写端点挂在锚上）。⚠️ 由**详情端点**给，与选约表是两个并行请求 ⇒ 可能还没到手。
   * `null` 时 chip 照常渲染当前值（读得到），只是点不动 —— 不隐藏面板（FR-020 同款纪律）。
   */
  anchorId: string | null;
  table: LegTableResponse | null;
}

export function PositionBucketChips({ symbol, anchorId, table }: PositionBucketChipsProps) {
  // ⚠️ 只解构 `mutate` —— mutation 对象每 render 换 identity，整个塞进 deps 会自激。
  const { mutate, isPending, isError } = useSetPositionBucket(symbol);

  const pick = useCallback(
    (bucket: SetPositionBucketRequestPositionBucket) => {
      if (anchorId === null) return;
      mutate({ id: anchorId, data: { positionBucket: bucket } });
    },
    [anchorId, mutate],
  );

  const current = table?.positionBucket ?? null;
  const manual = isManualBucket(table?.positionBucketSource ?? null);

  return (
    <View
      className="gap-xs border-b border-line bg-surface px-md py-xs"
      testID="optionsdesk-detail-leg-intent-bar"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-baseline gap-xs">
          <Text
            className="text-xs font-semibold text-ink"
            testID="optionsdesk-detail-leg-intent"
          >{`${COPY.intentPrefix}${intentLabel(table?.intent)}`}</Text>
          <Text className="text-[10px] text-ink-muted">{intentBasisLine(table)}</Text>
        </View>
        {manual ? (
          <Text
            className="rounded-full border border-line-strong px-1.5 text-[9px] text-ink-muted"
            testID="optionsdesk-detail-position-bucket-manual"
          >
            {COPY.bucketManual}
          </Text>
        ) : null}
      </View>

      <View className="flex-row items-center gap-xs">
        <Text className="text-[10px] text-ink-muted">{COPY.bucketTitle}</Text>
        {LEG_POSITION_BUCKETS.map((bucket) => {
          const on = bucket === current;
          return (
            <Pressable
              key={bucket}
              onPress={() => pick(bucket)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={bucketLabel(bucket)}
              testID={`optionsdesk-detail-position-bucket-${bucket}`}
              className={`rounded-full border px-sm py-0.5 ${
                on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface'
              }`}
            >
              <Text className={on ? 'text-[10px] text-brand-500' : 'text-[10px] text-ink-muted'}>
                {bucketLabel(bucket)}
              </Text>
            </Pressable>
          );
        })}
        {isPending ? <Text className="text-[10px] text-ink-muted">{COPY.bucketSaving}</Text> : null}
      </View>

      {isError ? (
        <View testID="optionsdesk-detail-position-bucket-error">
          <ErrorRow text={COPY.bucketSaveFailed} />
        </View>
      ) : null}
    </View>
  );
}
