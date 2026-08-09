import { describe, it, expect } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client';
import { VendorHttpClient } from '../../src/marketdata/vendor-http-client';
import { LIXINGER_PROFILE } from '../../src/marketdata/lixinger.constraint-profile';
import { LixingerEodBarAdapter } from '../../src/marketdata/lixinger-eod-bar.adapter';
import { LixingerCorporateActionAdapter } from '../../src/marketdata/lixinger-corporate-action.adapter';
import {
  buildFactorEventTerms,
  decideFactor,
  factorFromEventTerms,
  factorFromOfficialChange,
  type FactorCorporateAction,
} from '../../src/marketdata/factor-event-terms.rules';
import { deriveAdjustedBars } from '../../src/marketdata/adjusted-bars.rules';
import type { AdjustableBarRow } from '../../src/marketdata/adjusted-bars.rules';
import type { EodBarPoint } from '../../src/marketdata/marketdata.types';

/**
 * 020 T012 SC-A02 对拍门 (env-gated 真 vendor, 默认 skip) — 2026-08-01 随算法换口径重写。
 *
 * **旧版对拍的是什么、为什么失效**: 旧版拿 `anchorFactorJumps`(vendor backward 序列反推) 的
 * 输出与 dividend 端点公式互校, ε 门 2e-2。该门**从未在 CI 跑过**(env-gated), 而 prod 攒下了
 * 62 行 ≥10% 偏差 —— 门开在正确的位置上, 只是没通电。反推口径已于本次证伪并退役
 * (理杏仁 `bc_rights` 是仿射 `bc = K·ex − C`, C≠0 且随窗内事件数累积, 比值不是不变量)。
 *
 * **新版对拍**: 两条**互不共用输入**的路径在真 vendor 数据上的一致率 ——
 *   ① 事件条款法 `f = M·n₀/(n₀ + P·q − d)`  ← dividend 端点条款 (派息 + 送转股比)
 *   ② 涨跌幅复权法 `f' = (1+chg/100)·n₀/n₁` ← candlestick 的官方涨跌幅
 * 这正是 production `decideFactor` 的 2-of-2 闸本身, 本门验的是「闸在真数据上的通过率」。
 * 一致率塌下去 = 要么 vendor 数据变了、要么条款覆盖漏了, 两种都该有人看。
 *
 * ③ **自洽恒等门**保留: `forward(t) = backward(t) ÷ B_latest` 逐日断言 (构造性, 零额外请求)。
 *
 * **本地启用** (token 放 gitignored env / shell, 禁入仓):
 *   RUN_MARKETDATA_IT=true LIXINGER_TOKEN=<token> \
 *   pnpm nx test server -- marketdata.factor-crosscheck-020
 */
const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';
const BASE = 'https://open.lixinger.com/api';

// 抽样: 多次除权史 + T001 已知形态全覆盖 — 600519 多年纯现金分红 / 601318 同日多行
// (2018-06-07 特别息+常规息) / 601088 已知 WARN 离群 (再投资 convention gap) / 600036 常规。
const SAMPLES = ['cn:600519', 'cn:601318', 'cn:601088', 'cn:600036'];
// 窗口起点: corporate-action adapter 回看 3650 天 (~2016-08) → bars 同窗对齐。
const FROM_DATE = '2017-01-01';
// 两法一致率下限。PoC (18 只港股 / 180 事件) 实测 88.4% 落在 1% 内; cn 纯现金分红为主、
// 条款覆盖更全, 门定 0.85 留足 vendor 抖动余量 —— 低于此说明条款侧成规模地漏了东西。
const MIN_VERIFIED_RATIO = 0.85;

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 理杏仁 dividend 端点原始行 → 条款 (同 exDate 多行聚合: 特别息 + 常规息同日并存)。 */
function aggregateActions(
  actions: Array<{ exDate: string; payload: unknown }>,
): FactorCorporateAction[] {
  const by = new Map<string, { dividend: number; bonus: number; currency: string | null }>();
  for (const a of actions) {
    const p = a.payload as Record<string, unknown>;
    const agg = by.get(a.exDate) ?? { dividend: 0, bonus: 0, currency: null };
    agg.dividend += toNum(p.dividend);
    agg.bonus += toNum(p.bonusSharesFromProfit) + toNum(p.bonusSharesFromCapitalReserve);
    agg.currency = typeof p.currency === 'string' ? p.currency : agg.currency;
    by.set(a.exDate, agg);
  }
  return [...by.entries()].map(([exDate, agg]) => ({
    exDate,
    dividend: agg.dividend > 0 ? new Prisma.Decimal(agg.dividend) : null,
    bonusShares: agg.bonus > 0 ? new Prisma.Decimal(agg.bonus) : null,
    // cn dividend 端点不下发 currency → 视同标的交易币种 (CNY), 否则条款会被币种守卫吞掉。
    currency: agg.currency ?? 'CNY',
  }));
}

