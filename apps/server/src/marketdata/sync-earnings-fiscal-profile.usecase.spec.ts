import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import {
  SyncEarningsFiscalProfileUseCase,
  type FiscalProfileSyncOutcome,
} from './sync-earnings-fiscal-profile.usecase.js';

/**
 * 批量入口 `syncHkAnchors` 的聚合与锚作用域 (079 T029, plan §D13 ②)。单标的读写语义 (一致写入 /
 * 矛盾无行 / 已有档案矛盾不覆盖) 由 `test/integration/marketdata-079.earnings-dates.it.spec.ts` 真 PG 校验。
 */
describe('SyncEarningsFiscalProfileUseCase.syncHkAnchors', () => {
  it('只取港股锚 (loadAnchoredInstruments 口径), 按单标的结局聚合 written / pending / conflicts', async () => {
    const anchorFindMany = vi.fn(async () => [
      { ticker: 'hk:00001' },
      { ticker: 'hk:00002' },
      { ticker: 'hk:00003' },
      { ticker: 'hk:00004' },
      { ticker: 'us:AAPL' },
    ]);
    const instrumentFindMany = vi.fn(async (_args: unknown) =>
      ['00001', '00002', '00003', '00004'].map((code, i) => ({
        id: BigInt(i + 1),
        market: 'hk',
        code,
      })),
    );
    const prisma = {
      anchor: { findMany: anchorFindMany },
      instrument: { findMany: instrumentFindMany },
    } as unknown as PrismaService;
    const usecase = new SyncEarningsFiscalProfileUseCase(prisma);
    const outcomes: FiscalProfileSyncOutcome[] = [
      { kind: 'written', month: 12, source: 'annual_title' },
      { kind: 'pending', pending: 'none', detail: '推不出' },
      { kind: 'conflict', profileMonth: 12, detail: '档案 12 月 ≠ 年度业绩标题 6 月' },
      { kind: 'unchanged', month: 3 },
    ];
    const syncInstrument = vi
      .spyOn(usecase, 'syncInstrument')
      .mockImplementation(async (instrument) => outcomes[Number(instrument.id) - 1]);

    const result = await usecase.syncHkAnchors(new Date('2026-09-13T15:30:00Z'));

    expect(result).toEqual({
      written: 1,
      pending: [{ ticker: 'hk:00002', pending: 'none', detail: '推不出' }],
      conflicts: [{ ticker: 'hk:00003', detail: '档案 12 月 ≠ 年度业绩标题 6 月' }],
    });
    expect(syncInstrument).toHaveBeenCalledTimes(4);
    // 标的查询只按港股代码筛 —— us 锚不进作用域。
    expect(JSON.stringify(instrumentFindMany.mock.calls[0][0])).not.toContain('AAPL');
  });
});
