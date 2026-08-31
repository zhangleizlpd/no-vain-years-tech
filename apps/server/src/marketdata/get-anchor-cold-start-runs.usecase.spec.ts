import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service';
import {
  COLD_START_RUN_QUERY_CAP,
  GetAnchorColdStartRunsUseCase,
} from './get-anchor-cold-start-runs.usecase';

/**
 * 断言派生自 spec **FR-009** 与 **state_branch 17 / 18**：
 * 「五档 → needsAttention=true」「查不到的 anchorId **不返回**，且这有语义（排队中或正在跑）」。
 */
function makePrisma(rows: readonly Record<string, unknown>[]) {
  const findMany = vi.fn(async (args: { where: { anchorId: { in: bigint[] } } }) =>
    rows.filter((r) => args.where.anchorId.in.includes(r['anchorId'] as bigint)),
  );
  const prisma = { anchorColdStartRun: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
}

const row = (anchorId: bigint, outcome: string) => ({
  anchorId,
  ticker: 'us:CFG',
  outcome,
  reason: null,
  targetSession: new Date('2026-08-28T00:00:00Z'),
  lastRunAt: new Date('2026-08-31T02:00:00Z'),
});

describe('GetAnchorColdStartRunsUseCase (072 FR-009)', () => {
  it('五档永久缺口 → needsAttention=true', async () => {
    const outcomes = [
      'retry_exhausted',
      'backfill_incomplete',
      'calendar_missing',
      'session_unregistered',
      'ticker_unresolved',
    ];
    const { prisma } = makePrisma(outcomes.map((o, i) => row(BigInt(i + 1), o)));
    const res = await new GetAnchorColdStartRunsUseCase(prisma).execute(
      outcomes.map((_, i) => BigInt(i + 1)),
    );
    expect(res).toHaveLength(5);
    expect(res.every((r) => r.needsAttention)).toBe(true);
  });

  // no_option_chain 是 066 从 backfill_incomplete 拆出来的:港股大多数标的没挂牌期权,
  // 混进去会让每只无期权的港股锚都产一条假警报。
  it('「本就不该做」与「做成了」→ needsAttention=false（含 no_option_chain）', async () => {
    const outcomes = [
      'backfilled',
      'already_present',
      'no_option_chain',
      'intraday_skipped',
      'market_not_enabled',
    ];
    const { prisma } = makePrisma(outcomes.map((o, i) => row(BigInt(i + 1), o)));
    const res = await new GetAnchorColdStartRunsUseCase(prisma).execute(
      outcomes.map((_, i) => BigInt(i + 1)),
    );
    expect(res.some((r) => r.needsAttention)).toBe(false);
  });

  // 🚨 state_branch 18：缺席**有语义**。补一个占位结局会让「N/M 已出结局」这个进度判据当场失效。
  it('查不到的 anchorId → 不返回该行, MUST NOT 编占位结局', async () => {
    const { prisma } = makePrisma([row(1n, 'backfilled')]);
    const res = await new GetAnchorColdStartRunsUseCase(prisma).execute([1n, 2n, 3n]);
    expect(res).toHaveLength(1);
    expect(res.map((r) => r.anchorId)).toEqual([1n]);
  });

  it('空入参 → 零查询', async () => {
    const { prisma, findMany } = makePrisma([row(1n, 'backfilled')]);
    expect(await new GetAnchorColdStartRunsUseCase(prisma).execute([])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('去重 + 截到单次上限（常识性防护）', async () => {
    const { prisma, findMany } = makePrisma([]);
    const ids = Array.from({ length: COLD_START_RUN_QUERY_CAP + 40 }, (_, i) => BigInt(i + 1));
    await new GetAnchorColdStartRunsUseCase(prisma).execute([...ids, ...ids]);
    const passed = findMany.mock.calls[0]![0].where.anchorId.in;
    expect(passed).toHaveLength(COLD_START_RUN_QUERY_CAP);
  });
});
