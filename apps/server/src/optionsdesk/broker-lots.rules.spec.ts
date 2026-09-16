import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { BrokerTradeSide } from './broker-opened-at.rules';
import {
  restoreLots,
  type LotDeal,
  type LotOrder,
  type RestoreLotsInput,
} from './broker-lots.rules';

/**
 * `broker-lots.rules.ts` 纯单测 (083 T002, plan D10; FR-013 / FR-014 / FR-015)。
 *
 * 🚨 减仓按 **FIFO** 从最早批次起扣 —— 扣错批次不报错, 只让批次成本与剩余数量静默错位。
 * ② 是 FIFO 反例 (LIFO 实现此臂红)。
 *
 * ⚠️ ⑤ 的字面数值 (持仓 −3、批次合计 −2) **分不开**「带符号比较」与「比较绝对值」(2 ≠ 3 两边都 false),
 * 故 ⑤ 另加一例符号相反、绝对值相等 (成交还原为空头 3、券商报多头 3) —— 定向变异 c 靠它红。
 *
 * fixture 全部合成值; 价格避开 `check-optionsdesk-rule-constants` 的 #1 子串。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1): 结果见 T002 commit message body。
 *   复跑: pnpm nx test server src/optionsdesk/broker-lots.rules.spec.ts --skip-nx-cache
 */

const D1 = new Date('2026-09-01T14:00:00.000Z');
const D2 = new Date('2026-09-02T14:00:00.000Z');
const D3 = new Date('2026-09-03T14:00:00.000Z');
const D4 = new Date('2026-09-04T14:00:00.000Z');
const D5 = new Date('2026-09-05T14:00:00.000Z');

const dec = (v: string | number) => new Prisma.Decimal(v);

function deal(
  dealId: string,
  tradedAt: Date,
  side: BrokerTradeSide,
  qty: number,
  price: string,
  orderId: string | null,
): LotDeal {
  return { dealId, tradedAt, side, qty: dec(qty), price: dec(price), orderId };
}

/** 订单 `amount = qty × price × 乘数` (plan V0b 的口径)。 */
function order(id: number, qty: number, price: string, multiplier: number): LotOrder {
  return {
    id: BigInt(id),
    qty: dec(qty),
    price: dec(price),
    amount: dec(qty).times(dec(price)).times(multiplier),
  };
}

function input(
  overrides: Partial<RestoreLotsInput> & Pick<RestoreLotsInput, 'deals' | 'positionQty'>,
) {
  return {
    currentPrice: dec('4'),
    positionMarketValue: null,
    orders: new Map<string, LotOrder>(),
    ...overrides,
  } satisfies RestoreLotsInput;
}

/** 断言对比用: Decimal / bigint 转 string, 便于逐字段 `toEqual`。 */
function view(result: ReturnType<typeof restoreLots>) {
  return {
    restorable: result.restorable,
    lots: result.lots.map((l) => ({
      openedAt: l.openedAt,
      orderDbId: l.orderDbId === null ? null : l.orderDbId.toString(),
      originalQty: l.originalQty.toString(),
      remainingQty: l.remainingQty.toString(),
      cost: l.cost.toString(),
      marketValue: l.marketValue === null ? null : l.marketValue.toString(),
      unrealizedPl: l.unrealizedPl === null ? null : l.unrealizedPl.toString(),
    })),
  };
}

