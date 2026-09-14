import { BrokenCircuitError } from 'cockatiel';
import { describe, it, expect, vi } from 'vitest';
import type { MarketdataConfig } from '../config/marketdata.config';
import { MockCollectionRefusedError } from '../marketdata/refusing-collection.adapter';
import { TransientVendorError, VendorHttpError } from '../marketdata/vendor-http-client';
import type { VendorHttpClient, VendorRequest } from '../marketdata/vendor-http-client';
import { BrokerAccountSelectionError, BrokerInfrastructureError } from './broker-account.port';
import { FutuBrokerAccountAdapter, createBrokerAccountPort } from './futu-broker-account.adapter';

/**
 * 082 T012 富途券商账户 adapter 单测 (Small: HTTP 以 test double 注入, 不打真网)。
 *
 * 仿真行的**键集照 futu SDK 源码**的行字典 (`futu/trade/trade_query.py`: 持仓 `position_list`、
 * 订单 `parse_order`、成交 `parse_deal`), 取值形态照 082 POC-1 (plan D2 / D4): 空头持仓 `qty`
 * 为负、成交 `qty` 非负、`deal_id` 为数字串、成交行无 `currency`、时间无时区带毫秒。
 * 真端点契约不在本文件的证据范围内。
 *
 * 成交号 / 订单号用 19 位明显假号的**数字串** (2026-09-14 amend): 即修复后 shim 的输出形态。
 * EVIDENCE: 真号超安全整数 —— 082 POC-1 (2026-09-13 维护者采集的原始输出) 244/244 行 `deal_id` 为
 * 17–19 位整数且 > 2^53−1; 2026-09-14 prod 首次回填因 shim 仍输出 JSON number 而报「缺可用的 deal_id」。
 * 旧 fixture 的 7 位小号覆盖不到这个尺寸, 故 T012 未发现。
 *
 * 🚨 账户号一律假值 {@link FAKE_ACC_ID} (末 4 位 0000)。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1; 2026-09-14 实跑, 每次还原后 `cmp` 与备份逐字节相同):
 *   a. 去掉 `delete raw.acc_id`                      → 1 failed | 9 passed —— 只有 ⑥ 红
 *   b. 成交币种取另一市场的值                          → 1 failed | 9 passed —— 只有 ② 红
 *   c. 409 映射条件改成永不命中 (`=== 4090`)           → 1 failed | 9 passed —— 只有 ⑤ 红
 *   d. 工厂去掉 mock 分支 (`if (false)`)               → 1 failed | 9 passed —— 只有 ⑦ 红
 *   2026-09-14 amend 补 ⑧ ⑨ 后 (共 12 条, 同法直跑, 还原后 `cmp` 相同):
 *   e. `idOrNull` number 分支去掉 `isSafeInteger`        → 1 failed | 11 passed —— 只有 ⑧ 红
 *   f. `idOrNull` 串分支改 `String(Number(s))`            → 2 failed | 10 passed —— ⑨ 与 ③ (断言 19 位 dealId) 红
 *   ⚠️ b / c / d 经 `pnpm -C apps/server exec vitest run <本文件>` 直跑: `nx test server` 先跑
 *   typecheck, 类型不合的变异 (d 丢了 `cfg` 收窄) 会在 tsc 处红而**测试根本没跑**, 那不算证据。
 *   边界规则对照: 在 optionsdesk 新建文件 import `marketdata/marketdata.rules` → eslint
 *   `boundaries/dependencies` error (exit 1), 删除后本 adapter 全部 import 零报错。
 *   复跑: pnpm nx test server src/optionsdesk/futu-broker-account.adapter.spec.ts --skip-nx-cache
 */
const BASE = 'http://shim.test';
const TOKEN = 'test-shim-token';
const FAKE_ACC_ID = 12340000;
const WINDOW = { start: '2026-09-01', end: '2026-09-11' };

