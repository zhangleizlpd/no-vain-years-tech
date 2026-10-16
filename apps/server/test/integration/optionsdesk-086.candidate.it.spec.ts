import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { recordingOutboxPublisher } from '../_support/outbox-stub';
import { noEodSeed } from '../_support/eod-seed-stub';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';
import { PrismaService } from '../../src/security/prisma.service';
import type {
  RealtimeQuote,
  RealtimeQuoteBatch,
  RealtimeQuotePort,
} from '../../src/marketdata/realtime-quote.port';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { SyncAnchorLastCloseUseCase } from '../../src/optionsdesk/sync-anchor-last-close';
import {
  CANDIDATE_SIGNAL_VENDOR_UNKNOWN,
  CANDIDATE_STATUS,
  type CodeSuggestion,
} from '../../src/optionsdesk/symbol-candidate.rules';

// 086 T018 疑似改名候选的产生 (FR-018; plan D8; state_branches 21 / 22 / 24)。
//
// 为什么要真 PG: 「同一 ticker 至多一条 PENDING」靠的是部分唯一索引 + 先查后写两层, DISMISSED 抑制
// 是对已有行的查询 —— 都是落库口径, mock prisma 验不到索引谓词。
// 装配 = 直接 new use case + 真 PrismaService (体例同 optionsdesk-045.anchor.it.spec.ts);
// 报价源与交易日历用替身 (只验「拿到 unknownSymbols 之后」这一段)。
// 公司名取自公开行情事件 (PARA → PSKY → SKYD), 代码与价一律合成。
describe('086 疑似改名候选产生 IT (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let createAnchor: CreateAnchorUseCase;
  let useCase: SyncAnchorLastCloseUseCase;

  /** us 目标 session = 08-31; 此刻 = 08-31 20:30 ET (已过收盘缓冲、未跨当地午夜 ⇒ 窗开)。 */
  const TARGET = '2026-08-31';
  const NOW = new Date('2026-09-01T00:30:00Z');
  const LATER = new Date('2026-09-01T00:40:00Z');

  /** 报价替身: 只给 `quoted` 里的代码报价, `unknown` 里的代码进 unknownSymbols。 */
  let unknown: string[] = [];
  const quoted = new Set(['us:CCC']);
  const realtimeQuote: RealtimeQuotePort = {
    async fetchQuotes(symbols: readonly string[]): Promise<RealtimeQuoteBatch> {
      const quotes = new Map<string, RealtimeQuote>();
      for (const s of symbols) {
        if (quoted.has(s)) {
          quotes.set(s, { price: '12.3400', capturedAt: NOW, vendorUpdateTime: null });
        }
      }
      return { quotes, unknownSymbols: symbols.filter((s) => unknown.includes(s)) };
    },
  };

  const seedAnchor = (ticker: string) =>
    createAnchor.execute({
      ticker,
      v: '50',
      asof: new Date('2026-06-30T00:00:00Z'),
      method: 'dcf',
      confidence: '8',
      nextReview: new Date('2026-12-31T00:00:00Z'),
    });

  const candidatesOf = (ticker: string) =>
    prisma.symbolChangeCandidate.findMany({ where: { ticker }, orderBy: { id: 'asc' } });

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
    useCase = new SyncAnchorLastCloseUseCase(
      prisma,
      realtimeQuote,
      stubTradingCalendar({ lastClosed: TARGET }),
    );

    const instrument = (code: string, name: string) => ({
      market: 'us',
      code,
      name,
      type: 'stock',
      currency: 'USD',
      status: 'active',
    });
    await prisma.instrument.createMany({
      data: [
        instrument('AAA', 'Paramount Skydance Corp'), // 被报未知的旧码
        instrument('BBB', 'Skydance'),
        instrument('CCC', 'Paramount Global'),
        instrument('DDD', 'Banzai International'),
        instrument('EEE', 'Eee Robotics Inc'), // 与任何同市场标的零交集
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, optionsdesk.symbol_change_candidate RESTART IDENTITY',
    );
    unknown = [];
  });

  it('① 未知代码 + 有建议 ⇒ 一条 PENDING 候选带建议, 旧码自身不进建议 (branch 21)', async () => {
    await seedAnchor('us:AAA');
    await seedAnchor('us:CCC');
    unknown = ['us:AAA'];

    const report = await useCase.execute(NOW);

    // 同批其余报价照常落库 (FR-010 不回退)。
    expect(report.updated).toBe(1);
    const rows = await candidatesOf('us:AAA');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signal: CANDIDATE_SIGNAL_VENDOR_UNKNOWN,
      status: CANDIDATE_STATUS.PENDING,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      resolvedAt: null,
      symbolChangeId: null,
    });
    const codes = (rows[0]?.suggestions as unknown as CodeSuggestion[]).map((s) => s.code);
    expect(codes.slice(0, 2)).toContain('BBB');
    expect(codes).not.toContain('AAA');
    expect(codes).not.toContain('DDD');
    // 已报价的锚不产生候选。
    expect(await candidatesOf('us:CCC')).toEqual([]);
  });

  it('② 无任何建议 ⇒ 候选标「代码失效」(suggestions 为空数组, branch 22 的生成半)', async () => {
    await seedAnchor('us:EEE');
    await seedAnchor('us:CCC');
    unknown = ['us:EEE'];

    await useCase.execute(NOW);

    const rows = await candidatesOf('us:EEE');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(CANDIDATE_STATUS.PENDING);
    expect(rows[0]?.suggestions).toEqual([]);
  });

  it('③ 预置 DISMISSED 后同一 ticker 再报未知 ⇒ 不新增候选 (branch 24)', async () => {
    await seedAnchor('us:AAA');
    await seedAnchor('us:CCC');
    await prisma.symbolChangeCandidate.create({
      data: {
        ticker: 'us:AAA',
        signal: CANDIDATE_SIGNAL_VENDOR_UNKNOWN,
        suggestions: [],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        status: CANDIDATE_STATUS.DISMISSED,
        resolvedAt: NOW,
        resolutionNote: '合成: 人工判定非改名',
      },
    });
    unknown = ['us:AAA'];

    await useCase.execute(LATER);

    const rows = await candidatesOf('us:AAA');
    expect(rows.map((r) => r.status)).toEqual([CANDIDATE_STATUS.DISMISSED]);
    // 驳回行本身也不被「刷新最近观测」改写。
    expect(rows[0]?.lastSeenAt).toEqual(NOW);
  });

  it('④ 同一 ticker 连续两拍 ⇒ 仍只一条 PENDING, 只刷新最近观测', async () => {
    await seedAnchor('us:AAA');
    await seedAnchor('us:CCC');
    unknown = ['us:AAA'];

    await useCase.execute(NOW);
    await useCase.execute(LATER);

    const rows = await candidatesOf('us:AAA');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: CANDIDATE_STATUS.PENDING,
      firstSeenAt: NOW,
      lastSeenAt: LATER,
    });
  });
});
