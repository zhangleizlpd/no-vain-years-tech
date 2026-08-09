import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ListBrokerAccountsUseCase } from './list-broker-accounts.usecase';

// 012 T004 US1: 列出券商账户 (默认置顶 + 跨账号隔离 + raw clientNo)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('ListBrokerAccountsUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: ListBrokerAccountsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new ListBrokerAccountsUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  // 每个测试用独立 accountId, 避免跨测试串扰。
  const nextAccountId = (): bigint => BigInt(900_000 + ++seq);

  it('新账号 (无券商行) → 仅默认账户一条 (isDefault, id=accountId, brokerCode/clientNo=null)', async () => {
    const accountId = nextAccountId();
    const { accounts } = await usecase.execute(accountId);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: accountId.toString(),
      brokerCode: null,
      brokerName: '默认账户',
      clientNo: null,
      isDefault: true,
      createdAt: null,
    });
  });

  it('本账号 2 已绑 + 他人 1 → 默认置顶 + 本账号 2 按 createdAt, 他人不可见, clientNo raw', async () => {
    const accountId = nextAccountId();
    const otherId = nextAccountId();
    await prisma.brokerAccount.create({
      data: { accountId, brokerCode: 'htai', clientNo: '3119000002466' },
    });
    await prisma.brokerAccount.create({
      data: { accountId, brokerCode: 'zxzq', clientNo: '88001234' },
    });
    await prisma.brokerAccount.create({
      data: { accountId: otherId, brokerCode: 'dfcf', clientNo: 'OTHER999' },
    });

    const { accounts } = await usecase.execute(accountId);

    expect(accounts).toHaveLength(3);
    // 默认置顶
    expect(accounts[0].isDefault).toBe(true);
    expect(accounts[0].id).toBe(accountId.toString());
    // 本账号 2 条按 createdAt asc, brokerName merge, clientNo raw 明文
    expect(accounts[1]).toMatchObject({
      brokerCode: 'htai',
      brokerName: '华泰证券',
      clientNo: '3119000002466',
      isDefault: false,
    });
    expect(accounts[2]).toMatchObject({
      brokerCode: 'zxzq',
      brokerName: '中信证券',
      clientNo: '88001234',
      isDefault: false,
    });
    // 他人账号不可见
    expect(accounts.some((a) => a.clientNo === 'OTHER999')).toBe(false);
  });
});
