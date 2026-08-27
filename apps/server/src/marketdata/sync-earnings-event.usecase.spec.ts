import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
  EarningsCalendarBudgetExhaustedError,
  EarningsCalendarRejectedError,
  type EarningsCalendarEvent,
  type EarningsCalendarPort,
  type EarningsCalendarWindowQuery,
} from './earnings-calendar.port.js';
import { emptyStats } from './sync-run.recorder.js';
import {
  EARNINGS_FORWARD_HORIZON_DAYS,
  planEarningsWindows,
  SyncEarningsEventUseCase,
} from './sync-earnings-event.usecase.js';

/**
 * 财报日历维度 use case 单测 (047 T019, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的都是「盲写会踩、且踩了不会红」的坑:
 * ① **零锚照常发请求并落库** (FR-035a 的反向守卫) —— 挂锚闸会让零锚时静默不采, 且不会红。
 *    这条是 Guardrail 2 的机器绊线, 本仓第三次撞同一形状。
 * ② **锚从 12 增到 100, 调用数不变** (SC-006a) —— 市场级接口的可验证判据。
 * ③ 改期**原地改**并记 PIT 三件套 —— 插新行会让旧日期继续声称那天有财报。
 * ④ 库外标的跳过并计数 —— 计数持续升高 = universe 枚举漏了一类标的。
 * ⑤ 同日重跑零写 —— `date_changed_at` 一被无谓刷新, 复核名单就再也不可信。
 */

/** 北京 06:00 = us 维度 cron 时刻; 入参就是它对应的 **us 业务日**。 */
const beijing6am = (usDate: string) => new Date(`${usDate}T22:00:00Z`);

/** `YYYY-MM-DD` 加 n 天 (UTC)。 */
function addUtcDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 真 vendor 实测的窗宽上限 (**端点差**, 2026-08-07 经 77 → wg1 打真 shim):
 * 端点差 5 / 6 → 200; **7 → 502 `NN_ProtoRet_SvrFailed`**; 8 → shim 自己的 400。
 * 差 7 在 08-07 / 09-02 / 10-19 三个相隔一个多月的 start 上 **3/3 复现**, 不是抖动。
 * ⇒ vendor 原文「与 beginDate 间隔不超过 7 天」说的是**含首尾的 7 天窗**, 即端点差 ≤ 6。
 *
 * 🚫 蓄意**不引用** `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS`: 这是**外部事实**, 那个常量是被它
 * 校准的一方 —— 常量曾写作 7, 于是窗序列切出的**每一个**窗都恰好差 7 ⇒ 生产财报采集窗窗 502,
 * 而 502 映射成瞬时错误会一路重试 / 顺延, **永远不以「参数错」的形状说出来**。同一实测的真端
 * 回归锚在 `test/integration/marketdata.futu-shim.vendor.spec.ts` (env-gated, 默认 skip)。
 */
const OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF = 6;

/** 窗数**由常量派生**而不写死 —— 窗宽哪天再被真 vendor 校准, 这里跟着走, 不用逐条改数字。 */
const EXPECTED_WINDOW_COUNT = Math.ceil(
  EARNINGS_FORWARD_HORIZON_DAYS / EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
);

const DIM = {
  dimensionKey: 'earnings_event',
  marketScope: ['us'],
} as unknown as ExecutorSyncDimensionRow;

function makeInput(usDate = '2026-08-04'): ExecutorInput {
  return { mode: 'delta', asOf: usDate, now: beijing6am(usDate) };
}

function event(
  symbol: string,
  earningsDate: string,
  extra: Partial<EarningsCalendarEvent> = {},
): EarningsCalendarEvent {
  return {
    underlyingSymbol: symbol,
    earningsDate,
    pubType: 'BEFORE',
    periodText: 'Q3 2026',
    epsActual: null,
    epsPredict: '2.31',
    ...extra,
  };
}

/** 库内既有行 (findMany 投影形态)。 */
function existingRow(
  id: bigint,
  instrumentId: bigint,
  earningsDate: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    instrumentId,
    earningsDate: new Date(`${earningsDate}T00:00:00Z`),
    pubType: 'BEFORE',
    periodText: 'Q3 2026',
    epsActual: null,
    epsPredict: new Prisma.Decimal('2.310000'),
    ...extra,
  };
}

