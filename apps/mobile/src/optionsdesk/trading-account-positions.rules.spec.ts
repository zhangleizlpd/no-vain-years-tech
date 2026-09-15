// 083 T013 — 交易账户页 · 持仓分段的视图判定 / 行展示规则 / 独立文案段的纯逻辑单测。
// 渲染与交互（状态卡、组头折叠、下拉重读）走 Playwright e2e（T014–T016），不在这里。
//
// 🚨 对 `@nvy/api-client` 只 `import type`：mobile vitest 解析不到它的运行时入口，
//    import 生成的枚举常量对象会让整个 spec 0 用例却 exit 1。枚举值一律写字符串字面量。
// 📌 fixture 只用合成值（`ZQX` / `ZQY` / 港股 `088xx`、「示例汽车」）。
import type {
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionRowResponse,
} from '@nvy/api-client';
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  displayCode,
  expiryYymmdd,
  formatPlRatio,
  isDetailNotFound,
  localDateTimeParts,
  marketTzLabel,
  optionDisplayName,
  orderKind,
  orderStatusText,
  plColorClass,
  refetchFailed,
  resolveDetailView,
  resolvePositionsView,
  showConnectionLabel,
  showGroupHeader,
  showUnresolvedHint,
  tradeSideText,
  trimStrike,
} from './trading-account-positions.rules';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;

function row(overrides: Partial<BrokerPositionRowResponse> = {}): BrokerPositionRowResponse {
  return {
    id: '1',
    market: 'us',
    brokerCode: 'futu',
    connectionLabel: '示例连接',
    kind: 'stock',
    code: 'US.ZQY',
    name: 'ZQY 示例',
    option: null,
    qty: '100',
    marketValue: '12000',
    currentPrice: '120',
    averageCost: '110',
    unrealizedPl: '1000',
    unrealizedPlRatio: '9.09',
    currency: 'USD',
    openedAt: '2026-09-01T14:00:00.000Z',
    openedAtSource: 'derived',
    expired: false,
    ...overrides,
  };
}

function group(rowCount: number): BrokerPositionGroupResponse {
  return {
    underlyingTicker: 'us:ZQY',
    underlyingName: 'ZQY 示例',
    underlyingPrice: '120',
    groupMarketValue: '12000',
    groupUnrealizedPl: '1000',
    rows: Array.from({ length: rowCount }, (_, i) => row({ id: String(i + 1) })),
  };
}

function list(overrides: Partial<BrokerPositionListResponse> = {}): BrokerPositionListResponse {
  return {
    hasConnection: true,
    brokerCount: 1,
    syncedAt: '2026-09-08T18:05:12.000Z',
    syncedAtLocal: '2026-09-08 14:05:12',
    stale: false,
    unresolvedCount: 0,
    groups: [group(1)],
    ...overrides,
  };
}

describe('resolvePositionsView — 四种非列表状态 + 列表（FR-010）', () => {
  it('① 无连接 ⇒ no-connection', () => {
    const data = list({ hasConnection: false, brokerCount: 0, syncedAt: null, groups: [] });
    expect(resolvePositionsView({ hasData: true, isError: false, data })).toBe('no-connection');
  });

  it('② 有连接但从未成功同步 ⇒ never-synced', () => {
    const data = list({ syncedAt: null, syncedAtLocal: null, groups: [] });
    expect(resolvePositionsView({ hasData: true, isError: false, data })).toBe('never-synced');
  });

  it('③ 已同步、groups 为空 ⇒ empty，且未归类 2 条时提示仍显示', () => {
    const data = list({ groups: [], unresolvedCount: 2 });
    expect(resolvePositionsView({ hasData: true, isError: false, data })).toBe('empty');
    expect(showUnresolvedHint(data.unresolvedCount)).toBe(true);
  });

  it('④ 无已加载数据且请求失败 ⇒ error', () => {
    expect(resolvePositionsView({ hasData: false, isError: true })).toBe('error');
  });

  it('有数据、未失败 ⇒ list', () => {
    expect(resolvePositionsView({ hasData: true, isError: false, data: list() })).toBe('list');
  });
});

