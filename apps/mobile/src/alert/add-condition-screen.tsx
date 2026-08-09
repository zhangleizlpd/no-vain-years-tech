import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { AlertConditionItemType } from '@nvy/api-client';

import { SearchBar } from '~/ui';
import {
  ALERT_CATEGORIES,
  ALERT_COPY,
  ALERT_CONDITION_TYPES,
  NO_PARAM,
  conditionName,
  conditionsByCategory,
  metaOf,
  type AlertCategory,
} from './alert-copy';
import { InstrumentQuoteStrip } from './instrument-quote-strip';
import {
  MAX_CONDITIONS,
  isAdded,
  multiSelectQuota,
  newConditionDefaults,
  useAlertDraft,
} from './use-alert-draft';
import { ValueInputSheet } from './value-input-sheet';

// 屏 3 添加条件（023 US1 / FR-M01，mockup AddCondKit 翻 RN）：搜条件框 + 左 4 分类 rail
// （价格跟踪 / 估值 / 成交量 / 技术指标）+ 右该类条件行（含无参语义副标题）+「添加」。
// 行为分流（按 meta.kind）：
//   • none（MACD/KDJ/BOLL 等无参穿越）→ 点添加**直接入草稿返回屏 2**，不弹 sheet（FR-M01）；
//   • 其余（阈值 / 带参）→ 弹 ValueInputSheet（参数变体族 = T016）。
// 「已添加」判定按 (type, param)：单实例类型（无参白名单：阈值/RSI/无参）按 (type,0) 判定并显
// 静态徽标；带参类型（ma/window/daysPct/pctile）可多 param 共存，行级永远可加（去重在 sheet）。
// 搜索（FR-M04）跨分类命中：有 query 时全词表过滤、隐藏 rail，结果跨类平铺；无 query 按选中分类。
// 条件满 4（server 同口径上限）时未加项 disabled。标的取草稿（屏 2 已 init；批量无行情条）。

const COPY = ALERT_COPY.addCondition;

