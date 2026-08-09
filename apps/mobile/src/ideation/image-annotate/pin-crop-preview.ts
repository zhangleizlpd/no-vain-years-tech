// 036 T011 — pin 周边裁切预览参数计算（纯函数，无 IO，vitest=logic）。
//
// 注记输入行左侧的「周边小图块」= 以 pin 锚点为中心、从原图裁出的一小块（让用户确认这个编号
// 标在图上哪儿）。本文件只算 expo-image-manipulator `crop` 所需的像素矩形（纯计算）；真正调
// manipulator crop 的 IO 在 AnnotationRow 组件薄壳（同 use-profile-image-upload 的 manipulate
// 分层）。
//
// 🚨 crop 是**纯 UI 预览**——绝不进模型 payload（模型只收 SoM 烧录图，T012 som-flatten）。
//
// 坐标系：pin nx/ny 锚**图片内容归一化坐标**（0..1，pin-reducer 同源）；crop 矩形锚**原图像素
// 坐标**（manipulator crop 要 originX/originY/width/height 像素）。窗口边长 = 短边的固定比例
// （正方形小块，行高内等比缩放显示），clamp 到图片边界不越界。复杂度 O(1)。

/** crop 窗口边长占图片短边的比例（锚点周边一小块，预览够辨识即可）。 */
export const CROP_WINDOW_FRACTION = 0.28;

/** 图片自然像素尺寸（来自 expo-image onLoad / asset 元数据）。 */
export interface ImageNaturalSize {
  width: number;
  height: number;
}

/** expo-image-manipulator `crop` 入参矩形（像素坐标，整数）。 */
export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * 计算 pin 锚点周边的 crop 矩形（原图像素坐标）。
 *
 * - 边长 = `CROP_WINDOW_FRACTION × min(width,height)`，再 clamp 不超图片任一边（极小图退化整图）。
 * - 中心 = 归一化锚点投到像素（nx×W, ny×H），origin = 中心 − 半边，clamp 使 [origin, origin+边长]
 *   落在 [0, 尺寸] 内（角落锚点贴边不越界）。
 * - 非法尺寸（≤0）→ 零矩形兜底（调用方据 width===0 跳过 crop，不抛、不产 NaN）。
 */
export function pinCropRect(nx: number, ny: number, image: ImageNaturalSize): CropRect {
  const { width: W, height: H } = image;
  if (!(W > 0) || !(H > 0)) return { originX: 0, originY: 0, width: 0, height: 0 };

  const shortSide = Math.min(W, H);
  // 边长不超图片任一边（极小图：fraction×短边可能仍 < 短边，但乘子 < 1 时不会溢出；保险 clamp）。
  const side = Math.min(Math.round(CROP_WINDOW_FRACTION * shortSide), W, H);

  const cx = clamp01(nx) * W;
  const cy = clamp01(ny) * H;
  const half = side / 2;

  // origin clamp 到 [0, 尺寸-边长]，保证矩形完全落在图内。
  const originX = clampRange(Math.round(cx - half), 0, W - side);
  const originY = clampRange(Math.round(cy - half), 0, H - side);

  return { originX, originY, width: side, height: side };
}

function clampRange(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
