// 052 T012 — 检索条件控件的纯函数（FR-011/012/013/015/029/030）。
//
// 🚨 **本片最容易踩且不会红的那条**：客户端自己算一份默认值（Guardrail 6 / FR-011）。
//    默认值依赖 spot（每天变），自算与服务端**两边都算得出数** —— 只在换日那一刻才漂移。
//    ⇒ 本文件所有断言的共同形状是「服务端给什么，控件里就是什么」，没有一条在验算式。
//    源码层的零命中判据在 `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #8
//    （Small 档禁磁盘 I/O ⇒ 治理扫描归 scripts/checks，同 #5/#6/#7 的处置）。
import { describe, expect, it } from 'vitest';
import type {
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
  RetrievalOutcomesResponse,
} from '@nvy/api-client';

import {
  changedCriteria,
  criteriaFormOf,
  criteriaOverrideCount,
  criteriaCountLines,
  criteriaQueryParams,
  normalizeCriteriaForm,
  type CriteriaForm,
} from './leg-criteria.rules';

/** 收租视角的一份系统默认值（形状取自契约，值取 dev 链的量级）。 */
function defaults(over: Partial<RetrievalCriteriaResponse> = {}): RetrievalCriteriaResponse {
  return {
    strikeMax: '137.7000',
    strikeMin: null,
    dteBand: { min: 30, max: 365 },
    premiumMin: '0.2400',
    livenessMin: { oi: 1, volume: 1 },
    relativeSpreadMax: '0.3500',
    ...over,
  };
}

/** 三视角共用的「一条都没动过」outcomes。 */
function outcomes(over: Partial<RetrievalOutcomesResponse> = {}): RetrievalOutcomesResponse {
  const untouched = { state: 'default' as const, excludedCount: 0 };
  return {
    strikeMax: untouched,
    strikeMin: untouched,
    dteBand: untouched,
    premiumMin: untouched,
    livenessMin: untouched,
    relativeSpreadMax: untouched,
    ...over,
  };
}

function perspective(over: Partial<PerspectiveCriteriaResponse> = {}): PerspectiveCriteriaResponse {
  return { defaults: defaults(), effective: defaults(), outcomes: outcomes(), ...over };
}

// ═══════════ ① 默认值回填：服务端给什么控件里就是什么，客户端零处自算 ═══════════

describe('🚨 FR-011 —— 控件值全部来自服务端下发的 defaults', () => {
  it('定标串裁到最简显示形（`137.7000` → `137.7`），值本身不动', () => {
    expect(criteriaFormOf(defaults()).strikeMax).toBe('137.7');
    expect(criteriaFormOf(defaults()).premiumMin).toBe('0.24');
  });

  it('DTE 段与活性两对数原样落两个框', () => {
    const form = criteriaFormOf(defaults());
    expect([form.dteMin, form.dteMax]).toEqual(['30', '365']);
    expect([form.oiMin, form.volMin]).toEqual(['1', '1']);
  });

  it('🚨 相对价差换成百分数显示 —— 它是无量纲比例，与同屏四项金额/张数混排会被读成金额', () => {
    expect(criteriaFormOf(defaults()).relativeSpreadMax).toBe('35');
  });

  it('🚫 `null` = 不限 ⇒ 空框，MUST NOT 拿 0 / ∞ / 任何替代数字顶上', () => {
    const form = criteriaFormOf(defaults({ strikeMax: null, dteBand: null }));
    expect(form.strikeMax).toBe('');
    expect(form.dteMin).toBe('');
    expect(form.dteMax).toBe('');
  });

  it('🚨 链未就绪（六维全 null）⇒ 六个框全空 —— 「解不出」MUST NOT 看起来像「解出来正好是这些」', () => {
    const form = criteriaFormOf({
      strikeMax: null,
      strikeMin: null,
      dteBand: null,
      premiumMin: null,
      livenessMin: null,
      relativeSpreadMax: null,
    });
    expect(Object.values(form).every((v) => v === '')).toBe(true);
  });

  it('契约未到手（null）⇒ 全空表单，不崩', () => {
    expect(criteriaFormOf(null).premiumMin).toBe('');
  });
});

// ═══════════ ② 行集统一（056）：新露出的行 MUST NOT 带上任何预填 ═══════════

