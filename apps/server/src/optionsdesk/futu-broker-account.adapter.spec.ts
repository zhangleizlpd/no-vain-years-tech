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
 * 成交号用 19 位明显假号的**数字串** (2026-09-14 amend): 即修复后 shim 的输出形态。
 * EVIDENCE: 真号超安全整数 —— 082 POC-1 (2026-09-13 维护者采集的原始输出) 全部成交行的 `deal_id` 均为
 * 17–19 位整数且 > 2^53−1; 2026-09-14 prod 首次回填因 shim 仍输出 JSON number 而报「缺可用的 deal_id」。
 * 旧 fixture 的 7 位小号覆盖不到这个尺寸, 故 T012 未发现。
 *
 * 订单号 (订单行与成交行上的 `order_id`) 用 18 位「大写字母 + 数字」、首字符为字母的明显假号
 * (`FAKE…`, 2026-09-14 二次 amend)。EVIDENCE: 2026-09-14 prod 第二次回填报「缺可用的 order_id」;
 * 形态计数见 adapter `orderIdOrNull` 注释。旧 fixture 的纯数字订单号与真形态不符, 故 T012 与首次 amend 均未发现。
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
 *   2026-09-14 二次 amend 补 ⑩ ⑪ ⑫ ⑬ 后 (共 18 条; e / f 时的 `idOrNull` 已拆为 `dealIdOrNull` + `orderIdOrNull`):
 *   先红: 旧实现上跑 → 5 failed | 13 passed —— ④ ⑥ ⑨ ⑩ ⑪ 红; ⑫ ⑬ 绿 (守的是修复前后都该成立的行为)
 *   g. `ORDER_ID_RE` 改回纯数字 `/^\d+$/`               → 5 failed | 13 passed —— ④ ⑥ ⑨ ⑩ ⑪ 红
 *   h. `ORDER_ID_RE` 去掉 64 上限 (`{1,64}` → `+`)      → 1 failed | 17 passed —— 只有 ⑫ 的 65 字符臂红
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
  code: 'US.ZQY260918P130000',
  stock_name: 'ZQY 260918 130.00P',
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
    code: 'US.ZQY260918P130000',
    stock_name: 'ZQY 260918 130.00P',
    deal_market: 'US',
    deal_id: '1000000000000000001',
    order_id: 'FAKE00000000000002',
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
  code: 'US.ZQY-COMBO',
  stock_name: 'ZQY combo',
  order_market: 'US',
  trd_side: 'SELL',
  order_type: 'NORMAL',
  order_status: 'FILLED_ALL',
  order_id: 'FAKE00000000000003',
  qty: 1.0,
  price: 0.95,
  create_time: '2026-09-11 09:40:00.120',
  updated_time: '2026-09-11 09:40:01.502',
  dealt_qty: 1.0,
  dealt_avg_price: 0.95,
  currency: 'USD',
  combo_legs: [
    'ComboLeg(code=US.ZQY260918P120000, trd_side=BUY, qty_ratio=1.0, position_id=N/A)',
    'ComboLeg(code=US.ZQY260918P130000, trd_side=SELL, qty_ratio=1.0, position_id=N/A)',
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
    expect(order?.comboLegCodes).toEqual(['US.ZQY260918P120000', 'US.ZQY260918P130000']);
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

  it('⑨ 19 位数字成交号 ⇒ dealId 与输入逐位相等, 仅末位不同的两笔成交不撞号', async () => {
    const shim = makeShim({
      '/trade/deals': [
        deal(),
        deal({ deal_id: '1000000000000000002', order_id: 'FAKE00000000000004' }),
      ],
    });
    const deals = await makeAdapter(shim.http).fetchDeals('us', WINDOW);
    expect(deals.map((d) => [d.dealId, d.orderId])).toEqual([
      ['1000000000000000001', 'FAKE00000000000002'],
      ['1000000000000000002', 'FAKE00000000000004'],
    ]);
  });

  it('⑩ 订单行 18 位字母数字订单号 ⇒ 接受, orderId 与输入逐字相等', async () => {
    const shim = makeShim({ '/trade/orders': [COMBO_ORDER] });
    const [order] = await makeAdapter(shim.http).fetchOrders('us', WINDOW);
    expect(order?.orderId).toBe('FAKE00000000000003');
  });

  it('⑪ 成交行上的字母数字 order_id ⇒ 保留 (不再静默置 null, 成交 ↔ 订单关联不丢)', async () => {
    const shim = makeShim({ '/trade/deals': [deal({ order_id: 'FAKE00000000000005' })] });
    const [row] = await makeAdapter(shim.http).fetchDeals('us', WINDOW);
    expect(row?.orderId).toBe('FAKE00000000000005');
  });

  it.each(['FAKE-0001', 'FAKE 0001', 'A'.repeat(65)])(
    '⑫ 订单号 %j 含标点 / 空白 / 超 64 字符 ⇒ 订单行抛「缺可用的 order_id」, 成交行上为 null',
    async (bad) => {
      const orders = makeShim({ '/trade/orders': [{ ...COMBO_ORDER, order_id: bad }] });
      await expect(makeAdapter(orders.http).fetchOrders('us', WINDOW)).rejects.toThrow(
        '缺可用的 order_id',
      );
      const deals = makeShim({ '/trade/deals': [deal({ order_id: bad })] });
      const [row] = await makeAdapter(deals.http).fetchDeals('us', WINDOW);
      expect(row).toBeDefined();
      expect(row?.orderId).toBeNull();
    },
  );

  it('⑬ 成交号仍只收数字: 字母数字 deal_id ⇒ 抛「缺可用的 deal_id」', async () => {
    const shim = makeShim({ '/trade/deals': [deal({ deal_id: 'FAKE00000000000009' })] });
    await expect(makeAdapter(shim.http).fetchDeals('us', WINDOW)).rejects.toThrow(
      '缺可用的 deal_id',
    );
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

/**
 * 084 T005 推送事件行规范化 (plan D2; FR-006 / FR-015 / FR-020 / FR-021)。
 *
 * 仿真行的**键集照 futu SDK 源码**的推送列表 (`futu/trade/trade_response_handler.py`:
 * `TradeOrderHandlerBase` 的 `col_list` / `TradeDealHandlerBase` 的 `col_list`, futu-shim venv):
 * 订单推送带 `currency` / `updated_time` / `combo_legs`, 成交推送三者皆无 —— **两类字段集不同**,
 * 故分别映射、靠 `event_type` 分流 (branch 13)。`seq` / `event_type` 由 shim 的事件缓冲盖上。
 *
 * 🚨 反例臂的形状决定这组测试有没有用 (plan「本片额外的反例臂」):
 *   - **腿必须喂结构化对象数组**。喂文本数组的话, 走 `parseComboLegs` 的错误实现同样绿 ——
 *     它对对象元素做 `filter(typeof === 'string')`, 静默返回 `[]` (`broker-code.rules.ts:99-107`)。
 *   - **成交号必须喂超出安全整数范围的尺寸**。小整数下「转串」与「原样透传」两种实现都绿。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1; 2026-09-16 实跑, 还原后 `cmp` 与备份逐字节相同):
 *   a. 市场改读 `order_market` (`eventMarket` 里 `r.trd_market` → `r.order_market`)
 *      → 9 failed | 19 passed —— ① 在其中。⚠️ **不是只有 ① 红**: 市场是每条事件臂的共同前置,
 *      而真实推送行**不带** `order_market` ⇒ `eventMarket` 当场 throw, 整组事件臂一起红。这是
 *      真实夹具形状下的必然结果, 不是断言不精确 —— 要做到「只红一条」得往夹具里塞一个券商根本
 *      不发的诱饵列, 那种精确是演出来的。
 *   b. 空腿改为正常返回 (`legsPending` 恒 `false`)
 *      → 1 failed | 27 passed —— 只有 ④ 红; ④b 仍绿 (它守的正是反方向: 普通单腿单不该被标)。
 *   复跑: pnpm nx test server src/optionsdesk/futu-broker-account.adapter.spec.ts --skip-nx-cache
 */
describe('FutuBrokerAccountAdapter — 推送事件行规范化 (084 T005)', () => {
  /**
   * 19 位合成成交号。沿用本文件既有夹具的形态 (同文件 `deal()` 的 `deal_id`)。
   * 它 > 2^53−1 这一点由用例内断言现场证明, 不靠肉眼数位数。
   */
  const HUGE_DEAL_ID = '1000000000000000001';

  /** 订单推送行 (列集照 SDK `TradeOrderHandlerBase.col_list`)。默认是一张**组合单**。 */
  function orderEvent(extra: Record<string, unknown> = {}) {
    return {
      event_type: 'order',
      seq: 11,
      trd_env: 'REAL',
      code: 'US.ZQY-COMBO',
      stock_name: 'ZQY combo',
      // 🚨 推送的市场列是 `trd_market`; 历史订单查询是 `order_market` (FR-015 / branch 13)。
      trd_market: 'US',
      trd_side: 'SELL',
      order_type: 'NORMAL',
      order_status: 'SUBMITTED',
      order_id: 'FAKE00000000000003',
      qty: 1.0,
      price: 0.95,
      dealt_qty: 0.0,
      dealt_avg_price: 0.0,
      create_time: '2026-09-11 09:40:00.120',
      updated_time: '2026-09-11 09:40:01.502',
      currency: 'USD',
      // 🚨 结构化**对象**数组 —— shim 已从 `ComboLeg` 展开 (FR-020), 不是文本。
      combo_legs: [
        { code: 'US.ZQY260918P120000', trd_side: 'BUY', qty_ratio: 1.0, position_id: null },
        { code: 'US.ZQY260918P130000', trd_side: 'SELL', qty_ratio: 1.0, position_id: null },
      ],
      ...extra,
    };
  }

  /** 成交推送行 (列集照 SDK `TradeDealHandlerBase.col_list`: 无 `currency`、无 `combo_legs`)。 */
  function dealEvent(extra: Record<string, unknown> = {}) {
    return {
      event_type: 'deal',
      seq: 12,
      trd_env: 'REAL',
      code: 'US.ZQY260918P130000',
      stock_name: 'ZQY 260918 130.00P',
      trd_market: 'US',
      deal_id: HUGE_DEAL_ID,
      order_id: 'FAKE00000000000002',
      qty: 2.0,
      price: 1.85,
      trd_side: 'SELL_SHORT',
      create_time: '2026-09-11 09:31:08.950',
      counter_broker_id: 'N/A',
      counter_broker_name: 'N/A',
      status: 'OK',
      ...extra,
    };
  }

  /**
   * 事件源报出的「最近一次事件到达时刻」(084 FR-014)。⚠️ 它是**事件到达**时刻, 与信封的
   * `as_of` (响应时刻) 不是一回事 —— 夹具里刻意取两个不同的值, 免得取错字段也能绿。
   */
  const LAST_EVENT_AT_ISO = '2026-09-11T13:59:58.250000+00:00';

  /**
   * `/trade/events` 的信封比 rows 型端点多 `epoch` / `next_seq` / `dropped` / `last_event_at`
   * 四个字段。🚨 **四个都得在**: adapter 对其中任一缺失都 throw, 少一个就是整批事件拿不到。
   */
  function makeEventsShim(rows: unknown[], extra: Record<string, unknown> = {}) {
    // 返回型刻意标成松的 `Record<string, unknown>`: 下面「缺字段 ⇒ 抛」那条臂要喂一个**故意
    // 少一个键**的信封, 而由实现推断出的字面量类型会让它在 typecheck 期就被拒 (那条臂就写不出来)。
    const request = vi.fn(
      async (_req: VendorRequest): Promise<Record<string, unknown>> => ({
        as_of: '2026-09-11T14:00:00+00:00',
        count: rows.length,
        rows,
        epoch: 'aaaa0000epoch',
        next_seq: 12,
        dropped: false,
        last_event_at: LAST_EVENT_AT_ISO,
        ...extra,
      }),
    );
    return { http: { request } as unknown as VendorHttpClient, request };
  }

  it('① 订单事件 ⇒ 规范化出订单字段, 市场取自 `trd_market` (branch 13)', async () => {
    const shim = makeEventsShim([orderEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [event] = batch.rows;
    expect(event?.kind).toBe('order');
    if (event?.kind !== 'order') throw new Error('分流错: 订单事件应归 order');
    expect(event.order.market).toBe('us');
    expect(event.order.orderId).toBe('FAKE00000000000003');
    expect(event.order.status).toBe('SUBMITTED');
    expect(event.order.qty.toString()).toBe('1');
    expect(event.order.currency).toBe('USD');
    expect(event.seq).toBe(11);
  });

  it('② 成交事件 ⇒ 成交字段, `dealId` 逐位不变且长度不变 (branch 16 / FR-021)', async () => {
    // 🚨 先证明这个号确实超出安全整数: 否则「转串」与「原样透传」两种实现都绿, 本臂白写。
    expect(Number(HUGE_DEAL_ID)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(String(Number(HUGE_DEAL_ID))).not.toBe(HUGE_DEAL_ID);

    const shim = makeEventsShim([dealEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [event] = batch.rows;
    if (event?.kind !== 'deal') throw new Error('分流错: 成交事件应归 deal');
    expect(event.deal.dealId).toBe(HUGE_DEAL_ID);
    expect(event.deal.dealId).toHaveLength(HUGE_DEAL_ID.length);
    expect(event.deal.market).toBe('us');
    expect(event.deal.side).toBe('SELL_SHORT');
    // 成交推送无 currency 列 ⇒ 按市场补 (与订单事件字段集不同的直接证据)。
    expect(event.deal.currency).toBe('USD');
  });

  it('③ 腿为结构化数组 ⇒ 解出各腿代码与方向 (branch 14 / FR-020)', async () => {
    const shim = makeEventsShim([orderEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [event] = batch.rows;
    if (event?.kind !== 'order') throw new Error('分流错');
    expect(event.order.comboLegs).toEqual([
      { code: 'US.ZQY260918P120000', side: 'BUY' },
      { code: 'US.ZQY260918P130000', side: 'SELL' },
    ]);
    expect(event.order.comboLegCodes).toEqual(['US.ZQY260918P120000', 'US.ZQY260918P130000']);
    expect(event.order.legsPending).toBe(false);
  });

  it('④ 组合单腿为空 ⇒ 标记待回查, 🚫 当作「无腿」正常返回 (branch 15 / FR-020)', async () => {
    const shim = makeEventsShim([orderEvent({ combo_legs: [] })]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [event] = batch.rows;
    if (event?.kind !== 'order') throw new Error('分流错');
    expect(event.order.legsPending).toBe(true);
    expect(event.order.comboLegs).toEqual([]);
  });

  it('④b 普通单腿单腿列表本来就空 ⇒ **不**标待回查 (否则每一单都触发回查)', async () => {
    const shim = makeEventsShim([orderEvent({ code: 'US.ZQY260918P130000', combo_legs: [] })]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [event] = batch.rows;
    if (event?.kind !== 'order') throw new Error('分流错');
    expect(event.order.legsPending).toBe(false);
  });

  it('⑤ 事件行含 acc_id ⇒ 不进入规范化结果 (含 raw) (FR-019)', async () => {
    const shim = makeEventsShim([
      orderEvent({ acc_id: FAKE_ACC_ID }),
      dealEvent({ acc_id: FAKE_ACC_ID }),
    ]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    expect(batch.rows).toHaveLength(2);
    expect(JSON.stringify(batch)).not.toContain(String(FAKE_ACC_ID));
    for (const event of batch.rows) {
      const raw = event.kind === 'order' ? event.order.raw : event.deal.raw;
      expect(raw).not.toHaveProperty('acc_id');
    }
  });

  it('⑥ 事件时间带毫秒 ⇒ 按市场交易所时区解析且毫秒保留', async () => {
    const shim = makeEventsShim([orderEvent(), dealEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    const [order, deal] = batch.rows;
    if (order?.kind !== 'order' || deal?.kind !== 'deal') throw new Error('分流错');
    // 2026-09-11 美东夏令时 UTC-4
    expect(order.order.vendorUpdatedAt.toISOString()).toBe('2026-09-11T13:40:01.502Z');
    expect(order.order.vendorCreatedAt?.toISOString()).toBe('2026-09-11T13:40:00.120Z');
    expect(deal.deal.tradedAt.toISOString()).toBe('2026-09-11T13:31:08.950Z');

    const hk = makeEventsShim([
      dealEvent({ code: 'HK.00700', trd_market: 'HK', create_time: '2026-09-11 10:05:00.007' }),
    ]);
    const [hkEvent] = (await makeAdapter(hk.http).fetchEvents(null)).rows;
    if (hkEvent?.kind !== 'deal') throw new Error('分流错');
    // 香港 UTC+8
    expect(hkEvent.deal.tradedAt.toISOString()).toBe('2026-09-11T02:05:00.007Z');
    expect(hkEvent.deal.currency).toBe('HKD');
  });

  it('两类事件靠 `event_type` 分流, 不靠字段集猜; 未知取值 ⇒ 抛', async () => {
    const shim = makeEventsShim([orderEvent(), dealEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    expect(batch.rows.map((e) => e.kind)).toEqual(['order', 'deal']);

    const bad = makeEventsShim([orderEvent({ event_type: 'position' })]);
    await expect(makeAdapter(bad.http).fetchEvents(null)).rejects.toThrow('event_type');
  });

  it('信封的 epoch / next_seq / dropped 原样带出 (游标判定的入参)', async () => {
    const shim = makeEventsShim([dealEvent()], {
      epoch: 'bbbb1111epoch',
      next_seq: 42,
      dropped: true,
    });
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    expect(batch.epoch).toBe('bbbb1111epoch');
    expect(batch.nextSeq).toBe(42);
    expect(batch.dropped).toBe(true);
  });

  it('信封的 last_event_at: 有值 ⇒ Date、null ⇒ null、缺字段 ⇒ 抛 (FR-014)', async () => {
    const shim = makeEventsShim([dealEvent()]);
    const batch = await makeAdapter(shim.http).fetchEvents(null);
    // 🚨 取的是事件**到达**时刻, 不是信封的 `as_of` (那是响应时刻, 14:00:00)。
    expect(batch.lastEventAt?.toISOString()).toBe('2026-09-11T13:59:58.250Z');

    // 事件源从没收到过推送 ⇒ null。
    const never = makeEventsShim([], { last_event_at: null });
    expect((await makeAdapter(never.http).fetchEvents(null)).lastEventAt).toBeNull();

    // 🚨 缺字段 MUST 抛, 🚫 按 null 兜底 —— null 的含义是「从没收到过推送」(通道可能已死),
    // 而缺失只说明 shim 是旧版本; 混为一谈会让一条健在的通道显示为长期静默 (D8)。
    const stale = makeEventsShim([]);
    stale.request.mockResolvedValueOnce({
      as_of: '2026-09-11T14:00:00+00:00',
      count: 0,
      rows: [],
      epoch: 'aaaa0000epoch',
      next_seq: 12,
      dropped: false,
    });
    await expect(makeAdapter(stale.http).fetchEvents(null)).rejects.toThrow('last_event_at');
  });

  it('游标入参 ⇒ epoch / after_seq 进 query; 首次消费 (null) ⇒ 不带参数', async () => {
    const withCursor = makeEventsShim([]);
    await makeAdapter(withCursor.http).fetchEvents({ epoch: 'aaaa0000epoch', afterSeq: 7 });
    const url = new URL(withCursor.request.mock.calls[0]?.[0].url ?? '');
    expect(url.pathname).toBe('/trade/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      epoch: 'aaaa0000epoch',
      after_seq: '7',
    });

    const first = makeEventsShim([]);
    await makeAdapter(first.http).fetchEvents(null);
    expect(new URL(first.request.mock.calls[0]?.[0].url ?? '').search).toBe('');
  });
});
