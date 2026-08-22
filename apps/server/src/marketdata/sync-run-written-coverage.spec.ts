import { describe, it, expect, vi } from 'vitest';
import { DIMENSION_KEYS, DimensionExecutorRegistry } from './dimension-executor.js';
import type { SyncRunStats } from './sync-run.recorder.js';
import { SyncProfileUseCase } from './sync-profile.usecase.js';
import { SyncUniverseUseCase } from './sync-universe.usecase.js';

// #138 (承 #103): `written` 的**埋点覆盖面**守卫。
//
// ## 这个 spec 为什么必须是表驱动全集, 而不是几条挑出来的用例
//
// #103 修好的是 written 的**交接管道**; 病灶后来发现在管道两端 —— 多数维度压根没往里放东西。
// 2026-08-22 双通道实测 (prod 全维度取证 + 驱动真 registry 的探针) 的基线: 28 个维度里**只有**
// eod_bar / us_equity_bar / us_index_daily 在空转一轮时报得出 0, 其余 **25 个恒 NULL**。
// 逐维度挑用例写, 挑漏的那些正是会出事的那些 —— 事实上 #138 issue 本身就只点出了 4 个,
// 实测是 25 个。故本 spec 按 `DIMENSION_KEYS` **全集**跑, 新维度接进来自动进网, 忘埋点就红。
//
// ## 判据: 「跑通了、vendor 零行」的一轮必须报 `0`, 不是 `null`
//
// 三态语义里 `null` = 「没有任何写路径上报」, `0` = 「上报了, 真的一行没写」。后者才是本列要抓的
// 「全绿但没做事」。一个跑通、零失败的轮次停在 null, 等于把它伪装成「这个维度还没接线」。
//
// ## 两种 mode 都要跑
//
// 好几个维度的 delta 与 backfill 是**两条独立写路径** (fundamental / financial /
// underlying_iv_daily)。只跑 delta 会漏掉回填侧 —— 2026-08-22 实测: 族一那轮修完之后,
// delta 全绿而 backfill 里 fundamental / underlying_iv_daily 仍是 NULL。
//
// ## 🚨 prisma double 是 Proxy 而非逐 model 手写, 这是**刻意的**
//
// 本 spec 的价值就在「维度无关 + 全集」。手写 double 要为每个新维度补 model/method, 补漏的那天
// 这张网就跟着漏 —— 而它存在的理由恰恰是防漏。别把它"修"成显式 fake。
const DIM_ROW = {
  dimensionKey: 'any',
  enabled: true,
  cronExpr: '0 0 22 * * *',
  marketScope: ['cn'],
  adjustTypes: ['none'],
  batchSize: 50,
  historyDepth: 30,
  retryMax: 3,
  misfirePolicy: 'fire-now',
  reAdjustLookbackDays: 30,
  deltaLookbackDays: null,
  pausedUntil: null,
};

const INSTRUMENTS = [{ id: 1n, market: 'cn', code: '600519' }];

/** 任意 model 的任意方法 → 该方法的「零行」返回值 (findMany 空数组 / createMany count 0 / …)。 */
function modelDouble(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, method: string) => async () => {
        switch (method) {
          case 'findMany':
          case 'groupBy':
            return [];
          case 'findUnique':
          case 'findFirst':
            return null;
          case 'createMany':
          case 'deleteMany':
          case 'updateMany':
            return { count: 0 };
          case 'count':
            return 0;
          default:
            return {};
        }
      },
    },
  );
}

/** 维度无关的 prisma double: 除维度行与工作集外, 一切读返空、一切写返 0 行。 */
function prismaDouble(): unknown {
  const models = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === '$transaction') {
          return async (arg: unknown) =>
            typeof arg === 'function'
              ? await (arg as (tx: unknown) => Promise<unknown>)(prismaDouble())
              : [];
        }
        if (prop === 'syncDimension')
          return { findUnique: async () => DIM_ROW, update: async () => ({}) };
        if (prop === 'instrument') {
          return {
            findMany: async () => INSTRUMENTS,
            upsert: async () => ({}),
            update: async () => ({}),
            updateMany: async () => ({ count: 0 }),
          };
        }
        if (prop === 'then') return undefined; // 别让 await 把本对象当 thenable。
        if (!models.has(prop)) models.set(prop, modelDouble());
        return models.get(prop);
      },
    },
  );
}

/**
 * 全 port 零行的注册表。尾部端口一律走仓里已有的 `NULL_*` null-object (构造器默认值),
 * 那恰好就是「跑通了、vendor 一行都没返」的那一轮 —— 本 spec 要的正是这个形态。
 * universe / profile 装**真 use case** (它们的写路径在 use case 内, 换成 double 就测不到了)。
 */
function buildRegistry() {
  const finished: { status: string; stats: SyncRunStats }[] = [];
  const prisma = prismaDouble();
  const recorder = {
    start: vi.fn(async () => 1n),
    finish: vi.fn(async (_id: bigint, status: string, stats: SyncRunStats) => {
      finished.push({ status, stats });
    }),
  };
  const registry = new DimensionExecutorRegistry(
    new SyncUniverseUseCase({ enumerate: async () => [] } as never, prisma as never),
    new SyncProfileUseCase(
      { resolveCompanyTypes: async () => new Map() } as never,
      prisma as never,
    ),
    { getBars: async () => [] } as never,
    { getFundamentals: async () => [], getFundamentalsRange: async () => [] } as never,
    { getFinancials: async () => [], getFinancialsRange: async () => [] } as never,
    { getCorporateActions: async () => [] } as never,
    prisma as never,
    recorder as never,
    { recalcSafely: async () => null } as never,
  );
  return { registry, finished };
}

describe.each(['delta', 'backfill'] as const)(
  '#138 written 埋点覆盖面 — mode=%s: 每个维度跑完一轮都必须上报',
  (mode) => {
    it.each([...DIMENSION_KEYS])(
      '🚨 %s: 跑通且零失败的一轮 ⇒ written = 0 (不是 null —— null 会被读成「这个维度还没接线」)',
      async (key) => {
        const { registry, finished } = buildRegistry();

        await registry.execute(key, {
          mode,
          asOf: '2026-06-05',
          now: new Date('2026-06-05T14:00:00Z'),
          backfillHistoryDays: 30,
        });

        const run = finished.at(-1);
        // 先钉「这一轮真的跑通了」—— 否则 written 的断言会因为整轮炸掉而变得没有意义。
        expect(run?.stats.failed).toBe(0);
        expect(run?.stats.written).toBe(0);
      },
    );
  },
);