describe('🚨 056 SC-013 —— 行集统一 MUST NOT 改变任一视角的默认候选集', () => {
  // 🚨 **本片最危险的一条**：某个新露出的行若意外带上一个非空值，候选集会静默变少 ——
  //    条数与数值全都正常、**屏幕上什么都不会红**（同 053 那一类失败）。
  //    ⇒ 判据是「一格未动时，表单逐字段 = 服务端默认值投影」，且提交出去**一维都不带**
  //    （缺键 = 未覆盖 ⇒ 服务端走它自己的默认值 ⇒ 与改版前逐条一致）。
  //    📌 052 的 `criteriaRowsFor` / `ROWS_BY_TAB` / `HAS_DEFAULT` 随本片删除（FR-012），
  //       其四条用例一并删 —— 它们断言的正是被 supersede 掉的 per-视角行集。

  /** 建仓：`052` 藏起来的是行权价两维，服务端下发的就是 `null`。 */
  const buildDefaults = defaults({ strikeMin: null, strikeMax: null });
  /** 全腿：`052` 藏起来的是价差，且期限段在全腿也是 `null`。 */
  const allDefaults = defaults({
    strikeMin: null,
    strikeMax: null,
    dteBand: null,
    relativeSpreadMax: null,
  });

  it('🚨 建仓：新露出的行权价两个框呈空（= 不限），提交时一维都不下发', () => {
    const untouched = normalizeCriteriaForm(criteriaFormOf(buildDefaults));
    expect(untouched).toEqual(criteriaFormOf(buildDefaults));
    expect([untouched.strikeMin, untouched.strikeMax]).toEqual(['', '']);
    expect(criteriaQueryParams('build', untouched, buildDefaults)).toBeUndefined();
  });

  it('🚨 全腿：新露出的价差框呈空，且期限段两端也空 —— 提交时一维都不下发', () => {
    const untouched = normalizeCriteriaForm(criteriaFormOf(allDefaults));
    expect(untouched).toEqual(criteriaFormOf(allDefaults));
    expect(untouched.relativeSpreadMax).toBe('');
    expect([untouched.dteMin, untouched.dteMax]).toEqual(['', '']);
    expect(criteriaQueryParams('all', untouched, allDefaults)).toBeUndefined();
  });

  it('收租（五行本来就全在）同样零变化 —— 一格未动 ⇒ 逐字段等于默认值投影', () => {
    const untouched = normalizeCriteriaForm(criteriaFormOf(defaults()));
    expect(untouched).toEqual(criteriaFormOf(defaults()));
    expect(criteriaQueryParams('rent', untouched, defaults())).toBeUndefined();
  });
});

// ═══════════ ③ 改动检测：定标不算改，清空算改 ═══════════

describe('FR-012 —— 哪些维度被用户动过', () => {
  const base = criteriaFormOf(defaults());

  it('原样未动 ⇒ 零维改动', () => {
    expect(changedCriteria(base, defaults())).toEqual([]);
  });

  it('🚨 定标差异不算改动（`0.24` 与 `0.2400` 是同一个值）', () => {
    expect(changedCriteria({ ...base, premiumMin: '0.2400' }, defaults())).toEqual([]);
  });

  it('清空一个有默认值的框 = 覆盖为「不限」，算改动', () => {
    expect(changedCriteria({ ...base, strikeMax: '' }, defaults())).toEqual(['strikeMax']);
  });

  it('🚨 DTE 只改一端也只算**一个**维度 —— 段是一个维度、值是闭区间', () => {
    expect(changedCriteria({ ...base, dteMax: '50' }, defaults())).toEqual(['dteBand']);
  });

  it('🚨 OI 与 Vol 同属活性**一个**维度 —— 拆成两维会让同一条腿在两行计数里各记一次', () => {
    expect(changedCriteria({ ...base, oiMin: '50' }, defaults())).toEqual(['livenessMin']);
    expect(changedCriteria({ ...base, oiMin: '50', volMin: '5' }, defaults())).toEqual([
      'livenessMin',
    ]);
  });

  it('行权价上下界是**两个**独立维度（与 DTE 段蓄意不同构）', () => {
    const changed = changedCriteria({ ...base, strikeMin: '100', strikeMax: '128' }, defaults());
    expect(changed).toEqual(['strikeMax', 'strikeMin']);
  });
});

// ═══════════ ④ 成对维度的半空归零 ═══════════

describe('🚨 成对维度：任一端清空 ⇒ 整维回「不限」', () => {
  const base = criteriaFormOf(defaults());

  it('活性任一支放到不限 ⇒ 整维不限（OR 的一支恒成立，另一支就再挡不住谁）', () => {
    expect(normalizeCriteriaForm({ ...base, volMin: '' })).toMatchObject({
      oiMin: '',
      volMin: '',
    });
  });

  it('DTE 半个区间不是合法维度值 ⇒ 两端一起清空（契约只给一端直接 400）', () => {
    expect(normalizeCriteriaForm({ ...base, dteMin: '' })).toMatchObject({
      dteMin: '',
      dteMax: '',
    });
  });

  it('🚫 行权价**不**归零 —— 上下界是两个独立维度，单边不限是合法值', () => {
    expect(normalizeCriteriaForm({ ...base, strikeMin: '', strikeMax: '128' })).toMatchObject({
      strikeMin: '',
      strikeMax: '128',
    });
  });
});

// ═══════════ ⑤ 表单 → query 参数 ═══════════