const SHORT_PUT_POSITION = {
  code: 'US.PEP260918P130000',
  stock_name: 'PEP 260918 130.00P',
  position_market: 'US',
  qty: -2.0,
  can_sell_qty: 0.0,
  cost_price: 1.85,
  cost_price_valid: true,
  average_cost: 1.85,
  diluted_cost: 1.85,
  market_val: -210.0,
  nominal_price: 1.05,
  currency: 'USD',
  position_side: 'SHORT',
  position_id: 3001,
  acc_id: FAKE_ACC_ID,
};

function deal(extra: Record<string, unknown> = {}) {
  return {
    code: 'US.PEP260918P130000',
    stock_name: 'PEP 260918 130.00P',
    deal_market: 'US',
    deal_id: '1000000000000000001',
    order_id: '1000000000000000002',
    qty: 2.0,
    price: 1.85,
    trd_side: 'SELL_SHORT',
    create_time: '2026-09-11 09:31:08.950',
    counter_broker_id: 'N/A',
    counter_broker_name: 'N/A',
    status: 'OK',
    acc_id: FAKE_ACC_ID,
    ...extra,
  };
}

/** 组合单: 合成 `code` 不被解析 (FR-007), 取值与断言无关。腿串形态照 POC-1 (`broker-code.rules.ts`)。 */
const COMBO_ORDER = {
  code: 'US.PEP-COMBO',
  stock_name: 'PEP combo',
  order_market: 'US',
  trd_side: 'SELL',
  order_type: 'NORMAL',
  order_status: 'FILLED_ALL',
  order_id: '1000000000000000003',
  qty: 1.0,
  price: 0.95,
  create_time: '2026-09-11 09:40:00.120',
  updated_time: '2026-09-11 09:40:01.502',
  dealt_qty: 1.0,
  dealt_avg_price: 0.95,
  currency: 'USD',
  combo_legs: [
    'ComboLeg(code=US.PEP260918P120000, trd_side=BUY, qty_ratio=1.0, position_id=N/A)',
    'ComboLeg(code=US.PEP260918P130000, trd_side=SELL, qty_ratio=1.0, position_id=N/A)',
  ],
  acc_id: FAKE_ACC_ID,
};

