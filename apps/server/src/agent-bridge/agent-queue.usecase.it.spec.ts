import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../security/prisma.service';
import { JwtTokenService } from '../security/jwt-token.service';
import { ClaimNextEventUseCase } from './claim-next-event.usecase';
import { ExtendLeaseUseCase } from './extend-lease.usecase';
import { CompleteEventUseCase } from './complete-event.usecase';

/**
 * P1.4 agent-queue usecase IT (Testcontainers PG)。验队列核心不变量:
 * ① 原子 claim 零双投递 (FOR UPDATE SKIP LOCKED) ② 租约可见性超时重投递 + attempts 递增
 * ③ 委托 token 编码 accountId ④ ack 续租 ⑤ result 终态 + 幂等闸。
 */

describe('agent-queue usecases IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let claim: ClaimNextEventUseCase;
  let extend: ExtendLeaseUseCase;
  let complete: CompleteEventUseCase;
  const jwt = new JwtTokenService(new JwtService({ secret: 'test-secret' }));

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    claim = new ClaimNextEventUseCase(prisma, jwt);
    extend = new ExtendLeaseUseCase(prisma);
    complete = new CompleteEventUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.agentQueueEvent.deleteMany({});
  });

  async function seedPending(accountId: bigint, bizId: string) {
    return prisma.agentQueueEvent.create({
      data: { accountId, bizType: 'ideation.requirement', bizId },
    });
  }

  it('原子 claim: 5 并发 poll → 零双投递, 全部被 claim', async () => {
    for (let i = 0; i < 5; i++) await seedPending(100n + BigInt(i), `biz-${i}`);

    const results = await Promise.all(Array.from({ length: 5 }, () => claim.execute()));
    const claimedIds = results.map((r) => r?.eventId).filter((id): id is string => !!id);

    expect(new Set(claimedIds).size).toBe(claimedIds.length); // 核心: 无重复 (零双 claim)
    expect(claimedIds.length).toBe(5);
    expect(await prisma.agentQueueEvent.count({ where: { status: 'claimed' } })).toBe(5);
    expect(await claim.execute()).toBeNull(); // 无剩余 claimable
  });

  it('租约: claim 后租约内不可再 claim; 过期则重新可见 + attempts 递增', async () => {
    const ev = await seedPending(200n, 'biz-lease');

    expect((await claim.execute())?.eventId).toBe(ev.id);
    expect(await claim.execute()).toBeNull(); // 租约内不可见

    await prisma.agentQueueEvent.update({
      where: { id: ev.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) }, // 手动让租约过期
    });

    expect((await claim.execute())?.eventId).toBe(ev.id); // 重新可见
    const row = await prisma.agentQueueEvent.findUnique({ where: { id: ev.id } });
    expect(row?.attempts).toBe(2);
  });

  it('委托 token 编码 accountId (verifyAccess 可还原)', async () => {
    const ev = await seedPending(12345n, 'biz-token');
    const claimed = await claim.execute();
    expect(claimed?.eventId).toBe(ev.id);
    expect(jwt.verifyAccess(claimed!.delegationToken).accountId).toBe(12345n);
  });

  it('ack: 仅 claimed 可续租 (pending → null); 续后租约推后', async () => {
    const ev = await seedPending(300n, 'biz-ack');
    expect(await extend.execute(ev.id)).toBeNull(); // pending 不可续

    const claimed = await claim.execute();
    const extended = await extend.execute(ev.id);
    expect(extended).not.toBeNull();
    expect(extended!.getTime()).toBeGreaterThanOrEqual(claimed!.leaseExpiresAt.getTime());
  });

  it('result SUCCESS: claimed→done + 存产物; 重复 result → false (幂等闸)', async () => {
    const ev = await seedPending(400n, 'biz-result');
    expect(await complete.execute(ev.id, 'SUCCESS', { url: 'x' })).toBe(false); // 未 claim 不可终态

    await claim.execute();
    expect(await complete.execute(ev.id, 'SUCCESS', { url: 'https://oss/mockup.html' })).toBe(true);

    const row = await prisma.agentQueueEvent.findUnique({ where: { id: ev.id } });
    expect(row?.status).toBe('done');
    expect(row?.result).toEqual({ url: 'https://oss/mockup.html' });
    expect(row?.doneAt).not.toBeNull();

    expect(await complete.execute(ev.id, 'SUCCESS', { url: 'y' })).toBe(false); // 已 done → 非 claimed
  });

  it('result FAILURE: claimed→failed', async () => {
    const ev = await seedPending(500n, 'biz-fail');
    await claim.execute();
    expect(await complete.execute(ev.id, 'FAILURE')).toBe(true);
    const row = await prisma.agentQueueEvent.findUnique({ where: { id: ev.id } });
    expect(row?.status).toBe('failed');
  });
});
