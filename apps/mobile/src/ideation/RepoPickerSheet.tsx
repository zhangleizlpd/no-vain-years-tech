// 034 T009 — 选择代码库 bottom-sheet（翻面 A/A2）。root RN Modal slide 弹层：拉 catalog
// （useSessionControllerRepos）→ repo 列表（名 + 状态点 ready/indexing + meta 行）；选中调
// set-repo（父 onSelectRepo）写 idea_session.repo + 会话态。
//
// 4 态（per nativewind-mapping § 状态机）：loading / error（可重试，FR-010）/ empty（无 ready
// repo，A2）/ list。indexing 行置灰不可选（FR-005）。selectedRepo 行 brand 高亮 + ✓。
// 视觉 0 新 token：复用 ~/theme + ~/ui（Spinner）；状态点 / 置灰用既有 token（bg-ok / bg-warn）。
//
// presentational + RQ 编排，无纯逻辑 → 列表渲染 / 选中 / 空态 / 错误重试走 T012 Playwright e2e
// （per 测试分层）；状态映射 / meta 行纯逻辑在 repo-catalog.rules.ts（vitest 覆盖）。
//
// 🚨 RN 布局（per mobile-impl-playbook「无确定高度父容器内禁裸 flex-1」）：sheet 卡片是
// maxHeight 内容撑高（非确定高度），故列表 ScrollView **不能**用裸 flex-1（flexBasis:0 在
// 内容撑高父内塌缩成 0 高 → 行被裁出视口不可点；实测真机 sheet 只剩标题）。改用按窗口高算的
// 显式像素 maxHeight 约束 ScrollView frame（内容少则撑小、多则在该高度内滚动）。
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { useSessionControllerRepos } from '@nvy/api-client';

import { Spinner } from '~/ui';
import { IDEATION_COPY } from './ideation-copy';
import { REPO_STATUS_META, buildRepoMetaLine, type RepoCatalogEntry } from './repo-catalog.rules';

export interface RepoPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 当前会话已锁定的 repo（高亮 + ✓；null = 未选）。 */
  selectedRepo: string | null;
  /** 选中一个 ready repo → 父写会话态（set-repo PATCH）。失败由父 toast。 */
  onSelectRepo: (repo: string) => void;
}

export function RepoPickerSheet({
  visible,
  onClose,
  selectedRepo,
  onSelectRepo,
}: RepoPickerSheetProps) {
  // catalog query：sheet 打开才 enabled（避免后台无谓拉取）。
  const catalogQuery = useSessionControllerRepos({ query: { enabled: visible } });
  const items = catalogQuery.data?.data.items ?? [];

  const handleSelect = (entry: RepoCatalogEntry) => {
    if (!REPO_STATUS_META[entry.status].selectable) return; // indexing 置灰不可选。
    onClose();
    onSelectRepo(entry.repo);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-modal-overlay justify-end">
        <Pressable
          onPress={onClose}
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel={IDEATION_COPY.overlayBackdrop}
        />

        <View
          className="bg-surface rounded-t-2xl px-md pt-sm pb-8 shadow-sheet"
          style={{ maxHeight: '72%' }}
          testID="ideation-repo-sheet"
        >
          <View className="items-center pb-sm">
            <View className="rounded-full bg-line-strong" style={{ width: 38, height: 5 }} />
          </View>

          <Text className="text-base font-semibold text-ink">{IDEATION_COPY.repoPickerTitle}</Text>
          <Text className="text-xs text-ink-subtle pt-1 pb-sm">
            {IDEATION_COPY.repoPickerSubtitle}
          </Text>

          <RepoSheetBody
            isLoading={catalogQuery.isLoading}
            isError={catalogQuery.isError}
            items={items}
            selectedRepo={selectedRepo}
            onRetry={() => void catalogQuery.refetch()}
            onSelect={handleSelect}
          />
        </View>
      </View>
    </Modal>
  );
}

/** 4 态分发（loading / error / empty / list）。empty = 无任何 catalog 项（含全 indexing）。 */
function RepoSheetBody({
  isLoading,
  isError,
  items,
  selectedRepo,
  onRetry,
  onSelect,
}: {
  isLoading: boolean;
  isError: boolean;
  items: RepoCatalogEntry[];
  selectedRepo: string | null;
  onRetry: () => void;
  onSelect: (entry: RepoCatalogEntry) => void;
}) {
  // 列表区显式 frame 上限（内容撑高的 sheet 卡片内裸 flex-1 会塌缩，见文件头注释）：
  // 按窗口高取 ~55%，少则内容撑小、多则滚动；ScrollView 有界像素高度才能滚 overflow。
  const { height } = useWindowDimensions();
  const listMaxHeight = Math.round(height * 0.55);

  if (isLoading) {
    return (
      <View className="items-center py-8 gap-sm" testID="ideation-repo-loading">
        <Spinner size={20} tone="brand" />
        <Text className="text-sm text-ink-subtle">{IDEATION_COPY.repoPickerLoading}</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View className="items-center py-8 gap-sm" testID="ideation-repo-error">
        <Text className="text-sm text-ink-muted">{IDEATION_COPY.repoPickerLoadError}</Text>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={IDEATION_COPY.repoPickerRetry}
          className="bg-surface border border-line rounded-full px-md py-1.5"
          testID="ideation-repo-retry"
        >
          <Text className="text-sm font-medium text-brand-600">
            {IDEATION_COPY.repoPickerRetry}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View className="items-center py-8 gap-1" testID="ideation-repo-empty">
        <Text className="text-base font-medium text-ink">{IDEATION_COPY.repoPickerEmpty}</Text>
        <Text className="text-sm text-ink-subtle">{IDEATION_COPY.repoPickerEmptyHint}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ maxHeight: listMaxHeight }} testID="ideation-repo-list">
      {items.map((entry) => (
        <RepoRow
          key={entry.repo}
          entry={entry}
          selected={entry.repo === selectedRepo}
          onPress={() => onSelect(entry)}
        />
      ))}
    </ScrollView>
  );
}

/** 单 repo 行：状态点 + 名 + meta（相对索引时间 / chunk 数）；selected 高亮 + ✓；indexing 置灰。 */
function RepoRow({
  entry,
  selected,
  onPress,
}: {
  entry: RepoCatalogEntry;
  selected: boolean;
  onPress: () => void;
}) {
  const meta = REPO_STATUS_META[entry.status];
  const rowCls = selected
    ? 'bg-brand-soft border border-brand-500'
    : 'bg-surface border border-line';

  return (
    <Pressable
      onPress={onPress}
      disabled={!meta.selectable}
      accessibilityRole="button"
      accessibilityLabel={`${entry.repo}，${meta.label}`}
      accessibilityState={{ disabled: !meta.selectable, selected }}
      className={`flex-row items-center gap-md rounded-md px-md py-3 mb-2 ${rowCls}`}
      style={{ opacity: meta.selectable ? 1 : 0.45 }}
      testID="ideation-repo-row"
    >
      <View className={`w-2 h-2 rounded-full ${meta.dotClass}`} />
      <View className="flex-1">
        <Text className="text-base text-ink" numberOfLines={1}>
          {entry.repo}
        </Text>
        <Text className="text-xs text-ink-subtle pt-0.5">
          {buildRepoMetaLine(entry, new Date())}
        </Text>
      </View>
      {selected ? <Text className="text-base text-brand-600">✓</Text> : null}
    </Pressable>
  );
}
