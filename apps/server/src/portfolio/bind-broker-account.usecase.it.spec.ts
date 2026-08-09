import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { BindBrokerAccountUseCase } from './bind-broker-account.usecase';
import { BrokerAccountDuplicateException } from './broker-account-duplicate.exception';
import { FormValidationException } from '../security/form-validation.exception';

// 控制字符测试用 \t (\x09, ∈ deny-list); trim 不吞中段, 故置于客户号中间。
// 用 fromCharCode 而非 literal 避免源码内裸控制符 (per memory author_invisible_chars_via_fromcharcode)。
const CLIENT_NO_WITH_CONTROL = `ab${String.fromCharCode(9)}cd`;

// 012 T005 US2: 绑定券商账户 (字典+禁字符校验 + 唯一性 dup→409)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('BindBrokerAccountUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: BindBrokerAccountUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new BindBrokerAccountUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(910_000 + ++seq);

  it('有效 brokerCode + clientNo → 201 落库 (raw 明文 + brokerName merge)', async () => {
    const accountId = nextAccountId();
    const item = await usecase.execute(accountId, 'htai', '3119000002466');

    expect(item).toMatchObject({
      brokerCode: 'htai',
      brokerName: '华泰证券',
      clientNo: '3119000002466',
      isDefault: false,
    });
    const count = await prisma.brokerAccount.count({ where: { accountId } });
    expect(count).toBe(1);
  });

  it('重复 POST 同 {brokerCode, clientNo} → 409 BROKER_ACCOUNT_DUPLICATE 不重复落库', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'zxzq', '88001234');
    await expect(usecase.execute(accountId, 'zxzq', '88001234')).rejects.toBeInstanceOf(
      BrokerAccountDuplicateException,
    );
    const count = await prisma.brokerAccount.count({ where: { accountId } });
    expect(count).toBe(1);
  });

  it('未知 brokerCode → 400 FormValidationException 不落库', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'nope', '123456')).rejects.toBeInstanceOf(
      FormValidationException,
    );
    expect(await prisma.brokerAccount.count({ where: { accountId } })).toBe(0);
  });

  it('clientNo trim 后空 → 400 FormValidationException', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'htai', '   ')).rejects.toBeInstanceOf(
      FormValidationException,
    );
  });

  it('clientNo 含控制字符 → 400 FormValidationException', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'htai', CLIENT_NO_WITH_CONTROL)).rejects.toBeInstanceOf(
      FormValidationException,
    );
  });

  it('同券商不同 clientNo → 均 201 (两条独立)', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'gtja', '1001');
    await usecase.execute(accountId, 'gtja', '1002');
    expect(await prisma.brokerAccount.count({ where: { accountId } })).toBe(2);
  });
});