interface Harness {
  useCase: SyncEarningsEventUseCase;
  windowCalls: EarningsCalendarWindowQuery[];
  createMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

/**
 * @param eventsFor  每窗返回的事件 (默认: 窗起当天 PEP 一条)
 * @param instruments 库内 `Instrument` 行 (`market:code`)
 * @param existing   库内 `earnings_event` 既有行
 */
function makeHarness(opts: {
  eventsFor?: (q: EarningsCalendarWindowQuery) => EarningsCalendarEvent[];
  instruments?: string[];
  existing?: ReturnType<typeof existingRow>[];
}): Harness {
  const windowCalls: EarningsCalendarWindowQuery[] = [];
  const calendar: EarningsCalendarPort = {
    getWindow: vi.fn(async (q: EarningsCalendarWindowQuery) => {
      windowCalls.push(q);
      return opts.eventsFor ? opts.eventsFor(q) : [];
    }),
  };

  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const update = vi.fn(async () => ({}));
  const prisma = {
    instrument: {
      findMany: vi.fn(async () =>
        (opts.instruments ?? []).map((s, i) => ({
          id: BigInt(i + 1),
          market: s.split(':')[0],
          code: s.split(':')[1],
        })),
      ),
    },
    earningsEvent: {
      findMany: vi.fn(async () => opts.existing ?? []),
      createMany,
      update,
    },
  } as unknown as PrismaService;

  return {
    useCase: new SyncEarningsEventUseCase(calendar, prisma),
    windowCalls,
    createMany,
    update,
  };
}

/** 本轮 createMany 落下的全部行 (跨 chunk 摊平)。 */
function insertedRows(createMany: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return createMany.mock.calls.flatMap(
    (call) => (call[0] as { data: Record<string, unknown>[] }).data,
  );
}

describe('SyncEarningsEventUseCase', () => {
  describe('工作集 = 固定前向时间窗序列, 不挂锚闸 (FR-035a / SC-006a, Guardrail 2)', () => {
    it(`🚨 零锚 → 照常发满 ${EXPECTED_WINDOW_COUNT} 个窗的请求并落库 (挂锚闸会让这里静默变成 0)`, async () => {
      // 锚表在本 use case 里**根本没有查询入口** —— 结构上就不可能被锚数量影响。
      const { useCase, windowCalls, createMany } = makeHarness({
        instruments: ['us:PEP'],
        eventsFor: (q) => [event('us:PEP', q.start)],
      });
      const stats = emptyStats();

      await useCase.run(DIM, stats, makeInput());

      expect(windowCalls).toHaveLength(EXPECTED_WINDOW_COUNT);
      expect(insertedRows(createMany).length).toBeGreaterThan(0);
      expect(stats.ok).toBeGreaterThan(0);
    });

    it('🚨 锚从 12 增到 100 → 调用数不变 (市场级接口的可验证判据, SC-006a)', async () => {
      // 「锚」在这里只能通过 Instrument 表体现 —— 换成 100 只票, 窗序列一模一样。
      const twelve = makeHarness({ instruments: Array.from({ length: 12 }, (_, i) => `us:A${i}`) });
      const hundred = makeHarness({
        instruments: Array.from({ length: 100 }, (_, i) => `us:A${i}`),
      });

      await twelve.useCase.run(DIM, emptyStats(), makeInput());
      await hundred.useCase.run(DIM, emptyStats(), makeInput());

      expect(hundred.windowCalls).toHaveLength(twelve.windowCalls.length);
      expect(hundred.windowCalls).toEqual(twelve.windowCalls);
    });

    it(`窗序列首尾相接覆盖整段前向视野, 端点差恒 ≤${OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF} 天 (vendor 实测硬约束)`, async () => {
      const windows = planEarningsWindows('2026-08-04');

      expect(windows[0].start).toBe('2026-08-04');
      expect(windows).toHaveLength(EXPECTED_WINDOW_COUNT);
      // 末窗**恰好收在视野末端**: 视野未必被窗宽整除, 越过去的那几天落在 `loadExistingRows`
      // 的取数区间之外 ⇒ 它们的行每天都会被当成「第一次见」重新 diff, PIT 三件套失真。
      expect(windows[windows.length - 1].end).toBe(
        addUtcDays('2026-08-04', EARNINGS_FORWARD_HORIZON_DAYS),
      );
      for (const [i, w] of windows.entries()) {
        const span =
          (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 864e5;
        // 🚨 上限取**实测值**而不是那个常量: 常量写宽一天 ⇒ 窗窗 502, 且 502 会伪装成瞬时错误
        // 一路重试 / 顺延 (2026-08-07 打真 shim 三个 start 3/3 复现, 见文件头实测注释)。
        expect(span).toBeGreaterThan(0);
        expect(span).toBeLessThanOrEqual(OBSERVED_EARNINGS_MAX_ENDPOINT_DIFF);
        // 相邻窗共享端点日: 重叠一天是幂等 no-op, 缺一天则是那天全市场的财报无人再问。
        if (i > 0) expect(w.start).toBe(windows[i - 1].end);
      }
    });

    it('业务日期按 us 时区求值 —— 用上海日会错位一天且每周固定丢周五 (FR-036)', async () => {
      const { useCase, windowCalls } = makeHarness({});
      // 北京时间周六 06:00 = us 的周五 —— 若吃 input.asOf / 上海日, 首窗会从周六起算。
      await useCase.run(DIM, emptyStats(), {
        mode: 'delta',
        asOf: '2026-08-08',
        now: beijing6am('2026-08-07'),
      });

      expect(windowCalls[0].start).toBe('2026-08-07');
    });
  });

  describe('全市场落库 + 库外标的跳过并计数 (FR-035b / plan D-DATA-8)', () => {
    it('非白名单标的照常落库 —— 拉回什么存什么', async () => {
      const { useCase, createMany } = makeHarness({
        instruments: ['us:PEP', 'us:NOBODYCARES'],
        eventsFor: (q) =>
          q.start === '2026-08-04'
            ? [event('us:PEP', q.start), event('us:NOBODYCARES', q.start)]
            : [],
      });

      await useCase.run(DIM, emptyStats(), makeInput());

      expect(insertedRows(createMany)).toHaveLength(2);
    });

    it('🚨 Instrument 表外的标的 → 跳过、计数、上抛监控信号 (MUST NOT 改幂等键绕 FK)', async () => {
      const { useCase, createMany } = makeHarness({
        instruments: ['us:PEP'],
        eventsFor: (q) =>
          q.start === '2026-08-04'
            ? [event('us:PEP', q.start), event('us:GHOST', q.start), event('us:GHOST2', q.start)]
            : [],
      });
      const stats = emptyStats();

      await useCase.run(DIM, stats, makeInput());

      expect(insertedRows(createMany)).toHaveLength(1);
      expect([stats.scanned, stats.ok, stats.skipped]).toEqual([3, 1, 2]);
      // 计数持续升高 = universe 枚举漏了一类标的 ⇒ 必须是可查询的信号, 不是一句 log 了事。
      expect(stats.findings).toContainEqual(
        expect.objectContaining({
          kind: 'notice',
          step: 'earnings_instrument_unmatched',
          detail: expect.objectContaining({ unmatched: 2 }),
        }),
      );
    });
  });

  describe('PIT diff (FR-027)', () => {
    it('🚨 财报日变更 → 原地改 + 记变更前日期与变更时刻, first_seen_at 不动', async () => {
      const { useCase, update, createMany } = makeHarness({
        instruments: ['us:PEP'],
        existing: [existingRow(77n, 1n, '2026-08-06')],
        eventsFor: (q) => (q.start === '2026-08-04' ? [event('us:PEP', '2026-08-13')] : []),
      });
      const stats = emptyStats();
      const input = makeInput();

      await useCase.run(DIM, stats, input);

      // 插新行会让 2026-08-06 那条留在库里继续声称那天有财报 —— 下游会照着一个不存在的
      // 日期打标, 而两条路径都不会红。
      expect(insertedRows(createMany)).toHaveLength(0);
      expect(update).toHaveBeenCalledTimes(1);
      const args = update.mock.calls[0][0] as {
        where: { id: bigint };
        data: Record<string, unknown>;
      };
      expect(args.where.id).toBe(77n);
      expect(args.data.earningsDate).toEqual(new Date('2026-08-13T00:00:00Z'));
      expect(args.data.prevEarningsDate).toEqual(new Date('2026-08-06T00:00:00Z'));
      expect(args.data.dateChangedAt).toEqual(input.now);
      expect(args.data.firstSeenAt).toBeUndefined();
      // 进 WARN 复核名单 + SyncRun 审计明细。
      expect(stats.findings).toContainEqual(
        expect.objectContaining({
          kind: 'notice',
          step: 'earnings_date_changed',
          detail: expect.objectContaining({ changed: 1 }),
        }),
      );
    });

    it('vendor 未给 period_text 时, 双方各剩一条 → 仍认作改期 (无歧义配对)', async () => {
      const { useCase, update } = makeHarness({
        instruments: ['us:PEP'],
        existing: [existingRow(88n, 1n, '2026-08-06', { periodText: null })],
        eventsFor: (q) =>
          q.start === '2026-08-04' ? [event('us:PEP', '2026-08-13', { periodText: null })] : [],
      });

      await useCase.run(DIM, emptyStats(), makeInput());

      const args = update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(args.data.prevEarningsDate).toEqual(new Date('2026-08-06T00:00:00Z'));
    });

    it('剩多条 (歧义) → 一律当新事件 insert, 不乱配对写出假改期史', async () => {
      const { useCase, update, createMany } = makeHarness({
        instruments: ['us:PEP'],
        existing: [
          existingRow(1n, 1n, '2026-08-06', { periodText: null }),
          existingRow(2n, 1n, '2026-09-06', { periodText: null }),
        ],
        eventsFor: (q) =>
          q.start === '2026-08-04'
            ? [
                event('us:PEP', '2026-08-13', { periodText: null }),
                event('us:PEP', '2026-09-13', { periodText: null }),
              ]
            : [],
      });

      await useCase.run(DIM, emptyStats(), makeInput());

      expect(update).not.toHaveBeenCalled();
      expect(insertedRows(createMany)).toHaveLength(2);
    });

    it('日期没变、eps 由预估变实际 → 只更新可变字段, 不碰 PIT 三件套', async () => {
      const { useCase, update } = makeHarness({
        instruments: ['us:PEP'],
        existing: [existingRow(5n, 1n, '2026-08-06')],
        eventsFor: (q) =>
          q.start === '2026-08-04'
            ? [event('us:PEP', '2026-08-06', { epsActual: '2.35', epsPredict: '2.31' })]
            : [],
      });
      const stats = emptyStats();

      await useCase.run(DIM, stats, makeInput());

      const args = update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(args.data.epsActual).toBe('2.35');
      expect(args.data.dateChangedAt).toBeUndefined();
      expect(args.data.prevEarningsDate).toBeUndefined();
      expect(stats.findings).toHaveLength(0);
    });

    it('🚨 同日重跑幂等: 逐字段相等 → 零 insert 零 update (Decimal 标度差不算变更)', async () => {
      // 库里是 numeric(18,6) 的 '2.310000', 端口给的是 '2.31' —— 按字面比会把每一行都判成
      // 变了, 于是每晚全表 UPDATE 一遍, 把真正的变更淹掉。
      const { useCase, update, createMany } = makeHarness({
        instruments: ['us:PEP'],
        existing: [existingRow(9n, 1n, '2026-08-06')],
        eventsFor: (q) => (q.start === '2026-08-04' ? [event('us:PEP', '2026-08-06')] : []),
      });

      await useCase.run(DIM, emptyStats(), makeInput());

      expect(update).not.toHaveBeenCalled();
      expect(insertedRows(createMany)).toHaveLength(0);
    });

    it('相邻窗共享的端点日事件被去重, 不产生重复行', async () => {
      const { useCase, createMany } = makeHarness({
        instruments: ['us:PEP'],
        // 2026-08-11 同时是窗 0 的 end 与窗 1 的 start。
        eventsFor: () => [event('us:PEP', '2026-08-11')],
      });

      await useCase.run(DIM, emptyStats(), makeInput());

      expect(insertedRows(createMany)).toHaveLength(1);
    });
  });

  describe('失败语义', () => {
    it('429 → 返 budgetExhausted 且已取到的窗照常落库 (deferral ≠ failure)', async () => {
      let calls = 0;
      const { useCase, createMany } = makeHarness({
        instruments: ['us:PEP'],
        eventsFor: (q) => {
          if (++calls > 2) throw new EarningsCalendarBudgetExhaustedError(`${q.start}..${q.end}`);
          return [event('us:PEP', q.start)];
        },
      });
      const stats = emptyStats();

      expect(await useCase.run(DIM, stats, makeInput())).toBe(true);
      expect(insertedRows(createMany)).toHaveLength(2);
      // 顺延不是失败 —— 计 failed 会白白吃掉重试次数。
      expect(stats.failed).toBe(0);
    });

    it('单窗永久拒绝 → 窗级隔离: 计 failed 后其余窗照常跑', async () => {
      const { useCase, windowCalls, createMany } = makeHarness({
        instruments: ['us:PEP'],
        eventsFor: (q) => {
          if (q.start === '2026-08-04') throw new EarningsCalendarRejectedError('窗越界');
          return [event('us:PEP', q.start)];
        },
      });
      const stats = emptyStats();

      await useCase.run(DIM, stats, makeInput());

      expect(windowCalls).toHaveLength(EXPECTED_WINDOW_COUNT);
      expect(stats.failed).toBe(1);
      expect(insertedRows(createMany).length).toBeGreaterThan(0);
    });

    it('整段视野无财报 (淡季) → 不报错、零落库', async () => {
      const { useCase, createMany } = makeHarness({ instruments: ['us:PEP'] });
      const stats = emptyStats();

      expect(await useCase.run(DIM, stats, makeInput())).toBe(false);
      expect(createMany).not.toHaveBeenCalled();
      expect(stats.scanned).toBe(0);
    });
  });
});
