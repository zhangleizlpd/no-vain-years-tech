// 036 T010 — 标注 pin 纯 reducer + 屏↔图坐标映射（无 IO、无副作用，vitest=logic）。
//
// 设计（同 ideation-reducer / market-badge.rules 分层）：副作用（手势驱动 reanimated 共享值、
// captureRef 烧录）在 ImageAnnotateCanvas 薄壳；本文件只做 (state, action) → state 纯转换 +
// 坐标换算纯函数。pin 坐标锚**图片内容坐标**（归一化 0..1），缩放/平移后位置稳定（FR-003）——
// 屏幕坐标随手势变换浮动，归一化图坐标不变；overlay 在 UI 线程 worklet 内按同一仿射逐帧投影。
//
// 软上限 9（FR-003）：达上限 add 返回**同一引用**（reducer 不变 → 调用方据此判定「已达上限」
// 给轻提示，不硬阻断流程）。编号递增且**不复用**已删编号（删 #2 后再 add → #(maxN+1)，
// 与 SoM 合成文字编号 1:1 对齐预期：编号是稳定标识，不因删除回填，避免 server 烧录图与
// annotationText 编号错位）。

/** 单个标注 pin。坐标为**图片内容归一化坐标**（0..1，缩放/平移后稳定）。 */
export interface AnnotationPin {
  /** 进程内唯一 id（递增计数，vitest 可控）。 */
  id: string;
  /** 展示编号（递增，不复用已删编号，与 SoM 合成文字 1:1）。 */
  n: number;
  /** 归一化图坐标 x（0..1，0=左边 1=右边）。 */
  nx: number;
  /** 归一化图坐标 y（0..1，0=顶 1=底）。 */
  ny: number;
  /** 该 pin 的文字注记（T011 注记行写入；空串 = 无注记，SoM 烧录时丢弃，FR-006）。 */
  note: string;
}

export interface PinState {
  pins: AnnotationPin[];
  /** 下一个 pin 的 id 序号（单调递增，删除不回退）。 */
  nextId: number;
  /** 下一个 pin 的展示编号（单调递增，删除不回退 → 编号不复用）。 */
  nextN: number;
}

/** 软上限：超过此值 add 无效（达上限给轻提示，不再新增，FR-003）。 */
export const PIN_SOFT_CAP = 9;

export const initialPinState: PinState = { pins: [], nextId: 0, nextN: 1 };

export type PinAction =
  | { type: 'add'; nx: number; ny: number }
  | { type: 'remove'; id: string }
  | { type: 'setNote'; id: string; note: string }
  | { type: 'reset' };

/**
 * pin 态纯 reducer。复杂度 O(n)（remove/setNote 线性扫，n ≤ 9 软上限 → 实质 O(1)）。
 *
 * - `add`：未达软上限 → 追加新 pin（编号/ id 取 next* 并自增）；**已达上限 → 返回原 state 引用**
 *   （调用方据 `state === next` 或长度未变判定「已达上限」给轻提示）。坐标 clamp 到 [0,1]。
 * - `remove`：移除指定 id；**不回退** nextN（编号不复用，保 SoM 1:1）。
 * - `setNote`：更新指定 pin 注记（T011）；id 不存在 → 原样返回。
 * - `reset`：清空（取消/返回零副作用，FR-012 —— 丢弃本次全部本地 pin/注记态）。
 */
