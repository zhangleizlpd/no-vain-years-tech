import { describe, expect, it } from 'vitest';
import {
  BAND_LITERAL_RE,
  CLIENT_DEFAULT_COMPUTE_RE,
  DELTA_BAND_SHAPE_RE,
  INLINE_COEFFICIENT_RE,
  extractPadRatio,
  windowSelfProbe,
  clientDefaultProbe,
  COARSE_DECISION_RE,
  coarseProbe,
  DTE_BOUND_RE,
  extractCoefficients,
  extractMarchThresholds,
  extractRecallThresholds,
  findOffenders,
  findShapeHits,
  findShapeOffenders,
  findStorageVocab,
  fwdIsolationSelfProbe,
  MEMBERSHIP_PREDICATE_RE,
  WINDOW_MODULE_REF_RE,
  membershipProbe,
  marchSelfProbe,
  recallSelfProbe,
  selfProbe,
  shapePatternProbe,
  storageVocabProbe,
  stripComments,
} from './check-optionsdesk-rule-constants';

/** 镜像 anchor.rules.ts 的四处系数声明（只留检查关心的形状）。 */
const RULES_SOURCE = `
import { Prisma } from '../generated/prisma/client';

/** 愿买锚系数 0.8V。 */
export const W_COEFFICIENT = new Prisma.Decimal('0.8');

/** 四区间内段下界 0.6V。 */
export const ZONE_FLOOR_COEFFICIENT = new Prisma.Decimal('0.6');

/** 四区间内段上界 1.2V。 */
export const ZONE_CEILING_COEFFICIENT = new Prisma.Decimal('1.2');

export const WILLING_SELL_COEFFICIENTS = {
  longHold: new Prisma.Decimal('1.2'),
  rent: new Prisma.Decimal('1.0'),
};
`;

describe('extractCoefficients', () => {
  it('抽出四处声明，去重且只留带小数点的', () => {
    // longHold 与 ZONE_CEILING 同为 1.2 → 去重；rent 的 1.0 不在抽取名单内
    expect(extractCoefficients(RULES_SOURCE)).toEqual(['0.8', '0.6', '1.2']);
  });

  it('换掉 Prisma.Decimal 写法 → 抽取落空（由 selfProbe 兜住，不静默）', () => {
    const changed = RULES_SOURCE.replace(/new Prisma\.Decimal\('([\d.]+)'\)/g, "toDecimal('$1')");
    expect(extractCoefficients(changed)).toEqual([]);
  });

  it('只在注释里出现的数值不被抽成常量', () => {
    expect(
      extractCoefficients("// export const W_COEFFICIENT = new Prisma.Decimal('0.8')"),
    ).toEqual([]);
  });
});

describe('selfProbe —— 防「检查变平凡绿」的那一臂', () => {
  it('抽取落空 → 报错，而不是放行', () => {
    expect(selfProbe(RULES_SOURCE, [])).toMatch(/平凡绿/);
  });

  it('抽取口径与扫描口径不一致 → 报错', () => {
    expect(selfProbe(RULES_SOURCE, ['0.8', '9.9'])).toMatch(/9\.9/);
  });

  it('规则文件含全部被禁字面量 → 通过', () => {
    expect(selfProbe(RULES_SOURCE, extractCoefficients(RULES_SOURCE))).toBeNull();
  });
});

