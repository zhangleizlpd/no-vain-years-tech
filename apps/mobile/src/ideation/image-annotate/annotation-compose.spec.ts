// 036 T012 — SoM 合成标注文字纯函数测试（vitest=logic）。
//
// FR-006 严格 1:1：仅纳入**有注记**（note 非空 trim 后）的 pin；空 pin 既不烧录进图也不计入
// 合成文字。按编号顺序合成「1：… 2：…」。全空 → 无 attachment（退化由调用方据 hasAnnotations
// 判定，本任务处理有注记的烧录路径；仅附图直发由 T014 管）。
import { describe, expect, it } from 'vitest';

import { composeAnnotationText, pinsWithNotes } from './annotation-compose';
import type { AnnotationPin } from './pin-reducer';

const pin = (n: number, note: string): AnnotationPin => ({
  id: `pin-${n}`,
  n,
  nx: 0.5,
  ny: 0.5,
  note,
});

describe('pinsWithNotes (T012 / FR-006 仅纳入有注记的 pin)', () => {
  it('过滤空 note（含纯空白）→ 只留有注记的 pin', () => {
    const pins = [pin(1, '左上的按钮'), pin(2, ''), pin(3, '   '), pin(4, '颜色太深')];
    expect(pinsWithNotes(pins).map((p) => p.n)).toEqual([1, 4]);
  });

  it('全空 note → 空数组（调用方据此判定无 attachment）', () => {
    expect(pinsWithNotes([pin(1, ''), pin(2, '  ')])).toEqual([]);
  });

  it('无 pin → 空数组', () => {
    expect(pinsWithNotes([])).toEqual([]);
  });
});

describe('composeAnnotationText (T012 / FR-006 编号顺序 1:1)', () => {
  it('按编号顺序合成「n：note」逐行', () => {
    const pins = [pin(1, '主标题'), pin(2, '副标题')];
    expect(composeAnnotationText(pins)).toBe('1：主标题\n2：副标题');
  });

  it('跳过空 note（编号沿用 pin.n 不重排，与烧录图编号 1:1）', () => {
    // pin 2 空 → 不计入；输出仍用原编号 1/3（不压缩成 1/2）。
    const pins = [pin(1, '甲'), pin(2, ''), pin(3, '丙')];
    expect(composeAnnotationText(pins)).toBe('1：甲\n3：丙');
  });

  it('note 两端空白 trim 后合成', () => {
    expect(composeAnnotationText([pin(1, '  含空白  ')])).toBe('1：含空白');
  });

  it('全空 note → 空串（调用方据此不附 annotationText）', () => {
    expect(composeAnnotationText([pin(1, ''), pin(2, '   ')])).toBe('');
  });

  it('无 pin → 空串', () => {
    expect(composeAnnotationText([])).toBe('');
  });

  it('编号乱序输入 → 按 pin.n 升序输出（稳定 1:1）', () => {
    const pins = [pin(3, '丙'), pin(1, '甲'), pin(2, '乙')];
    expect(composeAnnotationText(pins)).toBe('1：甲\n2：乙\n3：丙');
  });
});
