import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import {
  ANCHOR_GATED_MARKETS,
  AnchorDrivenSyncGate,
  parseGateTicker,
} from './anchor-driven-sync-gate.js';

/**
 * 045 T015 US4 采集闸重算单测 (FR-028 / FR-029, plan D7)。
 *
 * 假 prisma 直实例化 (plain class, 非 Guard/Filter, 无 DI 容器必要 — 同
 * `sync-universe.usecase.spec.ts` 体例)。落库口径由
 * `test/integration/optionsdesk-045.sync-gate.it.spec.ts` (T016) 真 PG 承载。
 */

/** 被断言的 updateMany 入参形状 (只取本测关心的三处)。 */
interface GateUpdateArgs {
  where: {
    market: string;
    code: { in?: string[]; notIn?: string[] };
    needSync?: boolean;
  };
  data: Record<string, unknown>;
}

function buildGate(opts: {
  /** 锚表返回的 ticker 行; 省略 = 用 `findManyRejects` 模拟读失败。 */
  anchors?: string[];
  findManyRejects?: Error;
}): {
  gate: AnchorDrivenSyncGate;
  updateMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.spyOn>;
} {
  const findMany = opts.findManyRejects
    ? vi.fn(async () => {
        throw opts.findManyRejects;
      })
    : vi.fn(async () => (opts.anchors ?? []).map((ticker) => ({ ticker })));
  // updateMany 同步返「op 句柄」(真 Prisma 是 thenable), 由 $transaction 收集 → 结果数组。
  const updateMany = vi.fn((_args: GateUpdateArgs) => ({ count: 1 }));
  const transaction = vi.fn(async (ops: { count: number }[]) => ops);
  const prisma = {
    anchor: { findMany },
    instrument: { updateMany },
    $transaction: transaction,
  } as unknown as PrismaService;

  const gate = new AnchorDrivenSyncGate(prisma);
  // Logger 是实例私有字段, 从实例上 spy (不 mock 整个 @nestjs/common)。
  const warn = vi.spyOn(
    (gate as unknown as { logger: { warn: (m: string) => void } }).logger,
    'warn',
  );
  return { gate, updateMany, transaction, warn };
}

/** 取某市场的开闸 (in) / 关闸 (notIn) 调用入参。 */
function callsOf(updateMany: ReturnType<typeof vi.fn>): {
  open: GateUpdateArgs[];
  close: GateUpdateArgs[];
} {
  const args = updateMany.mock.calls.map((c) => c[0] as GateUpdateArgs);
  return {
    open: args.filter((a) => a.where.code.in !== undefined),
    close: args.filter((a) => a.where.code.notIn !== undefined),
  };
}

