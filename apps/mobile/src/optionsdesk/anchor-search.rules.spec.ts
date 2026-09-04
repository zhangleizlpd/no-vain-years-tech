import { describe, expect, it } from 'vitest';

import { searchSheetState, type SearchSheetState } from './anchor-search.rules';

// 074 T006 — 锚搜索浮层五态判定（FR-009 / FR-010; sb 1/4/7）。
// logic-only：Modal / 防抖计时器 / 行渲染归 T007/T008 的 Playwright e2e
// （per mono 测试分层：vitest 只测判定，UI 归 Playwright）。
//
// 用例照 spec 写，不照实现写：空输入那格逐个点名 isError / 零命中 ——
// 「没搜过 ≠ 搜不到」是本判定的唯一分辨点，只测非空维度的话，
// 一个漏判 debouncedQ 的实现照样全绿。

const BOOLS = [true, false] as const;

describe('searchSheetState — 空输入恒 idle（sb-1：没搜过 ≠ 搜不到）', () => {
  it('空串 → idle', () => {
    expect(
      searchSheetState({ debouncedQ: '', isFetching: false, isError: false, itemCount: 0 }),
    ).toBe('idle');
  });

  it('仅空白 → idle（sb-1 明写「为空**或仅空白**」）', () => {
    expect(
      searchSheetState({ debouncedQ: '   ', isFetching: false, isError: false, itemCount: 0 }),
    ).toBe('idle');
    expect(
      searchSheetState({ debouncedQ: '\t\n', isFetching: false, isError: false, itemCount: 0 }),
    ).toBe('idle');
  });

  it('空输入 ∧ 零命中 → idle 而非 empty ——「无匹配」只许说给搜过的人听（FR-009）', () => {
    expect(
      searchSheetState({ debouncedQ: '', isFetching: false, isError: false, itemCount: 0 }),
    ).not.toBe('empty');
  });

  it('空输入 ∧ isError → idle 而非 error —— 清空输入后旧请求的失败不许留在屏上', () => {
    expect(
      searchSheetState({ debouncedQ: '', isFetching: false, isError: true, itemCount: 0 }),
    ).toBe('idle');
  });

  it('空输入 ∧ 有旧命中 / 在途 → 仍 idle（清空的瞬间不闪旧列表、不闪 spinner）', () => {
    expect(
      searchSheetState({ debouncedQ: '', isFetching: false, isError: false, itemCount: 5 }),
    ).toBe('idle');
    expect(
      searchSheetState({ debouncedQ: '', isFetching: true, isError: false, itemCount: 0 }),
    ).toBe('idle');
  });

  it('空输入下 isFetching × isError × itemCount 全组合恒 idle', () => {
    for (const isFetching of BOOLS) {
      for (const isError of BOOLS) {
        for (const itemCount of [0, 3]) {
          expect(searchSheetState({ debouncedQ: ' ', isFetching, isError, itemCount })).toBe(
            'idle',
          );
        }
      }
    }
  });
});

describe('searchSheetState — 非空输入四态互斥（sb-4 / sb-7）', () => {
  it('在途 → loading', () => {
    expect(
      searchSheetState({ debouncedQ: '腾讯', isFetching: true, isError: false, itemCount: 0 }),
    ).toBe('loading');
  });

  it('在途 ∧ isError（重试在途）→ loading —— 点了重试要看得见在转（sb-7）', () => {
    expect(
      searchSheetState({ debouncedQ: '腾讯', isFetching: true, isError: true, itemCount: 0 }),
    ).toBe('loading');
  });

  it('在途 ∧ 有旧命中（换词在途）→ loading 而非 hits（sb-2 旧词结果不闪回的判定半边）', () => {
    expect(
      searchSheetState({ debouncedQ: '阿里', isFetching: true, isError: false, itemCount: 2 }),
    ).toBe('loading');
  });

  it('失败 ∧ 不在途 → error（缓存残留的命中数不参与，sb-7 浮层内提示）', () => {
    expect(
      searchSheetState({ debouncedQ: '腾讯', isFetching: false, isError: true, itemCount: 0 }),
    ).toBe('error');
    expect(
      searchSheetState({ debouncedQ: '腾讯', isFetching: false, isError: true, itemCount: 2 }),
    ).toBe('error');
  });

  it('命中 ≥1 → hits', () => {
    expect(
      searchSheetState({ debouncedQ: '腾讯', isFetching: false, isError: false, itemCount: 1 }),
    ).toBe('hits');
    expect(
      searchSheetState({ debouncedQ: '700', isFetching: false, isError: false, itemCount: 20 }),
    ).toBe('hits');
  });

  it('零命中 → empty（显式空态，sb-4；旁路入口的「零 CTA」归 e2e）', () => {
    expect(
      searchSheetState({ debouncedQ: '不存在', isFetching: false, isError: false, itemCount: 0 }),
    ).toBe('empty');
  });

  it('非空输入下全组合恰好映射四态（互斥全排列，无第五种出口）', () => {
    for (const isFetching of BOOLS) {
      for (const isError of BOOLS) {
        for (const itemCount of [0, 3]) {
          const expected: SearchSheetState = isFetching
            ? 'loading'
            : isError
              ? 'error'
              : itemCount > 0
                ? 'hits'
                : 'empty';
          expect(searchSheetState({ debouncedQ: 'q', isFetching, isError, itemCount })).toBe(
            expected,
          );
        }
      }
    }
  });
});
