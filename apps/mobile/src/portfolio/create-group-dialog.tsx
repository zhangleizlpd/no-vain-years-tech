import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';

import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 居中新建分组弹框（014 US6 / FR-M08，T013，port mockup NewGroupModal）。薄壳：组名 TextInput +
// 字符计数 + 取消/确定。**复用 013 useWatchlistGroups().createGroup**（由 onCreate 注入，D11 不重构
// 013 内联建组行）。无颜色 / 无快速建组 / 无分享。建后由调用方刷新组列 → 新组现于编辑分组 sheet 可勾。
// presentational —— 渲染/交互走 Playwright e2e（per mono 测试分层）。

const COPY = STOCK_DETAIL_COPY.editGroups.create;
const NAME_MAX = 40; // 与 mockup 一致；组名上限。

export interface CreateGroupDialogProps {
  visible: boolean;
  onClose: () => void;
  /** 复用 013 createGroup（async）；调用方建后刷新组列。 */
  onCreate: (name: string) => Promise<void> | void;
}

export function CreateGroupDialog({ visible, onClose, onCreate }: CreateGroupDialogProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // 每次打开复位（下次干净）。
  useEffect(() => {
    if (visible) {
      setName('');
      setBusy(false);
    }
  }, [visible]);

  const len = [...name].length; // code-point 计数（中文/emoji 准确）。
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onCreate(trimmed);
      onClose();
    } catch {
      setBusy(false); // 失败留弹框让用户重试（errorToast 由 hook 在 sheet 层展示）。
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-modal-overlay px-xl">
        <Pressable
          onPress={onClose}
          accessibilityLabel={COPY.cancel}
          className="absolute inset-0"
        />
        <View className="w-full max-w-xs bg-surface rounded-lg px-lg py-lg shadow-modal">
          <Text className="text-base font-semibold text-ink text-center">{COPY.title}</Text>
          <Text className="text-xs text-ink-subtle text-center mt-1 mb-md">{COPY.sub}</Text>

          <View className="bg-surface-alt border border-line rounded-md px-md">
            <TextInput
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChangeText={setName}
              placeholder={COPY.placeholder}
              accessibilityLabel={COPY.title}
              className="text-base text-ink py-md"
            />
          </View>
          <Text className="text-xs text-ink-subtle text-right mt-1 mb-md">
            {len}/{NAME_MAX}
          </Text>

          <View className="flex-row gap-sm">
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={COPY.cancel}
              className="flex-1 h-11 rounded-md bg-surface-sunken items-center justify-center"
            >
              <Text className="text-base font-medium text-ink">{COPY.cancel}</Text>
            </Pressable>
            <Pressable
              onPress={() => void submit()}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={COPY.confirm}
              accessibilityState={{ disabled: !canSubmit }}
              className={`flex-1 h-11 rounded-md items-center justify-center ${
                canSubmit ? 'bg-brand-500' : 'bg-brand-300'
              }`}
            >
              <Text className="text-base font-semibold text-white">{COPY.confirm}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
