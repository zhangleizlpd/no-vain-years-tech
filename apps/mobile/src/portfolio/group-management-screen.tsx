import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { GroupItemType, type GroupItem } from '@nvy/api-client';

import { Button, ConfirmModal, DraggableList, ErrorRow, Spinner } from '~/ui';
import {
  reorderEntriesAfterMove,
  reorderEntriesWithVisibilityToggled,
} from './group-management.helpers';
import { useWatchlistGroups } from './use-watchlist-groups';
import { WATCHLIST_COPY } from './watchlist-copy';

// 屏3 分组管理（013 US5 / FR-M05·FR-M06）。标题「全部分组」+ 右上「新建分组」；DraggableList
// 拖拽排序（→ 主列表 Tab 顺序）+ 每组 👁 隐藏切换 + 标的数；系统组仅隐藏+拖拽，自定义组加
// 重命名(⋯)+删除。删非空自定义组 → 服务端把 item 回落「自选」（FR-S02），删前 ConfirmModal 二确。
// DraggableList 依赖手势根 → 套 GestureHandlerRootView（根 _layout 不全局挂，镜像 broker 屏）。
// presentational —— 渲染/拖拽走 Playwright e2e；reorder 折算纯函数走 vitest（per mono 测试分层）。

const COPY = WATCHLIST_COPY.groups;
const ROW_HEIGHT = 56;

