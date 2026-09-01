import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  ANCHOR_TRACKED_FIELDS,
  buildAnchorChange,
  buildCreationChange,
  buildDeletionChange,
  derivePointInTimeValues,
  replayAnchorAt,
  toAnchorSnapshot,
  type AnchorChangeRecord,
  type AnchorSnapshot,
} from './anchor-history';

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

/** 当前锚行 (模型 import 之后的态)。 */
const currentRow = {
  id: 7n,
  ticker: 'us:AOS',
  v: D('60'),
  asof: new Date('2026-07-01T00:00:00Z'),
  method: 'dcf',
  confidence: D('9.2'),
  confidenceSource: 'model',
  excluded: false,
  excludeReason: null,
  nextReview: new Date('2026-09-30T00:00:00Z'),
  lastReviewedOn: new Date('2026-05-01T00:00:00Z'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L1',
  lastClose: D('47.5'),
  lastCloseDate: new Date('2026-08-01T00:00:00Z'),
  breachStartedOn: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

/** 建锚 → 人工调 L 层 → 模型 import 回落, 三条痕迹 (返回时按 changed_at 倒序)。 */
const changes: AnchorChangeRecord[] = [
  {
    changedAt: new Date('2026-07-01T10:00:00Z'),
    changedFields: ['v', 'confidence', 'confidenceSource', 'lLevelManual', 'lLevelEffective'],
    beforeValues: {
      v: '50',
      confidence: '8',
      confidenceSource: 'manual',
      lLevelManual: 'L3',
      lLevelEffective: 'L3',
    },
    source: 'model',
  },
  {
    changedAt: new Date('2026-06-01T10:00:00Z'),
    changedFields: ['lLevelManual', 'lLevelEffective'],
    beforeValues: { lLevelManual: null, lLevelEffective: 'L2' },
    source: 'manual',
  },
  {
    changedAt: new Date('2026-05-01T10:00:00Z'),
    changedFields: [...ANCHOR_TRACKED_FIELDS],
    beforeValues: {},
    source: 'manual',
  },
];

describe('anchor-history — 痕迹构造 (FR-031 一行 = 一次变更)', () => {
  const before = toAnchorSnapshot(currentRow);

  it('一次变更落一条痕迹, changedFields = 本次变更的**字段集** (非一行一字段)', () => {
    const change = buildAnchorChange(before, { v: '70', method: 'comps' }, 'manual');
    expect(change).not.toBeNull();
    expect([...change!.changedFields].sort()).toEqual(['method', 'v']);
  });

  it('beforeValues 只存被改字段的改前值', () => {
    const change = buildAnchorChange(before, { v: '70', method: 'comps' }, 'manual');
    expect(change!.beforeValues).toEqual({ v: '60', method: 'dcf' });
  });

  it('值没真变 → 返回 null (零变更零痕迹, 幂等重写不刷噪声行)', () => {
    expect(
      buildAnchorChange(before, { method: 'dcf', lLevelEffective: 'L1' }, 'manual'),
    ).toBeNull();
  });

  it('Decimal 按值比较, 写法不同不算变更 (60 vs 60.00)', () => {
    expect(buildAnchorChange(before, { v: '60.00' }, 'manual')).toBeNull();
  });

  it('人工位置 null (撤销) 算一次变更, 改前值留在痕迹里', () => {
    const manualBefore = toAnchorSnapshot({ ...currentRow, lLevelManual: 'L3' });
    const change = buildAnchorChange(manualBefore, { lLevelManual: null }, 'manual');
    expect(change!.beforeValues).toEqual({ lLevelManual: 'L3' });
  });

  it('🚨 行情列不进痕迹: last_close / last_close_date 是外部行情不是锚事实', () => {
    expect([...ANCHOR_TRACKED_FIELDS]).not.toContain('lastClose');
    expect([...ANCHOR_TRACKED_FIELDS]).not.toContain('lastCloseDate');
    expect(buildAnchorChange(before, { lastClose: D('99') }, 'manual')).toBeNull();
  });

  it('source 可分辨 model / manual (FR-035)', () => {
    expect(buildAnchorChange(before, { v: '70' }, 'model')!.source).toBe('model');
    expect(buildAnchorChange(before, { v: '70' }, 'manual')!.source).toBe('manual');
  });

  it('建锚痕迹: beforeValues 为空 (锚此前不存在), changedFields = 全字段集', () => {
    const change = buildCreationChange(currentRow, 'manual');
    expect(change.beforeValues).toEqual({});
    expect([...change.changedFields].sort()).toEqual([...ANCHOR_TRACKED_FIELDS].sort());
  });

  it('删锚痕迹: beforeValues = 整行快照 (删锚本身也是一次变更)', () => {
    const change = buildDeletionChange(currentRow, 'manual');
    expect(change.beforeValues.v).toBe('60');
    expect(change.beforeValues.lLevelEffective).toBe('L1');
    expect([...change.changedFields].sort()).toEqual([...ANCHOR_TRACKED_FIELDS].sort());
  });
});

// SC-011: 给定时点回放 —— 算法 = 按时点倒放 beforeValues。
describe('anchor-history — PIT 回放 (SC-011)', () => {
  const current = toAnchorSnapshot(currentRow);

  it('时点在最近一次变更之前 → 倒放该条得当时值', () => {
    const at = new Date('2026-06-15T00:00:00Z');
    const snapshot = replayAnchorAt(current, changes, at) as AnchorSnapshot;
    expect(snapshot.v).toBe('50');
    expect(snapshot.confidence).toBe('8');
    expect(snapshot.lLevelManual).toBe('L3');
    expect(snapshot.confidenceSource).toBe('manual');
  });

  it('时点更早 → 逐条继续倒放 (人工态尚未设置)', () => {
    const snapshot = replayAnchorAt(
      current,
      changes,
      new Date('2026-05-15T00:00:00Z'),
    ) as AnchorSnapshot;
    expect(snapshot.lLevelManual).toBeNull();
    expect(snapshot.lLevelEffective).toBe('L2');
    expect(snapshot.v).toBe('50');
  });

  it('时点晚于全部变更 → 就是当前值', () => {
    const snapshot = replayAnchorAt(
      current,
      changes,
      new Date('2026-08-01T00:00:00Z'),
    ) as AnchorSnapshot;
    expect(snapshot.v).toBe('60');
    expect(snapshot.lLevelEffective).toBe('L1');
  });

  it('时点早于建锚 → null (锚当时不存在, 不返回半截快照)', () => {
    expect(replayAnchorAt(current, changes, new Date('2026-04-01T00:00:00Z'))).toBeNull();
  });

  it('痕迹乱序传入也按 changed_at 倒序回放 (不依赖调用方排序)', () => {
    const shuffled = [changes[1]!, changes[2]!, changes[0]!];
    const snapshot = replayAnchorAt(
      current,
      shuffled,
      new Date('2026-06-15T00:00:00Z'),
    ) as AnchorSnapshot;
    expect(snapshot.v).toBe('50');
    expect(snapshot.lLevelManual).toBe('L3');
  });

  it('已删除的锚 (当前行不存在) → 从删锚痕迹的整行快照起回放', () => {
    const deletion: AnchorChangeRecord = {
      changedAt: new Date('2026-07-20T10:00:00Z'),
      changedFields: [...ANCHOR_TRACKED_FIELDS],
      beforeValues: current,
      source: 'manual',
    };
    const snapshot = replayAnchorAt(
      null,
      [deletion, ...changes],
      new Date('2026-07-10T00:00:00Z'),
    ) as AnchorSnapshot;
    expect(snapshot.v).toBe('60');
    expect(snapshot.lLevelEffective).toBe('L1');
  });
});

describe('anchor-history — PIT 派生值与当时显示逐项一致 (SC-011)', () => {
  const current = toAnchorSnapshot(currentRow);

  it('回放到人工 L3 那一刻: V / W / L 层 / 单票上限 / 愿卖锚五项', () => {
    const snapshot = replayAnchorAt(
      current,
      changes,
      new Date('2026-06-15T00:00:00Z'),
    ) as AnchorSnapshot;
    const pit = derivePointInTimeValues(snapshot);
    expect(pit.v.toString()).toBe('50');
    expect(pit.w.toString()).toBe('40');
    expect(pit.lLevel).toBe('L3');
    expect(pit.positionCap!.toString()).toBe('0.02');
    expect(pit.willingSell.longHold.toString()).toBe('60');
    expect(pit.willingSell.rent.toString()).toBe('50');
  });

  it('当时处于人工态 → PIT 能分辨值是人工设的还是派生的 (FR-035 source)', () => {
    const snapshot = replayAnchorAt(
      current,
      changes,
      new Date('2026-06-15T00:00:00Z'),
    ) as AnchorSnapshot;
    const pit = derivePointInTimeValues(snapshot);
    expect(pit.lLevelIsManual).toBe(true);
    expect(pit.derived.lLevel).toBe('L2');
  });

  it('回放到人工态之前 → 三处均非人工, L 层走映射档', () => {
    const snapshot = replayAnchorAt(
      current,
      changes,
      new Date('2026-05-15T00:00:00Z'),
    ) as AnchorSnapshot;
    const pit = derivePointInTimeValues(snapshot);
    expect(pit.lLevelIsManual).toBe(false);
    expect(pit.lLevel).toBe('L2');
    expect(pit.positionCap!.toString()).toBe('0.05');
  });

  it('当前时点的派生值与当前行直算一致 (回放算法不引入偏差)', () => {
    const pit = derivePointInTimeValues(current);
    expect(pit.v.toString()).toBe('60');
    expect(pit.lLevel).toBe('L1');
    expect(pit.positionCap!.toString()).toBe('0.25');
  });

  it('生效 V 取人工值 (COALESCE(v_manual, v)) 后 W 与愿卖锚随之', () => {
    const pit = derivePointInTimeValues(toAnchorSnapshot({ ...currentRow, vManual: D('100') }));
    expect(pit.v.toString()).toBe('100');
    expect(pit.w.toString()).toBe('80');
    expect(pit.vIsManual).toBe(true);
  });
});
