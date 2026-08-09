import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { InspectWechatBindingUseCase } from './inspect-wechat-binding.usecase';

// T007: 微信绑定存在性只读探查 (两段式委托读半段)。
// run via `nx test server <file>` (cwd=apps/server)。
describe('InspectWechatBindingUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: InspectWechatBindingUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new InspectWechatBindingUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextPhone = () => `+861380020${String(++seq).padStart(4, '0')}`;
  const nextOpenid = () => `oINSP${String(++seq).padStart(23, '0')}`;
  const newAccount = () =>
    prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });

  it('WECHAT 绑定存在 → bound:true', async () => {
    const acc = await newAccount();
    await prisma.wechatBinding.create({
      data: { accountId: acc.id, provider: 'WECHAT', openid: nextOpenid() },
    });
    expect(await usecase.execute(acc.id)).toEqual({ bound: true });
  });

  it('无绑定 → bound:false', async () => {
    const acc = await newAccount();
    expect(await usecase.execute(acc.id)).toEqual({ bound: false });
  });

  it('跨 provider 隔离: 仅有 OTHER provider 绑定 → WECHAT bound:false 不误判', async () => {
    const acc = await newAccount();
    await prisma.wechatBinding.create({
      data: { accountId: acc.id, provider: 'OTHER', openid: nextOpenid() },
    });
    expect(await usecase.execute(acc.id)).toEqual({ bound: false });
  });
});
