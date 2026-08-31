import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service';
import { RejectAnchorSubmissionsUseCase } from './reject-anchor-submissions.usecase';

/**
 * 断言全部派生自 `specs/072-anchor-submission-review/spec.md` 的 **FR-007** 与
 * **state_branch 14**（「批量驳回命中 PENDING 子集 → rejected=命中数、skipped 列出其余；
 * MUST NOT 折成一句 ok」），**不是**照着实现反推的。
 *
 * 🚨 用**行为 fake** 而不是手写桩返回值：桩会把「实现当前恰好返回什么」固化成断言，
 * 于是 bug 一起被合法化。fake 复刻 PG 的条件更新语义（`where.status` 不匹配就不动），
 * 让「读写顺序」这类缺陷自己暴露出来，而不是被桩掩盖。
 */
type Row = { id: bigint; status: string; reviewNote: string | null };

function makePrisma(initial: readonly Row[]) {
  const rows: Row[] = initial.map((r) => ({ ...r }));

  const updateMany = vi.fn(
    async (args: {
      where: { id: { in: bigint[] }; status?: string };
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const row of rows) {
        if (!args.where.id.in.includes(row.id)) continue;
        if (args.where.status !== undefined && row.status !== args.where.status) continue;
        Object.assign(row, args.data);
        count += 1;
      }
      return { count };
    },
  );

  const findMany = vi.fn(async (args: { where: { id: { in: bigint[] } } }) =>
    rows
      .filter((r) => args.where.id.in.includes(r.id))
      .map((r) => ({ id: r.id, status: r.status })),
  );

  const prisma = {
    anchorSubmission: { updateMany, findMany },
    // 数组形态: Prisma 顺序执行并返回结果数组。
    $transaction: vi.fn(async (ops: readonly Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;

  return { prisma, rows, updateMany };
}

const pending = (id: bigint): Row => ({ id, status: 'PENDING', reviewNote: null });

describe('RejectAnchorSubmissionsUseCase (072 FR-007 / state_branch 14)', () => {
  it('全部是 PENDING → 全驳回, skipped 为空', async () => {
    const { prisma } = makePrisma([pending(1n), pending(2n)]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [1n, 2n] });
    expect(res.rejected).toBe(2);
    expect(res.skipped).toEqual([]);
  });

  it('混合 PENDING / CONSUMED → 只驳回 PENDING, 其余进 skipped', async () => {
    const { prisma } = makePrisma([
      pending(1n),
      { id: 2n, status: 'CONSUMED', reviewNote: null },
      pending(3n),
    ]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [1n, 2n, 3n] });
    expect(res.rejected).toBe(2);
    expect(res.skipped).toEqual(['2']);
  });

  // 🚨 本文件的核心用例。批次里混进一条**早已 REJECTED** 的行:本次调用并没有处置它,
  //    它必须出现在 skipped 里。把它报成「已驳回」正是 FR-007 明禁的「折成一句 ok」。
  it('批次含早已 REJECTED 的行 → 它 MUST 出现在 skipped(本次没动它)', async () => {
    const { prisma } = makePrisma([
      pending(1n),
      { id: 2n, status: 'REJECTED', reviewNote: '上一轮驳的' },
    ]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [1n, 2n] });
    expect(res.rejected).toBe(1);
    expect(res.skipped).toEqual(['2']);
  });

  it('不存在的 id → 进 skipped', async () => {
    const { prisma } = makePrisma([pending(1n)]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [1n, 99n] });
    expect(res.rejected).toBe(1);
    expect(res.skipped).toEqual(['99']);
  });

  // 不变量:每个 id 要么被本次驳回、要么被跳过, 没有第三种去处。
  it('rejected + skipped 恒等于去重后的 id 数(无声吞没)', async () => {
    const { prisma } = makePrisma([
      pending(1n),
      { id: 2n, status: 'CONSUMED', reviewNote: null },
      { id: 3n, status: 'REJECTED', reviewNote: null },
    ]);
    const ids = [1n, 2n, 3n, 4n];
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids });
    expect(res.rejected + res.skipped.length).toBe(ids.length);
  });

  it('重复 id 去重后计数', async () => {
    const { prisma } = makePrisma([pending(1n)]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [1n, 1n, 1n] });
    expect(res.rejected).toBe(1);
    expect(res.skipped).toEqual([]);
  });

  it('空 ids → 零调用零影响', async () => {
    const { prisma, updateMany } = makePrisma([pending(1n)]);
    const res = await new RejectAnchorSubmissionsUseCase(prisma).execute({ ids: [] });
    expect(res).toEqual({ rejected: 0, skipped: [] });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('给了 reviewNote → 写入;没给 → 不覆盖既有', async () => {
    const withNote = makePrisma([pending(1n)]);
    await new RejectAnchorSubmissionsUseCase(withNote.prisma).execute({
      ids: [1n],
      reviewNote: '口径日不可信',
    });
    expect(withNote.rows[0]!.reviewNote).toBe('口径日不可信');

    const noNote = makePrisma([{ id: 1n, status: 'PENDING', reviewNote: '早先写的' }]);
    await new RejectAnchorSubmissionsUseCase(noNote.prisma).execute({ ids: [1n] });
    expect(noNote.rows[0]!.reviewNote).toBe('早先写的');
  });
});
