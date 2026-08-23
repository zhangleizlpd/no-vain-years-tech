import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import {
  SyncUniverseUseCase,
  defaultNeedSync,
  seedInstrumentCreateData,
} from './sync-universe.usecase.js';

/**
 * 038 T004 currency 按 market 单测: sync-universe upsert 的 create.currency 从 hardcode 'CNY'
 * → 按标的 market 取 (cn→CNY / hk→HKD)。仅 insert 分支写 currency (update 分支护下游, FR-S03)。
 */

function buildUseCase(entries: UniverseEntry[]): {
  useCase: SyncUniverseUseCase;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => ({}));
  const prisma = {
    // S2-T2: run() 读 universe 维度 marketScope 驱动 enumerate (mock universe 忽略入参返固定 entries)。
    syncDimension: { findUnique: vi.fn(async () => ({ marketScope: ['cn', 'hk'] })) },
    syncBlacklist: { findMany: vi.fn(async () => []) },
    instrument: { upsert },
  } as unknown as PrismaService;
  const universe = {
    enumerate: vi.fn(async () => entries),
  } as unknown as InstrumentUniversePort;
  return { useCase: new SyncUniverseUseCase(universe, prisma), upsert };
}

/** 取某 code 的 upsert create.currency (断言辅助)。 */
function currencyOf(upsert: ReturnType<typeof vi.fn>, code: string): unknown {
  const call = upsert.mock.calls.find(
    (c) => (c[0] as { create: { code: string } }).create.code === code,
  );
  return (call?.[0] as { create: { currency: unknown } }).create.currency;
}

describe('SyncUniverseUseCase — 038 T004 / S2-T3 currency 按 market + B 股 code 例外', () => {
  it('hk → HKD; us → USD; cn → CNY', async () => {
    const { useCase, upsert } = buildUseCase([
      { market: 'cn', code: '600519', name: '贵州茅台' },
      { market: 'hk', code: '00700', name: '腾讯控股' },
      { market: 'us', code: 'AAPL', name: '苹果' },
    ]);

    const stats = await useCase.run();

    expect(stats.ok).toBe(3);
    expect(currencyOf(upsert, '600519')).toBe('CNY');
    expect(currencyOf(upsert, '00700')).toBe('HKD');
    expect(currencyOf(upsert, 'AAPL')).toBe('USD');
  });

  // 🚨 B 股挂在 cn 却以外币交易 (库里价格就是本币)。标成 CNY 不会报错, 只会让派息被币种守卫
  // 吞掉 → 条款法退化成 f=1 → 与见证法分歧 → 该除权日落 needs_review + 因子 1, 于是那只票
  // 除权日之前的整段历史都没被复权。2026-08 prod 实测 13 只 B 股全中, 故补此档。
  it('🚨 cn B 股按 code 例外: 深市 200xxx → HKD / 沪市 900xxx → USD', async () => {
    const { useCase, upsert } = buildUseCase([
      { market: 'cn', code: '200429', name: '粤高速B' },
      { market: 'cn', code: '900902', name: '市北B股' },
      { market: 'cn', code: '300692', name: '中赋科技' },
    ]);

    const stats = await useCase.run();

    expect(stats.ok).toBe(3);
    expect(currencyOf(upsert, '200429')).toBe('HKD');
    expect(currencyOf(upsert, '900902')).toBe('USD');
    // 同为 cn 的非 B 股不受影响 (深市创业板 300xxx) —— 防「例外」写宽把 A 股一起改了。
    expect(currencyOf(upsert, '300692')).toBe('CNY');
  });
});

// #138: universe 曾被**蓄意豁免**出 `written` (schema 原话「恒写恒非零, 跑了但零写入这个形态
// 在它身上不存在」)。豁免不成立: `enumerate()` 返空 —— fallback 链耗尽 / 上游改了返回形态 ——
// 就是「跑了、status=success、一行没写」, 而那恰恰是本列要抓的东西。豁免等于把它挡在门外。
describe('SyncUniverseUseCase — #138 written 埋点 (豁免已撤)', () => {
  it('🚨 enumerate 返空 ⇒ written = 0 而非 null (跑了、全绿、一行没写 = 本列要抓的形态)', async () => {
    const { useCase, upsert } = buildUseCase([]);

    const stats = await useCase.run();

    expect(upsert).not.toHaveBeenCalled();
    expect(stats.written).toBe(0);
  });

  it('逐行 upsert 按行计 ⇒ 3 行入库 ⇒ written = 3', async () => {
    const { useCase } = buildUseCase([
      { market: 'cn', code: '600519', name: '贵州茅台' },
      { market: 'hk', code: '00700', name: '腾讯控股' },
      { market: 'us', code: 'AAPL', name: '苹果' },
    ]);

    const stats = await useCase.run();

    expect(stats.written).toBe(3);
  });
});

// 066 T03 新建标的行的采集资格默认值 (FR-009, plan §A4)。Small / 零外部依赖。
//
// 🚨 本组盯的是**永远不会红的那类坑**: `needSync` 写错既不报错也不掉数据, 只让那只标的从
// `eod_bar` / `sync-profile` / backfill CLI 三个消费方的工作集里静默消失 —— 表现为「那只
// 标的永远没有日线」, 而日线是雷达跌破判据的输入。
describe('066 T03 defaultNeedSync / seedInstrumentCreateData —— 新建行默认值单一真相源', () => {
  it('us 走「无锚不采」成员制 ⇒ false; 其余市场全量语义 ⇒ true', () => {
    expect(defaultNeedSync('us')).toBe(false);
    expect(defaultNeedSync('hk')).toBe(true);
    expect(defaultNeedSync('cn')).toBe(true);
    // 未来市场默认**采** —— 漏采是永久缺口, 多采只是几次 API 调用 (同锚闸的不对称性判据)。
    expect(defaultNeedSync('jp')).toBe(true);
  });

  it('🚨 港股 seed payload 落 needSync=true —— 这正是被两个 seed 点写死 false 破坏掉的不变量', () => {
    expect(seedInstrumentCreateData('hk', '09999')).toEqual({
      market: 'hk',
      code: '09999',
      name: '09999', // 列 NOT NULL 的占位, universe 轮到该票时覆盖成真名
      type: 'stock',
      currency: 'HKD',
      status: 'active',
      needSync: true,
    });
  });

  it('美股 seed payload 仍落 needSync=false (不误伤既有「无锚不采」语义)', () => {
    expect(seedInstrumentCreateData('us', 'NVDA')).toMatchObject({
      currency: 'USD',
      needSync: false,
    });
  });

  it('币种走 currencyForMarket 同一判据 (B 股例外不在 seed 路径上另写一份)', () => {
    expect(seedInstrumentCreateData('cn', '900902').currency).toBe('USD');
    expect(seedInstrumentCreateData('cn', '600519').currency).toBe('CNY');
  });
});
