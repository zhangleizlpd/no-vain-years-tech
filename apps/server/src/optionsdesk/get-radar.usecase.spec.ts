import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { classifyZone, computeW } from './anchor.rules';
import { isAnchorReviewFlagOn } from './review-anchor.usecase';
import {
  GetRadarUseCase,
  RADAR_EMPTY_STATE_MESSAGES,
  resolveBreachTransition,
  resolveRadarEmptyState,
} from './get-radar.usecase';
import { encodeRadarCursor } from './radar-cursor';
import { INTRADAY_FRESHNESS_SECONDS } from './intraday-spot.rules';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

/** V = 50 ⇒ W = 40 (由 rules 派生, 本文件不写任何档位字面量, SC-005)。 */
const V = new Prisma.Decimal('50');
const W = computeW(V);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const anchorRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  ticker: 'us:AOS',
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

describe('resolveRadarEmptyState — 三空态 (FR-015 + FR-034)', () => {
  const base = { baseTotal: 5, pageItems: 3, actionableTotal: 1, firstPage: true };

  it('锚库为空 → zero_anchors (引导建锚)', () => {
    expect(resolveRadarEmptyState({ ...base, baseTotal: 0, pageItems: 0 })).toBe('zero_anchors');
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

  it('🚨 三态文案两两不同, MUST NOT 复用 (FR-034 明令与 FR-015 区分)', () => {
    const texts = Object.values(RADAR_EMPTY_STATE_MESSAGES);
    expect(new Set(texts).size).toBe(texts.length);
    expect(RADAR_EMPTY_STATE_MESSAGES.all_idle).toContain('今日无解');
    expect(RADAR_EMPTY_STATE_MESSAGES.filtered_empty).toContain('筛选');
    expect(RADAR_EMPTY_STATE_MESSAGES.zero_anchors).not.toContain('筛选');
  });
});

interface PrismaMock {
  prisma: PrismaService;
  tradingDayFindFirst: Fn;
  queryRaw: Fn;
  findMany: Fn;
  updateMany: Fn;
}

function buildPrismaMock(rows = [anchorRow()]): PrismaMock {
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      rows.map((r) => ({ anchor_id: r.id.toString(), distance_text: '-10.0000' })),
    );
  const findMany = vi.fn(async (args: { where?: unknown }) =>
    args.where === undefined ? rows : rows.filter((r) => r.excluded === false),
  );
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const tradingDayFindFirst = vi.fn(async () => null as { date: Date } | null);
  const prisma = {
    tradingDay: { findFirst: tradingDayFindFirst },
    anchor: { findMany, updateMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  return { prisma, queryRaw, findMany, updateMany, tradingDayFindFirst };
}

describe('GetRadarUseCase — SQL 端排序/筛选 + keyset 分页 (FR-010/033/034)', () => {
  let m: PrismaMock;
  let useCase: GetRadarUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new GetRadarUseCase(m.prisma);
  });

  const lastSql = (): { sql: string; values: unknown[] } => {
    const arg = m.queryRaw.mock.calls.at(-1)![0] as { sql: string; values: unknown[] };
    return arg;
  };

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
    m.queryRaw.mockResolvedValue([
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
    useCase = new GetRadarUseCase(m.prisma);

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
    useCase = new GetRadarUseCase(m.prisma);
    await useCase.execute();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('excluded 锚的状态机照常维护 (维护 ≠ 展示: 它在锚列表仍要显示红标)', async () => {
    m = buildPrismaMock([anchorRow({ excluded: true })]);
    useCase = new GetRadarUseCase(m.prisma);
    await useCase.execute();
    expect(m.updateMany).toHaveBeenCalledTimes(1);
  });

  it('行情不可用的行仍进结果且 zone/距 W% 为 null (EC-15 禁隐藏行 / 禁 0 值)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: null, lastCloseDate: null })]);
    m.queryRaw.mockResolvedValue([{ anchor_id: '7', distance_text: null }]);
    useCase = new GetRadarUseCase(m.prisma);

    const page = await useCase.execute();

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.zone).toBeNull();
    expect(page.items[0]!.distanceToWPct).toBeNull();
    expect(page.items[0]!.row.lastClose).toBeNull();
  });

  it('页内行序严格按 SQL 返回的键序 (不在内存里二次排序)', async () => {
    const rows = [anchorRow({ id: 7n }), anchorRow({ id: 8n, ticker: 'us:PEP' })];
    m = buildPrismaMock(rows);
    m.queryRaw.mockResolvedValue([
      { anchor_id: '8', distance_text: '-20' },
      { anchor_id: '7', distance_text: '-10' },
    ]);
    m.findMany.mockImplementation(async (args: { where?: unknown }) =>
      args.where === undefined ? rows : rows,
    );
    useCase = new GetRadarUseCase(m.prisma);

    const page = await useCase.execute();

    expect(page.items.map((i) => i.row.id)).toEqual([8n, 7n]);
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
    useCase = new GetRadarUseCase(m.prisma);

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
    useCase = new GetRadarUseCase(m.prisma);

    const view = (await useCase.execute()).items[0]!;
    expect(view.spot.priceKind).toBe('eod_close');
    expect(view.spot.asOf).toBe('2026-07-31');
    expect(view.distanceToWPct?.toFixed(2)).toBe('-10.00'); // 陈旧实时价 MUST NOT 被用
  });

  it('两价皆无 → 距 W% 显式 null **不是 0**, 档位仍显式给出 (state_branch 13 / FR-014)', async () => {
    m = buildPrismaMock([anchorRow({ lastClose: null, lastCloseDate: null })]);
    m.queryRaw.mockResolvedValue([{ anchor_id: '7', distance_text: null }]);
    useCase = new GetRadarUseCase(m.prisma);

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
    useCase = new GetRadarUseCase(m.prisma);

    const page = await useCase.execute();

    expect(m.updateMany).not.toHaveBeenCalled();
    // 但排序/呈现确实用了实时价 —— 两个口径并存是刻意的, 不是漂移。
    expect(page.items[0]!.spot.priceKind).toBe('realtime');
    expect(page.items[0]!.distanceToWPct?.toFixed(2)).toBe('-10.00');
  });

  it('空态随页一起返回 (含文案): 有可动标的 → null; 全部在 W 上方 → all_idle', async () => {
    const active = await useCase.execute(); // 默认 fixture spot < W ⇒ 可动
    expect(active.emptyState).toBeNull();
    expect(active.emptyStateMessage).toBeNull();

    m = buildPrismaMock([anchorRow({ lastClose: new Prisma.Decimal('45') })]);
    useCase = new GetRadarUseCase(m.prisma);
    const idle = await useCase.execute();
    expect(idle.emptyState).toBe('all_idle');
    expect(idle.emptyStateMessage).toBe(RADAR_EMPTY_STATE_MESSAGES.all_idle);
  });
});