export function GroupManagementScreen() {
  const {
    groups,
    status,
    createGroup,
    renameGroup,
    deleteGroup,
    reorderGroups,
    errorToast,
    refetch,
  } = useWatchlistGroups();

  // null = 不在新建；'' / 文本 = 新建输入中。
  const [newName, setNewName] = useState<string | null>(null);
  // 行内重命名中的组 + 文本。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // ⋯ 动作面板打开的组（custom）。
  const [menuGroup, setMenuGroup] = useState<GroupItem | null>(null);
  // 待二次确认删除的组。
  const [pendingDelete, setPendingDelete] = useState<GroupItem | null>(null);

  const newButton = (
    <Pressable
      onPress={() => {
        setNewName('');
        setRenamingId(null);
      }}
      accessibilityRole="button"
      accessibilityLabel={COPY.create}
    >
      <Text className="text-base text-brand-500 px-md">{COPY.create}</Text>
    </Pressable>
  );

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface-sunken">
        <Stack.Screen options={{ headerRight: () => newButton }} />
        <Spinner />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface-sunken px-md">
        <Stack.Screen options={{ headerRight: () => newButton }} />
        <Text className="text-base text-ink-muted">{WATCHLIST_COPY.main.load.error}</Text>
        <Button label={WATCHLIST_COPY.main.load.retry} onPress={() => void refetch()} />
      </View>
    );
  }

  const commitNew = () => {
    const name = (newName ?? '').trim();
    if (!name) return;
    setNewName(null);
    void createGroup(name);
  };

  const commitRename = (id: string) => {
    const name = renameText.trim();
    setRenamingId(null);
    if (name) void renameGroup(id, name);
  };

  const toggleHide = (id: string) =>
    void reorderGroups(reorderEntriesWithVisibilityToggled(groups, id));

  const onReorder = (from: number, to: number) =>
    void reorderGroups(reorderEntriesAfterMove(groups, from, to));

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    void deleteGroup(id);
  };

  const renderRow = (g: GroupItem) => {
    const isSystem = g.type === GroupItemType.system;
    const renaming = renamingId === g.id;
    return (
      <View
        className="flex-row items-center gap-sm px-md bg-surface border-b border-line-soft"
        style={{ height: ROW_HEIGHT }}
      >
        <View className="flex-1 min-w-0">
          {renaming ? (
            <View className="flex-row items-center gap-sm">
              <TextInput
                autoFocus
                value={renameText}
                onChangeText={setRenameText}
                placeholder={COPY.namePlaceholder}
                onSubmitEditing={() => commitRename(g.id)}
                accessibilityLabel={COPY.rename}
                className="flex-1 text-base text-ink"
              />
              <Pressable
                onPress={() => commitRename(g.id)}
                accessibilityRole="button"
                accessibilityLabel={COPY.confirm}
              >
                <Text className="text-sm text-brand-500">{COPY.confirm}</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View className="flex-row items-center gap-sm">
                <Text className="text-base text-ink" numberOfLines={1}>
                  {g.name}
                </Text>
                {isSystem ? (
                  <Text className="text-xs text-ink-muted bg-surface-sunken rounded-sm px-xs">
                    {COPY.systemBadge}
                  </Text>
                ) : null}
              </View>
              <Text className="text-xs text-ink-subtle mt-0.5">
                {g.itemCount} {COPY.countSuffix}
                {g.visible ? '' : ` · ${COPY.hidden}`}
              </Text>
            </>
          )}
        </View>

        {!isSystem && !renaming ? (
          <Pressable
            onPress={() => setMenuGroup(g)}
            accessibilityRole="button"
            accessibilityLabel={COPY.moreActions}
            className="w-8 h-8 items-center justify-center"
          >
            <Text className="text-lg text-ink-subtle">⋯</Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={() => toggleHide(g.id)}
          accessibilityRole="button"
          accessibilityLabel={g.visible ? COPY.hideLabel : COPY.showLabel}
          accessibilityState={{ selected: g.visible }}
          className="w-8 h-8 items-center justify-center"
        >
          <Text className={`text-base ${g.visible ? 'text-ink-muted' : 'text-ink-subtle'}`}>
            {g.visible ? '👁' : '⊘'}
          </Text>
        </Pressable>

        <View accessibilityLabel={COPY.dragHandle} className="w-7 h-8 items-center justify-center">
          <Text className="text-base text-line-strong">☰</Text>
        </View>
      </View>
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerRight: () => newButton }} />
      <ScrollView className="flex-1 bg-surface-sunken" contentContainerClassName="pt-sm pb-xl">
        {errorToast ? (
          <View className="px-md pb-sm">
            <ErrorRow text={errorToast} />
          </View>
        ) : null}

        {newName != null ? (
          <View
            className="flex-row items-center gap-sm px-md bg-surface border-b border-line-soft"
            style={{ height: ROW_HEIGHT }}
          >
            <TextInput
              autoFocus
              value={newName}
              onChangeText={setNewName}
              placeholder={COPY.namePlaceholder}
              onSubmitEditing={commitNew}
              accessibilityLabel={COPY.create}
              className="flex-1 text-base text-ink"
            />
            <Pressable
              onPress={commitNew}
              disabled={!newName.trim()}
              accessibilityRole="button"
              accessibilityLabel={COPY.confirm}
            >
              <Text className={`text-sm ${newName.trim() ? 'text-brand-500' : 'text-ink-subtle'}`}>
                {COPY.confirm}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <DraggableList
          data={groups}
          keyExtractor={(g) => g.id}
          renderItem={renderRow}
          onReorder={onReorder}
          rowHeight={ROW_HEIGHT}
        />

        <Text className="text-xs text-ink-subtle leading-relaxed px-lg pt-md">{COPY.footnote}</Text>
      </ScrollView>

      {/* ⋯ 自定义组动作面板（重命名 / 删除）。 */}
      <Modal
        visible={menuGroup != null}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuGroup(null)}
      >
        <View className="flex-1 justify-end bg-modal-overlay">
          <Pressable
            onPress={() => setMenuGroup(null)}
            accessibilityLabel="关闭"
            className="absolute inset-0"
          />
          <View className="bg-surface rounded-t-lg pb-lg">
            <Pressable
              onPress={() => {
                if (!menuGroup) return;
                setRenameText(menuGroup.name);
                setRenamingId(menuGroup.id);
                setMenuGroup(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={COPY.rename}
              className="px-lg py-md border-b border-line-soft"
            >
              <Text className="text-base text-ink">{COPY.rename}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setPendingDelete(menuGroup);
                setMenuGroup(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={COPY.deleteGroup}
              className="px-lg py-md"
            >
              <Text className="text-base text-err">{COPY.deleteGroup}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ConfirmModal
        visible={pendingDelete !== null}
        title={COPY.deleteGroup}
        message={pendingDelete ? pendingDelete.name : undefined}
        cancelLabel="取消"
        confirmLabel={COPY.deleteGroup}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </GestureHandlerRootView>
  );
}
