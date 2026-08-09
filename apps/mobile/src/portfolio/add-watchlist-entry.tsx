import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  GroupItemSystemKind,
  useMarketdataControllerSearch,
  type AddWatchlistItemRequestMarket,
  type GroupItem,
  type InstrumentSearchItem,
} from '@nvy/api-client';

import { ErrorRow, MarketBadge } from '~/ui';
import { useWatchlistItems } from './use-watchlist-items';
import { WATCHLIST_COPY } from './watchlist-copy';

// V1 临时添加自选入口（013 US6 / FR-M07）。mini 搜索调 015 `/search`（typed orval hook）→
// 选中 → POST 加入目标组（默认落「自选」，可选其他非持仓组）。底部 sheet Modal（镜像 mockup
// AddSheet）。搜索 250ms 防抖；015 失败 → ErrorRow（不阻断）。详情入口落地后并存/替换。
// presentational —— 渲染/交互走 Playwright e2e；加自选真落库走 contract-smoke（per sdd.md §V）。

const COPY = WATCHLIST_COPY.add;

export interface AddWatchlistEntryProps {
  visible: boolean;
  onClose: () => void;
  /** 全量分组（取「自选」作默认 target + 渲染可选目标 chips，排除持仓组）。 */
  groups: GroupItem[];
  /** 成功加入后回调（如刷新当前组 / 提示）。 */
  onAdded?: () => void;
}

/** canonical `market:code` → {market, code}（015 词表 cn/hk/us 已对齐，不映射）。 */
function parseSymbol(symbol: string): { market: AddWatchlistItemRequestMarket; code: string } {
  const [market, code] = symbol.split(':');
  return { market: market as AddWatchlistItemRequestMarket, code: code ?? '' };
}

/**
 * 015 type → 副行类型 tag。stock 的类型信息已由板块 badge（沪A/深A，同同花顺）承载，
 * 重复标无意义故留空；仅 etf/index 加 tag 区分（板块 badge 对 ETF 首位兜底不准）。
 * 标的池不含债券 → 无「债」类（同花顺「(债)/其他」对应的源数据我们没有）。
 */
function instrumentTypeLabel(type: string): string {
  if (type === 'etf') return 'ETF';
  if (type === 'index') return '指数';
  return '';
}

export function AddWatchlistEntry({ visible, onClose, groups, onAdded }: AddWatchlistEntryProps) {
  const { addItem, errorToast } = useWatchlistItems(null);

  const watchlistGroup = useMemo(
    () => groups.find((g) => g.systemKind === GroupItemSystemKind.watchlist) ?? groups[0],
    [groups],
  );
  // 可选目标 = 非持仓组（持仓派生只读）。
  const targets = useMemo(
    () => groups.filter((g) => g.systemKind !== GroupItemSystemKind.holdings),
    [groups],
  );

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<InstrumentSearchItem | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);

  // 关闭时复位本地态（下次打开干净）。
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setDebounced('');
      setPicked(null);
      setTargetId(null);
    }
  }, [visible]);

  // 250ms 防抖，避免每键一打 /search。
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useMarketdataControllerSearch(
    { q: debounced },
    { query: { enabled: debounced.length > 0 } },
  );
  const results = search.data?.data.items ?? [];

  const effectiveTarget = targetId ?? watchlistGroup?.id ?? null;

  const submit = async () => {
    if (!picked || !effectiveTarget) return;
    const { market, code } = parseSymbol(picked.symbol);
    if (!code) return;
    try {
      await addItem(effectiveTarget, { market, code });
      onAdded?.();
      onClose();
    } catch {
      // errorToast 已由 hook 设置；保持 sheet 打开让用户重试。
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable onPress={onClose} accessibilityLabel="关闭" className="absolute inset-0" />
        <View className="bg-surface rounded-t-lg overflow-hidden" style={{ height: '78%' }}>
          {/* 标头。 */}
          <View className="flex-row items-center justify-between px-md py-md border-b border-line-soft">
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭">
              <Text className="text-base text-brand-500">取消</Text>
            </Pressable>
            <Text className="text-base font-semibold text-ink">{COPY.title}</Text>
            <View className="w-10" />
          </View>

          {/* 搜索框。 */}
          <View className="px-md py-sm">
            <View className="flex-row items-center gap-sm bg-surface-sunken rounded-md px-md h-10">
              <Text className="text-base text-ink-subtle">⌕</Text>
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder={COPY.searchPlaceholder}
                accessibilityLabel={COPY.title}
                className="flex-1 text-base text-ink"
              />
            </View>
          </View>

          {errorToast ? (
            <View className="px-md pb-sm">
              <ErrorRow text={errorToast} />
            </View>
          ) : null}

          {/* 结果列表。 */}
          <ScrollView className="flex-1">
            {results.length === 0 ? (
              <Text className="text-sm text-ink-subtle text-center px-md py-2xl">
                {debounced ? COPY.noResult : COPY.emptyHint}
              </Text>
            ) : (
              results.map((r) => {
                const on = picked?.symbol === r.symbol;
                const { market, code } = parseSymbol(r.symbol);
                return (
                  <Pressable
                    key={r.symbol}
                    onPress={() => setPicked(r)}
                    accessibilityRole="button"
                    accessibilityLabel={r.name}
                    accessibilityState={{ selected: on }}
                    className={`flex-row items-center px-md py-sm border-b border-line-soft ${
                      on ? 'bg-brand-soft' : ''
                    }`}
                  >
                    <View className="flex-1">
                      <Text className="text-base text-ink">{r.name}</Text>
                      <View className="flex-row items-center gap-xs mt-0.5">
                        <MarketBadge code={code} market={market} />
                        <Text className="text-xs font-mono text-ink-subtle">{code}</Text>
                        {instrumentTypeLabel(r.type) ? (
                          <Text className="text-xs text-ink-subtle border border-line rounded-sm px-xs">
                            {instrumentTypeLabel(r.type)}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    {on ? <Text className="text-base text-brand-500">✓</Text> : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          {/* 目标组选择 + 提交。 */}
          <View className="border-t border-line-soft px-md py-md gap-sm">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row items-center gap-sm">
                <Text className="text-sm text-ink-muted">{COPY.addTo}</Text>
                {targets.map((g) => {
                  const on = effectiveTarget === g.id;
                  return (
                    <Pressable
                      key={g.id}
                      onPress={() => setTargetId(g.id)}
                      accessibilityRole="button"
                      accessibilityLabel={g.name}
                      accessibilityState={{ selected: on }}
                      className={`rounded-full px-md py-xs border ${
                        on ? 'border-brand-500 bg-brand-soft' : 'border-line'
                      }`}
                    >
                      <Text className={`text-sm ${on ? 'text-brand-500' : 'text-ink-muted'}`}>
                        {g.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
            <Pressable
              onPress={() => void submit()}
              disabled={!picked}
              accessibilityRole="button"
              accessibilityLabel={COPY.submit}
              className={`h-12 rounded-full items-center justify-center ${
                picked ? 'bg-brand-500' : 'bg-brand-300'
              }`}
            >
              <Text className="text-base font-medium text-white">{COPY.submit}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
