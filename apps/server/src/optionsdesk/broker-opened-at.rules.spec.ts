import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { resolveOpenedAt, type BrokerTradeSide, type OpenedAtDeal } from './broker-opened-at.rules';

/**
 * `broker-opened-at.rules.ts` 纯单测 (082 T007, plan D8; FR-016)。
 *
 * 🚨 口径是**持仓起点**, 不是 FIFO 批次: 「累计带符号数量由 0 变非 0、或正负翻转」那一笔的时间。
 * 取错口径不报错, 只让开仓时间 (持有天数的起点) 悄悄偏移。
 *
 * ⚠️ tasks.md 臂 ① 的数值 (开 2 / 加 1 / 平 1, 持仓 2) **分不开 FIFO**: FIFO 先平最早批次后
 * D1 仍余 1 张, 同样答 D1。真正的 FIFO 反例是 ①b (平 2 ⇒ D1 批次耗尽, FIFO 答 D2)。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   a. 改坏: 起点改为首笔成交时间 → (2026-09-14 实跑) 3 failed | 7 passed —— ② ④ ⑥ 红
 *   b. 改坏: 忽略正负翻转 (只认 0 → 非 0) → (2026-09-14 实跑) 1 failed | 9 passed —— 只有 ④ 红
 *   两次均还原后 `cmp` 与备份逐字节相同, 10/10 绿
 *   复跑: pnpm nx test server src/optionsdesk/broker-opened-at.rules.spec.ts --skip-nx-cache
 */

const FIRST_SEEN = new Date('2026-09-14T01:00:00.000Z');
const D1 = new Date('2026-09-01T14:00:00.000Z');
const D2 = new Date('2026-09-02T14:00:00.000Z');
const D3 = new Date('2026-09-03T14:00:00.000Z');

const dec = (v: string | number) => new Prisma.Decimal(v);

function deal(dealId: string, tradedAt: Date, side: BrokerTradeSide, qty: number): OpenedAtDeal {
  return { dealId, tradedAt, side, qty: dec(qty) };
}

describe('resolveOpenedAt — 推算 (derived)', () => {
  it('① D1 开 2、D2 加 1、D3 平 1, 持仓 2 ⇒ D1 (加仓不移动起点)', () => {
    const deals = [deal('1', D1, 'BUY', 2), deal('2', D2, 'BUY', 1), deal('3', D3, 'SELL', 1)];
    expect(resolveOpenedAt({ deals, positionQty: dec(2), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D1,
      source: 'derived',
    });
  });

  it('🚨 ①b FIFO 反例: D1 开 2、D2 加 1、D3 平 2, 持仓 1 ⇒ D1 (FIFO 会答 D2)', () => {
    const deals = [deal('1', D1, 'BUY', 2), deal('2', D2, 'BUY', 1), deal('3', D3, 'SELL', 2)];
    expect(resolveOpenedAt({ deals, positionQty: dec(1), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D1,
      source: 'derived',
    });
  });

  it('🚨 ② 清仓后重开 ⇒ 重开那笔 (D3), 不是首笔', () => {
    const deals = [deal('1', D1, 'BUY', 2), deal('2', D2, 'SELL', 2), deal('3', D3, 'BUY', 1)];
    expect(resolveOpenedAt({ deals, positionQty: dec(1), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D3,
      source: 'derived',
    });
  });

  it('③ 空头: SELL_SHORT 开 3、BUY_BACK 部分平 1, 持仓 -2 ⇒ 开仓那笔 (D1)', () => {
    // 持仓数量带符号: 空头为负 (082 POC-1 原始输出 SHORT 持仓 17/17 行 qty < 0)。
    const deals = [deal('1', D1, 'SELL_SHORT', 3), deal('2', D2, 'BUY_BACK', 1)];
    expect(resolveOpenedAt({ deals, positionQty: dec(-2), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D1,
      source: 'derived',
    });
  });

  it('🚨 ④ 多翻空: 持 2 后一笔卖 5, 持仓 -3 ⇒ 翻转那笔 (D2)', () => {
    const deals = [deal('1', D1, 'BUY', 2), deal('2', D2, 'SELL', 5)];
    expect(resolveOpenedAt({ deals, positionQty: dec(-3), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D2,
      source: 'derived',
    });
  });

  it('⑥ 同一时刻两笔按 dealId 排序, 与入参顺序无关 (数字 id 按数值: 9 < 10)', () => {
    // 同刻: id 9 卖 2 (清仓) 在前、id 10 买 1 (重开) 在后 ⇒ 起点 D2。
    // 顺序若反过来 (字典序 '10' < '9'), 累计 2→3→1 不经过 0 ⇒ 会答 D1。
    const deals = [deal('1', D1, 'BUY', 2), deal('10', D2, 'BUY', 1), deal('9', D2, 'SELL', 2)];
    const permutations = [deals, [...deals].reverse(), [deals[2], deals[0], deals[1]]];
    for (const p of permutations) {
      expect(
        resolveOpenedAt({
          deals: p as OpenedAtDeal[],
          positionQty: dec(1),
          firstSeenAt: FIRST_SEEN,
        }),
      ).toEqual({ openedAt: D2, source: 'derived' });
    }
    // 入参不被原地排序。
    expect(deals.map((d) => d.dealId)).toEqual(['1', '10', '9']);
  });
});

describe('resolveOpenedAt — 回落 (fallback) 取首次发现时间', () => {
  it('⑤ 净量 ≠ 持仓 (拆股形态: 成交净 395、持仓 3950) ⇒ fallback', () => {
    const deals = [deal('1', D1, 'BUY', 395)];
    expect(resolveOpenedAt({ deals, positionQty: dec(3950), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: FIRST_SEEN,
      source: 'fallback',
    });
  });

  it('⑦ 无成交 ⇒ fallback', () => {
    expect(resolveOpenedAt({ deals: [], positionQty: dec(2), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: FIRST_SEEN,
      source: 'fallback',
    });
  });

  it('净量与持仓同为 0 (已平掉) ⇒ fallback, 不给一个已结束持仓的起点', () => {
    const deals = [deal('1', D1, 'BUY', 2), deal('2', D2, 'SELL', 2)];
    expect(resolveOpenedAt({ deals, positionQty: dec(0), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: FIRST_SEEN,
      source: 'fallback',
    });
  });

  it('数量按十进制精确比较: 0.1 + 0.2 张与持仓 0.3 相等 ⇒ derived', () => {
    const deals = [deal('1', D1, 'BUY', 0.1), deal('2', D2, 'BUY', 0.2)];
    expect(resolveOpenedAt({ deals, positionQty: dec('0.3'), firstSeenAt: FIRST_SEEN })).toEqual({
      openedAt: D1,
      source: 'derived',
    });
  });
});
