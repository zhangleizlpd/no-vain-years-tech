import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { classifyZone, computeW, isBelowW } from './anchor.rules';
import { isAnchorReviewFlagOn } from './review-anchor.usecase';
import {
  GetRadarUseCase,
  RADAR_EMPTY_STATE_MESSAGES,
  RADAR_EMPTY_STATES,
  resolveBreachTransition,
  resolveRadarEmptyState,
} from './get-radar.usecase';
import { encodeRadarCursor } from './radar-cursor';
import { INTRADAY_FRESHNESS_SECONDS, resolveAnchorSpot } from './intraday-spot.rules';
import type { PrismaService } from '../security/prisma.service';
import {
  stubTradingCalendar,
  type TradingCalendarStub,
} from '../../test/_support/trading-calendar-stub';

type Fn = ReturnType<typeof vi.fn>;

/** V = 50 ⇒ W = 40 (由 rules 派生, 本文件不写任何档位字面量, SC-005)。 */
const V = new Prisma.Decimal('50');
const W = computeW(V);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const anchorRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  ticker: (overrides.ticker as string | undefined) ?? 'us:AOS',
  // 🚨 跟随 ticker 派生, MUST NOT 写死 'us' —— 065 起本文件有 override 成 hk 的用例, 写死会种出
  //    market 与 ticker 不一致的行, 而那种行恰好会让市场作用域的断言**假绿**。
  market: ((overrides.ticker as string | undefined) ?? 'us:AOS').split(':')[0]!,
  v: V,
  asof: day('2026-06-30'),
  method: 'dcf',
  confidence: new Prisma.Decimal('8'),
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  nextReview: day('2026-09-30'),
  lastReviewedOn: day('2026-06-30'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L2',
  lastClose: new Prisma.Decimal('36'),
  lastCloseDate: day('2026-07-31'),
  // 061: 盘中两列默认空 = 「还没经历过任何盘中采集」⇒ 恒收盘档 (state_branch 13)。
  intradayPrice: null,
  intradayAt: null,
  breachStartedOn: null,
  createdAt: day('2026-05-01'),
  updatedAt: day('2026-07-31'),
  ...overrides,
});

/** `now` 之前 n 秒 —— 闸内 / 闸外一律由 {@link INTRADAY_FRESHNESS_SECONDS} 派生, 不写 90。 */
const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

