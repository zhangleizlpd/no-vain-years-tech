// 头像 / 主页背景图 编辑编排（009 US3 + US5）。把 action sheet + 选图分叉（native picker /
// web 文件选择 + 裁剪）+ 上传（useProfileImageUpload）+ 查看大图 + 错误/忙态 UI 串成一个钩子。
// 入口（profile.tsx hero / account-security 资料卡行）只 `open()` 开 sheet + 渲染 `overlay`。
import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from 'react-native';

import { colors } from '~/theme';
import { ProfileImageActionSheet, type ActionSheetItem } from './profile-image-action-sheet';
import { CropModal } from './crop-modal';
import { ImageViewer } from './image-viewer';
import {
  mapUploadError,
  processedFromWebBlob,
  useProfileImageUpload,
  validateImageFile,
  type UploadTarget,
} from './use-profile-image-upload';

const LABEL: Record<UploadTarget, string> = { avatar: '头像', background: '主页背景图' };
const ASPECT: Record<UploadTarget, number> = { avatar: 1, background: 16 / 9 };

// web 文件选择：imperative DOM input（RN-web 无 <input> 组件）。隐藏挂 body 供 Playwright
// filechooser / locator 命中；onchange 后即移除。web cancel 不可靠 → 仅靠 onchange resolve。
function pickWebFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    };
    input.click();
  });
}

export interface UseProfileImageEditor {
  open: () => void;
  isUploading: boolean;
  overlay: ReactNode;
}

export function useProfileImageEditor(
  target: UploadTarget,
  currentImageUrl: string | null,
): UseProfileImageEditor {
  const upload = useProfileImageUpload(target);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const open = () => {
    setSelectionError(null);
    upload.clearError();
    setSheetVisible(true);
  };

  const onReplaceWeb = async () => {
    setSheetVisible(false);
    const file = await pickWebFile();
    if (!file) return;
    try {
      // client 先拦非图片 / 超 size（FR-C08，与后端 policy 互为兜底）。
      validateImageFile({ mimeType: file.type, fileSize: file.size }, target);
    } catch (e) {
      setSelectionError(mapUploadError(e));
      return;
    }
    setCropSrc(URL.createObjectURL(file));
  };

  const onPickNative = (source: 'library' | 'camera') => {
    setSheetVisible(false);
    void upload.pickAndUpload(source);
  };

  const closeCrop = () => {
    setCropSrc((src) => {
      if (src) URL.revokeObjectURL(src);
      return null;
    });
  };
  const onCropConfirm = (blob: Blob) => {
    closeCrop();
    void upload.uploadProcessed(processedFromWebBlob(blob));
  };

  const items: ActionSheetItem[] = [];
  if (Platform.OS === 'web') {
    items.push({ label: '更换', onPress: () => void onReplaceWeb() });
  } else {
    items.push({ label: '从相册选择', onPress: () => onPickNative('library') });
    items.push({ label: '拍照', onPress: () => onPickNative('camera') });
  }
  if (currentImageUrl) {
    items.push({
      label: '查看大图',
      onPress: () => {
        setSheetVisible(false);
        setViewerVisible(true);
      },
    });
  }

  const error = selectionError ?? upload.errorToast;
  const clearError = () => {
    setSelectionError(null);
    upload.clearError();
  };

  const overlay = (
    <>
      <ProfileImageActionSheet
        visible={sheetVisible}
        title={`更换${LABEL[target]}`}
        items={items}
        onClose={() => setSheetVisible(false)}
      />
      <CropModal
        visible={cropSrc !== null}
        imageSrc={cropSrc}
        aspect={ASPECT[target]}
        onConfirm={onCropConfirm}
        onCancel={closeCrop}
      />
      <ImageViewer
        visible={viewerVisible}
        uri={currentImageUrl}
        onClose={() => setViewerVisible(false)}
      />
      <UploadErrorModal message={error} onDismiss={clearError} />
      <UploadingOverlay visible={upload.isUploading} />
    </>
  );

  return { open, isUploading: upload.isUploading, overlay };
}

function UploadErrorModal({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  return (
    <Modal visible={message !== null} transparent animationType="fade" onRequestClose={onDismiss}>
      <View className="flex-1 bg-modal-overlay items-center justify-center px-xl">
        <View className="bg-surface rounded-md w-full p-lg gap-md shadow-sheet">
          <Text className="text-base text-ink text-center">{message}</Text>
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="知道了"
            className="bg-brand-500 rounded-md items-center justify-center"
            style={{ height: 44 }}
          >
            <Text className="text-base font-semibold text-surface">知道了</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function UploadingOverlay({ visible }: { visible: boolean }) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View
        className="flex-1 bg-modal-overlay items-center justify-center"
        accessibilityLabel="上传中"
      >
        <View className="bg-surface rounded-md px-xl py-lg items-center gap-sm shadow-sheet">
          <ActivityIndicator size="large" color={colors.brand[500]} />
          <Text className="text-sm text-ink-muted">上传中…</Text>
        </View>
      </View>
    </Modal>
  );
}
