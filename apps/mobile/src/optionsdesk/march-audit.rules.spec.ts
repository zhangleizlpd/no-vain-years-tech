// 069 T009 — 弹层组装纯函数五臂（logic-only；交互与可见性走 Playwright e2e）。
import { describe, expect, it } from 'vitest';
import type {
  LegMarchAuditResponse,
  LegMarchStrikeResponse,
  MarchAuditEvidenceResponse,
} from '@nvy/api-client';

import {
  MARCH_FAMILY_OF_CATEGORY,
  MARCH_FAMILY_KINDS,
  marchAuditSheetView,
} from './march-audit.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const evidence = (over: Partial<MarchAuditEvidenceResponse> = {}): MarchAuditEvidenceResponse => ({
  bid: null,
  ask: null,
  fwd: null,
  fwdOut: null,
  premium: null,
  premiumShorter: null,
  chordDistanceTicks: null,
  phi: null,
  decay: null,
  decayCap: null,
  annualized: null,
  tierFloor: null,
  recommendedDteDays: null,
  oi: null,
  oiMin: null,
  absDelta: null,
  bandFloor: null,
  ...over,
});

const audit = (
  dteDays: number,
  category: LegMarchAuditResponse['category'],
  over: Partial<LegMarchAuditResponse> = {},
): LegMarchAuditResponse => ({
  dteDays,
  mergedIntoDteDays: null,
  category,
  evidence: evidence(),
  ...over,
});

const strikeView = (over: Partial<LegMarchStrikeResponse> = {}): LegMarchStrikeResponse => ({
  strike: '92.0000',
  verdict: 'recommended',
  recommendedDteDays: 180,
  summary: { ladderCount: 3, netChainCount: 3, removedCount: 0, mergedCount: 0, markedCount: 0 },
  audits: [],
  ...over,
});

