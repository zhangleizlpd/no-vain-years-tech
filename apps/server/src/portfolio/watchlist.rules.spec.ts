import { describe, it, expect } from 'vitest';
import {
  isSystemGroup,
  isHoldingsGroup,
  resortWithPinPriority,
  defaultSystemGroups,
  fallbackGroupForDelete,
  type SortItem,
  type ResortOp,
} from './watchlist.rules';

// 013 T003: 自选列表纯函数不变量 (无 DB)。重点 = resortWithPinPriority 固顶/非固顶区
// 调位 (FR-S05 Gherkin) + 删组回落自选 (FR-S02)。
describe('watchlist.rules', () => {
  describe('isSystemGroup / isHoldingsGroup', () => {
    it('system 组 → isSystemGroup true；custom 组 → false', () => {
      expect(isSystemGroup({ type: 'system', systemKind: 'watchlist' })).toBe(true);
      expect(isSystemGroup({ type: 'system', systemKind: 'holdings' })).toBe(true);
      expect(isSystemGroup({ type: 'custom', systemKind: null })).toBe(false);
    });

    it('holdings 系统组 → isHoldingsGroup true；自选 / custom → false', () => {
      expect(isHoldingsGroup({ type: 'system', systemKind: 'holdings' })).toBe(true);
      expect(isHoldingsGroup({ type: 'system', systemKind: 'watchlist' })).toBe(false);
      expect(isHoldingsGroup({ type: 'custom', systemKind: null })).toBe(false);
    });
  });

  describe('resortWithPinPriority', () => {
    // helper: 输入按 order 乱序也能正确归一
    const items = (...rows: [bigint, boolean, number][]): SortItem[] =>
      rows.map(([id, pinned, order]) => ({ id, pinned, order }));

    // 读侧投影 = ORDER BY pinned DESC, order ASC
    const readOrder = (out: SortItem[]): bigint[] =>
      [...out]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order)
        .map((i) => i.id);

    it('pin：非固顶项固顶 → 移入固顶区头部 (常驻分组最顶, Gherkin US2-1)', () => {
      const out = resortWithPinPriority(items([1n, false, 0], [2n, false, 1], [3n, false, 2]), {
        kind: 'pin',
        itemId: 3n,
      } satisfies ResortOp);
      expect(readOrder(out)).toEqual([3n, 1n, 2n]);
      const t = out.find((i) => i.id === 3n)!;
      expect(t.pinned).toBe(true);
      expect(t.order).toBe(0);
    });

    it('pin：已有固顶项时新固顶项置于固顶区最顶', () => {
      const out = resortWithPinPriority(items([1n, true, 0], [2n, false, 0], [3n, false, 1]), {
        kind: 'pin',
        itemId: 3n,
      });
      // 固顶区: [3,1]；非固顶区: [2]
      expect(readOrder(out)).toEqual([3n, 1n, 2n]);
    });

    it('moveFront：非固顶项移到最前 → 位于固顶项下方 (非固顶区头部, Gherkin US2-2)', () => {
      const out = resortWithPinPriority(
        items([1n, true, 0], [2n, false, 0], [3n, false, 1], [4n, false, 2]),
        { kind: 'moveFront', itemId: 4n },
      );
      // 固顶区: [1]；非固顶区: [4,2,3]
      expect(readOrder(out)).toEqual([1n, 4n, 2n, 3n]);
      const t = out.find((i) => i.id === 4n)!;
      expect(t.pinned).toBe(false);
      expect(t.order).toBe(0); // 非固顶区头部
    });

    it('moveBack：非固顶项移到最后 → 非固顶区尾部', () => {
      const out = resortWithPinPriority(items([1n, false, 0], [2n, false, 1], [3n, false, 2]), {
        kind: 'moveBack',
        itemId: 1n,
      });
      expect(readOrder(out)).toEqual([2n, 3n, 1n]);
    });

    it('unpin：固顶项取消固顶 → 落非固顶区尾部', () => {
      const out = resortWithPinPriority(items([1n, true, 0], [2n, true, 1], [3n, false, 0]), {
        kind: 'unpin',
        itemId: 1n,
      });
      // 固顶区: [2]；非固顶区: [3,1]
      expect(readOrder(out)).toEqual([2n, 3n, 1n]);
      expect(out.find((i) => i.id === 1n)!.pinned).toBe(false);
    });

    it('固顶区常驻顶：非固顶项 moveFront 永不越过固顶项', () => {
      const out = resortWithPinPriority(
        items([1n, true, 0], [2n, true, 1], [3n, false, 1], [4n, false, 0]),
        { kind: 'moveFront', itemId: 3n },
      );
      const order = readOrder(out);
      // 固顶项 1,2 仍在前两位
      expect(order.slice(0, 2)).toEqual([1n, 2n]);
      expect(order.slice(2)).toEqual([3n, 4n]);
    });

    it('未知 itemId → 仅按现状重排 order 稠密化 (no-op move)', () => {
      const out = resortWithPinPriority(items([1n, true, 5], [2n, false, 9]), {
        kind: 'moveFront',
        itemId: 999n,
      });
      expect(readOrder(out)).toEqual([1n, 2n]);
      expect(out.find((i) => i.id === 1n)!.order).toBe(0);
      expect(out.find((i) => i.id === 2n)!.order).toBe(0);
    });

    it('空列表 → 空', () => {
      expect(resortWithPinPriority([], { kind: 'pin', itemId: 1n })).toEqual([]);
    });
  });

  describe('defaultSystemGroups', () => {
    it('返回自选 (order 0) + 持仓 (order 1)，均 system/visible', () => {
      const seeds = defaultSystemGroups(42n);
      expect(seeds).toHaveLength(2);
      const [watch, hold] = seeds;
      expect(watch).toMatchObject({
        accountId: 42n,
        name: '自选',
        type: 'system',
        systemKind: 'watchlist',
        visible: true,
        order: 0,
      });
      expect(hold).toMatchObject({
        accountId: 42n,
        name: '我的持仓',
        type: 'system',
        systemKind: 'holdings',
        visible: true,
        order: 1,
      });
    });
  });

  describe('fallbackGroupForDelete', () => {
    it('返回系统自选组 (回落目标, FR-S02)', () => {
      const groups = [
        { id: 1n, systemKind: 'holdings' as string | null },
        { id: 2n, systemKind: 'watchlist' as string | null },
        { id: 3n, systemKind: null as string | null },
      ];
      expect(fallbackGroupForDelete(groups)?.id).toBe(2n);
    });

    it('无自选组 → null', () => {
      expect(fallbackGroupForDelete([{ systemKind: null }, { systemKind: 'holdings' }])).toBeNull();
    });
  });
});