/** 按请求路径回信封 `{as_of, count, rows}` 的假 transport。 */
function makeShim(rowsByPath: Record<string, unknown[]>) {
  const request = vi.fn(async (req: VendorRequest) => {
    const rows = rowsByPath[new URL(req.url).pathname] ?? [];
    return { as_of: '2026-09-11T14:00:00+00:00', count: rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

function makeThrowingShim(err: unknown) {
  const request = vi.fn(async () => {
    throw err;
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

const makeAdapter = (http: VendorHttpClient) => new FutuBrokerAccountAdapter(http, BASE, TOKEN);

const LIVE_CONFIG = {
  kind: 'live',
  lixingerToken: 'x',
  lixingerBaseUrl: 'https://lixinger.test',
  eastmoneyBaseUrl: 'https://eastmoney.test',
  eastmoneyClistBaseUrl: 'https://clist.test',
  tencentCalendarBaseUrl: 'https://tencent.test',
  futuShimUrl: BASE,
  futuShimToken: TOKEN,
} satisfies MarketdataConfig;

describe('FutuBrokerAccountAdapter', () => {
  it('① 成交时间带毫秒 ⇒ 按市场交易所时区解析且毫秒保留 (FR-008)', async () => {
    const us = makeShim({ '/trade/deals': [deal()] });
    const [usDeal] = await makeAdapter(us.http).fetchDeals('us', WINDOW);
    // 2026-09-11 美东夏令时 UTC-4
    expect(usDeal?.tradedAt.toISOString()).toBe('2026-09-11T13:31:08.950Z');

    const hk = makeShim({
      '/trade/deals': [
        deal({ code: 'HK.00700', deal_market: 'HK', create_time: '2026-09-11 10:05:00.007' }),
      ],
    });
    const [hkDeal] = await makeAdapter(hk.http).fetchDeals('hk', WINDOW);
    // 香港 UTC+8
    expect(hkDeal?.tradedAt.toISOString()).toBe('2026-09-11T02:05:00.007Z');

    const req = us.request.mock.calls[0]?.[0];
    const url = new URL(req?.url ?? '');
    expect(url.pathname).toBe('/trade/deals');
    expect(Object.fromEntries(url.searchParams)).toEqual({ market: 'US', ...WINDOW });
    expect(req?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('② 成交行无 currency ⇒ 按市场补 (US ⇒ USD, HK ⇒ HKD)', async () => {
    const us = makeShim({ '/trade/deals': [deal()] });
    const hk = makeShim({ '/trade/deals': [deal({ code: 'HK.00700', deal_market: 'HK' })] });
    const [usDeal] = await makeAdapter(us.http).fetchDeals('us', WINDOW);
    const [hkDeal] = await makeAdapter(hk.http).fetchDeals('hk', WINDOW);
    expect(usDeal?.currency).toBe('USD');
    expect(hkDeal?.currency).toBe('HKD');
  });

  it('③ 期权 qty 原样 (张): 空头持仓保持负号, 成交数量不乘合约股数', async () => {
    const shim = makeShim({ '/trade/positions': [SHORT_PUT_POSITION], '/trade/deals': [deal()] });
    const adapter = makeAdapter(shim.http);
    const [position] = await adapter.fetchPositions('us');
    const [shortDeal] = await adapter.fetchDeals('us', WINDOW);
    expect(position?.qty.toString()).toBe('-2');
    expect(position?.marketValue?.toString()).toBe('-210');
    expect(position?.costPrice?.toString()).toBe('1.85');
    expect(position?.currentPrice?.toString()).toBe('1.05');
    expect(shortDeal?.qty.toString()).toBe('2');
    expect(shortDeal?.side).toBe('SELL_SHORT');
    expect(shortDeal?.dealId).toBe('1000000000000000001');
  });

  it('④ 组合单订单 ⇒ 解析出两个腿码, 更新时间毫秒保留', async () => {
    const shim = makeShim({ '/trade/orders': [COMBO_ORDER] });
    const [order] = await makeAdapter(shim.http).fetchOrders('us', WINDOW);
    expect(order?.comboLegCodes).toEqual(['US.PEP260918P120000', 'US.PEP260918P130000']);
    expect(order?.vendorUpdatedAt.toISOString()).toBe('2026-09-11T13:40:01.502Z');
    expect(order?.status).toBe('FILLED_ALL');
  });

  it('⑧ deal_id 为超过安全整数的 JSON number ⇒ 抛「缺可用的 deal_id」, 不收已丢精度的号', async () => {
    // shim 修复前的线上形态: JSON 里是 19 位整数字面量, JSON.parse 后已被舍入到另一个号
    const lossy = JSON.parse('1000000000000000001') as number;
    expect(String(lossy)).not.toBe('1000000000000000001');
    const shim = makeShim({ '/trade/deals': [deal({ deal_id: lossy })] });
    await expect(makeAdapter(shim.http).fetchDeals('us', WINDOW)).rejects.toThrow(
      '缺可用的 deal_id',
    );
  });

  it('⑨ 19 位数字串 ⇒ dealId / orderId 与输入逐位相等, 仅末位不同的两笔成交不撞号', async () => {
    const shim = makeShim({
      '/trade/deals': [
        deal(),
        deal({ deal_id: '1000000000000000002', order_id: '1000000000000000004' }),
      ],
      '/trade/orders': [COMBO_ORDER],
    });
    const adapter = makeAdapter(shim.http);
    const deals = await adapter.fetchDeals('us', WINDOW);
    expect(deals.map((d) => [d.dealId, d.orderId])).toEqual([
      ['1000000000000000001', '1000000000000000002'],
      ['1000000000000000002', '1000000000000000004'],
    ]);
    const [order] = await adapter.fetchOrders('us', WINDOW);
    expect(order?.orderId).toBe('1000000000000000003');
  });

  it('⑤ shim 409 ⇒ BrokerAccountSelectionError (数据类, 不可重试)', async () => {
    const shim = makeThrowingShim(new VendorHttpError('futu-shim:trade', 409));
    await expect(makeAdapter(shim.http).fetchPositions('us')).rejects.toBeInstanceOf(
      BrokerAccountSelectionError,
    );
  });

  it('⑥ 响应行即使含 acc_id 也不进入规范化结果 (含 raw)', async () => {
    const shim = makeShim({
      '/trade/positions': [SHORT_PUT_POSITION],
      '/trade/deals': [deal()],
      '/trade/orders': [COMBO_ORDER],
    });
    const adapter = makeAdapter(shim.http);
    const results = [
      await adapter.fetchPositions('us'),
      await adapter.fetchDeals('us', WINDOW),
      await adapter.fetchOrders('us', WINDOW),
    ];
    for (const rows of results) {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.raw).not.toHaveProperty('acc_id');
      expect(JSON.stringify(rows)).not.toContain(String(FAKE_ACC_ID));
    }
  });

  it('⑦ mock 绑定 ⇒ 任一方法调用即抛; live 绑定 ⇒ futu adapter', () => {
    const refused = createBrokerAccountPort({ kind: 'mock' });
    expect(() => refused.fetchPositions('us')).toThrow(MockCollectionRefusedError);
    expect(() => refused.fetchDeals('us', WINDOW)).toThrow(MockCollectionRefusedError);
    expect(() => refused.getAccountSummary()).toThrow(MockCollectionRefusedError);

    expect(createBrokerAccountPort(LIVE_CONFIG)).toBeInstanceOf(FutuBrokerAccountAdapter);
  });

  it('基础设施类失败 (5xx / 429 用尽 / 熔断) ⇒ BrokerInfrastructureError; 其余 4xx 原样上抛', async () => {
    for (const err of [
      new TransientVendorError('futu-shim:trade', 502),
      new TransientVendorError('futu-shim:trade', 429),
      new TransientVendorError('futu-shim:trade', 'network'),
      new BrokenCircuitError(),
    ]) {
      await expect(
        makeAdapter(makeThrowingShim(err).http).fetchDeals('us', WINDOW),
      ).rejects.toBeInstanceOf(BrokerInfrastructureError);
    }
    const badRequest = makeAdapter(
      makeThrowingShim(new VendorHttpError('futu-shim:trade', 400)).http,
    );
    await expect(badRequest.fetchOrders('us', WINDOW)).rejects.toBeInstanceOf(VendorHttpError);
  });

  it('账户概要只含 {trdmarketAuth, matched}', async () => {
    const shim = makeShim({ '/trade/accounts': [{ trdmarket_auth: ['HK', 'US'], matched: 1 }] });
    await expect(makeAdapter(shim.http).getAccountSummary()).resolves.toEqual({
      trdmarketAuth: ['HK', 'US'],
      matched: 1,
    });
  });

  it('fetchStockOwners ⇒ stock_owner 转 canonical; 未给归属 / 未返回 ⇒ null; 空入参零外呼', async () => {
    const shim = makeShim({
      '/option-snapshot': [
        { code: 'US.CMCS1261218C50000', option_valid: true, stock_owner: 'US.CMCSA' },
        { code: 'US.ZZZ260918C10000', option_valid: true, stock_owner: 'N/A' },
      ],
    });
    const adapter = makeAdapter(shim.http);
    const owners = await adapter.fetchStockOwners('us', [
      'US.CMCS1261218C50000',
      'US.ZZZ260918C10000',
      'US.GONE260918C10000',
    ]);
    expect(Object.fromEntries(owners)).toEqual({
      'US.CMCS1261218C50000': 'us:CMCSA',
      'US.ZZZ260918C10000': null,
      'US.GONE260918C10000': null,
    });
    const url = new URL(shim.request.mock.calls[0]?.[0].url ?? '');
    expect(url.searchParams.get('codes')).toBe(
      'US.CMCS1261218C50000,US.ZZZ260918C10000,US.GONE260918C10000',
    );

    shim.request.mockClear();
    expect((await adapter.fetchStockOwners('us', [])).size).toBe(0);
    expect(shim.request).not.toHaveBeenCalled();
  });
});
