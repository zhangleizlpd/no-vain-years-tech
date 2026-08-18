import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ImportAnchorFromModelUseCase } from './import-anchor-from-model.usecase';
import type { CreateAnchorUseCase } from './create-anchor.usecase';
import type { PrismaService } from '../security/prisma.service';
import { stubTradingCalendar } from '../../test/_support/trading-calendar-stub';

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  prisma: PrismaService;
  findUnique: Fn;
  updateMany: Fn;
  findUniqueOrThrow: Fn;
  changeCreate: Fn;
}

const ASOF = new Date('2026-06-30T00:00:00Z');
const NEXT_ASOF = new Date('2026-07-31T00:00:00Z');

/** 与 `update-anchor.usecase.spec.ts` 同形的贫血锚行（无 Domain Class）。 */
function anchorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7n,
    ticker: 'us:AOS',
    v: new Prisma.Decimal('50'),
    asof: ASOF,
    method: 'dcf',
    confidence: new Prisma.Decimal('8'),
    confidenceSource: 'model',
    excluded: false,
    excludeReason: null,
    nextReview: new Date('2026-09-30T00:00:00Z'),
    lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
    vManual: null,
    lLevelManual: null,
    positionCapManual: null,
    lLevelEffective: 'L2',
    lastClose: null,
    lastCloseDate: null,
    breachStartedOn: null,
    createdAt: new Date('2026-08-02T01:00:00Z'),
    updatedAt: new Date('2026-08-02T01:00:00Z'),
    ...overrides,
  };
}

function buildPrismaMock(): PrismaMock {
  const findUnique = vi.fn();
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUniqueOrThrow = vi.fn().mockResolvedValue(anchorRow());
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  const tx = {
    anchor: { updateMany, findUniqueOrThrow },
    anchorChange: { create: changeCreate },
  };
  const prisma = {
    // FR-020 新鲜度基准: 日历无行 ⇒ fail-open，本文件的断言与它无关。
    anchor: { findUnique, updateMany, findUniqueOrThrow },
    anchorChange: { create: changeCreate },
    $transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, findUnique, updateMany, findUniqueOrThrow, changeCreate };
}

function buildCreateAnchorStub(): { useCase: CreateAnchorUseCase; execute: Fn } {
  const execute = vi.fn(async (input: Record<string, unknown>) => ({
    ...anchorRow({ ticker: input.ticker, confidenceSource: 'model' }),
    overdueAgainstAsof: false,
    lastClosedSession: null,
  }));
  return { useCase: { execute } as unknown as CreateAnchorUseCase, execute };
}

const IMPORT = {
  ticker: 'us:AOS',
  v: '60',
  asof: NEXT_ASOF,
  method: 'dcf',
  confidence: '9.5',
};

function writtenPatch(m: PrismaMock): Record<string, unknown> {
  return m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
}

