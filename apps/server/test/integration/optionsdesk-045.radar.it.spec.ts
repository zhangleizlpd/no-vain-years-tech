import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { recordingOutboxPublisher } from '../_support/outbox-stub';
import { PrismaService } from '../../src/security/prisma.service';
import { classifyZone, computeDistanceToWPct, computeW } from '../../src/optionsdesk/anchor.rules';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { ReviewAnchorUseCase } from '../../src/optionsdesk/review-anchor.usecase';
import { ListAnchorsUseCase } from '../../src/optionsdesk/list-anchors.usecase';
import { SyncAnchorQuoteUseCase } from '../../src/optionsdesk/sync-anchor-quote';
import {
  GetRadarUseCase,
  RADAR_EMPTY_STATE_MESSAGES,
  type RadarPage,
} from '../../src/optionsdesk/get-radar.usecase';

// 045 T014 US2 集成 IT (**SC-006**) —— 真 PG 端到端: **IT 内塞真行 us `Instrument` + `DailyBar`**
// (spec 明定的验收方式, 不碰任何 vendor) → `last_close` 单向投影 → 雷达读端返真值。
//
// 覆盖 state_branch: 正常进雷达 / 逾期红标行不隐藏 / excluded 不进雷达 / 复核锚四条 /
// 色带区间三条 / 行情三档 (当日·陈旧·不可得) / 空态两条 / 游标分页 / 并列 tiebreaker /
// 筛选 SQL 端 / 筛选空 / `last_close` 单向。EC-15 (锚已建但从未采集) 单列。
//
// 装配方式 = 直接 new usecase + 真 `PrismaService` (体例同 optionsdesk-045.anchor.it.spec.ts):
// 验证面是**落库口径与 SQL 语义**; HTTP 通道层由 controller spec 覆盖, 此处不起 Nest 容器。
describe('045 optionsdesk US2 雷达集成 IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createAnchor: CreateAnchorUseCase;
  let reviewAnchor: ReviewAnchorUseCase;
  let listAnchors: ListAnchorsUseCase;
  let syncQuote: SyncAnchorQuoteUseCase;
  let getRadar: GetRadarUseCase;

  /** V = 50 ⇒ W = 40 (由 rules 派生, 本文件零档位字面量, SC-005)。 */
  const V = '50';
  const W = computeW(V);
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const todayUtc = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  };
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    createAnchor = new CreateAnchorUseCase(prisma, recordingOutboxPublisher());
    reviewAnchor = new ReviewAnchorUseCase(prisma);
    listAnchors = new ListAnchorsUseCase(prisma);
    syncQuote = new SyncAnchorQuoteUseCase(prisma);
    getRadar = new GetRadarUseCase(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change RESTART IDENTITY',
    );
    await prisma.$executeRawUnsafe(
      'TRUNCATE marketdata.daily_bar, marketdata.instrument RESTART IDENTITY CASCADE',
    );
  });

  // ── fixture helpers ────────────────────────────────────────────────────────

  /** 塞一行真 us `Instrument` (与富途/理杏仁无关, 纯本地行)。 */
  async function seedInstrument(code: string): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'us',
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
      },
      select: { id: true },
    });
    return row.id;
  }

  /** 塞一行真 `DailyBar` (adjust = none, D7 原始价口径)。 */
  async function seedBar(instrumentId: bigint, tradeDate: Date, close: string): Promise<void> {
    await prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate,
        adjust: 'none',
        open: close,
        high: close,
        low: close,
        close,
      },
    });
  }

  interface AnchorFixture {
    code: string;
    /** 收盘价; 省略 = 该标的**从未被采集** (EC-15)。 */
    close?: string;
    /** bar 的 session 日 (缺省今日)。 */
    tradeDate?: Date;
    v?: string;
    confidence?: string;
    excluded?: boolean;
    nextReview?: Date | null;
    /** 未注册 instrument (连标的都不在库) → 只建锚不塞行。 */
    unregistered?: boolean;
  }

  /** 建锚 (+ 可选真行情行), 返回锚 id。 */
  async function seedAnchor(fixture: AnchorFixture): Promise<bigint> {
    if (fixture.unregistered !== true) {
      const instrumentId = await seedInstrument(fixture.code);
      if (fixture.close !== undefined) {
        await seedBar(instrumentId, fixture.tradeDate ?? todayUtc(), fixture.close);
      }
    }
    const created = await createAnchor.execute({
      ticker: `us:${fixture.code}`,
      v: fixture.v ?? V,
      asof: day('2026-06-30'),
      method: 'dcf',
      confidence: fixture.confidence ?? '8', // → L2
      excluded: fixture.excluded,
      excludeReason: fixture.excluded === true ? '暂不交易' : null,
      nextReview: fixture.nextReview === undefined ? day('2099-01-01') : fixture.nextReview,
    });
    return created.id;
  }

  /** 把锚「变老」—— 建锚当日回填的 last_reviewed_on 会压住红标, 复核锚场景须先退回过去。 */
  async function backdateAnchor(id: bigint, on: Date): Promise<void> {
    await prisma.anchor.update({
      where: { id },
      data: { createdAt: on, lastReviewedOn: on },
    });
  }

  const tickerOf = (page: RadarPage) => page.items.map((i) => i.row.ticker);

  // ── 真行 Instrument + DailyBar → 投影 → 雷达返真值 ─────────────────────────

  describe('塞真行 us Instrument + DailyBar → 雷达返真值 (spec 明定验收方式)', () => {
    it('雷达返真值 + asOf = last_close_date = bar 的 tradeDate (FR-016/FR-036)', async () => {
      const tradeDate = day('2026-07-31');
      await seedAnchor({ code: 'AOS', close: '36', tradeDate });

      const report = await syncQuote.execute();
      expect(report.projections[0]).toMatchObject({ ticker: 'us:AOS', asOf: '2026-07-31' });

      const page = await getRadar.execute();
      const view = page.items[0]!;
      expect(view.row.ticker).toBe('us:AOS');
      expect(view.row.lastClose!.toString()).toBe('36');
      expect(isoDay(view.row.lastCloseDate!)).toBe('2026-07-31');
      // 距 W% 真值与 rules 单点口径逐位一致 (读端不另算一套)
      expect(view.distanceToWPct!.toFixed(4)).toBe(computeDistanceToWPct(V, '36')!.toFixed(4));
      expect(view.zone).toBe(classifyZone(V, '36'));
    });

    it('🚨 last_close 单向: 投影 + 雷达读全程不反写 marketdata.daily_bar', async () => {
      const tradeDate = day('2026-07-31');
      await seedAnchor({ code: 'AOS', close: '36', tradeDate });
      const before = await prisma.dailyBar.findMany({ orderBy: { id: 'asc' } });

      await syncQuote.execute();
      await getRadar.execute();

      const after = await prisma.dailyBar.findMany({ orderBy: { id: 'asc' } });
      expect(after).toHaveLength(before.length);
      expect(after[0]!.close.toString()).toBe(before[0]!.close.toString());
      expect(after[0]!.tradeDate.toISOString()).toBe(before[0]!.tradeDate.toISOString());
    });

    it('🚨 EC-15 锚已建但该标的从未被采集 → 行仍在列表且显式行情不可用 (禁 0 值 / 禁隐藏 / 禁整页失败)', async () => {
      await seedAnchor({ code: 'NEW' }); // instrument 已注册但无任何 bar
      await seedAnchor({ code: 'GHOST', unregistered: true }); // 连 instrument 都没有

      const report = await syncQuote.execute();
      expect(report.projections.every((p) => p.hasData === false)).toBe(true);
      expect(report.updated).toBe(0);

      const page = await getRadar.execute();
      expect(tickerOf(page).sort()).toEqual(['us:GHOST', 'us:NEW']); // 行未被剔除
      for (const view of page.items) {
        expect(view.row.lastClose).toBeNull(); // 不写 0
        expect(view.row.lastCloseDate).toBeNull();
        expect(view.distanceToWPct).toBeNull();
        expect(view.zone).toBeNull();
      }
    });

    it('行情三档 (当日 / 陈旧 / 不可得) 各自可辨且互不混淆 (FR-016/FR-017)', async () => {
      const today = todayUtc();
      await seedAnchor({ code: 'FRESH', close: '36', tradeDate: today });
      await seedAnchor({ code: 'STALE', close: '36', tradeDate: day('2026-01-05') });
      await seedAnchor({ code: 'NODATA' });

      await syncQuote.execute();
      const page = await getRadar.execute();
      const byTicker = new Map(page.items.map((i) => [i.row.ticker, i]));

      expect(isoDay(byTicker.get('us:FRESH')!.row.lastCloseDate!)).toBe(isoDay(today));
      expect(isoDay(byTicker.get('us:STALE')!.row.lastCloseDate!)).toBe('2026-01-05');
      expect(byTicker.get('us:NODATA')!.row.lastCloseDate).toBeNull();
      // 三档都带各自的 asOf 语义: 数值与 asOf 同生共死 (无裸数值)
      expect(byTicker.get('us:NODATA')!.row.lastClose).toBeNull();
    });
  });

  // ── 基础语义 ───────────────────────────────────────────────────────────────

  describe('基础语义: 进雷达 / 逾期 / excluded / 色带区间', () => {
    it('锚存在 ∧ 未逾期 ∧ 未 excluded → 正常进雷达, 派生值齐备', async () => {
      await seedAnchor({ code: 'AOS', close: '36' });
      await syncQuote.execute();

      const page = await getRadar.execute();
      const view = page.items[0]!;
      expect(view.overdue).toBe(false);
      expect(view.row.excluded).toBe(false);
      expect(view.effective.lLevel).toBe('L2');
      expect(view.w.toString()).toBe(W.toString());
    });

    it('逾期锚 → 行**不隐藏**, overdue 标记为真 (红标是提醒不是过滤器)', async () => {
      await seedAnchor({ code: 'OLD', close: '36', nextReview: day('2020-01-01') });
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(tickerOf(page)).toEqual(['us:OLD']);
      expect(page.items[0]!.overdue).toBe(true);
    });

    it('🚨 Guardrail 12: excluded 不进雷达, 但在锚列表可见并带 excludeReason', async () => {
      await seedAnchor({ code: 'AOS', close: '36' });
      await seedAnchor({ code: 'SKIP', close: '30', excluded: true });
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(tickerOf(page)).toEqual(['us:AOS']);

      const anchors = await listAnchors.execute();
      const skipped = anchors.find((a) => a.row.ticker === 'us:SKIP')!;
      expect(skipped.row.excluded).toBe(true);
      expect(skipped.row.excludeReason).toBe('暂不交易');
    });

    it('色带区间三条: 深买区 / 买区 / 薄带按 spot 归属 (与 rules 同口径)', async () => {
      await seedAnchor({ code: 'DEEP', close: '25' }); // < 内段下界
      await seedAnchor({ code: 'BUY', close: '36' }); // 下界 ~ W
      await seedAnchor({ code: 'THIN', close: '45' }); // W ~ V
      await syncQuote.execute();

      const page = await getRadar.execute();
      const zones = new Map(page.items.map((i) => [i.row.ticker, i.zone]));
      expect(zones.get('us:DEEP')).toBe('deep_buy');
      expect(zones.get('us:BUY')).toBe('buy');
      expect(zones.get('us:THIN')).toBe('thin');
    });
  });

  // ── 复核锚状态机 (FR-013) ──────────────────────────────────────────────────

  describe('复核锚状态机四条转移 (FR-013 / EC-12 / EC-13)', () => {
    it('① spot 由上穿下 → 本轮起点落库 + 红标亮', async () => {
      const id = await seedAnchor({ code: 'AOS', close: '36', tradeDate: day('2026-07-31') });
      await backdateAnchor(id, day('2026-05-01'));
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(isoDay(page.items[0]!.row.breachStartedOn!)).toBe('2026-07-31');
      expect(page.items[0]!.reviewFlagOn).toBe(true);
    });

    it('② 完成一次定期复审 → 红标解除, 但区间徽标照常 (EC-12, 唯一解除动作)', async () => {
      const id = await seedAnchor({ code: 'AOS', close: '36', tradeDate: day('2026-07-31') });
      await backdateAnchor(id, day('2026-05-01'));
      await syncQuote.execute();
      await getRadar.execute(); // 置起点

      await reviewAnchor.execute(id, day('2099-01-01'));

      const page = await getRadar.execute();
      expect(page.items[0]!.reviewFlagOn).toBe(false);
      expect(page.items[0]!.zone).toBe('buy'); // 区间徽标不随红标一起消失
      expect(page.items[0]!.row.breachStartedOn).not.toBeNull(); // 复审不清起点
    });

    it('③ spot 回到 W 上方 → 起点清空; 再跌破 = 新一轮, 红标重新亮 (EC-13)', async () => {
      const id = await seedAnchor({ code: 'AOS', close: '36', tradeDate: day('2026-07-20') });
      await backdateAnchor(id, day('2026-05-01'));
      await syncQuote.execute();
      await getRadar.execute();
      await reviewAnchor.execute(id, day('2099-01-01')); // 本轮已复审 ⇒ 红标灭
      // 复审动作按定义盖**今日**戳; 本 fixture 的 bar 是历史日期, 把复审日倒回轮次当时,
      // 才能让「新一轮起点晚于最近复审」这条 EC-13 的关键条件在历史时间轴上成立。
      await prisma.anchor.update({ where: { id }, data: { lastReviewedOn: day('2026-07-21') } });

      // 回到 W 上方
      const instrument = await prisma.instrument.findFirstOrThrow({ where: { code: 'AOS' } });
      await seedBar(instrument.id, day('2026-07-22'), '45');
      await syncQuote.execute();
      const cleared = await getRadar.execute();
      expect(cleared.items[0]!.row.breachStartedOn).toBeNull();
      expect(cleared.items[0]!.reviewFlagOn).toBe(false);

      // 新一轮跌破 (起点晚于最近复审) ⇒ 红标重新亮
      await seedBar(instrument.id, day('2026-07-23'), '30');
      await syncQuote.execute();
      const relit = await getRadar.execute();
      expect(isoDay(relit.items[0]!.row.breachStartedOn!)).toBe('2026-07-23');
      expect(relit.items[0]!.reviewFlagOn).toBe(true);
    });

    it('④ 行情不可用期间 → 起点既不推进也不清空, 红标维持上一次可判定状态', async () => {
      const id = await seedAnchor({ code: 'AOS', close: '36', tradeDate: day('2026-07-31') });
      await backdateAnchor(id, day('2026-05-01'));
      await syncQuote.execute();
      await getRadar.execute();

      // 行情不可用: 把投影清掉 (模拟从未采到 / 采集中断), 起点保持
      await prisma.anchor.update({
        where: { id },
        data: { lastClose: null, lastCloseDate: null },
      });

      const page = await getRadar.execute();
      expect(isoDay(page.items[0]!.row.breachStartedOn!)).toBe('2026-07-31');
      expect(page.items[0]!.reviewFlagOn).toBe(true); // 维持上一次可判定状态
      expect(page.items[0]!.row.lastClose).toBeNull(); // 与「行情不可用」标记一同呈现
    });

    it('建锚时 spot 已在 W 之下 → 本轮起点 = 建锚当日, 且当日不误亮红标 (建锚即一次确认)', async () => {
      await seedAnchor({ code: 'AOS', close: '30', tradeDate: day('2026-07-20') }); // bar 比锚老
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(isoDay(page.items[0]!.row.breachStartedOn!)).toBe(isoDay(todayUtc()));
      expect(page.items[0]!.reviewFlagOn).toBe(false);
    });
  });

  // ── 游标分页 + SQL 端筛选 ─────────────────────────────────────────────────

  describe('游标分页 + SQL 端筛选 (FR-033 / FR-034)', () => {
    it('翻页期间改动 last_close → 不漏行、不重复 (keyset, 非 OFFSET)', async () => {
      for (const [code, close] of [
        ['A', '30'],
        ['B', '32'],
        ['C', '34'],
        ['D', '36'],
        ['E', '38'],
      ] as const) {
        await seedAnchor({ code, close });
      }
      await syncQuote.execute();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: RadarPage = await getRadar.execute({ limit: 2, cursor });
        if (page.items.length === 0) break;
        seen.push(...tickerOf(page));
        if (guard === 0) {
          // 翻页期间一次「行情刷新」: 已翻过的行价格下探 (排序键前移, 不会再被吐出来)
          await prisma.anchor.update({
            where: { ticker: 'us:A' },
            data: { lastClose: '20' },
          });
        }
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5); // 不重复
      expect(seen.sort()).toEqual(['us:A', 'us:B', 'us:C', 'us:D', 'us:E']); // 不漏行
    });

    it('距 W% 并列 → 锚 id 升序 tiebreaker, 逐页序稳定可复现', async () => {
      for (const code of ['T1', 'T2', 'T3']) {
        await seedAnchor({ code, close: '36' }); // 同 V 同 close ⇒ 距 W% 完全并列
      }
      await syncQuote.execute();

      const ids: bigint[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard++) {
        const page: RadarPage = await getRadar.execute({ limit: 1, cursor });
        if (page.items.length === 0) break;
        ids.push(page.items[0]!.row.id);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(ids).toHaveLength(3);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    it('筛选在 SQL 端求值且与游标同时生效 (生效 L 层多选)', async () => {
      await seedAnchor({ code: 'H1', close: '30', confidence: '9' }); // L1
      await seedAnchor({ code: 'M1', close: '32', confidence: '8' }); // L2
      await seedAnchor({ code: 'M2', close: '34', confidence: '8' }); // L2
      await seedAnchor({ code: 'L1X', close: '36', confidence: '2' }); // L4
      await syncQuote.execute();

      const filter = { lLevels: ['L2'] as const };
      const first = await getRadar.execute({ limit: 1, filter });
      expect(tickerOf(first)).toEqual(['us:M1']);
      expect(first.hasMore).toBe(true);

      const second = await getRadar.execute({ limit: 1, cursor: first.nextCursor, filter });
      expect(tickerOf(second)).toEqual(['us:M2']);
      expect(second.hasMore).toBe(false);
    });

    it('待复审 / 跌破 W 两个筛选各自在 SQL 端生效', async () => {
      await seedAnchor({ code: 'DUE', close: '45', nextReview: day('2020-01-01') });
      await seedAnchor({ code: 'BELOW', close: '30' });
      await syncQuote.execute();

      const overdue = await getRadar.execute({ filter: { pendingReview: true } });
      expect(tickerOf(overdue)).toEqual(['us:DUE']);

      const below = await getRadar.execute({ filter: { belowW: true } });
      expect(tickerOf(below)).toEqual(['us:BELOW']);
    });

    it('跌破 W 筛选不把「行情不可用」的行算作跌破 (禁伪造)', async () => {
      await seedAnchor({ code: 'NODATA' });
      await seedAnchor({ code: 'BELOW', close: '30' });
      await syncQuote.execute();

      const below = await getRadar.execute({ filter: { belowW: true } });
      expect(tickerOf(below)).toEqual(['us:BELOW']);
    });
  });

  // ── SC-006 四种降级态 ─────────────────────────────────────────────────────

  describe('SC-006 四种降级态各自可见且互不混淆', () => {
    it('① 锚库为空 → zero_anchors + 引导建锚文案 (非空白页)', async () => {
      const page = await getRadar.execute();
      expect(page.items).toHaveLength(0);
      expect(page.emptyState).toBe('zero_anchors');
      expect(page.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.zero_anchors);
    });

    it('② 全体不动区 → all_idle + 「今日无解」文案, 且行**照常渲染**', async () => {
      await seedAnchor({ code: 'HIGH1', close: '45' });
      await seedAnchor({ code: 'HIGH2', close: '48' });
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(page.items).toHaveLength(2); // 行不隐藏
      expect(page.emptyState).toBe('all_idle');
      expect(page.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.all_idle);
    });

    it('③ 单票行情缺失 → 该行降级但其余行正常, 不整页降级 (与 all_idle 不混淆)', async () => {
      await seedAnchor({ code: 'OK', close: '30' });
      await seedAnchor({ code: 'MISSING' });
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(page.items).toHaveLength(2);
      expect(page.emptyState).toBeNull(); // 有可动标的 ⇒ 不是不动区
      const missing = page.items.find((i) => i.row.ticker === 'us:MISSING')!;
      const ok = page.items.find((i) => i.row.ticker === 'us:OK')!;
      expect(missing.row.lastClose).toBeNull();
      expect(ok.row.lastClose!.toString()).toBe('30');
    });

    it('④ 锚逾期 → 行内 overdue 标记, 与前三态互不混淆', async () => {
      await seedAnchor({ code: 'DUE', close: '30', nextReview: day('2020-01-01') });
      await syncQuote.execute();

      const page = await getRadar.execute();
      expect(page.emptyState).toBeNull();
      expect(page.items[0]!.overdue).toBe(true);
      expect(page.items[0]!.row.lastClose).not.toBeNull();
    });

    it('筛选后为空 → filtered_empty (与零锚 / 不动区文案互不复用)', async () => {
      await seedAnchor({ code: 'AOS', close: '30', confidence: '8' }); // L2
      await syncQuote.execute();

      const page = await getRadar.execute({ filter: { lLevels: ['L1'] } });
      expect(page.items).toHaveLength(0);
      expect(page.emptyState).toBe('filtered_empty');
      expect(page.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.filtered_empty);
      expect(page.emptyStateMessage).not.toBe(RADAR_EMPTY_STATE_MESSAGES.zero_anchors);
      expect(page.emptyStateMessage).not.toBe(RADAR_EMPTY_STATE_MESSAGES.all_idle);
    });
  });
});
