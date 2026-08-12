import { describe, expect, it } from 'vitest';
import {
  BAND_LITERAL_RE,
  COARSE_DECISION_RE,
  coarseProbe,
  DTE_BOUND_RE,
  extractCoefficients,
  extractRecallThresholds,
  findOffenders,
  findShapeHits,
  findShapeOffenders,
  findStorageVocab,
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

/** 镜像 leg-recall.rules.ts 的三处阈值声明（只留检查关心的形状）。 */
const RECALL_SOURCE = `
export const PREMIUM_FLOOR: PremiumFloorParams = {
  absolute: new Prisma.Decimal('0.20'),
  spotRatio: new Prisma.Decimal('0.0012'),
};

export const LIQUIDITY_MAX_RELATIVE_SPREAD = new Prisma.Decimal('0.35');
`;

describe('extractRecallThresholds —— 050 不变量 #2', () => {
  it('抽出三个阈值，顺序固定为 绝对下限 / spot 比例 / 价差上界', () => {
    expect(extractRecallThresholds(RECALL_SOURCE)).toEqual(['0.20', '0.0012', '0.35']);
  });

  it('🚨 蓄意不过滤不去重 —— 少抽到一个要能被探针看见，而不是静默缩小扫描面', () => {
    const renamed = RECALL_SOURCE.replace('LIQUIDITY_MAX_RELATIVE_SPREAD', 'MAX_SPREAD');
    expect(extractRecallThresholds(renamed)).toEqual(['0.20', '0.0012']);
    expect(recallSelfProbe(renamed, extractRecallThresholds(renamed))).toMatch(/平凡绿/);
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
    expect(recallSelfProbe(RECALL_SOURCE, ['0.20', '0.0012', '9.9'])).toMatch(/9\.9/);
  });

  it('三个阈值齐全且均在源码里 → 通过', () => {
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
