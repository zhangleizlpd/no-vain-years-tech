#!/usr/bin/env node
/**
 * check-optionsdesk-rule-constants.ts — optionsdesk **可调策略参数单点**的机器守门。
 *
 * 九条不变量。#8 以外的扫描面是 `apps/server/src/optionsdesk/`，**第八条扫的是客户端**：
 *
 * | # | 不变量 | 判据形态 | 出处 |
 * | - | ------ | -------- | ---- |
 * | 1 | 档位系数只住 `anchor.rules.ts` | 字面量**子串扫描** | 045 SC-005 |
 * | 2 | 召回层可调阈值只住 `leg-recall.rules.ts` | 字面量**子串扫描** | 050 FR-007 / SC-009 · 052 FR-005 |
 * | 3 | 三段 DTE 界只住 `leg-recall.rules.ts` | **比较表达式**扫描 | 050 SC-009 |
 * | 4 | 闭区间带字面量只住 `leg-recall` / `leg-mark` | **对象形状**扫描 | 050 SC-009 |
 * | 5 | 检索 port 接口零存储侧词汇 | **词表**扫描 | 052 FR-031 |
 * | 6 | 粗排层恒等 + 五层入口各有 spec | **词表**扫描 + 文件存在 | 052 FR-004 / SC-010 |
 * | 7 | 六维成员判据只住 `leg-recall.rules.ts` | **词表**扫描 | 052 FR-003 |
 * | 8 | **客户端零处自算检索条件默认值** | **词表 + 算式形状**扫描 | 052 FR-011 / Guardrail 6 |
 * | 9 | 068 窗判据只住 `leg-delta-surface` / `leg-window` | **形状**扫描 ×2 + pad **子串** | 068 FR-002 / SC-004 |
 *
 * 🚨 **#5/#6/#7 为什么在这里而不在各自的 `*.spec.ts`**：它们要读源码，而 Small 档禁磁盘
 * I/O（testing.md）⇒ 治理扫描一律归 `scripts/checks/`。同 #1 当年从 `anchor.rules.spec.ts`
 * 尾部两个 `it()` 迁出来的那条路径，判据不变、只是换了执行面。
 *
 * 🚨 **三种判据形态不是花样，是被扫描对象的形状逼出来的**（2026-08-11 读实现后定）：
 * - #2 沿用 #1 的子串扫描，因为门槛阈值也是小数。
 * - #3 **不能**走子串扫描：`extractCoefficients` 显式过滤掉不含小数点的字面量，注释原文
 *   「整数系数当子串扫会把行号 / 数组下标全扫成违规」。DTE 界 `1` / `49` / `30` / `365` 全是
 *   整数，`1` 会命中几乎每一行。⇒ 改扫 `dteDays <op> <正整数>` 这个**语法形状**。
 *   📌 比较对象为 `0` 的形式 MUST 排除 —— `leg-derive.rules.ts` 的 `dteDays <= 0` 是 DTE≤0 时
 *   费率无定义的合法守卫，不排除会让判据**恒红**（同 047 T039 那个坑）。
 * - #4 **也不能**走子串扫描：Δ 带取值 `0.05` / `0.15` 与 `leg-tier.rules.ts` 的档界**撞值**，
 *   而子串扫认值不认名 ⇒ 会把那个文件报成违规。⇒ 改扫 `{ min: …, max: … }` 这个对象形状。
 *
 * 🚨 **#2/#3/#4 的扫描面排除 `*.spec.ts`，#1 不排除**（蓄意的不对称）：守档位系数时测试文件在
 * 扫描面内没问题（那些值不出现在断言里），但 `leg-recall.rules.spec.ts` / `leg-mark.rules.spec.ts`
 * **必须**在断言里写出边界值 —— 不排除的话，「阈值单点」与「边界有单测」两个验收条件直接互斥。
 *
 * 为什么值得一个专门的检查：
 * 这几个系数是**可调策略参数**，不是数学常数。任何一处把 `0.8` / `1.2` 抄进代码，
 * 调参时就会漏改那一处 —— 而漏改是**静默**的：类型对、测试绿、只是算出来的锚位悄悄不一致。
 * `anchor.rules.ts` 里已明写「两者 MUST 独立可配，rent 等于 1 倍 V 是取值巧合而非定义」，
 * 这个检查就是那句话的机器版本。
 *
 * 🚨 **被禁字面量从 `anchor.rules.ts` 自身派生**，不在本文件里写死 —— 否则调参时
 * 检查器自己就是第二处硬编码，正好犯它要防的错。
 *
 * 出身：原本是 `anchor.rules.spec.ts` 尾部两个 `it()`（用 `readdirSync` / `readFileSync`
 * 扫 ctx 目录）。按测试分类学 Small 档「禁磁盘 I/O」+ 治理检查归 `scripts/checks/`
 * （`check-test-size` 不变量 7）迁到这里。同时修掉原实现对 `process.cwd()` 的耦合
 * —— 那使它只在 cwd = `apps/server` 时才对（矩阵 §2 铁律 2 那个陷阱）。
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-optionsdesk-rule-constants.ts
 *   pr-validation.yml `gate-checks` job 每个 PR 无条件跑。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CTX_DIR = 'apps/server/src/optionsdesk';
/** 052 不变量 #8 的扫描面 —— 客户端侧同名 feature 目录（FR-011 的判据落在这里）。 */
const MOBILE_CTX_DIR = 'apps/mobile/src/optionsdesk';
const RULES_FILE = 'anchor.rules.ts';
/** 050 召回层：两道门槛阈值 + 三段 DTE 界的唯一落点。 */
const RECALL_RULES_FILE = 'leg-recall.rules.ts';
/** 050 打标层：两组 Δ 带的唯一落点。 */
const MARK_RULES_FILE = 'leg-mark.rules.ts';
/** 052 检索 port：接口只暴露业务语义（FR-031）。 */
const RETRIEVAL_PORT_FILE = 'leg-retrieval.port.ts';
/** 052 粗排层：当前为恒等函数，函数体零判据（FR-004 / ADR-0064 决策 1）。 */
const COARSE_RULES_FILE = 'leg-coarse.rules.ts';
/**
 * 052 五层入口的载体文件 —— 每个 MUST 有 colocate 的 Small spec（SC-010「五层各自有独立入口
 * 与独立测试」）。
 *
 * 📌 **表达层（`optionsdesk.dto.ts`）蓄意不在表内**：052 对它零改动，覆盖归 053
 * （tasks.md §故意零覆盖登记）。写在这里是为了让「少一层」是**读得出来的决定**而不是遗漏。
 */
