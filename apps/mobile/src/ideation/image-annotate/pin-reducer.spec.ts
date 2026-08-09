// 036 T010 — pin reducer + 屏↔图坐标映射纯逻辑单测（递增编号 / 软上限 9 / 坐标缩放后稳定 /
// 删除 / 取消丢弃零副作用）。手势·render·取消交互走 T015 e2e（vitest=logic 分层）。
import { describe, expect, it } from 'vitest';

import {
  computeContainLayout,
  imageToScreen,
  initialPinState,
  pinReducer,
  PIN_SOFT_CAP,
  screenToImage,
  type CanvasTransform,
  type ImageLayout,
  type PinState,
} from './pin-reducer';

function addN(state: PinState, count: number): PinState {
  let s = state;
  for (let i = 0; i < count; i++) s = pinReducer(s, { type: 'add', nx: 0.1 * i, ny: 0.1 * i });
  return s;
}

describe('pinReducer add（递增编号）', () => {
  it('首个 pin 编号 = 1，递增', () => {
    const s = addN(initialPinState, 3);
    expect(s.pins.map((p) => p.n)).toEqual([1, 2, 3]);
  });

  it('落 pin 锚归一化图坐标 + 空注记', () => {
    const s = pinReducer(initialPinState, { type: 'add', nx: 0.42, ny: 0.73 });
    expect(s.pins[0]).toMatchObject({ n: 1, nx: 0.42, ny: 0.73, note: '' });
  });

  it('坐标越界 clamp 到 [0,1]', () => {
    const s = pinReducer(initialPinState, { type: 'add', nx: 1.5, ny: -0.3 });
    expect(s.pins[0]).toMatchObject({ nx: 1, ny: 0 });
  });
});

describe('pinReducer 软上限 9（FR-003 轻提示不硬阻断）', () => {
  it('达上限后 add 返回同一 state 引用（调用方据此提示）', () => {
    const s9 = addN(initialPinState, PIN_SOFT_CAP);
    expect(s9.pins).toHaveLength(9);
    const s10 = pinReducer(s9, { type: 'add', nx: 0.5, ny: 0.5 });
    expect(s10).toBe(s9); // 同引用 → 未新增
    expect(s10.pins).toHaveLength(9);
  });
});

describe('pinReducer remove（编号不复用，保 SoM 1:1）', () => {
  it('删除指定 pin', () => {
    const s = addN(initialPinState, 3);
    const removed = pinReducer(s, { type: 'remove', id: s.pins[1]!.id });
    expect(removed.pins.map((p) => p.n)).toEqual([1, 3]);
  });

  it('删 #2 后再 add → 新 pin 编号 = 4（不回填已删编号）', () => {
    const s = addN(initialPinState, 3);
    const removed = pinReducer(s, { type: 'remove', id: s.pins[1]!.id });
    const added = pinReducer(removed, { type: 'add', nx: 0.9, ny: 0.9 });
    expect(added.pins.map((p) => p.n)).toEqual([1, 3, 4]);
  });

  it('删不存在 id → 原样返回', () => {
    const s = addN(initialPinState, 2);
    expect(pinReducer(s, { type: 'remove', id: 'nope' })).toBe(s);
  });
});

describe('pinReducer setNote（T011 注记）', () => {
  it('更新指定 pin 注记', () => {
    const s = addN(initialPinState, 2);
    const noted = pinReducer(s, { type: 'setNote', id: s.pins[0]!.id, note: '这里间距太大' });
    expect(noted.pins[0]!.note).toBe('这里间距太大');
    expect(noted.pins[1]!.note).toBe('');
  });

  it('setNote 不存在 id → 原样返回', () => {
    const s = addN(initialPinState, 1);
    expect(pinReducer(s, { type: 'setNote', id: 'nope', note: 'x' })).toBe(s);
  });
});

describe('pinReducer reset（取消/返回零副作用，FR-012）', () => {
  it('reset 清空全部 pin/注记本地态', () => {
    let s = addN(initialPinState, 3);
    s = pinReducer(s, { type: 'setNote', id: s.pins[0]!.id, note: 'x' });
    expect(pinReducer(s, { type: 'reset' })).toEqual(initialPinState);
  });
});

// ──────────────────────────── 坐标映射（缩放/平移后稳定，FR-003） ────────────────────────────

const LAYOUT: ImageLayout = { offsetX: 20, offsetY: 50, width: 300, height: 400 };
const IDENTITY: CanvasTransform = { scale: 1, translateX: 0, translateY: 0 };

