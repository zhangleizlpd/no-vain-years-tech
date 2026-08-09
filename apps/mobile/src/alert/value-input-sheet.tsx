import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import type { AlertConditionItemType } from '@nvy/api-client';

import { formatPrice, useQuoteMerge } from '~/portfolio/use-quote-merge';
import { colors } from '~/theme';
import { Button, SafeAreaView } from '~/ui';
import {
  ALERT_COPY,
  conditionName,
  conditionUnit,
  formatRemainingQuota,
  metaOf,
  NO_PARAM,
  referencePlaceholder,
} from './alert-copy';
import { AlertIcon } from './alert-icon';
import { applyKey } from './keypad.rules';
import { NumericKeypad } from './numeric-keypad';
import { QuoteStrip } from './quote-strip';
import { thresholdValid } from './use-alert-draft';

// 参数输入 sheet（023 屏 7b 变体族 / 026 重构，mockup design/06-12-sheet-family-baseline 翻 RN）：
// 条件名标题 + 按 meta.kind 分发的输入体 + 分流提交（026 FR-007）：
//   • threshold / rsi（单实例阈值类）→ 只读显示 + 自绘键盘「确定」（026 US1）；
//   • ma / window（纯周期，无阈值）→ 多选 chip + 底部「选好了」（026 US2）；
//   • daysPct / pctile（组合类）→ 多选 chip + 单阈值自绘键盘「确定」（多 param 共用阈值批量生成，US2）。
// chip 组多选（selected: Set<param>），选中态 brand-soft 底 + brand-500 边 + 右下角勾标（FR-010，0 新 token）；
// 名额受上限把守（quotaMax = 4 − 草稿非本 type 条数），满额未勾 chip 禁选 + 剩余名额 helper（FR-008）。
// US3：顶部行情头（单一标的 015 quote merge）+ 右上角 X 关闭（不写草稿）+ 到价类空态参考占位（最新价 X）。
// presentational：提交集（selectedParams + threshold）的 reconcile 编排在调用屏，交互验证走 Playwright。

const COPY = ALERT_COPY.sheet;

export interface ValueInputSheetProps {
  /** null = 关闭（兼当 visible；type 驱动标题/变体/校验）。 */
  type: AlertConditionItemType | null;
  /** 打开时预勾选的 param 集（草稿同 type 已存 param；无参/阈值类为 [NO_PARAM]）。父级须 memo 稳定引用。 */
  initialParams: number[];
  /** 打开时 seed 的阈值原串（编辑回显现值 / 新建空或 RSI 默认）。 */
  initialThreshold: string;
  /** 多选名额上界（4 − 草稿非本 type 条数，plan D4）；满额未勾 chip 禁选。 */
  quotaMax: number;
  /** 标的（026 US3 T009 接：sheet 行情头 + 到价类参考占位；批量新建无单一标的 = undefined）。 */
  market?: string;
  code?: string;
  /** 提交（params = 选中集；纯周期类 threshold ''，阈值类带阈值原串）。 */
  onConfirm: (params: number[], threshold: string) => void;
  onClose: () => void;
}

/** chip 标签（按 kind：MA5 / 250日 / 5日 / 5年）。 */
function chipLabel(kind: string, param: number): string {
  switch (kind) {
    case 'ma':
      return `MA${param}`;
    case 'pctile':
      return `${param}年`;
    default:
      return `${param}日`;
  }
}

