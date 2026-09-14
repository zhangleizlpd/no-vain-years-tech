import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { BrokerMarket } from './broker-code.rules';
import { planPositionSync } from './broker-position-sync.rules';

/**
 * `broker-position-sync.rules.ts` 纯单测 (082 T008, plan D8; FR-014 / FR-015; state_branches 9, 10)。
 *
 * 🚨 保留 `firstSeenAt` 是本函数唯一「写错不报错」的点: 覆盖掉它, 开仓时间的回落值 (FR-016)
 * 就会每次对账后悄悄变成「今天」, 持有天数归零。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   a. 改坏: toUpdate 的 firstSeenAt 取 `new Date()` (覆盖) → (2026-09-14 实跑) 2 failed | 5 passed
 *      —— ② ③ 红 (③ 同样断言了被保留那一行的 firstSeenAt)
 *   还原后 `cmp` 与备份逐字节相同, 7/7 绿
 *   复跑: pnpm nx test server src/optionsdesk/broker-position-sync.rules.spec.ts --skip-nx-cache
 */

const OLD_SEEN = new Date('2026-08-01T01:00:00.000Z');
const OTHER_SEEN = new Date('2026-08-20T01:00:00.000Z');

const dec = (v: number) => new Prisma.Decimal(v);

function existingRow(market: BrokerMarket, code: string, firstSeenAt = OLD_SEEN) {
  return { market, code, firstSeenAt, qty: dec(1) };
}

function reportedRow(market: BrokerMarket, code: string, qty = 1) {
  return { market, code, qty: dec(qty) };
}

describe('planPositionSync — 集合替换计划', () => {
  it('① 券商新报告、库里没有 ⇒ insert', () => {
    const r = reportedRow('us', 'US.PDD260918P70000', -2);
    expect(planPositionSync({ existing: [], reported: [r] })).toEqual({
      toInsert: [r],
      toUpdate: [],
      toDelete: [],
    });
  });

  it('🚨 ② 两边都有 ⇒ update, firstSeenAt 保留库内值 (不被本次覆盖)', () => {
    const e = existingRow('us', 'US.PDD260918P70000');
    const r = reportedRow('us', 'US.PDD260918P70000', -3);
    expect(planPositionSync({ existing: [e], reported: [r] })).toEqual({
      toInsert: [],
      toUpdate: [{ reported: r, firstSeenAt: OLD_SEEN }],
      toDelete: [],
    });
  });

  it('③ 券商不再报告 (平仓 / 到期作废) ⇒ delete (branch 10)', () => {
    const kept = existingRow('us', 'US.PDD260918P70000');
    const gone = existingRow('us', 'US.PEP260918P120000', OTHER_SEEN);
    const r = reportedRow('us', 'US.PDD260918P70000');
    const plan = planPositionSync({ existing: [kept, gone], reported: [r] });
    expect(plan.toDelete).toEqual([gone]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toUpdate).toEqual([{ reported: r, firstSeenAt: OLD_SEEN }]);
  });

  it('④ 空报告 (拉取成功且确实空仓) ⇒ 全部 delete (branch 9)', () => {
    const rows = [existingRow('hk', 'HK.00700'), existingRow('hk', 'HK.TCH260929C420000')];
    expect(planPositionSync({ existing: rows, reported: [] })).toEqual({
      toInsert: [],
      toUpdate: [],
      toDelete: rows,
    });
  });

  it('⑤ 指派形态: 期权消失 + 正股出现 ⇒ 1 delete + 1 insert', () => {
    const option = existingRow('us', 'US.PDD260918P70000');
    const stock = reportedRow('us', 'US.PDD', 100);
    expect(planPositionSync({ existing: [option], reported: [stock] })).toEqual({
      toInsert: [stock],
      toUpdate: [],
      toDelete: [option],
    });
  });

  it('键是 (market, code): 同一 code 串挂在不同市场 ⇒ 视为两条持仓', () => {
    const e = existingRow('us', 'SAME');
    const r = reportedRow('hk', 'SAME');
    expect(planPositionSync({ existing: [e], reported: [r] })).toEqual({
      toInsert: [r],
      toUpdate: [],
      toDelete: [e],
    });
  });

  it('报告里同一 (market, code) 出现两次 ⇒ 抛 (不静默丢掉其中一行)', () => {
    const r = reportedRow('us', 'US.PDD');
    expect(() => planPositionSync({ existing: [], reported: [r, { ...r }] })).toThrow(/US\.PDD/);
  });
});
