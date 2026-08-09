import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import { SyncUniverseUseCase } from './sync-universe.usecase.js';

/**
 * 038 T004 currency 按 market 单测: sync-universe upsert 的 create.currency 从 hardcode 'CNY'
 * → 按标的 market 取 (cn→CNY / hk→HKD)。仅 insert 分支写 currency (update 分支护下游, FR-S03)。
 */

function buildUseCase(entries: UniverseEntry[]): {
  useCase: SyncUniverseUseCase;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => ({}));
  const prisma = {
    // S2-T2: run() 读 universe 维度 marketScope 驱动 enumerate (mock universe 忽略入参返固定 entries)。
    syncDimension: { findUnique: vi.fn(async () => ({ marketScope: ['cn', 'hk'] })) },
    syncBlacklist: { findMany: vi.fn(async () => []) },
    instrument: { upsert },
  } as unknown as PrismaService;
  const universe = {
    enumerate: vi.fn(async () => entries),
  } as unknown as InstrumentUniversePort;
  return { useCase: new SyncUniverseUseCase(universe, prisma), upsert };
}

/** 取某 code 的 upsert create.currency (断言辅助)。 */
function currencyOf(upsert: ReturnType<typeof vi.fn>, code: string): unknown {
  const call = upsert.mock.calls.find(
    (c) => (c[0] as { create: { code: string } }).create.code === code,
  );
  return (call?.[0] as { create: { currency: unknown } }).create.currency;
}

describe('SyncUniverseUseCase — 038 T004 / S2-T3 currency 按 market', () => {
  it('hk → HKD; us → USD; cn → CNY', async () => {
    const { useCase, upsert } = buildUseCase([
      { market: 'cn', code: '600519', name: '贵州茅台' },
      { market: 'hk', code: '00700', name: '腾讯控股' },
      { market: 'us', code: 'AAPL', name: '苹果' },
    ]);

    const stats = await useCase.run();

    expect(stats.ok).toBe(3);
    expect(currencyOf(upsert, '600519')).toBe('CNY');
    expect(currencyOf(upsert, '00700')).toBe('HKD');
    expect(currencyOf(upsert, 'AAPL')).toBe('USD');
  });
});