function setup(): {
  useCase: ImportAnchorFromModelUseCase;
  m: PrismaMock;
  create: Fn;
} {
  const m = buildPrismaMock();
  const stub = buildCreateAnchorStub();
  return {
    useCase: new ImportAnchorFromModelUseCase(m.prisma, stub.useCase, stubTradingCalendar()),
    m,
    create: stub.execute,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// state_branch 1 —— 无锚 → 建锚 + 模型来源身份
// ─────────────────────────────────────────────────────────────────────────────
describe('ImportAnchorFromModelUseCase — 无锚（state_branch 1）', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.m.findUnique.mockResolvedValue(null);
  });

  it('建锚且 action=create，回落清单为空', async () => {
    const result = await ctx.useCase.execute(IMPORT);
    expect(result.action).toBe('create');
    expect(result.fallbackEntries).toEqual([]);
  });

  it('🚨 confidenceSource 与 source **两个参数都显式传 model**（Guardrail 3）', () => {
    // 漏传 source 的表现是: 锚建出来了、痕迹却记成人工 —— 没有任何别的断言会红。
    return ctx.useCase.execute(IMPORT).then(() => {
      expect(ctx.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticker: 'us:AOS',
          confidenceSource: 'model',
          source: 'model',
        }),
      );
    });
  });

  it('建锚路径不碰 updateMany / 不写第二条痕迹（建锚痕迹归 CreateAnchorUseCase）', async () => {
    await ctx.useCase.execute(IMPORT);
    expect(ctx.m.updateMany).not.toHaveBeenCalled();
    expect(ctx.m.changeCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state_branch 2 / 5 / 6 / 7 —— 有锚且估值有变
// ─────────────────────────────────────────────────────────────────────────────
describe('ImportAnchorFromModelUseCase — 有锚且估值有变（state_branch 2）', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.m.findUnique.mockResolvedValue(anchorRow());
  });

  it('更新不报冲突，action=update（既有 409 是建锚口的语义，导入口不该撞它）', async () => {
    const result = await ctx.useCase.execute(IMPORT);
    expect(result.action).toBe('update');
    expect(ctx.m.updateMany).toHaveBeenCalledTimes(1);
  });

  it('写的是封闭键集那 9 列，一列不多（禁调用侧 spread 补字段）', async () => {
    await ctx.useCase.execute(IMPORT);
    expect(Object.keys(writtenPatch(ctx.m)).sort()).toEqual(
      [
        'v',
        'confidence',
        'asof',
        'method',
        'confidenceSource',
        'vManual',
        'lLevelManual',
        'positionCapManual',
        'lLevelEffective',
      ].sort(),
    );
  });

  it('🚨 state_branch 7: 不重置 next_review、不解除逾期红标（patch 里没有这些键）', async () => {
    await ctx.useCase.execute(IMPORT);
    const keys = Object.keys(writtenPatch(ctx.m));
    expect(keys).not.toContain('nextReview');
    expect(keys).not.toContain('lastReviewedOn');
    expect(keys).not.toContain('breachStartedOn');
  });

  it('痕迹 source = model（FR-008: 来源是系统对写入路径的判断，不是调方声明）', async () => {
    await ctx.useCase.execute(IMPORT);
    expect(ctx.m.changeCreate).toHaveBeenCalledTimes(1);
    const change = ctx.m.changeCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(change.source).toBe('model');
    expect(change.anchorId).toBe(7n);
  });

  it('state_branch 6: 无人工调整 → 回落清单为空，不编造条目', async () => {
    const result = await ctx.useCase.execute(IMPORT);
    expect(result.fallbackEntries).toEqual([]);
  });
});

describe('ImportAnchorFromModelUseCase — 人工位回落（state_branch 5）', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.m.findUnique.mockResolvedValue(
      anchorRow({
        vManual: new Prisma.Decimal('55'),
        lLevelManual: 'L3',
        positionCapManual: new Prisma.Decimal('0.1'),
      }),
    );
  });

  it('三处人工位一并回落，且逐条回报（禁静默回落）', async () => {
    const result = await ctx.useCase.execute(IMPORT);
    expect([...result.fallbackEntries].map((e) => e.slot).sort()).toEqual([
      'lLevel',
      'positionCap',
      'v',
    ]);
    const vEntry = result.fallbackEntries.find((e) => e.slot === 'v');
    expect(vEntry).toMatchObject({ ticker: 'us:AOS', manualValue: '55', fallbackValue: '60' });
  });

  it('回报的项与痕迹 changed_fields 对得上（同一信息的两种呈现，SC-004）', async () => {
    const result = await ctx.useCase.execute(IMPORT);
    const change = ctx.m.changeCreate.mock.calls[0]![0].data as {
      changedFields: string[];
      beforeValues: Record<string, unknown>;
    };
    for (const entry of result.fallbackEntries) {
      const column = { v: 'vManual', lLevel: 'lLevelManual', positionCap: 'positionCapManual' }[
        entry.slot
      ];
      expect(change.changedFields).toContain(column);
      expect(String(change.beforeValues[column!])).toBe(entry.manualValue);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state_branch 3 / 4 —— noop 与「第二天还能导」
// ─────────────────────────────────────────────────────────────────────────────
describe('ImportAnchorFromModelUseCase — 值全等（state_branch 3）', () => {
  let ctx: ReturnType<typeof setup>;

  const SAME = { ticker: 'us:AOS', v: '50', asof: ASOF, method: 'dcf', confidence: '8' };

  beforeEach(() => {
    ctx = setup();
  });

  it('零写入、零痕迹，action=noop', async () => {
    ctx.m.findUnique.mockResolvedValue(anchorRow());
    const result = await ctx.useCase.execute(SAME);
    expect(result.action).toBe('noop');
    expect(ctx.m.updateMany).not.toHaveBeenCalled();
    expect(ctx.m.changeCreate).not.toHaveBeenCalled();
  });

  it('🚨 noop 时人工位**不被冲**（这条短路的全部理由：L 层是唯一的人工干预手段）', async () => {
    ctx.m.findUnique.mockResolvedValue(anchorRow({ lLevelManual: 'L3' }));
    const result = await ctx.useCase.execute(SAME);
    expect(result.action).toBe('noop');
    expect(result.fallbackEntries).toEqual([]);
    expect(ctx.m.updateMany).not.toHaveBeenCalled();
  });

  it('数值等价但写法不同（"50" vs "50.00"）仍判全等 —— 比的是值不是字符串', async () => {
    ctx.m.findUnique.mockResolvedValue(anchorRow());
    const result = await ctx.useCase.execute({ ...SAME, v: '50.00', confidence: '8.0' });
    expect(result.action).toBe('noop');
  });

  it('来源仍是 manual 时**不判 noop** —— 导入这一次确实改了 provenance（FR-002）', async () => {
    ctx.m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'manual' }));
    const result = await ctx.useCase.execute(SAME);
    expect(result.action).toBe('update');
    expect(writtenPatch(ctx.m).confidenceSource).toBe('model');
  });

  it.each([
    ['v', { v: '51' }],
    ['confidence', { confidence: '9' }],
    ['asof', { asof: NEXT_ASOF }],
    ['method', { method: 'ddm' }],
  ])('四个字段任一不同即**不是** noop（%s 变了）', async (_field, diff) => {
    ctx.m.findUnique.mockResolvedValue(anchorRow());
    const result = await ctx.useCase.execute({ ...SAME, ...diff });
    expect(result.action).toBe('update');
  });
});

