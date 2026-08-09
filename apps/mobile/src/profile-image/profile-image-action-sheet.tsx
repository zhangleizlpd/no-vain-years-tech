// 头像 / 主页背景图 操作 action sheet（009 US3 FR-C01）。iOS-style 底部卡：选项卡 + 取消卡。
// 跨端用 RN Modal（镜像 RemoveDeviceSheet 范式，不引组件库）。选项由 caller 按 Platform 组装
// （web 仅「更换」；native「从相册选择 / 拍照」）+ 条件「查看大图」+ 取消。
import { Modal, Pressable, Text, View } from 'react-native';

export interface ActionSheetItem {
  label: string;
  onPress: () => void;
  tone?: 'default' | 'muted';
}

interface ProfileImageActionSheetProps {
  visible: boolean;
  title: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

export function ProfileImageActionSheet({
  visible,
  title,
  items,
  onClose,
}: ProfileImageActionSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-modal-overlay justify-end px-md pb-md">
        <Pressable onPress={onClose} className="flex-1" accessibilityLabel="关闭" />

        {/* 选项卡 */}
        <View className="bg-surface rounded-md overflow-hidden shadow-sheet">
          <View className="items-center py-sm border-b border-line-soft">
            <Text className="text-xs text-ink-muted">{title}</Text>
          </View>
          {items.map((item, i) => (
            <View key={item.label}>
              {i > 0 ? <View className="h-px bg-line-soft" /> : null}
              <Pressable
                onPress={item.onPress}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                className="items-center justify-center"
                style={{ height: 52 }}
              >
                <Text
                  className={
                    item.tone === 'muted'
                      ? 'text-base text-ink-muted'
                      : 'text-base font-medium text-ink'
                  }
                >
                  {item.label}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>

        {/* 取消卡 */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="取消"
          className="bg-surface rounded-md items-center justify-center mt-sm shadow-sheet"
          style={{ height: 52 }}
        >
          <Text className="text-base font-semibold text-ink">取消</Text>
        </Pressable>
        <View style={{ height: 8 }} />
      </View>
    </Modal>
  );
}