describe('restoreLots — 批次归并与成本 (FR-013 / FR-014)', () => {
  it('① 订单 A 分两次成交 ⇒ 1 个批次、数量为两次之和、成本为加权均价 (branch 26)', () => {
    const deals = [deal('1', D1, 'BUY', 1, '3', 'A'), deal('2', D2, 'BUY', 3, '5', 'A')];
    const r = view(restoreLots(input({ deals, positionQty: dec(4) })));
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0]).toMatchObject({
      openedAt: D1,
      originalQty: '4',
      remainingQty: '4',
      cost: '4.5',
    });
  });

  it('🚨 ② FIFO 反例: A 空 2 @ 高价、B 空 1 @ 低价、买回 1 ⇒ A 剩 1、B 剩 1, A 成本不变 (branch 27)', () => {
    const deals = [
      deal('1', D1, 'SELL_SHORT', 2, '7', 'A'),
      deal('2', D2, 'SELL_SHORT', 1, '3', 'B'),
      deal('3', D3, 'BUY_BACK', 1, '5', 'C'),
    ];
    const r = view(restoreLots(input({ deals, positionQty: dec(-2) })));
    // LIFO 会先扣 B ⇒ A 剩 2、B 不输出。
    expect(r.lots.map((l) => [l.openedAt, l.remainingQty, l.cost])).toEqual([
      [D1, '-1', '7'],
      [D2, '-1', '3'],
    ]);
  });

  it('③ 批次被扣为 0 ⇒ 不输出 (branch 28)', () => {
    const deals = [
      deal('1', D1, 'BUY', 1, '3', 'A'),
      deal('2', D2, 'BUY', 2, '5', 'B'),
      deal('3', D3, 'SELL', 1, '4', 'C'),
    ];
    const r = view(restoreLots(input({ deals, positionQty: dec(2) })));
    expect(r.lots.map((l) => [l.openedAt, l.remainingQty])).toEqual([[D2, '2']]);
  });

  it('⑥ 组合单一腿的成交 orderId 指向组合订单 ⇒ 批次 orderDbId = 该订单 (branch 31)', () => {
    const deals = [deal('1', D1, 'SELL_SHORT', 1, '3', 'COMBO')];
    const orders = new Map([['COMBO', order(77, 1, '2', 100)]]);
    const r = view(restoreLots(input({ deals, positionQty: dec(-1), orders })));
    expect(r.lots[0]?.orderDbId).toBe('77');
  });

  it('⑦ 开仓成交 orderId 为 null ⇒ 单独批次、orderDbId=null (branch 32)', () => {
    const deals = [deal('1', D1, 'BUY', 1, '3', null), deal('2', D2, 'BUY', 1, '5', null)];
    const r = view(restoreLots(input({ deals, positionQty: dec(2) })));
    expect(r.lots.map((l) => [l.openedAt, l.orderDbId, l.originalQty, l.cost])).toEqual([
      [D1, null, '1', '3'],
      [D2, null, '1', '5'],
    ]);
  });

  it('⑫ 被扣减 1 张的批次 originalQty=2、remainingQty=1', () => {
    const deals = [deal('1', D1, 'BUY', 2, '3', 'A'), deal('2', D2, 'SELL', 1, '4', 'B')];
    const r = view(restoreLots(input({ deals, positionQty: dec(1) })));
    expect(r.lots).toEqual([expect.objectContaining({ originalQty: '2', remainingQty: '1' })]);
  });

  it('入参顺序不限: 成交打乱后按 (tradedAt, dealId) 升序还原', () => {
    const ordered = [
      deal('9', D1, 'BUY', 2, '3', 'A'),
      deal('10', D1, 'SELL', 2, '4', 'B'), // 同一时刻, 成交号 9 < 10 ⇒ 先开后平
      deal('11', D2, 'BUY', 1, '5', 'C'),
    ];
    const shuffled = [ordered[2]!, ordered[1]!, ordered[0]!];
    expect(view(restoreLots(input({ deals: shuffled, positionQty: dec(1) })))).toEqual(
      view(restoreLots(input({ deals: ordered, positionQty: dec(1) }))),
    );
    expect(view(restoreLots(input({ deals: shuffled, positionQty: dec(1) }))).lots).toEqual([
      expect.objectContaining({ openedAt: D2, remainingQty: '1', cost: '5' }),
    ]);
  });
});

