import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  INTRINSIC_VALUE_TOLERANCE,
  MAX_ABS_DELTA,
  checkOptionSnapshotRow,
  checkOptionSnapshotRows,
  intrinsicValue,
  type OptionSnapshotGuardRow,
} from './option-snapshot-guard.rules.js';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 一条正常的虚值认沽腿（四条门全过），各用例只覆盖自己要动的字段。 */
function putRow(overrides: Partial<OptionSnapshotGuardRow> = {}): OptionSnapshotGuardRow {
  return {
    contractCode: 'US.PEP260918P130000',
    optionSide: 'PUT',
    strikePrice: '130',
    isStandard: true,
    bid: '1.20',
    ask: '1.25',
    delta: '-0.42',
    underlyingSpot: '148.72',
    ...overrides,
  };
}

/** 一条正常的虚值认购腿 —— Δ 符号门方向与 {@link putRow} 相反。 */
function callRow(overrides: Partial<OptionSnapshotGuardRow> = {}): OptionSnapshotGuardRow {
  return {
    contractCode: 'US.PEP260918C160000',
    optionSide: 'CALL',
    strikePrice: '160',
    isStandard: true,
    bid: '0.85',
    ask: '0.95',
    delta: '0.31',
    underlyingSpot: '148.72',
    ...overrides,
  };
}

const codesOf = (row: OptionSnapshotGuardRow) =>
  checkOptionSnapshotRow(row).violations.map((v) => v.code);

const unjudgedOf = (row: OptionSnapshotGuardRow) =>
  [...checkOptionSnapshotRow(row).unjudged].sort();

