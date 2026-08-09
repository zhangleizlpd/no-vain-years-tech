import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { EvaluateAlertsUseCase } from './evaluate-alerts.usecase';

// 021 T011 US2: EOD 评估 UC (Testcontainers PG, 造 marketdata instrument+daily_bar 种子)。
// 覆盖: 触发写流水含 actual / 三档后置 (ONCE_DELETE 删·流水留 / ONCE_DISABLE 停用 /
// DAILY 不动) / 幂等重跑零新增 (P2002 skip) / 停牌旧 tradeDate no-op / prevClose null
// 不触发 / 标的无 bar·无 instrument 跳过 / 停用不评估 / 评估中删除竞态不炸 (D9)。
// 022 T005 追加: push fan-out (绑定 → PENDING delivery / 0 绑定 0 行 / P2002 回滚零残留)。
// run via `nx test server <file>` (cwd=apps/server)。
describe('EvaluateAlertsUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let evaluate: EvaluateAlertsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    evaluate = new EvaluateAlertsUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    // 评估 UC 全量扫 enabled alert → 测试间清空三方表隔离 (instrument 留, code 唯一隔离)。
    await prisma.pushDelivery.deleteMany();
    await prisma.pushBinding.deleteMany();
    await prisma.alertTrigger.deleteMany();
    await prisma.alert.deleteMany();
    // trading_day 是市场级全局表 (staleness count where market='cn'), 跨 test 不靠 instrumentId
    // 隔离 → 每 test 前清, 防 023 估值 staleness 用例互相污染。
    await prisma.tradingDay.deleteMany();
  });

  const nextAccountId = (): bigint => BigInt(930_000 + ++seq);
  const nextCode = (): string => `60${String(1000 + ++seq)}`;

  /** marketdata 种子: instrument + 最新 none bar (021 评估读侧 Q7-B 数据)。 */
  async function seedInstrument(
    opts: {
      code?: string;
      name?: string;
      bar?: {
        tradeDate: string;
        high: string;
        low: string;
        close: string;
        prevClose: string | null;
      } | null;
    } = {},
  ): Promise<{ code: string; instrumentId: bigint }> {
    const code = opts.code ?? nextCode();
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: opts.name ?? `名称-${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });
    if (opts.bar !== null) {
      const bar = opts.bar ?? {
        tradeDate: '2026-06-05',
        high: '14.5',
        low: '12.8',
        close: '14.2',
        prevClose: '10',
      };
      await prisma.dailyBar.create({
        data: {
          instrumentId: inst.id,
          tradeDate: new Date(bar.tradeDate),
          adjust: 'none',
          open: bar.prevClose ?? bar.close,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          prevClose: bar.prevClose,
        },
      });
    }
    return { code, instrumentId: inst.id };
  }

  async function seedAlert(
    accountId: bigint,
    code: string,
    opts: {
      conditions?: Array<{ type: string; threshold?: string | null; param?: number }>;
      frequency?: string;
      enabled?: boolean;
      note?: string | null;
    } = {},
  ) {
    return prisma.alert.create({
      data: {
        accountId,
        market: 'cn',
        code,
        frequency: opts.frequency ?? 'DAILY',
        note: opts.note ?? null,
        enabled: opts.enabled ?? true,
        conditions: {
          create: (opts.conditions ?? [{ type: 'PRICE_FALL_TO', threshold: '13' }]).map((c) => ({
            type: c.type,
            threshold: c.threshold ?? null,
            param: c.param ?? 0,
          })),
        },
      },
    });
  }

  // ── 023 T011 种子: 前复权序列 / 因子 / 估值快照 / 交易日历 ─────────────────────
  let instSeq = 0;
  /** instrument + N 根 none bar 升序 (各 bar 可覆盖 high/low/volume/turnoverRate)。 */
  async function seedInstrumentWithBars(
    bars: Array<{
      tradeDate: string;
      close: number;
      high?: number;
      low?: number;
      prevClose?: number | null;
      volume?: number | null;
      turnoverRate?: number | null;
    }>,
  ): Promise<{ code: string; instrumentId: bigint }> {
    const code = `30${String(2000 + ++instSeq)}`;
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: `指标-${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });
    for (const b of bars) {
      await prisma.dailyBar.create({
        data: {
          instrumentId: inst.id,
          tradeDate: new Date(b.tradeDate),
          adjust: 'none',
          open: b.close,
          high: b.high ?? b.close,
          low: b.low ?? b.close,
          close: b.close,
          prevClose: b.prevClose === undefined ? null : b.prevClose,
          volume: b.volume === undefined ? null : b.volume,
          turnoverRate: b.turnoverRate === undefined ? null : b.turnoverRate,
        },
      });
    }
    return { code, instrumentId: inst.id };
  }

  /** 等距日期序列 (2026-04 起, 工作日近似, 仅需唯一升序; tradeDate 字典序即时序)。 */
  const dateSeq = (n: number, start = 1): string[] =>
    Array.from({ length: n }, (_, i) => `2026-04-${String(start + i).padStart(2, '0')}`);

  const seedFactor = (instrumentId: bigint, exDate: string, factorBackward: string) =>
    prisma.adjustmentFactor.create({
      data: { instrumentId, exDate: new Date(exDate), factorBackward },
    });

  const seedFundamental = (
    instrumentId: bigint,
    date: string,
    fields: { peTtm?: string; pb?: string; dividendYield?: string; pePctlY3?: string },
  ) =>
    prisma.fundamentalSnapshot.create({ data: { instrumentId, date: new Date(date), ...fields } });

  const seedTradingDays = (dates: string[]) =>
    prisma.tradingDay.createMany({ data: dates.map((d) => ({ market: 'cn', date: new Date(d) })) });

  it('触发 → 写流水 (alertId/标的/名称快照/tradeDate/conditionsSnapshot 含 actual)', async () => {
    const accountId = nextAccountId();
    const { code } = await seedInstrument({ name: '旭升集团' });
    const alert = await seedAlert(accountId, code); // 低 12.8 ≤ 13 → 命中

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(1);

    const triggers = await prisma.alertTrigger.findMany({ where: { accountId } });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      alertId: alert.id,
      market: 'cn',
      code,
      instrumentName: '旭升集团',
      frequencySnapshot: 'DAILY',
      noteSnapshot: null,
    });
    expect(triggers[0]!.tradeDate.toISOString().slice(0, 10)).toBe('2026-06-05');
    expect(triggers[0]!.conditionsSnapshot).toEqual([
      { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
    ]);
  });

  it('AND 双条件一项不命中 → 不触发', async () => {
    const accountId = nextAccountId();
    const { code } = await seedInstrument();
    await seedAlert(accountId, code, {
      conditions: [
        { type: 'PRICE_FALL_TO', threshold: '13' }, // 命中
        { type: 'PRICE_RISE_TO', threshold: '99' }, // 不命中
      ],
    });

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(0);
  });

  it('三档后置: ONCE_DELETE → 预警删·conditions 级联·流水留; ONCE_DISABLE → 停用; DAILY → 不动', async () => {
    const accountId = nextAccountId();
    const { code } = await seedInstrument();
    const del = await seedAlert(accountId, code, { frequency: 'ONCE_DELETE' });
    const dis = await seedAlert(accountId, code, { frequency: 'ONCE_DISABLE' });
    const daily = await seedAlert(accountId, code, { frequency: 'DAILY' });

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(3);

    expect(await prisma.alert.findUnique({ where: { id: del.id } })).toBeNull();
    expect(await prisma.alertCondition.count({ where: { alertId: del.id } })).toBe(0);
    expect((await prisma.alert.findUnique({ where: { id: dis.id } }))!.enabled).toBe(false);
    expect((await prisma.alert.findUnique({ where: { id: daily.id } }))!.enabled).toBe(true);
    // 流水三条全在 (ONCE_DELETE 流水独立于 Alert 生命周期, FR-S05)
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(3);
  });

  it('幂等重跑: 同 tradeDate 二轮零新增 (P2002 skip); DAILY 新 tradeDate 再触发', async () => {
    const accountId = nextAccountId();
    const { code, instrumentId } = await seedInstrument();
    await seedAlert(accountId, code, { frequency: 'DAILY' });

    await evaluate.execute();
    const second = await evaluate.execute(); // 停牌场景同构: 最新 bar tradeDate 未变 → no-op
    expect(second.triggered).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(1);

    // 新交易日 bar 落库 → 下一轮再触发
    await prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date('2026-06-08'),
        adjust: 'none',
        open: '12',
        high: '12.5',
        low: '11.9',
        close: '12.1',
        prevClose: '14.2',
      },
    });
    const third = await evaluate.execute();
    expect(third.triggered).toBe(1);
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(2);
  });

  it('prevClose null → DAILY_* 不触发 (新上市); 无 bar / 无 instrument → 跳过不炸', async () => {
    const accountId = nextAccountId();
    const noPrev = await seedInstrument({
      bar: { tradeDate: '2026-06-05', high: '14.5', low: '12.8', close: '14.2', prevClose: null },
    });
    await seedAlert(accountId, noPrev.code, {
      conditions: [{ type: 'DAILY_GAIN_OVER', threshold: '1' }],
    });
    const noBar = await seedInstrument({ bar: null });
    await seedAlert(accountId, noBar.code);
    await seedAlert(accountId, '999999'); // instrument 不存在

    const summary = await evaluate.execute();
    expect(summary.triggered).toBe(0);
    expect(summary.skippedNoBar).toBe(2);
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(0);
  });

  it('停用预警不评估 (enabled=false 不入扫描面)', async () => {
    const accountId = nextAccountId();
    const { code } = await seedInstrument();
    await seedAlert(accountId, code, { enabled: false });

    const summary = await evaluate.execute();
    expect(summary.enabledAlerts).toBe(0);
    expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(0);
  });

  it('评估中删除竞态: load 后预警被删 → 不炸, 流水仍落 (D9 触发先于删除)', async () => {
    const accountId = nextAccountId();
    const { code } = await seedInstrument();
    const alert = await seedAlert(accountId, code, { frequency: 'ONCE_DISABLE' });

    // 模拟 load→tx 窗口内用户删除: 代理 PrismaService, alert.findMany 返回后立删该行。
    const racingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'alert') {
          const delegate = target.alert;
          return new Proxy(delegate, {
            get(dTarget, dProp, dReceiver) {
              if (dProp === 'findMany') {
                return async (...args: unknown[]) => {
                  const rows = await (dTarget.findMany as (...a: unknown[]) => Promise<unknown[]>)(
                    ...args,
                  );
                  await target.alertCondition.deleteMany({ where: { alertId: alert.id } });
                  await target.alert.deleteMany({ where: { id: alert.id } });
                  return rows;
                };
              }
              return Reflect.get(dTarget, dProp, dReceiver);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaService;

    const summary = await new EvaluateAlertsUseCase(racingPrisma).execute();
    expect(summary.triggered).toBe(1); // 不炸 + 触发计数
    const triggers = await prisma.alertTrigger.findMany({ where: { accountId } });
    expect(triggers).toHaveLength(1); // 流水已落 (alertId 普通列无 FK, 自立)
    expect(triggers[0]!.alertId).toBe(alert.id);
    expect(await prisma.alert.count({ where: { id: alert.id } })).toBe(0); // 后置 no-op 不复活
  });

  describe('push fan-out (022 T005, R1 same-ctx tx)', () => {
    const seedBinding = (accountId: bigint, registrationId: string) =>
      prisma.pushBinding.create({ data: { accountId, registrationId, platform: 'android' } });

    it('触发 × 2 绑定 → 2 行 PENDING (triggerId/accountId + registrationId 快照)', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrument();
      await seedAlert(accountId, code);
      await seedBinding(accountId, 'regid-t005-a');
      await seedBinding(accountId, 'regid-t005-b');

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
      const trigger = await prisma.alertTrigger.findFirstOrThrow({ where: { accountId } });
      const deliveries = await prisma.pushDelivery.findMany({
        where: { accountId },
        orderBy: { registrationId: 'asc' },
      });
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((d) => d.registrationId)).toEqual(['regid-t005-a', 'regid-t005-b']);
      for (const d of deliveries) {
        expect(d.triggerId).toBe(trigger.id);
        expect(d.status).toBe('PENDING');
        expect(d.attempts).toBe(0);
        expect(d.nextAttemptAt).toBeNull();
      }
    });

    it('0 绑定 → 0 行 delivery, 触发流水照落 (消息中心 only)', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrument();
      await seedAlert(accountId, code);

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
      expect(await prisma.alertTrigger.count({ where: { accountId } })).toBe(1);
      expect(await prisma.pushDelivery.count({ where: { accountId } })).toBe(0);
    });

    it('幂等重跑 P2002 回滚 → 二轮 delivery 零新增零残留', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrument();
      await seedAlert(accountId, code, { frequency: 'DAILY' });
      await seedBinding(accountId, 'regid-t005-rerun');

      await evaluate.execute();
      const second = await evaluate.execute(); // 同 tradeDate → trigger P2002 整 tx 回滚
      expect(second.skippedDuplicate).toBe(1);
      expect(await prisma.pushDelivery.count({ where: { accountId } })).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 023 T011: 取数分层求值 (forwardBars / fundamental / 量类 + 除权回归)
  // 纯函数口径正确性由 alert-evaluation.rules.spec 全覆盖; 此处验 UC 取数装配端到端通。
  // ════════════════════════════════════════════════════════════════════════════
  describe('023 指标/估值/量类求值 (T011)', () => {
    it('forwardBars 取数 — MA_CROSS_UP(5) 上穿触发, snapshot 含 param 无 threshold', async () => {
      const accountId = nextAccountId();
      const d = dateSeq(6);
      // MA5 昨=49/5=9.8 今=51/5=10.2; 昨收 9 < 9.8 ∧ 今收 12 ≥ 10.2 → 上穿
      const { code } = await seedInstrumentWithBars(
        [10, 10, 10, 10, 9, 12].map((c, i) => ({ tradeDate: d[i], close: c })),
      );
      await seedAlert(accountId, code, { conditions: [{ type: 'MA_CROSS_UP', param: 5 }] });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
      const t = await prisma.alertTrigger.findFirstOrThrow({ where: { accountId } });
      expect(t.conditionsSnapshot).toEqual([
        { type: 'MA_CROSS_UP', threshold: null, actual: '12.0000', param: 5 },
      ]);
      expect(t.tradeDate.toISOString().slice(0, 10)).toBe(d[5]);
    });

    it('forwardBars warm-up 防御 — MA_CROSS_UP(5) 仅 3 根 → 不触发, 不报错', async () => {
      const accountId = nextAccountId();
      const d = dateSeq(3);
      const { code } = await seedInstrumentWithBars(
        [10, 11, 12].map((c, i) => ({ tradeDate: d[i], close: c })),
      );
      await seedAlert(accountId, code, { conditions: [{ type: 'MA_CROSS_UP', param: 5 }] });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(0);
      expect(summary.skippedNoBar).toBe(0); // 有 bar, 只是 warm-up 不命中 (非跳过)
    });

    it('量类 — VOLUME_RATIO_OVER 今量/前5日均量 ≥ 阈 → 触发', async () => {
      const accountId = nextAccountId();
      const d = dateSeq(6);
      const { code } = await seedInstrumentWithBars(
        [1, 1, 1, 1, 1, 3].map((v, i) => ({ tradeDate: d[i], close: 10, volume: v })),
      );
      await seedAlert(accountId, code, {
        conditions: [{ type: 'VOLUME_RATIO_OVER', threshold: '2' }],
      });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
      const t = await prisma.alertTrigger.findFirstOrThrow({ where: { accountId } });
      expect(t.conditionsSnapshot).toEqual([
        { type: 'VOLUME_RATIO_OVER', threshold: '2.0000', actual: '3.0000' },
      ]);
    });

    it('技术指标 — RSI_OVERBOUGHT 单边上涨 RSI≈100 ≥70 → 触发 (状态语义)', async () => {
      const accountId = nextAccountId();
      const d = dateSeq(20);
      const { code } = await seedInstrumentWithBars(
        Array.from({ length: 20 }, (_, i) => ({ tradeDate: d[i], close: 10 + i })),
      );
      await seedAlert(accountId, code, {
        conditions: [{ type: 'RSI_OVERBOUGHT', threshold: '70' }],
      });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
    });

    it('估值 — PE_BELOW + staleness 0 → 触发, snapshot 含 dataDate 无 param', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrumentWithBars([{ tradeDate: '2026-04-10', close: 10 }]);
      const instId = (await prisma.instrument.findFirstOrThrow({ where: { code } })).id;
      await seedFundamental(instId, '2026-04-10', { peTtm: '9.8' });
      await seedTradingDays(['2026-04-10']); // snap.date == tradeDate → staleness 0
      await seedAlert(accountId, code, { conditions: [{ type: 'PE_BELOW', threshold: '10' }] });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(1);
      const t = await prisma.alertTrigger.findFirstOrThrow({ where: { accountId } });
      expect(t.conditionsSnapshot).toEqual([
        { type: 'PE_BELOW', threshold: '10.0000', actual: '9.8000', dataDate: '2026-04-10' },
      ]);
    });

    it('估值 staleness > 3 防御 — 快照落后 4 交易日 → 不触发', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrumentWithBars([{ tradeDate: '2026-04-15', close: 10 }]);
      const instId = (await prisma.instrument.findFirstOrThrow({ where: { code } })).id;
      await seedFundamental(instId, '2026-04-09', { peTtm: '9' });
      // 快照日 04-09 之后到 04-15 之间 4 个交易日 → staleness 4 > 3
      await seedTradingDays(['2026-04-10', '2026-04-11', '2026-04-14', '2026-04-15']);
      await seedAlert(accountId, code, { conditions: [{ type: 'PE_BELOW', threshold: '10' }] });

      expect((await evaluate.execute()).triggered).toBe(0);
    });

    it('估值字段 null 防御 — PB_BELOW 但快照 pb 缺失 → 不触发', async () => {
      const accountId = nextAccountId();
      const { code } = await seedInstrumentWithBars([{ tradeDate: '2026-04-10', close: 10 }]);
      const instId = (await prisma.instrument.findFirstOrThrow({ where: { code } })).id;
      await seedFundamental(instId, '2026-04-10', { peTtm: '9.8' }); // pb 未设 → null
      await seedTradingDays(['2026-04-10']);
      await seedAlert(accountId, code, { conditions: [{ type: 'PB_BELOW', threshold: '2' }] });

      expect((await evaluate.execute()).triggered).toBe(0);
    });

    it('除权回归 — 今日除权 none 价跳水, 前复权连续 → NEW_LOW(3) 不假触发 (SC-003)', async () => {
      const accountId = nextAccountId();
      const d = dateSeq(6);
      // none: 前 5 日 low=10, 今日(除权日) low=8 prevClose=10 (raw 看会创新低);
      // 因子 f=1.25 (exDate=今日) → forward 前 5 日 low=10/1.25=8, 今日 low=8 → 全 8, 不创新低。
      const { code, instrumentId } = await seedInstrumentWithBars([
        ...d.slice(0, 5).map((td) => ({ tradeDate: td, close: 10, high: 10, low: 10 })),
        { tradeDate: d[5], close: 8, high: 8, low: 8, prevClose: 10 },
      ]);
      await seedFactor(instrumentId, d[5], '1.25');
      await seedAlert(accountId, code, { conditions: [{ type: 'NEW_LOW', param: 3 }] });

      const summary = await evaluate.execute();
      expect(summary.triggered).toBe(0); // 前复权连续 → 除权日不产生假新低
    });
  });
});
