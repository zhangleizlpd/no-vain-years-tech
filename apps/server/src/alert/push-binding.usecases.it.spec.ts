import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { UpsertPushBindingUseCase } from './upsert-push-binding.usecase';
import { DeletePushBindingUseCase } from './delete-push-binding.usecase';

// 022 T004 US3: 绑定双 UC (EP9 upsert 转绑 / EP10 scope 解绑)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('push binding usecases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let upsert: UpsertPushBindingUseCase;
  let del: DeletePushBindingUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    upsert = new UpsertPushBindingUseCase(prisma);
    del = new DeletePushBindingUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(930_000 + ++seq);
  const nextRegId = (): string => `regid-t004-${++seq}`;

  describe('UpsertPushBindingUseCase (EP9, clarify Q1 转绑语义)', () => {
    it('建绑: 新 regId → 落库 1 行 (accountId / platform 快照)', async () => {
      const accountId = nextAccountId();
      const regId = nextRegId();
      const row = await upsert.execute(accountId, { registrationId: regId, platform: 'android' });
      expect(row.accountId).toBe(accountId);
      expect(row.registrationId).toBe(regId);
      expect(row.platform).toBe('android');
      expect(await prisma.pushBinding.count({ where: { registrationId: regId } })).toBe(1);
    });

    it('同账号重报 → 不新增行, updatedAt 刷新 (幂等无 409)', async () => {
      const accountId = nextAccountId();
      const regId = nextRegId();
      const first = await upsert.execute(accountId, { registrationId: regId, platform: 'android' });
      await new Promise((r) => setTimeout(r, 10));
      const second = await upsert.execute(accountId, {
        registrationId: regId,
        platform: 'android',
      });
      expect(second.id).toBe(first.id);
      expect(second.accountId).toBe(accountId);
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      expect(await prisma.pushBinding.count({ where: { registrationId: regId } })).toBe(1);
    });

    it('他账号同 regId → 整体转绑当前账号 (旧绑定消失, 仍 1 行)', async () => {
      const accountA = nextAccountId();
      const accountB = nextAccountId();
      const regId = nextRegId();
      await upsert.execute(accountA, { registrationId: regId, platform: 'android' });
      const rebound = await upsert.execute(accountB, {
        registrationId: regId,
        platform: 'android',
      });
      expect(rebound.accountId).toBe(accountB);
      expect(await prisma.pushBinding.count({ where: { registrationId: regId } })).toBe(1);
      expect(await prisma.pushBinding.count({ where: { accountId: accountA } })).toBe(0);
    });
  });

  describe('DeletePushBindingUseCase (EP10, scope accountId 反枚举)', () => {
    it('本账号命中 → deleted 1; 再删 → 0 (幂等)', async () => {
      const accountId = nextAccountId();
      const regId = nextRegId();
      await upsert.execute(accountId, { registrationId: regId, platform: 'android' });
      expect(await del.execute(accountId, regId)).toBe(1);
      expect(await prisma.pushBinding.count({ where: { registrationId: regId } })).toBe(0);
      expect(await del.execute(accountId, regId)).toBe(0);
    });

    it('他人 regId / 不存在 regId → deleted 0 无杂音 (绑定原样保留)', async () => {
      const owner = nextAccountId();
      const other = nextAccountId();
      const regId = nextRegId();
      await upsert.execute(owner, { registrationId: regId, platform: 'android' });
      expect(await del.execute(other, regId)).toBe(0);
      expect(await del.execute(other, 'regid-t004-never-bound')).toBe(0);
      const kept = await prisma.pushBinding.findUnique({ where: { registrationId: regId } });
      expect(kept?.accountId).toBe(owner);
    });
  });
});
