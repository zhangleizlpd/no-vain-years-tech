#!/usr/bin/env node
/**
 * check-optionsdesk-rule-constants.ts — optionsdesk **可调策略参数单点**的机器守门。
 *
 * 四条不变量，扫描面都是 `apps/server/src/optionsdesk/`：
 *
 * | # | 不变量 | 判据形态 | 出处 |
 * | - | ------ | -------- | ---- |
 * | 1 | 档位系数只住 `anchor.rules.ts` | 字面量**子串扫描** | 045 SC-005 |
 * | 2 | 两道门槛阈值只住 `leg-recall.rules.ts` | 字面量**子串扫描** | 050 FR-007 / SC-009 |
 * | 3 | 三段 DTE 界只住 `leg-recall.rules.ts` | **比较表达式**扫描 | 050 SC-009 |
 * | 4 | 闭区间带字面量只住 `leg-recall` / `leg-mark` | **对象形状**扫描 | 050 SC-009 |
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
const RULES_FILE = 'anchor.rules.ts';
/** 050 召回层：两道门槛阈值 + 三段 DTE 界的唯一落点。 */
const RECALL_RULES_FILE = 'leg-recall.rules.ts';
/** 050 打标层：两组 Δ 带的唯一落点。 */
const MARK_RULES_FILE = 'leg-mark.rules.ts';
/** 门槛阈值的个数（绝对下限 / spot 比例 / 相对价差上界）—— 少抽到一个就是检查变平凡绿。 */
const RECALL_THRESHOLD_COUNT = 3;

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
 * 从 `leg-recall.rules.ts` 源码里抽出两道门槛的三个阈值。
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

  const offenders = findOffenders(siblings, forbidden);
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
  const outsideRecall = nonSpec.filter((f) => f.name !== RECALL_RULES_FILE);

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

  console.log(
    `✅ check-optionsdesk-rule-constants: ${siblings.length} 个同级 .ts 零命中 —— ` +
      `档位系数 (${forbidden.join(' / ')}) 只住在 ${RULES_FILE}；` +
      `门槛阈值 (${[...new Set(thresholds)].join(' / ')}) 与三段 DTE 界只住 ${RECALL_RULES_FILE}；` +
      `闭区间带只住 ${RECALL_RULES_FILE} / ${MARK_RULES_FILE}（后三条扫 ${outsideRecall.length} 个非-spec 文件）。`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
