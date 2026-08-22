import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { CompanyProfilePort } from './company-profile.port.js';
import { SyncProfileUseCase } from './sync-profile.usecase.js';

// #138: profile 与 universe 同批被蓄意豁免出 `written`, 一并撤销。
// 本维度的写**发生在 adapter 里** (`resolveFsTypes` 逐个 `updateMany` 回写 fsType), use case
// 自己不碰库 ⇒ 行数只能从 port 契约推: run() 的查询条件已把 `lixingerCompanyType: null` 钉死
// ⇒ 整批必为缓存未命中 ⇒ 每个解析成功的 code 都回写一行 ⇒ 落库行数 = `resolved.size`。
function buildUseCase(opts: { missing?: { market: string; code: string }[]; resolved?: string[] }) {
  const prisma = {
    syncDimension: { findUnique: vi.fn(async () => ({ marketScope: ['cn'] })) },
    instrument: { findMany: vi.fn(async () => opts.missing ?? []) },
  } as unknown as PrismaService;
  const resolveCompanyTypes = vi.fn(
    async () => new Map((opts.resolved ?? []).map((c) => [c, 'non_financial'])),
  );
  const profile = { resolveCompanyTypes } as unknown as CompanyProfilePort;
  return { useCase: new SyncProfileUseCase(profile, prisma), resolveCompanyTypes };
}

describe('SyncProfileUseCase — #138 written 埋点 (豁免已撤)', () => {
  it('🚨 无待富化标的 (早退) ⇒ written = 0 而非 null —— 那一轮确实跑了、确实一行没写', async () => {
    const { useCase, resolveCompanyTypes } = buildUseCase({ missing: [] });

    const stats = await useCase.run();

    expect(resolveCompanyTypes).not.toHaveBeenCalled();
    expect(stats.written).toBe(0);
  });

  it('2 个解析成功 / 1 个 vendor 未返 ⇒ written = 2 (= 回写行数, 非批大小)', async () => {
    const { useCase } = buildUseCase({
      missing: [
        { market: 'cn', code: '600519' },
        { market: 'cn', code: '000001' },
        { market: 'cn', code: '300692' },
      ],
      resolved: ['600519', '000001'],
    });

    const stats = await useCase.run();

    expect(stats.ok).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.written).toBe(2);
  });
});
