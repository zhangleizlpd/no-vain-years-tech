// 036 T011 — 单点注记输入行（FR-004 行式布局，mockup 帧④）。
//
// 布局：`[周边小图块] + [编号 badge] + [文字输入] + [麦克风]`。一个 pin 一行，文字键入 → onChangeNote
// 绑该 pin 注记（父屏 dispatch setNote 到 pin-reducer，状态字段已存在）。
//
// 继承决策（task brief）：
//   ① 小图块 = **纯预览缩略**，无勾选语义 → a11y `image`（**非** checkbox/imagebutton，不给勾选 role）。
//   ② 编号 badge 与 pin.n 一致（同源 AnnotationPin 的 n）。
//   ③ crop = **纯 UI 预览**，不进模型 payload（模型只收 SoM 烧录图，T012）。
//   ④ 麦克风本 task 仅**接口位 + 行布局预留**；真接 035 录音转写在 T013（本组件不实现录音逻辑）。
//
// 视觉 0 新 token：复用 ~/theme + ~/ui（IconButton mic 圆框）+ 承 AnnotationPin 编号 badge 体例。
// 测试分层：crop 参数计算纯逻辑 = pin-crop-preview.spec.ts（vitest）；本组件 render·a11y 走 T015 e2e。
import { useEffect, useRef, useState } from 'react';
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native';
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors } from '~/theme';
import { pinCropRect, type ImageNaturalSize } from './pin-crop-preview';

const PREVIEW_SIZE = 44;

export interface AnnotationRowProps {
  /** 标注图 uri（裁切周边小图块的源图 = 原暂存图 localUri）。 */
  uri: string;
  /** 源图自然像素尺寸（算 crop 矩形用；缺省 / 非法 → 跳过 crop 显示整图缩略）。 */
  imageSize: ImageNaturalSize | null;
  /** 该 pin 展示编号（与 AnnotationPin 同源 pin.n）。 */
  n: number;
  /** 归一化锚点（pin.nx/ny；裁切周边小图块用）。 */
  nx: number;
  ny: number;
  /** 当前注记文字（pin.note）。 */
  note: string;
  /** 文字键入 → 写该 pin 注记（父屏 dispatch setNote）。 */
  onChangeNote: (note: string) => void;
  /**
   * 036 T013：选区变化（语音 transcript 经 insert-at-cursor 插入光标处用，FR-005）。父屏仅对
   * **当前 selected** 行透传 setSelection（无焦点 → 末尾追加）。
   */
  onSelectionChange?: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  /** 选中态高亮（与画布 pin 联动）。 */
  selected?: boolean;
  /**
   * 麦克风**接口位**（T013 接 035 录音转写）。本 task 仅预留：传入则可点，缺省则 disabled 灰显。
   * T013 把它接到 use-ideation-recording（录音 → 转写 → insert 落本 pin 注记框）。
   */
  onPressMic?: () => void;
  /** 麦克风 disabled（流式态 / 录音进行中，T013 据 canRecord 传）。 */
  micDisabled?: boolean;
}

export function AnnotationRow({
  uri,
  imageSize,
  n,
  nx,
  ny,
  note,
  onChangeNote,
  onSelectionChange,
  selected = false,
  onPressMic,
  micDisabled = false,
}: AnnotationRowProps) {
  const previewUri = usePinCropPreview(uri, imageSize, nx, ny);

  return (
    <View
      className={`flex-row items-center gap-2 rounded-lg px-2 py-1.5 ${
        selected ? 'bg-brand-soft' : 'bg-surface'
      }`}
      testID={`ideation-annotation-row-${n}`}
    >
      {/* 周边小图块（纯预览缩略，无勾选语义 → a11y image，非 checkbox/imagebutton）。 */}
      <View
        className="rounded-md overflow-hidden bg-surface-sunken"
        style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      >
        <Image
          source={{ uri: previewUri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          accessibilityRole="image"
          accessibilityLabel={`标注 ${n} 周边预览`}
        />
      </View>

      {/* 编号 badge（与 pin.n 一致，承 AnnotationPin 视觉体例）。 */}
      <View
        className="w-6 h-6 rounded-full bg-brand-500 items-center justify-center"
        accessibilityRole="text"
        accessibilityLabel={`标注 ${n}`}
      >
        <Text className="text-xs font-bold text-white">{n}</Text>
      </View>

      {/* 文字输入（键入绑该 pin 注记）。 */}
      <TextInput
        className="flex-1 text-base text-ink"
        value={note}
        onChangeText={onChangeNote}
        onSelectionChange={onSelectionChange}
        placeholder="补充说明这个点…"
        placeholderTextColor={colors.ink.subtle}
        multiline
        textAlignVertical="center"
        accessibilityLabel={`标注 ${n} 文字说明`}
        testID={`ideation-annotation-input-${n}`}
      />

      {/* 麦克风接口位（T013 接录音转写；本 task 仅占位 + 行内预留入口）。 */}
      <Pressable
        onPress={onPressMic}
        disabled={micDisabled || !onPressMic}
        accessibilityRole="button"
        accessibilityLabel="语音输入"
        accessibilityState={{ disabled: micDisabled || !onPressMic }}
        testID={`ideation-annotation-mic-${n}`}
        className="w-9 h-9 rounded-full items-center justify-center"
      >
        <MicIcon disabled={micDisabled || !onPressMic} />
      </Pressable>
    </View>
  );
}

/**
 * 裁出 pin 锚点周边小块（纯 UI 预览）。crop 参数 = pinCropRect（纯函数）；本 hook 是 IO 薄壳
 * （expo-image-manipulator crop，同 use-profile-image-upload manipulate 分层）。crop 失败 / 尺寸
 * 未知 → 退化整图 uri（不抛、不崩，预览缩略仅为辅助辨识）。
 */
function usePinCropPreview(
  uri: string,
  imageSize: ImageNaturalSize | null,
  nx: number,
  ny: number,
): string {
  const [previewUri, setPreviewUri] = useState(uri);
  // 防卸载后 setState：组件可能在 crop async 完成前卸载（取消标注屏）。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!imageSize) {
      setPreviewUri(uri);
      return;
    }
    const rect = pinCropRect(nx, ny, imageSize);
    if (rect.width <= 0 || rect.height <= 0) {
      setPreviewUri(uri); // 非法尺寸兜底：整图。
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const context = ImageManipulator.manipulate(uri);
        context.crop(rect);
        const ref = await context.renderAsync();
        const out = await ref.saveAsync({ format: SaveFormat.WEBP });
        if (!cancelled && aliveRef.current) setPreviewUri(out.uri);
      } catch {
        // crop 失败（格式 / 平台差异）→ 退化整图（预览仅辅助，不阻断注记输入）。
        if (!cancelled && aliveRef.current) setPreviewUri(uri);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri, imageSize, nx, ny]);

  return previewUri;
}

function MicIcon({ disabled }: { disabled: boolean }) {
  const stroke = disabled ? colors.ink.subtle : colors.ink.muted;
  return (
    <Svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <Path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <Path d="M12 18v4" />
    </Svg>
  );
}
