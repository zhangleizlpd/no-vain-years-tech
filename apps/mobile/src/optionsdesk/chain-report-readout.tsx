// 055 T014 — 十字线读数面板（`FR-027`–`FR-029`, `SC-004`）。mockup 帧 ⑤。
//
// 🚨 **空格给「为什么空」而不是给一份空读数**（`FR-029`）—— 三种成因各自成句；
//    🚫 MUST NOT 停留在上一格（面板恒由当前落点算出，见 `chain-report-crosshair.rules.ts`）。
// 🚨 **本列 IV 与格明细同屏给出**（`SC-004`）—— 用户回答「这一列年化高是不是因为波动率高」
//    所需的操作次数 = 1，故它在空格时也照常显示（那问题与这一格有没有值无关）。
import { Text, View } from 'react-native';

import type { ChainReportReadoutView } from './chain-report-crosshair.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

export interface ChainReportReadoutProps {
  view: ChainReportReadoutView;
}

export function ChainReportReadout({ view }: ChainReportReadoutProps) {
  return (
    <View
      className="mx-md mt-1 gap-1 rounded-sm border border-line bg-surface-sunken px-2 py-1.5"
      testID="chain-report-readout"
    >
      <View className="flex-row items-baseline gap-1.5">
        <Text className="text-xs font-bold text-ink">{view.expiryText}</Text>
        <Text className="text-[10px] text-ink-muted">{view.dteText}</Text>
        {view.monthlyText === null ? null : (
          <Text className="text-[10px] text-brand-500">{view.monthlyText}</Text>
        )}
        <Text className="ml-auto text-[10px] text-ink-muted">{view.spanText}</Text>
      </View>

      {view.emptyReason === null ? (
        <View className="flex-row gap-3.5">
          <Field label={COPY.readoutLegCount} value={view.legCountText} />
          <Field label={view.bestLabel} value={view.bestText} />
          {/* 🚨 次优为空时**显式呈「无」**，🚫 不复述最优（`FR-028`）—— 用降级字重与它区分。 */}
          <Field label={view.runnerUpLabel} value={view.runnerUpText} muted={view.runnerUpIsNone} />
          <Field label={COPY.readoutIv} value={view.ivText} />
        </View>
      ) : (
        <View className="flex-row gap-3.5">
          <Text className="text-[11px] text-ink" testID="chain-report-readout-reason">
            {view.emptyReason}
          </Text>
          <Field label={COPY.readoutIv} value={view.ivText} />
        </View>
      )}

      <Text className="text-[9px] text-ink-subtle">{COPY.readoutTip}</Text>
    </View>
  );
}

function Field({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <View className="flex-row items-baseline gap-1">
      <Text className="text-[10px] text-ink-muted">{label}</Text>
      <Text className={muted ? 'text-[11px] text-ink-muted' : 'text-[11px] font-semibold text-ink'}>
        {value}
      </Text>
    </View>
  );
}
