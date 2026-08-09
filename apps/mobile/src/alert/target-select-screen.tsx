import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { GroupItemSystemKind, useMarketdataControllerSearch } from '@nvy/api-client';

import { Button, ErrorRow, MarketBadge, SafeAreaView, Spinner } from '~/ui';
import { colors } from '~/theme';
import { useQuoteMerge } from '~/portfolio/use-quote-merge';
import { useWatchlistGroups } from '~/portfolio/use-watchlist-groups';
import { useWatchlistItems } from '~/portfolio/use-watchlist-items';
import { ALERT_COPY } from './alert-copy';
import { AlertIcon } from './alert-icon';
import { AlertTabRow } from './alert-tab-row';
import { CheckCircle } from './check-circle';
import { isAllSelected, toggleSelectAll, toggleSelection } from './alert-selection';
import { splitNameHighlight } from './target-select.helpers';

// 屏 4 预警对象选择（021 US4 / FR-M09，mockup TargetSelectScreen 翻 RN）：自选 tab =
// 系统「自选」组 checkbox 多选（user 定夺：仅系统组；其余组标的走搜索 tab）+ 全选 +
// 「去添加」批量进编辑页；搜索 tab = 015 /search（add-watchlist-entry 同源，D11）结果行
// 「添加」单只直进。范围 V1 仅 A股（cn）。行主名 = 名称（015 /quote 返 name，原 013
// 决策 A「以代码为主名」已翻案；未就位回落代码）。
// presentational 编排 — 渲染/交互走 Playwright（mono 测试分层）。

const COPY = ALERT_COPY.targetSelect;