describe('ImportAnchorFromModelUseCase — 连续两日各导入一次（state_branch 4）', () => {
  it('🚨 第二日仍成功：模型来源锚**不被自己的只读门控 400 掉**（本片最贵的一条回归钉）', async () => {
    // 045 的 update-anchor.usecase 对 confidence_source='model' 的锚拒改 confidence。
    // 若本 use case 图省事复用它，首日全绿、**次日静默停止更新已有锚** —— 当天看不出来。
    const ctx = setup();
    ctx.m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'model' }));

    const day1 = await ctx.useCase.execute(IMPORT);
    expect(day1.action).toBe('update');

    ctx.m.findUnique.mockResolvedValue(
      anchorRow({
        confidenceSource: 'model',
        v: new Prisma.Decimal('60'),
        confidence: new Prisma.Decimal('9.5'),
        asof: NEXT_ASOF,
      }),
    );
    const day2 = await ctx.useCase.execute({
      ...IMPORT,
      v: '62',
      confidence: '9',
      asof: new Date('2026-08-31T00:00:00Z'),
    });
    expect(day2.action).toBe('update');
    expect(ctx.m.updateMany).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state_branch 8 / 9 / 10 / 11 —— 输入校验（拒绝原因可区分）
// ─────────────────────────────────────────────────────────────────────────────
describe('ImportAnchorFromModelUseCase — 输入校验', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
    ctx.m.findUnique.mockResolvedValue(null);
  });

  it.each([
    ['AOS', 'INVALID_IMPORT_TICKER'],
    ['us:pep', 'INVALID_IMPORT_TICKER'],
    ['cn:600519', 'INVALID_IMPORT_MARKET'],
  ])('state_branch 8/9: 标的写法 %j → 400 且原因可区分', async (ticker, code) => {
    await expect(ctx.useCase.execute({ ...IMPORT, ticker })).rejects.toThrow(code);
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('state_branch 10: 置信度越界 → 400（不穿透到 PG 变 numeric overflow）', async () => {
    await expect(ctx.useCase.execute({ ...IMPORT, confidence: '999' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it.each(['0', '-1'])('state_branch 11: 估值 %s → 400 且不落库', async (v) => {
    await expect(ctx.useCase.execute({ ...IMPORT, v })).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state_branch 18 —— 并发删除
// ─────────────────────────────────────────────────────────────────────────────
describe('ImportAnchorFromModelUseCase — 并发删除（state_branch 18）', () => {
  it('读写窗内被删 → affected-count 0 ⇒ 404，且**不写孤儿痕迹**', async () => {
    const ctx = setup();
    ctx.m.findUnique.mockResolvedValue(anchorRow());
    ctx.m.updateMany.mockResolvedValue({ count: 0 });

    await expect(ctx.useCase.execute(IMPORT)).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.m.changeCreate).not.toHaveBeenCalled();
  });
});
