import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CreateAnchorUseCase, shanghaiDateOnly, toUtcDateOnly } from './create-anchor.usecase';
import type { PrismaService } from '../security/prisma.service';
import type { OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import type { EnsureLatestEodBarUseCase } from '../marketdata/ensure-latest-eod-bar.usecase';
import {
  stubTradingCalendar,
  type TradingCalendarStub,
} from '../../test/_support/trading-calendar-stub';

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  prisma: PrismaService;
  /** 062 T010: 陈旧度基准改走 `TRADING_CALENDAR_PORT`，不再是 `tradingDay.findFirst`。 */
  calendar: TradingCalendarStub;
  findUnique: Fn;
  create: Fn;
  updateMany: Fn;
  changeCreate: Fn;
  /** `$transaction` 交给回调的那个 client —— 060 T009 断言 publish 收到的是**它**。 */
  tx: unknown;
  outbox: OutboxPublisher;
  publish: Fn;
  /** 建锚同步取价: 默认返 `null` (= vendor 无数据) ⇒ 既有用例行为逐条不变。 */
  ensureBar: EnsureLatestEodBarUseCase;
  ensureBarExecute: Fn;
  anchorUpdate: Fn;
}

function buildPrismaMock(): PrismaMock {
  const findUnique = vi.fn();
  const create = vi.fn();
  const updateMany = vi.fn();
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  const tx = { anchor: { create }, anchorChange: { create: changeCreate } };
  const publish = vi.fn().mockResolvedValue(undefined);
  const outbox = { publish } as unknown as OutboxPublisher;
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const calendar = stubTradingCalendar();
  const anchorUpdate = vi.fn();
  const ensureBarExecute = vi.fn().mockResolvedValue(null);
  const ensureBar = { execute: ensureBarExecute } as unknown as EnsureLatestEodBarUseCase;
  const prisma = {
    anchor: { findUnique, create, updateMany, update: anchorUpdate },
    anchorChange: { create: changeCreate },
    $transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return {
    prisma,
    findUnique,
    create,
    updateMany,
    changeCreate,
    calendar,
    tx,
    outbox,
    publish,
    ensureBar,
    ensureBarExecute,
    anchorUpdate,
  };
}

const ASOF = new Date('2026-06-30T00:00:00Z');

/** 建锚落库后 prisma 返回的贫血 row (与 schema `optionsdesk.anchor` 逐列对应)。 */
function anchorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7n,
    ticker: 'us:AOS',
    v: new Prisma.Decimal('50'),
    asof: ASOF,
    method: 'dcf',
    confidence: new Prisma.Decimal('8'),
    confidenceSource: 'manual',
    excluded: false,
    excludeReason: null,
    nextReview: new Date('2026-09-30T00:00:00Z'),
    lastReviewedOn: new Date('2026-08-02T00:00:00Z'),
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

const validInput = {
  ticker: 'us:AOS',
  v: '50',
  asof: ASOF,
  method: 'dcf',
  confidence: '8',
};

// FR-003a ③ / plan D3: 生效 L 层是普通列, 应用层**写入时求值**。
describe('CreateAnchorUseCase — 生效 L 层写入求值 (FR-033, plan D3)', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
  });

  it('confidence 8 → 生效 L 层 L2 写入 data', async () => {
    await useCase.execute({ ...validInput, confidence: '8' });
    expect(m.create.mock.calls[0]![0].data.lLevelEffective).toBe('L2');
  });

  it('档界恰好 9 (下界闭) → L1; 恰好 3 → L3 —— 归属取自 anchor.rules, 写侧不复推', async () => {
    await useCase.execute({ ...validInput, confidence: '9' });
    expect(m.create.mock.calls[0]![0].data.lLevelEffective).toBe('L1');

    await useCase.execute({ ...validInput, confidence: '3' });
    expect(m.create.mock.calls[1]![0].data.lLevelEffective).toBe('L3');
  });

  it('confidence 是 Decimal(4,2) 可出 8.5 → 仍落 L2', async () => {
    await useCase.execute({ ...validInput, confidence: '8.5' });
    expect(m.create.mock.calls[0]![0].data.lLevelEffective).toBe('L2');
  });

  it('任一时刻只有一个生效 L 层: create data 里 lLevel* 键恰为 lLevelEffective 一个', async () => {
    await useCase.execute(validInput);
    const data = m.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(data).filter((k) => k.startsWith('lLevel'))).toEqual(['lLevelEffective']);
  });

  it('建锚不代设人工位 (FR-032 ① 人工调整须显式动作): 三列均不出现在 data', async () => {
    await useCase.execute(validInput);
    const data = m.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain('vManual');
    expect(Object.keys(data)).not.toContain('lLevelManual');
    expect(Object.keys(data)).not.toContain('positionCapManual');
  });

  it('confidenceSource 默认 manual (App 手工建锚), 可显式传 model', async () => {
    await useCase.execute(validInput);
    expect(m.create.mock.calls[0]![0].data.confidenceSource).toBe('manual');

    await useCase.execute({ ...validInput, confidenceSource: 'model' as const });
    expect(m.create.mock.calls[1]![0].data.confidenceSource).toBe('model');
  });
});