describe('findOffenders', () => {
  const FORBIDDEN = ['0.8', '0.6', '1.2'];

  it('import 常量的文件零命中', () => {
    const files = [
      {
        name: 'compute-anchor.ts',
        source: "import { W_COEFFICIENT } from './anchor.rules';\nconst w = v.mul(W_COEFFICIENT);",
      },
    ];
    expect(findOffenders(files, FORBIDDEN)).toEqual([]);
  });

  it('🚨 反例臂：抄了字面量的文件必被抓出（含具体命中值）', () => {
    const files = [
      { name: 'bad.ts', source: "const w = v.mul(new Prisma.Decimal('0.8'));" },
      { name: 'worse.ts', source: 'const lo = v.times(0.6);\nconst hi = v.times(1.2);' },
    ];
    expect(findOffenders(files, FORBIDDEN)).toEqual([
      { name: 'bad.ts', literals: ['0.8'] },
      { name: 'worse.ts', literals: ['0.6', '1.2'] },
    ]);
  });

  it('注释里提到系数不算违规 —— 那是正确的文档', () => {
    const files = [
      {
        name: 'documented.ts',
        source: '// 愿买锚 = 0.8V，上界 1.2V\nconst w = mul(W_COEFFICIENT);',
      },
      { name: 'block-comment.ts', source: '/** 下界 0.6V。 */\nexport const x = 1;' },
    ];
    expect(findOffenders(files, FORBIDDEN)).toEqual([]);
  });
});

/** 镜像 leg-recall.rules.ts 的四处阈值声明（只留检查关心的形状）。 */
const RECALL_SOURCE = `
export const PREMIUM_FLOOR: PremiumFloorParams = {
  absolute: new Prisma.Decimal('0.20'),
  spotRatio: new Prisma.Decimal('0.0012'),
};

export const LIQUIDITY_MAX_RELATIVE_SPREAD = new Prisma.Decimal('0.35');

export const QUALITY_CEILING_SPOT_RATIO = new Prisma.Decimal('0.04');
`;

describe('extractRecallThresholds —— 050 不变量 #2', () => {
  it('抽出四个阈值，顺序固定为 绝对下限 / spot 比例 / 价差上界 / 成色兜底比例', () => {
    expect(extractRecallThresholds(RECALL_SOURCE)).toEqual(['0.20', '0.0012', '0.35', '0.04']);
  });

  it('🚨 蓄意不过滤不去重 —— 少抽到一个要能被探针看见，而不是静默缩小扫描面', () => {
    const renamed = RECALL_SOURCE.replace('LIQUIDITY_MAX_RELATIVE_SPREAD', 'MAX_SPREAD');
    expect(extractRecallThresholds(renamed)).toEqual(['0.20', '0.0012', '0.04']);
    expect(recallSelfProbe(renamed, extractRecallThresholds(renamed))).toMatch(/平凡绿/);
  });

  it('🚨 052 成色比例入表 —— 漏掉它就等于新阈值可被抄到别处而无人拦', () => {
    const withoutQuality = RECALL_SOURCE.replace('QUALITY_CEILING_SPOT_RATIO', 'QUALITY_RATIO');
    expect(recallSelfProbe(withoutQuality, extractRecallThresholds(withoutQuality))).toMatch(
      /平凡绿/,
    );
  });

  it('只在注释里出现的阈值不被抽成常量', () => {
    expect(
      extractRecallThresholds(
        "// export const LIQUIDITY_MAX_RELATIVE_SPREAD = new Prisma.Decimal('0.35')",
      ),
    ).toEqual([]);
  });
});

describe('recallSelfProbe —— 整数阈值那一臂', () => {
  it('阈值被写成整数 → 报错并给出改法（整数不可子串扫）', () => {
    const integral = RECALL_SOURCE.replace("'0.20'", "'1'");
    const probe = recallSelfProbe(integral, extractRecallThresholds(integral));
    expect(probe).toMatch(/整数/);
    expect(probe).toMatch(/MUST NOT 放宽/);
  });

  it('抽取口径与扫描口径不一致 → 报错', () => {
    expect(recallSelfProbe(RECALL_SOURCE, ['0.20', '0.0012', '0.35', '9.9'])).toMatch(/9\.9/);
  });

  it('四个阈值齐全且均在源码里 → 通过', () => {
    expect(recallSelfProbe(RECALL_SOURCE, extractRecallThresholds(RECALL_SOURCE))).toBeNull();
  });
});

