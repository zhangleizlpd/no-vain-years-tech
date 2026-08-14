// 055 T017 — 屏级降级合成的单测（Small，logic-only）。
//
// 🚨 本文件盯三条「照样渲染得出来」的错法：
//    ① 「链未就绪」与「全被门槛挡下」合成同一态 —— 两者都能印出一句「没有可看的腿」，
//       但前者是**采集还没轮到**（等就有）、后者是**链就长这样**（等也没有），处置完全相反；
//    ② 「全被门槛挡下」不画网格 —— 那时整屏只剩一句话，用户看不到「哪一档哪一列有腿被挡」，
//       而三个计数还在页脚上，读起来像界面坏了；
//    ③ 网格读失败把页头一起拖下水 —— IV 分位明明读得到（它是另一条链路的四态）。
import { describe, expect, it } from 'vitest';
import type { ChainReportGateCountsResponse } from '@nvy/api-client';

import { composeChainReport, type ChainReportPageState } from './chain-report-page.rules';

const COUNTS: ChainReportGateCountsResponse = {
  total: 825,
  removedByPremium: 252,
  skeleton: 573,
  outsideRowFloor: 261,
  withinRows: 312,
  blockedByLiveness: 38,
  valued: 274,
};

/** 全被挡下：一条都没落到图上，但链上**有**合约。 */
const ALL_GATED: ChainReportGateCountsResponse = {
  ...COUNTS,
  outsideRowFloor: 261 + 274,
  valued: 0,
};

/** 链上一条腿都没有 —— 与「全被挡下」不是一回事。 */
const EMPTY_COUNTS: ChainReportGateCountsResponse = {
  total: 0,
  removedByPremium: 0,
  skeleton: 0,
  outsideRowFloor: 0,
  withinRows: 0,
  blockedByLiveness: 0,
  valued: 0,
};

function pageOf(input: {
  isPending?: boolean;
  isError?: boolean;
  state?: 'available' | 'chain_not_ready' | 'read_failed';
  spot?: string | null;
  gateCounts?: ChainReportGateCountsResponse;
  noReport?: boolean;
}) {
  return composeChainReport({
    isPending: input.isPending ?? false,
    isError: input.isError ?? false,
    report:
      input.noReport === true
        ? null
        : {
            state: input.state ?? 'available',
            spot: input.spot === undefined ? '298.4500' : input.spot,
            gateCounts: input.gateCounts ?? COUNTS,
          },
  });
}

describe('055 T017 —— 五种降级态各自可判', () => {
  const cases: readonly [string, ChainReportPageState, Parameters<typeof pageOf>[0]][] = [
    ['加载', 'loading', { isPending: true, noReport: true }],
    ['取数失败', 'read_failed', { isError: true, noReport: true }],
    ['服务端说读故障', 'read_failed', { state: 'read_failed' }],
    ['链未就绪', 'chain_not_ready', { state: 'chain_not_ready' }],
    ['现价缺失', 'no_spot', { spot: null }],
    ['全被门槛挡下', 'all_gated', { gateCounts: ALL_GATED }],
    ['常态', 'ready', {}],
  ];

  for (const [label, expected, input] of cases) {
    it(`${label} ⇒ ${expected}`, () => {
      expect(pageOf(input).page).toBe(expected);
    });
  }

  it('六种页态两两不同（没有两个分支塌进同一个字符串）', () => {
    const states = new Set(cases.map(([, expected]) => expected));
    expect(states.size).toBe(6);
  });
});