describe('march-audit.rules — 弹层内容组装 (069 T009 FR-014/FR-016 · 070 T005 FR-003/FR-009)', () => {
  it('家族归组: Record 穷举 13 类 → 恰四家族 (A4/B5/C2/D2)', () => {
    const counts = new Map<string, number>();
    for (const family of Object.values(MARCH_FAMILY_OF_CATEGORY)) {
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    expect(Object.keys(MARCH_FAMILY_OF_CATEGORY)).toHaveLength(13);
    expect(MARCH_FAMILY_KINDS).toHaveLength(4);
    expect(counts.get('chain_clean')).toBe(4);
    expect(counts.get('march')).toBe(5);
    expect(counts.get('tradability')).toBe(2);
    expect(counts.get('boundary')).toBe(2);
  });

  it('① 推荐态: 判决 chip + 推荐档读数 + 净链小结 + φ 读数 + 逐档行 (含并段指向)', () => {
    const view = marchAuditSheetView(
      strikeView({
        audits: [
          audit(45, 'qualified_not_stop', { evidence: evidence({ recommendedDteDays: 180 }) }),
          audit(90, 'fwd_below_phi', {
            evidence: evidence({ fwd: '0.060000', phi: '0.150000' }),
          }),
          audit(120, 'collinear_merged', {
            mergedIntoDteDays: 180,
            evidence: evidence({ chordDistanceTicks: '0.3000' }),
          }),
        ],
        summary: {
          ladderCount: 5,
          netChainCount: 3,
          removedCount: 1,
          mergedCount: 1,
          markedCount: 2,
        },
      }),
    )!;
    expect(view.title).toBe(OPTIONSDESK_COPY.march.sheetTitle('92'));
    expect(view.verdictLabel).toBe('推荐档');
    expect(view.recommendedLabel).toBe('180d');
    expect(view.emptyText).toBeNull();
    expect(view.summaryLine).toBe('段内 5 档 · 净链 3 · 剔 1 · 并 1 · 标 2');
    expect(view.phiLine).toBe('再投资线 φ 15.0%');
    expect(view.rows.map((r) => r.dteLabel)).toEqual(['45d', '90d', '120d → 180d']);
    expect(view.rows[1]!.text).toBe('远期费率 6.0% < φ 15.0%');
    expect(view.rows.map((r) => r.family)).toEqual(['march', 'march', 'chain_clean']);
  });

  it('② 无合格档: 诚实空态文案 (中性, 零感叹号零错误语气), 逐档行照渲', () => {
    const view = marchAuditSheetView(
      strikeView({
        verdict: 'no_qualified',
        recommendedDteDays: null,
        audits: [
          audit(45, 'fwd_below_phi', { evidence: evidence({ fwd: '0.100000', phi: '0.150000' }) }),
        ],
      }),
    )!;
    expect(view.verdictLabel).toBe('无合格档');
    expect(view.recommendedLabel).toBeNull();
    expect(view.emptyText).toBe(OPTIONSDESK_COPY.march.emptyNoQualified);
    expect(view.emptyText).not.toMatch(/[!！]|失败|错误/);
    expect(view.rows).toHaveLength(1);
  });

  it('③ 整梯无可成交 · OI 成因: 空态 + 逐档 #11 文案可判', () => {
    const view = marchAuditSheetView(
      strikeView({
        verdict: 'untradable',
        recommendedDteDays: null,
        audits: [
          audit(180, 'ladder_oi_all_below_min', { evidence: evidence({ oi: 8, oiMin: 50 }) }),
        ],
      }),
    )!;
    expect(view.emptyText).toBe(OPTIONSDESK_COPY.march.emptyUntradable);
    expect(view.rows[0]!.text).toBe('持仓 8 < 下限 50，全梯无过闸');
    expect(view.rows[0]!.family).toBe('tradability');
  });

  it('④ 整梯无可成交 · 报价异常成因: 同一空态, 逐档 #1 文案与 OI 成因互斥可分 (clarify Q2)', () => {
    const view = marchAuditSheetView(
      strikeView({
        verdict: 'untradable',
        recommendedDteDays: null,
        audits: [
          audit(60, 'crossed_quote', { evidence: evidence({ bid: '3.0000', ask: '2.9000' }) }),
          audit(120, 'crossed_quote', { evidence: evidence({ bid: '5.0000', ask: '4.9000' }) }),
        ],
      }),
    )!;
    expect(view.emptyText).toBe(OPTIONSDESK_COPY.march.emptyUntradable);
    expect(view.rows.map((r) => r.text)).toEqual([
      '报价交叉 买 3 ≥ 卖 2.9',
      '报价交叉 买 5 ≥ 卖 4.9',
    ]);
    expect(view.rows.every((r) => r.family === 'chain_clean')).toBe(true);
    expect(view.rows.some((r) => r.text.includes('持仓'))).toBe(false);
  });

  it('⑤ 建仓 / 全腿 / 离线 (strikeView=null) ⇒ null, 无弹层可开 (FR-019)', () => {
    expect(marchAuditSheetView(null)).toBeNull();
  });

  it('070 ② 口径行: 收盘档 ⇒ 「基于 {交易日} 收盘」; 实时档 / 时点形态不对 / 缺省上下文 ⇒ 不渲', () => {
    const eod = marchAuditSheetView(strikeView(), {
      priceKind: 'eod_close',
      quoteAsOf: '2026-08-28',
      marchMode: 'phi',
    })!;
    expect(eod.basisLine).toBe('基于 2026-08-28 收盘');
    expect(eod.basisLine).toBe(OPTIONSDESK_COPY.march.basisEodClose('2026-08-28'));
    // 🚨 实时档零口径行: 这一批就是此刻的盘口, 写「基于…收盘」正是 064 要防的反向伪装。
    expect(
      marchAuditSheetView(strikeView(), {
        priceKind: 'realtime',
        quoteAsOf: '2026-08-28T21:47:32.000Z',
        marchMode: 'phi',
      })!.basisLine,
    ).toBeNull();
    // 🚨 反例: 档位说收盘、时点却是个时刻 ⇒ 只取交易日部分, 时分秒一个都不许渗出
    //    (同 `formatQuoteSessionDay` 那条纪律)。
    const contradictory = marchAuditSheetView(strikeView(), {
      priceKind: 'eod_close',
      quoteAsOf: '2026-08-28T21:47:32.000Z',
      marchMode: 'phi',
    })!;
    expect(contradictory.basisLine).toBe('基于 2026-08-28 收盘');
    expect(contradictory.basisLine).not.toContain(':');
    // 形态不对 / 缺时点 / 069 既有调用体例 (不传上下文) ⇒ 一律不渲, 绝不渲染裸 null
    expect(
      marchAuditSheetView(strikeView(), {
        priceKind: 'eod_close',
        quoteAsOf: '2026/08/28',
        marchMode: 'phi',
      })!.basisLine,
    ).toBeNull();
    expect(
      marchAuditSheetView(strikeView(), {
        priceKind: 'eod_close',
        quoteAsOf: null,
        marchMode: 'phi',
      })!.basisLine,
    ).toBeNull();
    expect(marchAuditSheetView(strikeView())!.basisLine).toBeNull();
  });

  it('070 ③ 模式标示: θ ⇒ 标示行 + φ 读数收起; φ / 缺省 ⇒ 读数行原样、零新元素', () => {
    const withPhi = strikeView({
      audits: [
        audit(90, 'fwd_below_phi', { evidence: evidence({ fwd: '0.060000', phi: '0.150000' }) }),
      ],
    });
    const phiView = marchAuditSheetView(withPhi, {
      priceKind: 'eod_close',
      quoteAsOf: '2026-08-28',
      marchMode: 'phi',
    })!;
    expect(phiView.phiLine).toBe('再投资线 φ 15.0%');
    // 默认 φ 态**零新元素** = 零噪音 (FR-009)
    expect(phiView.modeLine).toBeNull();

    const thetaView = marchAuditSheetView(withPhi, {
      priceKind: 'eod_close',
      quoteAsOf: '2026-08-28',
      marchMode: 'theta',
    })!;
    expect(thetaView.modeLine).toBe(OPTIONSDESK_COPY.march.modeThetaReadout);
    // 🚨 θ 下判据是年化 argmax 不是再投资线 ⇒ φ 读数 MUST 收起, 否则就是静默混用两模式语义。
    expect(thetaView.phiLine).toBeNull();

    // 069 既有调用体例 (不传上下文) 与 φ 态逐字段同值 —— 「实时档零既有行为改动」的机器判据
    const legacy = marchAuditSheetView(withPhi)!;
    expect(legacy.modeLine).toBeNull();
    expect(legacy.phiLine).toBe(phiView.phiLine);
    expect(legacy.rows).toEqual(phiView.rows);
  });

  it('070 ④ 新 copy 键: 微标四类键集 + 中性语气 (禁感叹号, 「异常/失败」留给真故障)', () => {
    const copy = OPTIONSDESK_COPY.march;
    expect(copy.basisEodClose('2026-08-28')).toBe('基于 2026-08-28 收盘');
    expect(copy.modeThetaReadout).toBe('选档判据 · 自身年化最大');
    // 微标键集 = 清链家族四类 (契约加类而这里漏配 ⇒ leg-row.tsx 索引处编译红)
    expect(Object.keys(copy.inferiorMarks)).toEqual(['concave', 'stale', 'merged', 'crossed']);
    for (const text of [
      copy.basisEodClose('2026-08-28'),
      copy.modeThetaReadout,
      copy.inferiorMarks.crossed,
    ]) {
      expect(text).not.toMatch(/[!！]|失败|异常|错误/);
    }
  });
});