// 建锚 = 一次确认 ⇒ 回填 last_reviewed_on, 否则新锚在 W 下方立刻误亮复核锚红标 (FR-013)。
describe('CreateAnchorUseCase — 建锚即一次确认', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T13:30:00Z'));
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('last_reviewed_on = 建锚当日 UTC 日界', async () => {
    await useCase.execute(validInput);
    expect(m.create.mock.calls[0]![0].data.lastReviewedOn).toEqual(
      new Date('2026-08-02T00:00:00Z'),
    );
  });

  it('breach_started_on 不在建锚期写入 (判据要 spot, 归雷达状态机)', async () => {
    await useCase.execute(validInput);
    expect(Object.keys(m.create.mock.calls[0]![0].data)).not.toContain('breachStartedOn');
  });
});

// EC-10: next_review 早于 asof → 允许保存, 但 MUST 可识别为「建锚即逾期」, 不静默当有效。
describe('CreateAnchorUseCase — EC-10 建锚即逾期', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
  });

  it('next_review 早于 asof → 仍然保存 (不拒绝)', async () => {
    await useCase.execute({ ...validInput, nextReview: new Date('2026-05-01T00:00:00Z') });
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it('next_review 早于 asof → overdueAgainstAsof = true (可识别)', async () => {
    const result = await useCase.execute({
      ...validInput,
      nextReview: new Date('2026-05-01T00:00:00Z'),
    });
    expect(result.overdueAgainstAsof).toBe(true);
  });

  it('next_review 晚于 asof → overdueAgainstAsof = false', async () => {
    const result = await useCase.execute({
      ...validInput,
      nextReview: new Date('2026-09-30T00:00:00Z'),
    });
    expect(result.overdueAgainstAsof).toBe(false);
  });

  it('next_review 为空 → overdueAgainstAsof = false (无复审计划 ≠ 逾期)', async () => {
    const result = await useCase.execute({ ...validInput, nextReview: null });
    expect(result.overdueAgainstAsof).toBe(false);
  });
});

// EC-7: 同一 ticker 重复建锚 → 拒绝 (409 + 既有锚 id), 不静默 upsert 覆盖既有估值结论。
describe('CreateAnchorUseCase — EC-7 同 ticker 重复建锚', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
  });

  it('预检命中既有锚 → ConflictException (409)', async () => {
    m.findUnique.mockResolvedValue({ id: 42n });
    await expect(useCase.execute(validInput)).rejects.toBeInstanceOf(ConflictException);
  });

  it('409 body 带 code + 既有锚 id (引导去编辑既有锚)', async () => {
    m.findUnique.mockResolvedValue({ id: 42n });
    const err = await useCase.execute(validInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('ANCHOR_TICKER_EXISTS');
    expect(body.existingAnchorId).toBe('42');
    expect(String(body.message)).toContain('42');
  });

  it('重复建锚不改既有行: create / updateMany 均未被调用', async () => {
    m.findUnique.mockResolvedValue({ id: 42n });
    await expect(useCase.execute(validInput)).rejects.toThrow();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('并发窗内被抢 (create 撞 P2002 唯一索引) → 同样折叠成 409 + 既有锚 id', async () => {
    m.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 99n });
    m.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const err = await useCase.execute(validInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ existingAnchorId: '99' });
  });

  it('非 P2002 的 create 失败原样上抛 (不误折叠成 409)', async () => {
    m.findUnique.mockResolvedValue(null);
    m.create.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }));
    await expect(useCase.execute(validInput)).rejects.toMatchObject({ message: 'boom' });
  });
});

