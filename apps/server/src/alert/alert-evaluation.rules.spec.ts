import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  conditionDataNeed,
  evaluateAlertConditions,
  type EodBarSnapshot,
  type EvaluableCondition,
  type EvaluationInputs,
  type FundamentalRow,
} from './alert-evaluation.rules.js';
import type { IndicatorBar } from './alert-indicator.rules.js';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 标准 none bar: 高 14.5 / 低 12.8 / 收 14.2 / 昨收 10 (涨幅 +42%)。 */
function bar(overrides: Partial<EodBarSnapshot> = {}): EodBarSnapshot {
  return { high: D('14.5'), low: D('12.8'), close: D('14.2'), prevClose: D('10'), ...overrides };
}

/** 021 价格类入参: 只填 noneBar (forwardBars/fundamental 缺省)。 */
const priceInputs = (b: EodBarSnapshot = bar()): EvaluationInputs => ({ noneBar: b });

/** 前复权数值序列入参 (noneBar 给中性占位, 不被 forward 类条件读)。 */
const fwdInputs = (bars: readonly IndicatorBar[]): EvaluationInputs => ({
  noneBar: bar(),
  forwardBars: bars,
});

/** 单 IndicatorBar (只关心 close, 其余可覆盖)。 */
function ib(o: Partial<IndicatorBar> & { close: number }): IndicatorBar {
  return {
    tradeDate: '2026-01-01',
    open: o.close,
    high: o.high ?? o.close,
    low: o.low ?? o.close,
    close: o.close,
    prevClose: o.prevClose ?? null,
    volume: o.volume ?? null,
    turnoverRate: o.turnoverRate ?? null,
  };
}
const closes = (...cs: number[]): IndicatorBar[] => cs.map((c) => ib({ close: c }));
/** n 根 close=10 平盘 + 末根 close=last (high=last,low=10)。 */
const flatThen = (n: number, last: number): IndicatorBar[] => [
  ...Array.from({ length: n }, () => ib({ close: 10, high: 10, low: 10 })),
  ib({ close: last, high: last, low: 10 }),
];

const cond = (type: string, threshold?: string | number, param = 0): EvaluableCondition => ({
  type,
  param,
  threshold: threshold === undefined ? null : D(threshold),
});

