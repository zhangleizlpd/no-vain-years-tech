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
  expiryYymmdd,
  localDateTimeParts,
  marketTzLabel,
  optionDisplayName,
  refetchFailed,
  resolvePositionsView,
  showConnectionLabel,
  showGroupHeader,
  showUnresolvedHint,
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