// EC-3: V ≤ 0 拒绝 —— 判据取自 anchor.rules (写侧不复推), 映射 400。
describe('CreateAnchorUseCase — EC-3 V ≤ 0 拒绝保存', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
  });

  it('V = 0 → BadRequestException INVALID_ANCHOR_V', async () => {
    await expect(useCase.execute({ ...validInput, v: '0' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('V 为负 → INVALID_ANCHOR_V 且 create 未被调用', async () => {
    await expect(useCase.execute({ ...validInput, v: '-1' })).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_ANCHOR_V'),
    });
    expect(m.create).not.toHaveBeenCalled();
  });
});

// T008 FR-031: 痕迹写入与主行变更同一个 tx, 一行痕迹 = 一次变更。
describe('CreateAnchorUseCase — 变更痕迹 (FR-031)', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
  });

  it('建锚落**恰好一条**痕迹', async () => {
    await useCase.execute(validInput);
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
  });

  it('建锚痕迹 beforeValues 为空 (锚此前不存在), 挂对 anchor_id', async () => {
    await useCase.execute(validInput);
    const data = m.changeCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.beforeValues).toEqual({});
    expect(data.anchorId).toBe(7n);
  });

  it('source 默认 manual, import 建锚可传 model (FR-035 可分辨来源)', async () => {
    await useCase.execute(validInput);
    expect(m.changeCreate.mock.calls[0]![0].data.source).toBe('manual');

    await useCase.execute({ ...validInput, source: 'model' as const });
    expect(m.changeCreate.mock.calls[1]![0].data.source).toBe('model');
  });

  it('主行与痕迹同一个 tx', async () => {
    await useCase.execute(validInput);
    expect((m.prisma as unknown as { $transaction: Fn }).$transaction).toHaveBeenCalledTimes(1);
  });

  it('建锚被拒 (EC-7 重复 ticker) → 零痕迹', async () => {
    m.findUnique.mockResolvedValue({ id: 42n });
    await expect(useCase.execute(validInput)).rejects.toThrow();
    expect(m.changeCreate).not.toHaveBeenCalled();
  });
});