export function pinReducer(state: PinState, action: PinAction): PinState {
  switch (action.type) {
    case 'add': {
      if (state.pins.length >= PIN_SOFT_CAP) return state; // 软上限：原样返回（调用方提示）。
      const pin: AnnotationPin = {
        id: `pin-${state.nextId}`,
        n: state.nextN,
        nx: clamp01(action.nx),
        ny: clamp01(action.ny),
        note: '',
      };
      return { pins: [...state.pins, pin], nextId: state.nextId + 1, nextN: state.nextN + 1 };
    }
    case 'remove': {
      const pins = state.pins.filter((p) => p.id !== action.id);
      if (pins.length === state.pins.length) return state; // 无变化原样返回。
      return { ...state, pins }; // nextN 不回退（编号不复用）。
    }
    case 'setNote': {
      let changed = false;
      const pins = state.pins.map((p) => {
        if (p.id !== action.id) return p;
        changed = true;
        return { ...p, note: action.note };
      });
      return changed ? { ...state, pins } : state;
    }
    case 'reset':
      return initialPinState;
    default:
      return state;
  }
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ──────────────────────────── 屏↔图坐标映射（纯函数，缩放/平移后稳定） ────────────────────────────

/** 画布内图片的渲染布局（content-fit 后图片在画布中的矩形，未叠加手势 transform 前的基准）。 */
export interface ImageLayout {
  /** 图片基准矩形左上角（画布坐标系，content-fit 居中后的 offset）。 */
  offsetX: number;
  offsetY: number;
  /** 图片基准矩形渲染尺寸（content-fit 后，未叠加缩放）。 */
  width: number;
  height: number;
}

/** 手势变换（reanimated 共享值快照）：先平移后缩放（以画布原点为基准）。 */
export interface CanvasTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

/**
 * 屏幕（画布）坐标 → 图片归一化坐标（0..1）。落 pin 时把点击点换算为锚图坐标。
 *
 * 变换链（与 ImageAnnotateCanvas Animated.View 一致）：画布点 → 去手势 transform（减平移、
 * 除缩放）得到图片基准矩形内坐标 → 除以基准尺寸归一化。缩放/平移后同一图内容点归一化坐标不变。
 */
export function screenToImage(
  screenX: number,
  screenY: number,
  layout: ImageLayout,
  transform: CanvasTransform,
): { nx: number; ny: number } {
  const { scale, translateX, translateY } = transform;
  // 1. 去手势变换：先减平移，再除缩放，回到基准（未变换）画布坐标。
  const baseX = (screenX - translateX) / scale;
  const baseY = (screenY - translateY) / scale;
  // 2. 减图片基准矩形 offset → 矩形内局部坐标 → 除尺寸归一化。
  const nx = (baseX - layout.offsetX) / layout.width;
  const ny = (baseY - layout.offsetY) / layout.height;
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

/**
 * 图片归一化坐标（0..1）→ 屏幕（画布）坐标。逆 screenToImage（坐标契约的 JS 线程参照，由
 * round-trip 单测守约）。pin overlay 在 UI 线程 worklet 内**内联同式**投影逐帧跟随手势
 * （AnnotationPin），二者必须保持同一仿射 `screen = base×scale + translate`。
 */
export function imageToScreen(
  nx: number,
  ny: number,
  layout: ImageLayout,
  transform: CanvasTransform,
): { x: number; y: number } {
  const { scale, translateX, translateY } = transform;
  // 1. 归一化 → 图片基准矩形内坐标 → 加 offset 回基准画布坐标。
  const baseX = layout.offsetX + nx * layout.width;
  const baseY = layout.offsetY + ny * layout.height;
  // 2. 叠加手势变换：乘缩放、加平移。
  return { x: baseX * scale + translateX, y: baseY * scale + translateY };
}

/**
 * content-fit `contain` 后图片在画布内的真实渲染矩形（aspect-fit + 居中黑边/留白）。
 *
 * pin 落点/回投/周边裁切都须对**此内容矩形**归一化，而非满画布 —— 否则 contain 的 letterbox
 * 偏移会让归一化坐标相对窗口（而非图片内容），裁切预览与真机锚点错位（036 真机实证）。
 *
 * - 缩放因子 `s = min(画布宽/自然宽, 画布高/自然高)`（取小 → 整图可见、不裁），显示尺寸 = 自然 × s，
 *   offset = (画布 − 显示) / 2（居中）。
 * - 非法尺寸（任一 ≤ 0）→ 退化为满画布矩形（尺寸就绪前的兜底，不产 NaN）。复杂度 O(1)。
 */
export function computeContainLayout(
  canvasW: number,
  canvasH: number,
  naturalW: number,
  naturalH: number,
): ImageLayout {
  if (!(canvasW > 0) || !(canvasH > 0) || !(naturalW > 0) || !(naturalH > 0)) {
    return { offsetX: 0, offsetY: 0, width: Math.max(0, canvasW), height: Math.max(0, canvasH) };
  }
  const s = Math.min(canvasW / naturalW, canvasH / naturalH);
  const width = naturalW * s;
  const height = naturalH * s;
  return { offsetX: (canvasW - width) / 2, offsetY: (canvasH - height) / 2, width, height };
}