describe('restoreLots — 持仓周期 (FR-014)', () => {
  it('🚨 ⑧ 清仓后重开 ⇒ 只输出重开后的批次 (Edge「清仓后重新开仓」)', () => {
    const deals = [
      deal('1', D1, 'BUY', 2, '3', 'A'),
      deal('2', D2, 'SELL', 2, '4', 'B'),
      deal('3', D3, 'BUY', 1, '5', 'C'),
    ];
    const r = view(restoreLots(input({ deals, positionQty: dec(1) })));
    expect(r.lots.map((l) => [l.openedAt, l.originalQty, l.remainingQty, l.cost])).toEqual([
      [D3, '1', '1', '5'],
    ]);
    expect(r.restorable).toBe(true);
  });

  it('⑨ 一笔卖出量超过多头持仓 ⇒ 旧批次清零、余量成为新空头批次', () => {
    const deals = [
      deal('1', D1, 'BUY', 1, '3', 'A'),
      deal('2', D2, 'BUY', 1, '5', 'B'),
      deal('3', D3, 'SELL', 5, '4', 'C'),
    ];
    const orders = new Map([['C', order(30, 5, '4', 100)]]);
    const r = view(restoreLots(input({ deals, positionQty: dec(-3), orders })));
    expect(
      r.lots.map((l) => [l.openedAt, l.orderDbId, l.originalQty, l.remainingQty, l.cost]),
    ).toEqual([[D3, '30', '-3', '-3', '4']]);
    expect(r.restorable).toBe(true);
  });

  it('⑩ 到期作废 BUY_BACK @0 按 FIFO 扣减最早批次 (US2-AS3)', () => {
    const deals = [
      deal('1', D1, 'SELL_SHORT', 2, '3', 'A'),
      deal('2', D2, 'SELL_SHORT', 1, '5', 'B'),
      deal('3', D3, 'BUY_BACK', 1, '0', null),
    ];
    const r = view(restoreLots(input({ deals, positionQty: dec(-2) })));
    expect(r.lots.map((l) => [l.openedAt, l.originalQty, l.remainingQty, l.cost])).toEqual([
      [D1, '-2', '-1', '3'],
      [D2, '-1', '-1', '5'],
    ]);
  });

  it('同一订单在批次被扣空后再成交 ⇒ 补回原批次, 仍按原开仓时间参与 FIFO', () => {
    const deals = [
      deal('1', D1, 'BUY', 1, '3', 'A'),
      deal('2', D2, 'BUY', 1, '5', 'B'),
      deal('3', D3, 'SELL', 1, '4', 'C'), // 扣空 A
      deal('4', D4, 'BUY', 1, '3', 'A'), // A 再成交 1
      deal('5', D5, 'SELL', 1, '4', 'D'), // FIFO ⇒ 仍先扣 A
    ];
    const r = view(restoreLots(input({ deals, positionQty: dec(1) })));
    expect(r.lots.map((l) => [l.openedAt, l.originalQty, l.remainingQty])).toEqual([
      [D2, '1', '1'],
    ]);
  });
});

describe('restoreLots — 能否还原 (FR-015)', () => {
  it('④ Σ剩余 = 持仓 ⇒ restorable=true (branch 29)', () => {
    const deals = [deal('1', D1, 'SELL_SHORT', 3, '3', 'A')];
    expect(restoreLots(input({ deals, positionQty: dec(-3) })).restorable).toBe(true);
  });

  it('🚨 ⑤ 空头持仓 −3、批次合计 −2 ⇒ false; 符号相反而绝对值相等也 ⇒ false (branch 30)', () => {
    const shortTwo = [deal('1', D1, 'SELL_SHORT', 2, '3', 'A')];
    expect(restoreLots(input({ deals: shortTwo, positionQty: dec(-3) })).restorable).toBe(false);

    // 成交还原为空头 3, 券商报多头 3 —— 绝对值比较会误判为可还原。
    const shortThree = [deal('1', D1, 'SELL_SHORT', 3, '3', 'A')];
    expect(restoreLots(input({ deals: shortThree, positionQty: dec(3) })).restorable).toBe(false);
  });

  it('无成交、持仓非 0 ⇒ lots=[]、restorable=false', () => {
    expect(view(restoreLots(input({ deals: [], positionQty: dec(2) })))).toEqual({
      restorable: false,
      lots: [],
    });
  });
});

