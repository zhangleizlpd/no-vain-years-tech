import { Modal, Pressable, Text, View } from 'react-native';
import { Spinner } from './Spinner';

// 居中二次确认对话框（012 US6 删除确认）。RN Modal portal + 半透明 scrim（点击 = 取消，
// busy 时锁定）；确认按钮 err 强调（镜像 ~/settings/login-management/RemoveDeviceSheet
// 删除按钮体例）。受控（visible + 回调），presentational 无单测 —— 走 Playwright e2e。

export interface ConfirmModalProps {
  visible: boolean;
  title: string;
  /** 可选副文案（如「{券商} · {脱敏客户号} 删除后持仓归属将解除关联」）。 */
  message?: string;
  cancelLabel: string;
  confirmLabel: string;
  /** 确认动作 in-flight：锁取消 + 删除按钮转 spinner。 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  visible,
  title,
  message,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 bg-modal-overlay items-center justify-center px-xl">
        <Pressable
          onPress={busy ? undefined : onCancel}
          accessibilityLabel="关闭"
          className="absolute inset-0"
        />
        <View
          className="bg-surface rounded-lg px-lg pt-lg pb-md shadow-modal"
          style={{ width: '100%', maxWidth: 300 }}
        >
          <Text className="text-base font-semibold text-ink text-center">{title}</Text>
          {message ? (
            <Text className="text-sm text-ink-muted text-center mt-sm" style={{ lineHeight: 21 }}>
              {message}
            </Text>
          ) : null}
          <View className="flex-row gap-sm mt-lg">
            <Pressable
              onPress={busy ? undefined : onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
              className="flex-1 bg-surface border border-line-strong rounded-md items-center justify-center"
              style={{ height: 44, opacity: busy ? 0.5 : 1 }}
            >
              <Text className="text-base font-medium text-ink">{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              className="flex-1 bg-err rounded-md items-center justify-center shadow-cta-err"
              style={{ height: 44 }}
            >
              {busy ? (
                <Spinner size={15} tone="white" />
              ) : (
                <Text className="text-base font-semibold text-surface">{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
