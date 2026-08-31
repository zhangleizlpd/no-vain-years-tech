import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../security/prisma.service';
import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import { ApproveAnchorSubmissionUseCase } from './approve-anchor-submission.usecase';
import type {
  ImportAnchorFromModelInput,
  ImportAnchorFromModelUseCase,
} from './import-anchor-from-model.usecase';

/**
 * 断言派生自 spec **FR-003 / FR-004 / FR-005 / FR-006** 与 state_branches 1–8, 12, 13。
 *
 * 🚨 最要紧的两条：
 *  ① **零 `prisma.anchor` 调用** —— FR-003「MUST NOT 存在第二条写锚路径」在本层的判据；
 *  ② **导入在前、翻状态在后** —— 断言的是**顺序**，不是「两个都被调过」。
 *     写成「都调过」的断言在顺序颠倒时**照样绿**，等于没测。
 */
const SUBMISSION = {
  id: 5n,
  submitter: 'friend2',
  ticker: 'us:CFG',
  v: new Prisma.Decimal('49.34'),
  asof: new Date('2026-08-30T00:00:00Z'),
  method: 'weighted',
  confidence: new Prisma.Decimal('6.00'),
  note: null,
  reviewNote: null,
  status: 'PENDING',
  consumedAnchorId: null,
};

function makeDeps(
  opts: {
    row?: Record<string, unknown> | null;
    classify?: 'trading' | 'non-trading' | 'unknown';
    prevTradingDay?: string | null;
    flipCount?: number;
    action?: 'create' | 'update' | 'noop';
  } = {},
) {
  const calls: string[] = [];
  const anchor = {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  };
  const findUnique = vi.fn(async () => (opts.row === undefined ? SUBMISSION : opts.row));
  const updateMany = vi.fn(async () => {
    calls.push('flip');
    return { count: opts.flipCount ?? 1 };
  });
  const prisma = {
    anchorSubmission: { findUnique, updateMany },
    anchor,
  } as unknown as PrismaService;

  const importExecute = vi.fn(async (_input: ImportAnchorFromModelInput) => {
    calls.push('import');
    return {
      action: opts.action ?? 'create',
      anchor: { id: 42n, ticker: 'us:CFG' },
      fallbackEntries: [],
    };
  });
  const importAnchor = { execute: importExecute } as unknown as ImportAnchorFromModelUseCase;

  const calendar = {
    classify: vi.fn(async () => opts.classify ?? 'trading'),
    lastClosedSession: vi.fn(async () => null),
    // 🚨 用 `in` 而不是 `??`:显式传 null(「日历解不出」)与不传是两件事,
    //    `null ?? '2026-08-28'` 会把前者悄悄变成后者,于是那条用例根本没被测到。
    previousTradingDay: vi.fn(async () =>
      'prevTradingDay' in opts ? opts.prevTradingDay : '2026-08-28',
    ),
  } as unknown as TradingCalendarPort;

  const uc = new ApproveAnchorSubmissionUseCase(prisma, importAnchor, calendar);
  // 交易所「今天」固定在 08-31，使 08-30 是过去、09-05 是未来。
  const now = new Date('2026-08-31T20:00:00Z');
  return { uc, now, calls, importExecute, updateMany, anchor, calendar };
}

describe('ApproveAnchorSubmissionUseCase — FR-003 单写路径', () => {
  it('🚨 全程零 `prisma.anchor` 调用（写锚只经 ImportAnchorFromModelUseCase）', async () => {
    const d = makeDeps();
    await d.uc.execute({ id: 5n }, d.now);
    for (const [name, fn] of Object.entries(d.anchor)) {
      expect(fn, `prisma.anchor.${name} 被调用了`).not.toHaveBeenCalled();
    }
    expect(d.importExecute).toHaveBeenCalledTimes(1);
  });

  it('ticker 原样交给导入口，MUST NOT 可被入参改写（FR-006）', async () => {
    const d = makeDeps();
    await d.uc.execute({ id: 5n, method: 'dcf' } as never, d.now);
    expect(d.importExecute.mock.calls[0]![0]).toMatchObject({ ticker: 'us:CFG', method: 'dcf' });
  });
});

