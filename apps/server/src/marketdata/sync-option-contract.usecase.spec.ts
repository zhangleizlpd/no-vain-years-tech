import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  OptionChainBudgetExhaustedError,
  OptionChainRejectedError,
  type OptionChainPort,
  type OptionChainWindowQuery,
  type OptionContractStatic,
} from './option-chain.port.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionContractUseCase } from './sync-option-contract.usecase.js';

/**
 * 链发现维度 use case 单测 (047 T015, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的四条都是「盲写会踩、且踩了不会红」的坑:
 * ① 零锚 ⇒ 对 vendor 的调用数必须是 **0** (FR-035)
 * ② `option_type` 恒 ALL、无行权价带、无到期日上限 (Guardrail 3 / 4 / FR-032)
 * ③ 业务日期按 **us 时区** —— 用上海日会「每周固定丢周五」(FR-036)
 * ④ gapCheck 有差集 **MUST 上抛**, 静默 log = 那一整批腿永久缺失且日志全绿
 */

/** 北京 06:00 = us 维度 cron 时刻; 入参就是它对应的 **us 业务日**。 */
const beijing6am = (usDate: string) => new Date(`${usDate}T22:00:00Z`);

const DIM = {
  dimensionKey: 'option_contract',
  marketScope: ['us'],
  batchSize: 50,
} as unknown as ExecutorSyncDimensionRow;

function makeInput(usDate = '2026-09-18'): ExecutorInput {
  return { mode: 'delta', asOf: usDate, now: beijing6am(usDate) };
}

const PEP = { id: 1n, market: 'us', code: 'PEP' };
const VICI = { id: 2n, market: 'us', code: 'VICI' };

/** 一行链合约 (adapter 已归一化后的形态)。 */
function contract(
  code: string,
  expiryDate: string,
  extra: Partial<OptionContractStatic> = {},
): OptionContractStatic {
  return {
    market: 'us',
    code,
    root: 'PEP',
    underlyingSymbol: 'us:PEP',
    expiryDate,
    strikePrice: '130',
    optionType: 'PUT',
    expirationCycle: 'MONTH',
    settlementMode: 'PM',
    isStandard: true,
    ...extra,
  };
}

interface Harness {
  useCase: SyncOptionContractUseCase;
  expiryCalls: string[];
  windowCalls: OptionChainWindowQuery[];
  createMany: ReturnType<typeof vi.fn>;
  instrumentUpsert: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
}

/**
 * @param ladder      每 symbol 的到期日阶梯
 * @param chainFor    每窗返回的合约 (默认: 该窗每个到期日各一 PUT)
 * @param anchors     锚表 ticker (FR-028b 兜底 seed 的输入)
 * @param existing    已在 Instrument 表内的 `market:code`
 */
function makeHarness(opts: {
  ladder?: Record<string, string[]>;
  chainFor?: (
    q: OptionChainWindowQuery,
  ) => OptionContractStatic[] | Promise<OptionContractStatic[]>;
  anchors?: string[];
  existing?: string[];
  /** 挂牌对账 `updateMany` 的返回行数 (withdraw = 置 withdrawnAt; restore = 清回 null)。 */
  reconcileCounts?: { withdraw?: number; restore?: number };
}): Harness {
  const ladder = opts.ladder ?? {};
  const expiryCalls: string[] = [];
  const windowCalls: OptionChainWindowQuery[] = [];

  const chain: OptionChainPort = {
    getExpiryDates: vi.fn(async (symbol: string) => {
      expiryCalls.push(symbol);
      return (ladder[symbol] ?? []).map((d) => ({
        expiryDate: d,
        expirationCycle: 'MONTH',
        daysToExpiry: null,
      }));
    }),
    getChainWindow: vi.fn(async (q: OptionChainWindowQuery) => {
      windowCalls.push(q);
      if (opts.chainFor) return opts.chainFor(q);
      const dates = (ladder[q.symbol] ?? []).filter((d) => d >= q.start && d <= q.end);
      return dates.map((d) => contract(`US.PEP${d.replaceAll('-', '')}P130000`, d));
    }),
  };

  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const instrumentUpsert = vi.fn(async () => ({}));
  // 对账两条 updateMany 由 `data.withdrawnAt` 区分: Date ⇒ withdraw, null ⇒ restore。
  const updateMany = vi.fn(async (args: { data: { withdrawnAt: Date | null } }) => {
    const isWithdraw = args.data.withdrawnAt !== null;
    return {
      count: isWithdraw
        ? (opts.reconcileCounts?.withdraw ?? 0)
        : (opts.reconcileCounts?.restore ?? 0),
    };
  });
  const prisma = {
    anchor: { findMany: vi.fn(async () => (opts.anchors ?? []).map((ticker) => ({ ticker }))) },
    instrument: {
      findMany: vi.fn(async () =>
        (opts.existing ?? []).map((s) => ({ market: s.split(':')[0], code: s.split(':')[1] })),
      ),
      upsert: instrumentUpsert,
    },
    optionContract: { createMany, updateMany },
  } as unknown as PrismaService;

  return {
    useCase: new SyncOptionContractUseCase(chain, prisma),
    expiryCalls,
    windowCalls,
    createMany,
    instrumentUpsert,
    updateMany,
  };
}