describe('🚨 055 T017 —— 「链未就绪」与「全被门槛挡下」可分辨（state_branch 7）', () => {
  it('两者不是同一个页态', () => {
    expect(pageOf({ state: 'chain_not_ready' }).page).not.toBe(
      pageOf({ gateCounts: ALL_GATED }).page,
    );
  });

  it('🚨 全被挡下时**网格照常渲染** —— 否则整屏只剩一句话，而三个计数还在页脚上', () => {
    expect(pageOf({ gateCounts: ALL_GATED }).grid).toBe(true);
  });

  it('🚨 链未就绪时不画网格（没有列可画）', () => {
    expect(pageOf({ state: 'chain_not_ready' }).grid).toBe(false);
  });

  it('全被挡下时压一句说明在网格下方；未就绪那支不出这一句', () => {
    expect(pageOf({ gateCounts: ALL_GATED }).gatedBanner).not.toBeNull();
    expect(pageOf({ state: 'chain_not_ready' }).gatedBanner).toBeNull();
  });

  it('🚨 链上一条腿都没有 ⇒ **不说**「全被门槛挡下」（那句话会是假的）', () => {
    expect(pageOf({ gateCounts: EMPTY_COUNTS }).page).toBe('ready');
  });
});

describe('🚨 055 T017 —— 页头按自己的四态独立降级，不被网格失败波及', () => {
  it('服务端说读故障时页头照常渲染，只有网格不画', () => {
    const composition = pageOf({ state: 'read_failed' });
    expect(composition.header).toBe(true);
    expect(composition.grid).toBe(false);
  });

  it('链未就绪 / 现价缺失同样保留页头（IV 分位是另一条链路）', () => {
    expect(pageOf({ state: 'chain_not_ready' }).header).toBe(true);
    expect(pageOf({ spot: null }).header).toBe(true);
  });

  it('响应根本没到手才没有页头（那时确实一个字段都没有）', () => {
    expect(pageOf({ isPending: true, noReport: true }).header).toBe(false);
    expect(pageOf({ isError: true, noReport: true }).header).toBe(false);
  });
});

describe('🚨 055 T017 —— 加载期不画骨架网格', () => {
  it('列数取决于链上实际到期日，加载前未知 ⇒ 骨架必然跳变', () => {
    const composition = pageOf({ isPending: true, noReport: true });
    expect(composition.grid).toBe(false);
    expect(composition.notice).toBeNull();
  });
});

describe('055 T017 —— 只有「读失败」那一支给重试入口', () => {
  it('读失败可重试', () => {
    expect(pageOf({ state: 'read_failed' }).notice?.retry).toBe(true);
    expect(pageOf({ isError: true, noReport: true }).notice?.retry).toBe(true);
  });

  it('🚨 链未就绪 / 现价缺失 **不给重试** —— 它们是事实不是故障，重试一百次也一样', () => {
    expect(pageOf({ state: 'chain_not_ready' }).notice?.retry).toBe(false);
    expect(pageOf({ spot: null }).notice?.retry).toBe(false);
  });

  it('三句说明两两不同（🚫 不合并成一句「暂不可用」）', () => {
    const texts = [
      pageOf({ state: 'chain_not_ready' }).notice?.text,
      pageOf({ spot: null }).notice?.text,
      pageOf({ state: 'read_failed' }).notice?.text,
    ];
    expect(new Set(texts).size).toBe(3);
  });
});

describe('🚨 055 T017 —— 某格值零非空格不改变页态（state_branch 4）', () => {
  // 页态是**链级**的：四种格值跑在不同召回集上，某一种下一格都没有是正确行为
  // （实测填充率 建仓 6.3%），那时骨架与行列标签照常渲染，🚫 不呈空白页 / 错误页。
  it('链级有值 ⇒ 恒 ready，与当前看的是哪种格值无关', () => {
    expect(pageOf({}).page).toBe('ready');
    expect(pageOf({}).grid).toBe(true);
  });

  it('合成的入参里根本没有「当前格值」这一项（结构上做不到按格值分支）', () => {
    // 入参只有取数态 + 链级三字段 —— 想按格值分页态，得先改签名。
    expect(Object.keys(pageOf({}))).toEqual(['page', 'header', 'grid', 'notice', 'gatedBanner']);
  });
});