// ════════════════════════════════════════════════════════════════════════════
// 021 价格 4 类 (FR-S09 零回归: snapshot 形状逐字节延续, 全含等号 D7)
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 021 价格基线 (零回归)', () => {
  it('PRICE_FALL_TO: 低 12.8 ≤ 阈 13 → 命中, snapshot {type,threshold,actual} 无 param 键', () => {
    const hits = evaluateAlertConditions([cond('PRICE_FALL_TO', 13)], priceInputs());
    expect(hits).toEqual([{ type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' }]);
  });

  it('PRICE_FALL_TO: 低 12.8 > 阈 12.5 → 不命中', () => {
    expect(evaluateAlertConditions([cond('PRICE_FALL_TO', '12.5')], priceInputs())).toBeNull();
  });

  it('PRICE_FALL_TO 边界: 低 == 阈 (12.8) → 命中 (含等号)', () => {
    expect(evaluateAlertConditions([cond('PRICE_FALL_TO', '12.8')], priceInputs())).not.toBeNull();
  });

  it('PRICE_RISE_TO: 高 14.5 ≥ 阈 14 → 命中, actual = high', () => {
    const hits = evaluateAlertConditions([cond('PRICE_RISE_TO', 14)], priceInputs());
    expect(hits).toEqual([{ type: 'PRICE_RISE_TO', threshold: '14.0000', actual: '14.5000' }]);
  });

  it('PRICE_RISE_TO 边界: 高 == 阈 (14.5) → 命中', () => {
    expect(evaluateAlertConditions([cond('PRICE_RISE_TO', '14.5')], priceInputs())).not.toBeNull();
  });

  it('DAILY_GAIN_OVER: +42% ≥ 阈 40 → 命中, actual = 涨幅', () => {
    const hits = evaluateAlertConditions([cond('DAILY_GAIN_OVER', 40)], priceInputs());
    expect(hits).toEqual([{ type: 'DAILY_GAIN_OVER', threshold: '40.0000', actual: '42.0000' }]);
  });

  it('DAILY_LOSS_OVER: −10% ≤ −阈 5 → 命中, actual = −10', () => {
    const hits = evaluateAlertConditions(
      [cond('DAILY_LOSS_OVER', 5)],
      priceInputs(bar({ close: D('9'), prevClose: D('10') })),
    );
    expect(hits).toEqual([{ type: 'DAILY_LOSS_OVER', threshold: '5.0000', actual: '-10.0000' }]);
  });

  it('DAILY_LOSS_OVER 边界: 跌幅恰 −5% == −阈 → 命中', () => {
    expect(
      evaluateAlertConditions(
        [cond('DAILY_LOSS_OVER', 5)],
        priceInputs(bar({ close: D('9.5'), prevClose: D('10') })),
      ),
    ).not.toBeNull();
  });

  it('prevClose null/0 → DAILY_* 不命中 (PRICE_* 不受影响)', () => {
    const noPrev = priceInputs(bar({ prevClose: null }));
    expect(evaluateAlertConditions([cond('DAILY_GAIN_OVER', 1)], noPrev)).toBeNull();
    expect(evaluateAlertConditions([cond('PRICE_FALL_TO', 13)], noPrev)).not.toBeNull();
    expect(
      evaluateAlertConditions(
        [cond('DAILY_GAIN_OVER', 1)],
        priceInputs(bar({ prevClose: D('0') })),
      ),
    ).toBeNull();
  });

  it('精度: 涨幅 10/3% 与阈 3.3333 Decimal 比较不爆浮点', () => {
    const hits = evaluateAlertConditions(
      [cond('DAILY_GAIN_OVER', '3.3333')],
      priceInputs(bar({ close: D('3.1'), prevClose: D('3') })),
    );
    expect(hits).not.toBeNull();
    expect(hits![0]!.actual).toBe('3.3333');
  });

  it('AND: 双条件全命中 → 输入序; 任一不命中 → null; 空数组 → null', () => {
    expect(
      evaluateAlertConditions(
        [cond('PRICE_FALL_TO', 13), cond('DAILY_GAIN_OVER', 40)],
        priceInputs(),
      ),
    ).toHaveLength(2);
    expect(
      evaluateAlertConditions(
        [cond('PRICE_FALL_TO', 13), cond('PRICE_RISE_TO', 99)],
        priceInputs(),
      ),
    ).toBeNull();
    expect(evaluateAlertConditions([], priceInputs())).toBeNull();
  });

  it('真正未知类型 → 不命中 (防御)', () => {
    expect(evaluateAlertConditions([cond('TOTALLY_UNKNOWN', 1)], priceInputs())).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// conditionDataNeed 取数分类 (usecase 取数分层依据)
// ════════════════════════════════════════════════════════════════════════════
describe('conditionDataNeed', () => {
  it('021 四类 → noneBar; 估值 → fundamental; 价格扩展/量/技术 → forwardBars; 未知 → noneBar', () => {
    expect(conditionDataNeed('PRICE_FALL_TO')).toBe('noneBar');
    expect(conditionDataNeed('DAILY_GAIN_OVER')).toBe('noneBar');
    expect(conditionDataNeed('PE_BELOW')).toBe('fundamental');
    expect(conditionDataNeed('PE_PCTL_ABOVE')).toBe('fundamental');
    expect(conditionDataNeed('MA_CROSS_UP')).toBe('forwardBars');
    expect(conditionDataNeed('NEW_HIGH')).toBe('forwardBars');
    expect(conditionDataNeed('VOLUME_RATIO_OVER')).toBe('forwardBars');
    expect(conditionDataNeed('MACD_GOLDEN_CROSS')).toBe('forwardBars');
    expect(conditionDataNeed('TOTALLY_UNKNOWN')).toBe('noneBar');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 价格扩展类 (MA 穿越 / 新高低 / 累计涨跌幅) — 前复权序列, 事件 vs 状态
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 价格扩展类', () => {
  it('MA_CROSS_UP(3): 昨收<昨MA ∧ 今收≥今MA → 命中, snapshot 带 param 无 threshold', () => {
    // closes [10,10,10,9,12]: MA3 昨=29/3≈9.67 今=31/3≈10.33; 昨收9<9.67 今收12≥10.33
    const hits = evaluateAlertConditions(
      [cond('MA_CROSS_UP', undefined, 3)],
      fwdInputs(closes(10, 10, 10, 9, 12)),
    );
    expect(hits).toEqual([{ type: 'MA_CROSS_UP', threshold: null, actual: '12.0000', param: 3 }]);
  });

  it('MA_CROSS_UP(3): 持续站上均线 (非穿越日) → 不命中 (事件语义)', () => {
    expect(
      evaluateAlertConditions(
        [cond('MA_CROSS_UP', undefined, 3)],
        fwdInputs(closes(10, 11, 12, 13, 14)),
      ),
    ).toBeNull();
  });

  it('MA_CROSS_DOWN(3): 昨收>昨MA ∧ 今收≤今MA → 命中', () => {
    const hits = evaluateAlertConditions(
      [cond('MA_CROSS_DOWN', undefined, 3)],
      fwdInputs(closes(10, 10, 10, 11, 8)),
    );
    expect(hits).not.toBeNull();
  });

  it('MA_CROSS_UP: warm-up 不足 (len ≤ N) → 不命中', () => {
    expect(
      evaluateAlertConditions([cond('MA_CROSS_UP', undefined, 3)], fwdInputs(closes(10, 11, 12))),
    ).toBeNull();
    expect(evaluateAlertConditions([cond('MA_CROSS_UP', undefined, 3)], fwdInputs([]))).toBeNull();
  });

  it('NEW_HIGH(3): 今高 > 前 3 日最高 → 命中, actual = 今高', () => {
    const bars = [
      ib({ close: 10, high: 11 }),
      ib({ close: 10, high: 12 }),
      ib({ close: 9, high: 9 }),
      ib({ close: 13, high: 13 }),
    ];
    const hits = evaluateAlertConditions([cond('NEW_HIGH', undefined, 3)], fwdInputs(bars));
    expect(hits).toEqual([{ type: 'NEW_HIGH', threshold: null, actual: '13.0000', param: 3 }]);
  });

  it('NEW_LOW(3): 今低 < 前 3 日最低 → 命中', () => {
    const bars = [
      ib({ close: 10, low: 9 }),
      ib({ close: 10, low: 10 }),
      ib({ close: 10, low: 11 }),
      ib({ close: 8, low: 8 }),
    ];
    expect(
      evaluateAlertConditions([cond('NEW_LOW', undefined, 3)], fwdInputs(bars)),
    ).not.toBeNull();
  });

  it('PERIOD_GAIN_OVER(3): (今收−3日前收)/3日前收 ≥ 阈 → 命中', () => {
    // 今=bars[4]=12, 3日前=bars[1]=10: (12−10)/10×100=20% ≥ 15
    const hits = evaluateAlertConditions(
      [cond('PERIOD_GAIN_OVER', 15, 3)],
      fwdInputs(closes(11, 10, 11, 11, 12)),
    );
    expect(hits).toEqual([
      { type: 'PERIOD_GAIN_OVER', threshold: '15.0000', actual: '20.0000', param: 3 },
    ]);
  });

  it('PERIOD_LOSS_OVER(3): 跌幅 ≤ −阈 → 命中', () => {
    const hits = evaluateAlertConditions(
      [cond('PERIOD_LOSS_OVER', 15, 3)],
      fwdInputs(closes(9, 10, 9, 9, 8)), // 今=8, 3日前=bars[1]=10: (8−10)/10=−20% ≤ −15
    );
    expect(hits![0]!.actual).toBe('-20.0000');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 成交量类 (换手率 / 量比)
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 成交量类', () => {
  it('TURNOVER_RATE_OVER: 今换手率 ≥ 阈 → 命中, actual = 换手率', () => {
    const bars = [ib({ close: 10, turnoverRate: 1 }), ib({ close: 10, turnoverRate: 5.5 })];
    const hits = evaluateAlertConditions([cond('TURNOVER_RATE_OVER', 5)], fwdInputs(bars));
    expect(hits).toEqual([{ type: 'TURNOVER_RATE_OVER', threshold: '5.0000', actual: '5.5000' }]);
  });

  it('TURNOVER_RATE_OVER: 换手率字段 null → 不命中 (字段缺失防御)', () => {
    expect(
      evaluateAlertConditions([cond('TURNOVER_RATE_OVER', 5)], fwdInputs([ib({ close: 10 })])),
    ).toBeNull();
  });

  it('VOLUME_RATIO_OVER: 今量/前5日均量 ≥ 阈 → 命中', () => {
    const vols = [1, 1, 1, 1, 1, 3].map((v) => ib({ close: 10, volume: v }));
    const hits = evaluateAlertConditions([cond('VOLUME_RATIO_OVER', 2)], fwdInputs(vols));
    expect(hits).toEqual([{ type: 'VOLUME_RATIO_OVER', threshold: '2.0000', actual: '3.0000' }]);
  });

  it('VOLUME_RATIO_OVER: warm-up 不足 (<6 根) → 不命中', () => {
    const vols = [1, 1, 1].map((v) => ib({ close: 10, volume: v }));
    expect(evaluateAlertConditions([cond('VOLUME_RATIO_OVER', 2)], fwdInputs(vols))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 技术指标类 (MACD/KDJ 金叉死叉 + KDJ/RSI 超买卖 + BOLL 突破) — 事件 vs 状态
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 技术指标类', () => {
  it('MACD_GOLDEN_CROSS: 平盘后跳涨 → DIF 上穿 DEA 命中 (threshold null + actual=DIF)', () => {
    const hits = evaluateAlertConditions([cond('MACD_GOLDEN_CROSS')], fwdInputs(flatThen(30, 11)));
    expect(hits).not.toBeNull();
    expect(hits![0]!.threshold).toBeNull();
    expect(hits![0]!.type).toBe('MACD_GOLDEN_CROSS');
  });

  it('MACD_DEATH_CROSS: 平盘后跳跌 → 命中; 纯平盘 → 不命中 (无穿越)', () => {
    expect(
      evaluateAlertConditions([cond('MACD_DEATH_CROSS')], fwdInputs(flatThen(30, 9))),
    ).not.toBeNull();
    expect(
      evaluateAlertConditions(
        [cond('MACD_GOLDEN_CROSS')],
        fwdInputs(closes(...Array(30).fill(10))),
      ),
    ).toBeNull();
  });

  it('MACD: warm-up <2 根 → 不命中', () => {
    expect(evaluateAlertConditions([cond('MACD_GOLDEN_CROSS')], fwdInputs(closes(10)))).toBeNull();
  });

  it('KDJ_GOLDEN_CROSS: 平盘后跳涨 → K 上穿 D 命中', () => {
    expect(
      evaluateAlertConditions([cond('KDJ_GOLDEN_CROSS')], fwdInputs(flatThen(12, 11))),
    ).not.toBeNull();
  });

  it('KDJ_OVERBOUGHT/OVERSOLD: 强势拉升 J>100 超买命中, 超卖不命中 (状态语义)', () => {
    const rally = closes(10, 11, 12, 13, 14, 15, 16, 17, 18);
    expect(evaluateAlertConditions([cond('KDJ_OVERBOUGHT')], fwdInputs(rally))).not.toBeNull();
    expect(evaluateAlertConditions([cond('KDJ_OVERSOLD')], fwdInputs(rally))).toBeNull();
  });

  it('RSI_OVERBOUGHT(阈70): 单边上涨 RSI≈100 ≥70 → 命中; RSI_OVERSOLD(阈30) → 不命中', () => {
    const up = closes(...Array.from({ length: 20 }, (_, i) => 10 + i));
    const hits = evaluateAlertConditions([cond('RSI_OVERBOUGHT', 70)], fwdInputs(up));
    expect(hits).toEqual([{ type: 'RSI_OVERBOUGHT', threshold: '70.0000', actual: '100.0000' }]);
    expect(evaluateAlertConditions([cond('RSI_OVERSOLD', 30)], fwdInputs(up))).toBeNull();
  });

  it('RSI_OVERSOLD(阈30): 单边下跌 RSI≈0 ≤30 → 命中', () => {
    const down = closes(...Array.from({ length: 20 }, (_, i) => 30 - i));
    expect(evaluateAlertConditions([cond('RSI_OVERSOLD', 30)], fwdInputs(down))).not.toBeNull();
  });

  it('BOLL_BREAK_UPPER: 昨收在轨内 ∧ 今收破上轨 → 命中 (穿越事件)', () => {
    const hits = evaluateAlertConditions([cond('BOLL_BREAK_UPPER')], fwdInputs(flatThen(20, 11)));
    expect(hits).not.toBeNull();
    expect(hits![0]!.type).toBe('BOLL_BREAK_UPPER');
  });

  it('BOLL: warm-up <20 根 → 不命中', () => {
    expect(
      evaluateAlertConditions([cond('BOLL_BREAK_UPPER')], fwdInputs(closes(...Array(10).fill(10)))),
    ).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 估值类 (最新快照 + staleness gate + 字段缺失防御)
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 估值类', () => {
  const fund = (o: Partial<FundamentalRow> = {}): FundamentalRow => ({
    date: '2026-06-04',
    peTtm: null,
    pb: null,
    dividendYield: null,
    pePctlY3: null,
    pePctlY5: null,
    pbPctlY3: null,
    pbPctlY5: null,
    ...o,
  });
  const valInputs = (
    fundamental: FundamentalRow | null,
    staleness: number | null,
  ): EvaluationInputs => ({ noneBar: bar(), fundamental, fundamentalStaleness: staleness });

  it('PE_BELOW: PE 9.8 ≤ 阈 10, staleness 0 → 命中, snapshot 带 dataDate 无 param', () => {
    const hits = evaluateAlertConditions(
      [cond('PE_BELOW', 10)],
      valInputs(fund({ peTtm: 9.8 }), 0),
    );
    expect(hits).toEqual([
      { type: 'PE_BELOW', threshold: '10.0000', actual: '9.8000', dataDate: '2026-06-04' },
    ]);
  });

  it('PE_ABOVE 边界含等号; PB_BELOW / 股息率方向正确', () => {
    expect(
      evaluateAlertConditions([cond('PE_ABOVE', 10)], valInputs(fund({ peTtm: 10 }), 1)),
    ).not.toBeNull();
    expect(
      evaluateAlertConditions([cond('PB_BELOW', 2)], valInputs(fund({ pb: 1.5 }), 1)),
    ).not.toBeNull();
    expect(
      evaluateAlertConditions(
        [cond('DIVIDEND_YIELD_ABOVE', 3)],
        valInputs(fund({ dividendYield: 4.2 }), 1),
      ),
    ).not.toBeNull();
  });

  it('PE_PCTL_ABOVE: param 3 读 pePctlY3 / param 5 读 pePctlY5', () => {
    const f = fund({ pePctlY3: 80, pePctlY5: 20 });
    expect(evaluateAlertConditions([cond('PE_PCTL_ABOVE', 70, 3)], valInputs(f, 0))).not.toBeNull(); // 80 ≥ 70
    expect(evaluateAlertConditions([cond('PE_PCTL_ABOVE', 70, 5)], valInputs(f, 0))).toBeNull(); // 20 < 70
  });

  it('staleness > 3 → 不命中 (陈旧 gate); == 3 边界 → 命中', () => {
    expect(
      evaluateAlertConditions([cond('PE_BELOW', 10)], valInputs(fund({ peTtm: 9 }), 4)),
    ).toBeNull();
    expect(
      evaluateAlertConditions([cond('PE_BELOW', 10)], valInputs(fund({ peTtm: 9 }), 3)),
    ).not.toBeNull();
  });

  it('无快照 / staleness null / 字段 null → 不命中 (防御)', () => {
    expect(evaluateAlertConditions([cond('PE_BELOW', 10)], valInputs(null, null))).toBeNull();
    expect(
      evaluateAlertConditions([cond('PE_BELOW', 10)], valInputs(fund({ peTtm: 9 }), null)),
    ).toBeNull();
    expect(
      evaluateAlertConditions([cond('PE_BELOW', 10)], valInputs(fund({ peTtm: null }), 0)),
    ).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 024 盘中 5min 差分 (相邻 tick 涨跌幅; realtime 数据源; 方向区分 + 首 tick 防御 D3.3)
// ════════════════════════════════════════════════════════════════════════════
describe('alert-evaluation.rules — 024 盘中 5min 差分', () => {
  /** 5min 差分入参: 现价 + 上一 tick 价 (noneBar 给中性占位, 不被 realtime 类读)。 */
  const diffInputs = (price: number, prevTickPrice: number | null): EvaluationInputs => ({
    noneBar: bar(),
    realtimeDiff: { price, prevTickPrice },
  });

  it("conditionDataNeed: 5min 差分 2 类 → 'realtime'; 到价类仍 'noneBar' (T009 零改)", () => {
    expect(conditionDataNeed('PRICE_RISE_5MIN_OVER')).toBe('realtime');
    expect(conditionDataNeed('PRICE_FALL_5MIN_OVER')).toBe('realtime');
    expect(conditionDataNeed('PRICE_RISE_TO')).toBe('noneBar');
    expect(conditionDataNeed('PRICE_FALL_TO')).toBe('noneBar');
  });

  it('PRICE_RISE_5MIN_OVER: 10→10.3 (+3%) ≥ 阈 3 → 命中, actual=pct', () => {
    const hits = evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(10.3, 10));
    expect(hits).toEqual([{ type: 'PRICE_RISE_5MIN_OVER', threshold: '3.0000', actual: '3.0000' }]);
  });

  // 注: 5min 差分走 number 算术 (实时价本为 number, 同指标 number 口径) → 不保证 Decimal
  // EOD 价格类那样的 float-exact 边界等号; 故边界用「略超」而非 float 等值断言。
  it('PRICE_RISE_5MIN_OVER: 涨幅略超阈值 (+3.1% ≥ 3) → 命中', () => {
    expect(
      evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(10.31, 10)),
    ).not.toBeNull();
  });

  it('PRICE_FALL_5MIN_OVER: 10→9.6 (−4%) ≤ −阈 3 → 命中', () => {
    const hits = evaluateAlertConditions([cond('PRICE_FALL_5MIN_OVER', 3)], diffInputs(9.6, 10));
    expect(hits).not.toBeNull();
    expect(hits![0]!.actual).toBe('-4.0000');
  });

  it('未达阈值 → 不命中 (涨 +1% < 阈 3)', () => {
    expect(
      evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(10.1, 10)),
    ).toBeNull();
  });

  it('方向区分: 上涨 +3% 对 PRICE_FALL_5MIN_OVER → 不命中; 下跌 −3% 对 PRICE_RISE_5MIN_OVER → 不命中', () => {
    expect(
      evaluateAlertConditions([cond('PRICE_FALL_5MIN_OVER', 3)], diffInputs(10.3, 10)),
    ).toBeNull();
    expect(
      evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(9.7, 10)),
    ).toBeNull();
  });

  it('首 tick (prevTickPrice null) → 不命中 (防御, 不误触发)', () => {
    expect(
      evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(10.3, null)),
    ).toBeNull();
  });

  it('realtimeDiff 缺省 (EOD 轮) → 5min 差分类不命中', () => {
    expect(evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], priceInputs())).toBeNull();
    expect(evaluateAlertConditions([cond('PRICE_FALL_5MIN_OVER', 3)], priceInputs())).toBeNull();
  });

  it('上一 tick 价 ≤ 0 (除零防御) → 不命中', () => {
    expect(
      evaluateAlertConditions([cond('PRICE_RISE_5MIN_OVER', 3)], diffInputs(10, 0)),
    ).toBeNull();
  });
});
