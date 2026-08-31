import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ErrorRow, Spinner } from '~/ui';
import { AnchorSubmissionRow } from './anchor-submission-row';
import { useAnchorSubmissions } from './use-anchor-submissions';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskAnchorSubmissionRoute } from './optionsdesk-routes';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

/**
 * 072 T018 — 「我的」审批栏的内嵌面板（mockup 帧 ①）。
 *
 * 🚨 **不自带纵向滚动器**：宿主是 profile 那个 `stickyHeaderIndices` 的父 ScrollView，
 * 嵌套纵向滚动器会同时毁掉两边的滚动手感（同 `AlertMessagePanel` 的纪律）。
 * 截断到 `limit` 条，其余走「查看全部」进全屏列表。
 */
export interface AnchorSubmissionPanelProps {
  /** 内嵌宿主的截断条数。 */
  limit: number;
  /** 「查看全部」→ 全屏待审列表。路由由宿主屏给，本组件不认路由。 */
  onSeeAll: () => void;
}

export function AnchorSubmissionPanel({ limit, onSeeAll }: AnchorSubmissionPanelProps) {
  const router = useRouter();
  const { items, total, status, refetch } = useAnchorSubmissions();

  return (
    <View className="pb-md" testID="optionsdesk-submission-panel">
      <View className="flex-row items-center justify-between px-md pt-md">
        <View className="flex-row items-baseline gap-xs">
          <Text className="text-base font-semibold text-ink">{COPY.panelTitle}</Text>
          {status === 'ready' ? (
            <Text className="text-sm text-ink-muted" testID="optionsdesk-submission-panel-count">
              {total}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onSeeAll}
          accessibilityRole="button"
          accessibilityLabel={COPY.seeAll}
          testID="optionsdesk-submission-see-all"
        >
          <Text className="text-sm text-ink-muted">{`${COPY.seeAll} ›`}</Text>
        </Pressable>
      </View>

      {status === 'loading' ? (
        <View className="items-center justify-center py-2xl">
          <Spinner size={16} tone="muted" />
        </View>
      ) : status === 'error' ? (
        <View className="px-md pt-md">
          <ErrorRow text={COPY.loadFailed} />
          <Pressable onPress={refetch} accessibilityRole="button" accessibilityLabel={COPY.retry}>
            <Text className="pt-sm text-sm text-brand-500">{COPY.retry}</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View className="items-center gap-xs px-xl py-2xl">
          <Text className="text-sm font-semibold text-ink" testID="optionsdesk-submission-empty">
            {COPY.emptyTitle}
          </Text>
          <Text className="text-xs text-ink-muted text-center">{COPY.emptyHint}</Text>
        </View>
      ) : (
        <View className="px-md pt-sm gap-sm">
          {items.slice(0, limit).map((item) => (
            <AnchorSubmissionRow
              key={item.id}
              item={item}
              onPress={() => router.push(optionsdeskAnchorSubmissionRoute(item.id))}
            />
          ))}
        </View>
      )}
    </View>
  );
}