const LAYER_ENTRY_FILES = [
  'leg-recall.rules.ts', // 召回 · 判据
  'leg-retrieval.port.ts', // 召回 · 数据来源接缝
  COARSE_RULES_FILE, // 粗排
  'leg-rank.rules.ts', // 特征加工 + 精排
  'leg-derive.rules.ts', // 特征加工 · 活跃标
] as const;
/**
 * 召回层可调阈值的个数（权利金绝对下限 / spot 比例 / 相对价差上界 / 052 成色兜底比例）
 * —— 少抽到一个就是检查变平凡绿。
 *
 * 🚨 **新增可调阈值时这个数要跟着加**：漏加等于新阈值可以被抄到别处而无人拦（052 T003 起
 * 成色比例入表，因为它同样是「T016 会调、调时必须只有一处」的策略参数）。
 * 📌 只有**小数**阈值能入表 —— 整数走不了子串扫描（见 {@link recallSelfProbe} 那一臂），
 * 故 052 的持仓量下限与候选上限 K 不在其内。
 */
const RECALL_THRESHOLD_COUNT = 4;

/**
 * 剥注释后再匹配 —— 注释里写 `1.2V 上界` 是**正确的文档**，不是硬编码
 * （同 check-test-size / check-shutdown-hooks 的纪律）。
 *
 * 🚨 **行尾注释也剥 —— 这是一个有代价的取舍，别当成默认对的写法照抄。**
 *
 * 本检查与 `check-test-size` **同极性**（都断言「违规文本不存在」），故多剥的风险方向是
 * **漏报**：若某行先出现含 `//` 的非-URL 字符串字面量、其后才是硬编码系数，该行会被截断而漏掉。
 * `check-test-size` 正因此蓄意只剥整行（它扫全仓 513 个 spec，样本面大）。
 *
 * 这里仍选择剥行尾，理由是两侧概率悬殊、且已实测：
 * - 误报侧**真实且高频** —— `const w = mul(W_COEFFICIENT); // 0.8V` 是本 ctx 的常见注解写法，
 *   不剥就是稳定误报（该缺陷由本检查的单测抓出，不是通读发现的）。
 * - 漏报侧**当前为零** —— `apps/server/src/optionsdesk/**` 实测无任何非-URL 的 `//` 字面量；
 *   扫描面只有一个 ctx 的 ~29 个文件，不是全仓。
 *
 * ⇒ 若将来本 ctx 出现 `'a//b'` 这类字面量，此取舍需重估。`(?<!:)` 已守住 `https://…`。
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/**
 * 从 `anchor.rules.ts` 源码里抽出档位系数取值。
 *
 * 只认 `new Prisma.Decimal('<num>')` 这一种写法 —— 换写法会让抽取落空，而落空由
 * {@link selfProbe} 立刻抓住（抽不出东西 = 检查变平凡绿），不会静默失效。
 */
export function extractCoefficients(rulesSource: string): string[] {
  const code = stripComments(rulesSource);
  const patterns = [
    /export\s+const\s+W_COEFFICIENT\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /export\s+const\s+ZONE_FLOOR_COEFFICIENT\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /export\s+const\s+ZONE_CEILING_COEFFICIENT\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /longHold:\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
  ];
  const found = patterns
    .map((re) => re.exec(code)?.[1])
    .filter((v): v is string => v !== undefined);
  // 只留带小数点的（整数系数当子串扫会把行号 / 数组下标全扫成违规）+ 去重
  return found.filter((s, i, all) => s.includes('.') && all.indexOf(s) === i);
}

/**
 * 探针自检：规则文件本身必须命中**全部**被禁字面量。
 *
 * 这条不是形式主义 —— 它回答 testing.md §7 那个问题「如果反例存在，这条管道能看到吗」。
 * 抽取正则失配 / 常量被改名 ⇒ FORBIDDEN 变空 ⇒ 下面的扫描恒绿。有本条才拦得住。
 */
export function selfProbe(rulesSource: string, forbidden: string[]): string | null {
  if (forbidden.length === 0) {
    return `没能从 ${RULES_FILE} 抽出任何档位系数 —— 常量写法变了？检查已变成平凡绿，必须先修抽取`;
  }
  const code = stripComments(rulesSource);
  const missing = forbidden.filter((literal) => !code.includes(literal));
  if (missing.length > 0) {
    return `${RULES_FILE} 自身不含 ${missing.join(' / ')} —— 抽取与扫描口径不一致`;
  }
  return null;
}

