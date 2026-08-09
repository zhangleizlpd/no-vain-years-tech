import { describe, expect, it } from 'vitest';
import {
  extractCoefficients,
  findOffenders,
  selfProbe,
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