/** EodBarPoint (vendor 串值) → deriveAdjustedBars 输入行 (价格四字段进 Decimal)。 */
function toAdjustableRow(b: EodBarPoint): AdjustableBarRow {
  return {
    tradeDate: b.tradeDate,
    open: new Prisma.Decimal(b.open),
    high: new Prisma.Decimal(b.high),
    low: new Prisma.Decimal(b.low),
    close: new Prisma.Decimal(b.close),
    changePct: b.changePct === null ? null : new Prisma.Decimal(b.changePct),
    prevClose: b.prevClose === null ? null : new Prisma.Decimal(b.prevClose),
    volume: null,
    amount: null,
    turnoverRate: null,
  };
}

describe.skipIf(!RUN_MARKETDATA_IT)('020 T012 SC-A02 对拍门 (env-gated, 默认 skip)', () => {
  const token = process.env.LIXINGER_TOKEN ?? '';
  // 单实例 http client (共享双窗限频器, 沿 lixinger-vendor.it 范式)。
  const http = new VendorHttpClient(LIXINGER_PROFILE);

  it('LIXINGER_TOKEN 必设 (否则明确报错, 不静默打空 token)', () => {
    if (!token) throw new Error('真 vendor IT 缺 LIXINGER_TOKEN');
  });

  it('两法一致率 ≥ 85% + forward = backward ÷ B_latest 恒等', async () => {
    const eodAdapter = new LixingerEodBarAdapter(http, token, BASE);
    const corpAdapter = new LixingerCorporateActionAdapter(http, token, BASE);
    const to = new Date().toISOString().slice(0, 10);

    let comparable = 0;
    let verified = 0;
    const warnList: string[] = [];

    for (const symbol of SAMPLES) {
      const noneBars = await eodAdapter.getBars({
        symbol,
        from: FROM_DATE,
        to,
        adjust: 'none',
      });
      const actions = await corpAdapter.getCorporateActions(symbol);
      expect(noneBars.length).toBeGreaterThan(200);
      expect(actions.length).toBeGreaterThan(0);

      // 🚨 零 backward 拉取 —— 换口径后本门不再需要 vendor 已复权序列 (它正是失效口径的输入)。
      const terms = buildFactorEventTerms({
        currency: 'CNY',
        noneBars: noneBars.map((b) => ({
          tradeDate: b.tradeDate,
          close: new Prisma.Decimal(b.close),
          changePct: b.changePct === null ? null : new Prisma.Decimal(b.changePct),
        })),
        corporateActions: aggregateActions(actions),
        equityChanges: [], // cn 无 equity_change 覆盖 —— 送转股走 payload 的 bonusShares。
        allotments: [],
      });
      expect(terms.length).toBeGreaterThan(3); // 多次除权史样本, 管道必须看得到事件。

      const jumps = [];
      for (const t of terms) {
        const decision = decideFactor(t);
        jumps.push({ exDate: t.exDate, factorJump: decision.factorJump });
        const a = factorFromEventTerms(t);
        const b = factorFromOfficialChange(t);
        if (a === null || b === null) continue; // 只统计两法都可算的事件。
        comparable++;
        if (decision.status === 'verified') verified++;
        else {
          const eps = a.minus(b).abs().div(b).toNumber();
          warnList.push(
            `${symbol} ex=${t.exDate} terms=${a.toFixed(6)} witness=${b.toFixed(6)} ε=${eps.toExponential(2)}`,
          );
        }
      }

      // ③ 自洽恒等: forward = backward ÷ B_latest (toFixed(4) 双侧舍入 → 相对容差 1e-3)。
      const rows = noneBars.map(toAdjustableRow);
      const fwd = deriveAdjustedBars(rows, jumps, 'forward');
      const bwd = deriveAdjustedBars(rows, jumps, 'backward');
      let bLatest = new Prisma.Decimal(1);
      for (const j of jumps) bLatest = bLatest.mul(j.factorJump);
      for (let k = 0; k < fwd.length; k++) {
        const expected = bwd[k].close.div(bLatest).toNumber();
        const actual = fwd[k].close.toNumber();
        expect(
          Math.abs(actual - expected) / expected,
          `${symbol} ${fwd[k].tradeDate} 恒等破坏`,
        ).toBeLessThan(1e-3);
      }
    }

    // 全样本管道可见性门: 可比事件须成规模 (T001 round-2 同窗 12 样本 139 事件量级)。
    expect(comparable).toBeGreaterThan(20);
    if (warnList.length > 0) {
      console.warn(`两法分歧复核名单 (${warnList.length}/${comparable}):`);
      for (const w of warnList) console.warn(`  ${w}`);
    }
    expect(
      verified / comparable,
      '两法一致率塌陷 — 条款覆盖漏了或 vendor 数据变了',
    ).toBeGreaterThanOrEqual(MIN_VERIFIED_RATIO);
  }, 180_000);
});