describe('resolveBreachTransition — FR-013 复核锚状态机四条转移', () => {
  const base = {
    v: V,
    lastClose: new Prisma.Decimal('36'), // < W
    lastCloseDate: day('2026-07-31'),
    createdAt: day('2026-05-01'),
    breachStartedOn: null as Date | null,
  };

  it('① spot 由上穿下 ∧ 本轮起点为空 → 写入本轮起点 = 观测日 (行情 session 日)', () => {
    const t = resolveBreachTransition(base);
    expect(t.changed).toBe(true);
    expect(t.next?.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('① 本轮进行中 (起点非空 ∧ 仍在 W 下) → 不推进起点 (起点是本轮身份)', () => {
    const t = resolveBreachTransition({ ...base, breachStartedOn: day('2026-07-20') });
    expect(t.changed).toBe(false);
    expect(t.next).toEqual(day('2026-07-20'));
  });

  it('② spot 回到 W 上方 → 清空本轮起点', () => {
    const t = resolveBreachTransition({
      ...base,
      lastClose: new Prisma.Decimal('45'),
      breachStartedOn: day('2026-07-20'),
    });
    expect(t).toEqual({ next: null, changed: true });
  });

  it('② spot 在 W 上方且本就无起点 → 无写入 (不产生噪声 UPDATE)', () => {
    const t = resolveBreachTransition({ ...base, lastClose: new Prisma.Decimal('45') });
    expect(t).toEqual({ next: null, changed: false });
  });

  it('③ 建锚时 spot 已在 W 之下 → 本轮起点 = 建锚当日 (bar 早于建锚也不倒推)', () => {
    const t = resolveBreachTransition({
      ...base,
      createdAt: day('2026-08-01'),
      lastCloseDate: day('2026-07-31'), // bar 比锚老
    });
    expect(t.next?.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('④ 行情不可用 → 既不推进也不清空 (起点原样保留)', () => {
    const held = resolveBreachTransition({
      ...base,
      lastClose: null,
      lastCloseDate: null,
      breachStartedOn: day('2026-07-20'),
    });
    expect(held).toEqual({ next: day('2026-07-20'), changed: false });

    const idle = resolveBreachTransition({ ...base, lastClose: null, lastCloseDate: null });
    expect(idle).toEqual({ next: null, changed: false });
  });

  it('🚨 EC-11 spot 恰好 = W → 不算跌破, 与区间归属取同一侧 (thin) 且可复现', () => {
    const atW = { ...base, lastClose: W };
    expect(classifyZone(V, W)).toBe('thin'); // 下界闭上界开 ⇒ 归 W 上侧
    expect(resolveBreachTransition(atW)).toEqual({ next: null, changed: false });
    // 本轮进行中时恰好回到 W ⇒ 视为已回到上方, 清空起点 (同一侧判定)
    expect(resolveBreachTransition({ ...atW, breachStartedOn: day('2026-07-20') })).toEqual({
      next: null,
      changed: true,
    });
  });

  it('🚨 EC-13 W 上下反复穿越 → 每次由上穿下都算新一轮, 红标可重新亮起', () => {
    const reviewedOn = day('2026-07-21');
    // 第 1 轮: 07-20 跌破 → 07-21 完成复审 ⇒ 红标解除
    const round1 = resolveBreachTransition({ ...base, lastCloseDate: day('2026-07-20') });
    expect(
      isAnchorReviewFlagOn({
        v: V,
        lastClose: base.lastClose,
        lastReviewedOn: reviewedOn,
        breachStartedOn: round1.next,
      }),
    ).toBe(false);

    // 回到 W 上方 → 清空
    const cleared = resolveBreachTransition({
      ...base,
      lastClose: new Prisma.Decimal('45'),
      lastCloseDate: day('2026-07-22'),
      breachStartedOn: round1.next,
    });
    expect(cleared.next).toBeNull();

    // 第 2 轮: 07-23 再次跌破 ⇒ 新起点晚于最近复审 ⇒ 红标重新亮 (不因「本轮已复审过」失效)
    const round2 = resolveBreachTransition({ ...base, lastCloseDate: day('2026-07-23') });
    expect(round2.next).toEqual(day('2026-07-23'));
    expect(
      isAnchorReviewFlagOn({
        v: V,
        lastClose: base.lastClose,
        lastReviewedOn: reviewedOn,
        breachStartedOn: round2.next,
      }),
    ).toBe(true);
  });

  it('🚨 EC-13 同一交易日内反复穿越 → 新一轮起点照常写入 (无「本轮已复审」抑制位)', () => {
    const sameDay = day('2026-07-31');
    const down1 = resolveBreachTransition({ ...base, lastCloseDate: sameDay });
    const up = resolveBreachTransition({
      ...base,
      lastClose: new Prisma.Decimal('45'),
      lastCloseDate: sameDay,
      breachStartedOn: down1.next,
    });
    expect(up.next).toBeNull();
    const down2 = resolveBreachTransition({ ...base, lastCloseDate: sameDay });
    expect(down2).toEqual({ next: sameDay, changed: true });
  });
});

describe('resolveRadarEmptyState — 四空态 (FR-008/FR-009/FR-010, FR-015 + FR-034)', () => {
  const base = {
    baseTotal: 5,
    globalBaseTotal: 5,
    pageItems: 3,
    actionableTotal: 1,
    firstPage: true,
  };

  it('锚库为空 → zero_anchors (引导建锚)', () => {
    expect(
      resolveRadarEmptyState({ ...base, baseTotal: 0, globalBaseTotal: 0, pageItems: 0 }),
    ).toBe('zero_anchors');
  });

  it('065 库里有锚但本市场一只都没有 → zero_anchors_in_market (引导切市场)', () => {
    expect(
      resolveRadarEmptyState({ ...base, baseTotal: 0, globalBaseTotal: 7, pageItems: 0 }),
    ).toBe('zero_anchors_in_market');
  });

  it('🚨 065 优先级: 整库为空 ∧ 本市场为空 → 落 zero_anchors 而非 zero_anchors_in_market', () => {
    // 两个条件此时**同时**成立, 判定序是唯一的分辨器。落错了不会红也不会崩 —— 只是把人支到
    // 另一个同样空的页签, 还暗示「你的锚在别处」(其实并没有)。
    expect(
      resolveRadarEmptyState({ ...base, baseTotal: 0, globalBaseTotal: 0, pageItems: 0 }),
    ).not.toBe('zero_anchors_in_market');
  });

  it('有锚但筛选后为空 → filtered_empty (不是零锚)', () => {
    expect(resolveRadarEmptyState({ ...base, pageItems: 0 })).toBe('filtered_empty');
  });

  it('有锚有行但无一只跌破 W → all_idle (行照常渲染, 只加提示)', () => {
    expect(resolveRadarEmptyState({ ...base, actionableTotal: 0 })).toBe('all_idle');
  });

  it('有可动标的 → 无空态', () => {
    expect(resolveRadarEmptyState(base)).toBeNull();
  });

  it('续页 (带游标) 不判空态 —— 空态是「打开雷达」这一刻的语义', () => {
    expect(resolveRadarEmptyState({ ...base, pageItems: 0, firstPage: false })).toBeNull();
  });

  it('🚨 四态文案两两不同, MUST NOT 复用 (FR-034 明令与 FR-015 区分)', () => {
    const texts = Object.values(RADAR_EMPTY_STATE_MESSAGES);
    expect(texts).toHaveLength(RADAR_EMPTY_STATES.length); // 加了枚举值必须补文案
    expect(new Set(texts).size).toBe(texts.length);
    expect(RADAR_EMPTY_STATE_MESSAGES.all_idle).toContain('今日无解');
    expect(RADAR_EMPTY_STATE_MESSAGES.filtered_empty).toContain('筛选');
    expect(RADAR_EMPTY_STATE_MESSAGES.zero_anchors).not.toContain('筛选');
    // 🚨 第 4 态的有效动作是**切市场**不是**建锚** —— 两条文案措辞必须真的不同,
    //    复制第一条过来会让用户以为自己之前建的锚丢了。
    expect(RADAR_EMPTY_STATE_MESSAGES.zero_anchors_in_market).toContain('市场');
    expect(RADAR_EMPTY_STATE_MESSAGES.zero_anchors_in_market).not.toContain('建');
    expect(RADAR_EMPTY_STATE_MESSAGES.zero_anchors).toContain('建');
  });
});

interface RadarKeyRowFixture {
  anchor_id: string;
  distance_text: string | null;
}

interface PrismaMock {
  prisma: PrismaService;
  /** 062 T010: 陈旧度基准改走 `TRADING_CALENDAR_PORT`，不再是 `tradingDay.findFirst`。 */
  calendar: TradingCalendarStub;
  queryRaw: Fn;
  findMany: Fn;
  updateMany: Fn;
  /** D13 标的名的批量取数 (`marketdata.instrument`)。 */
  instrumentFindMany: Fn;
  /**
   * 覆盖「取一页键」那条查询的返回。061 T019 起 `$queryRaw` 服务**两条**查询 (空态计数 +
   * 取页键), 直接 `queryRaw.mockResolvedValue(...)` 会把计数查询一并顶掉 ⇒ 改走这个入口。
   */
  setPageKeys: (keys: RadarKeyRowFixture[]) => void;
}

/**
 * 空态计数查询的 fixture 侧求值 —— 与 SQL 的 `GROUP BY market` + `COUNT(*) FILTER (WHERE spot < W)`
 * 同语义: 只数 `excluded = false` 的行、**按市场分组**, spot 走 rules 单点 {@link resolveAnchorSpot}。
 * 真 SQL 与它的等价性由 IT (`optionsdesk-045.radar.it.spec.ts`) 覆盖, 本文件只钉「计数吃的是哪个
 * 口径、按什么分组」。
 *
 * 🚨 065 起回**多行**(每市场一行): 计数一次查回全部市场是 plan D4 的刻意选择 —— 同一次扫描额外
 * 换来 FR-016 的跨页签小圆点与 FR-015 的失联市场告警, 严格优于只查当前作用域。
 */
function countBaseSet(rows: readonly ReturnType<typeof anchorRow>[], now: Date) {
  const byMarket = new Map<string, { base_total: number; actionable_total: number }>();
  for (const r of rows.filter((row) => row.excluded === false)) {
    const { price } = resolveAnchorSpot(
      {
        intradayPrice: r.intradayPrice,
        intradayAt: r.intradayAt,
        lastClose: r.lastClose,
        lastCloseDate: r.lastCloseDate,
      },
      now,
    );
    const actionable = price !== null && isBelowW(r.vManual ?? r.v, price);
    const cur = byMarket.get(r.market) ?? { base_total: 0, actionable_total: 0 };
    byMarket.set(r.market, {
      base_total: cur.base_total + 1,
      actionable_total: cur.actionable_total + (actionable ? 1 : 0),
    });
  }
  return [...byMarket].map(([market, counts]) => ({ market, ...counts }));
}

function buildPrismaMock(rows = [anchorRow()]): PrismaMock {
  let pageKeys: RadarKeyRowFixture[] = rows.map((r) => ({
    anchor_id: r.id.toString(),
    distance_text: '-10.0000',
  }));
  // `$queryRaw` 服务两条查询 ⇒ 按 SQL 文本分派 (计数查询先发, 取页键后发)。
  const queryRaw = vi.fn(async (arg: { sql: string }) =>
    arg.sql.includes('actionable_total') ? countBaseSet(rows, new Date()) : pageKeys,
  );
  // 🚨 mock **必须认** `where.market` —— 065 D2 的否定断言全靠它: 若 mock 无视 market 谓词,
  //    有人给状态机扫描 (`advanceBreachState`) 加上 scope 也照样全绿, 那颗钉子就是**假的**。
  //    状态机那条 `findMany` 无 `where` ⇒ 回全部行 (含 excluded, 维护 ≠ 展示);
  //    `hydrate` 那条带 `where.id` ⇒ 回非 excluded 行 (雷达不展示 excluded)。
  const findMany = vi.fn(async (args: { where?: Record<string, unknown> }) => {
    const market = args.where?.market;
    const scoped = market === undefined ? rows : rows.filter((r) => r.market === market);
    return args.where === undefined ? scoped : scoped.filter((r) => r.excluded === false);
  });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const calendar = stubTradingCalendar();
  // D13 标的名: 批量一次 findMany, 谓词按市场分组 —— 只回被问到的那些票
  // (cn 一律不回 = 「这票没在行情库注册」, 供退回代号那条用例)。
  const instrumentFindMany = vi.fn(
    async (args: { where: { OR: { market: string; code: { in: string[] } }[] } }) =>
      args.where.OR.filter((group) => group.market !== 'cn').flatMap((group) =>
        group.code.in.map((code) => ({
          market: group.market,
          code,
          name: `${group.market}-${code} 的名字`,
        })),
      ),
  );
  const prisma = {
    anchor: { findMany, updateMany },
    instrument: { findMany: instrumentFindMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  return {
    prisma,
    queryRaw,
    findMany,
    updateMany,
    instrumentFindMany,
    calendar,
    setPageKeys: (keys) => {
      pageKeys = keys;
    },
  };
}

describe('GetRadarUseCase — SQL 端排序/筛选 + keyset 分页 (FR-010/033/034)', () => {
  let m: PrismaMock;
  let useCase: GetRadarUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
  });

  const sqlCalls = (): { sql: string; values: unknown[] }[] =>
    m.queryRaw.mock.calls.map((c) => c[0] as { sql: string; values: unknown[] });

  /** 取页键那条 —— 计数查询先发, 故它恒是最后一条。 */
  const lastSql = (): { sql: string; values: unknown[] } => sqlCalls().at(-1)!;

  /** 空态计数那条 (061 T019); 未发出时为 `undefined`。 */
  const countSql = (): { sql: string; values: unknown[] } | undefined =>
    sqlCalls().find((a) => a.sql.includes('actionable_total'));

  it('🚨 Guardrail 12: 基础 WHERE 排除 excluded (锚列表相反, 不共用查询)', async () => {
    await useCase.execute();
    expect(lastSql().sql).toContain('excluded = false');
  });

  it('🚨 排序 = 距 W% ASC NULLS LAST + 锚 id ASC tiebreaker', async () => {
    await useCase.execute();
    expect(lastSql().sql).toMatch(/ORDER BY\s+distance_to_w_pct ASC NULLS LAST,\s*id ASC/);
  });

  it('🚨 禁 OFFSET (翻页期间行情刷新会漏行/重复)', async () => {
    await useCase.execute({ cursor: encodeRadarCursor({ distanceToWPct: '-5', anchorId: '3' }) });
    expect(lastSql().sql.toUpperCase()).not.toContain('OFFSET');
  });

  it('W 系数走参数绑定且取自 anchor.rules 常量 (SC-005 零自造参数)', async () => {
    await useCase.execute();
    const { sql, values } = lastSql();
    expect(sql).toContain('COALESCE(v_manual, v)');
    expect(values.map(String)).toContain(computeW('1').toString()); // W(1) = 系数本身
  });

  it('筛选三项全在 SQL 端求值 (FR-033: 禁拉全量回来再筛)', async () => {
    await useCase.execute({
      filter: { lLevels: ['L1', 'L3'], pendingReview: true, belowW: true },
    });
    const { sql, values } = lastSql();
    expect(sql).toContain('l_level_effective IN');
    expect(sql).toContain('next_review <');
    // 061: 跌破判据的左操作数从裸 last_close 换成 spot 表达式 (与排序键同源, 见下方专测)。
    expect(sql).toContain('last_close) <');
    expect(values).toContain('L1');
    expect(values).toContain('L3');
  });

  it('L 层筛选为空数组 → 不加该条件 (L1 档为空不是校验错误, FR-008)', async () => {
    await useCase.execute({ filter: { lLevels: [] } });
    expect(lastSql().sql).not.toContain('l_level_effective IN');
  });

  it('带游标 → keyset 谓词进 SQL, 且不再重扫状态机 (续页不改判据)', async () => {
    await useCase.execute({ cursor: encodeRadarCursor({ distanceToWPct: '-5', anchorId: '3' }) });
    expect(lastSql().sql).toContain('distance_to_w_pct >');
    expect(m.findMany.mock.calls.filter((c) => c[0]?.where === undefined)).toHaveLength(0);
  });

  it('游标非法 → 400 (不静默从头翻页, 那会让用户以为看全了)', async () => {
    await expect(useCase.execute({ cursor: 'tampered' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('多取一条探测 hasMore, 返回页长仍为 limit, nextCursor 取末行键', async () => {
    m.setPageKeys([
      { anchor_id: '7', distance_text: '-10.0000' },
      { anchor_id: '8', distance_text: '-9.0000' },
    ]);
    m.findMany.mockImplementation(async (args: { where?: unknown }) =>
      args.where === undefined ? [anchorRow()] : [anchorRow()],
    );

    const page = await useCase.execute({ limit: 1 });

    expect(lastSql().values).toContain(2); // limit + 1
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(encodeRadarCursor({ distanceToWPct: '-10.0000', anchorId: '7' }));
  });

  it('末页 → hasMore=false 且 nextCursor=null', async () => {
    const page = await useCase.execute();
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('状态机变更走 conditional updateMany (带前置值, affected-count 判胜负)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: new Prisma.Decimal('36') })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    await useCase.execute();

    expect(m.updateMany).toHaveBeenCalledTimes(1);
    const call = m.updateMany.mock.calls[0]![0] as {
      where: { id: bigint; breachStartedOn: Date | null };
      data: { breachStartedOn: Date | null };
    };
    expect(call.where).toEqual({ id: 7n, breachStartedOn: null });
    expect(call.data.breachStartedOn?.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('状态机无转移 → 零 UPDATE (打开雷达不产生噪声写)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: new Prisma.Decimal('45') })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    await useCase.execute();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('excluded 锚的状态机照常维护 (维护 ≠ 展示: 它在锚列表仍要显示红标)', async () => {
    m = buildPrismaMock([anchorRow({ excluded: true })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    await useCase.execute();
    expect(m.updateMany).toHaveBeenCalledTimes(1);
  });

  it('行情不可用的行仍进结果且 zone/距 W% 为 null (EC-15 禁隐藏行 / 禁 0 值)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: null, lastCloseDate: null })]);
    m.setPageKeys([{ anchor_id: '7', distance_text: null }]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.zone).toBeNull();
    expect(page.items[0]!.distanceToWPct).toBeNull();
    expect(page.items[0]!.row.lastClose).toBeNull();
  });

  it('页内行序严格按 SQL 返回的键序 (不在内存里二次排序)', async () => {
    const rows = [anchorRow({ id: 7n }), anchorRow({ id: 8n, ticker: 'us:PEP' })];
    m = buildPrismaMock(rows);
    m.setPageKeys([
      { anchor_id: '8', distance_text: '-20' },
      { anchor_id: '7', distance_text: '-10' },
    ]);
    m.findMany.mockImplementation(async (args: { where?: unknown }) =>
      args.where === undefined ? rows : rows,
    );
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(page.items.map((i) => i.row.id)).toEqual([8n, 7n]);
  });

  // ── 045 plan D13 标的名 (行首「标的标识」的中文名那一半) ───────────────────

  it('每行带标的名, 且整页**一次** findMany 取 (逐行点查会放大成 N 次往返)', async () => {
    const rows = [anchorRow({ id: 7n }), anchorRow({ id: 8n, ticker: 'hk:00700' })];
    m = buildPrismaMock(rows);
    m.setPageKeys([
      { anchor_id: '7', distance_text: '-10' },
      { anchor_id: '8', distance_text: '-5' },
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(page.items.map((i) => i.instrumentName)).toEqual(['us-AOS 的名字', 'hk-00700 的名字']);
    expect(m.instrumentFindMany).toHaveBeenCalledTimes(1);
  });

  it('未在行情库注册的票 ⇒ instrumentName 为 null (呈现侧退回代号, 不伪造)', async () => {
    // mock 对 cn 一律不回行 = 「这票没注册」。
    m = buildPrismaMock([anchorRow({ id: 9n, ticker: 'cn:600519' })]);
    m.setPageKeys([{ anchor_id: '9', distance_text: '-10' }]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    expect((await useCase.execute()).items[0]!.instrumentName).toBeNull();
  });

  // ── 061 盘中价接入 (FR-008 / FR-009 / FR-014 / FR-015) ─────────────────────

  it('🚨 排序键走 spot 表达式: 新鲜实时价否则收盘价, cutoff **参数绑定**', async () => {
    await useCase.execute();
    const { sql, values } = lastSql();
    expect(sql).toContain('COALESCE(CASE WHEN intraday_at >=');
    expect(sql).toContain('THEN intraday_price END, last_close)');
    // cutoff 不拼进 SQL 文本 (值一律绑定, 同 keyset 谓词的纪律)。
    expect(values.some((v) => v instanceof Date)).toBe(true);
  });

  it('🚨 cutoff = now − 闸, 由 rules 常量**派生** (在此手写 90 秒时本条红)', async () => {
    const before = Date.now();
    await useCase.execute();
    const cutoff = lastSql().values.find((v): v is Date => v instanceof Date)!;
    const expected = before - INTRADAY_FRESHNESS_SECONDS * 1000;
    // 判据与 T001 同源: 闸的取值改了这里自动跟着改; 手写常数则会在闸变动时静默失配。
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
  });

  it('🚨 跌破筛选与排序键**同一个** spot 表达式 (禁一个按实时一个按收盘)', async () => {
    await useCase.execute({ filter: { belowW: true } });
    const { sql } = lastSql();
    // 两处若各写各的, 「筛出跌破的」与「距 W% 显示跌破」会在盘中互相矛盾, 且不会红。
    const occurrences = sql.split('COALESCE(CASE WHEN intraday_at >=').length - 1;
    expect(occurrences).toBe(2);
  });

  it('🚨 Guardrail 5: 不新增输出列别名 (::text 同名会让 ORDER BY 落到字典序)', async () => {
    await useCase.execute();
    const { sql } = lastSql();
    // 内层子查询的 `AS distance_to_w_pct` 是**合法且必需**的 (ORDER BY 要解析到那个 numeric 原列);
    // 被禁的是**外层**把 `::text` 转换后的列取同名 —— 那才会让排序落到字典序上。
    expect(sql).toContain('id::text AS anchor_id');
    expect(sql).toContain('distance_to_w_pct::text AS distance_text');
    expect(sql).not.toContain('::text AS distance_to_w_pct');
    expect(sql).not.toContain('::text AS id');
  });

  it('实时价新鲜 → 距 W% 由实时价算 + 档位 realtime + asOf 呈**时刻** (state_branch 11)', async () => {
    const at = secondsAgo(INTRADAY_FRESHNESS_SECONDS - 5);
    m = buildPrismaMock([anchorRow({ intradayPrice: new Prisma.Decimal('44'), intradayAt: at })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    const view = page.items[0]!;
    expect(view.spot.priceKind).toBe('realtime');
    expect(view.spot.asOf).toBe(at.toISOString()); // 时刻, 不是 YYYY-MM-DD
    // V=50 ⇒ W=40; spot 44 ⇒ (44−40)/40×100 = +10 (若仍按 lastClose 36 算则是 −10)
    expect(view.distanceToWPct?.toFixed(2)).toBe('10.00');
  });

  it('实时价陈旧 → **回落收盘价** + 档位 eod_close + asOf 呈交易日 (state_branch 12)', async () => {
    m = buildPrismaMock([
      anchorRow({
        intradayPrice: new Prisma.Decimal('44'),
        intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS + 5),
      }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const view = (await useCase.execute()).items[0]!;
    expect(view.spot.priceKind).toBe('eod_close');
    expect(view.spot.asOf).toBe('2026-07-31');
    expect(view.distanceToWPct?.toFixed(2)).toBe('-10.00'); // 陈旧实时价 MUST NOT 被用
  });

  it('两价皆无 → 距 W% 显式 null **不是 0**, 档位仍显式给出 (state_branch 13 / FR-014)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: null, lastCloseDate: null })]);
    m.setPageKeys([{ anchor_id: '7', distance_text: null }]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const view = (await useCase.execute()).items[0]!;
    expect(view.distanceToWPct).toBeNull();
    expect(view.spot.price).toBeNull();
    expect(view.spot.priceKind).toBe('eod_close');
    expect(view.spot.asOf).toBeNull();
  });

  it('🚨 Guardrail 3 回归钉: 实时价穿到 W 下方 MUST NOT 推进 breach_started_on', async () => {
    // 收盘价在 W 上方、实时价在 W 下方 —— 若有人「顺手统一」两个 spot 口径, 状态机就会在
    // 一天内随 spot 反复置位/清空, 而清空是**破坏性**的 (最近复审 < 本轮起点 的比较就此失效)。
    m = buildPrismaMock([
      anchorRow({
        lastClose: new Prisma.Decimal('45'), // > W(40) ⇒ 状态机判「未跌破」
        intradayPrice: new Prisma.Decimal('36'), // < W ⇒ 排序按它, 状态机 MUST 不看
        intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS - 5),
      }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(m.updateMany).not.toHaveBeenCalled();
    // 但排序/呈现确实用了实时价 —— 两个口径并存是刻意的, 不是漂移。
    expect(page.items[0]!.spot.priceKind).toBe('realtime');
    expect(page.items[0]!.distanceToWPct?.toFixed(2)).toBe('-10.00');
  });

  it('🚨 T019 空态计数走 spot 口径: 实时价跌破 W 而收盘价未跌破 → MUST NOT 报 all_idle', async () => {
    // 与上面那条 Guardrail 3 回归钉**同一份数据**: 状态机照旧不动 (它恒用收盘), 但顶部横幅
    // 必须跟着盘中口径走 —— `all_idle` 是压在**非空列表**头上的提示 (列表为空时先被判成
    // `filtered_empty`), 它与那条红色负距 W% 的行必然同屏。用收盘口径数 = 横幅说「一个都
    // 没有」而底下就摆着一只, 且**没有任何断言会红**。
    m = buildPrismaMock([
      anchorRow({
        lastClose: new Prisma.Decimal('45'), // > W(40) ⇒ 收盘口径数出 0 只可动
        intradayPrice: new Prisma.Decimal('36'), // < W ⇒ 盘中口径数出 1 只可动
        intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS - 5),
      }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(page.items).toHaveLength(1);
    expect(page.emptyState).toBeNull();
    expect(page.emptyStateMessage).toBeNull();
    // 射程订正的另一半: 禁令管的是**写库**, 计数改口径 MUST NOT 顺带推进状态机。
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('🚨 T019 反向: 收盘价跌破而新鲜实时价回到 W 上方 → 仍 all_idle (行照常渲染)', async () => {
    m = buildPrismaMock([
      anchorRow({
        lastClose: new Prisma.Decimal('36'), // < W ⇒ 收盘口径会数出 1 只
        intradayPrice: new Prisma.Decimal('45'), // > W ⇒ 盘中口径数出 0 只
        intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS - 5),
      }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    const page = await useCase.execute();

    expect(page.items).toHaveLength(1); // 不动区不隐藏行, 只在顶部加提示
    expect(page.emptyState).toBe('all_idle');
    expect(page.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.all_idle);
  });

  it('🚨 T019 计数查询与排序/筛选**同一个** spot 片段, 且是基础集合口径 (不叠用户筛选)', async () => {
    await useCase.execute({ filter: { lLevels: ['L1'], belowW: true } });

    const count = countSql()!;
    expect(count.sql).toContain('COUNT(*) FILTER (WHERE');
    expect(count.sql).toContain('COALESCE(CASE WHEN intraday_at >='); // 与排序键同一片段
    expect(count.sql).toContain('excluded = false');
    // 空态问的是「基础集合里有没有可动的」, 不是「筛完还剩几个」—— 叠上筛选会把
    // `filtered_empty` 与 `all_idle` 搅成一团。
    expect(count.sql).not.toContain('l_level_effective IN');
    expect(count.values.some((v) => v instanceof Date)).toBe(true); // cutoff 仍走参数绑定
  });

  it('🚨 T019 续页不发计数查询 (空态是「打开雷达」这一刻的语义)', async () => {
    await useCase.execute({ cursor: encodeRadarCursor({ distanceToWPct: '-5', anchorId: '3' }) });
    expect(countSql()).toBeUndefined();
  });

  it('空态随页一起返回 (含文案): 有可动标的 → null; 全部在 W 上方 → all_idle', async () => {
    const active = await useCase.execute(); // 默认 fixture spot < W ⇒ 可动
    expect(active.emptyState).toBeNull();
    expect(active.emptyStateMessage).toBeNull();

    m = buildPrismaMock([anchorRow({ lastClose: new Prisma.Decimal('45') })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    const idle = await useCase.execute();
    expect(idle.emptyState).toBe('all_idle');
    expect(idle.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.all_idle);
  });

  // ── 065 T04 市场作用域 (FR-002/FR-003/FR-004, SC-003, plan D1/D3/D4) ────────

  /**
   * 「作用域没进计数」的最小反例形态: 美股已跌破 (W = 50 × 0.8 = 40), 港股未跌破。
   * 计数若取全集, 港股页签会因为**那只美股**而判不出 `all_idle`。
   */
  const usBreachedHkIdle = () => [
    anchorRow({ id: 7n, ticker: 'us:AOS', lastClose: new Prisma.Decimal('36') }),
    anchorRow({ id: 8n, ticker: 'hk:00700', lastClose: new Prisma.Decimal('45') }),
  ];

  it('🚨 作用域**同时**落在分页 SQL 与计数 SQL —— D1 的不变式, 此前零覆盖', async () => {
    await useCase.execute({ market: 'hk' });

    // 分页侧: **列相等**谓词 (plan D3 否掉了 `ticker LIKE 'us:%'` 与切分隔符两种写法)。
    expect(lastSql().sql).toContain('market = ');
    // 计数侧: 同一列**分组**。作用域进计数不靠 WHERE, 靠「按同一列分组 + 按同一个值取那一格」——
    // 两处同源但不同形, 别因为 `radarScopeSql` 只有一个调用点就以为作用域没进计数。
    expect(countSql()!.sql).toContain('GROUP BY market');
    // 🚨 反向: 计数 MUST NOT 被当前作用域 WHERE 掉 —— 那样别的市场那几格永远查不出来,
    //    FR-016 的跨页签小圆点与 FR-015 的失联市场告警会同时失去数据源 (plan D4)。
    expect(countSql()!.sql).not.toContain('market = ');
  });

  it('market 走参数绑定 (values 含市场值、sql 文本不含)', async () => {
    await useCase.execute({ market: 'hk' });
    expect(lastSql().values).toContain('hk');
    expect(lastSql().sql).not.toContain("'hk'");
  });

  it('🚨 作用域进计数: 美股全部跌破 MUST NOT 压掉港股的「全体不动区」判定', async () => {
    m = buildPrismaMock(usBreachedHkIdle());
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([{ anchor_id: '8', distance_text: '12.5000' }]); // 港股那一行

    const page = await useCase.execute({ market: 'hk' });

    // 计数若取全集, actionableTotal = 1 (那只美股) ⇒ 空态被压成 null, 港股页签明明一只可动
    // 都没有却不给提示。这正是「只进分页不进计数」的病症, 别的断言都抓不到它。
    expect(page.items).toHaveLength(1); // 不动区不隐藏行, 只在顶部加提示
    expect(page.emptyState).toBe('all_idle');
  });

  it('🚨 反向: 同一批数据切到美股作用域 → 判成「有可动」(证明上一条不是恒 all_idle)', async () => {
    m = buildPrismaMock(usBreachedHkIdle());
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([{ anchor_id: '7', distance_text: '-10.0000' }]);

    expect((await useCase.execute({ market: 'us' })).emptyState).toBeNull();
  });

  it('省略 market = 不声明作用域 = 全集 (SC-003 并集性质的服务端前提)', async () => {
    m = buildPrismaMock(usBreachedHkIdle());
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([{ anchor_id: '7', distance_text: '-10.0000' }]);

    const page = await useCase.execute();

    expect(lastSql().sql).not.toContain('market = '); // 分页不加作用域谓词
    expect(page.emptyState).toBeNull(); // 计数按全部市场加总 ⇒ 那只美股仍算「可动」
  });

  it('🚨 D2 否定断言: 请求 us 作用域时港股锚的跌破状态机**仍被推进** (MUST NOT 被 scope)', async () => {
    // 🚨 此前**零覆盖**: 本文件的 fixture 恒 `us:AOS` (唯一 override 是 `us:PEP`) ⇒ 有人「为了
    //    一致性」把 market 串进 `advanceBreachState` 的扫描面, 现有测试照样全绿。
    //    一旦被 scope, 用户停在美股页签期间港股锚的状态机整段冻结, 而 `breachStartedOn` 的清空
    //    是破坏性、日粒度、**不可回补**的 (plan D2)。
    m = buildPrismaMock([
      anchorRow({ id: 8n, ticker: 'hk:00700', lastClose: new Prisma.Decimal('36') }), // < W ⇒ 该落起点
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([]); // 美股作用域下这一页本就是空的 —— 状态机照样必须跑

    await useCase.execute({ market: 'us' });

    expect(m.updateMany).toHaveBeenCalledTimes(1);
    const call = m.updateMany.mock.calls[0]![0] as { where: { id: bigint } };
    expect(call.where.id).toBe(8n); // 写的正是那只**不属于当前作用域**的港股锚
  });

  it('🚨 T06 库里有锚但本市场一只都没有 → zero_anchors_in_market (不是「整库还没有锚」)', async () => {
    m = buildPrismaMock([anchorRow({ id: 7n, ticker: 'us:AOS' })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([]);

    const page = await useCase.execute({ market: 'hk' });

    // 作用域计数取到零 (T04) + 整库计数非零 (T06 的 globalBaseTotal) ⇒ 两者的差别就是判据。
    expect(page.emptyState).toBe('zero_anchors_in_market');
    expect(page.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.zero_anchors_in_market);
  });

  it('🚨 T06 优先级: 整库真的空时仍落 zero_anchors (此时「去建锚」才是对的动作)', async () => {
    m = buildPrismaMock([]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);
    m.setPageKeys([]);

    expect((await useCase.execute({ market: 'hk' })).emptyState).toBe('zero_anchors');
  });

  // ── 065 T07 失联市场的告警级留痕 (FR-015, state_branches 10) ────────────────

  it('🚨 T07 计数含无页签可达的市场 → WARN 一次且消息含市场值与条数', async () => {
    // 🚨 fixture 里的 cn 锚模拟的是「历史遗留 / 新增了受支持市场却忘了加页签」那一类行 ——
    //    T03 的 `ck_anchor_market` 今天不让 cn 落库, 但这条判据必须在**将来**那种形态出现时
    //    仍然成立, 所以在 mock 层造出它。这是**判据的输入**, 不是往 DB 种脏数据。
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    m = buildPrismaMock([
      anchorRow({ id: 7n, ticker: 'us:AOS' }),
      anchorRow({ id: 9n, ticker: 'cn:600519' }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    await useCase.execute({ market: 'us' });

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain('cn'); // 市场值
    expect(msg).toContain('cn=1'); // 条数
    expect(msg).not.toContain('us='); // 受支持的那些不进告警正文
    warn.mockRestore();
  });

  it('🚨 T07 只含受支持市场 → **零 WARN** (雷达首页高频, 每请求一条会沦为背景噪声)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    m = buildPrismaMock([
      anchorRow({ id: 7n, ticker: 'us:AOS' }),
      anchorRow({ id: 8n, ticker: 'hk:00700' }),
    ]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    await useCase.execute({ market: 'us' });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('🚨 T07 续页不查计数 ⇒ 也不喊 (同一次滚动里不该重复告警)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    m = buildPrismaMock([anchorRow({ id: 9n, ticker: 'cn:600519' })]);
    useCase = new GetRadarUseCase(m.prisma, m.calendar);

    await useCase.execute({
      market: 'us',
      cursor: encodeRadarCursor({ distanceToWPct: '-5', anchorId: '3' }),
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
