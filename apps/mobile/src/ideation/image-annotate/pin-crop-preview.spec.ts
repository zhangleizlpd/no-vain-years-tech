// 036 T011 — pin 周边裁切预览参数计算纯函数测试（vitest=logic）。
//
// crop 是**纯 UI 预览**（注记行左侧小图块，让用户确认锚点周边内容），**不进**模型 payload
// （模型只收 SoM 烧录图，T012）。本测覆盖：归一化锚点 → 图片像素 crop 矩形、边界 clamp、
// 比例守恒、退化输入兜底。
import { describe, expect, it } from 'vitest';

import { CROP_WINDOW_FRACTION, pinCropRect } from './pin-crop-preview';

describe('pinCropRect (T011 / FR-004 周边裁切预览)', () => {
  const img = { width: 1000, height: 800 };

  it('居中锚点 → crop 矩形以锚点为中心、边长 = fraction × 短边', () => {
    const side = Math.round(CROP_WINDOW_FRACTION * 800); // 短边为高 800。
    const rect = pinCropRect(0.5, 0.5, img);
    expect(rect.width).toBe(side);
    expect(rect.height).toBe(side);
    // 中心 = 锚点像素 (500,400)，originX/Y = 中心 - 半边。
    expect(rect.originX).toBe(500 - Math.round(side / 2));
    expect(rect.originY).toBe(400 - Math.round(side / 2));
  });

  it('左上角锚点 → originX/originY clamp 到 0（不越界负坐标）', () => {
    const rect = pinCropRect(0, 0, img);
    expect(rect.originX).toBe(0);
    expect(rect.originY).toBe(0);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('右下角锚点 → origin + 边长 不超图片边界', () => {
    const rect = pinCropRect(1, 1, img);
    expect(rect.originX + rect.width).toBeLessThanOrEqual(img.width);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(img.height);
  });

  it('crop 窗口大于短边 → 退化为整图（width/height clamp 到图片尺寸，origin=0）', () => {
    // 极小图：短边 10 → fraction × 10 仍 ≥ 短边时不溢出。
    const tiny = { width: 10, height: 10 };
    const rect = pinCropRect(0.5, 0.5, tiny);
    expect(rect.originX).toBeGreaterThanOrEqual(0);
    expect(rect.originY).toBeGreaterThanOrEqual(0);
    expect(rect.originX + rect.width).toBeLessThanOrEqual(tiny.width);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(tiny.height);
  });

  it('nx/ny 越界（<0 或 >1）→ clamp 到 [0,1] 再算（不产出负 origin / 越界矩形）', () => {
    const rect = pinCropRect(-0.3, 1.7, img);
    expect(rect.originX).toBeGreaterThanOrEqual(0);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(img.height);
  });

  it('非法图片尺寸（0 / 负）→ 返回零矩形兜底（不抛、不产 NaN）', () => {
    const rect = pinCropRect(0.5, 0.5, { width: 0, height: 0 });
    expect(rect).toEqual({ originX: 0, originY: 0, width: 0, height: 0 });
    expect(Number.isNaN(rect.width)).toBe(false);
  });
});