describe('DTE 段界的比较表达式判据 —— 050 不变量 #3', () => {
  it('🚨 正例臂：`dteDays <= 49` 这类字面量比较必被抓出', () => {
    const files = [{ name: 'bad.ts', source: 'if (dteDays <= 49 && dteDays >= 1) return true;' }];
    expect(findShapeOffenders(files, DTE_BOUND_RE)).toEqual([
      { name: 'bad.ts', hits: ['dteDays <= 49', 'dteDays >= 1'] },
    ]);
  });

  it('🚨 反例臂：`dteDays <= 0` 是合法守卫, MUST NOT 命中 —— 否则判据恒红', () => {
    const files = [
      {
        name: 'leg-derive.rules.ts',
        source: 'if (!Number.isFinite(dteDays) || dteDays <= 0) return null;',
      },
    ];
    expect(findShapeOffenders(files, DTE_BOUND_RE)).toEqual([]);
  });

  it('比常量而非字面量的写法零命中（这正是要求的写法）', () => {
    const files = [{ name: 'ok.ts', source: 'return dteDays >= band.min && dteDays <= band.max;' }];
    expect(findShapeOffenders(files, DTE_BOUND_RE)).toEqual([]);
  });

  it('注释里写 `dteDays <= 49` 不算违规 —— 那是正确的文档', () => {
    const files = [{ name: 'doc.ts', source: '// 047 判据是 dteDays <= 49\nconst x = 1;' }];
    expect(findShapeOffenders(files, DTE_BOUND_RE)).toEqual([]);
  });
});

describe('闭区间带的对象形状判据 —— 050 不变量 #4', () => {
  it('🚨 抄了带字面量的文件必被抓出（含具体命中片段）', () => {
    const files = [{ name: 'bad.ts', source: 'const b = { min: 0.4, max: 0.55 };' }];
    expect(findShapeOffenders(files, BAND_LITERAL_RE)).toEqual([
      { name: 'bad.ts', hits: ['{ min: 0.4, max: 0.55 }'] },
    ]);
  });

  it('import 常量的文件零命中', () => {
    const files = [
      {
        name: 'ok.ts',
        source: "import { BUILD_RECOMMEND_ABS_DELTA_BAND } from './leg-mark.rules';",
      },
    ];
    expect(findShapeOffenders(files, BAND_LITERAL_RE)).toEqual([]);
  });
});

describe('findShapeHits —— `g` 标志的 lastIndex 不许跨调用残留', () => {
  it('同一个正则连续两次调用返回相同结果', () => {
    const src = 'const b = { min: 0.4, max: 0.55 };';
    expect(findShapeHits(src, BAND_LITERAL_RE)).toEqual(findShapeHits(src, BAND_LITERAL_RE));
  });
});

describe('shapePatternProbe —— 两侧探针都健在', () => {
  it('现役正则的正例臂与反例臂均通过', () => {
    expect(shapePatternProbe()).toBeNull();
  });
});

describe('findStorageVocab —— 052 不变量 #5（检索 port 零存储侧词汇）', () => {
  it('查询语义命中：分页 / 游标 / 查询片段', () => {
    expect(findStorageVocab('const p = { take: 50, skip: 10, cursor: id };')).toEqual([
      'take',
      'skip',
      'cursor',
    ]);
  });

  it('ORM 命名空间命中 —— `Prisma.Decimal` 也不许进接口（金额量纲经判据入参类型带入）', () => {
    expect(findStorageVocab('readonly spot: Prisma.Decimal;')).toEqual(['prisma']);
  });

  it('注释里写这些词是**正确的文档**，不是违规', () => {
    const src = '// 🚫 接口 MUST NOT 出现 cursor / offset\nreadonly perspectives: LegTab[];';
    expect(findStorageVocab(src)).toEqual([]);
  });

  it('业务词零命中 —— 视角 / 候选 / 标的价都不该被误伤', () => {
    const src =
      'export interface LegRetrievalResult { readonly candidates: readonly LegCandidate[]; readonly spot: number }';
    expect(findStorageVocab(src)).toEqual([]);
  });

  it('大小写不敏感（`PRISMA` 与 `Prisma` 同判）', () => {
    expect(findStorageVocab('type X = PRISMA.Decimal;')).toEqual(['prisma']);
  });
});

