// Web 裁剪 modal（009 US3，web-only）。react-easy-crop 自由裁剪 → canvas 导出 webp Blob →
// onConfirm。native 永不渲染本文件（Metro 平台解析取 crop-modal.tsx stub）。
//
// 注：react-easy-crop 是 react-dom 组件，渲染进 react-native-web 树（底层同 react-dom）可用；
// 裁剪区放在 position:relative 定高容器里，Cropper 绝对填充。
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import Cropper, { type Area, type Point } from 'react-easy-crop';

import { colors } from '~/theme';
import type { CropModalProps } from './crop-modal';

const WEBP_COMPRESS = 0.8;
const CROP_AREA_HEIGHT = 320;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// 把裁剪区（natural-pixel 坐标）画进 canvas → webp Blob。
async function cropToWebpBlob(imageSrc: string, area: Area): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width));
  canvas.height = Math.max(1, Math.round(area.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob returned null'))),
      'image/webp',
      WEBP_COMPRESS,
    );
  });
}

export function CropModal({ visible, imageSrc, aspect, onConfirm, onCancel }: CropModalProps) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    if (!imageSrc || !areaPixels || busy) return;
    setBusy(true);
    try {
      const blob = await cropToWebpBlob(imageSrc, areaPixels);
      onConfirm(blob);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 bg-modal-overlay justify-center px-md">
        <View className="bg-surface rounded-md overflow-hidden shadow-sheet">
          <View className="items-center py-sm border-b border-line-soft">
            <Text className="text-base font-semibold text-ink">裁剪</Text>
          </View>

          {/* 裁剪区：relative 定高容器，Cropper 绝对填充 */}
          <View style={{ position: 'relative', width: '100%', height: CROP_AREA_HEIGHT }}>
            {imageSrc ? (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_area, pixels) => setAreaPixels(pixels)}
              />
            ) : null}
          </View>

          {/* 取消 / 确认 */}
          <View className="flex-row gap-sm p-md">
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="取消"
              className="flex-1 bg-surface border border-line-strong rounded-md items-center justify-center"
              style={{ height: 48, opacity: busy ? 0.5 : 1 }}
            >
              <Text className="text-base font-medium text-ink">取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void handleConfirm()}
              disabled={busy || !areaPixels}
              accessibilityRole="button"
              accessibilityLabel="确认"
              className="flex-1 bg-brand-500 rounded-md items-center justify-center"
              style={{ height: 48, opacity: busy || !areaPixels ? 0.6 : 1 }}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.surface.DEFAULT} />
              ) : (
                <Text className="text-base font-semibold text-surface">确认</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
