#!/usr/bin/env node
/**
 * check-optionsdesk-rule-constants.ts — 守住 SC-005：档位系数只许出现在 `anchor.rules.ts`。
 *
 * 不变量：`apps/server/src/optionsdesk/` 下**除 `anchor.rules.ts` 以外**的任何 `.ts`，
 * 代码里都不得出现档位系数的字面量（`W_COEFFICIENT` / `ZONE_FLOOR_COEFFICIENT` /
 * `ZONE_CEILING_COEFFICIENT` / `WILLING_SELL_COEFFICIENTS.longHold` 的取值）——
 * 一律 `import` 常量。
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

  console.log(
    `✅ check-optionsdesk-rule-constants: ${siblings.length} 个同级 .ts 零命中 —— ` +
      `档位系数 (${forbidden.join(' / ')}) 只住在 ${RULES_FILE}。`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