describe('storageVocabProbe —— 两侧探针都健在', () => {
  it('现役词表的正例臂与反例臂均通过', () => {
    expect(storageVocabProbe()).toBeNull();
  });
});

describe('COARSE_DECISION_RE —— 052 不变量 #6（粗排层恒等）', () => {
  it('判据 / 重排词汇命中', () => {
    expect(
      findShapeHits('if (a >= b) return xs.filter(Boolean).sort(cmp);', COARSE_DECISION_RE),
    ).toEqual(['if', '>=', 'filter', 'sort']);
  });

  it('泛型恒等实现零命中 —— `<T>` 不许被 `<=` 误伤（那会让判据恒红）', () => {
    const src = 'export function coarseRank<T>(xs: readonly T[]): readonly T[] { return xs; }';
    expect(findShapeHits(src, COARSE_DECISION_RE)).toEqual([]);
  });

  it('注释里写 `filter` 是**正确的文档**，不是违规', () => {
    expect(findShapeHits('// 🚫 MUST NOT filter\nreturn xs;', COARSE_DECISION_RE)).toEqual([]);
  });

  it('词内子串不误伤（`identity` 里的 `if` / `resort` 里的 `sort`）', () => {
    expect(findShapeHits('const identity = resortable;', COARSE_DECISION_RE)).toEqual([]);
  });
});

describe('coarseProbe —— 两侧探针都健在', () => {
  it('现役正则的正例臂与反例臂均通过', () => {
    expect(coarseProbe()).toBeNull();
  });
});

describe('MEMBERSHIP_PREDICATE_RE —— 052 不变量 #7（成员判据只住召回层）', () => {
  it('六维判据与硬门槛的调用命中', () => {
    expect(
      findShapeHits(
        'if (failedCriteria(c, l).length === 0 && passesHardGates(t, ch, l)) keep(l);',
        MEMBERSHIP_PREDICATE_RE,
      ),
    ).toEqual(['failedCriteria(', 'passesHardGates(']);
  });

  it('🚨 反例臂：默认值解析 MUST NOT 命中 —— use case 侧本来就要读得到它们', () => {
    expect(
      findShapeHits(
        'const d = defaultCriteriaByTab(chain); const f = resolvePremiumFloor(spot);',
        MEMBERSHIP_PREDICATE_RE,
      ),
    ).toEqual([]);
  });

  it('注释里提到判据是**正确的文档**，不是违规', () => {
    expect(
      findShapeHits('// 成员判定走 failedCriteria(criteria, leg)', MEMBERSHIP_PREDICATE_RE),
    ).toEqual([]);
  });

  it('词内子串不误伤（`myFailedCriteria(` 是别的函数）', () => {
    expect(findShapeHits('myFailedCriteria(x);', MEMBERSHIP_PREDICATE_RE)).toEqual([]);
  });
});

describe('membershipProbe —— 两侧探针都健在', () => {
  it('现役词表的正例臂与反例臂均通过', () => {
    expect(membershipProbe()).toBeNull();
  });
});