describe('FR-012 —— 提交映射（缺键 = 未覆盖，空串 = 覆盖为不限）', () => {
  const base = criteriaFormOf(defaults());

  it('🚨 一维都没改 ⇒ `undefined`（= 首屏 / 复位，服务端三视角全走默认值）', () => {
    expect(criteriaQueryParams('rent', base, defaults())).toBeUndefined();
  });

  it('🚫 系统默认值 MUST NOT 回传 —— 只带改过的那几维', () => {
    const params = criteriaQueryParams('rent', { ...base, strikeMax: '128' }, defaults());
    expect(params).toEqual({ perspective: 'rent', strikeMax: '128' });
  });

  it('🚨 DTE 与活性**成对**下发 —— 只给一端服务端直接 400', () => {
    expect(criteriaQueryParams('rent', { ...base, dteMax: '50' }, defaults())).toEqual({
      perspective: 'rent',
      dteMin: '30',
      dteMax: '50',
    });
    expect(criteriaQueryParams('rent', { ...base, oiMin: '50' }, defaults())).toEqual({
      perspective: 'rent',
      oiMin: '50',
      volMin: '1',
    });
  });

  it('🚨 空串下发的是空串本身（覆盖为不限），MUST NOT 省略该键 —— 省略 = 没动过', () => {
    expect(criteriaQueryParams('rent', { ...base, strikeMax: '' }, defaults())).toEqual({
      perspective: 'rent',
      strikeMax: '',
    });
  });

  it('百分数换回无量纲比例（`20` → `0.2000`）', () => {
    expect(
      criteriaQueryParams('build', { ...base, relativeSpreadMax: '20' }, defaults()),
    ).toMatchObject({ relativeSpreadMax: '0.2000' });
  });

  it('覆盖作用于**当前视角**（`perspective` 恒随参数同行）', () => {
    expect(criteriaQueryParams('build', { ...base, premiumMin: '0.5' }, defaults())).toEqual({
      perspective: 'build',
      premiumMin: '0.5',
    });
  });

  it('🚫 非数字输入不下发那一维（宁可当没改，也不把 `NaN` 送上去）', () => {
    expect(criteriaQueryParams('rent', { ...base, strikeMax: 'abc' }, defaults())).toBeUndefined();
  });
});

// ═══════════ ⑥ 三态 → 计数行（仅收窄出计数） ═══════════

describe('🚨 FR-029 / FR-030 —— 仅**收窄**的维度出计数', () => {
  it('未覆盖 ⇒ 零行', () => {
    expect(criteriaCountLines(perspective())).toEqual([]);
  });

  it('🚫 放宽也**不**出计数 —— 放宽不产生排除，显示出来是噪音', () => {
    const widened = perspective({
      outcomes: outcomes({ dteBand: { state: 'widened', excludedCount: 0 } }),
    });
    expect(criteriaCountLines(widened)).toEqual([]);
  });

  it('收窄 ⇒ 该维出一行，措辞是「之外还有 N 条」而非「被系统滤掉」', () => {
    const narrowed = perspective({
      outcomes: outcomes({ strikeMax: { state: 'narrowed', excludedCount: 8 } }),
    });
    const lines = criteriaCountLines(narrowed);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.key).toBe('strikeMax');
    expect(lines[0]?.text).toContain('之外还有 8 条');
    expect(lines[0]?.text).not.toContain('滤掉');
  });

  it('活性一个维度只出**一行**（不是 OI 一行 Vol 一行）', () => {
    const narrowed = perspective({
      outcomes: outcomes({ livenessMin: { state: 'narrowed', excludedCount: 3 } }),
    });
    expect(criteriaCountLines(narrowed).map((l) => l.key)).toEqual(['livenessMin']);
  });

  it('收窄了却一条都没排除 ⇒ 不出行（「之外还有 0 条」是句自相矛盾的话）', () => {
    const narrowed = perspective({
      outcomes: outcomes({ premiumMin: { state: 'narrowed', excludedCount: 0 } }),
    });
    expect(criteriaCountLines(narrowed)).toEqual([]);
  });

  it('契约未到手 ⇒ 零行', () => {
    expect(criteriaCountLines(null)).toEqual([]);
  });
});

// ═══════════ ⑦ 入口徽标 = 已覆盖维度数（不是排除条数） ═══════════

describe('入口徽标数', () => {
  it('未覆盖 ⇒ 0', () => {
    expect(criteriaOverrideCount(perspective())).toBe(0);
  });

  it('🚨 放宽也计入 —— 徽标数的是「你动过几维」，与出不出计数是两件事', () => {
    const mixed = perspective({
      outcomes: outcomes({
        strikeMax: { state: 'narrowed', excludedCount: 8 },
        dteBand: { state: 'widened', excludedCount: 0 },
      }),
    });
    expect(criteriaOverrideCount(mixed)).toBe(2);
    expect(criteriaCountLines(mixed)).toHaveLength(1);
  });

  it('契约未到手 ⇒ 0（不闪一个徽标）', () => {
    expect(criteriaOverrideCount(null)).toBe(0);
  });
});

// ═══════════ ⑧ 表单等值（抽屉副标题「未提交」判据） ═══════════

describe('未提交判据', () => {
  const base: CriteriaForm = criteriaFormOf(defaults());

  it('草稿与已提交逐字相同 ⇒ 无未提交改动', () => {
    expect(changedCriteria(base, defaults())).toEqual([]);
  });

  it('改了两项 ⇒ 两维', () => {
    expect(changedCriteria({ ...base, strikeMax: '128', oiMin: '50' }, defaults())).toHaveLength(2);
  });
});
