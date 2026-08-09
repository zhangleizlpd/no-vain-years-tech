import { describe, it, expect } from 'vitest';
import { parseTriggerArgs, cascadeClosure } from './marketdata-trigger.cli.js';
import type { SyncDependencyEdge } from './sync-flow-assembler.js';

// 017 T017 trigger CLI 纯函数层: argv 解析 + cascade BFS 传递性下游闭包。
// 退出码三态 (0/1/2) 走 Testcontainers IT (marketdata.trigger-cli.it.spec.ts)。

describe('parseTriggerArgs', () => {
  it('全旗标解析: --dimension --cascade --as-of --timeout', () => {
    expect(
      parseTriggerArgs([
        '--dimension',
        'eod_bar',
        '--cascade',
        '--as-of',
        '2026-06-04',
        '--timeout',
        '5000',
      ]),
    ).toEqual({ dimension: 'eod_bar', cascade: true, asOf: '2026-06-04', timeoutMs: 5000 });
  });

  it('默认值: 仅 --dimension → cascade=false, asOf/timeoutMs 未设', () => {
    expect(parseTriggerArgs(['--dimension', 'universe'])).toEqual({
      dimension: 'universe',
      cascade: false,
    });
  });

  it('--dimension 缺失 → throw (必填)', () => {
    expect(() => parseTriggerArgs(['--cascade'])).toThrow(/--dimension/);
  });

  it('未知维度键 → throw (值域 = 维度全序)', () => {
    expect(() => parseTriggerArgs(['--dimension', 'nope'])).toThrow(/未知维度/);
  });

  it('--timeout 非正数 → throw', () => {
    expect(() => parseTriggerArgs(['--dimension', 'universe', '--timeout', 'abc'])).toThrow(
      /--timeout/,
    );
    expect(() => parseTriggerArgs(['--dimension', 'universe', '--timeout', '0'])).toThrow(
      /--timeout/,
    );
  });
});

describe('cascadeClosure (传递性下游 BFS, 不含根)', () => {
  // seed 6 边 (PR-2): universe→* soft ×5 + profile→fundamental hard。
  const SEED: SyncDependencyEdge[] = [
    { upstream: 'universe', downstream: 'profile', mode: 'soft' },
    { upstream: 'universe', downstream: 'eod_bar', mode: 'soft' },
    { upstream: 'universe', downstream: 'fundamental', mode: 'soft' },
    { upstream: 'universe', downstream: 'financial', mode: 'soft' },
    { upstream: 'universe', downstream: 'corporate_action', mode: 'soft' },
    { upstream: 'profile', downstream: 'fundamental', mode: 'hard' },
  ];

  it('universe 根 → 全 5 下游 (直接 + profile→fundamental 传递去重)', () => {
    expect([...cascadeClosure('universe', SEED)].sort()).toEqual(
      ['corporate_action', 'eod_bar', 'financial', 'fundamental', 'profile'].sort(),
    );
  });

  it('profile 根 → 仅 fundamental (不含上游 universe, FR-S15)', () => {
    expect(cascadeClosure('profile', SEED)).toEqual(['fundamental']);
  });

  it('叶子根 (eod_bar) → 空闭包', () => {
    expect(cascadeClosure('eod_bar', SEED)).toEqual([]);
  });

  it('多跳传递: a→b→c → closure(a) 含 c', () => {
    const edges: SyncDependencyEdge[] = [
      { upstream: 'a', downstream: 'b', mode: 'soft' },
      { upstream: 'b', downstream: 'c', mode: 'soft' },
    ];
    expect([...cascadeClosure('a', edges)].sort()).toEqual(['b', 'c']);
  });
});
