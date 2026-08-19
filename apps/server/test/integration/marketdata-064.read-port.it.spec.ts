import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { marketdataConfig } from '../../src/config/marketdata.config';
import { FutuOptionSnapshotAdapter } from '../../src/marketdata/futu-option-snapshot.adapter';
import { MockCollectionRefusedError } from '../../src/marketdata/refusing-collection.adapter';
import {
  OPTION_SNAPSHOT_PORT,
  OPTION_SNAPSHOT_READ_PORT,
  RealtimeOptionSnapshotUnavailableError,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
} from '../../src/marketdata/option-snapshot.port';

/**
 * 064 T002 — **快照读取口 token 的绑定意图** (FR-015 前置, plan D1)。
 *
 * ## 为什么必须要真 DI 容器 (以及真 PG + 真 Redis)
 *
 * 本 task 改的**就是 `useFactory` 的绑定结果** —— 「两个 token 解析出的是不是同一个对象」这个
 * 问题只有真 DI 容器答得了: `provide` 是裸 `Symbol`, `FactoryProvider<T>` 的 `T` 由返回值反向
 * 推断, token 与类型之间零关联 (054 plan D-2 已实测), ⇒ 任何不经容器的写法验不到核心。
 * 而 `MarketdataModule` 依赖 `SecurityModule` (PrismaService + Redis 客户端) ⇒ 容器一起来就要
 * 有真库真 Redis 在, 否则连不上的是基建、红的却是本 feature。⇒ 走 `isolated-db.ts` 的
 * `setupIsolatedStores()` (共享 PG 容器上克隆一份库 + 一个 Redis), **不自起 PG 容器**。
 *
 * 📌 **`imports` 里 `AppModule` 与 `MarketdataModule` 两个都要, 缺一不可**: 前者带进全局
 * `ThrottlerModule` 等根级注册物 (只导 `MarketdataModule` 会在 `AccountIdThrottlerGuard` 处
 * 解析失败, 与本 feature 无关); 后者让**根测试模块**够得着它 `exports` 的 token —— 那正是下面
 * 那条 export 探针的机制 (Nest 模块是单例, 两处导的是同一个实例)。
 *
 * ## `kind` 靠 override 而不是 env
 *
 * `MARKETDATA_PROVIDER=live` 会连带要求一整套真 vendor 凭据 (zod fail-fast), 而本 IT 一次外呼
 * 都不发 —— 要验的是**接线**。⇒ `overrideProvider(marketdataConfig.KEY)` 直接喂两种 `kind`。
 * 📌 override 若失效, `kind` 落回 mock ⇒ 两个 token 绑的是两个不同的壳 ⇒ 同一性断言**变红而
 * 不是变绿**, 失败方向安全。
 *
 * 🚨 **同一性断言用 `toBe` 而不是 `toEqual`**: 要守的是「同一个 `VendorHttpClient` 实例 = 同一个
 * 令牌桶」(Guardrail 3)。两个各自 `new` 出来的 adapter 在 `toEqual` 下**照样相等** (字段同形),
 * 而那正是撞 429 的形态 —— 写成 `toEqual` 就等于这条 IT 没写。
 */

/** 一次不会真的发出去的查询 —— 只用于驱动 mock 分支的两种错误。 */
const QUERY: OptionSnapshotQuery = {
  underlyingSymbol: 'us:PEP',
  contractCodes: ['US.PEP260918P130000'],
};

/** `kind=live` 的收窄 config —— 全是假值: 本 IT 零外呼, 只看接线。 */
const LIVE_CONFIG = {
  kind: 'live' as const,
  lixingerToken: 'it-064-fake-lixinger-token',
  lixingerBaseUrl: 'https://open.lixinger.invalid/api',
  eastmoneyBaseUrl: 'https://searchapi.eastmoney.invalid',
  eastmoneyClistBaseUrl: 'https://push2.eastmoney.invalid',
  tencentCalendarBaseUrl: 'https://web.ifzq.gtimg.invalid',
  futuShimUrl: 'http://127.0.0.1:1',
  futuShimToken: 'it-064-fake-futu-shim-token',
};

/**
 * 「读取口确实是被 **export** 出去的」的探针 —— 根测试模块里的 provider 只解析得到**被 export
 * 的** token。漏 export 时 `compile()` 当场抛, 而不是等 optionsdesk 注入那天 boot 才炸。
 */
const EXPORT_PROBE = Symbol('OPTION_SNAPSHOT_READ_PORT_EXPORT_PROBE');

async function compileWith(config: unknown): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [AppModule, MarketdataModule],
    providers: [
      {
        provide: EXPORT_PROBE,
        inject: [OPTION_SNAPSHOT_READ_PORT],
        useFactory: (port: OptionSnapshotPort) => port,
      },
    ],
  })
    .overrideProvider(marketdataConfig.KEY)
    .useValue(config)
    .compile();
}

describe('064 快照读取口 token 的绑定意图 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let live: TestingModule;
  let mock: TestingModule;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-064-read-port-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-064-read-port-hmac-secret-min-32-b';
    delete process.env.MARKETDATA_PROVIDER; // kind 一律由 override 决定, 不受本机 env 影响

    live = await compileWith(LIVE_CONFIG);
    mock = await compileWith({ kind: 'mock' });
  }, 180_000);

  afterAll(async () => {
    await live?.close();
    await mock?.close();
    await stores.drop();
  });

  it('🚨 kind=live: 读取口与采集口解析出的是**同一个对象** (Guardrail 3 的机器化)', () => {
    const collection = live.get<OptionSnapshotPort>(OPTION_SNAPSHOT_PORT);
    const read = live.get<OptionSnapshotPort>(OPTION_SNAPSHOT_READ_PORT);
    // 探针: 先确认解析出来的确实是真 adapter, 否则下面的 toBe 可能是「两个壳恰好相等」。
    expect(collection).toBeInstanceOf(FutuOptionSnapshotAdapter);
    expect(read).toBe(collection);
  });

  it('kind=live: 读取口经 exports 可被外部模块注入 (漏 export ⇒ optionsdesk 注入时 boot 才炸)', () => {
    expect(live.get(EXPORT_PROBE)).toBe(live.get<OptionSnapshotPort>(OPTION_SNAPSHOT_PORT));
    const exported = Reflect.getMetadata('exports', MarketdataModule) as unknown[];
    expect(exported).toContain(OPTION_SNAPSHOT_READ_PORT);
  });

  it('🚨 kind=mock: 采集口抛拒绝壳原有错误, 读取口抛**可区分的**降级错误', async () => {
    const collection = mock.get<OptionSnapshotPort>(OPTION_SNAPSHOT_PORT);
    const read = mock.get<OptionSnapshotPort>(OPTION_SNAPSHOT_READ_PORT);

    expect(read).not.toBe(collection);
    expect(() => collection.getSnapshots(QUERY)).toThrow(MockCollectionRefusedError);
    await expect(read.getSnapshots(QUERY)).rejects.toBeInstanceOf(
      RealtimeOptionSnapshotUnavailableError,
    );
    // 两者混同会让 dev 的「本来就没有实时源」看起来像一次故障。
    await expect(read.getSnapshots(QUERY)).rejects.not.toBeInstanceOf(MockCollectionRefusedError);
  });

  it('kind=mock: 读取口 MUST NOT 返回 fixture —— 抛出来上游才落得到收盘档 (FR-010)', async () => {
    const read = mock.get<OptionSnapshotPort>(OPTION_SNAPSHOT_READ_PORT);
    await expect(read.getSnapshots(QUERY)).rejects.toThrow(/收盘档/);
  });
});
