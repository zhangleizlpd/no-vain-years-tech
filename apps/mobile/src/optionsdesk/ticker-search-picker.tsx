// 045 T022 — 建锚搜票选择器（mockup 帧 ⑥）。消费**已 ship** 的 `GET /marketdata/search`
// （东财 searchapi 主源 + pg_trgm 本地兜底，无 market 过滤 ⇒ us 天然可搜；无匹配返空 200）。
//
// 🚨 EC-2 / FR-002 硬约束：**不接受自由文本**。ticker 只能由这里的选中项写进表单，搜不到
// 即不能提交，**不提供任何绕过路径**（没有「仍然保存」，也没有手填 code 的入口）—— 因为
// ticker 是采集工作集与跨 ctx 关联的锚点，未经校验的串会让整条链断在看不见的地方。
//
// 下拉项字段取该端点**现有响应形状**（`InstrumentSearchItem`：symbol / name / type），不新增字段。
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useMarketdataControllerSearch, type InstrumentSearchItem } from '@nvy/api-client';

import { colors } from '~/theme';
import { Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { isSupportedMarket } from './radar.rules';

const COPY = OPTIONSDESK_COPY.anchorForm;

export interface TickerSearchPickerProps {
  picked: { symbol: string; name: string } | null;
  onPick: (item: InstrumentSearchItem | null) => void;
  disabled?: boolean;
}

/** canonical `market:code` → 展示用两段（不做映射，015 词表 cn/hk/us 已对齐）。 */
function splitSymbol(symbol: string): { market: string; code: string } {
  const [market, code] = symbol.split(':');
  return { market: market ?? '', code: code ?? symbol };
}

export function TickerSearchPicker({ picked, onPick, disabled }: TickerSearchPickerProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // 250ms 防抖，避免每键一打 /search（同 portfolio/add-watchlist-entry 体例）。
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useMarketdataControllerSearch(
    { q: debounced },
    { query: { enabled: debounced.length > 0 } },
  );
  const results = search.data?.data.items ?? [];
  const searched = debounced.length > 0 && !search.isFetching;
  const noMatch = searched && results.length === 0;

  if (picked) {
    const { market, code } = splitSymbol(picked.symbol);
    return (
      <View
        className="flex-row items-center justify-between gap-sm"
        testID="optionsdesk-ticker-picked"
      >
        <View className="flex-1">
          <Text className="text-base font-semibold text-ink">{code}</Text>
          <Text className="text-xs text-ink-muted mt-0.5">
            {picked.name} · {market}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            setQuery('');
            setDebounced('');
            onPick(null);
          }}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={COPY.tickerChange}
          testID="optionsdesk-ticker-change"
        >
          <Text className="text-sm text-brand-500 px-sm">{COPY.tickerChange}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="gap-sm">
      <Text className="text-xs text-ink-muted">{COPY.tickerSearchLabel}</Text>
      <View className="flex-row items-center gap-sm bg-surface-sunken rounded-md px-md h-11">
        <TextInput
          value={query}
          onChangeText={setQuery}
          editable={!disabled}
          autoCapitalize="characters"
          placeholder={COPY.tickerSearchPlaceholder}
          placeholderTextColor={colors.ink.subtle}
          accessibilityLabel={COPY.tickerSearchLabel}
          testID="optionsdesk-ticker-search-input"
          className="flex-1 text-base text-ink"
        />
        {search.isFetching ? <Spinner size={14} tone="muted" /> : null}
      </View>

      {noMatch ? (
        // EC-2：明示搜不到 + 明写无绕过路径。这里**不渲染**任何「仍然保存 / 手填代码」入口。
        <View className="gap-xs" testID="optionsdesk-ticker-no-match">
          <Text className="text-sm text-err">{COPY.tickerNoMatch}</Text>
          <Text className="text-xs text-ink-subtle">{COPY.tickerNoBypass}</Text>
        </View>
      ) : null}

      {results.length > 0 ? (
        // ⚠️ ScrollView 的 frame 不受 width/height class 约束 → 外包一层 View 定高
        // （memory `nativewind_web_class_traps`）。
        <View style={{ maxHeight: 220 }}>
          <ScrollView keyboardShouldPersistTaps="handled">
            {results.map((r) => {
              const { market, code } = splitSymbol(r.symbol);
              // 065 FR-017 / SC-006：非受支持市场**可见但不可选 + 一句原因**。
              // 🚫 MUST NOT 静默过滤掉 —— 搜「茅台」返回空白会让人以为搜索坏了。
              // 判据与市场页签**取同一处**（`isSupportedMarket`），分成两份必然漂。
              const supported = isSupportedMarket(market);
              return (
                <Pressable
                  key={r.symbol}
                  onPress={supported ? () => onPick(r) : undefined}
                  disabled={!supported}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !supported }}
                  accessibilityLabel={
                    supported
                      ? `${code} ${r.name}`
                      : `${code} ${r.name} ${COPY.tickerMarketUnsupported}`
                  }
                  testID={`optionsdesk-ticker-result-${r.symbol}`}
                  className="flex-row items-center gap-sm py-sm border-b border-line-soft"
                >
                  <Text className="text-sm font-mono text-ink w-20">{code}</Text>
                  <Text className="flex-1 text-sm text-ink-muted" numberOfLines={1}>
                    {r.name}
                  </Text>
                  {supported ? (
                    <Text className="text-xs text-ink-subtle">{market}</Text>
                  ) : (
                    // 原因就地给出 —— 「为什么点不动」必须与那一行同屏，否则等于静默失效。
                    <Text
                      className="text-xs text-ink-subtle"
                      testID={`optionsdesk-ticker-unsupported-${r.symbol}`}
                    >
                      {COPY.tickerMarketUnsupported}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Text className="text-xs text-ink-subtle">
        {debounced.length === 0 ? COPY.tickerEmptyHint : COPY.tickerSearchHint}
      </Text>
    </View>
  );
}