describe('🚨 三态: 「判过了且过了」与「压根没判成」MUST 分得开 (2026-08-31 收口)', () => {
  it('全字段齐备且合规 → unjudged 为空 (恒有值, 不是 undefined)', () => {
    expect(checkOptionSnapshotRow(putRow()).unjudged).toEqual([]);
  });

  it('🚨 港股闭市形态: 标准合约无盘口 → 仍放行入库, 但门 ① / ④ 记为**无从判定**', () => {
    // 这就是那条把好数据换成坏数据的补救链的病根形态: 收盘轮撞 `ask_below_intrinsic` 被拒的腿,
    // 次日 08:30 盘前重采时港股 09:00 才竞价 ⇒ ask 全为 null ⇒ 门 ④ **根本没跑** ⇒ 零违规
    // ⇒ 补救判「补回了」。空数据反而比有瑕疵的数据更"合格"。
    const verdict = checkOptionSnapshotRow(putRow({ bid: null, ask: null }));
    // 📌 入库行为**不变** —— 无盘口行携带 OI 与合约骨架, 漏采即永久缺口。
    expect(verdict.admitted).toBe(true);
    expect(verdict.violations).toEqual([]);
    // 而「零违规」的成因在这里显式可读。
    expect([...verdict.unjudged].sort()).toEqual(['ask_below_intrinsic', 'bid_above_ask']);
  });

  it('只缺 ask → 门 ① 与门 ④ 都判不动 (两条都吃 ask)', () => {
    expect(unjudgedOf(putRow({ ask: null }))).toEqual(['ask_below_intrinsic', 'bid_above_ask']);
  });

  it('只缺 underlyingSpot → 只有门 ④ 判不动, 门 ① 照判', () => {
    expect(unjudgedOf(putRow({ underlyingSpot: null }))).toEqual(['ask_below_intrinsic']);
  });

  it('缺 Δ → 门 ② 与门 ③ **一起**判不动 (同一个入参)', () => {
    expect(unjudgedOf(putRow({ delta: null }))).toEqual(['delta_out_of_range', 'delta_sign']);
  });

  it('🚨 非标合约的门 ④ **不进** unjudged —— 那是「不适用」不是「无从判定」', () => {
    // 交割物不是 100 股标的 ⇒ 内在价值**没有定义**, 与「缺一格输入所以算不了」是两回事。
    // 混在一起会让非标合约恒「未判」, 把真正的信号淹掉 (#186 实拒 238 行全落在调整后合约上)。
    expect(unjudgedOf(putRow({ isStandard: false }))).toEqual([]);
    // 而同一张非标合约**缺 ask** 时, 门 ① 仍照常记未判 —— 门 ① 与交割物无关。
    expect(unjudgedOf(putRow({ isStandard: false, ask: null }))).toEqual(['bid_above_ask']);
  });

  it('unjudged MUST NOT 影响 admitted —— 真违规才拦', () => {
    // 无盘口 (门 ①④ 未判) + Δ 符号非法 (门 ② 判得动且违规) ⇒ 拦, 且两个列表各记各的。
    const verdict = checkOptionSnapshotRow(putRow({ bid: null, ask: null, delta: '0.42' }));
    expect(verdict.admitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toEqual(['delta_sign']);
    expect([...verdict.unjudged].sort()).toEqual(['ask_below_intrinsic', 'bid_above_ask']);
  });
});

describe('checkOptionSnapshotRow — 门 ①「bid ≤ ask」(FR-043)', () => {
  it('bid < ask → 放行', () => {
    expect(checkOptionSnapshotRow(putRow()).admitted).toBe(true);
  });

  it('bid == ask（锁价盘口）→ 放行，边界是闭的', () => {
    expect(checkOptionSnapshotRow(putRow({ bid: '1.25', ask: '1.25' })).admitted).toBe(true);
  });

  it('bid > ask（交叉盘口，不可能的真实报价）→ 违规 bid_above_ask', () => {
    const verdict = checkOptionSnapshotRow(putRow({ bid: '1.30', ask: '1.25' }));
    expect(verdict.admitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toEqual(['bid_above_ask']);
    // 原因串带上两个实值，运维不必回查原始 payload 就能定位。
    expect(verdict.violations[0]?.reason).toContain('1.3');
    expect(verdict.violations[0]?.reason).toContain('1.25');
  });

  it('单边缺报价（bid 或 ask 为 null）→ 该门跳过，行仍放行', () => {
    expect(checkOptionSnapshotRow(putRow({ bid: null })).admitted).toBe(true);
    expect(checkOptionSnapshotRow(putRow({ ask: null, underlyingSpot: null })).admitted).toBe(true);
  });
});

describe('checkOptionSnapshotRow — 门 ②「PUT Δ ≤ 0 / CALL Δ ≥ 0」两侧方向相反 (FR-043)', () => {
  it('PUT Δ = −0.42 → 放行；CALL Δ = +0.31 → 放行', () => {
    expect(checkOptionSnapshotRow(putRow()).admitted).toBe(true);
    expect(checkOptionSnapshotRow(callRow()).admitted).toBe(true);
  });

  it('🚨 同一个 Δ 值在两侧判定相反：+0.42 对 PUT 是违规、对 CALL 是正常', () => {
    expect(codesOf(putRow({ delta: '0.42' }))).toEqual(['delta_sign']);
    expect(checkOptionSnapshotRow(callRow({ delta: '0.42' })).admitted).toBe(true);
  });

  it('🚨 反向同理：−0.42 对 CALL 是违规、对 PUT 是正常', () => {
    expect(codesOf(callRow({ delta: '-0.42' }))).toEqual(['delta_sign']);
    expect(checkOptionSnapshotRow(putRow({ delta: '-0.42' })).admitted).toBe(true);
  });

  it('Δ = 0 两侧都放行（深虚腿的合法取值，两个门都是闭的）', () => {
    expect(checkOptionSnapshotRow(putRow({ delta: '0' })).admitted).toBe(true);
    expect(checkOptionSnapshotRow(callRow({ delta: '0' })).admitted).toBe(true);
  });
});

describe('checkOptionSnapshotRow — 门 ③「|Δ| ≤ 1」(FR-043)', () => {
  it('上限是具名常量 1', () => {
    expect(MAX_ABS_DELTA.toNumber()).toBe(1);
  });

  it('|Δ| 恰好 1（深实值腿的合法极值）→ 放行，边界闭', () => {
    expect(checkOptionSnapshotRow(putRow({ delta: '-1' })).admitted).toBe(true);
    expect(checkOptionSnapshotRow(callRow({ delta: '1' })).admitted).toBe(true);
  });

  it('|Δ| = 1.4 → 违规 delta_out_of_range（符号门另判，两条门各自独立）', () => {
    expect(codesOf(putRow({ delta: '-1.4' }))).toEqual(['delta_out_of_range']);
    expect(codesOf(callRow({ delta: '1.4' }))).toEqual(['delta_out_of_range']);
  });

  it('🚨 Δ 缺失（greeks 整块为 null 的深实值腿）→ 三条 Δ 门全跳过、行照常入库 (FR-007)', () => {
    // 实测 227/2150 行 greeks 缺失、99.5% 是深实值腿 —— 这是数学固有现象不是脏数据。
    // 把它拒在门外就等于「决策带由 |Δ| 定义、缺 Δ 即被筛没且无人知晓」那个 FR-007 明禁的形态。
    const verdict = checkOptionSnapshotRow(putRow({ delta: null }));
    expect(verdict.admitted).toBe(true);
    expect(verdict.violations).toEqual([]);
  });
});

describe('checkOptionSnapshotRow — 门 ④ 无套利下界用 `ask` 不用 `bid` (FR-044 / Guardrail 1)', () => {
  it('容差是顶部具名常量（改口径改一处，判定函数里无字面量）', () => {
    expect(INTRINSIC_VALUE_TOLERANCE.greaterThan(0)).toBe(true);
  });

  it('🚨🚨 bid 跌破内在价值、ask 未跌破的实值腿 **必须放行** —— 这条正是 FR-044 存在的理由', () => {
    // K=150 PUT / spot=130 ⇒ 内在价值 20。做市商挂 bid 19.10（比内在价值低 0.90，远超任何容差）
    // 而 ask 20.40 正常。实测同一批 2138 行：ask 版 0 违规、bid 版 **706 违规** ⇒ 用 bid 会当场
    // 误拦三分之一的实值腿，且被拒的快照**漏采即永久缺口**、买不回来。
    // 🚫 谁把实现改成 bid 版，这条就红。合成数据不会自然产生这种行，故必须显式造出来。
    const verdict = checkOptionSnapshotRow(
      putRow({ strikePrice: '150', underlyingSpot: '130', bid: '19.10', ask: '20.40' }),
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('🚨 CALL 侧同形：spot 高于 K 时 bid 跌破内在价值、ask 未跌破 → 放行', () => {
    const verdict = checkOptionSnapshotRow(
      callRow({
        strikePrice: '110',
        underlyingSpot: '130',
        delta: '0.98',
        bid: '19.10',
        ask: '20.40',
      }),
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('ask 跌破内在价值超出容差 → 违规 ask_below_intrinsic（PUT）', () => {
    const verdict = checkOptionSnapshotRow(
      putRow({ strikePrice: '150', underlyingSpot: '130', bid: '19.00', ask: '19.50' }),
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toEqual(['ask_below_intrinsic']);
    expect(verdict.violations[0]?.reason).toContain('20'); // 内在价值进原因串
  });

  it('ask 跌破内在价值超出容差 → 违规 ask_below_intrinsic（CALL）', () => {
    expect(
      codesOf(
        callRow({
          strikePrice: '110',
          underlyingSpot: '130',
          delta: '0.98',
          bid: '19',
          ask: '19.50',
        }),
      ),
    ).toEqual(['ask_below_intrinsic']);
  });

  it('ask 恰好 = 内在价值 − 容差 → 放行（下界闭，容差一分不多拦）', () => {
    const intrinsic = D(20);
    const ask = intrinsic.minus(INTRINSIC_VALUE_TOLERANCE);
    expect(
      checkOptionSnapshotRow(
        putRow({ strikePrice: '150', underlyingSpot: '130', bid: '19', ask: ask.toString() }),
      ).admitted,
    ).toBe(true);
  });

  it('虚值腿内在价值取 0（不取负）—— 任何非负 ask 都过', () => {
    // K=130 PUT / spot=148.72 ⇒ K − S = −18.72，内在价值必须截到 0 而不是负数；
    // 否则「内在价值 −18.72」会让这条门对虚值腿彻底失效（永远不可能触发）。
    expect(checkOptionSnapshotRow(putRow({ bid: '0.01', ask: '0.05' })).admitted).toBe(true);
    expect(checkOptionSnapshotRow(callRow({ bid: '0.01', ask: '0.05' })).admitted).toBe(true);
  });

  it('spot 或 ask 缺失 → 本门跳过（算不出内在价值就不判，不拿缺失当违规）', () => {
    expect(checkOptionSnapshotRow(putRow({ underlyingSpot: null })).admitted).toBe(true);
    expect(checkOptionSnapshotRow(putRow({ ask: null })).admitted).toBe(true);
  });
});

describe('checkOptionSnapshotRow — 门 ④ 只对标准合约成立：非标合约跳过 (#186, FR-033)', () => {
  /**
   * 形状取自 #186 的真实被拒行 `US.CHTR1260918C17500`（`ask 20.5` 被判「低于无套利下界」）。
   * 调整后合约的交割物不是 100 股标的 ⇒ `max(0, S − K)` 算出来的**不是**它的内在价值。
   * spot 取一个让普通公式当场跌破下界的值（内在价值 27.80，下界 27.75，ask 20.5）。
   */
  const adjustedCall = (overrides: Partial<OptionSnapshotGuardRow> = {}) =>
    callRow({
      contractCode: 'US.CHTR1260918C17500',
      strikePrice: '17.5',
      underlyingSpot: '45.30',
      bid: '20.1',
      ask: '20.5',
      delta: '0.98',
      isStandard: false,
      ...overrides,
    });

  it('🚨 非标合约的 ask 远低于「用普通行权价算出的内在价值」→ 放行 (FR-033 采集端照常全采)', () => {
    expect(checkOptionSnapshotRow(adjustedCall()).admitted).toBe(true);
  });

  it('🚨 对照：同一行标成标准合约即被拒 —— 放行来自 is_standard，不是数值恰好合规', () => {
    expect(codesOf(adjustedCall({ isStandard: false }))).toEqual([]);
    expect(codesOf(adjustedCall({ isStandard: true }))).toEqual(['ask_below_intrinsic']);
  });

  it('跳过的只有门 ④ 一条 —— 非标合约的交叉盘口 / 非法 Δ 照拦', () => {
    expect(codesOf(adjustedCall({ bid: '30', ask: '20.5' }))).toEqual(['bid_above_ask']);
    expect(codesOf(adjustedCall({ delta: '-0.98' }))).toEqual(['delta_sign']);
    expect(codesOf(adjustedCall({ delta: '1.4' }))).toEqual(['delta_out_of_range']);
  });
});

describe('checkOptionSnapshotRow — 逐行判定语义：多违规并列、永不抛异常', () => {
  it('一行同时撞多条门 → violations 全列出（不是撞第一条就短路）', () => {
    const verdict = checkOptionSnapshotRow(
      putRow({
        strikePrice: '150',
        underlyingSpot: '130',
        bid: '19.60',
        ask: '19.50',
        delta: '1.4',
      }),
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.violations.map((v) => v.code).sort()).toEqual([
      'ask_below_intrinsic',
      'bid_above_ask',
      'delta_out_of_range',
      'delta_sign',
    ]);
  });

  it('🚨 违规行不抛异常 —— 调用方逐行拒绝，MUST NOT 整批回滚 (FR-043)', () => {
    // 抛异常会让一条脏行带走整批的落库，而「已落历史数据不受影响」是 FR-043 的明文要求。
    expect(() =>
      checkOptionSnapshotRow(putRow({ bid: '99', ask: '0.01', delta: '7' })),
    ).not.toThrow();
  });

  it('verdict 带回 contractCode，调用方无需按下标对齐就能定位被拒的行', () => {
    expect(checkOptionSnapshotRow(putRow()).contractCode).toBe('US.PEP260918P130000');
  });
});

describe('checkOptionSnapshotRows — 批量逐行判定 (O(n))', () => {
  it('违规行被拒，同批其余行照常放行；顺序与输入一一对应', () => {
    const rows = [
      putRow({ contractCode: 'A' }),
      putRow({ contractCode: 'B', bid: '1.30', ask: '1.25' }),
      callRow({ contractCode: 'C' }),
    ];
    const verdicts = checkOptionSnapshotRows(rows);
    expect(verdicts.map((v) => v.contractCode)).toEqual(['A', 'B', 'C']);
    expect(verdicts.map((v) => v.admitted)).toEqual([true, false, true]);
  });

  it('空批 → 空数组，不抛错', () => {
    expect(checkOptionSnapshotRows([])).toEqual([]);
  });

  it('整批全违规也只是全部 admitted=false，仍不抛异常', () => {
    const verdicts = checkOptionSnapshotRows([
      putRow({ delta: '0.5' }),
      callRow({ delta: '-0.5' }),
    ]);
    expect(verdicts.every((v) => !v.admitted)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T007a: SC-010 真实样本回放
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SC-010「硬门在真实数据上的误拦率为 0」—— 用**已采的真实样本回放**，不是合成数据。
 *
 * ## 🚨 为什么这一段非有不可（合成数据造不出它要防的那件事）
 *
 * 上面那些 hermetic 用例里的「bid 跌破内在价值但 ask 未跌破」是**手写出来的一条**。真实分布
 * 长什么样、这种腿到底是罕见异常还是市场常态，手写例子一个字都答不出。本段回放的这一批
 * 2150 行（2026-07-29 美股收盘后实采，7 只标的全链）里**{@link BID_FLOOR_VIOLATIONS} 行**
 * 是这个形态 —— 占比三分之一，是**常态**。
 *
 * ⇒ 谁要是把无套利下界从 `ask`「修正」回 `bid`（Guardrail 1 明写不许），hermetic 用例只会红
 * 一条、看着像个边角，而这一段会当场红几百行，把「误拦三分之一实值腿」的真实体量摆出来。
 * 2026-08-07 实测：`bid` 版回放这一批**误拦 702 行**（全部 `ask_below_intrinsic`），`ask` 版 0。
 *
 * 📌 与 `option-snapshot-guard.rules.ts` 文件头记的「2138 行 / 706 违规」的关系：那是 p3b 分析
 * 期的口径（另一次取数 + 浮点判定），本段是入仓 fixture 上**用产品代码自己**重量的结果。两处
 * 说的是同一个现象、同一个量级；文件头那两个数是**冻结的决策记录**，不回改。
 *
 * ## 磁盘读取的例外说明（分类学 Small = 禁磁盘 I/O）
 *
 * 读的是**同仓 colocate 的只读静态 fixture**，单进程内、零容器零网络，与
 * `portfolio/holdings-xlsx.parser.spec.ts` 读 `__fixtures__/sample-holdings.xlsx` 同形态。
 *
 * ## fixture 出处
 *
 * `~/futu-screener/eod_snapshots/eod.sqlite` 的 `chain_snapshot` 表（本机 3.3 MB，**不入仓**），
 * 只导出硬门 {@link OptionSnapshotGuardRow} 用得到的七列：
 *
 * ```
 * sqlite3 -csv -header eod.sqlite "select code as contract_code, opt_type as option_side,
 *   strike as strike_price, bid, ask, delta, spot as underlying_spot
 *   from chain_snapshot where session_date='2026-07-29' order by code;"
 * ```
 *
 * CSV 而非 JSON：同一批数据 CSV 120 KB / JSON 对象数组 340 KB，且 CSV 逐行可 diff。字段全是
 * 裸数字与合约代码，**无引号无逗号**（导出时已验），故 `split(',')` 足够，不引 CSV 解析库。
 */
describe('SC-010 真实样本回放 (T007a) — 2026-07-29 美股收盘后实采 2150 行', () => {
  /** 本批行数。裁 fixture 会在这里当场红（fixture 悄悄变小 = 回放失去意义）。 */
  const SAMPLE_ROWS = 2150;

  /**
   * `bid` 跌破无套利下界、而 `ask` 未跌破的行数 —— **整条 task 的意义所在**。
   *
   * 这个数 > 0 是硬要求：为 0 就说明 fixture 被裁成了「反正都合规」的一批，回放形同虚设。
   * 数值本身由 {@link INTRINSIC_VALUE_TOLERANCE} 校准；改容差口径要连这个数一起重新量。
   *
   * ⚠️ 同一批数据在 sqlite 里用 `REAL` 算是 **703** —— 差的那一行恰好卡在容差边界上，是浮点
   * 减法把它算到了另一侧。以 `Prisma.Decimal` 为准（产品代码就是拿它判的），正是门 ③/④
   * 「卡在恰好等于边界」时禁用浮点的那条理由的一次现场复现。
   */
  const BID_FLOOR_VIOLATIONS = 702;

  const rows: OptionSnapshotGuardRow[] = readFileSync(
    join(__dirname, '__fixtures__', 'option-snapshot-us-2026-07-29.csv'),
    'utf8',
  )
    .trim()
    .split('\n')
    .slice(1) // 表头
    .map((line) => {
      const [contractCode, optionSide, strikePrice, bid, ask, delta, underlyingSpot] =
        line.split(',');
      return {
        contractCode,
        optionSide: optionSide as OptionSnapshotGuardRow['optionSide'],
        strikePrice,
        // 导出时没有这一列, 全批按**标准合约**喂 ⇒ 门 ④ 对每一行都武装着, SC-010 的零误拦
        // 断言不因 #186「非标跳过」而被削弱 (这批里确有 12 行 `VICI1` 是非标 root)。
        isStandard: true,
        bid,
        ask,
        delta,
        underlyingSpot,
      };
    });

  it('fixture 完整性：行数与两侧腿都在，没被裁成「反正都合规」的一批', () => {
    expect(rows).toHaveLength(SAMPLE_ROWS);
    expect(rows.filter((r) => r.optionSide === 'PUT').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.optionSide === 'CALL').length).toBeGreaterThan(0);
  });

  it('🚨 零误拦 (SC-010)：2150 行真实样本全部放行', () => {
    const rejected = checkOptionSnapshotRows(rows).filter((v) => !v.admitted);
    // 失败时把前几条摊开 —— 「误拦了 N 行」本身不够定位，要看是哪条门在拦。
    expect(
      rejected.slice(0, 5).map((v) => `${v.contractCode}: ${v.violations.map((x) => x.code)}`),
    ).toEqual([]);
    expect(rejected).toHaveLength(0);
  });

  it('🚨 这批样本里确有数百行「bid 跌破内在价值、ask 没跌破」—— 下界写成 bid 即当场误拦', () => {
    // 判据用**产品代码自己的** intrinsicValue + 容差常量, 不在测试里另写一份 K−S。
    const belowBidFloor = rows.filter((r) => {
      const floor = intrinsicValue(
        r.optionSide,
        D(r.strikePrice as string),
        D(r.underlyingSpot as string),
      ).minus(INTRINSIC_VALUE_TOLERANCE);
      return D(r.bid as string).lessThan(floor) && !D(r.ask as string).lessThan(floor);
    });

    // > 0 是这条断言的**本意**（fixture 哪天被裁剪, 上一条的「零误拦」会变成空洞的真命题）。
    expect(belowBidFloor.length).toBeGreaterThan(0);
    expect(belowBidFloor).toHaveLength(BID_FLOOR_VIOLATIONS);
  });
});