describe('restoreLots — 批次市值与盈亏 (FR-013; plan D10 / V0b)', () => {
  it('⑪ 乘数: 订单 amount = qty × price × 500 ⇒ 批次盈亏按 500 计; 市值按剩余比例拆分', () => {
    const deals = [deal('1', D1, 'BUY', 2, '3', 'A'), deal('2', D2, 'BUY', 1, '5', 'B')];
    const orders = new Map([
      ['A', order(11, 2, '3', 500)],
      ['B', order(12, 1, '5', 500)],
    ]);
    const r = view(
      restoreLots(
        input({
          deals,
          positionQty: dec(3),
          currentPrice: dec('4'),
          positionMarketValue: dec('6000'),
          orders,
        }),
      ),
    );
    expect(r.lots).toEqual([
      expect.objectContaining({ orderDbId: '11', marketValue: '4000', unrealizedPl: '1000' }),
      expect.objectContaining({ orderDbId: '12', marketValue: '2000', unrealizedPl: '-500' }),
    ]);
  });

  it('⑪ 空头批次: 剩余带符号 ⇒ 现价低于成本时盈利为正', () => {
    const deals = [deal('1', D1, 'SELL_SHORT', 2, '5', 'A')];
    const orders = new Map([['A', order(11, 2, '5', 100)]]);
    const r = view(
      restoreLots(
        input({
          deals,
          positionQty: dec(-2),
          currentPrice: dec('3'),
          positionMarketValue: dec('-600'),
          orders,
        }),
      ),
    );
    expect(r.lots).toEqual([expect.objectContaining({ marketValue: '-600', unrealizedPl: '400' })]);
  });

  it('⑪ 开仓订单缺失 ⇒ 盈亏 null、市值仍按比例拆分', () => {
    const deals = [deal('1', D1, 'BUY', 1, '3', 'A'), deal('2', D2, 'BUY', 3, '5', null)];
    const orders = new Map<string, LotOrder>(); // A 不在订单表
    const r = view(
      restoreLots(input({ deals, positionQty: dec(4), positionMarketValue: dec('1600'), orders })),
    );
    expect(r.lots).toEqual([
      expect.objectContaining({ orderDbId: null, marketValue: '400', unrealizedPl: null }),
      expect.objectContaining({ orderDbId: null, marketValue: '1200', unrealizedPl: null }),
    ]);
  });

  it('开仓订单价格为 0 ⇒ 乘数与盈亏 null (orderDbId 照常指向订单)', () => {
    const deals = [deal('1', D1, 'BUY', 1, '3', 'A')];
    const orders = new Map([['A', { id: 5n, qty: dec(1), price: dec(0), amount: dec(0) }]]);
    const r = view(restoreLots(input({ deals, positionQty: dec(1), orders })));
    expect(r.lots).toEqual([expect.objectContaining({ orderDbId: '5', unrealizedPl: null })]);
  });

  it('现价或持仓市值为 null ⇒ 对应字段 null', () => {
    const deals = [deal('1', D1, 'BUY', 1, '3', 'A')];
    const orders = new Map([['A', order(11, 1, '3', 100)]]);
    const r = view(
      restoreLots(
        input({
          deals,
          positionQty: dec(1),
          currentPrice: null,
          positionMarketValue: null,
          orders,
        }),
      ),
    );
    expect(r.lots).toEqual([expect.objectContaining({ marketValue: null, unrealizedPl: null })]);
  });
});