describe('重读失败保留数据（FR-023，analyze Q3）', () => {
  it('⑤ 🚨 已有数据且重读失败 ⇒ 视图仍为 list、refetchFailed 为真', () => {
    const data = list();
    expect(resolvePositionsView({ hasData: true, isError: true, data })).toBe('list');
    expect(refetchFailed({ hasData: true, isError: true })).toBe(true);
  });

  it('已有数据且重读失败时，非列表视图同样保持（空态不被错误卡替换）', () => {
    const data = list({ groups: [] });
    expect(resolvePositionsView({ hasData: true, isError: true, data })).toBe('empty');
  });

  it('refetchFailed：无数据的失败不算刷新失败；有数据且成功也不算', () => {
    expect(refetchFailed({ hasData: false, isError: true })).toBe(false);
    expect(refetchFailed({ hasData: true, isError: false })).toBe(false);
  });
});

describe('行与组的显隐（FR-004 / FR-011 / FR-012）', () => {
  it('⑥ 未归类 0 / 2 ⇒ 提示不显示 / 显示', () => {
    expect(showUnresolvedHint(0)).toBe(false);
    expect(showUnresolvedHint(2)).toBe(true);
  });

  it('⑦ 1 行组无组头、2 行组起有组头、3 行组有组头', () => {
    expect(showGroupHeader(group(1))).toBe(false);
    expect(showGroupHeader(group(2))).toBe(true);
    expect(showGroupHeader(group(3))).toBe(true);
  });

  it('⑧ brokerCount 1 / 2 ⇒ 不显示 / 显示连接标签', () => {
    expect(showConnectionLabel(1)).toBe(false);
    expect(showConnectionLabel(2)).toBe(true);
  });
});

describe('期权名称 / 到期日 / 行权价（FR-007）', () => {
  it('⑨ 港股沽 ⇒「示例汽车 沽」、美股 Call ⇒「ZQY 示例 Call」', () => {
    expect(optionDisplayName({ market: 'hk', underlyingName: '示例汽车', right: 'P' })).toBe(
      '示例汽车 沽',
    );
    expect(optionDisplayName({ market: 'us', underlyingName: 'ZQY 示例', right: 'C' })).toBe(
      'ZQY 示例 Call',
    );
    expect(optionDisplayName({ market: 'hk', underlyingName: '示例汽车', right: 'C' })).toBe(
      '示例汽车 购',
    );
    expect(optionDisplayName({ market: 'us', underlyingName: 'ZQY 示例', right: 'P' })).toBe(
      'ZQY 示例 Put',
    );
  });

  it('⑩ 到期日 6 位；行权价去尾零（无小数点的整数不动）', () => {
    expect(expiryYymmdd('2026-09-29')).toBe('260929');
    expect(trimStrike('12.500')).toBe('12.5');
    expect(trimStrike('300.000')).toBe('300');
    expect(trimStrike('7.25')).toBe('7.25');
    expect(trimStrike('300')).toBe('300');
  });

  it('到期日形态不合法 ⇒ 原样返回（不吞信息）', () => {
    expect(expiryYymmdd('20260929')).toBe('20260929');
  });
});

describe('交易所当地时间串（只重排，不换算时区；FR-017）', () => {
  it('⑪ 时间串拆分与时区标签', () => {
    expect(localDateTimeParts('2026-09-08 14:05:12')).toEqual({
      ymd: '2026/09/08',
      hms: '14:05:12',
      mdHm: '09-08 14:05',
    });
    expect(marketTzLabel('us')).toBe('（美东）');
    expect(marketTzLabel('hk')).toBe('（香港）');
  });

  it('形态不合法 ⇒ null（调用方不渲染，🚫 猜）', () => {
    expect(localDateTimeParts('2026-09-08T14:05:12Z')).toBeNull();
    expect(localDateTimeParts('')).toBeNull();
  });
});

