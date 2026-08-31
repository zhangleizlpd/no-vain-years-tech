import { describe, expect, it } from 'vitest';

import {
  coldStartProgress,
  consumedAnchorIds,
  groupColdStartRuns,
} from './anchor-cold-start.rules';

// 072 T021 — 冷启动结局判定（FR-009 / US5 / sb-17, sb-18）。logic-only。

const run = (anchorId: string, needsAttention: boolean) => ({ anchorId, needsAttention });

describe('coldStartProgress — 缺席 = 排队中，不是失败（sb-18）', () => {
  it('三只问出去、两只回了结局 → 一只在排队（**不计入失败**）', () => {
    expect(coldStartProgress(['1', '2', '3'], [run('1', false), run('2', true)])).toEqual({
      total: 3,
      settled: 2,
      pending: 1,
    });
  });

  it('一条结局都没回 → 全在排队（而不是「全失败」）', () => {
    expect(coldStartProgress(['1', '2'], [])).toEqual({ total: 2, settled: 0, pending: 2 });
  });

  it('全回齐 → pending 归零', () => {
    expect(coldStartProgress(['1'], [run('1', false)])).toEqual({
      total: 1,
      settled: 1,
      pending: 0,
    });
  });

  it('服务端回了本批之外的 id（不该发生）→ 不把 settled 顶过 total', () => {
    expect(coldStartProgress(['1'], [run('1', false), run('99', false)])).toEqual({
      total: 1,
      settled: 1,
      pending: 0,
    });
  });

  it('空批 → 全 0（不除零、不报错）', () => {
    expect(coldStartProgress([], [])).toEqual({ total: 0, settled: 0, pending: 0 });
  });
});

describe('groupColdStartRuns — 分档只认服务端那一位', () => {
  it('needsAttention 的置顶，其余归已完成', () => {
    const runs = [run('1', false), run('2', true), run('3', false)];
    const { attention, done } = groupColdStartRuns(runs);
    expect(attention.map((r) => r.anchorId)).toEqual(['2']);
    expect(done.map((r) => r.anchorId)).toEqual(['1', '3']);
  });

  it('🚨 分档**不看 outcome 值**：服务端说某个 backfilled 需人工，就归需人工', () => {
    const { attention, done } = groupColdStartRuns([
      { anchorId: '1', outcome: 'backfilled', needsAttention: true },
      { anchorId: '2', outcome: 'retry_exhausted', needsAttention: false },
    ]);
    // 客户端若自己抄一份「哪些 outcome 算永久缺口」的名单，这条必红 —— 而线上的表现
    // 是某个永久缺口在界面上悄悄降级成「已完成」。
    expect(attention.map((r) => r.anchorId)).toEqual(['1']);
    expect(done.map((r) => r.anchorId)).toEqual(['2']);
  });

  it('两组互斥且并集 = 全集（没有行被吞掉）', () => {
    const runs = [run('1', true), run('2', false), run('3', true)];
    const { attention, done } = groupColdStartRuns(runs);
    expect(attention.length + done.length).toBe(runs.length);
    expect(attention.some((a) => done.includes(a))).toBe(false);
  });
});

describe('consumedAnchorIds — 采纳落成的那批锚', () => {
  it('挑出非空的 consumedAnchorId，保持顺序、去重', () => {
    expect(
      consumedAnchorIds(
        [
          { consumedAnchorId: 'a1' },
          { consumedAnchorId: null },
          { consumedAnchorId: 'a2' },
          { consumedAnchorId: 'a1' },
        ],
        10,
      ),
    ).toEqual(['a1', 'a2']);
  });

  it('按上限截断（服务端单次 anchorIds 上限 100）', () => {
    expect(consumedAnchorIds([{ consumedAnchorId: 'a1' }, { consumedAnchorId: 'a2' }], 1)).toEqual([
      'a1',
    ]);
  });

  it('一条都没有 → 空数组（不发一个空 anchorIds 的请求）', () => {
    expect(consumedAnchorIds([{ consumedAnchorId: null }], 10)).toEqual([]);
  });
});
