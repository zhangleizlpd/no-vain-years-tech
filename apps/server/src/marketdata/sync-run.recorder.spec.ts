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
  findings: unknown;
}

function row(id: bigint, bullJobId: string | null, status: string): Row {
  return { id, bullJobId, status, finishedAt: null, findings: null };
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
    expect(target.findings).toEqual([
      { kind: 'interrupt', reason: INTERRUPT_REASON.SUPERSEDED_BY_RETRY },
    ]);
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

  it('两个触发点的 reason 可分辨 —— 查表的人只看 findings 就知道还会不会重跑', () => {
    expect(INTERRUPT_REASON.SUPERSEDED_BY_RETRY).not.toBe(INTERRUPT_REASON.RETRIES_EXHAUSTED);
  });
});

/**
 * Small × Narrow: 一行 `SyncRun` 的**来历两列** (#202) —— `triggered_by` / `as_of`。
 *
 * 断言的是**写进去了什么**, 故双替身只实现 `create` / `update` 的记账语义: 这两列没有任何
 * 读侧行为, 它们的全部风险就在「落库时是不是那个值」。
 */
function writeDouble() {
  const created: Record<string, unknown>[] = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    created.push(data);
    return { id: BigInt(created.length) };
  });
  const update = vi.fn(async () => ({}));
  return { prisma: { syncRun: { create, update } }, created };
}

describe('SyncRunRecorder.start — 来历两列 (#202)', () => {
  it('origin 三件套逐字落库 (bullJobId / triggeredBy / asOf)', async () => {
    const { prisma, created } = writeDouble();
    const recorder = new SyncRunRecorder(prisma as never);

    await recorder.start('sync:option_contract', {
      bullJobId: 'job-7',
      triggeredBy: 'tick',
      asOf: '2026-08-26',
    });

    expect(created[0]).toMatchObject({
      syncType: 'sync:option_contract',
      status: 'running',
      bullJobId: 'job-7',
      triggeredBy: 'tick',
    });
    expect((created[0]?.asOf as Date).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  it('🚨 origin 缺省 ⇒ 两列一个都不写 (NULL), **不兜底成 tick**', async () => {
    const { prisma, created } = writeDouble();
    const recorder = new SyncRunRecorder(prisma as never);

    await recorder.start('sync:eod_bar');

    // 键本身不该出现 —— 「不知道来历」与「按计划跑的一轮」若在库里长得一样, #146 Phase 2 /
    // #199 的计数器就会把漏接线的路径当成 tick 轮吃进去, 而那是判据输入被污染且全绿。
    expect(created[0]).not.toHaveProperty('triggeredBy');
    expect(created[0]).not.toHaveProperty('asOf');
  });

  it('🚨 asOf 是**业务日**不是本机日期 —— 宿主时区换了也必须落同一天', async () => {
    const original = process.env.TZ;
    try {
      // 两个方向都试: 本机领先 / 落后 UTC 各一次。裸 `new Date('YYYY-MM-DDT00:00:00')` 会按
      // 本机时区解析 ⇒ 这两轮会落到相邻的两天上, 本用例即为该写法的定向反例。
      for (const tz of ['Asia/Tokyo', 'America/New_York']) {
        process.env.TZ = tz;
        const { prisma, created } = writeDouble();
        const recorder = new SyncRunRecorder(prisma as never);

        await recorder.start('sync:eod_bar', { triggeredBy: 'tick', asOf: '2026-08-26' });

        expect((created[0]?.asOf as Date).toISOString()).toBe('2026-08-26T00:00:00.000Z');
      }
    } finally {
      // 进程级全局 —— 不还原会污染同 worker 里后续文件的任何日期断言。
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('skipped 行同样带来历 —— 「轮到它了但按设计没做」与「压根没轮到」必须分得开', async () => {
    const { prisma, created } = writeDouble();
    const recorder = new SyncRunRecorder(prisma as never);

    await recorder.recordSkippedWithReason('sync:announcement', 'event-calendar 日历未命中', NOW, {
      triggeredBy: 'tick',
      asOf: '2026-08-26',
    });

    expect(created[0]).toMatchObject({ status: 'running', triggeredBy: 'tick' });
    expect((created[0]?.asOf as Date).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });
});