describe('tradingAccountPositions 文案段（plan D17）', () => {
  it('四种非列表状态 title 逐字（FR-010）', () => {
    expect(COPY.states['no-connection']).toBe('暂无交易账户');
    expect(COPY.states['never-synced']).toBe('尚未同步');
    expect(COPY.states.empty).toBe('暂无持仓');
    expect(COPY.states.error).toBe('持仓加载失败');
    expect(COPY.retry).toBe('重试');
  });

  it('陈旧提示为中性措辞、刷新失败 / 未归类 / 已到期逐字', () => {
    expect(COPY.stale('09-08 14:05（美东）')).toBe(
      '数据可能已过时 · 最近成功同步于 09-08 14:05（美东）',
    );
    expect(COPY.stale('x')).not.toMatch(/失败|未成功/);
    expect(COPY.refetchFailed).toBe('刷新失败，显示的是上次加载的数据');
    expect(COPY.unresolved(2)).toBe('未归类 2 条');
    expect(COPY.expired).toBe('已到期 · 待同步');
    expect(COPY.syncedAt('09-08 14:05（美东）')).toBe('同步于 09-08 14:05（美东）');
  });
});

// ── T017：详情屏视图（持仓 / 订单共用） ───────────────────────────────────────

describe('isDetailNotFound / resolveDetailView（FR-020 / FR-023）', () => {
  const axios404 = {
    isAxiosError: true,
    response: { status: 404, data: { status: 404, detail: 'BROKER_POSITION_NOT_FOUND' } },
  };
  const axios500 = { isAxiosError: true, response: { status: 500 } };

  it('HTTP 404 的 axios 错误 ⇒ 不存在；500 / 非 axios 错误 / null ⇒ 否', () => {
    expect(isDetailNotFound(axios404)).toBe(true);
    expect(isDetailNotFound(axios500)).toBe(false);
    expect(isDetailNotFound(new Error('network'))).toBe(false);
    expect(isDetailNotFound(null)).toBe(false);
  });

  it('🚨 已有数据且重读 404 ⇒ not-found（优先于已显示的旧数据）', () => {
    expect(
      resolveDetailView({ isPending: false, hasData: true, isError: true, notFound: true }),
    ).toBe('not-found');
  });

  it('🚨 已有数据且重读 500 ⇒ 仍 ready（顶部提示另由 refetchFailed 出，🚫 错误卡）', () => {
    expect(
      resolveDetailView({ isPending: false, hasData: true, isError: true, notFound: false }),
    ).toBe('ready');
  });

  it('无数据：首次加载中 ⇒ loading；失败 ⇒ error；首次即 404 ⇒ not-found', () => {
    expect(
      resolveDetailView({ isPending: true, hasData: false, isError: false, notFound: false }),
    ).toBe('loading');
    expect(
      resolveDetailView({ isPending: false, hasData: false, isError: true, notFound: false }),
    ).toBe('error');
    expect(
      resolveDetailView({ isPending: false, hasData: false, isError: true, notFound: true }),
    ).toBe('not-found');
  });
});

// ── T015：主列表行展示 ─────────────────────────────────────────────────────────

describe('plColorClass（持仓盈亏涨跌色，plan D14）', () => {
  it('正 ⇒ up、负 ⇒ down、0 ⇒ flat', () => {
    expect(plColorClass('420.00')).toBe('text-quote-up');
    expect(plColorClass('-50')).toBe('text-quote-down');
    expect(plColorClass('0')).toBe('text-quote-flat');
    expect(plColorClass('0.00')).toBe('text-quote-flat');
  });

  it('null / 非法 ⇒ 中性灰（不猜方向）', () => {
    expect(plColorClass(null)).toBe('text-ink-subtle');
    expect(plColorClass('N/A')).toBe('text-ink-subtle');
  });
});

describe('formatPlRatio（持仓盈亏比例，不缩写）', () => {
  it('响应值即百分数：带符号两位小数 + %', () => {
    expect(formatPlRatio('4.56')).toBe('+4.56%');
    expect(formatPlRatio('-20.833')).toBe('-20.83%');
    expect(formatPlRatio('40')).toBe('+40.00%');
    expect(formatPlRatio('0')).toBe('0.00%');
  });

  it('null / 非法 ⇒ --', () => {
    expect(formatPlRatio(null)).toBe('--');
    expect(formatPlRatio('abc')).toBe('--');
  });
});

