import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { recordingOutboxPublisher } from '../_support/outbox-stub';
import { noEodSeed } from '../_support/eod-seed-stub';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';
import { PrismaService } from '../../src/security/prisma.service';
import { OutboxEventPrismaPublisher } from '../../src/security/outbox/outbox-event.prisma.publisher';
import type { OutboxPublisher } from '../../src/security/outbox/outbox-publisher.port';
import { CreateAnchorUseCase, shanghaiDateOnly } from '../../src/optionsdesk/create-anchor.usecase';
import { ReviewAnchorUseCase, isAnchorOverdue } from '../../src/optionsdesk/review-anchor.usecase';
import { MigrateAnchorTickerUseCase } from '../../src/optionsdesk/migrate-anchor-ticker.usecase';
import { ANCHOR_CREATED_EVENT } from '../../src/marketdata/anchor-cold-start.subscriber';
import {
  RemediateSymbolChangeUseCase,
  type RemediateSymbolChangeInput,
  type RemediationStep,
} from '../../src/optionsdesk/remediate-symbol-change.usecase';
import {
  CollectionScopeStep,
  MigrateAnchorStep,
  RegisterSymbolChangeStep,
  RejectOldCodeSubmissionsStep,
  revertStepsOf,
  VerifyRemediationStep,
} from '../../src/optionsdesk/remediate-symbol-change.steps';
import { RevokeSymbolChangeUseCase } from '../../src/marketdata/revoke-symbol-change.usecase';
import { RejectAnchorSubmissionsUseCase } from '../../src/optionsdesk/reject-anchor-submissions.usecase';
import { RegisterSymbolChangeUseCase } from '../../src/marketdata/register-symbol-change.usecase';
import { EnsureInstrumentUseCase } from '../../src/marketdata/ensure-instrument.usecase';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import { GetInstrumentBarsUseCase } from '../../src/marketdata/get-instrument-bars.usecase';
import { seedInstrumentCreateData } from '../../src/marketdata/sync-universe.usecase';
import { SYMBOL_CHANGE_SOURCE } from '../../src/marketdata/symbol-lineage.rules';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';

