import { describe, it, expect } from 'vitest';
import { PrismaService } from '../security/prisma.service.js';
import { DbOptionChainDiscoveryAdapter } from './db-option-chain-discovery.adapter.js';

/**
 * 链发现进度 adapter 单测 (#361)。被测面是 adapter 自己那一层职责: **把「问全了」这三条判据
 * 落成一次查询**, 以及市场 → 维度键的路由。
 *
 * 🚨 stub 真的按 `where` 过滤、真的按 `orderBy` 排序 —— 否则「筛掉了没筛掉」根本断言不出来,
 * 整份 spec 会变成一句「adapter 会调 prisma」。三条判据各自都有一条**只有它能拦住**的臂。
 *
 * 🚨 **种子里的 `syncType` 一律写死 `sync:` 前缀的字面量, 🚫 MUST NOT 复用实现侧的
 * `dimensionSyncType()`** —— 用同一个函数造种子, 测的就只是「实现和自己一致」, 前缀写错时
 * 两边一起错、七条断言全绿。本 spec 初版正是这么写的, 直到直查 prod 才发现读侧在拿裸维度键
 * 查一张全部带前缀的表, 恒零行。
 * EVIDENCE: 2026-09-05 直查 prod `marketdata.sync_run` 近 30 天 29 个 `sync_type` 全部形如
 * `sync:<dim>`（`sync:hk_option_contract` 9 轮 / `sync:option_contract` 58 轮）。
 */

interface RunRow {
  syncType: string;
  status: string;
  skipped: number;
  startedAt: string;
  finishedAt: string;
}

function prismaWith(rows: readonly RunRow[]): PrismaService {
  return {
    syncRun: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { syncType?: string; status?: string; skipped?: number };
        orderBy: { startedAt: 'desc' };
      }) => {
        expect(orderBy).toEqual({ startedAt: 'desc' });
        // 🚨 **缺键 = 不过滤**, 照 Prisma 的语义。写成 `r.skipped === where.skipped` 会让
        //    「adapter 少传一个过滤键」表现为**全都匹配不上**, 于是定向变异红在一堆不相干的
        //    臂上、而真正该拦住它的那条反倒是绿的 (2026-09-05 实撞: 摘掉 `skipped: 0` 红了 4 条,
        //    其中不含「限频顺延 ⇒ null」那条) —— 红了但红错地方, 等于没钉住。
        const match = <T>(expected: T | undefined, actual: T) =>
          expected === undefined || expected === actual;
        const hit = rows
          .filter(
            (r) =>
              match(where.syncType, r.syncType) &&
              match(where.status, r.status) &&
              match(where.skipped, r.skipped),
          )
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        return hit === undefined
          ? null
          : { startedAt: new Date(hit.startedAt), finishedAt: new Date(hit.finishedAt) };
      },
    },
  } as unknown as PrismaService;
}

const run = (o: Partial<RunRow> & Pick<RunRow, 'syncType' | 'startedAt'>): RunRow => ({
  status: 'success',
  skipped: 0,
  finishedAt: '2099-01-01T00:00:00Z',
  ...o,
});

describe('DbOptionChainDiscoveryAdapter', () => {
  it('问全了的一轮 ⇒ 返回它的 started_at', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([
        run({
          syncType: 'sync:hk_option_contract',
          startedAt: '2026-09-04T15:20:00Z',
          finishedAt: '2026-09-04T15:41:00Z',
        }),
      ]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toEqual(
      new Date('2026-09-04T15:20:00Z'),
    );
  });

  it('🚨 只有「限频顺延」的轮 (status=success ∧ skipped>0) ⇒ null —— deriveStatus 只看 failed, 顺延掉一半标的的轮照样报 success', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([
        run({
          syncType: 'sync:hk_option_contract',
          startedAt: '2026-09-04T15:20:00Z',
          skipped: 17,
        }),
      ]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toBeNull();
  });

  it('🚨 只有取数失败的轮 (status=partial) ⇒ null —— 每晚都失败的标的 MUST NOT 被判成「没有期权」', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([
        run({
          syncType: 'sync:hk_option_contract',
          startedAt: '2026-09-04T15:20:00Z',
          status: 'partial',
        }),
      ]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toBeNull();
  });

  it('🚨 返回的是 started_at 不是 finished_at —— 工作集在轮开始时装载, 拿 finished_at 比建锚时刻会把「轮跑到一半时建的锚」误判成已问过', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([
        run({ syncType: 'us_x', startedAt: '2026-09-04T15:20:00Z' }),
        run({
          syncType: 'sync:option_contract',
          startedAt: '2026-09-04T22:00:00Z',
          finishedAt: '2026-09-04T23:30:00Z',
        }),
      ]),
    );
    const at = await adapter.lastCompleteDiscoveryAt('us');
    expect(at).toEqual(new Date('2026-09-04T22:00:00Z'));
    expect(at).not.toEqual(new Date('2026-09-04T23:30:00Z'));
  });

  it('多轮 ⇒ 取最近的那一轮', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([
        run({ syncType: 'sync:hk_option_contract', startedAt: '2026-09-01T15:20:00Z' }),
        run({ syncType: 'sync:hk_option_contract', startedAt: '2026-09-04T15:20:00Z' }),
        run({ syncType: 'sync:hk_option_contract', startedAt: '2026-09-02T15:20:00Z' }),
      ]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toEqual(
      new Date('2026-09-04T15:20:00Z'),
    );
  });

  it('🚨 两个市场各取自己的维度键, 不串 —— us 有轮不让 hk 变成「问过了」', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      prismaWith([run({ syncType: 'sync:option_contract', startedAt: '2026-09-04T22:00:00Z' })]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('us')).resolves.not.toBeNull();
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toBeNull();
  });

  it('🚨 拿**裸维度键**存的行查不到 —— `sync_run.sync_type` 是 `sync:<dim>`, 前缀丢了就恒零行', async () => {
    const adapter = new DbOptionChainDiscoveryAdapter(
      // 🚨 蓄意用**错误**的裸键播种: 读侧若也用裸键, 这条会「绿」, 而生产里那张表一条都匹配不上。
      prismaWith([run({ syncType: 'hk_option_contract', startedAt: '2026-09-04T15:20:00Z' })]),
    );
    await expect(adapter.lastCompleteDiscoveryAt('hk')).resolves.toBeNull();
  });

  it('🚨 未登记链发现维度的市场 ⇒ null 且零查询 (MUST NOT 猜一个维度键)', async () => {
    let queried = false;
    const prisma = {
      syncRun: {
        findFirst: async () => {
          queried = true;
          return null;
        },
      },
    } as unknown as PrismaService;
    await expect(
      new DbOptionChainDiscoveryAdapter(prisma).lastCompleteDiscoveryAt('cn'),
    ).resolves.toBeNull();
    expect(queried).toBe(false);
  });
});
