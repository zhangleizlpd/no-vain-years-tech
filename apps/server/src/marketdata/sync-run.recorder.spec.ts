import { describe, expect, it, vi } from 'vitest';
import { INTERRUPT_REASON, SyncRunRecorder } from './sync-run.recorder.js';

/**
 * Small × Narrow: `SyncRunRecorder.convergeInterrupted` 的行为面 (#137)。
 *
 * 用「带行的假表」而不是纯 spy —— 本方法的全部风险都在 **where 命中了谁**
 * (漏收 / 误伤活着的行), 断言 `toHaveBeenCalledWith` 只能证明参数长什么样,
 * 证明不了它选中的是哪几行。
 */

interface Row {
  id: bigint;
  bullJobId: string | null;
  status: string;
  finishedAt: Date | null;
  failedTargets: unknown;
}

function row(id: bigint, bullJobId: string | null, status: string): Row {
  return { id, bullJobId, status, finishedAt: null, failedTargets: null };
}

/** 只实现 `syncRun.updateMany` 的等价语义 (等值 where + 整体赋值)。 */
function prismaDouble(rows: Row[]) {
  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { bullJobId: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const hit = rows.filter((r) => r.bullJobId === where.bullJobId && r.status === where.status);
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  );
  return { prisma: { syncRun: { updateMany } }, updateMany };
}

const NOW = new Date('2026-08-21T15:06:32.000Z');

describe('SyncRunRecorder.convergeInterrupted (#137)', () => {
  it('把同 job 未收尾的行收成 interrupted 终态 (含 finishedAt + reason), 返收敛行数', async () => {
    const target = row(667n, 'job-a', 'running');
    const { prisma } = prismaDouble([target]);
    const recorder = new SyncRunRecorder(prisma as never);

    const count = await recorder.convergeInterrupted(
      'job-a',
      INTERRUPT_REASON.SUPERSEDED_BY_RETRY,
      NOW,
    );

    expect(count).toBe(1);
    expect(target.status).toBe('interrupted');
    // 终态必须带 finishedAt —— 否则报告脚本的 `finished_at IS NULL` 会永远给它挂「⚠未收尾」。
    expect(target.finishedAt).toEqual(NOW);
    expect(target.failedTargets).toEqual([{ reason: INTERRUPT_REASON.SUPERSEDED_BY_RETRY }]);
  });

  it('🚨 只碰 running 行 —— 已收尾的同 job 行 (前几次 attempt) 一律不动', async () => {
    const settled = row(665n, 'job-a', 'success');
    const zombie = row(667n, 'job-a', 'running');
    const { prisma } = prismaDouble([settled, zombie]);
    const recorder = new SyncRunRecorder(prisma as never);

    const count = await recorder.convergeInterrupted(
      'job-a',
      INTERRUPT_REASON.SUPERSEDED_BY_RETRY,
      NOW,
    );

    expect(count).toBe(1);
    expect(zombie.status).toBe('interrupted');
    // 把已成功的那轮改写成 interrupted = 伪造历史, 比不收敛更坏。
    expect(settled.status).toBe('success');
    expect(settled.finishedAt).toBeNull();
  });

  it('🚨 只碰本 job —— 别的 job 正在跑的行不受影响 (它们各有自己的接管者)', async () => {
    const mine = row(667n, 'job-a', 'running');
    const other = row(668n, 'job-b', 'running');
    const legacy = row(350n, null, 'running');
    const { prisma } = prismaDouble([mine, other, legacy]);
    const recorder = new SyncRunRecorder(prisma as never);

    await recorder.convergeInterrupted('job-a', INTERRUPT_REASON.SUPERSEDED_BY_RETRY, NOW);

    expect(mine.status).toBe('interrupted');
    expect(other.status).toBe('running');
    // bull_job_id 为 NULL 的历史行 (worker 路径之前的聚合行) 够不到, 只能一次性 SQL 收 —— 见 #137。
    expect(legacy.status).toBe('running');
  });

  it('无命中 ⇒ 返 0 且不抛 —— 正常失败收尾后 retry 耗尽会走到这里 (触发点 B 的稳态)', async () => {
    const closed = row(667n, 'job-a', 'failed');
    const { prisma } = prismaDouble([closed]);
    const recorder = new SyncRunRecorder(prisma as never);

    await expect(
      recorder.convergeInterrupted('job-a', INTERRUPT_REASON.RETRIES_EXHAUSTED, NOW),
    ).resolves.toBe(0);
    expect(closed.status).toBe('failed');
  });

  it('两个触发点的 reason 可分辨 —— 查表的人只看 failed_targets 就知道还会不会重跑', () => {
    expect(INTERRUPT_REASON.SUPERSEDED_BY_RETRY).not.toBe(INTERRUPT_REASON.RETRIES_EXHAUSTED);
  });
});
