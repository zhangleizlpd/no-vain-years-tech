import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import type { Redis } from 'ioredis';
import { PrismaService } from '../security/prisma.service';
import { EvaluateIntradayAlertsUseCase } from './evaluate-intraday-alerts.usecase';
import type { RealtimeQuotePort } from './realtime-quote.port';
import type { RealtimeQuote } from './realtime-quote.rules';

/**
 * 内存 Redis 替身: 仅 hash 三操作 (UC 上一 tick 快照用 hgetall/hset/expire)。
 * 跨同一实例的多 tick 调用保留 hash 态 (5min 差分两 tick 链路验证); expire no-op (TTL 行为不入测)。
 */
function makeRedis(): Redis {
  const store = new Map<string, Record<string, string>>();
  return {
    hgetall: async (key: string) => ({ ...(store.get(key) ?? {}) }),
    hset: async (key: string, obj: Record<string, string>) => {
      store.set(key, { ...(store.get(key) ?? {}), ...obj });
      return 0;
    },
    expire: async () => 1,
  } as unknown as Redis;
}

// 024 T009/T010: 盘中实时求值 UC (Testcontainers PG + mock 实时 port + 内存 Redis 快照, 无外部
// 请求)。覆盖: 到价命中 → 触发写流水 (priceContext:'intraday' 快照) + push fan-out PENDING /
// 盘中触发后同日再 tick 幂等 skip (P2002) / 拉取集仅含 intradayEligible 标的 (纯 EOD 预警标的不入
// tick) / 缺标的实时价跳过 / PRICE_FALL_TO 现价口径 / T010 5min 差分 (首 tick 无快照不触发 → 次
// tick 相邻涨幅达阈触发 + 未达阈不触发)。run via `nx test server <file>` (cwd=apps/server)。
describe('EvaluateIntradayAlertsUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alertTrigger.deleteMany();
    await prisma.alert.deleteMany();
  });

  const TRADE_DATE = '2026-06-09';
  const nextAccountId = (): bigint => BigInt(940_000 + ++seq);

  /** mock 实时 port: 按符号查表返报价 (缺表 → 该符号不返, 模拟无效码); 记录被拉取的符号集。 */
  function mockPort(table: Record<string, { price: number; prevClose: number; name?: string }>): {
    port: RealtimeQuotePort;
    fetched: string[];
  } {
    const fetched: string[] = [];
    const port: RealtimeQuotePort = {
      fetchQuotes: async (symbols) => {
        fetched.push(...symbols);
        const m = new Map<string, RealtimeQuote>();
        for (const s of symbols) {
          const q = table[s];
          if (q) {
            m.set(s, {
              symbol: s,
              name: q.name ?? `名-${s}`,
              price: q.price,
              prevClose: q.prevClose,
              changePct: 0,
            });
          }
        }
        return m;
      },
    };
    return { port, fetched };
  }

  async function seedAlert(
    accountId: bigint,
    code: string,
    conditions: Array<{ type: string; threshold?: string | null; param?: number }>,
    opts: { frequency?: string; enabled?: boolean } = {},
  ) {
    return prisma.alert.create({
      data: {
        accountId,
        market: 'cn',
        code,
        frequency: opts.frequency ?? 'DAILY',
        note: null,
        enabled: opts.enabled ?? true,
        conditions: {
          create: conditions.map((c) => ({
            type: c.type,
            threshold: c.threshold ?? null,
            param: c.param ?? 0,
          })),
        },
      },
    });
  }

  const seedBinding = (accountId: bigint, registrationId: string) =>
    prisma.pushBinding.create({ data: { accountId, registrationId, platform: 'android' } });

  it('到价命中 → 触发写流水 (priceContext:intraday 快照) + push fan-out PENDING', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_TO', threshold: '50' }]);
    await seedBinding(accountId, 'reg-A');
    const { port, fetched } = mockPort({
      sh600519: { price: 55, prevClose: 48, name: '贵州茅台' },
    });
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);

    expect(summary).toEqual({ fetched: 1, triggered: 1, skippedDuplicate: 0, skippedNoData: 0 });
    expect(fetched).toEqual(['sh600519']);
    const triggers = await prisma.alertTrigger.findMany();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.instrumentName).toBe('贵州茅台');
    expect(triggers[0]!.tradeDate.toISOString().slice(0, 10)).toBe(TRADE_DATE);
    const snap = triggers[0]!.conditionsSnapshot as Array<Record<string, unknown>>;
    expect(snap[0]!.priceContext).toBe('intraday');
    expect(snap[0]!.actual).toBe('55.0000'); // 现价喂 high → PRICE_RISE_TO actual
    const deliveries = await prisma.pushDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('PENDING');
  });

  it('PRICE_FALL_TO: 现价 ≤ 阈值 → 命中 (现价喂 low 口径)', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '000001', [{ type: 'PRICE_FALL_TO', threshold: '12' }]);
    const { port } = mockPort({ sz000001: { price: 11.5, prevClose: 13 } });
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);
    expect(summary.triggered).toBe(1);
    const snap = (await prisma.alertTrigger.findFirst())!.conditionsSnapshot as Array<
      Record<string, unknown>
    >;
    expect(snap[0]!.actual).toBe('11.5000');
  });

  it('盘中触发后同日再 tick → P2002 幂等 skip, 不重复写流水', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_TO', threshold: '50' }]);
    const { port } = mockPort({ sh600519: { price: 55, prevClose: 48 } });
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const first = await uc.execute(TRADE_DATE);
    expect(first.triggered).toBe(1);
    const second = await uc.execute(TRADE_DATE); // 同日第二 tick
    expect(second).toMatchObject({ triggered: 0, skippedDuplicate: 1 });
    expect(await prisma.alertTrigger.count()).toBe(1);
  });

  it('拉取集仅含 intradayEligible 标的 — 纯 EOD 预警标的不进 tick', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_TO', threshold: '50' }]); // 到价 → 盘中
    await seedAlert(accountId, '000002', [{ type: 'DAILY_GAIN_OVER', threshold: '5' }]); // 纯 EOD
    const { port, fetched } = mockPort({ sh600519: { price: 55, prevClose: 48 } });
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);
    expect(summary.fetched).toBe(1); // 仅 600519
    expect(fetched).toEqual(['sh600519']); // sz000002 不被拉取
    expect(summary.triggered).toBe(1);
  });

  it('缺标的实时价 (vendor 未返符号) → skippedNoData, 不触发', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_TO', threshold: '50' }]);
    const { port } = mockPort({}); // 空表 → 符号无返
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);
    expect(summary).toMatchObject({ fetched: 1, triggered: 0, skippedNoData: 1 });
    expect(await prisma.alertTrigger.count()).toBe(0);
  });

  it('未达阈值 → 不命中不触发', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_TO', threshold: '60' }]);
    const { port } = mockPort({ sh600519: { price: 55, prevClose: 48 } });
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);
    expect(summary.triggered).toBe(0);
    expect(await prisma.alertTrigger.count()).toBe(0);
  });

  it('无 intradayEligible 预警 → 零拉取零源调用', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '000002', [{ type: 'DAILY_GAIN_OVER', threshold: '5' }]);
    const { port, fetched } = mockPort({});
    const uc = new EvaluateIntradayAlertsUseCase(prisma, port, makeRedis());

    const summary = await uc.execute(TRADE_DATE);
    expect(summary.fetched).toBe(0);
    expect(fetched).toEqual([]); // port 未被调用
  });

  it('5min 涨超: 首 tick 无快照 → 不触发; 次 tick 现价较上 tick +3% ≥ 阈 → 触发', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_5MIN_OVER', threshold: '3' }]);
    const redis = makeRedis(); // 同实例跨两 tick 保留快照

    // 首 tick: lasttick 无键 → 差分类跳过, 但本 tick 价写入快照
    const tick1 = mockPort({ sh600519: { price: 100, prevClose: 99 } });
    const s1 = await new EvaluateIntradayAlertsUseCase(prisma, tick1.port, redis).execute(
      TRADE_DATE,
    );
    expect(s1.triggered).toBe(0);
    expect(await prisma.alertTrigger.count()).toBe(0);

    // 次 tick: 100 → 103 (+3%) ≥ 阈 3 → 命中触发
    const tick2 = mockPort({ sh600519: { price: 103, prevClose: 99 } });
    const s2 = await new EvaluateIntradayAlertsUseCase(prisma, tick2.port, redis).execute(
      TRADE_DATE,
    );
    expect(s2.triggered).toBe(1);
    const snap = (await prisma.alertTrigger.findFirst())!.conditionsSnapshot as Array<
      Record<string, unknown>
    >;
    expect(snap[0]!.type).toBe('PRICE_RISE_5MIN_OVER');
    expect(snap[0]!.priceContext).toBe('intraday');
    expect(snap[0]!.actual).toBe('3.0000');
  });

  it('5min 涨超: 次 tick 涨幅未达阈值 → 不触发', async () => {
    const accountId = nextAccountId();
    await seedAlert(accountId, '600519', [{ type: 'PRICE_RISE_5MIN_OVER', threshold: '5' }]);
    const redis = makeRedis();
    await new EvaluateIntradayAlertsUseCase(
      prisma,
      mockPort({ sh600519: { price: 100, prevClose: 99 } }).port,
      redis,
    ).execute(TRADE_DATE);
    const s2 = await new EvaluateIntradayAlertsUseCase(
      prisma,
      mockPort({ sh600519: { price: 102, prevClose: 99 } }).port, // +2% < 阈 5
      redis,
    ).execute(TRADE_DATE);
    expect(s2.triggered).toBe(0);
    expect(await prisma.alertTrigger.count()).toBe(0);
  });
});