describe('screenToImage / imageToScreen round-trip', () => {
  it('identity transform：屏→图→屏 还原', () => {
    const screen = { x: 170, y: 250 };
    const img = screenToImage(screen.x, screen.y, LAYOUT, IDENTITY);
    const back = imageToScreen(img.nx, img.ny, LAYOUT, IDENTITY);
    expect(back.x).toBeCloseTo(screen.x, 5);
    expect(back.y).toBeCloseTo(screen.y, 5);
  });

  it('🚨 缩放/平移后同一图内容点归一化坐标稳定（FR-003 核心）', () => {
    // 用户在 identity 下点画布中心落 pin → 得归一化图坐标。
    const tapAtIdentity = {
      x: LAYOUT.offsetX + LAYOUT.width / 2,
      y: LAYOUT.offsetY + LAYOUT.height / 2,
    };
    const img = screenToImage(tapAtIdentity.x, tapAtIdentity.y, LAYOUT, IDENTITY);
    expect(img).toEqual({ nx: 0.5, ny: 0.5 });

    // 之后捏合放大 2x + 平移 → 同一归一化坐标投影到新屏幕位置，
    // 再逆映射回归一化坐标必须仍 = 0.5/0.5（pin 不漂移）。
    const zoomed: CanvasTransform = { scale: 2, translateX: -40, translateY: 30 };
    const projected = imageToScreen(img.nx, img.ny, LAYOUT, zoomed);
    const reInverse = screenToImage(projected.x, projected.y, LAYOUT, zoomed);
    expect(reInverse.nx).toBeCloseTo(0.5, 5);
    expect(reInverse.ny).toBeCloseTo(0.5, 5);
  });

  it('图片矩形左上角 → 归一化 (0,0)，右下角 → (1,1)', () => {
    const tl = screenToImage(LAYOUT.offsetX, LAYOUT.offsetY, LAYOUT, IDENTITY);
    const br = screenToImage(
      LAYOUT.offsetX + LAYOUT.width,
      LAYOUT.offsetY + LAYOUT.height,
      LAYOUT,
      IDENTITY,
    );
    expect(tl).toEqual({ nx: 0, ny: 0 });
    expect(br).toEqual({ nx: 1, ny: 1 });
  });

  it('点击图片矩形外（含手势平移）→ clamp 到边界', () => {
    const img = screenToImage(-100, -100, LAYOUT, IDENTITY);
    expect(img).toEqual({ nx: 0, ny: 0 });
  });
});

// ──────────────────────────── contain 内容矩形（aspect-fit + 居中黑边，Bug 修复） ────────────────────────────

describe('computeContainLayout（content-fit contain 内容矩形）', () => {
  it('竖图 + 方画布 → 左右留白（pillarbox），高占满', () => {
    // 自然 100×200（竖，比 0.5），画布 300×300：s=min(3,1.5)=1.5 → 显示 150×300，左右各留白 75。
    expect(computeContainLayout(300, 300, 100, 200)).toEqual({
      offsetX: 75,
      offsetY: 0,
      width: 150,
      height: 300,
    });
  });

  it('横图 + 方画布 → 上下留白（letterbox），宽占满', () => {
    // 自然 200×100（横，比 2），画布 300×300：s=min(1.5,3)=1.5 → 显示 300×150，上下各留白 75。
    expect(computeContainLayout(300, 300, 200, 100)).toEqual({
      offsetX: 0,
      offsetY: 75,
      width: 300,
      height: 150,
    });
  });

  it('比例相同 → 整图铺满无留白', () => {
    expect(computeContainLayout(300, 600, 100, 200)).toEqual({
      offsetX: 0,
      offsetY: 0,
      width: 300,
      height: 600,
    });
  });

  it('非法尺寸（自然 0 / 画布 0）→ 退化满画布矩形（不产 NaN）', () => {
    expect(computeContainLayout(300, 400, 0, 200)).toEqual({
      offsetX: 0,
      offsetY: 0,
      width: 300,
      height: 400,
    });
    expect(computeContainLayout(0, 0, 100, 200)).toEqual({
      offsetX: 0,
      offsetY: 0,
      width: 0,
      height: 0,
    });
  });

  it('🚨 落 pin 锚内容矩形：内容矩形角落 → 归一化 (0,0)/(1,1)（黑边不掺入 → 裁切对位）', () => {
    // 竖图在方画布：内容矩形 = {75,0,150,300}。点内容矩形左上/右下 → 归一化必须正好 0/1，
    // 而非相对满画布（满画布会把左右黑边算进 nx → 裁切错位，即真机 Bug 2 根因）。
    const layout = computeContainLayout(300, 300, 100, 200);
    const tl = screenToImage(layout.offsetX, layout.offsetY, layout, IDENTITY);
    const br = screenToImage(
      layout.offsetX + layout.width,
      layout.offsetY + layout.height,
      layout,
      IDENTITY,
    );
    expect(tl).toEqual({ nx: 0, ny: 0 });
    expect(br).toEqual({ nx: 1, ny: 1 });
  });
});
