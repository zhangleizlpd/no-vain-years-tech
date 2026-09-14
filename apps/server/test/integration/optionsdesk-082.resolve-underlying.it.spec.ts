import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  BROKER_ACCOUNT_PORT,
  type BrokerAccountPort,
} from '../../src/optionsdesk/broker-account.port';
import type { BrokerMarket } from '../../src/optionsdesk/broker-code.rules';
import {
  createBrokerUnderlyingResolver,
  underlyingOfOrder,
} from '../../src/optionsdesk/resolve-broker-underlying';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-082-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-082-it-hmac-secret-min-32-bytes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 082 T013 —— 券商代码 → 正股判定链 + 缓存的**真 PG IT** (FR-006 / FR-007; plan D5;
 * state_branches 4, 5)。
 *
 * ## 为什么必须要真 PG
 *
 * ① 词根映射是对 marketdata `option_contract` × `instrument` 的**跨 ctx 只读聚合**
 *    (`groupBy` + `in` 查询), 判的是「调整合约词根 `CMCS1` → `us:CMCSA`」这种只有真行才有的
 *    归属; fake 仓储里那张映射是测试自己写的, 断言等于自证。
 * ② 缓存命中 (「第二次同步 `fetchStockOwners` 调用数 0」) 的证据是 `broker_contract_ref`
 *    **真的落了行**且下一个解析器实例从库里读回来; 内存 Map 验不到跨同步持久化。
 * ③ `createMany({ skipDuplicates })` 的 ON CONFLICT 语义只在真库成立。
 *
 * 装配 = `OptionsdeskModule` 真 DI (plan Testing Invariants), **只替换** `BROKER_ACCOUNT_PORT`。
 *
 * ## 定向变异留档 (2026-09-14, 类型合法形态, 均经 `pnpm nx test server <本文件>`)
 *
 * - 基线: 6/6 绿。
 * - m1 缓存查询恒空 (`code: { in: [] as string[] }`) ⇒ 仅「第二次同步命中缓存」红 (券商被再问 1 次)。
 * - m2 在挂判据恒真 (`expiry >= today || today.length > 0`) ⇒ 仅「全链都判不出」红
 *   (已过期码被送券商)。
 * - m3 组合单只判「无未解析腿」(`tickers.has(null)`) ⇒ 仅「组合单」红 (两腿正股不一致取了首腿)。
 * - moat: 删 `option_contract` 那处 `CROSS-CONTEXT-READ` ⇒ `check-server-moat` exit 1
 *   (`optionContract.groupBy()` 缺注释)。
 * - 四处均还原 (`cmp` 与备份一致) 后: IT 6/6 绿、moat exit 0。
 */

/** 2026-09-14 11:00 ET ⇒ 美股交易所当地「今天」= 2026-09-14, 与宿主时区无关。 */
const NOW = new Date('2026-09-14T15:00:00Z');

class FakeStockOwnerPort implements Partial<BrokerAccountPort> {
  readonly calls: { market: BrokerMarket; codes: string[] }[] = [];
  owners = new Map<string, string | null>();

  async fetchStockOwners(market: BrokerMarket, codes: readonly string[]) {
    this.calls.push({ market, codes: [...codes] });
    return new Map(codes.map((code) => [code, this.owners.get(code) ?? null]));
  }
}