/** 所有 createMany 落库行拍平。 */
function persistedRows(createMany: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Record<string, unknown>[] }).data ?? [],
  );
}

describe('SyncOptionContractUseCase', () => {
  describe('🚨 工作集 = 锚白名单 (FR-035 / FR-038)', () => {
    it('零锚 (工作集为空) → 对 port 的调用数为 0', async () => {
      // 挂锚闸的意义全在这条: 不挂闸工作集会从十几只炸到 19,465 只 us 标的, 实算 44 小时。
      const h = makeHarness({});
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([], DIM, stats, makeInput());

      expect(h.expiryCalls).toHaveLength(0);
      expect(h.windowCalls).toHaveLength(0);
      expect(budgetExhausted).toBe(false);
      // 零锚跑绿 (不是失败, 也不是告警) —— state_branch 21。
      expect(stats).toMatchObject({ scanned: 0, ok: 0, failed: 0 });
    });

    it('工作集里的每一只都采 —— 无硬编码白名单 / 无 symbol 过滤 (新锚下一轮零代码改动即纳入)', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'], 'us:VICI': ['2026-09-18'] },
      });
      await h.useCase.run([PEP, VICI], DIM, emptyStats(), makeInput());
      expect(h.expiryCalls).toEqual(['us:PEP', 'us:VICI']);
    });
  });

  describe('🚨 采集端零过滤 (Guardrail 3 / 4, FR-032 / FR-033)', () => {
    it('给 port 的窗查询只有 symbol/start/end —— 没有任何筛选入参', async () => {
      // 「本片只含认沽」是呈现面的话。端口层没有 optionType 参数 ⇒ 结构上不可能滤边;
      // 真正传给 vendor 的 `option_type=ALL` 由 futu-option-chain.adapter.spec 钉死。
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-09-18'] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      expect(h.windowCalls).toHaveLength(1);
      expect(Object.keys(h.windowCalls[0]).sort()).toEqual(['end', 'start', 'symbol']);
    });

    it('CALL 行与 PUT 行一并落库 (漏采即永久缺口, M4 要 CALL 时买不回来)', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'] },
        chainFor: () => [
          contract('US.PEP260918P130000', '2026-09-18'),
          contract('US.PEP260918C130000', '2026-09-18', { optionType: 'CALL' }),
        ],
      });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      expect(
        persistedRows(h.createMany)
          .map((r) => r.optionType)
          .sort(),
      ).toEqual(['CALL', 'PUT']);
    });

    it('非标合约照常落库, 只是 isStandard=false (排除只发生在选约层)', async () => {
      const h = makeHarness({
        ladder: { 'us:VICI': ['2026-09-18'] },
        chainFor: () => [
          contract('US.VICI260918P30000', '2026-09-18', {
            root: 'VICI',
            underlyingSymbol: 'us:VICI',
          }),
          contract('US.VICI1260918P30000', '2026-09-18', {
            root: 'VICI1',
            underlyingSymbol: 'us:VICI',
            isStandard: false,
          }),
        ],
      });
      await h.useCase.run([VICI], DIM, emptyStats(), makeInput());

      const rows = persistedRows(h.createMany);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.isStandard)).toEqual([true, false]);
    });

    it('不设到期日上限 —— LEAPS 照常进窗 (FR-032)', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-09-18', '2028-01-21'] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());
      // 两个到期日相隔 >30 天 ⇒ 两个窗, 远月那个不被丢弃。
      expect(h.windowCalls.map((w) => w.end)).toEqual(['2026-09-18', '2028-01-21']);
    });
  });

  describe('贪心分窗 (FR-029, T008 纯函数的消费面)', () => {
    it('5–12 月 8 个到期日 = 5 次链调用 (p3b 实测基线), 且窗端点恒为真实到期日', async () => {
      const ladder = [
        '2026-05-15',
        '2026-06-19',
        '2026-07-17',
        '2026-08-21',
        '2026-09-18',
        '2026-10-16',
        '2026-11-20',
        '2026-12-18',
      ];
      const h = makeHarness({ ladder: { 'us:PEP': ladder } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-05-01'));

      expect(h.windowCalls).toHaveLength(5);
      for (const w of h.windowCalls) {
        expect(ladder).toContain(w.start);
        expect(ladder).toContain(w.end);
      }
    });
  });

  describe('🚨 业务日期按 us 时区 (FR-036 / plan D-DATA-10)', () => {
    it('北京周六 06:00 跑 → 当日 (周五) 到期的合约仍被采, 不丢周五', async () => {
      // 2026-06-12 周五。用全局上海日会算成周六 06-13 ⇒ 周五到期的那批腿在它们**最后一天**
      // 被整批跳过, 而快照漏采即永久缺口。这条不红的话, 每周固定丢一次。
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-06-12', '2026-06-19'] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-06-12'));

      expect(h.windowCalls[0].start).toBe('2026-06-12');
      expect(persistedRows(h.createMany).map((r) => r.expiryDate)).toContainEqual(
        new Date('2026-06-12T00:00:00Z'),
      );
    });

    it('已过期的到期日被剔除 (FR-028a: 判据是 ≥ 当前交易日, 不是 >)', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-06-05', '2026-06-12'] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-06-12'));
      expect(h.windowCalls.map((w) => w.start)).toEqual(['2026-06-12']);
    });
  });

  describe('🚨 gapCheck 差集非空 MUST 上抛 (plan D-DATA-2)', () => {
    it('vendor 权威列表里有、链却没返回合约的到期日 → throw, 不静默 log', async () => {
      // 分窗与链调用**全都成功了**, 除了这条对表没有任何东西会发现那一整批腿没落库。
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18', '2026-10-16'] },
        chainFor: (q) =>
          q.start === '2026-09-18' ? [contract('US.PEP260918P130000', '2026-09-18')] : [],
      });

      const err = await h.useCase.run([PEP], DIM, emptyStats(), makeInput()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(err)).toMatch(/2026-10-16/);
    });

    it('上抛前已采到的行照常落库 (不为一条对表失败回滚整轮证据)', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18', '2026-10-16'] },
        chainFor: (q) =>
          q.start === '2026-09-18' ? [contract('US.PEP260918P130000', '2026-09-18')] : [],
      });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput()).catch(() => undefined);
      expect(persistedRows(h.createMany)).toHaveLength(1);
    });

    it('两侧集合一致 → 不抛', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-09-18'] } });
      await expect(h.useCase.run([PEP], DIM, emptyStats(), makeInput())).resolves.toBe(false);
    });
  });

  describe('🚨 挂牌状态对账 —— 软下架 vendor 已删的码 (withdrawn_at, #334 后续)', () => {
    // 死码毒批病根: vendor 已不认的码留在工作集 ⇒ 整批 snapshot 502。对账在链发现里摘掉它。
    const usDate = '2026-09-18';
    const bizDate = usDate; // us 业务日 = 入参日 (beijing6am 折算)

    it('gap.ok 时对账两条 updateMany —— withdraw 谓词 = 未到期 ∧ 不在阶梯 ∧ 尚未 withdrawn', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': [usDate] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput(usDate));

      const withdraw = h.updateMany.mock.calls.find(
        (c) => (c[0] as { data: { withdrawnAt: unknown } }).data.withdrawnAt !== null,
      )?.[0] as { where: Record<string, any>; data: { withdrawnAt: Date } } | undefined;
      expect(withdraw).toBeDefined();
      expect(withdraw!.where.underlyingInstrumentId).toBe(PEP.id);
      expect(withdraw!.where.withdrawnAt).toBeNull();
      // 未到期闸 + 不在 vendor 当前阶梯的到期日 (notIn)。
      expect(withdraw!.where.expiryDate.gte).toEqual(new Date(`${bizDate}T00:00:00Z`));
      expect(withdraw!.where.expiryDate.notIn).toEqual([new Date(`${usDate}T00:00:00Z`)]);
      expect(withdraw!.data.withdrawnAt).toBeInstanceOf(Date);
    });

    it('gap.ok 时 restore 谓词 = 在阶梯 ∧ 当前 withdrawn → 清回 null (vendor 认回来即复采)', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': [usDate] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput(usDate));

      const restore = h.updateMany.mock.calls.find(
        (c) => (c[0] as { data: { withdrawnAt: unknown } }).data.withdrawnAt === null,
      )?.[0] as { where: Record<string, any>; data: { withdrawnAt: null } } | undefined;
      expect(restore).toBeDefined();
      expect(restore!.where.underlyingInstrumentId).toBe(PEP.id);
      expect(restore!.where.expiryDate.in).toEqual([new Date(`${usDate}T00:00:00Z`)]);
      expect(restore!.where.withdrawnAt).toEqual({ not: null });
    });

    it('🚨 gap≠ok (链差集) → 一条 updateMany 都不发 —— 差集时 discovered 不是权威阶梯, 摘会误摘真合约', async () => {
      // 与「gapCheck 差集 MUST 上抛」同一场景: 阶梯有 10-16 但链没返回它。
      const h = makeHarness({
        ladder: { 'us:PEP': [usDate, '2026-10-16'] },
        chainFor: (q) => (q.start === usDate ? [contract('US.PEP260918P130000', usDate)] : []),
      });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput(usDate)).catch(() => undefined);
      expect(h.updateMany).not.toHaveBeenCalled();
    });

    it('对账发生变动 (withdraw / restore 任一 > 0) → 落 notice finding; 稳态零变动 → 无 finding', async () => {
      const changed = makeHarness({
        ladder: { 'us:PEP': [usDate] },
        reconcileCounts: { withdraw: 3 },
      });
      const s1 = emptyStats();
      await changed.useCase.run([PEP], DIM, s1, makeInput(usDate));
      const notice = s1.findings.find((f) => f.kind === 'notice');
      expect(notice).toMatchObject({
        kind: 'notice',
        step: 'option_contract_listing',
        detail: { symbol: 'us:PEP', withdrawn: 3, restored: 0 },
      });

      const steady = makeHarness({ ladder: { 'us:PEP': [usDate] } }); // 默认 counts 全 0
      const s2 = emptyStats();
      await steady.useCase.run([PEP], DIM, s2, makeInput(usDate));
      expect(s2.findings.some((f) => f.kind === 'notice')).toBe(false);
    });
  });

  describe('失败语义 (429 顺延 vs 400 失败)', () => {
    it('429 → budgetExhausted=true, 计 skipped 不计 failed, 剩余标的顺延', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'], 'us:VICI': ['2026-09-18'] },
        chainFor: () => {
          throw new OptionChainBudgetExhaustedError('option-chain us:PEP');
        },
      });
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([PEP, VICI], DIM, stats, makeInput());

      expect(budgetExhausted).toBe(true);
      // deferral ≠ failure: 记成 failed 会白白吃掉 worker 的重试次数。
      expect(stats.failed).toBe(0);
      expect(stats.skipped).toBe(2);
      // 顺延后不再对后续标的发请求。
      expect(h.expiryCalls).toEqual(['us:PEP']);
    });

    it('400 (窗越界等永久拒绝) → 计 failed 并继续下一只, 不顺延', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'], 'us:VICI': ['2026-09-18'] },
        chainFor: (q) => {
          if (q.symbol === 'us:PEP') throw new OptionChainRejectedError('option-chain us:PEP');
          return [
            contract('US.VICI260918P30000', '2026-09-18', {
              root: 'VICI',
              underlyingSymbol: 'us:VICI',
            }),
          ];
        },
      });
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([PEP, VICI], DIM, stats, makeInput());

      expect(budgetExhausted).toBe(false);
      expect(stats).toMatchObject({ scanned: 2, ok: 1, failed: 1 });
      expect(stats.findings).toHaveLength(1);
      expect(JSON.stringify(stats.findings)).toContain('us:PEP');
    });

    it('合约归属错配 (underlyingSymbol ≠ 请求的 symbol) → 该票计 failed, 不落到别人名下', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'] },
        chainFor: () => [
          contract('US.VICI260918P30000', '2026-09-18', { underlyingSymbol: 'us:VICI' }),
        ],
      });
      const stats = emptyStats();

      await h.useCase.run([PEP], DIM, stats, makeInput());

      expect(stats.failed).toBe(1);
      expect(persistedRows(h.createMany)).toHaveLength(0);
    });
  });

  describe('幂等 (FR-037)', () => {
    it('落库走 createMany + skipDuplicates —— 同日重跑不产生重复行', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-09-18'] } });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());
      expect(h.createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    });
  });

  describe('FR-028b 兜底 seed —— 有锚必有 Instrument 行', () => {
    it('已建锚但 Instrument 无行 → 幂等 upsert (update 为空, 不冲掉既有行的列)', async () => {
      const h = makeHarness({ anchors: ['us:NVDA'], existing: [] });
      await h.useCase.run([], DIM, emptyStats(), makeInput());

      expect(h.instrumentUpsert).toHaveBeenCalledTimes(1);
      const arg = h.instrumentUpsert.mock.calls[0][0] as {
        where: unknown;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(arg.where).toEqual({ market_code: { market: 'us', code: 'NVDA' } });
      expect(arg.create).toMatchObject({ market: 'us', code: 'NVDA', currency: 'USD' });
      // 🚨 needSync 是受保护列, 唯一的重算点是 anchor-driven-sync-gate —— seed 照
      // sync-universe 的 create 分支落 false, 由下一轮锚闸开闸 (SC-003 的「下一轮」时序)。
      expect(arg.create.needSync).toBe(false);
      // update 留空: 已有行的 name / syncTier / needSync 一个都不许被 seed 冲掉。
      expect(arg.update).toEqual({});
    });

    it('锚已有 Instrument 行 → 不发 upsert (兜底不是主路径)', async () => {
      const h = makeHarness({ anchors: ['us:PEP'], existing: ['us:PEP'] });
      await h.useCase.run([], DIM, emptyStats(), makeInput());
      expect(h.instrumentUpsert).not.toHaveBeenCalled();
    });

    it('scope 外市场的锚不 seed (本维度只承担 us)', async () => {
      const h = makeHarness({ anchors: ['hk:00700', 'us:NVDA'], existing: [] });
      await h.useCase.run([], DIM, emptyStats(), makeInput());
      expect(h.instrumentUpsert).toHaveBeenCalledTimes(1);
    });

    // 066 T03 (FR-009): 港股锚走 create 分支时**必须**落 needSync=true。
    //
    // 🚨 反例必须自己造 —— 拿 universe 已收录的港股票断言毫无意义 (那行的 needSync 本来
    // 就是 true, seed 分支根本没跑)。这里用一个 `existing` 里**没有**的港股代码, 逼 seed
    // 走 create。写 false 的后果: 该行被 22:00 的 `eod_bar` 静默排除 ⇒ 那只标的永远没日线,
    // 且**没有任何告警**。
    it('🚨 港股锚首建 → needSync=true (港股没有采集闸, seed 写死 false 会让它永远没日线)', async () => {
      const hkDim = {
        dimensionKey: 'hk_option_contract',
        marketScope: ['hk'],
        batchSize: 1,
      } as unknown as ExecutorSyncDimensionRow;
      const h = makeHarness({ anchors: ['hk:09999'], existing: [] });
      await h.useCase.run([], hkDim, emptyStats(), makeInput());

      const arg = h.instrumentUpsert.mock.calls[0][0] as { create: Record<string, unknown> };
      expect(arg.create).toMatchObject({
        market: 'hk',
        code: '09999',
        currency: 'HKD',
        needSync: true,
      });
    });
  });

  /**
   * 🚨 本体 `collect` 提 public (issue #159)。
   *
   * 冷启动直调它补**单只**新锚, 不再入维度 job —— 维度 job 的工作集是「全部 `needSync`
   * 标的」⇒ 93 只锚 = 93 次全域重扫 (O(N²))。prod 实测 2026-08-23: 单轮 2555 秒 /
   * 872 次外呼 / **写 0 行**, 93 只锚跑 59 小时, 而真正需要的是约 42 秒。
   *
   * 形态**逐字对齐** {@link SyncOptionSnapshotUseCase}: `run()` 只做「从 dim/input 算
   * spec」的薄适配 (供 `factExecutor` 注册), 工作集选择**恒属** `factExecutor` ——
   * 本体从不自己查工作集, 那才是「第二个口子」。
   */
  describe('🚨 collect —— 本体 public 入口 (冷启动直调, issue #159)', () => {
    const SPEC = { businessDate: '2026-09-18' };

    it('只采传入的那一只 —— 工作集不从库里查', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'], 'us:VICI': ['2026-09-18'] },
      });

      await h.useCase.collect([PEP], SPEC, emptyStats());

      // VICI 也是已开闸标的, 但没传进来就一次都不碰 —— 这正是 54× 放大的解药。
      expect(h.expiryCalls).toEqual(['us:PEP']);
    });

    it('🚨 MUST NOT 跑兜底 seed —— 那是维度级职责, 留在薄适配层', async () => {
      // seed 修的是「有锚必有 Instrument 行」这个 FK 前提, 与本轮工作集无关; 冷启动
      // 相一已 seed 过自己那一只。让本体也跑 = 每建一只锚就全量扫一遍锚表。
      const h = makeHarness({ anchors: ['us:NVDA'], existing: [] });

      await h.useCase.collect([PEP], SPEC, emptyStats());

      expect(h.instrumentUpsert).not.toHaveBeenCalled();
    });

    it('businessDate 由调用方显式给 —— 本体不自己算 (同快照侧 collect)', async () => {
      const h = makeHarness({ ladder: { 'us:PEP': ['2026-09-18', '2026-12-18'] } });

      // 显式给一个晚于首个到期日的业务日 ⇒ 它被 FR-028a 的 `>=` 判据剔除。
      await h.useCase.collect([PEP], { businessDate: '2026-10-01' }, emptyStats());

      expect(h.windowCalls.map((q) => q.start)).toEqual(['2026-12-18']);
    });

    it('gapCheck 差集仍 MUST 上抛 —— 换入口不许把这条对表丢掉', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'] },
        chainFor: async () => [], // 权威列表有该到期日, 却一个合约都没发现
      });

      await expect(h.useCase.collect([PEP], SPEC, emptyStats())).rejects.toThrow(
        /到期日对表有差集/,
      );
    });

    it('run() 语义不变 —— 薄适配层照旧 seed + 自己算 businessDate (回归)', async () => {
      const h = makeHarness({
        ladder: { 'us:PEP': ['2026-09-18'] },
        anchors: ['us:NVDA'],
        existing: [],
      });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-18'));

      expect(h.expiryCalls).toEqual(['us:PEP']);
      expect(h.instrumentUpsert).toHaveBeenCalledTimes(1);
    });
  });
});