describe('CLIENT_DEFAULT_COMPUTE_RE —— 052 不变量 #8（客户端零处自算默认值）', () => {
  it('抄服务端的默认值解析 / 阈值常量名即命中', () => {
    expect(
      findShapeHits(
        'const f = resolvePremiumFloor(s); const d = defaultCriteriaByTab(c);',
        CLIENT_DEFAULT_COMPUTE_RE,
      ),
    ).toEqual(['resolvePremiumFloor', 'defaultCriteriaByTab']);
    expect(
      findShapeHits('if (oi >= OPEN_INTEREST_FLOOR) keep();', CLIENT_DEFAULT_COMPUTE_RE),
    ).toEqual(['OPEN_INTEREST_FLOOR']);
  });

  it('🚨 `spot` 直接参与乘除即命中 —— 六维里两维的默认值就是 spot 的函数', () => {
    expect(findShapeHits('const c = spot * (1 + RATIO);', CLIENT_DEFAULT_COMPUTE_RE)).toEqual([
      'spot *',
    ]);
    expect(findShapeHits('const r = premium / spot;', CLIENT_DEFAULT_COMPUTE_RE)).toEqual([
      '/ spot',
    ]);
  });

  it('🚨 反例臂：读服务端下发的值 MUST NOT 命中 —— 那正是本条要求客户端做的事', () => {
    expect(
      findShapeHits('const form = criteriaFormOf(criteria.defaults);', CLIENT_DEFAULT_COMPUTE_RE),
    ).toEqual([]);
  });

  it('🚨 反例臂：046 色带那份 `spot` 是**画图**不是判据 —— 传参与取属性都不该命中', () => {
    expect(
      findShapeHits(
        'const p = bandPosition(spot, floor, ceiling); const left = `${spot.pct}%`;',
        CLIENT_DEFAULT_COMPUTE_RE,
      ),
    ).toEqual([]);
  });

  it('注释里解释这条禁令是**正确的文档**，不是违规', () => {
    expect(
      findShapeHits(
        '// 🚫 MUST NOT 写 spot * (1 + X) —— 默认值由服务端解',
        CLIENT_DEFAULT_COMPUTE_RE,
      ),
    ).toEqual([]);
  });

  it('词内子串不误伤（`spotPosition` / `hotspots` 不是 `spot`）', () => {
    expect(
      findShapeHits(
        'const p = spotPosition(a); const n = hotspots / 2;',
        CLIENT_DEFAULT_COMPUTE_RE,
      ),
    ).toEqual([]);
  });
});

describe('clientDefaultProbe —— 两侧探针都健在', () => {
  it('现役词表的正例臂与反例臂均通过', () => {
    expect(clientDefaultProbe()).toBeNull();
  });
});

