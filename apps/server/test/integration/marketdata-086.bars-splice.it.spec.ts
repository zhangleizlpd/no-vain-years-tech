import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { RegisterSymbolChangeUseCase } from '../../src/marketdata/register-symbol-change.usecase';
import { RevokeSymbolChangeUseCase } from '../../src/marketdata/revoke-symbol-change.usecase';
import { SYMBOL_CHANGE_SOURCE } from '../../src/marketdata/symbol-lineage.rules';

// 086 marketdata 代码变更 IT —— 登记 / 撤销 (T003)、标的行补齐 (T004)、日线读时拼接 (T005 起)。
//
// 为什么必须真 PG: 登记的并发守门人是**部分唯一索引** `uk_symbol_change_active`
// (`WHERE revoked_at IS NULL`, 迁移手写, Prisma schema 表达不了), P2002 折叠与「撤销后同参数
// 可重登」都只有真库才成立; 撤销是 conditional UPDATE + affected-count, 同理。
//
// 装配 = 直接 new usecase + 真 PrismaService (体例同 optionsdesk-045.anchor.it.spec.ts): use case
// 是贫血 class、无 lifecycle 语义, 验证面是落库口径。代码一律合成值。
describe('086 marketdata 代码变更 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let register: RegisterSymbolChangeUseCase;
  let revoke: RevokeSymbolChangeUseCase;

  /** us 交易所当地 2026-10-16 白天 (UTC 16:00 = 美东 12:00)。 */
  const NOW = new Date('2026-10-16T16:00:00Z');
  const base = {
    market: 'us',
    source: SYMBOL_CHANGE_SOURCE.MANUAL,
    evidence: 'https://example.invalid/notice',
    registeredBy: 'it-maintainer',
  };

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    register = new RegisterSymbolChangeUseCase(prisma);
    revoke = new RevokeSymbolChangeUseCase(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.drop();
  });

  describe('T003 登记 / 撤销 (FR-001 / FR-002 / FR-003 / FR-009)', () => {
    it('登记 → 读 → 撤销 → 同参数重登记成功; 撤销痕迹保留', async () => {
      const key = { oldCode: 'AAA', newCode: 'BBB', effectiveDate: '2026-07-01' };
      const first = await register.execute({ ...base, ...key }, NOW);
      expect(first.status).toBe('registered');

      const listed = await register.list('us');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        ...key,
        market: 'us',
        eventType: 'rename',
        source: 'manual',
        evidence: base.evidence,
        registeredBy: 'it-maintainer',
        revokedAt: null,
      });

      const revoked = await revoke.execute(
        {
          market: 'us',
          oldCode: 'AAA',
          effectiveDate: '2026-07-01',
          revokedBy: 'it-maintainer',
          reason: '误登记',
        },
        NOW,
      );
      expect(revoked).toEqual({ status: 'revoked' });

      const again = await register.execute({ ...base, ...key }, NOW);
      expect(again.status).toBe('registered');
      if (first.status === 'registered' && again.status === 'registered') {
        expect(again.id).not.toBe(first.id);
      }

      const all = await register.list('us');
      expect(all).toHaveLength(2);
      expect(all.filter((r) => r.revokedAt !== null)).toEqual([
        expect.objectContaining({ ...key, revokedBy: 'it-maintainer', revokeReason: '误登记' }),
      ]);
    });

    it('同参数重复登记 ⇒ already_exists 同 id, 库里仍一行', async () => {
      const input = { ...base, oldCode: 'CCC', newCode: 'DDD', effectiveDate: '2026-06-01' };
      const a = await register.execute(input, NOW);
      const b = await register.execute(input, NOW);
      expect(a.status).toBe('registered');
      expect(b).toEqual({ status: 'already_exists', id: a.status === 'registered' ? a.id : -1n });
      expect(await prisma.symbolChange.count({ where: { oldCode: 'CCC' } })).toBe(1);
    });

    it('并发两路同参数登记 ⇒ 一路 registered、一路 already_exists (P2002 折叠), 一行', async () => {
      const input = { ...base, oldCode: 'EEE', newCode: 'FFF', effectiveDate: '2026-05-01' };
      const results = await Promise.all([
        register.execute(input, NOW),
        register.execute(input, NOW),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['already_exists', 'registered']);
      expect(await prisma.symbolChange.count({ where: { oldCode: 'EEE' } })).toBe(1);
    });

    it('非法登记 ⇒ rejected 且零写入 (生效日晚于交易所当地今天 / 同键不同新码)', async () => {
      const future = await register.execute(
        { ...base, oldCode: 'GGG', newCode: 'HHH', effectiveDate: '2026-10-17' },
        NOW,
      );
      expect(future).toMatchObject({ status: 'rejected', reason: 'future_effective_date' });

      const dup = await register.execute(
        { ...base, oldCode: 'CCC', newCode: 'ZZZ', effectiveDate: '2026-06-01' },
        NOW,
      );
      expect(dup).toMatchObject({ status: 'rejected', reason: 'duplicate' });
      expect(await prisma.symbolChange.count({ where: { oldCode: { in: ['GGG'] } } })).toBe(0);
      expect(await prisma.symbolChange.count({ where: { newCode: 'ZZZ' } })).toBe(0);
    });

    it('重复撤销 ⇒ already_revoked; 从未登记 ⇒ not_found', async () => {
      await register.execute(
        { ...base, oldCode: 'JJJ', newCode: 'KKK', effectiveDate: '2026-04-01' },
        NOW,
      );
      const key = {
        market: 'us',
        oldCode: 'JJJ',
        effectiveDate: '2026-04-01',
        revokedBy: 'it',
        reason: 'r',
      };
      expect(await revoke.execute(key, NOW)).toEqual({ status: 'revoked' });
      expect(await revoke.execute(key, NOW)).toEqual({ status: 'already_revoked' });
      expect(await revoke.execute({ ...key, oldCode: 'NOPE' }, NOW)).toEqual({
        status: 'not_found',
      });
    });
  });
});
