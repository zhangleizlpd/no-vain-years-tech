import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { RegisterSymbolChangeUseCase } from '../../src/marketdata/register-symbol-change.usecase';
import { RevokeSymbolChangeUseCase } from '../../src/marketdata/revoke-symbol-change.usecase';
import { SYMBOL_CHANGE_SOURCE } from '../../src/marketdata/symbol-lineage.rules';
import { EnsureInstrumentUseCase } from '../../src/marketdata/ensure-instrument.usecase';
import { seedInstrumentCreateData } from '../../src/marketdata/sync-universe.usecase';
import {
  GetInstrumentBarsUseCase,
  type GetInstrumentBarsQuery,
} from '../../src/marketdata/get-instrument-bars.usecase';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';

// 086 marketdata 代码变更 IT —— 登记 / 撤销 (T003)、标的行补齐 (T004)、日线读时拼接 (T005 起)。
//
// 为什么必须真 PG: 登记的并发守门人是**部分唯一索引** `uk_symbol_change_active`
// (`WHERE revoked_at IS NULL`, 迁移手写, Prisma schema 表达不了), P2002 折叠与「撤销后同参数
// 可重登」都只有真库才成立; 撤销是 conditional UPDATE + affected-count, 同理。标的行补齐的
// 「并发两路只得一行」靠 `uk_instrument_market_code` + upsert, 也只有真库能证。
//
// 装配 = 直接 new usecase + 真 PrismaService (体例同 optionsdesk-045.anchor.it.spec.ts): use case
// 是贫血 class、无 lifecycle 语义, 验证面是落库口径。代码一律合成值。
describe('086 marketdata 代码变更 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let register: RegisterSymbolChangeUseCase;
  let revoke: RevokeSymbolChangeUseCase;
  let ensureInstrument: EnsureInstrumentUseCase;

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
    ensureInstrument = new EnsureInstrumentUseCase(prisma);
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

  describe('T004 同步补齐标的行 (FR-011; state_branches 16)', () => {
    it('① 不存在 ⇒ 建行, 字段与 seedInstrumentCreateData 一致', async () => {
      const res = await ensureInstrument.execute('us', 'NEWA');
      expect(res.status).toBe('created');
      const row = await prisma.instrument.findUniqueOrThrow({
        where: { market_code: { market: 'us', code: 'NEWA' } },
      });
      expect(row.id).toBe(res.id);
      expect(row).toMatchObject(seedInstrumentCreateData('us', 'NEWA'));
    });

    it('② 已存在 ⇒ existed 且零写入 (name / needSync / updatedAt 不变)', async () => {
      const pre = await prisma.instrument.create({
        data: {
          ...seedInstrumentCreateData('us', 'OLDB'),
          name: 'Synthetic B Inc',
          needSync: true,
        },
      });
      const res = await ensureInstrument.execute('us', 'OLDB');
      expect(res).toEqual({ status: 'existed', id: pre.id });
      const after = await prisma.instrument.findUniqueOrThrow({ where: { id: pre.id } });
      expect(after).toEqual(pre);
    });

    it('③ 并发两路补齐同一码 ⇒ 都不抛, 库里一行', async () => {
      const results = await Promise.all([
        ensureInstrument.execute('us', 'RACEC'),
        ensureInstrument.execute('us', 'RACEC'),
      ]);
      // 不断言两路各自的 status: 空 update 的 upsert 是「先读后写」, 后到的一路可能在 upsert 内部
      // 读到行而返回 created —— 那是 Prisma 的读写时序, 不是本 use case 的契约。
      expect(results[0].id).toBe(results[1].id);
      expect(await prisma.instrument.count({ where: { market: 'us', code: 'RACEC' } })).toBe(1);
    });
  });

  // 日线读时拼接 fixture: XAA → XBB @ 2026-07-04 (周六; 周五 07-03 无 bar)。两边都蓄意多造
  // 「不该被拼进来」的数据, 漏切段 / 漏下界都会显形:
  //   XAA 在生效日后仍有 bar (close 9x) 与因子 (07-07 ×5) —— 不属于旧段;
  //   XBB 在生效日前有自有 bar (06-30 close 55) 与因子 (06-15 ×7) —— 不属于新段 (branch 7)。
  // 期望拼接序列 (none): 06-29 30 · 06-30 15 · 07-01 16 · 07-02 17 | 07-06 18 · 07-07 12 · 07-08 13。
  describe('T005 日线读时拼接 (FR-003 / FR-004 / FR-006 / FR-007; SC-003 / SC-004)', () => {
    let bars: GetInstrumentBarsUseCase;
    /** ② 用改动前实现录下的基线 (inline snapshot), ③ 撤销后逐项比对。 */
    let baseline: unknown;

    const D = (s: string) => new Date(`${s}T00:00:00Z`);
    const bar = (instrumentId: bigint, tradeDate: string, close: string) => ({
      instrumentId,
      tradeDate: D(tradeDate),
      adjust: 'none',
      open: close,
      high: close,
      low: close,
      close,
      changePct: '1.0000',
      volume: '1000',
      amount: '10000.00',
    });

    /** 无登记基线覆盖的查询面: none / forward / backward × day / week × 有窗 / 无窗 + 未知码 404。 */
    const PROBES: GetInstrumentBarsQuery[] = [
      { symbol: 'us:XBB', adjust: 'none', period: 'day' },
      { symbol: 'us:XBB', adjust: 'forward', period: 'day' },
      {
        symbol: 'us:XBB',
        adjust: 'backward',
        period: 'week',
        from: '2026-06-30',
        to: '2026-07-07',
      },
      { symbol: 'us:XAA', adjust: 'forward', period: 'day', from: '2026-07-01' },
      { symbol: 'us:XAA', adjust: 'none', period: 'day', to: '2026-07-02' },
      { symbol: 'us:NOPEX', adjust: 'none', period: 'day' },
    ];
    const fingerprint = async (q: GetInstrumentBarsQuery) => {
      try {
        const r = await bars.execute(q);
        return { q, freshnessTier: r.freshnessTier, items: r.items.map((i) => JSON.stringify(i)) };
      } catch (e) {
        return { q, error: (e as Error).constructor.name };
      }
    };
    const runProbes = async () => {
      const out = [];
      for (const q of PROBES) out.push(await fingerprint(q));
      return out;
    };
    const closes = async (q: Omit<GetInstrumentBarsQuery, 'period'>) =>
      (await bars.execute({ ...q, period: 'day' })).items.map((i) => [i.tradeDate, i.close]);

    beforeAll(async () => {
      // 日历桩钉死「最近已收盘 session」, 让 freshnessTier 与墙钟解耦 (基线可重放)。
      const calendar = {
        lastClosedSession: async () => '2026-07-08',
      } as unknown as TradingCalendarPort;
      bars = new GetInstrumentBarsUseCase(prisma, calendar);

      const xaa = await prisma.instrument.create({ data: seedInstrumentCreateData('us', 'XAA') });
      const xbb = await prisma.instrument.create({ data: seedInstrumentCreateData('us', 'XBB') });
      await prisma.dailyBar.createMany({
        data: [
          bar(xaa.id, '2026-06-29', '30'),
          bar(xaa.id, '2026-06-30', '15'),
          bar(xaa.id, '2026-07-01', '16'),
          bar(xaa.id, '2026-07-02', '17'),
          bar(xaa.id, '2026-07-06', '99'),
          bar(xaa.id, '2026-07-07', '98'),
          bar(xaa.id, '2026-07-08', '97'),
          bar(xbb.id, '2026-06-30', '55'),
          bar(xbb.id, '2026-07-06', '18'),
          bar(xbb.id, '2026-07-07', '12'),
          bar(xbb.id, '2026-07-08', '13'),
        ],
      });
      const factor = (instrumentId: bigint, exDate: string, factorBackward: string) => ({
        instrumentId,
        exDate: D(exDate),
        factorBackward,
        source: 'event_terms',
        status: 'verified',
      });
      await prisma.adjustmentFactor.createMany({
        data: [
          factor(xaa.id, '2026-06-30', '2'),
          factor(xaa.id, '2026-07-07', '5'),
          factor(xbb.id, '2026-06-15', '7'),
          factor(xbb.id, '2026-07-07', '1.5'),
        ],
      });
    });

    it('② 无登记 ⇒ 与改动前实现逐项深等 (branch 3; SC-003)', async () => {
      // 基线由**改动前**的 get-instrument-bars 实现首跑写入 (vitest inline snapshot), 之后只读
      // 比对 —— 新旧两边不走同一条代码路径, 不是自证。库里另有 T003 留下的他码登记, 一并证明
      // 无关登记不影响。
      baseline = await runProbes();
      expect(baseline).toMatchInlineSnapshot(`
        [
          {
            "freshnessTier": "CURRENT",
            "items": [
              "{"tradeDate":"2026-06-30","adjust":"none","open":"55.0000","high":"55.0000","low":"55.0000","close":"55.0000","changePct":"1.0000","prevClose":"54.4554","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-06","adjust":"none","open":"18.0000","high":"18.0000","low":"18.0000","close":"18.0000","changePct":"1.0000","prevClose":"17.8218","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-07","adjust":"none","open":"12.0000","high":"12.0000","low":"12.0000","close":"12.0000","changePct":"1.0000","prevClose":"11.8812","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-08","adjust":"none","open":"13.0000","high":"13.0000","low":"13.0000","close":"13.0000","changePct":"1.0000","prevClose":"12.8713","volume":"1000","amount":"10000","turnoverRate":null}",
            ],
            "q": {
              "adjust": "none",
              "period": "day",
              "symbol": "us:XBB",
            },
          },
          {
            "freshnessTier": "CURRENT",
            "items": [
              "{"tradeDate":"2026-06-30","adjust":"forward","open":"36.6667","high":"36.6667","low":"36.6667","close":"36.6667","changePct":"1.0000","prevClose":"36.3037","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-06","adjust":"forward","open":"12.0000","high":"12.0000","low":"12.0000","close":"12.0000","changePct":"1.0000","prevClose":"11.8812","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-07","adjust":"forward","open":"12.0000","high":"12.0000","low":"12.0000","close":"12.0000","changePct":"1.0000","prevClose":"11.8812","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-08","adjust":"forward","open":"13.0000","high":"13.0000","low":"13.0000","close":"13.0000","changePct":"1.0000","prevClose":"12.8713","volume":"1000","amount":"10000","turnoverRate":null}",
            ],
            "q": {
              "adjust": "forward",
              "period": "day",
              "symbol": "us:XBB",
            },
          },
          {
            "freshnessTier": "STALE",
            "items": [
              "{"tradeDate":"2026-06-30","adjust":"backward","open":"385.0000","high":"385.0000","low":"385.0000","close":"385.0000","changePct":"1.0000","prevClose":"381.1881","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-07","adjust":"backward","open":"126.0000","high":"126.0000","low":"126.0000","close":"126.0000","changePct":"1.0000","prevClose":"124.7525","volume":"2000","amount":"20000","turnoverRate":null}",
            ],
            "q": {
              "adjust": "backward",
              "from": "2026-06-30",
              "period": "week",
              "symbol": "us:XBB",
              "to": "2026-07-07",
            },
          },
          {
            "freshnessTier": "CURRENT",
            "items": [
              "{"tradeDate":"2026-07-01","adjust":"forward","open":"3.2000","high":"3.2000","low":"3.2000","close":"3.2000","changePct":"1.0000","prevClose":"3.1683","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-02","adjust":"forward","open":"3.4000","high":"3.4000","low":"3.4000","close":"3.4000","changePct":"1.0000","prevClose":"3.3663","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-06","adjust":"forward","open":"19.8000","high":"19.8000","low":"19.8000","close":"19.8000","changePct":"1.0000","prevClose":"19.6040","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-07","adjust":"forward","open":"98.0000","high":"98.0000","low":"98.0000","close":"98.0000","changePct":"1.0000","prevClose":"97.0297","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-08","adjust":"forward","open":"97.0000","high":"97.0000","low":"97.0000","close":"97.0000","changePct":"1.0000","prevClose":"96.0396","volume":"1000","amount":"10000","turnoverRate":null}",
            ],
            "q": {
              "adjust": "forward",
              "from": "2026-07-01",
              "period": "day",
              "symbol": "us:XAA",
            },
          },
          {
            "freshnessTier": "STALE",
            "items": [
              "{"tradeDate":"2026-06-29","adjust":"none","open":"30.0000","high":"30.0000","low":"30.0000","close":"30.0000","changePct":"1.0000","prevClose":"29.7030","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-06-30","adjust":"none","open":"15.0000","high":"15.0000","low":"15.0000","close":"15.0000","changePct":"1.0000","prevClose":"14.8515","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-01","adjust":"none","open":"16.0000","high":"16.0000","low":"16.0000","close":"16.0000","changePct":"1.0000","prevClose":"15.8416","volume":"1000","amount":"10000","turnoverRate":null}",
              "{"tradeDate":"2026-07-02","adjust":"none","open":"17.0000","high":"17.0000","low":"17.0000","close":"17.0000","changePct":"1.0000","prevClose":"16.8317","volume":"1000","amount":"10000","turnoverRate":null}",
            ],
            "q": {
              "adjust": "none",
              "period": "day",
              "symbol": "us:XAA",
              "to": "2026-07-02",
            },
          },
          {
            "error": "InstrumentNotFoundException",
            "q": {
              "adjust": "none",
              "period": "day",
              "symbol": "us:NOPEX",
            },
          },
        ]
      `);
    });

    it('① 登记后查新码 ⇒ 旧段 + 新段连续、无重复日 (branch 1、2)', async () => {
      const reg = await register.execute(
        { ...base, oldCode: 'XAA', newCode: 'XBB', effectiveDate: '2026-07-04' },
        NOW,
      );
      expect(reg.status).toBe('registered');

      const all = await closes({ symbol: 'us:XBB', adjust: 'none' });
      const dates = all.map(([d]) => d);
      expect(new Set(dates).size).toBe(dates.length);
      expect(all).toEqual([
        ['2026-06-29', '30.0000'],
        ['2026-06-30', '15.0000'],
        ['2026-07-01', '16.0000'],
        ['2026-07-02', '17.0000'],
        ['2026-07-06', '18.0000'],
        ['2026-07-07', '12.0000'],
        ['2026-07-08', '13.0000'],
      ]);
      // 查询窗跨段: 两段各自与窗求交。
      expect(
        await closes({ symbol: 'us:XBB', adjust: 'none', from: '2026-07-01', to: '2026-07-07' }),
      ).toEqual([
        ['2026-07-01', '16.0000'],
        ['2026-07-02', '17.0000'],
        ['2026-07-06', '18.0000'],
        ['2026-07-07', '12.0000'],
      ]);
    });

    it('④ 生效日落在周末 ⇒ 前一个交易日属旧段、下一个交易日属新段', async () => {
      const all = await closes({
        symbol: 'us:XBB',
        adjust: 'none',
        from: '2026-07-02',
        to: '2026-07-06',
      });
      // 07-02 (周四) 取 XAA 的 17 而非缺席; 07-06 (周一) 取 XBB 的 18 而非 XAA 的 99。
      expect(all).toEqual([
        ['2026-07-02', '17.0000'],
        ['2026-07-06', '18.0000'],
      ]);
    });

    it('⑤ adjust=forward ⇒ 只用各段区间内的因子 (XAA 06-30 ×2 · XBB 07-07 ×1.5), B_latest = 3', async () => {
      // 段外因子 XAA 07-07 ×5 与 XBB 06-15 ×7 若被合并进来, B_latest 变 105/15/21, 下列全错。
      expect(await closes({ symbol: 'us:XBB', adjust: 'forward' })).toEqual([
        ['2026-06-29', '10.0000'],
        ['2026-06-30', '10.0000'],
        ['2026-07-01', '10.6667'],
        ['2026-07-02', '11.3333'],
        ['2026-07-06', '12.0000'],
        ['2026-07-07', '12.0000'],
        ['2026-07-08', '13.0000'],
      ]);
    });

    it('③ 撤销后 ⇒ 立即回到登记前读法, 与 ② 深等 (branch 8; SC-004)', async () => {
      const res = await revoke.execute(
        {
          market: 'us',
          oldCode: 'XAA',
          effectiveDate: '2026-07-04',
          revokedBy: 'it-maintainer',
          reason: '撤销验证',
        },
        NOW,
      );
      expect(res).toEqual({ status: 'revoked' });
      expect(baseline).toBeDefined();
      expect(await runProbes()).toEqual(baseline);
    });
  });
});