export function TargetSelectScreen() {
  const router = useRouter();
  const [tab, setTab] = useState('watch');

  const goEdit = (symbols: string[]) =>
    router.push({ pathname: '/(app)/alert/edit', params: { instruments: symbols.join(',') } });

  return (
    <View className="flex-1 bg-surface">
      <AlertTabRow
        tabs={[
          { key: 'watch', label: COPY.tabWatch },
          { key: 'search', label: COPY.tabSearch },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'watch' ? <WatchTab onAdd={goEdit} /> : <SearchTab onAdd={goEdit} />}
    </View>
  );
}

/** 自选 tab：系统「自选」组 cn 标的多选 + 全选 + 去添加（批量）。 */
function WatchTab({ onAdd }: { onAdd: (symbols: string[]) => void }) {
  const { groups, status: groupsStatus } = useWatchlistGroups();
  const watchlistGroup = groups.find((g) => g.systemKind === GroupItemSystemKind.watchlist) ?? null;
  const { items, status: itemsStatus, refetch } = useWatchlistItems(watchlistGroup?.id ?? null);

  // V1 预警仅 A股 → 过滤非 cn 标的（server rules 同口径，避免提交才 400）。
  const cnItems = useMemo(() => items.filter((it) => it.market === 'cn'), [items]);
  const symbols = cnItems.map((it) => `${it.market}:${it.code}`);
  // 行主名取 015 /quote 的 name（批量一次，未就位回落代码）。
  const { quoteFor } = useQuoteMerge(cnItems);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const status =
    groupsStatus === 'ready' && watchlistGroup == null
      ? 'ready' // 组列就位但无自选组（理论不可达，系统组必建）→ 按空列表渲染。
      : groupsStatus !== 'ready'
        ? groupsStatus
        : itemsStatus;

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md px-md">
        <Text className="text-base text-ink-muted">{ALERT_COPY.list.loadError}</Text>
        <Button label={ALERT_COPY.list.retry} onPress={() => void refetch()} />
      </View>
    );
  }

  return (
    <>
      <ScrollView className="flex-1">
        {cnItems.map((it) => {
          const symbol = `${it.market}:${it.code}`;
          const on = selected.has(symbol);
          return (
            <Pressable
              key={it.id}
              onPress={() => setSelected(toggleSelection(selected, symbol))}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${COPY.selectA11y} ${it.code}`}
              className="flex-row items-center gap-sm px-md py-md border-b border-line-soft"
            >
              <CheckCircle checked={on} size={21} />
              <MarketBadge code={it.code} />
              <Text className="text-base font-medium text-ink" numberOfLines={1}>
                {quoteFor(it)?.name ?? it.code}
              </Text>
              <Text className="text-xs font-mono text-ink-subtle">{it.code}</Text>
            </Pressable>
          );
        })}
        {cnItems.length === 0 ? (
          <Text className="text-center text-sm text-ink-subtle pt-3xl">{COPY.emptyWatchlist}</Text>
        ) : null}
      </ScrollView>
      <SafeAreaView edges={['bottom']} className="bg-surface border-t border-line">
        <Text className="text-center text-xs text-ink-subtle pt-sm">
          {ALERT_COPY.editScreen.batchHint}
        </Text>
        <View className="flex-row items-center px-md py-sm">
          <Pressable
            onPress={() => setSelected(toggleSelectAll(selected, symbols))}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isAllSelected(selected, symbols) }}
            accessibilityLabel={ALERT_COPY.listScreen.selectAll}
            className="flex-row items-center gap-sm"
          >
            <CheckCircle checked={isAllSelected(selected, symbols)} size={21} />
            <Text className="text-base text-ink">{ALERT_COPY.listScreen.selectAll}</Text>
          </Pressable>
          <View className="flex-1" />
          <View className="w-32">
            <Button
              label={COPY.goAdd}
              disabled={selected.size === 0}
              onPress={() => onAdd([...selected])}
            />
          </View>
        </View>
      </SafeAreaView>
    </>
  );
}

/** 搜索 tab：015 /search 防抖即点即用（单只直进编辑页）。 */
function SearchTab({ onAdd }: { onAdd: (symbols: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // 250ms 防抖（add-watchlist-entry 同款），避免每键一打 /search。
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useMarketdataControllerSearch(
    { q: debounced },
    { query: { enabled: debounced.length > 0 } },
  );
  // V1 预警仅 A股 → 只保留 cn 结果。
  const results = (search.data?.data.items ?? []).filter((r) => r.symbol.startsWith('cn:'));

  return (
    <View className="flex-1">
      <View className="px-md py-sm">
        <View className="flex-row items-center gap-sm bg-surface-sunken rounded-md px-md h-10">
          <AlertIcon name="search" color={colors.ink.subtle} size={17} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={COPY.searchPlaceholder}
            accessibilityLabel={COPY.searchPlaceholder}
            className="flex-1 text-base text-ink"
          />
          {query !== '' ? (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel={COPY.clear}
              hitSlop={8}
            >
              <AlertIcon name="xCircle" size={18} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {search.isError ? (
        <View className="px-md pb-sm">
          <ErrorRow text={ALERT_COPY.list.loadError} />
        </View>
      ) : null}
      <ScrollView className="flex-1">
        {results.length === 0 ? (
          <Text className="text-center text-sm text-ink-subtle px-md py-2xl">
            {debounced ? COPY.noResult : COPY.emptyHint}
          </Text>
        ) : (
          results.map((r) => {
            const code = r.symbol.split(':')[1] ?? '';
            return (
              <View
                key={r.symbol}
                className="flex-row items-center gap-sm px-md py-md border-b border-line-soft"
              >
                <MarketBadge code={code} />
                <Text className="text-base font-medium" numberOfLines={1}>
                  {splitNameHighlight(r.name, debounced).map((seg, i) => (
                    <Text key={i} className={seg.hit ? 'text-brand-500' : 'text-ink'}>
                      {seg.text}
                    </Text>
                  ))}
                </Text>
                <Text className="text-xs text-ink-subtle">{code}</Text>
                <View className="flex-1" />
                <Pressable
                  onPress={() => onAdd([r.symbol])}
                  accessibilityRole="button"
                  accessibilityLabel={`${COPY.add} ${r.name}`}
                  className="rounded-md bg-brand-500 px-lg py-xs"
                >
                  <Text className="text-sm font-semibold text-white">{COPY.add}</Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