describe('displayCode（正股行第二行代码）', () => {
  it('去掉券商市场前缀', () => {
    expect(displayCode('US.ZQY')).toBe('ZQY');
    expect(displayCode('HK.08801')).toBe('08801');
  });

  it('无前缀 ⇒ 原样', () => {
    expect(displayCode('ZQY')).toBe('ZQY');
  });
});

// ── T018：订单枚举文案（plan D11，Guardrail 16） ────────────────────────────────

/**
 * SDK 值域逐字再列一遍（futu `constant.py` `OrderStatus` / `TrdSide`），与 rules 里的 union 类型相互独立 ——
 * 类型漏值编译红只防「文案表比类型少」，这张表防「类型本身就漏了值」。
 */
const SDK_ORDER_STATUSES = [
  'N/A',
  'UNSUBMITTED',
  'WAITING_SUBMIT',
  'SUBMITTING',
  'SUBMIT_FAILED',
  'TIMEOUT',
  'SUBMITTED',
  'FILLED_PART',
  'FILLED_ALL',
  'CANCELLING_PART',
  'CANCELLING_ALL',
  'CANCELLED_PART',
  'CANCELLED_ALL',
  'FAILED',
  'DISABLED',
  'DELETED',
  'FILL_CANCELLED',
];
const SDK_TRADE_SIDES = ['N/A', 'BUY', 'SELL', 'SELL_SHORT', 'BUY_BACK'];

describe('订单状态 / 交易方向 / 订单类型文案（FR-017，plan D11）', () => {
  it('① 状态 17 值、方向 5 值全部有非空中文文案，且文案表恰为 SDK 值域', () => {
    expect(SDK_ORDER_STATUSES).toHaveLength(17);
    expect(SDK_TRADE_SIDES).toHaveLength(5);
    for (const status of SDK_ORDER_STATUSES) {
      expect(orderStatusText(status), status).not.toBe('');
      expect(orderStatusText(status), status).not.toBe(status);
    }
    for (const side of SDK_TRADE_SIDES) {
      expect(tradeSideText(side), side).not.toBe('');
      expect(tradeSideText(side), side).not.toBe(side);
    }
    expect(Object.keys(COPY.orderStatusLabel).sort()).toEqual([...SDK_ORDER_STATUSES].sort());
    expect(Object.keys(COPY.tradeSideLabel).sort()).toEqual([...SDK_TRADE_SIDES].sort());
  });

  it('维护者 App 截图定死的两条：SELL_SHORT → 卖空、FILLED_ALL → 全部成交', () => {
    expect(tradeSideText('SELL_SHORT')).toBe('卖空');
    expect(orderStatusText('FILLED_ALL')).toBe('全部成交');
  });

  it('值域外的值原样返回枚举名（含原型链上的键名），🚫 编文案', () => {
    expect(orderStatusText('SOME_NEW_STATUS')).toBe('SOME_NEW_STATUS');
    expect(tradeSideText('SOME_NEW_SIDE')).toBe('SOME_NEW_SIDE');
    expect(orderStatusText('toString')).toBe('toString');
  });

  it("② orderTypeLabel 只映射 NORMAL：('NORMAL') ⇒ 限价单、('MARKET') ⇒ MARKET", () => {
    expect(COPY.orderTypeLabel('NORMAL')).toBe('限价单');
    expect(COPY.orderTypeLabel('MARKET')).toBe('MARKET');
  });

  it('orderKind：期权 / 组合单 ⇒ option（张），正股 ⇒ stock（股）', () => {
    const option = { expiry: '2026-10-16', right: 'C', strike: '55.000' };
    expect(orderKind({ option, comboLegCodes: [] })).toBe('option');
    expect(orderKind({ option: null, comboLegCodes: ['US.ZQY261016C55000'] })).toBe('option');
    expect(orderKind({ option: null, comboLegCodes: [] })).toBe('stock');
  });
});