describe('ApproveAnchorSubmissionUseCase — FR-004 顺序与半截态', () => {
  it('🚨 先导入、后翻状态（断言顺序本身）', async () => {
    const d = makeDeps();
    await d.uc.execute({ id: 5n }, d.now);
    expect(d.calls).toEqual(['import', 'flip']);
  });

  it('导入抛错 → 状态**绝不**翻转（否则条目从待审箱里弄丢）', async () => {
    const d = makeDeps();
    d.importExecute.mockRejectedValueOnce(new Error('vendor down'));
    await expect(d.uc.execute({ id: 5n }, d.now)).rejects.toThrow('vendor down');
    expect(d.updateMany).not.toHaveBeenCalled();
  });

  it('翻转 0 行（并发抢跑）→ 不抛错，statusFlipped=false（锚已写，回 5xx 会致重试写第二遍）', async () => {
    const d = makeDeps({ flipCount: 0 });
    const res = await d.uc.execute({ id: 5n }, d.now);
    expect(res.statusFlipped).toBe(false);
    expect(res.flipFailure).toBe('CONCURRENT_DISPOSITION');
    expect(res.anchorId).toBe('42');
  });

  it('action=create → coldStartExpected=true；noop → false', async () => {
    expect((await makeDeps().uc.execute({ id: 5n }, makeDeps().now)).coldStartExpected).toBe(true);
    const d = makeDeps({ action: 'noop' });
    expect((await d.uc.execute({ id: 5n }, d.now)).coldStartExpected).toBe(false);
  });
});

describe('ApproveAnchorSubmissionUseCase — 前置状态', () => {
  it('条目不存在 → 404', async () => {
    const d = makeDeps({ row: null });
    await expect(d.uc.execute({ id: 5n }, d.now)).rejects.toBeInstanceOf(NotFoundException);
  });

  // 「已处置过」与「不存在」是两件事，客户端要能分开呈现。
  it('已非 PENDING → 409（不是 404），且零导入', async () => {
    const d = makeDeps({ row: { ...SUBMISSION, status: 'CONSUMED' } });
    await expect(d.uc.execute({ id: 5n }, d.now)).rejects.toBeInstanceOf(ConflictException);
    expect(d.importExecute).not.toHaveBeenCalled();
  });
});

describe('ApproveAnchorSubmissionUseCase — FR-005 asof fail-closed 闸', () => {
  it('非交易日且未带 ack → 409，且**一次导入都不发**', async () => {
    const d = makeDeps({ classify: 'non-trading' });
    await expect(d.uc.execute({ id: 5n }, d.now)).rejects.toBeInstanceOf(ConflictException);
    expect(d.importExecute).not.toHaveBeenCalled();
  });

  it('日历不可判定(unknown)同样进闸 —— MUST NOT 当作没问题放行', async () => {
    const d = makeDeps({ classify: 'unknown' });
    await expect(d.uc.execute({ id: 5n }, d.now)).rejects.toBeInstanceOf(ConflictException);
    expect(d.importExecute).not.toHaveBeenCalled();
  });

  it('ack=shift 且日历解得出 → 用建议日落库', async () => {
    const d = makeDeps({ classify: 'non-trading', prevTradingDay: '2026-08-28' });
    const res = await d.uc.execute({ id: 5n, asofAck: 'shift' }, d.now);
    expect(res.appliedAsof).toBe('2026-08-28');
    expect(d.importExecute.mock.calls[0]![0].asof).toEqual(new Date('2026-08-28T00:00:00Z'));
  });

  it('ack=shift 但日历解不出 → 409，**不猜**，且零导入', async () => {
    const d = makeDeps({ classify: 'non-trading', prevTradingDay: null });
    await expect(d.uc.execute({ id: 5n, asofAck: 'shift' }, d.now)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(d.importExecute).not.toHaveBeenCalled();
  });

  it('ack=accept → 原样发', async () => {
    const d = makeDeps({ classify: 'non-trading' });
    const res = await d.uc.execute({ id: 5n, asofAck: 'accept' }, d.now);
    expect(res.appliedAsof).toBe('2026-08-30');
  });

  // 🚨 闸判**最终 asof**：把坏日期改好就不该再要 ack。反过来编辑框会成为闸的绕过口。
  it('审核方把坏口径日改成好日期 → 无需 ack 直接放行', async () => {
    const d = makeDeps({ classify: 'trading' });
    const res = await d.uc.execute({ id: 5n, asof: '2026-08-28' }, d.now);
    expect(res.appliedAsof).toBe('2026-08-28');
    expect(d.calendar.classify).toHaveBeenCalledWith('us', '2026-08-28');
  });
});