// 086 US3 / US5 修正命令 IT (Testcontainers PG)。T009 = 迁锚 use case 臂 ①–⑥;
// T011 / T012 的编排臂追加在本文件。装配体例同 optionsdesk-045.anchor.it.spec.ts: 直接 new
// use case + 真 PrismaService; 事件用**真** `OutboxEventPrismaPublisher` 写真 `outbox_event`
// 表 —— 「与锚的写同 tx」只有真表能验 (④)。合成代码 AAA / BBB / CCC。
describe('086 迁锚 use case IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createAnchor: CreateAnchorUseCase;
  let reviewAnchor: ReviewAnchorUseCase;
  let migrate: MigrateAnchorTickerUseCase;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const OLD = 'us:AAA';
  const NEW = 'us:BBB';
  const ORIGINAL_NEXT_REVIEW = new Date('2027-03-31T00:00:00Z');

  const seedAnchor = async (ticker: string): Promise<bigint> => {
    const created = await createAnchor.execute({
      ticker,
      v: '50',
      asof: new Date('2026-06-30T00:00:00Z'),
      method: 'dcf',
      confidence: '8',
      nextReview: ORIGINAL_NEXT_REVIEW,
    });
    // 旧码最后一个价 —— 迁移后必须清空 (Guardrail 4), 否则新码锚带着旧价进雷达排序。
    await prisma.anchor.update({
      where: { id: created.id },
      data: {
        lastClose: '42.5',
        lastCloseDate: new Date('2026-10-14T00:00:00Z'),
        intradayPrice: '43.1',
        intradayAt: new Date('2026-10-15T14:00:00Z'),
        intradayVendorUpdateTime: new Date('2026-10-15T13:59:58Z'),
      },
    });
    return created.id;
  };

  const outboxRows = () =>
    prisma.outboxEvent.findMany({ where: { eventType: ANCHOR_CREATED_EVENT } });
  const changesOf = (anchorId: bigint) =>
    prisma.anchorChange.findMany({ where: { anchorId }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    createAnchor = new CreateAnchorUseCase(
      prisma,
      recordingOutboxPublisher(),
      noEodSeed(),
      stubTradingCalendar(),
    );
    reviewAnchor = new ReviewAnchorUseCase(prisma, stubTradingCalendar());
    migrate = new MigrateAnchorTickerUseCase(prisma, new OutboxEventPrismaPublisher());
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, public.outbox_event RESTART IDENTITY',
    );
  });

  describe('T009 迁锚', () => {
    it('① 旧码有锚、新码无锚 ⇒ 锚在新码名下、复核逾期、价格列清空、痕迹可查 (branch 19)', async () => {
      const anchorId = await seedAnchor(OLD);
      const now = new Date();

      const result = await migrate.execute({ oldTicker: OLD, newTicker: NEW, now });
      expect(result.kind).toBe('migrated');

      expect(await prisma.anchor.findUnique({ where: { ticker: OLD } })).toBeNull();
      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: NEW } });
      expect(row.id).toBe(anchorId);
      expect(isAnchorOverdue(row.nextReview, shanghaiDateOnly(now))).toBe(true);
      expect(row.lastClose).toBeNull();
      expect(row.lastCloseDate).toBeNull();
      expect(row.intradayPrice).toBeNull();
      expect(row.intradayAt).toBeNull();
      expect(row.intradayVendorUpdateTime).toBeNull();

      const changes = await changesOf(anchorId);
      const trace = changes[changes.length - 1]!;
      expect(trace.changedFields).toEqual(['ticker', 'nextReview']);
      expect(trace.beforeValues).toEqual({
        ticker: OLD,
        nextReview: ORIGINAL_NEXT_REVIEW.toISOString(),
      });
    });

    it('② 新码已有锚 ⇒ 冲突、零写入 (branch 17)', async () => {
      const oldId = await seedAnchor(OLD);
      const newId = await seedAnchor(NEW);
      const before = await prisma.anchor.findMany({ orderBy: { id: 'asc' } });
      const changesBefore = await prisma.anchorChange.count();

      const result = await migrate.execute({ oldTicker: OLD, newTicker: NEW });

      expect(result).toEqual({ kind: 'conflict', existingAnchorId: newId });
      expect(await prisma.anchor.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
      expect(await outboxRows()).toHaveLength(0);
      expect(before.map((r) => r.id)).toEqual([oldId, newId]);
    });

    it('旧码无锚 ⇒ no_anchor、零写入 (编排据此跳过; 已迁过再跑一次也落这里)', async () => {
      await seedAnchor(OLD);
      await migrate.execute({ oldTicker: OLD, newTicker: NEW });
      const changesBefore = await prisma.anchorChange.count();

      expect(await migrate.execute({ oldTicker: OLD, newTicker: NEW })).toEqual({
        kind: 'no_anchor',
      });
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
      expect(await outboxRows()).toHaveLength(1);
    });

    it('③ 迁移后调既有 review-anchor ⇒ 不再逾期 (branch 20)', async () => {
      const anchorId = await seedAnchor(OLD);
      await migrate.execute({ oldTicker: OLD, newTicker: NEW });

      await reviewAnchor.execute(anchorId, ORIGINAL_NEXT_REVIEW);

      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: anchorId } });
      expect(row.ticker).toBe(NEW);
      expect(isAnchorOverdue(row.nextReview, shanghaiDateOnly(new Date()))).toBe(false);
    });

    it('④ outbox 恰一条建锚事件 (新码) 且与锚的写同 tx: 事件写失败 ⇒ 锚未迁', async () => {
      const anchorId = await seedAnchor(OLD);
      await migrate.execute({ oldTicker: OLD, newTicker: NEW });

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload as { data: Record<string, unknown> };
      expect(payload.data).toEqual({ anchorId: String(anchorId), ticker: NEW });

      // 同 tx 反例: publisher 在 tx 内抛 ⇒ 锚、痕迹、outbox 全部回滚。
      await prisma.$executeRawUnsafe(
        'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, public.outbox_event RESTART IDENTITY',
      );
      const id2 = await seedAnchor(OLD);
      const changesBefore = await prisma.anchorChange.count();
      const failing: OutboxPublisher = {
        publish: async () => {
          throw new Error('outbox write failed');
        },
      };
      await expect(
        new MigrateAnchorTickerUseCase(prisma, failing).execute({ oldTicker: OLD, newTicker: NEW }),
      ).rejects.toThrow('outbox write failed');
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: id2 } });
      expect(row.ticker).toBe(OLD);
      expect(row.lastClose?.toString()).toBe('42.5');
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
      expect(await outboxRows()).toHaveLength(0);
    });

    it('⑤ revert ⇒ 回旧码、next_review 恢复原值; 再 revert ⇒ no_anchor', async () => {
      const anchorId = await seedAnchor(OLD);
      await migrate.execute({ oldTicker: OLD, newTicker: NEW });

      const result = await migrate.revert({ oldTicker: OLD, newTicker: NEW });

      expect(result).toEqual({
        kind: 'reverted',
        anchorId,
        restoredNextReview: ORIGINAL_NEXT_REVIEW,
      });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: anchorId } });
      expect(row.ticker).toBe(OLD);
      expect(row.nextReview).toEqual(ORIGINAL_NEXT_REVIEW);
      const changes = await changesOf(anchorId);
      expect(changes[changes.length - 1]!.changedFields).toEqual(['ticker', 'nextReview']);
      // revert 不发事件: 旧码数据本已在库 (T008 结论)。
      expect(await outboxRows()).toHaveLength(1);

      expect(await migrate.revert({ oldTicker: OLD, newTicker: NEW })).toEqual({
        kind: 'no_anchor',
      });
    });

    it('revert: 新码锚不是由旧码迁来 (手工建在新码上) ⇒ not_migrated、零写入', async () => {
      const newId = await seedAnchor(NEW);
      const changesBefore = await prisma.anchorChange.count();

      expect(await migrate.revert({ oldTicker: OLD, newTicker: NEW })).toEqual({
        kind: 'not_migrated',
        anchorId: newId,
      });
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
    });

    it('⑥ 时间轴: 上海 00:30 (美东仍是前一日) ⇒ next_review = 上海日的昨天, 迁移后立即逾期', async () => {
      await seedAnchor(OLD);
      // 上海 2026-10-16 00:30 = UTC 2026-10-15 16:30 = 美东 2026-10-15 12:30。
      const now = new Date('2026-10-15T16:30:00Z');

      const result = await migrate.execute({ oldTicker: OLD, newTicker: NEW, now });

      const expected = new Date('2026-10-15T00:00:00Z');
      expect(result).toMatchObject({ kind: 'migrated', nextReview: expected });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: NEW } });
      expect(row.nextReview).toEqual(expected);
      expect(isAnchorOverdue(row.nextReview, shanghaiDateOnly(now))).toBe(true);
    });
  });

  // T010 编排骨架: 桩步骤只在本测试里注入 (生产 REMEDIATION_STEPS 由 T011 接入真步骤)。
  // 桩 1 = 真迁锚 use case (写 anchor / anchor_change / outbox); 桩 2 / 3 = 各写一条标记 outbox 行,
  // 桩 2 可切换成「apply 抛错」。inspect 全部只读库, 与真步骤同形: 已完成的事实从库里读, 不靠内存。
  describe('T010 修正编排骨架', () => {
    const STUB_EVENT = 'test.remediate-stub';
    const input = (mode: RemediateSymbolChangeInput['mode']): RemediateSymbolChangeInput => ({
      market: 'us',
      oldCode: 'AAA',
      newCode: 'BBB',
      effectiveDate: '2026-10-15',
      evidence: 'https://example.invalid/notice',
      operator: 'it',
      mode,
    });

    const applyCalls: string[] = [];
    let step2Fails = false;

    const migrateStep: RemediationStep = {
      name: 'migrate-anchor',
      inspect: async (ctx) => {
        const old = await prisma.anchor.findUnique({ where: { ticker: ctx.oldTicker } });
        if (old === null) return { state: 'done', detail: '旧码无锚' };
        const occupant = await prisma.anchor.findUnique({ where: { ticker: ctx.newTicker } });
        if (occupant !== null) return { state: 'conflict', detail: '新码已有锚' };
        return { state: 'pending', detail: `锚 ${ctx.oldTicker} → ${ctx.newTicker}` };
      },
      apply: async (ctx) => {
        applyCalls.push('migrate-anchor');
        const r = await migrate.execute({ oldTicker: ctx.oldTicker, newTicker: ctx.newTicker });
        return r.kind === 'migrated'
          ? { status: 'ok', detail: 'migrated' }
          : { status: 'conflict', detail: r.kind };
      },
    };

    const markerStep = (name: string, opts: { failWhen?: () => boolean } = {}): RemediationStep => {
      const publisher = new OutboxEventPrismaPublisher();
      const findMarker = (ctx: { newTicker: string }) =>
        prisma.outboxEvent.findMany({ where: { eventType: STUB_EVENT } }).then((rows) =>
          rows.find((r) => {
            const data = (r.payload as { data: Record<string, unknown> }).data;
            return data.step === name && data.ticker === ctx.newTicker;
          }),
        );
      return {
        name,
        inspect: async (ctx) =>
          (await findMarker(ctx))
            ? { state: 'done', detail: '标记已在' }
            : { state: 'pending', detail: `将写标记 ${name}` },
        apply: async (ctx) => {
          applyCalls.push(name);
          if (opts.failWhen?.()) throw new Error(`${name} boom`);
          await prisma.$transaction((tx) =>
            publisher.publish(tx, STUB_EVENT, { step: name, ticker: ctx.newTicker }, 'optionsdesk'),
          );
          return { status: 'ok', detail: '标记已写' };
        },
      };
    };

    const orchestrator = () =>
      new RemediateSymbolChangeUseCase([
        migrateStep,
        markerStep('marker-2', { failWhen: () => step2Fails }),
        markerStep('marker-3'),
      ]);

    /** 相关表全行快照 (行数 + updated_at 等所有列一并比对)。 */
    const SNAPSHOT_TABLES = [
      'optionsdesk.anchor',
      'optionsdesk.anchor_change',
      'optionsdesk.anchor_submission',
      'public.outbox_event',
      'marketdata.symbol_change',
      'marketdata.instrument',
    ];
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const t of SNAPSHOT_TABLES) {
        const rows = await prisma.$queryRawUnsafe<{ j: string }[]>(
          `SELECT row_to_json(t)::text AS j FROM ${t} t ORDER BY 1`,
        );
        out[t] = rows.map((r) => r.j);
      }
      return out;
    };

    beforeEach(() => {
      applyCalls.length = 0;
      step2Fails = false;
    });

    it('① preview ⇒ 只调 inspect、报告「将要做」, 相关表行数与 updated_at 不变 (branch 12)', async () => {
      await seedAnchor(OLD);
      const before = await snapshot();
      expect(before['optionsdesk.anchor']).toHaveLength(1);

      const report = await orchestrator().execute(input('preview'));

      expect(report).toEqual([
        { step: 'migrate-anchor', status: 'ok', detail: `锚 ${OLD} → ${NEW}` },
        { step: 'marker-2', status: 'ok', detail: '将写标记 marker-2' },
        { step: 'marker-3', status: 'ok', detail: '将写标记 marker-3' },
      ]);
      expect(applyCalls).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

    it('② 步骤 2 失败 ⇒ 停在 2、3 不跑; 修复后重跑 ⇒ 1 skipped、2 起继续 (branch 14)', async () => {
      await seedAnchor(OLD);
      step2Fails = true;

      const first = await orchestrator().execute(input('apply'));

      expect(first).toEqual([
        { step: 'migrate-anchor', status: 'ok', detail: 'migrated' },
        { step: 'marker-2', status: 'failed', detail: 'marker-2 boom' },
      ]);
      expect(applyCalls).toEqual(['migrate-anchor', 'marker-2']);
      expect(await prisma.outboxEvent.count({ where: { eventType: STUB_EVENT } })).toBe(0);

      step2Fails = false;
      applyCalls.length = 0;
      const second = await orchestrator().execute(input('apply'));

      expect(second.map((r) => [r.step, r.status])).toEqual([
        ['migrate-anchor', 'skipped'],
        ['marker-2', 'ok'],
        ['marker-3', 'ok'],
      ]);
      expect(applyCalls).toEqual(['marker-2', 'marker-3']);
      expect(await prisma.anchor.findUnique({ where: { ticker: NEW } })).not.toBeNull();
    });

    it('③ 连跑两次 ⇒ 第二次全 skipped、零写入 (branch 15, SC-007)', async () => {
      await seedAnchor(OLD);

      const first = await orchestrator().execute(input('apply'));
      expect(first.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
      const afterFirst = await snapshot();
      applyCalls.length = 0;

      const second = await orchestrator().execute(input('apply'));

      expect(second.map((r) => [r.step, r.status])).toEqual([
        ['migrate-anchor', 'skipped'],
        ['marker-2', 'skipped'],
        ['marker-3', 'skipped'],
      ]);
      expect(applyCalls).toEqual([]);
      expect(await snapshot()).toEqual(afterFirst);
    });

    it('inspect 判冲突 ⇒ conflict 并停, 后续不跑 (preview 同样停)', async () => {
      await seedAnchor(OLD);
      await seedAnchor(NEW);

      for (const mode of ['preview', 'apply'] as const) {
        const report = await orchestrator().execute(input(mode));
        expect(report).toEqual([
          { step: 'migrate-anchor', status: 'conflict', detail: '新码已有锚' },
        ]);
      }
      expect(applyCalls).toEqual([]);
    });
  });

  // T011 五个真步骤: 与生产 `REMEDIATION_STEPS` 工厂同序装配, 全部真 use case + 真 PG。
  // 🚨 冷启动在本文件里**从不执行**: 迁锚发的 `optionsdesk.anchor-created` 只落 `outbox_event`
  // 表, 本 IT 不起 relay / BullMQ worker, 无人消费 ⇒ ② 观察到的新码标的行只可能来自第 4 步的
  // EnsureInstrument (branch 16「不依赖冷启动是否已跑」), 不需要再换冷启动桩。
  describe('T011 五个真步骤', () => {
    const MARKET = 'us';
    const EFFECTIVE = '2026-10-05';
    const input = (mode: RemediateSymbolChangeInput['mode']): RemediateSymbolChangeInput => ({
      market: MARKET,
      oldCode: 'AAA',
      newCode: 'BBB',
      effectiveDate: EFFECTIVE,
      evidence: 'https://example.invalid/notice',
      operator: 'it',
      mode,
    });

    /** 周一至周五即交易日的日历 (只为 ④ 的缺口数; 其余方法沿用默认替身)。 */
    const weekdayCalendar = (): TradingCalendarPort => ({
      ...stubTradingCalendar(),
      async countTradingDays(_m: string, fromExclusive: string, toInclusive: string) {
        let n = 0;
        const d = new Date(`${fromExclusive}T00:00:00Z`);
        const end = new Date(`${toInclusive}T00:00:00Z`);
        for (d.setUTCDate(d.getUTCDate() + 1); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          const wd = d.getUTCDay();
          if (wd !== 0 && wd !== 6) n += 1;
        }
        return n;
      },
    });

    const orchestrator = () => {
      const register = new RegisterSymbolChangeStep(
        new RegisterSymbolChangeUseCase(prisma),
        new RevokeSymbolChangeUseCase(prisma),
      );
      const migrateStep = new MigrateAnchorStep(prisma, migrate);
      const reject = new RejectOldCodeSubmissionsStep(
        prisma,
        new RejectAnchorSubmissionsUseCase(prisma),
      );
      const scope = new CollectionScopeStep(
        prisma,
        new EnsureInstrumentUseCase(prisma),
        new AnchorDrivenSyncGate(prisma),
      );
      const verify = new VerifyRemediationStep(
        prisma,
        new GetInstrumentBarsUseCase(prisma, weekdayCalendar()),
        weekdayCalendar(),
      );
      return new RemediateSymbolChangeUseCase(
        [register, migrateStep, reject, scope, verify],
        revertStepsOf({ register, migrate: migrateStep, reject, scope }),
      );
    };

    const seedSubmission = (ticker: string, status = 'PENDING') =>
      prisma.anchorSubmission.create({
        data: {
          submitter: 'guest-it',
          ticker,
          v: '50',
          asof: new Date('2026-09-30T00:00:00Z'),
          method: 'dcf',
          confidence: '7',
          status,
        },
      });

    const bar = (instrumentId: bigint, tradeDate: string) => ({
      instrumentId,
      tradeDate: new Date(`${tradeDate}T00:00:00Z`),
      adjust: 'none',
      open: '10',
      high: '10',
      low: '10',
      close: '10',
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE optionsdesk.anchor_submission, marketdata.symbol_change, marketdata.instrument RESTART IDENTITY CASCADE',
      );
      // 旧码标的行在采 (us 有锚 ⇒ need_sync=true); 新码 BBB 不在标的表。
      await prisma.instrument.create({
        data: { ...seedInstrumentCreateData(MARKET, 'AAA'), needSync: true },
      });
    });

    it('① apply ⇒ 五步 ok (branch 13), 登记 / 锚 / 采集闸落地', async () => {
      await seedAnchor(OLD);

      const report = await orchestrator().execute(input('apply'));

      expect(report.map((r) => [r.step, r.status])).toEqual([
        ['register', 'ok'],
        ['migrate-anchor', 'ok'],
        ['reject-submissions', 'skipped'],
        ['collection-scope', 'ok'],
        ['verify', 'ok'],
      ]);
      const reg = await prisma.symbolChange.findMany();
      expect(reg).toHaveLength(1);
      expect(reg[0]).toMatchObject({
        market: MARKET,
        oldCode: 'AAA',
        newCode: 'BBB',
        source: SYMBOL_CHANGE_SOURCE.MANUAL,
        registeredBy: 'it',
        revokedAt: null,
      });
      expect(await prisma.anchor.findUnique({ where: { ticker: OLD } })).toBeNull();
      expect(await prisma.anchor.findUnique({ where: { ticker: NEW } })).not.toBeNull();
      const gate = await prisma.instrument.findMany({
        where: { market: MARKET },
        select: { code: true, needSync: true },
        orderBy: { code: 'asc' },
      });
      expect(gate).toEqual([
        { code: 'AAA', needSync: false },
        { code: 'BBB', needSync: true },
      ]);

      // 再跑一次: 前四步 skipped, 验证每次都重验。
      const again = await orchestrator().execute(input('apply'));
      expect(again.map((r) => r.status)).toEqual([
        'skipped',
        'skipped',
        'skipped',
        'skipped',
        'ok',
      ]);
    });

    it('② 新码不在标的表 ⇒ 第 4 步结束时标的行已在且 need_sync 为真, 不依赖冷启动 (branch 16)', async () => {
      await seedAnchor(OLD);
      expect(
        await prisma.instrument.findUnique({
          where: { market_code: { market: MARKET, code: 'BBB' } },
        }),
      ).toBeNull();

      const report = await orchestrator().execute(input('apply'));

      const scope = report.find((r) => r.step === 'collection-scope')!;
      expect(scope.status).toBe('ok');
      expect(scope.detail).toContain('created');
      const row = await prisma.instrument.findUnique({
        where: { market_code: { market: MARKET, code: 'BBB' } },
      });
      expect(row?.needSync).toBe(true);
      // 冷启动事件确已发出但无人消费 —— 标的行不是它建的。
      expect(await outboxRows()).toHaveLength(1);
    });

    it('③ 旧码有 PENDING 提交 ⇒ 被驳回且理由含新码; 非 PENDING 不动', async () => {
      await seedAnchor(OLD);
      const pending = await seedSubmission(OLD);
      const approved = await seedSubmission(OLD, 'APPROVED');

      const report = await orchestrator().execute(input('apply'));

      expect(report.find((r) => r.step === 'reject-submissions')).toMatchObject({
        status: 'ok',
        detail: '已驳回 1 条',
      });
      const after = await prisma.anchorSubmission.findUniqueOrThrow({ where: { id: pending.id } });
      expect(after.status).toBe('REJECTED');
      expect(after.reviewNote).toContain(NEW);
      const untouched = await prisma.anchorSubmission.findUniqueOrThrow({
        where: { id: approved.id },
      });
      expect(untouched.status).toBe('APPROVED');
      expect(untouched.reviewNote).toBeNull();
    });

    it('④ 第 5 步报告含新码 lineage 日线首末日期与按交易日历的缺口数', async () => {
      await seedAnchor(OLD);
      const aaa = await prisma.instrument.findUniqueOrThrow({
        where: { market_code: { market: MARKET, code: 'AAA' } },
      });
      const bbb = await prisma.instrument.create({ data: seedInstrumentCreateData(MARKET, 'BBB') });
      // 旧段 09-29..10-02 (二~五), 新段自 10-05 (一) 起, 缺 10-06 ⇒ 交易日 7 个、实有 6 根。
      await prisma.dailyBar.createMany({
        data: [
          bar(aaa.id, '2026-09-29'),
          bar(aaa.id, '2026-09-30'),
          bar(aaa.id, '2026-10-01'),
          bar(aaa.id, '2026-10-02'),
          bar(bbb.id, '2026-10-05'),
          bar(bbb.id, '2026-10-07'),
        ],
      });

      const report = await orchestrator().execute(input('apply'));

      const verify = report.find((r) => r.step === 'verify')!;
      expect(verify.status).toBe('ok');
      expect(verify.detail).toContain('日线 2026-09-29 ~ 2026-10-07 共 6 根, 缺口 1');
      expect(verify.detail).toContain('新码锚复核逾期=是');
      expect(verify.detail).toContain('收盘价待下一拍');
    });

    it('新码已有锚 ⇒ 第 2 步 conflict 停, 后续不跑 (登记已写, 续跑靠人处置冲突)', async () => {
      await seedAnchor(OLD);
      await seedAnchor(NEW);

      const report = await orchestrator().execute(input('apply'));

      expect(report.map((r) => [r.step, r.status])).toEqual([
        ['register', 'ok'],
        ['migrate-anchor', 'conflict'],
      ]);
      expect(
        await prisma.instrument.findUnique({
          where: { market_code: { market: MARKET, code: 'BBB' } },
        }),
      ).toBeNull();
    });

    // T012 撤销编排: 逆序 = 迁锚回 → 撤销登记 → 重算采集闸, 末行「驳回不复原」。
    describe('T012 撤销编排', () => {
      const revert = (mode: RemediateSymbolChangeInput['mode']): RemediateSymbolChangeInput => ({
        ...input(mode),
        evidence: '登记有误, 撤销',
        direction: 'revert',
      });
      const gateState = () =>
        prisma.instrument.findMany({
          where: { market: MARKET },
          select: { code: true, needSync: true },
          orderBy: { code: 'asc' },
        });

      it('① apply 后 revert ⇒ 登记已撤销、锚回旧码且 next_review 复原、采集闸复原 (branch 18)', async () => {
        const anchorId = await seedAnchor(OLD);
        const submission = await seedSubmission(OLD);
        await orchestrator().execute(input('apply'));

        const preview = await orchestrator().execute(revert('preview'));
        expect(preview.map((r) => [r.step, r.status])).toEqual([
          ['revert-migrate-anchor', 'ok'],
          ['revoke-registration', 'ok'],
          ['recalc-sync-gate', 'ok'],
          ['restore-submissions', 'skipped'],
        ]);
        expect(await prisma.anchor.findUnique({ where: { ticker: NEW } })).not.toBeNull();

        const report = await orchestrator().execute(revert('apply'));

        expect(report.map((r) => [r.step, r.status])).toEqual([
          ['revert-migrate-anchor', 'ok'],
          ['revoke-registration', 'ok'],
          ['recalc-sync-gate', 'ok'],
          ['restore-submissions', 'skipped'],
        ]);
        expect(report[2]!.detail).toContain('补齐的新码标的行不删');
        expect(report[3]!.detail).toContain('不复原');

        const reg = await prisma.symbolChange.findFirstOrThrow();
        expect(reg.revokedAt).not.toBeNull();
        expect(reg).toMatchObject({ revokedBy: 'it', revokeReason: '登记有误, 撤销' });
        const anchor = await prisma.anchor.findUniqueOrThrow({ where: { ticker: OLD } });
        expect(anchor.id).toBe(anchorId);
        expect(anchor.nextReview).toEqual(ORIGINAL_NEXT_REVIEW);
        expect(await prisma.anchor.findUnique({ where: { ticker: NEW } })).toBeNull();
        // 旧码重新开闸、新码关闸; 新码标的行保留。
        expect(await gateState()).toEqual([
          { code: 'AAA', needSync: true },
          { code: 'BBB', needSync: false },
        ]);
        // 驳回不复原。
        const sub = await prisma.anchorSubmission.findUniqueOrThrow({
          where: { id: submission.id },
        });
        expect(sub.status).toBe('REJECTED');
      });

      it('② revert 两次 ⇒ 第二次全 skipped、零写入', async () => {
        await seedAnchor(OLD);
        await orchestrator().execute(input('apply'));
        await orchestrator().execute(revert('apply'));
        const changesBefore = await prisma.anchorChange.count();
        const regBefore = await prisma.symbolChange.findMany();
        const gateBefore = await gateState();

        const second = await orchestrator().execute(revert('apply'));

        expect(second.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
        expect(await prisma.anchorChange.count()).toBe(changesBefore);
        expect(await prisma.symbolChange.findMany()).toEqual(regBefore);
        expect(await gateState()).toEqual(gateBefore);
      });
    });
  });
});
