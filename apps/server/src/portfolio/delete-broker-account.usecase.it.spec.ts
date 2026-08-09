import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { DeleteBrokerAccountUseCase } from './delete-broker-account.usecase';
import { DefaultAccountNotDeletableException } from './default-account-not-deletable.exception';

// 012 T006 US3: 删除券商账户 (默认不可删 + 反枚举 404 + id 消歧)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('DeleteBrokerAccountUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: DeleteBrokerAccountUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new DeleteBrokerAccountUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(920_000 + ++seq);

  it('删本账号已绑 id → 204 (void) + 行不再存在', async () => {
    const accountId = nextAccountId();
    const row = await prisma.brokerAccount.create({
      data: { accountId, brokerCode: 'htai', clientNo: '111' },
    });
    await expect(usecase.execute(accountId, row.id)).resolves.toBeUndefined();
    expect(await prisma.brokerAccount.count({ where: { id: row.id } })).toBe(0);
  });

  it('删默认账户 (id=accountId) → 400 DEFAULT_ACCOUNT_NOT_DELETABLE 列表不变', async () => {
    const accountId = nextAccountId();
    await prisma.brokerAccount.create({ data: { accountId, brokerCode: 'zxzq', clientNo: '222' } });
    await expect(usecase.execute(accountId, accountId)).rejects.toBeInstanceOf(
      DefaultAccountNotDeletableException,
    );
    expect(await prisma.brokerAccount.count({ where: { accountId } })).toBe(1);
  });

  it('删不存在 id → 404 NotFoundException', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, BigInt(99_999_999))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('删他人账号已绑 id → 404 (反枚举, 他人行不动)', async () => {
    const accountId = nextAccountId();
    const otherId = nextAccountId();
    const otherRow = await prisma.brokerAccount.create({
      data: { accountId: otherId, brokerCode: 'dfcf', clientNo: '333' },
    });
    await expect(usecase.execute(accountId, otherRow.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.brokerAccount.count({ where: { id: otherRow.id } })).toBe(1);
  });

  it('幂等: 删已删 id → 404 NotFoundException', async () => {
    const accountId = nextAccountId();
    const row = await prisma.brokerAccount.create({
      data: { accountId, brokerCode: 'gtja', clientNo: '444' },
    });
    await usecase.execute(accountId, row.id);
    await expect(usecase.execute(accountId, row.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('真实 broker 行 id 数值 == accountId → 先 scoped-delete 命中 204 不误判默认 (D3)', async () => {
    const accountId = nextAccountId();
    // 显式置 id == accountId, 制造 BigInt 空间碰撞 (默认虚拟 id 也是 accountId)。
    const row = await prisma.brokerAccount.create({
      data: { id: accountId, accountId, brokerCode: 'swhy', clientNo: '555' },
    });
    await expect(usecase.execute(accountId, row.id)).resolves.toBeUndefined();
    expect(await prisma.brokerAccount.count({ where: { accountId } })).toBe(0);
  });
});