/** 纯函数，便于单测。返回命中被禁字面量的文件名列表。 */
export function findOffenders(
  files: { name: string; source: string }[],
  forbidden: string[],
): { name: string; literals: string[] }[] {
  return files
    .map(({ name, source }) => {
      const code = stripComments(source);
      return { name, literals: forbidden.filter((literal) => code.includes(literal)) };
    })
    .filter((f) => f.literals.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 050 不变量 #2 —— 两道门槛阈值（子串扫描，被禁字面量自 leg-recall.rules.ts 派生）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 `leg-recall.rules.ts` 源码里抽出召回层的四个小数阈值。
 *
 * 🚨 **蓄意不过滤、不去重** —— 判断全留给 {@link recallSelfProbe}，让「少抽到一个」与「阈值被
 * 写成整数」都变成**显式报错**，而不是静默缩小扫描面（那正是「检查变平凡绿」的形态）。
 */
export function extractRecallThresholds(recallSource: string): string[] {
  const code = stripComments(recallSource);
  const patterns = [
    /absolute:\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /spotRatio:\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /export\s+const\s+LIQUIDITY_MAX_RELATIVE_SPREAD\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
    /export\s+const\s+QUALITY_CEILING_SPOT_RATIO\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/,
  ];
  return patterns.map((re) => re.exec(code)?.[1]).filter((v): v is string => v !== undefined);
}

/** 同 {@link selfProbe}，但多一条「整数阈值不可子串扫」的硬拦。 */
export function recallSelfProbe(recallSource: string, thresholds: string[]): string | null {
  if (thresholds.length !== RECALL_THRESHOLD_COUNT) {
    return (
      `只从 ${RECALL_RULES_FILE} 抽到 ${thresholds.length} / ${RECALL_THRESHOLD_COUNT} 个门槛阈值 ` +
      `—— 常量写法变了？检查已变成平凡绿，必须先修抽取`
    );
  }
  const integral = thresholds.filter((t) => !t.includes('.'));
  if (integral.length > 0) {
    return (
      `阈值 ${integral.join(' / ')} 被写成整数 —— 整数当子串扫会把行号 / 数组下标全扫成违规。` +
      `MUST 写成带小数点的形态（如 '1.00'），🚫 MUST NOT 放宽本检查`
    );
  }
  const code = stripComments(recallSource);
  const missing = thresholds.filter((t) => !code.includes(t));
  if (missing.length > 0) {
    return `${RECALL_RULES_FILE} 自身不含 ${missing.join(' / ')} —— 抽取与扫描口径不一致`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 050 不变量 #3 / #4 —— 语法形状扫描（DTE 比较表达式 / 闭区间带字面量）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三段 DTE 界的判据：`dteDays <op> <正整数>`。
 *
 * 🚨 `[1-9][0-9]*` 里排除 `0` **不是洁癖** —— `leg-derive.rules.ts` 的 `dteDays <= 0`
 * 是合法守卫，不排除会让本判据恒红。已实测：收窄后现役零命中、收窄前 1 处命中。
 */
export const DTE_BOUND_RE = /dteDays\s*[<>=!]+\s*[1-9][0-9]*/g;

/** 闭区间带的字面量形状 —— Δ 带与 DTE 段共用它。 */
export const BAND_LITERAL_RE = /\{\s*min:\s*[\d.]+\s*,\s*max:\s*[\d.]+\s*\}/g;

/** 剥注释后按形状扫，返回命中的原文片段（供报错时指出具体是哪一处）。 */
export function findShapeHits(source: string, pattern: RegExp): string[] {
  return stripComments(source).match(new RegExp(pattern.source, 'g')) ?? [];
}

export function findShapeOffenders(
  files: { name: string; source: string }[],
  pattern: RegExp,
): { name: string; hits: string[] }[] {
  return files
    .map(({ name, source }) => ({ name, hits: findShapeHits(source, pattern) }))
    .filter((f) => f.hits.length > 0);
}

/**
 * 形状判据的**两侧**探针 —— 回答 `testing.md` §7 那一问「如果反例存在，这条管道能看到吗」。
 *
 * 正例臂防「判据变平凡绿」（正则写错 → 恒零命中 → 看着一直绿）；
 * 反例臂防「判据恒红」（未排除合法形态 → 每次都红 → 有人来放宽它 → 退化成平凡绿）。
 * 两条失效路径的终点是同一个，所以两臂都要有。
 */
export function shapePatternProbe(): string | null {
  const dteHit = findShapeHits('if (leg.dteDays <= 49) return true;', DTE_BOUND_RE);
  if (dteHit.length === 0) {
    return 'DTE 判据正例臂失灵：`dteDays <= 49` 未被命中 —— 判据已变平凡绿';
  }
  const dteGuard = findShapeHits(
    'if (!Number.isFinite(dteDays) || dteDays <= 0) return null;',
    DTE_BOUND_RE,
  );
  if (dteGuard.length > 0) {
    return 'DTE 判据反例臂失灵：`dteDays <= 0` 被判违规 —— 那是 DTE≤0 时费率无定义的合法守卫，判据会恒红';
  }
  const bandHit = findShapeHits('export const B = { min: 0.4, max: 0.55 };', BAND_LITERAL_RE);
  if (bandHit.length === 0) {
    return '带判据正例臂失灵：`{ min: 0.4, max: 0.55 }` 未被命中 —— 判据已变平凡绿';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 068 不变量 #9 —— 窗判据单点（Δ 带形状 / 内联系数形状 / pad 子串）
// ─────────────────────────────────────────────────────────────────────────────

/** 068 K-梯形窗：两条 Δ 带 + pad 的唯一落点。 */
const DELTA_SURFACE_FILE = 'leg-delta-surface.rules.ts';
/** 068 bootstrap 宽窗：两个矩形包络比例的唯一落点。 */
const WINDOW_RULES_FILE = 'leg-window.rules.ts';

/**
 * Δ 带对象形状 —— `lower:` / `upper:` 直挂 Decimal 字面量。
 *
 * 🚨 **带取值不走子串扫描是被撞值逼的**（同 #4 的理由）：带取值与 `leg-tier` 档界 /
 * `LIQUIDITY_MAX_RELATIVE_SPREAD` 等既有小数高频撞值，子串扫认值不认名会把无辜文件报成违规。
 * ⇒ 扫「第二份带对象」这个**形状**：出 `leg-delta-surface.rules.ts` 即红，值随标定怎么调都拦得住。
 */
export const DELTA_BAND_SHAPE_RE = /\b(?:lower|upper):\s*new\s+Prisma\.Decimal\(/g;

/**
 * 内联系数乘法形状 —— `.times(new Prisma.Decimal('…'))`。
 *
 * bootstrap 两比例（0.7 / 1.05）没法子串扫（`0.7` 撞遍全 ctx 的注释与示例串），改拦它们被
 * **抄走时必然出现的形状**：系数乘法 MUST 消费具名常量，内联字面量即第二份策略参数。
 * 实测现役全 ctx（含 rules 文件）零命中，扫描面不设豁免。
 */
export const INLINE_COEFFICIENT_RE = /\.times\(\s*new\s+Prisma\.Decimal\(\s*'[\d.]+'\s*\)\s*\)/g;

/** pad 是唯一可子串扫的窗参数（取值全 ctx 唯一，无撞值面）。 */
export function extractPadRatio(deltaSurfaceSource: string): string | undefined {
  const code = stripComments(deltaSurfaceSource);
  return /export\s+const\s+MONEYNESS_PAD_RATIO\s*=\s*new\s+Prisma\.Decimal\(\s*'([\d.]+)'\s*\)/.exec(
    code,
  )?.[1];
}

/** 同 {@link selfProbe} 一族：抽取失配 / 带形状在源文件里消失 ⇒ 显式报错，不许平凡绿。 */
export function windowSelfProbe(
  deltaSurfaceSource: string,
  pad: string | undefined,
): string | null {
  if (pad === undefined) {
    return `没能从 ${DELTA_SURFACE_FILE} 抽出 MONEYNESS_PAD_RATIO —— 常量写法变了？检查已变成平凡绿`;
  }
  if (!pad.includes('.')) {
    return `pad '${pad}' 被写成整数 —— 整数当子串扫会把行号全扫成违规，MUST 写成带小数点形态`;
  }
  const bandShapes = findShapeHits(deltaSurfaceSource, DELTA_BAND_SHAPE_RE);
  if (bandShapes.length < 4) {
    return (
      `${DELTA_SURFACE_FILE} 自身只命中 ${bandShapes.length} / 4 个带形状（两带 × lower/upper）` +
      '—— 带写法变了？形状判据已变成平凡绿'
    );
  }
  const inlineHit = findShapeHits(".times(new Prisma.Decimal('0.7'))", INLINE_COEFFICIENT_RE);
  if (inlineHit.length === 0) {
    return '内联系数判据正例臂失灵：`.times(new Prisma.Decimal(…))` 未被命中 —— 判据已变平凡绿';
  }
  const namedHit = findShapeHits(
    'axis.times(QUALITY_CEILING_SPOT_RATIO.plus(1))',
    INLINE_COEFFICIENT_RE,
  );
  if (namedHit.length > 0) {
    return '内联系数判据反例臂失灵：具名常量乘法被判违规 —— 判据会恒红';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 052 不变量 #5 —— 检索 port 接口零存储侧词汇（词表扫描）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 存储侧词表 —— 前五个是 052 T001 逐字点名的，其余是同类查询语义的近亲。
 *
 * 🚨 **`prisma` 也在表内，包括 `Prisma.Decimal`**：port 要金额量纲时 MUST 经召回判据的入参
 * 类型（`RecallLegInput` / `RecallContext`）带入，而不是自己 import 一个 ORM 命名空间。这不是
 * 洁癖 —— 允许它就等于允许「顺手再取一个 `Prisma.XxxWhereInput`」，而那正是 FR-031 要挡的。
 */
export const STORAGE_VOCAB = [
  'prisma',
  'sql',
  'cursor',
  'offset',
  'limit',
  'take',
  'skip',
  'where',
  'orderBy',
  'findMany',
  'findFirst',
  'findUnique',
] as const;

/** 剥注释后按词表扫（大小写不敏感，`Prisma` / `PRISMA` 一样命中），返回去重后的命中词。 */
export function findStorageVocab(source: string): string[] {
  const code = stripComments(source);
  const hits = code.match(new RegExp(`\\b(?:${STORAGE_VOCAB.join('|')})\\b`, 'gi')) ?? [];
  return [...new Set(hits.map((h) => h.toLowerCase()))];
}

/**
 * 词表判据的**两侧**探针（同 {@link shapePatternProbe} 的理由）。
 *
 * 正例臂防「判据变平凡绿」；反例臂防「判据恒红」—— port 里合法的业务词（视角 / 候选 / 标的价）
 * 一个都不能命中，否则总有人来放宽词表，最终退化成平凡绿。
 */
export function storageVocabProbe(): string | null {
  const hit = findStorageVocab('const page = { take: 50, cursor: id, where: { code } };');
  if (hit.length === 0) {
    return '词表判据正例臂失灵：`take` / `cursor` / `where` 未被命中 —— 判据已变平凡绿';
  }
  const legit = findStorageVocab(
    'export interface LegRetrievalQuery { readonly symbol: string; readonly perspectives: readonly LegTab[] }',
  );
  if (legit.length > 0) {
    return `词表判据反例臂失灵：合法业务签名被判违规（命中 ${legit.join(' / ')}）—— 判据会恒红`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 052 不变量 #6 —— 粗排层恒等（词表扫描）+ 五层入口各有 spec（文件存在）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判据 / 重排词汇。粗排层一旦出现其中任何一个就不再是恒等函数，而是**第二个打分点**
 * （ADR-0064 决策 1 的禁令）—— 与精排口径必然分叉，且分叉后两边都排得出顺序、都不会红。
 *
 * 🚨 `<` / `>` 单字符**不能**入表：泛型 `<T>` 会让判据恒红。收窄成 `>=` / `<=` 两个双字符
 * 比较符 —— 恒等函数里不该出现任何比较，这两个已足够拦住实际写法。
 */
export const COARSE_DECISION_RE = /\bif\b|\bfilter\b|\bsort\b|>=|<=/g;

/** 词表判据的**两侧**探针（同 {@link shapePatternProbe} 的理由）。 */
export function coarseProbe(): string | null {
  const decision = findShapeHits(
    'if (a.rate >= b.rate) return pool.filter(Boolean).sort(byRate);',
    COARSE_DECISION_RE,
  );
  if (decision.length === 0) {
    return '粗排判据正例臂失灵：`if` / `>=` / `filter` / `sort` 未被命中 —— 判据已变平凡绿';
  }
  const identity = findShapeHits(
    'export function coarseRank<T>(candidates: readonly T[]): readonly T[] { return candidates; }',
    COARSE_DECISION_RE,
  );
  if (identity.length > 0) {
    return `粗排判据反例臂失灵：恒等实现被判违规（命中 ${identity.join(' / ')}）—— 判据会恒红`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 052 不变量 #7 —— 成员判据只住召回层（词表扫描，FR-003「全仓只有一个 filter 概念」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 六维检索条件的判据函数名。它们**只允许**出现在 {@link RECALL_RULES_FILE} 与其 spec 里 ——
 * 别处调用即「排名之后再筛一次」的第二条路径（052 FR-003 的禁令）。
 *
 * 🚨 这条**踩了不会红**：第二处筛选照样筛得出结果，只是成员集合谁说了算变成运行时才知道的事，
 * 而两处的口径迟早分叉（且分叉后候选数、计数、名次全都算得出来）。
 * 📌 `resolvePremiumFloor` / `resolveQualityCeiling` **不在表内**：它们解的是**默认值**不是成员，
 * 下发默认值本来就要在 use case 侧读得到。
 */
export const MEMBERSHIP_PREDICATE_RE =
  /\b(failedCriteria|passesPremiumMin|passesOpenInterestMin|passesRelativeSpreadMax|passesQualityCeiling|passesEffectiveCostGate|passesHardGates)\s*\(/g;

/** 词表判据的**两侧**探针（同 {@link shapePatternProbe} 的理由）。 */
export function membershipProbe(): string | null {
  const positive = findShapeHits(
    'const kept = legs.filter((l) => failedCriteria(c, l).length === 0 && passesHardGates(t, ch, l));',
    MEMBERSHIP_PREDICATE_RE,
  );
  if (positive.length === 0) {
    return '成员判据正例臂失灵：`failedCriteria(` / `passesHardGates(` 未被命中 —— 判据已变平凡绿';
  }
  const negative = findShapeHits(
    'const defaults = defaultCriteriaByTab(chain); const floor = resolvePremiumFloor(spot);',
    MEMBERSHIP_PREDICATE_RE,
  );
  if (negative.length > 0) {
    return `成员判据反例臂失灵：默认值解析被判违规（命中 ${negative.join(' / ')}）—— 判据会恒红`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 052 不变量 #8 —— 客户端零处自算检索条件默认值（词表 + 算式形状，FR-011 / Guardrail 6）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 两类命中都判违规：
 * ① **照抄服务端那份默认值判据**（函数名 / 阈值常量名）——「同一判据两处各一份」的最短路径；
 * ② **`spot` 直接参与乘除** —— 六维里有两维（行权价上界 · 权利金下限）的默认值就是 spot 的
 *    函数，客户端一旦自己乘一下，两边**都算得出数**，漂移只在换日那一刻才看得见。
 *
 * 🚨 **这条踩了不会红**：客户端算出来的默认值照样填得进控件、照样点得动「搜」，服务端也照样
 * 按它自己那份判据召回 —— 屏幕上一切正常，只是控件里的数与真正生效的判据不是同一天的。
 *
 * ⚠️ **它拦的是「照抄」这一最可能的形态，不是所有可能的自算**：把 spot 先赋给别名再乘、或把
 * 系数拆成两步，都能绕开。刻意绕开的人不是这条守门要防的对象；防的是顺手抄一段过来的那一刻。
 */
export const CLIENT_DEFAULT_COMPUTE_RE =
  /\b(resolvePremiumFloor|resolveQualityCeiling|qualityCeiling|defaultCriteria(?:ByTab)?|PREMIUM_FLOOR|OPEN_INTEREST_FLOOR|VOLUME_FLOOR|LIQUIDITY_MAX_RELATIVE_SPREAD|BUILD_RECALL_DTE|RENT_RECALL_DTE)\b|\bspot\b\s*[*/]|[*/]\s*\bspot\b/g;

/** 词表判据的**两侧**探针（同 {@link shapePatternProbe} 的理由）。 */
export function clientDefaultProbe(): string | null {
  const positive = findShapeHits(
    'const ceiling = spot * (1 + RATIO); const floor = resolvePremiumFloor(spot);',
    CLIENT_DEFAULT_COMPUTE_RE,
  );
  if (positive.length === 0) {
    return '客户端自算正例臂失灵：`spot *` / `resolvePremiumFloor` 未被命中 —— 判据已变平凡绿';
  }
  const negative = findShapeHits(
    'const form = criteriaFormOf(criteria.defaults); const pos = spotPosition(anchor);' +
      ' const label = `${spot.pct}%`; const p = bandPosition(spot, floor, ceiling);',
    CLIENT_DEFAULT_COMPUTE_RE,
  );
  if (negative.length > 0) {
    return `客户端自算反例臂失灵：读下发值 / 画色带被判违规（命中 ${negative.join(' / ')}）—— 判据会恒红`;
  }
  return null;
}

function main(): void {
  const ctxPath = join(REPO_ROOT, CTX_DIR);
  const rulesPath = join(ctxPath, RULES_FILE);
  if (!existsSync(rulesPath)) {
    console.error(`❌ check-optionsdesk-rule-constants: 找不到 ${CTX_DIR}/${RULES_FILE}`);
    process.exit(1);
  }

  const rulesSource = readFileSync(rulesPath, 'utf8');
  const forbidden = extractCoefficients(rulesSource);

  const probeFailure = selfProbe(rulesSource, forbidden);
  if (probeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 探针自检失败 —— ${probeFailure}`);
    process.exit(1);
  }

  const siblings = readdirSync(ctxPath)
    .filter((f) => f.endsWith('.ts') && f !== RULES_FILE)
    .map((name) => ({ name, source: readFileSync(join(ctxPath, name), 'utf8') }));

  if (siblings.length === 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants: ${CTX_DIR} 下没有其他 .ts —— 目录结构变了？`,
    );
    process.exit(1);
  }

  // 📌 #1 的面同样豁免 `leg-delta-surface.rules.ts`（068 T010 撞值登记, 与下方 #2 同一条理由）:
  // rent 带上界 0.62 含子串 0.6（ZONE_FLOOR_COEFFICIENT）—— 取值巧合, 该文件参数由 #9 守。
  const offenders = findOffenders(
    siblings.filter((f) => f.name !== DELTA_SURFACE_FILE),
    forbidden,
  );
  if (offenders.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 档位系数被硬编码在 ${RULES_FILE} 以外：\n`,
    );
    for (const { name, literals } of offenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${literals.join(' / ')}`);
    }
    console.error(`\nFix: 从 ${RULES_FILE} import 常量，别抄字面量 —— 这几个系数是可调策略参数，`);
    console.error(
      '     抄一处就多一处调参时会漏改的地方，而漏改是静默的（类型对、测试绿、锚位悄悄不一致）。',
    );
    process.exit(1);
  }

  // ── 050 不变量 #2 / #3 / #4 ────────────────────────────────────────────────
  const recallPath = join(ctxPath, RECALL_RULES_FILE);
  if (!existsSync(recallPath)) {
    console.error(`❌ check-optionsdesk-rule-constants: 找不到 ${CTX_DIR}/${RECALL_RULES_FILE}`);
    process.exit(1);
  }
  const recallSource = readFileSync(recallPath, 'utf8');
  const thresholds = extractRecallThresholds(recallSource);

  const recallProbeFailure = recallSelfProbe(recallSource, thresholds);
  if (recallProbeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 门槛阈值探针失败 —— ${recallProbeFailure}`);
    process.exit(1);
  }
  const shapeProbeFailure = shapePatternProbe();
  if (shapeProbeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 形状判据探针失败 —— ${shapeProbeFailure}`);
    process.exit(1);
  }

  // 🚨 扫描面排除 `*.spec.ts`（与上面 #1 的不对称是蓄意的，理由见文件头）。
  const nonSpec = siblings.filter((f) => !f.name.endsWith('.spec.ts'));
  // 📌 #2 的面显式豁免 `leg-delta-surface.rules.ts`（068 T010 撞值登记）：rent 带下界 0.03 与
  // `QUALITY_CEILING_SPOT_RATIO` 同值是**两个独立参数的取值巧合**（同 052「LIQUIDITY_TIER_BOUNDS[1]
  // 与 ACTIVITY_ABSOLUTE_FLOOR 同为 100」先例）——该文件自身的参数由 #9 形状扫 + pad 子串守，
  // 🚫 MUST NOT 因巧合把其一改成引用另一个。
  const outsideRecall = nonSpec.filter(
    (f) => f.name !== RECALL_RULES_FILE && f.name !== DELTA_SURFACE_FILE,
  );

  const thresholdOffenders = findOffenders(outsideRecall, [...new Set(thresholds)]);
  if (thresholdOffenders.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 门槛阈值被硬编码在 ${RECALL_RULES_FILE} 以外：\n`,
    );
    for (const { name, literals } of thresholdOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${literals.join(' / ')}`);
    }
    console.error(
      `\nFix: 从 ${RECALL_RULES_FILE} import 常量。⚠️ 若命中的是**撞值**（该文件里那个数本来另有含义，` +
        `\n     如 leg-tier 的档界），改的是阈值取值而不是本检查 —— 放宽会让 SC-009 显示为「已机器强制」` +
        '\n     而实际没有，比不装更糟。',
    );
    process.exit(1);
  }

  const dteOffenders = findShapeOffenders(outsideRecall, DTE_BOUND_RE);
  if (dteOffenders.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— DTE 段界被硬编码在 ${RECALL_RULES_FILE} 以外：\n`,
    );
    for (const { name, hits } of dteOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${hits.join(' / ')}`);
    }
    console.error(
      `\nFix: 从 ${RECALL_RULES_FILE} import \`BUILD_RECALL_DTE\` / \`RENT_RECALL_DTE\` 比区间，` +
        '\n     别写 `dteDays <= 49` 这类字面量比较 —— 期限段是可调策略参数，抄一处就多一处漏改点。',
    );
    process.exit(1);
  }

  const bandOffenders = findShapeOffenders(
    outsideRecall.filter((f) => f.name !== MARK_RULES_FILE),
    BAND_LITERAL_RE,
  );
  if (bandOffenders.length > 0) {
    console.error(
      '❌ check-optionsdesk-rule-constants failed —— 闭区间带字面量出现在 ' +
        `${RECALL_RULES_FILE} / ${MARK_RULES_FILE} 以外：\n`,
    );
    for (const { name, hits } of bandOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${hits.join(' / ')}`);
    }
    console.error(
      '\nFix: 带（Δ 带 / DTE 段）是可调策略参数，MUST 具名住在那两个 rules 文件里并被 import。' +
        '\n     若这是一个与策略无关的数值区间（撞了形状不是撞了语义），给它换个字段名或在本检查里' +
        '\n     显式登记该文件 —— 但先确认它真的不是第二份策略参数。',
    );
    process.exit(1);
  }

  // ── 068 不变量 #9 ──────────────────────────────────────────────────────────
  const deltaSurfacePath = join(ctxPath, DELTA_SURFACE_FILE);
  const windowRulesPath = join(ctxPath, WINDOW_RULES_FILE);
  if (!existsSync(deltaSurfacePath) || !existsSync(windowRulesPath)) {
    console.error(
      `❌ check-optionsdesk-rule-constants: 找不到 ${CTX_DIR}/${DELTA_SURFACE_FILE} 或 ${WINDOW_RULES_FILE}`,
    );
    process.exit(1);
  }
  const deltaSurfaceSource = readFileSync(deltaSurfacePath, 'utf8');
  const pad = extractPadRatio(deltaSurfaceSource);
  const windowProbeFailure = windowSelfProbe(deltaSurfaceSource, pad);
  if (windowProbeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 窗判据探针失败 —— ${windowProbeFailure}`);
    process.exit(1);
  }

  const bandShapeOffenders = findShapeOffenders(
    nonSpec.filter((f) => f.name !== DELTA_SURFACE_FILE),
    DELTA_BAND_SHAPE_RE,
  );
  if (bandShapeOffenders.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— Δ 带对象出现在 ${DELTA_SURFACE_FILE} 以外：\n`,
    );
    for (const { name, hits } of bandShapeOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${hits.join(' / ')}`);
    }
    console.error(
      `\nFix: 从 ${DELTA_SURFACE_FILE} import 带常量 —— Δ 带是可标定策略参数，第二份带对象 = 调参漏改点。`,
    );
    process.exit(1);
  }

  const inlineCoefficientOffenders = findShapeOffenders(nonSpec, INLINE_COEFFICIENT_RE);
  if (inlineCoefficientOffenders.length > 0) {
    console.error(
      '❌ check-optionsdesk-rule-constants failed —— 内联系数乘法（`.times(new Prisma.Decimal(…))`）：\n',
    );
    for (const { name, hits } of inlineCoefficientOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${hits.join(' / ')}`);
    }
    console.error(
      '\nFix: 系数乘法 MUST 消费具名常量（bootstrap 比例 / Δ 带 / 档位系数各住其 rules 文件），' +
        '\n     内联字面量就是第二份策略参数 —— 0.7 这类短串没法子串扫，这个形状是它唯一的机器守卫。',
    );
    process.exit(1);
  }

  const padOffenders = findOffenders(
    nonSpec.filter((f) => f.name !== DELTA_SURFACE_FILE),
    [pad as string],
  );
  if (padOffenders.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— pad 被硬编码在 ${DELTA_SURFACE_FILE} 以外：\n`,
    );
    for (const { name, literals } of padOffenders) {
      console.error(`  - ${CTX_DIR}/${name}: ${literals.join(' / ')}`);
    }
    process.exit(1);
  }

  // ── 052 不变量 #5 ──────────────────────────────────────────────────────────
  const portPath = join(ctxPath, RETRIEVAL_PORT_FILE);
  if (!existsSync(portPath)) {
    console.error(`❌ check-optionsdesk-rule-constants: 找不到 ${CTX_DIR}/${RETRIEVAL_PORT_FILE}`);
    process.exit(1);
  }
  const vocabProbeFailure = storageVocabProbe();
  if (vocabProbeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 词表判据探针失败 —— ${vocabProbeFailure}`);
    process.exit(1);
  }
  const portVocab = findStorageVocab(readFileSync(portPath, 'utf8'));
  if (portVocab.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 检索 port 接口出现存储侧词汇：\n` +
        `  - ${CTX_DIR}/${RETRIEVAL_PORT_FILE}: ${portVocab.join(' / ')}\n`,
    );
    console.error(
      'Fix: 把它挪进实现（`leg-retrieval.adapter.ts`）。接口漏了存储侧概念，换实现时接口照样要',
    );
    console.error(
      '     重写 —— 接缝白留（052 FR-031 / ADR-0064 决策 4）。金额量纲经召回判据的入参类型带入。',
    );
    process.exit(1);
  }

  // ── 052 不变量 #6 ──────────────────────────────────────────────────────────
  const coarsePath = join(ctxPath, COARSE_RULES_FILE);
  if (!existsSync(coarsePath)) {
    console.error(`❌ check-optionsdesk-rule-constants: 找不到 ${CTX_DIR}/${COARSE_RULES_FILE}`);
    process.exit(1);
  }
  const coarseProbeFailure = coarseProbe();
  if (coarseProbeFailure) {
    console.error(`❌ check-optionsdesk-rule-constants: 粗排判据探针失败 —— ${coarseProbeFailure}`);
    process.exit(1);
  }
  const coarseHits = findShapeHits(readFileSync(coarsePath, 'utf8'), COARSE_DECISION_RE);
  if (coarseHits.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 粗排层出现判据 / 重排：\n` +
        `  - ${CTX_DIR}/${COARSE_RULES_FILE}: ${coarseHits.join(' / ')}\n`,
    );
    console.error(
      'Fix: 粗排层当前 MUST 恒等（052 FR-004 / ADR-0064 决策 1）。有判据就是第二个打分点 ——',
    );
    console.error(
      '     与精排口径必然分叉，而分叉后两边都排得出顺序、都不会红。合并去重要转实体，先改 ADR。',
    );
    process.exit(1);
  }

  const specless = LAYER_ENTRY_FILES.filter(
    (name) => !existsSync(join(ctxPath, `${name.replace(/\.ts$/, '')}.spec.ts`)),
  );
  if (specless.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 五层入口缺 colocate 的 Small spec：\n` +
        specless.map((n) => `  - ${CTX_DIR}/${n}`).join('\n') +
        '\n',
    );
    console.error(
      'Fix: SC-010 要求五层各自有独立入口**与独立测试**。层入口没有自己的 spec，那一层的判据就',
    );
    console.error('     只能靠穿过全链路的测试间接盖到 —— 改坏时红的是别人，定位不到这一层。');
    process.exit(1);
  }

  // ── 052 不变量 #7 ──────────────────────────────────────────────────────────
  const membershipProbeFailure = membershipProbe();
  if (membershipProbeFailure) {
    console.error(
      `❌ check-optionsdesk-rule-constants: 成员判据探针失败 —— ${membershipProbeFailure}`,
    );
    process.exit(1);
  }
  const secondFilters = outsideRecall
    .map(({ name, source }) => ({ name, hits: findShapeHits(source, MEMBERSHIP_PREDICATE_RE) }))
    .filter(({ hits }) => hits.length > 0);
  if (secondFilters.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 召回层之外出现成员判据：\n` +
        secondFilters
          .map(({ name, hits }) => `  - ${CTX_DIR}/${name}: ${hits.join(' / ')}`)
          .join('\n') +
        '\n',
    );
    console.error(
      'Fix: 成员判定 MUST 单点在 leg-recall.rules.ts（052 FR-003「全仓只有一个 filter 概念」）。',
    );
    console.error(
      '     别处再筛一次照样筛得出结果 —— 只是成员集合谁说了算变成运行时才知道的事，且两处口径迟早分叉。',
    );
    process.exit(1);
  }

  // ── 052 不变量 #8 ──────────────────────────────────────────────────────────
  const clientProbeFailure = clientDefaultProbe();
  if (clientProbeFailure) {
    console.error(
      `❌ check-optionsdesk-rule-constants: 客户端自算探针失败 —— ${clientProbeFailure}`,
    );
    process.exit(1);
  }
  const mobilePath = join(REPO_ROOT, MOBILE_CTX_DIR);
  if (!existsSync(mobilePath)) {
    console.error(`❌ check-optionsdesk-rule-constants: 找不到 ${MOBILE_CTX_DIR}`);
    process.exit(1);
  }
  const mobileFiles = readdirSync(mobilePath).filter((f) => /\.tsx?$/.test(f));
  if (mobileFiles.length === 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants: ${MOBILE_CTX_DIR} 下没有 .ts —— 目录变了？`,
    );
    process.exit(1);
  }
  const clientComputes = mobileFiles
    .map((name) => ({
      name,
      hits: findShapeHits(readFileSync(join(mobilePath, name), 'utf8'), CLIENT_DEFAULT_COMPUTE_RE),
    }))
    .filter(({ hits }) => hits.length > 0);
  if (clientComputes.length > 0) {
    console.error(
      `❌ check-optionsdesk-rule-constants failed —— 客户端在自算检索条件默认值：\n` +
        clientComputes
          .map(({ name, hits }) => `  - ${MOBILE_CTX_DIR}/${name}: ${hits.join(' / ')}`)
          .join('\n') +
        '\n',
    );
    console.error(
      'Fix: 默认值 MUST 由服务端解出并下发（052 FR-011）—— 六维里有两维是 spot 的函数，而 spot',
    );
    console.error(
      '     每天变。客户端自算与服务端**两边都算得出数**，屏幕上一切正常，只是控件里的数与真正',
    );
    console.error('     生效的判据不是同一天的。读 `criteriaByTab[tab].defaults` 就够了。');
    process.exit(1);
  }

  console.log(
    `✅ check-optionsdesk-rule-constants: ${siblings.length} 个同级 .ts 零命中 —— ` +
      `档位系数 (${forbidden.join(' / ')}) 只住在 ${RULES_FILE}；` +
      `门槛阈值 (${[...new Set(thresholds)].join(' / ')}) 与三段 DTE 界只住 ${RECALL_RULES_FILE}；` +
      `闭区间带只住 ${RECALL_RULES_FILE} / ${MARK_RULES_FILE}（后三条扫 ${outsideRecall.length} 个非-spec 文件）；` +
      `${RETRIEVAL_PORT_FILE} 零存储侧词汇；${COARSE_RULES_FILE} 恒等且 ${LAYER_ENTRY_FILES.length} 个层入口各有 spec；` +
      `六维成员判据零外溢；窗判据（Δ 带形状 / 内联系数形状 / pad '${pad}'）只住 ${DELTA_SURFACE_FILE} / ${WINDOW_RULES_FILE}；` +
      `${MOBILE_CTX_DIR} 的 ${mobileFiles.length} 个文件零处自算默认值。`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
