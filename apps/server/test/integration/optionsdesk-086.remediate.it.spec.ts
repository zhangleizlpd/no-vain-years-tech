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
});
