import { describe, expect, it } from 'vitest';
import type { LegIntent, RentDepth } from './intent-matrix.rules';
import * as legMark from './leg-mark.rules';
import {
  BUILD_RECOMMEND_ABS_DELTA_BAND,
  MONTHLY_EXPIRATION_CYCLE,
  RENT_RECOMMEND_ABS_DELTA_BANDS,
  isRecommended,
  monthlyChainExpiries,
} from './leg-mark.rules';

describe('leg-mark.rules — Δ 带自召回层迁入打标层, 值不变 (plan D-MARK-1)', () => {
  it('建仓推荐带 = 047 `BUILD_LEG_ABS_DELTA_BAND` 原值', () => {
    expect(BUILD_RECOMMEND_ABS_DELTA_BAND).toEqual({ min: 0.4, max: 0.55 });
  });

  it('收租三档推荐带 = 047 `RENT_DEPTH_ABS_DELTA_BANDS` 原值, 键序由浅到深', () => {
    expect(RENT_RECOMMEND_ABS_DELTA_BANDS).toEqual({
      near_atm: { min: 0.3, max: 0.4 },
      moderate: { min: 0.15, max: 0.3 },
      deep: { min: 0.05, max: 0.15 },
    });
  });

  it('🚨 三档并集整条不迁不留 —— 它是**召回**语义的产物 (Guardrail 1)', () => {
    // 「不替人做方向性假设」这条原则在召回语义下导出「取并集放宽收进来」、在打标语义下导出
    // 「不打标」。并集常量一旦跟着搬过来, 就是那个坑的入口 —— 照抄它会让「水位未选」时全表
    // 冒出一片推荐标, 而代码看着完全合理。⇒ 结构上不给它存在的机会。
    expect(Object.keys(legMark)).not.toContain('RENT_DEPTH_UNION_BAND');
  });
});

/**
 * T006 —— 推荐标真值表 (FR-011 / FR-012 / FR-013)。
 *
 * 两个探针**互不落入对方的带**, 所以「取错了带」这种错法抓得到, 而不是碰巧两边都为真:
 * `0.45` 只落建仓带 `[0.40,0.55]`, `0.35` 只落 `near_atm` 带 `[0.30,0.40]`。
 */