describe('082 券商代码正股判定链 IT (Testcontainers PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  const port = new FakeStockOwnerPort();

  const resolver = () =>
    createBrokerUnderlyingResolver(
      { prisma, port: port as unknown as BrokerAccountPort },
      { market: 'us', now: NOW },
    );

  const seedInstrument = async (code: string) =>
    (
      await prisma.instrument.create({
        data: { market: 'us', code, name: code, type: 'stock', currency: 'USD', status: 'active' },
        select: { id: true },
      })
    ).id;

  const seedContract = (code: string, root: string, underlyingInstrumentId: bigint) =>
    prisma.optionContract.create({
      data: {
        market: 'us',
        code,
        root,
        underlyingInstrumentId,
        expiryDate: new Date('2026-10-16T00:00:00Z'),
        strikePrice: '100',
        optionType: 'PUT',
        isStandard: root.length === 3,
      },
    });

  const refOf = (code: string) =>
    prisma.brokerContractRef.findUnique({ where: { market_code: { market: 'us', code } } });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(BROKER_ACCOUNT_PORT)
      .useValue(port)
      .compile();
    prisma = moduleRef.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    port.calls.length = 0;
    port.owners = new Map();
    await prisma.brokerContractRef.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.instrument.deleteMany({});
    const pep = await seedInstrument('PEP');
    const cmcsa = await seedInstrument('CMCSA');
    await seedContract('US.PEP261016P100000', 'PEP', pep);
    // prod 形态: 调整合约词根带尾数字, 与正股代码字面不同 (FR-006 禁截字面还原)。
    await seedContract('US.CMCS1261016P100000', 'CMCS1', cmcsa);
  });

  it('已过期期权码不在合约表, 经「市场 + 词根」映射判出正股并写缓存 (来源 root_map)', async () => {
    const expired = 'US.PEP240119P150000';
    const res = await resolver().resolve([expired]);

    expect(res.get(expired)).toBe('us:PEP');
    expect(port.calls).toHaveLength(0);
    expect(await refOf(expired)).toMatchObject({ underlyingTicker: 'us:PEP', source: 'root_map' });
  });

  it('调整合约词根 CMCS1 命中 us:CMCSA (不截字面)', async () => {
    const adjusted = 'US.CMCS1261218C45000';
    const res = await resolver().resolve([adjusted]);

    expect(res.get(adjusted)).toBe('us:CMCSA');
    expect(port.calls).toHaveLength(0);
  });

  it('零合约锚的在挂期权码走 fetchStockOwners 兜底并写缓存 (来源 stock_owner)', async () => {
    const orphan = 'US.NEWCO261218P50000';
    port.owners.set(orphan, 'us:NEWCO');
    const res = await resolver().resolve([orphan, 'US.PEP261016P100000']);

    expect(res.get(orphan)).toBe('us:NEWCO');
    expect(port.calls).toEqual([{ market: 'us', codes: [orphan] }]);
    expect(await refOf(orphan)).toMatchObject({
      underlyingTicker: 'us:NEWCO',
      source: 'stock_owner',
    });
  });

  it('第二次同步命中缓存, fetchStockOwners 调用数 0', async () => {
    const orphan = 'US.NEWCO261218P50000';
    const codes = [orphan, 'US.PEP240119P150000', 'US.CMCS1261218C45000'];
    port.owners.set(orphan, 'us:NEWCO');
    const first = await resolver().resolve(codes);
    expect(port.calls).toHaveLength(1);

    port.calls.length = 0;
    port.owners = new Map(); // 第二次若再问券商只会得 null ⇒ 结果一致只可能来自缓存
    const second = await resolver().resolve(codes);

    expect(port.calls).toHaveLength(0);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('全链都判不出 ⇒ null (未解析), 不落缓存; 已过期且不在词根映射的码不送券商', async () => {
    const ghostLive = 'US.GHOST261218P10000';
    const goneExpired = 'US.GONE240119P10000';
    const res = await resolver().resolve([ghostLive, goneExpired, 'garbage']);

    expect(res.get(ghostLive)).toBeNull();
    expect(res.get(goneExpired)).toBeNull();
    expect(res.get('garbage')).toBeNull();
    expect(port.calls).toEqual([{ market: 'us', codes: [ghostLive] }]);
    expect(await prisma.brokerContractRef.count()).toBe(0);
  });

  it('组合单: 各腿正股一致取之; 两腿正股不一致或任一腿未解析 ⇒ null', async () => {
    const pepLeg1 = 'US.PEP261016P100000';
    const pepLeg2 = 'US.PEP261120P95000';
    const cmcsaLeg = 'US.CMCS1261218C45000';
    const ghostLeg = 'US.GHOST261218P10000';
    const res = await resolver().resolve([pepLeg1, pepLeg2, cmcsaLeg, ghostLeg]);
    const combo = (legs: string[]) =>
      underlyingOfOrder({ code: 'US.SYNTHETIC/COMBO', comboLegCodes: legs }, res);

    expect(combo([pepLeg1, pepLeg2])).toBe('us:PEP');
    expect(combo([pepLeg1, cmcsaLeg])).toBeNull();
    expect(combo([pepLeg1, ghostLeg])).toBeNull();
    // 非组合单按自身代码
    expect(underlyingOfOrder({ code: cmcsaLeg, comboLegCodes: [] }, res)).toBe('us:CMCSA');
  });
});
