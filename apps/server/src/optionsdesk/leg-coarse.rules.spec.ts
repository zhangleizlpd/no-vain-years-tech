import { describe, expect, it } from 'vitest';
import { coarseRank } from './leg-coarse.rules';

/**
 * 052 T002 —— 粗排层恒等性 (FR-004, plan D-LAYER-1)。
 *
 * 📌 **「函数体零判据」那条机器判据不在本文件**: 它要读源码, 而 Small 档禁磁盘 I/O ⇒ 落
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #6 (同 #5 的处置)。本文件守的是
 * 行为面 —— 恒等**且不复制**: 返回新数组也算「有逻辑」, 而它会让下游对候选池的原地写 (活跃度
 * 标记正是往腿上原地写) 悄悄落到一份副本上。
 */

describe('leg-coarse.rules — 粗排层当前是恒等函数 (FR-004)', () => {
  it('空集进空集出 —— 空候选池不是要特判的边界, 是恒等的一个取值', () => {
    const empty: readonly number[] = [];
    expect(coarseRank(empty)).toBe(empty);
  });

  it('返回的是**同一个**引用而非等价副本 —— 复制就是一处不必要的逻辑', () => {
    const candidates = [{ code: 'C-1' }, { code: 'C-2' }, { code: 'C-3' }];
    expect(coarseRank(candidates)).toBe(candidates);
  });

  it('元素一条不增不减、不重排 —— 顺序是下游名次与决胜的输入', () => {
    const candidates = ['C-1', 'C-2', 'C-3'];
    expect(coarseRank(candidates)).toEqual(['C-1', 'C-2', 'C-3']);
  });

  it('对元素类型无知: 装什么进去就是什么出来 (合并去重是集合运算, 与元素形状无关)', () => {
    const legs = [{ tabs: ['all'], greeksComplete: false }];
    expect(coarseRank(legs)[0]).toBe(legs[0]);
  });
});