describe('leg-mark.rules — isRecommended 完整真值表 (FR-011/FR-012/FR-013)', () => {
  const IN_BUILD = 0.45;
  const IN_NEAR_ATM = 0.35;

  /** 4 种 intent × (未选 + 三档水位) 全枚举; `expected` = [探针 0.45, 探针 0.35] 的期望。 */
  const TRUTH_TABLE: ReadonlyArray<{
    intent: LegIntent;
    rentDepth: RentDepth | null;
    expected: [boolean, boolean];
  }> = [
    // 建仓意图取建仓带, 且**不看** rentDepth —— 该态下矩阵恒给 null, 但函数不能依赖调用方守约。
    { intent: 'build_position', rentDepth: null, expected: [true, false] },
    { intent: 'build_position', rentDepth: 'near_atm', expected: [true, false] },
    { intent: 'build_position', rentDepth: 'moderate', expected: [true, false] },
    { intent: 'build_position', rentDepth: 'deep', expected: [true, false] },
    // 🚨 收租 + 水位未选恒 false (Guardrail 1) —— 见下方那条单独的守卫用例。
    { intent: 'rent', rentDepth: null, expected: [false, false] },
    { intent: 'rent', rentDepth: 'near_atm', expected: [false, true] },
    { intent: 'rent', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'rent', rentDepth: 'deep', expected: [false, false] },
    // 待定 / 不开新仓: 没有方向就没有标 (FR-012), 与水位档和 Δ 都无关。
    { intent: 'pending', rentDepth: null, expected: [false, false] },
    { intent: 'pending', rentDepth: 'near_atm', expected: [false, false] },
    { intent: 'pending', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'pending', rentDepth: 'deep', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: null, expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'near_atm', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'deep', expected: [false, false] },
  ];

  it('16 格真值表逐格相符 (4 种 intent × 未选 + 三档水位)', () => {
    for (const { intent, rentDepth, expected } of TRUTH_TABLE) {
      const at = `${intent} × ${rentDepth ?? '水位未选'}`;
      expect([at, isRecommended(intent, rentDepth, IN_BUILD)]).toEqual([at, expected[0]]);
      expect([at, isRecommended(intent, rentDepth, IN_NEAR_ATM)]).toEqual([at, expected[1]]);
    }
  });

  it('🚨 收租 + 水位未选 → **恒** false, 三档带的任何取值都打不出标 (Guardrail 1 的守卫)', () => {
    // 「不替人做方向性假设」在**召回**语义下导出「取三档并集放宽收进来」, 在**打标**语义下导出
    // 「不打标」。照抄召回那半边会让水位未选时全表冒出一片推荐标, 而那段代码看着完全合理。
    // ⇒ 这里把三档带的**全部端点**都过一遍: 只要实现里出现任何形式的并集, 本条立刻红。
    for (const band of Object.values(RENT_RECOMMEND_ABS_DELTA_BANDS)) {
      for (const absDelta of [band.min, band.max, (band.min + band.max) / 2]) {
        expect(isRecommended('rent', null, absDelta)).toBe(false);
      }
    }
  });

  it('absDelta 为 null → 恒 false (FR-013: 缺 Δ 不能推定落在任何带内)', () => {
    for (const { intent, rentDepth } of TRUTH_TABLE) {
      expect(isRecommended(intent, rentDepth, null)).toBe(false);
    }
  });

  it('建仓带**两端均可取到**, 带外一点点即不打', () => {
    const { min, max } = BUILD_RECOMMEND_ABS_DELTA_BAND;
    expect(isRecommended('build_position', null, min)).toBe(true); // 恰好 0.40
    expect(isRecommended('build_position', null, max)).toBe(true); // 恰好 0.55
    expect(isRecommended('build_position', null, 0.3999)).toBe(false);
    expect(isRecommended('build_position', null, 0.5501)).toBe(false);
  });

  it('收租三档各自的两端均可取到; 相邻两档共享的端点在各自档下都成立', () => {
    for (const [depth, band] of Object.entries(RENT_RECOMMEND_ABS_DELTA_BANDS)) {
      expect(isRecommended('rent', depth as RentDepth, band.min)).toBe(true);
      expect(isRecommended('rent', depth as RentDepth, band.max)).toBe(true);
    }
    // 0.30 是 moderate 的上端也是 near_atm 的下端 —— 两档各自都收它, 这不是重叠 bug:
    // 档由**水位**定, 同一时刻只会取其中一档去判。
    expect(isRecommended('rent', 'moderate', 0.3)).toBe(true);
    expect(isRecommended('rent', 'near_atm', 0.3)).toBe(true);
    // 带外: deep 的下端之下 / near_atm 的上端之上。
    expect(isRecommended('rent', 'deep', 0.0499)).toBe(false);
    expect(isRecommended('rent', 'near_atm', 0.4001)).toBe(false);
  });
});

/**
 * 月度链标 (FR-014 / FR-015, plan D-MARK-2)。
 *
 * 🚨 **判据于 2026-08-15 (#45) 整条换源**: 从「第三个周五 + 交易日历假日回退」改为**读 vendor
 * 已落库的到期周期** (`marketdata.option_contract.expiration_cycle`)。旧判据在生产从未生效过 ——
 * 交易日历结构上不含未来交易日 (它的填充判据是「某指数当日**有 bar**」), 而期权到期日按定义
 * 都在未来 ⇒ 回退目标恒取不到 ⇒ 标一个都不出。详见 issue #45。
 *
 * 🚨 **本组用例的期望值全部是可外部核对的日历事实 / 真实 vendor 读数**, 不是拿同一套运算再
 * 算一遍 —— 后者是同义反复, 正是旧判据「单测全绿、生产全灭」的成因。
 */
