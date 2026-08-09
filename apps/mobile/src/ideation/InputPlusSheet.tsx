// InputPlusSheet — 033 多模态壳 `+` 附件面板（B2-1 US2/US4）。
//
// root RN `Modal`（transparent + slide）bottom-sheet：scrim（onPress 关）+ grabber + 4 入口
// （摄像头 / 图片 / 添加文件 / 选择代码库）。本段**不内嵌实时照片条**（per D1，需
// expo-media-library，defer B2-3）。范式参考 profile-image-action-sheet + BrokerPickerSheet。
//
// 接线：摄像头→captureFromCamera、图片→pickFromLibrary（来自 use-ideation-attachments）；
// 添加文件 = stub `fireToast(comingSoon)`；选择代码库 = 真接线（034，→ onOpenRepoPicker 开
// RepoPickerSheet，FR-004/005/010）。选/拍/选库完关 sheet。
//
// 🚨 RN 布局陷阱（per mobile-impl-playbook）：sheet 卡片用 intrinsic 高度，**禁裸 flex-1**
// （只 scrim 占满上方空白吸点关）；`rounded-full` 非 `rounded-[50%]`。
import { Modal, Pressable, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { colors } from '~/theme';
import { IDEATION_COPY } from './ideation-copy';

export interface InputPlusSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 图片入口 → 系统相册 picker（多选）。 */
  onPickImage: () => void;
  /** 摄像头入口 → 拍照。 */
  onCaptureCamera: () => void;
  /** 034 选择代码库入口 → 关本 sheet 并开 RepoPickerSheet（接地目标仓选择）。 */
  onOpenRepoPicker: () => void;
  /** stub 入口（添加文件）→ comingSoon toast。 */
  fireToast: (msg: string) => void;
}

export function InputPlusSheet({
  visible,
  onClose,
  onPickImage,
  onCaptureCamera,
  onOpenRepoPicker,
  fireToast,
}: InputPlusSheetProps) {
  // 功能性入口：执行后关闭 sheet（让带回的缩略图露出）。
  const handleCamera = () => {
    onClose();
    onCaptureCamera();
  };
  const handleImage = () => {
    onClose();
    onPickImage();
  };
  // 选择代码库：关本 sheet 再开 RepoPickerSheet（避免两 Modal 叠加）。
  const handleRepo = () => {
    onClose();
    onOpenRepoPicker();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-modal-overlay justify-end">
        {/* scrim：占满 sheet 之上空白，吸点关闭。 */}
        <Pressable
          onPress={onClose}
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel={IDEATION_COPY.overlayBackdrop}
        />

        {/* sheet 卡片（intrinsic 高度，禁裸 flex-1）。 */}
        <View
          className="bg-surface rounded-t-2xl px-md pt-sm pb-8 shadow-sheet"
          testID="ideation-plus-sheet"
        >
          {/* grabber */}
          <View className="items-center pb-sm">
            <View className="rounded-full bg-line-strong" style={{ width: 38, height: 5 }} />
          </View>

          <SheetRow
            label="摄像头"
            icon={<CameraIcon />}
            onPress={handleCamera}
            testID="ideation-sheet-camera"
          />
          <SheetRow
            label="图片"
            icon={<ImageIcon />}
            onPress={handleImage}
            testID="ideation-sheet-image"
          />
          <SheetRow
            label="添加文件"
            icon={<FileIcon />}
            onPress={() => fireToast(IDEATION_COPY.comingSoon)}
            testID="ideation-sheet-file"
          />
          <SheetRow
            label="选择代码库"
            icon={<RepoIcon />}
            onPress={handleRepo}
            testID="ideation-sheet-repo"
          />
        </View>
      </View>
    </Modal>
  );
}

function SheetRow({
  label,
  icon,
  onPress,
  testID,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      className="flex-row items-center gap-md py-3.5"
    >
      <View className="w-10 h-10 rounded-full bg-surface-sunken items-center justify-center">
        {icon}
      </View>
      <Text className="text-base text-ink">{label}</Text>
    </Pressable>
  );
}

// ─────────────────────────────── icons（屏内一次性，承 027/ClarifyChatScreen 范式） ───────────────────────────────

function CameraIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z" />
      <Path d="M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
    </Svg>
  );
}

function ImageIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={3} y={3} width={18} height={18} rx={2} />
      <Path d="M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <Path d="m21 15-5-5L5 21" />
    </Svg>
  );
}

function FileIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <Path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    </Svg>
  );
}

function RepoIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="m16 18 4-4-4-4" />
      <Path d="m8 6-4 4 4 4" />
      <Path d="m13 4-2 16" />
    </Svg>
  );
}