describe('stripComments', () => {
  it('块注释 + 行首注释 + **行尾**注释都剥掉，代码保留', () => {
    const src = '/* 1.2 */\n// 0.6\nconst a = 1; // 0.8\nconst b = 2;';
    const out = stripComments(src);
    expect(out).not.toMatch(/1\.2|0\.8|0\.6/);
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('不把字符串里的 https:// 拦腰截断', () => {
    expect(stripComments("const u = 'https://x.example/v1';")).toContain("'https://x.example/v1'");
  });
});

describe('068 不变量 #9 —— 窗判据单点', () => {
  const DELTA_SOURCE = [
    'export const BUILD_DELTA_BAND: DeltaBand = {',
    "  lower: new Prisma.Decimal('0.10'),",
    "  upper: new Prisma.Decimal('0.45'),",
    '};',
    'export const RENT_DELTA_BAND: DeltaBand = {',
    "  lower: new Prisma.Decimal('0.05'),",
    "  upper: new Prisma.Decimal('0.32'),",
    '};',
    "export const MONEYNESS_PAD_RATIO = new Prisma.Decimal('0.025');",
  ].join('\n');

  it('extractPadRatio 抽出 pad; 常量改名 ⇒ undefined + 探针报平凡绿', () => {
    expect(extractPadRatio(DELTA_SOURCE)).toBe('0.025');
    const renamed = DELTA_SOURCE.replace('MONEYNESS_PAD_RATIO', 'PAD');
    expect(extractPadRatio(renamed)).toBeUndefined();
    expect(windowSelfProbe(renamed, extractPadRatio(renamed))).toMatch(/平凡绿/);
  });

  it('windowSelfProbe: 带形状少于 4 个 ⇒ 报形状判据平凡绿; 完整源 ⇒ null', () => {
    const oneBand = DELTA_SOURCE.split('\n').slice(4).join('\n');
    expect(windowSelfProbe(oneBand, '0.025')).toMatch(/形状/);
    expect(windowSelfProbe(DELTA_SOURCE, '0.025')).toBeNull();
  });

  it('DELTA_BAND_SHAPE_RE: 命中 lower/upper 直挂 Decimal, 不命中 {min,max} 与 lowerBound', () => {
    expect(findShapeHits("lower: new Prisma.Decimal('0.1')", DELTA_BAND_SHAPE_RE)).toHaveLength(1);
    expect(findShapeHits('{ min: 0.4, max: 0.55 }', DELTA_BAND_SHAPE_RE)).toHaveLength(0);
    expect(
      findShapeHits("lowerBound: new Prisma.Decimal('0.1')", DELTA_BAND_SHAPE_RE),
    ).toHaveLength(0);
  });

  it('INLINE_COEFFICIENT_RE: 命中内联 Decimal 乘法, 不命中具名常量乘法', () => {
    expect(findShapeHits(".times(new Prisma.Decimal('0.7'))", INLINE_COEFFICIENT_RE)).toHaveLength(
      1,
    );
    expect(
      findShapeHits('.times(QUALITY_CEILING_SPOT_RATIO.plus(1))', INLINE_COEFFICIENT_RE),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 069 不变量 #10 —— 行军形状参数
// ─────────────────────────────────────────────────────────────────────────────

/** 镜像 leg-march.rules.ts 的两处参数声明（只留检查关心的形状；取值蓄意与实装不同）。 */
const MARCH_SOURCE = `
import { Prisma } from '../generated/prisma/client';

/** 形状条件的衰减比例帽 β。 */
export const MARCH_DECAY_REBOUND_BETA = new Prisma.Decimal('1.7');

/** 形状条件的绝对帽 γ。 */
export const MARCH_DECAY_ABSOLUTE_CAP_GAMMA = new Prisma.Decimal('0.004');
`;

describe('070 不变量 #11 —— 窗与 fwd 管道互不渗透', () => {
  it('WINDOW_MODULE_REF_RE: 静态 import / re-export / 动态 import 的 leg-window 引用全命中', () => {
    for (const src of [
      "import { bootstrapWindowFor } from './leg-window.rules';",
      "export * from './leg-window.rules';",
      "const w = await import('./leg-window.rules');",
    ]) {
      expect(findShapeHits(src, WINDOW_MODULE_REF_RE).length).toBeGreaterThan(0);
    }
  });

  it('🚨 反例臂: fwd 管道自身文件名与相邻模块不许误伤 —— 否则闸恒红', () => {
    for (const src of [
      "import { marchEvidence } from './leg-fwd-chain.rules';",
      "import { resolveMarchParams } from './leg-march.rules';",
      "import { resolveDeltaSurfaceWindow } from './leg-delta-surface.rules';",
    ]) {
      expect(findShapeHits(src, WINDOW_MODULE_REF_RE)).toEqual([]);
    }
  });

  it('注释里提到 leg-window 是**正确的文档**, 不是违规 (扫描在 stripComments 之后)', () => {
    const src =
      '// 窗判据单点住 leg-window.rules.ts (#9), 本文件禁引 —— 见结构闸 #11\nconst x = 1;';
    expect(findShapeHits(stripComments(src), WINDOW_MODULE_REF_RE)).toEqual([]);
  });

  it('fwdIsolationSelfProbe: 现役正反两臂均通过', () => {
    expect(fwdIsolationSelfProbe()).toBeNull();
  });
});

describe('extractMarchThresholds —— 069 不变量 #10', () => {
  it('抽出 β / γ 两个参数', () => {
    expect(extractMarchThresholds(MARCH_SOURCE)).toEqual(['1.7', '0.004']);
  });

  it('常量改名 ⇒ 抽取缺项, 探针报「平凡绿」', () => {
    const renamed = MARCH_SOURCE.replace('MARCH_DECAY_REBOUND_BETA', 'BETA_RENAMED');
    expect(marchSelfProbe(renamed, extractMarchThresholds(renamed))).toMatch(/平凡绿/);
  });

  it('参数写成整数 ⇒ 探针硬拦 (整数不可子串扫)', () => {
    const integral = MARCH_SOURCE.replace("'1.7'", "'2'");
    expect(marchSelfProbe(integral, extractMarchThresholds(integral))).toMatch(/整数/);
  });

  it('健康源自检通过', () => {
    expect(marchSelfProbe(MARCH_SOURCE, extractMarchThresholds(MARCH_SOURCE))).toBeNull();
  });
});