const leg = (expiryDate: string, expirationCycle: string | null) => ({
  expiryDate: new Date(`${expiryDate}T00:00:00.000Z`),
  expirationCycle,
});

describe('leg-mark.rules — monthlyChainExpiries: 月度到期日取自 vendor 到期周期 (FR-015)', () => {
  it('vendor 标 `MONTH` 的到期日进集合, `WEEK` 不进', () => {
    expect(
      monthlyChainExpiries([
        leg('2026-08-14', 'WEEK'),
        leg('2026-08-21', 'MONTH'),
        leg('2026-08-28', 'WEEK'),
        leg('2026-09-18', 'MONTH'),
      ]),
    ).toEqual(new Set(['2026-08-21', '2026-09-18']));
  });

  it('🚨 2027-06-17 是**周四**且 vendor 标 `MONTH` —— 「是不是第三个周五」答不对的那天', () => {
    // 2027-06-19 Juneteenth 落**周六** ⇒ NYSE 提前到周五 2027-06-18 休市 ⇒ 该月月度到期日
    // 前挪到周四 06-17。第三个周五是 06-18, 链上根本没有那天的合约 ⇒ 拿周五当判据的话
    // **整个 6 月一个月标都不出**, 而那种漏标看起来完全正常。
    // 实据: dev 库 `us` 链上 2027-06-17 共 298 条合约, `expiration_cycle` 全部为 `MONTH`。
    expect(monthlyChainExpiries([leg('2027-06-17', 'MONTH')])).toEqual(new Set(['2027-06-17']));
    // 反向: 同月的第三个周五 06-18 若真有合约且 vendor 标 WEEK, 也 MUST NOT 因「是周五」被标。
    expect(monthlyChainExpiries([leg('2027-06-18', 'WEEK')])).toEqual(new Set());
  });

  it('🚨 vendor 缺字段 (`null`) → 不打标, MUST NOT 推定 (同 FR-013「缺 Δ 不打推荐标」)', () => {
    expect(monthlyChainExpiries([leg('2026-08-21', null)])).toEqual(new Set());
  });

  it(`🚨 判据是白名单 \`=== ${MONTHLY_EXPIRATION_CYCLE}\`, 未知新值只漏标不错标`, () => {
    // 富途未公开 `ExpirationCycle` 的完整值域 ⇒ 黑名单 (「不等于 WEEK 就算月度」) 会把将来
    // 冒出的任何新值**错标**成月链; 白名单只会漏标。两者代价不对称。
    expect(monthlyChainExpiries([leg('2026-08-21', 'QUARTER')])).toEqual(new Set());
    expect(monthlyChainExpiries([leg('2026-08-21', 'month')])).toEqual(new Set());
  });

  it('同一到期日的多条腿 → 集合天然去重, 「同一到期日必同标」是结构保证', () => {
    expect(
      monthlyChainExpiries([
        leg('2026-08-21', 'MONTH'),
        leg('2026-08-21', 'MONTH'),
        leg('2026-08-21', 'MONTH'),
      ]),
    ).toEqual(new Set(['2026-08-21']));
  });

  it('空链 → 空集合, 不炸', () => {
    expect(monthlyChainExpiries([])).toEqual(new Set());
  });

  it('🚨 键一律走 UTC —— 宿主在 UTC−N 时不能把到期日算成前一天', () => {
    // `@db.Date` 读出来就是 UTC 午夜; 用本地时区取日期会让整片标错位一天, 而**测试在 UTC+8
    // 的开发机上照样绿** (同旧 `thirdFridayOf` 的那条 UTC 纪律, 换了落点仍成立)。
    expect(monthlyChainExpiries([leg('2026-01-16', 'MONTH')])).toEqual(new Set(['2026-01-16']));
    expect(monthlyChainExpiries([leg('2027-01-15', 'MONTH')])).toEqual(new Set(['2027-01-15']));
  });
});