/** 无 props——条件库静态 + 标的/已加条件均来自共享草稿。 */
export function AddConditionScreen() {
  const router = useRouter();
  const draft = useAlertDraft();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AlertCategory>('price');
  const [pickedType, setPickedType] = useState<AlertConditionItemType | null>(null);

  const single = draft.instruments.length === 1 ? draft.instruments[0] : null;
  const full = draft.conditions.length >= MAX_CONDITIONS;
  const q = query.trim();
  const visibleTypes = q
    ? ALERT_CONDITION_TYPES.filter((t) => conditionName(t).includes(q))
    : conditionsByCategory(category);

  // 单实例类型（无参白名单）按 (type,0) 已添加；带参类型可多 param 共存，行级永远可加。
  const rowAdded = (t: AlertConditionItemType) => {
    const m = metaOf(t);
    return (
      m !== undefined && m.paramWhitelist.length === 0 && isAdded(draft.conditions, t, NO_PARAM)
    );
  };

  const onAdd = (t: AlertConditionItemType) => {
    if (metaOf(t)?.kind === 'none') {
      // 无参条件无可配参数：直接入草稿返回屏 2（FR-M01）。
      draft.upsert(t, NO_PARAM, '');
      router.back();
      return;
    }
    setPickedType(t);
  };

  // sheet seed（026 多选）：带参类型预勾选草稿同 type 已存 param（FR-009）、新建空选；单实例类型
  // 回显现值或默认。initialParams 用 useMemo 稳引用，避免每渲染重置 sheet 内选中集。
  const pickedMeta = pickedType != null ? metaOf(pickedType) : undefined;
  const isChipType = pickedMeta !== undefined && pickedMeta.paramWhitelist.length > 0;
  const existingSameType = useMemo(
    () => (pickedType != null ? draft.conditions.filter((c) => c.type === pickedType) : []),
    [pickedType, draft.conditions],
  );
  const sheetParams = useMemo(
    () =>
      isChipType ? existingSameType.map((c) => c.param) : [existingSameType[0]?.param ?? NO_PARAM],
    [isChipType, existingSameType],
  );
  const sheetThreshold =
    existingSameType[0]?.threshold ??
    (pickedType != null ? newConditionDefaults(pickedType).threshold : '');
  const quotaMax =
    pickedType != null ? multiSelectQuota(draft.conditions, pickedType).max : MAX_CONDITIONS;

  return (
    <View className="flex-1 bg-surface-sunken">
      {single ? <InstrumentQuoteStrip market={single.market} code={single.code} /> : null}
      <View className="bg-surface px-md py-sm border-b border-line-soft">
        <SearchBar
          value={query}
          onChangeText={setQuery}
          onClear={() => setQuery('')}
          placeholder={COPY.searchPlaceholder}
        />
      </View>
      <View className="flex-1 flex-row">
        {/* 左侧 4 分类栏（搜索态隐藏，结果跨类平铺 per FR-M04）。 */}
        {q ? null : (
          <View className="w-24 bg-surface-sunken">
            <ScrollView>
              {ALERT_CATEGORIES.map((cat) => (
                <CategoryTab
                  key={cat}
                  label={COPY.categories[cat]}
                  active={cat === category}
                  onPress={() => setCategory(cat)}
                />
              ))}
            </ScrollView>
          </View>
        )}
        {/* 右侧条件列表 */}
        <ScrollView className="flex-1 bg-surface">
          {visibleTypes.length === 0 ? (
            <Text className="text-sm text-ink-subtle text-center py-lg">{COPY.emptySearch}</Text>
          ) : (
            visibleTypes.map((t, i) => (
              <ConditionRow
                key={t}
                type={t}
                added={rowAdded(t)}
                blocked={!rowAdded(t) && full}
                last={i === visibleTypes.length - 1}
                onAdd={() => onAdd(t)}
              />
            ))
          )}
        </ScrollView>
      </View>

      <ValueInputSheet
        type={pickedType}
        initialParams={sheetParams}
        initialThreshold={sheetThreshold}
        quotaMax={quotaMax}
        market={single?.market}
        code={single?.code}
        onConfirm={(params, threshold) => {
          // reconcile 对齐本 type 选中集（值变体单 (type,0)；chip 多选一次提交多 param，
          // 删未选/留他 type 同一函数收口，FR-007/009）。
          if (pickedType) draft.reconcile(pickedType, params, threshold);
          setPickedType(null);
          router.back();
        }}
        onClose={() => setPickedType(null)}
      />
    </View>
  );
}

/** 左 rail 分类项（选中态：白底 + brand 竖条 + brand 加粗文案）。 */
function CategoryTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      className={`flex-row items-center py-md ${active ? 'bg-surface' : ''}`}
    >
      <View className={`w-1 self-stretch rounded-full ${active ? 'bg-brand-500' : ''}`} />
      <Text
        className={`flex-1 text-sm pl-md ${
          active ? 'font-semibold text-brand-500' : 'text-ink-muted'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** 条件行：名 + 无参语义副标题 + 「添加/已添加」按钮（添加后按钮仍可点 → sheet 覆盖）。 */
function ConditionRow({
  type,
  added,
  blocked,
  last,
  onAdd,
}: {
  type: AlertConditionItemType;
  added: boolean;
  blocked: boolean;
  last: boolean;
  onAdd: () => void;
}) {
  const sub = metaOf(type)?.sub;
  return (
    <View
      className={`flex-row items-center px-md py-md ${last ? '' : 'border-b border-line-soft'}`}
    >
      <View className="flex-1">
        <Text className="text-base text-ink">{conditionName(type)}</Text>
        {sub ? <Text className="text-xs text-ink-subtle mt-xs">{sub}</Text> : null}
      </View>
      <Pressable
        onPress={onAdd}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityLabel={`${COPY.add}${conditionName(type)}`}
        accessibilityState={{ disabled: blocked }}
        className={`rounded-md px-md py-xs ${added ? 'bg-surface-sunken' : 'bg-brand-soft'} ${
          blocked ? 'opacity-40' : ''
        }`}
      >
        <Text className={`text-sm font-semibold ${added ? 'text-ink-subtle' : 'text-brand-500'}`}>
          {added ? COPY.added : COPY.add}
        </Text>
      </Pressable>
    </View>
  );
}
