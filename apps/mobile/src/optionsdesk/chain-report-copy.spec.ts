// 055 T010 — 报表页头合成层单测（`FR-031` / `FR-033`, `state_branch` 18/21, plan `D-UI-1`）。
//
// 🚨 本文件验的是**合成层**，不是 046 的 `ivReadoutView`（那份自己有单测）：
//    页头这一层最容易犯的两件事都在合成时发生 —— 把三个时点合成一句、以及在
//    「拿不到分位」时兜一个 0 进去。两者都渲染得出一个像模像样的页头。
import { describe, expect, it } from 'vitest';
import type {
  ChainReportResponse,
  UnderlyingIvReadoutResponse,
  UnderlyingIvReadoutResponseState,
} from '@nvy/api-client';

import { chainReportHeaderView, chainReportTitle } from './chain-report-copy';

const IV_AVAILABLE: UnderlyingIvReadoutResponse = {
  state: 'available',
  aggregateIv: '31.2',
  ivPercentile: '58.4',
  asOf: '2026-08-11',
  freshnessTier: 'CURRENT',
};

function report(overrides: Partial<ChainReportResponse> = {}): ChainReportResponse {
  return {
    symbol: 'us:ACN',
    state: 'available',
    spot: '179.820000',
    marketDate: '2026-08-14',
    asOf: '2026-08-11',
    quoteAsOf: '2026-08-11T20:05:00.000Z',
    oiAsOf: '2026-08-08',
    source: 'eod',
    iv: IV_AVAILABLE,
    anchorExcluded: false,
    gateCounts: {
      total: 825,
      removedByPremium: 252,
      skeleton: 573,
      outsideRowFloor: 261,
      withinRows: 312,
      blockedByLiveness: 38,
      valued: 274,
    },
    rows: [],
    columns: [],
    cells: { buildQuality: [], rentAnnualized: [], allAnnualized: [], activity: [] },
    ...overrides,
  };
}

const DEGRADED_STATES: Exclude<UnderlyingIvReadoutResponseState, 'available'>[] = [
  'percentile_unavailable',
  'missing',
  'read_failed',
];

describe('chain-report-copy · 页头合成', () => {
  describe('题头', () => {
    it('canonical `market:code` 只取 code 那一半', () => {
      expect(chainReportTitle('us:ACN')).toBe('ACN · 链分析');
    });

    it('解析不出 market 前缀时原样回退，🚫 不丢标的身份', () => {
      expect(chainReportTitle('ACN')).toBe('ACN · 链分析');
    });
  });

  describe('IV 分位四态（FR-031 / state_branch 18）', () => {
    it('齐备态给数值 + 分段条标记位', () => {
      const { iv } = chainReportHeaderView(report());
      expect(iv.state).toBe('available');
      expect(iv.ivPercentile).toBe(58.4);
      expect(iv.ivpText).toBe('58');
      expect(iv.degradedText).toBeNull();
      expect(iv.showMarker).toBe(true);
    });

    it.each(DEGRADED_STATES)('%s 态照常渲染这一块，只是没有数值', (state) => {
      const { iv } = chainReportHeaderView(
        report({ iv: { ...IV_AVAILABLE, state, ivPercentile: null } }),
      );
      expect(iv.state).toBe(state);
      expect(iv.degradedText).toBeTruthy();
      expect(iv.showMarker).toBe(false);
    });

    it('三句降级文案各自成句、互不复用', () => {
      const texts = DEGRADED_STATES.map(
        (state) =>
          chainReportHeaderView(report({ iv: { ...IV_AVAILABLE, state, ivPercentile: null } })).iv
            .degradedText,
      );
      expect(new Set(texts).size).toBe(DEGRADED_STATES.length);
    });

    // 🚨 state_branch 18 的那半条 ——「禁回落 0」。兜 0 会把「不知道」渲成「极度平静」，
    // 而分段条照样画得出一个位置标记。
    it.each(DEGRADED_STATES)('🚨 %s 态 MUST NOT 回落 0', (state) => {
      const { iv } = chainReportHeaderView(
        report({ iv: { ...IV_AVAILABLE, state, ivPercentile: null } }),
      );
      expect(iv.ivPercentile).toBeNull();
      expect(iv.ivpText).toBeNull();
    });

    it('齐备态但分位串解析不出 ⇒ 退「分位不可算」而非 NaN / 0', () => {
      const { iv } = chainReportHeaderView(
        report({ iv: { ...IV_AVAILABLE, ivPercentile: 'n/a' } }),
      );
      expect(iv.state).toBe('percentile_unavailable');
      expect(iv.ivPercentile).toBeNull();
    });
  });

  describe('三个业务日时点（FR-033）', () => {
    it('恒三条、各自成句、标签互异', () => {
      const { stamps } = chainReportHeaderView(report());
      expect(stamps).toHaveLength(3);
      expect(new Set(stamps.map((s) => s.key)).size).toBe(3);
      expect(new Set(stamps.map((s) => s.label)).size).toBe(3);
      expect(stamps.map((s) => s.value)).toEqual(['08-14', '08-11 收盘', '08-08']);
    });

    // 🚨 三者同日是**常见巧合**，不是合并的理由 —— 合并过一次，等它们再次分开时
    // 「活跃度是哪天的」就再也说不清了（美股期权 OI 盘前更新，常态不同日）。
    it('🚨 三个时点同日时仍是三条，🚫 不去重、不合并', () => {
      const same = report({ marketDate: '2026-08-11', asOf: '2026-08-11', oiAsOf: '2026-08-11' });
      const { stamps } = chainReportHeaderView(same);
      expect(stamps).toHaveLength(3);
      expect(stamps.map((s) => s.value)).toEqual(['08-11', '08-11 收盘', '08-11']);
    });

    it('时点缺失 ⇒ 该条显式「—」，🚫 不静默少一条', () => {
      const { stamps } = chainReportHeaderView(report({ oiAsOf: null, marketDate: null }));
      expect(stamps).toHaveLength(3);
      expect(stamps[0]?.value).toBe('—');
      expect(stamps[2]?.value).toBe('—');
    });
  });

  describe('现价与锚标记', () => {
    it('现价按价格显示口径定标', () => {
      expect(chainReportHeaderView(report()).spotText).toBe('179.82');
    });

    it('🚨 现价缺失 ⇒ null，🚫 MUST NOT 兜成 0.00', () => {
      expect(chainReportHeaderView(report({ spot: null })).spotText).toBeNull();
    });

    it('锚 excluded ⇒ 页头带标记（报表照常渲染）', () => {
      expect(chainReportHeaderView(report({ anchorExcluded: true })).excludedNotice).toBeTruthy();
      expect(chainReportHeaderView(report()).excludedNotice).toBeNull();
    });
  });
});