// 060 T009 / FR-001~FR-004: 建锚事务内发 outbox 事件, marketdata 侧据此起冷启动补数。
describe('CreateAnchorUseCase — 建锚事件 (060 FR-001/002/004, plan §D1)', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
  });

  it('建锚成功 ⇒ publish 一次, 四个实参逐个钉死', async () => {
    await useCase.execute(validInput);

    expect(m.publish).toHaveBeenCalledTimes(1);
    const [client, eventType, payload, producerContext] = m.publish.mock.calls[0]! as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    // 🚨 client 必须是 `$transaction` 交回的那个 tx, **不是** this.prisma —— 传错的话锚回滚了
    //    outbox 行还在, 于是给一只根本不存在的锚跑冷启动 (FR-004 要的正是这条同生共死)。
    expect(client).toBe(m.tx);
    // 事件类型字面量: marketdata 侧持同一份副本 (两 ctx 互不 import, 见 subscriber)。
    expect(eventType).toBe('optionsdesk.anchor-created');
    expect(payload).toEqual({ anchorId: '7', ticker: 'us:AOS' });
    // producerContext 默认是 'auth', 不显式传就会把本事件记成 auth 产的。
    expect(producerContext).toBe('optionsdesk');
  });

  it('payload.anchorId 是**十进制串**而非 bigint (消费侧按串校验, 给 bigint 会被判毒丸丢掉)', async () => {
    await useCase.execute(validInput);

    const payload = m.publish.mock.calls[0]![2] as Record<string, unknown>;
    expect(typeof payload.anchorId).toBe('string');
    expect(payload.anchorId).toMatch(/^\d+$/);
  });

  it('payload 只带 anchorId + ticker —— market 由消费侧从 ticker 前缀解析 (FR-020)', async () => {
    await useCase.execute(validInput);

    // 生产侧预解析 market = 把市场知识复制到第二处; 判据只该有一份。
    expect(Object.keys(m.publish.mock.calls[0]![2] as object).sort()).toEqual([
      'anchorId',
      'ticker',
    ]);
  });

  it('预检命中既有锚 (EC-7 409) ⇒ publish 零调用 (没建成锚就没有建锚事件)', async () => {
    m.findUnique.mockResolvedValue({ id: 42n });

    await expect(useCase.execute(validInput)).rejects.toBeInstanceOf(ConflictException);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('并发窗被抢 (create 撞 P2002) ⇒ publish 零调用', async () => {
    m.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 99n });
    m.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(useCase.execute(validInput)).rejects.toBeInstanceOf(ConflictException);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('V ≤ 0 被拒 (EC-3) ⇒ publish 零调用 (校验早退在事务之前)', async () => {
    await expect(useCase.execute({ ...validInput, v: '0' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(m.publish).not.toHaveBeenCalled();
  });

  it('publish 抛错 ⇒ 整个建锚失败上抛 (不吞: 吞了锚就成了永不补数的孤儿)', async () => {
    m.publish.mockRejectedValue(new Error('outbox down'));

    await expect(useCase.execute(validInput)).rejects.toThrow(/outbox down/);
  });
});

describe('日期基准 — 「今天」跟用户所在地走, 不是 UTC', () => {
  // 判别性时刻: 北京 2026-08-04 00:30 = UTC 2026-08-03 16:30。
  // 两个函数在此刻**必须给出不同答案** —— 若相同, 说明基准没换对。
  const beijingEarlyMorning = new Date('2026-08-03T16:30:00.000Z');

  it('shanghaiDateOnly 在北京凌晨返回北京当日 (而非 UTC 的前一天)', () => {
    expect(shanghaiDateOnly(beijingEarlyMorning).toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('toUtcDateOnly 对同一时刻给出前一天 —— 这正是它不能用来求「今天」的原因', () => {
    expect(toUtcDateOnly(beijingEarlyMorning).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('北京 08:00 之后两者才一致 (所以这个 bug 只在境内早晨显形)', () => {
    const beijingMidday = new Date('2026-08-04T04:00:00.000Z'); // 北京 12:00
    expect(shanghaiDateOnly(beijingMidday).toISOString()).toBe(
      toUtcDateOnly(beijingMidday).toISOString(),
    );
  });

  it('shanghaiDateOnly 对已归一的 @db.Date 值幂等 (可安全复用于比较链)', () => {
    const dbDate = new Date('2026-08-04T00:00:00.000Z');
    expect(shanghaiDateOnly(dbDate).toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });
});

/**
 * 建锚同步取价 (2026-08-18)。三条分支各一格 —— 判据是「**建锚这件事永远成功**」:
 * 取到价 ⇒ 顺带写列; 取不到 / 打不通 ⇒ 静默退回每小时投影, 而不是把一次成功的建锚
 * 包装成失败 (往外抛会让调用方重试, 重试撞 uk_anchor_ticker 只会收到 409)。
 */
describe('CreateAnchorUseCase — 建锚即取最近收盘 (best-effort)', () => {
  let m: PrismaMock;
  let useCase: CreateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new CreateAnchorUseCase(m.prisma, m.outbox, m.ensureBar, m.calendar);
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );
    // 目标交易日: 让 resolveLastClosedSessionForTicker 拿得到一行, 否则本档直接短路。
    m.calendar.setLastClosed('2026-08-17');
  });

  afterEach(() => vi.restoreAllMocks());

  it('vendor 有数据 ⇒ 写 last_close / last_close_date, 且值进创建响应', async () => {
    m.ensureBarExecute.mockResolvedValue({
      tradeDate: '2026-08-17',
      adjust: 'none',
      open: '86.00',
      high: '87.50',
      low: '85.80',
      close: '86.94',
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    });
    m.anchorUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      anchorRow(data),
    );

    const result = await useCase.execute(validInput);

    expect(m.ensureBarExecute).toHaveBeenCalledWith('us:AOS', '2026-08-17');
    expect(m.anchorUpdate).toHaveBeenCalledTimes(1);
    const written = m.anchorUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(written.data.lastClose).toBe('86.94');
    // 交易日按 UTC 零点存 —— 与 sync-anchor-quote 同口径, 免时区漂。
    expect(written.data.lastCloseDate).toEqual(new Date('2026-08-17T00:00:00.000Z'));
    expect(result.lastClose).toBe('86.94');
  });

  it('vendor 无数据 (停牌 / 新股) ⇒ 不写列、不报错, 建锚照样成功', async () => {
    m.ensureBarExecute.mockResolvedValue(null);

    const result = await useCase.execute(validInput);

    expect(m.anchorUpdate).not.toHaveBeenCalled();
    expect(result.lastClose).toBeNull();
    expect(result.ticker).toBe('us:AOS');
  });

  it('🚨 vendor 抛错 ⇒ 吞掉并退回每小时投影, MUST NOT 让建锚失败', async () => {
    m.ensureBarExecute.mockRejectedValue(new Error('futu shim 504'));

    const result = await useCase.execute(validInput);

    expect(m.anchorUpdate).not.toHaveBeenCalled();
    expect(result.lastClose).toBeNull();
    expect(result.ticker).toBe('us:AOS');
    // 事件照发 —— 冷启动那条链与取价成败无关 (060 FR-002)。
    expect(m.publish).toHaveBeenCalledTimes(1);
  });
});