describe('AnchorDrivenSyncGate — 045 T015 按锚表重算 needSync', () => {
  it('有锚 → 开闸集合 = 锚的 us code 集; 关闸集合 = 其补集 (同一集合的 notIn)', async () => {
    const { gate, updateMany, transaction } = buildGate({
      anchors: ['us:AOS', 'us:PEP', 'us:VICI'],
    });

    const result = await gate.recalcSafely();

    expect(result).not.toBeNull();
    const { open, close } = callsOf(updateMany);
    expect(open).toHaveLength(1);
    expect(open[0]?.where.market).toBe('us');
    expect(open[0]?.where.code.in?.sort()).toEqual(['AOS', 'PEP', 'VICI']);
    expect(open[0]?.where.needSync).toBe(false); // 幂等过滤: 已开闸的行零变更
    expect(open[0]?.data).toEqual({ needSync: true });
    // 关闸走**同一集合**的补集 —— 两条 where 的 code 集必须一致, 否则会出现「既不开也不关」
    // 或「同时开又关」的行。
    expect(close).toHaveLength(1);
    expect(close[0]?.where.code.notIn?.sort()).toEqual(['AOS', 'PEP', 'VICI']);
    expect(close[0]?.where.needSync).toBe(true);
    expect(close[0]?.data).toEqual({ needSync: false });
    // 双 updateMany 单事务快照一致 (无半成品态)。
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('无锚 → 开闸天然 no-op (in: []) + 关闸全量 (notIn: [])', async () => {
    const { gate, updateMany } = buildGate({ anchors: [] });

    const result = await gate.recalcSafely();

    expect(result).toEqual({ opened: 1, closed: 1 });
    const { open, close } = callsOf(updateMany);
    expect(open[0]?.where.code.in).toEqual([]);
    expect(close[0]?.where.code.notIn).toEqual([]);
  });

  it('🚨 excluded=true 的锚**仍在**开闸集合 (Guardrail 8 / FR-028: 判据严格是「有没有锚」)', async () => {
    // 锚表读取只 `select: { ticker }` —— `excluded` 根本不进查询, 是本条最硬的实现级保证:
    // 锚 = 采集意愿、excluded = 交易意愿; 要彻底停采只能删锚 (期权 EOD 无跨日补救)。
    const { gate, updateMany } = buildGate({ anchors: ['us:AOS', 'us:TAP'] });

    await gate.recalcSafely();

    const { open } = callsOf(updateMany);
    expect(open[0]?.where.code.in?.sort()).toEqual(['AOS', 'TAP']);
  });

  it('🚨 读锚表 throw → 返 null、不上抛、零 updateMany (FR-029 不污染 SyncRun)', async () => {
    const { gate, updateMany, transaction, warn } = buildGate({
      findManyRejects: new Error('relation "optionsdesk.anchor" does not exist'),
    });

    // 不上抛: 用 resolves 断言 —— 一旦上抛, executor 顶层 catch 会把 SyncRun 记成 failed。
    await expect(gate.recalcSafely()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // 读失败 ⇒ 一行都不动 (拿不到锚集就关闸 = 把在采的标的全部误停, 期权 EOD 无跨日补救)。
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('🚨 只碰 needSync 一列 (Guardrail 6 受保护列): 每条 data payload 的 key 集恰为 {needSync}', async () => {
    const { gate, updateMany } = buildGate({ anchors: ['us:LULU'] });

    await gate.recalcSafely();

    for (const call of updateMany.mock.calls) {
      expect(Object.keys((call[0] as GateUpdateArgs).data)).toEqual(['needSync']);
    }
  });

  it('🚨 SC-007: 受闸市场恒为 us —— cn/hk 锚不产生任何 cn/hk 的 updateMany', async () => {
    const { gate, updateMany } = buildGate({
      anchors: ['cn:600519', 'hk:00700', 'us:CPB'],
    });

    await gate.recalcSafely();

    const markets = updateMany.mock.calls.map((c) => (c[0] as GateUpdateArgs).where.market);
    expect([...new Set(markets)]).toEqual(['us']);
    const { open } = callsOf(updateMany);
    // cn/hk 锚被丢弃 (它们默认全量采, 关闸路径若放进去会一次性移出全部 cn/hk 标的)。
    expect(open[0]?.where.code.in).toEqual(['CPB']);
  });

  it('非法 ticker (无 `market:code` 形态) 被跳过, 不炸整轮重算', async () => {
    const { gate, updateMany } = buildGate({ anchors: ['AAPL', ':X', 'us:', 'us:PSKY'] });

    const result = await gate.recalcSafely();

    expect(result).not.toBeNull();
    expect(callsOf(updateMany).open[0]?.where.code.in).toEqual(['PSKY']);
  });

  it('ANCHOR_GATED_MARKETS = ["us"] —— 与 sync-universe.usecase.ts 的 `market !== "us"` 成对', () => {
    expect([...ANCHOR_GATED_MARKETS]).toEqual(['us']);
  });

  it('parseGateTicker: 合法 / 非法边界', () => {
    expect(parseGateTicker('us:AOS')).toEqual({ market: 'us', code: 'AOS' });
    // code 侧允许含冒号 (只按**首个**冒号切), market 侧不允许空。
    expect(parseGateTicker('us:BRK:B')).toEqual({ market: 'us', code: 'BRK:B' });
    expect(parseGateTicker('AOS')).toBeNull();
    expect(parseGateTicker(':AOS')).toBeNull();
    expect(parseGateTicker('us:')).toBeNull();
  });
});
