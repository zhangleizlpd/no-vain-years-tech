import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { ListMessagesUseCase } from './list-messages.usecase';
import { GetUnreadCountUseCase } from './get-unread-count.usecase';
import { MarkMessagesReadUseCase } from './mark-messages-read.usecase';

// 021 T005 US3: 消息三 UC (列表 EP6 / 未读计数 EP7 / 置已读 EP8, 水位线语义 plan D6)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('alert message usecases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let listMessages: ListMessagesUseCase;
  let unreadCount: GetUnreadCountUseCase;
  let markRead: MarkMessagesReadUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    listMessages = new ListMessagesUseCase(prisma);
    unreadCount = new GetUnreadCountUseCase(prisma);
    markRead = new MarkMessagesReadUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(940_000 + ++seq);
  let alertSeq = 0;

  /** 直插 trigger 行 (评估引擎 PR-2 才落; 快照形 = plan §数据模型 canonical)。 */
  const seedTrigger = (
    accountId: bigint,
    overrides: { triggeredAt?: Date; tradeDate?: Date; code?: string; note?: string | null } = {},
  ) =>
    prisma.alertTrigger.create({
      data: {
        alertId: BigInt(880_000 + ++alertSeq), // 唯一键 (alertId, tradeDate) 避撞
        accountId,
        market: 'cn',
        code: overrides.code ?? '603305',
        instrumentName: '旭升集团',
        tradeDate: overrides.tradeDate ?? new Date('2026-06-05'),
        conditionsSnapshot: [{ type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' }],
        frequencySnapshot: 'DAILY',
        noteSnapshot: overrides.note === undefined ? '低吸观察' : overrides.note,
        ...(overrides.triggeredAt ? { triggeredAt: overrides.triggeredAt } : {}),
      },
    });

  it('零消息: 列表空 + nextCursor null + 未读 0', async () => {
    const accountId = nextAccountId();
    expect(await listMessages.execute(accountId)).toEqual({ messages: [], nextCursor: null });
    expect(await unreadCount.execute(accountId)).toEqual({ unread: 0 });
  });

  it('无水位线行 = 全未读; 投影含快照字段 (tradeDate 日期串 / conditions 三元组 / note)', async () => {
    const accountId = nextAccountId();
    const row = await seedTrigger(accountId);

    expect(await unreadCount.execute(accountId)).toEqual({ unread: 1 });
    const { messages } = await listMessages.execute(accountId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      id: row.id.toString(),
      market: 'cn',
      code: '603305',
      instrumentName: '旭升集团',
      tradeDate: '2026-06-05',
      conditions: [{ type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' }],
      note: '低吸观察',
      triggeredAt: row.triggeredAt.toISOString(),
      unread: true,
    });
  });

  // 023 T003 (plan D7): 快照扩展 {type, param?, threshold?, actual, dataDate?}
  it('023 新 shape 快照透传 (param/dataDate; threshold null); 旧 shape 兼容由上例覆盖', async () => {
    const accountId = nextAccountId();
    await prisma.alertTrigger.create({
      data: {
        alertId: BigInt(880_000 + ++alertSeq),
        accountId,
        market: 'cn',
        code: '603305',
        instrumentName: '旭升集团',
        tradeDate: new Date('2026-06-05'),
        conditionsSnapshot: [
          { type: 'MA_CROSS_UP', param: 20, threshold: null, actual: '12.5000' },
          { type: 'PE_BELOW', threshold: '10.0000', actual: '8.5000', dataDate: '2026-06-04' },
        ],
        frequencySnapshot: 'DAILY',
        noteSnapshot: null,
      },
    });

    const { messages } = await listMessages.execute(accountId);
    expect(messages[0].conditions).toEqual([
      { type: 'MA_CROSS_UP', param: 20, threshold: null, actual: '12.5000' },
      { type: 'PE_BELOW', threshold: '10.0000', actual: '8.5000', dataDate: '2026-06-04' },
    ]);
  });

  // 024 T003 (plan D7): 盘中触发快照携带 priceContext='intraday'; 旧 EOD 消息缺键兜底
  it('024 priceContext 透传 (intraday 携带 / eod 旧 shape 缺键省略)', async () => {
    const accountId = nextAccountId();
    await prisma.alertTrigger.create({
      data: {
        alertId: BigInt(880_000 + ++alertSeq),
        accountId,
        market: 'cn',
        code: '603305',
        instrumentName: '旭升集团',
        tradeDate: new Date('2026-06-05'),
        conditionsSnapshot: [
          {
            type: 'PRICE_RISE_5MIN_OVER',
            threshold: '3.0000',
            actual: '3.4000',
            priceContext: 'intraday',
          },
        ],
        frequencySnapshot: 'DAILY',
        noteSnapshot: null,
      },
    });

    const { messages } = await listMessages.execute(accountId);
    // 盘中快照透传 priceContext;旧 EOD 快照 (seedTrigger 默认无该键) 不带该字段
    expect(messages[0].conditions).toEqual([
      {
        type: 'PRICE_RISE_5MIN_OVER',
        threshold: '3.0000',
        actual: '3.4000',
        priceContext: 'intraday',
      },
    ]);
    expect(messages[0].conditions[0]).not.toHaveProperty('priceContext', 'eod');
  });

  it('mark-read → {unread:0} + 计数归零 + 列表 unread 全 false', async () => {
    const accountId = nextAccountId();
    await seedTrigger(accountId);
    await seedTrigger(accountId, { code: '600519' });

    expect(await markRead.execute(accountId)).toEqual({ unread: 0 });
    expect(await unreadCount.execute(accountId)).toEqual({ unread: 0 });
    const { messages } = await listMessages.execute(accountId);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => !m.unread)).toBe(true);
  });

  it('mark-read 后新 trigger → 仅新条未读 (水位线推进非清空)', async () => {
    const accountId = nextAccountId();
    await seedTrigger(accountId);
    await markRead.execute(accountId);
    // 水位线 = now; 新触发显式落在其后
    const fresh = await seedTrigger(accountId, {
      code: '600519',
      triggeredAt: new Date(Date.now() + 5_000),
    });

    expect(await unreadCount.execute(accountId)).toEqual({ unread: 1 });
    const { messages } = await listMessages.execute(accountId);
    expect(messages.map((m) => [m.id, m.unread])).toEqual([
      [fresh.id.toString(), true],
      [expect.any(String), false],
    ]);
  });

  it('triggeredAt 倒序 + keyset 分页三页走完 (limit 2, 5 条)', async () => {
    const accountId = nextAccountId();
    const base = Date.parse('2026-06-01T15:00:00.000Z');
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        await seedTrigger(accountId, {
          tradeDate: new Date(base + i * 86_400_000),
          triggeredAt: new Date(base + i * 86_400_000 + 3_600_000),
        }),
      );
    }
    const idsDesc = rows.map((r) => r.id.toString()).reverse();

    const page1 = await listMessages.execute(accountId, { limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(idsDesc.slice(0, 2));
    expect(page1.nextCursor).toBe(idsDesc[1]);

    const page2 = await listMessages.execute(accountId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.messages.map((m) => m.id)).toEqual(idsDesc.slice(2, 4));
    expect(page2.nextCursor).toBe(idsDesc[3]);

    const page3 = await listMessages.execute(accountId, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.messages.map((m) => m.id)).toEqual(idsDesc.slice(4));
    expect(page3.nextCursor).toBeNull();
  });

  it('账号隔离: 他账号 trigger 不可见不计数', async () => {
    const mine = nextAccountId();
    const theirs = nextAccountId();
    await seedTrigger(theirs);

    expect(await unreadCount.execute(mine)).toEqual({ unread: 0 });
    expect((await listMessages.execute(mine)).messages).toEqual([]);
  });

  it('非数字 cursor → 400 FORM_VALIDATION (field=cursor)', async () => {
    const accountId = nextAccountId();
    await expect(listMessages.execute(accountId, { cursor: 'abc' })).rejects.toThrow(
      FormValidationException,
    );
    await expect(listMessages.execute(accountId, { cursor: 'abc' })).rejects.toMatchObject({
      invalidAttributes: [{ field: 'cursor', messages: [expect.any(String)] }],
    });
  });
});