/** 多选 param chip 网格（选中态 brand-soft 底 + brand-500 边 + 右下角勾标；满额未勾禁选，FR-008/010）。 */
function ParamChipGrid({
  whitelist,
  kind,
  selected,
  atQuota,
  onToggle,
}: {
  whitelist: readonly number[];
  kind: string;
  selected: Set<number>;
  atQuota: boolean;
  onToggle: (param: number) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-sm mb-md">
      {whitelist.map((p) => {
        const on = selected.has(p);
        const blocked = !on && atQuota;
        return (
          <Pressable
            key={p}
            onPress={() => onToggle(p)}
            disabled={blocked}
            accessibilityRole="button"
            accessibilityLabel={chipLabel(kind, p)}
            accessibilityState={{ selected: on, disabled: blocked }}
            className={`relative overflow-hidden border rounded-md px-md py-sm ${
              on ? 'border-brand-500 bg-brand-soft' : 'border-line'
            } ${blocked ? 'opacity-40' : ''}`}
          >
            <Text className={`text-base ${on ? 'font-semibold text-brand-500' : 'text-ink-muted'}`}>
              {chipLabel(kind, p)}
            </Text>
            {on ? (
              <View className="absolute right-0 bottom-0 w-4 h-4 bg-brand-500 rounded-tl items-center justify-center">
                <AlertIcon name="check" color={colors.surface.DEFAULT} size={9} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function ValueInputSheet({
  type,
  initialParams,
  initialThreshold,
  quotaMax,
  market,
  code,
  onConfirm,
  onClose,
}: ValueInputSheetProps) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialParams));
  const [raw, setRaw] = useState(initialThreshold);

  // 每次打开（type 翻非 null）重新 seed 选中集 + 阈值（父级 memo initialParams 引用稳定，避免每渲染重置）。
  useEffect(() => {
    if (type != null) {
      setSelected(new Set(initialParams));
      setRaw(initialThreshold);
    }
  }, [type, initialParams, initialThreshold]);

  // 行情头 + 到价类参考占位（US3）：单一标的走 015 quote merge；批量新建（无标的）退占位 '--'。
  const ref = market != null && code != null ? { market, code } : null;
  const { quoteFor } = useQuoteMerge(ref != null ? [ref] : []);
  const quote = ref != null ? quoteFor(ref) : undefined;
  const lastPriceText = formatPrice(quote);

  const meta = type != null ? metaOf(type) : undefined;
  const kind = meta?.kind;
  const hasChips = kind === 'ma' || kind === 'window' || kind === 'daysPct' || kind === 'pctile';
  // 带阈值族（threshold/rsi 单值 + daysPct/pctile 组合）走自绘键盘录入 + 键盘「确定」；
  // 纯周期类（ma/window，无阈值）走底部「选好了」。
  const hasThreshold =
    kind === 'threshold' || kind === 'rsi' || kind === 'daysPct' || kind === 'pctile';

  // 校验口径跨变体统一：chip 类至少选 1（FR-007a），阈值类 thresholdValid（无阈值族恒真）。
  const chipsValid = !hasChips || selected.size >= 1;
  const thrValid = !hasThreshold || (type != null && thresholdValid(type, raw));
  const valid = type != null && chipsValid && thrValid;
  // RSI 出域显式红字（FR-M02）；其余非法仅 disable 提交键（021 口径）。
  const rsiError = kind === 'rsi' && raw !== '' && !(type != null && thresholdValid(type, raw));

  // 名额（FR-008）：剩余 = max − 已选；满额（已选 ≥ max）未勾 chip 禁选；quota 实际约束时显 helper。
  const remaining = Math.max(0, quotaMax - selected.size);
  const atQuota = selected.size >= quotaMax;
  const constrained = hasChips && meta != null && quotaMax < meta.paramWhitelist.length;

  // 提交集：chip 类发选中集（纯周期 threshold ''），单实例阈值类发 [NO_PARAM] + 阈值原串。
  const submitParams = hasChips ? [...selected] : [NO_PARAM];
  const submitThreshold = hasThreshold ? raw : '';
  const submit = () => onConfirm(submitParams, submitThreshold);

  const toggle = (p: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else if (next.size < quotaMax) next.add(p);
      return next;
    });

  return (
    <Modal
      visible={type != null}
      transparent
      statusBarTranslucent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* 无 KeyboardAvoidingView：全阈值类走自绘键盘、不弹系统键盘，无需顶起底部 sheet。 */}
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable onPress={onClose} accessibilityLabel={COPY.close} className="absolute inset-0" />
        {/* max-h-[92%]：sheet 高度上限（M3/HIG 都对 modal sheet 限高、留顶部间隙）；键盘+头都是固定
            高度且在目标机型容下 → 不加 ScrollView（无溢出可滚，徒增 pan-to-dismiss 冲突）。底部
            safe-area 由 SafeAreaView edges=bottom 原生量取（Android 15 edge-to-edge 下让末行避开手势条）。 */}
        <SafeAreaView
          edges={['bottom']}
          className="bg-surface rounded-t-lg px-md pt-lg pb-md max-h-[92%]"
        >
          {type != null && meta != null ? (
            <>
              {/* 右上角 X 关闭（FR-013，与遮罩 / 系统返回同走 onClose，不写草稿）。 */}
              <View className="flex-row items-center justify-end mb-sm">
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.close}
                  hitSlop={8}
                >
                  <AlertIcon name="x" color={colors.ink.subtle} size={20} />
                </Pressable>
              </View>
              {/* 行情头（FR-012，单一标的；批量新建无标的 → 不渲染）。-mx-md 抵消 sheet 自身 px-md，
                  令 QuoteStrip 满 sheet 宽（自带 px-md），否则双层 padding 把 5 字段挤到截断。 */}
              {ref != null ? (
                <View className="-mx-md">
                  <QuoteStrip name={quote?.name ?? '--'} code={ref.code} quote={quote} />
                </View>
              ) : null}
              <View className="flex-row items-center justify-between mb-md mt-md">
                <Text className="text-lg font-semibold text-ink">{conditionName(type)}</Text>
                {hasChips ? (
                  <Text className="text-xs text-ink-subtle">{COPY.multiSelectHint}</Text>
                ) : null}
              </View>
              {meta.sub != null ? (
                <Text className="text-xs text-ink-subtle mb-md">{meta.sub}</Text>
              ) : null}
              {constrained ? (
                <Text className="text-xs text-ink-muted mb-sm">
                  {formatRemainingQuota(remaining)}
                </Text>
              ) : null}
              {hasChips ? (
                <ParamChipGrid
                  whitelist={meta.paramWhitelist}
                  kind={meta.kind}
                  selected={selected}
                  atQuota={atQuota}
                  onToggle={toggle}
                />
              ) : null}
              {hasThreshold ? (
                <>
                  {/* 阈值类（threshold/rsi 单值 + daysPct/pctile 组合）：只读显示 + 自绘键盘驱动（无系统键盘）。
                      组合类的多选 chip 已在上方渲染，多 param 共用此单一阈值，键盘「确定」一次批量生成（FR-011）。 */}
                  <View
                    className={`flex-row items-center bg-surface-alt border rounded-md px-md ${
                      rsiError ? 'border-err' : 'border-line'
                    }`}
                  >
                    <Text
                      accessibilityLabel={`${conditionName(type)}${raw ? ` ${raw}` : ''}`}
                      className={`flex-1 text-lg font-mono font-semibold py-md ${
                        raw === '' ? 'text-ink-subtle' : 'text-ink'
                      }`}
                    >
                      {raw === '' ? referencePlaceholder(type, lastPriceText) : raw}
                    </Text>
                    <Text className="text-base text-ink-muted">{conditionUnit(type)}</Text>
                  </View>
                  {rsiError ? (
                    <Text className="text-xs text-err mt-sm">{COPY.rsiRangeError}</Text>
                  ) : null}
                  <NumericKeypad
                    onKey={(key) => setRaw(applyKey(raw, key))}
                    onConfirm={submit}
                    confirmDisabled={!valid}
                    confirmLabel={COPY.keypadConfirm}
                  />
                </>
              ) : (
                // 纯周期类（ma/window，无阈值）：多选 chip + 底部「选好了」批量提交（FR-007）。
                <Button label={COPY.confirm} disabled={!valid} onPress={submit} />
              )}
            </>
          ) : null}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
