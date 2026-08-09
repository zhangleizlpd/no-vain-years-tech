import { describe, expect, it } from 'vitest';
import type { GroupItem } from '@nvy/api-client';

import {
  reorderEntriesAfterMove,
  reorderEntriesWithVisibilityToggled,
} from './group-management.helpers';

const g = (id: string, order: number, visible = true): GroupItem => ({
  id,
  name: id,
  type: 'custom',
  systemKind: null,
  visible,
  order,
  itemCount: 0,
});

describe('reorderEntriesAfterMove', () => {
  const groups = [g('a', 0), g('b', 1), g('c', 2), g('d', 3)];

  it('moves an item down and reindexes order 0-based', () => {
    // a,b,c,d → 把 a(0) 移到 2 → b,c,a,d
    expect(reorderEntriesAfterMove(groups, 0, 2)).toEqual([
      { groupId: 'b', order: 0, visible: true },
      { groupId: 'c', order: 1, visible: true },
      { groupId: 'a', order: 2, visible: true },
      { groupId: 'd', order: 3, visible: true },
    ]);
  });

  it('moves an item up', () => {
    // d(3) 移到 0 → d,a,b,c
    expect(reorderEntriesAfterMove(groups, 3, 0).map((e) => e.groupId)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });

  it('returns original order on from===to or out-of-range', () => {
    expect(reorderEntriesAfterMove(groups, 1, 1).map((e) => e.groupId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(reorderEntriesAfterMove(groups, 0, 9).map((e) => e.groupId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('reorderEntriesWithVisibilityToggled', () => {
  it('flips visible only for the target, keeps order indices', () => {
    const groups = [g('a', 0, true), g('b', 1, true), g('c', 2, false)];
    expect(reorderEntriesWithVisibilityToggled(groups, 'b')).toEqual([
      { groupId: 'a', order: 0, visible: true },
      { groupId: 'b', order: 1, visible: false },
      { groupId: 'c', order: 2, visible: false },
    ]);
  });
});
