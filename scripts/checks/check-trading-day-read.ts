#!/usr/bin/env node
/**
 * check-trading-day-read.ts — 防复发门禁（062 US5 / FR-003 / FR-018, plan §D7）。
 *
 * 病根：`marketdata.trading_day` 只向后填充，而读侧把「无记录」读成「不是交易日」
 * （closed-world assumption）⇒ 今天那一行落库之前，所有问「今天是不是交易日」的消费方都拿到
 * **静默的**错误答案（盘中预警全天不求值 / 期权快照二级兜底从不执行 / 建锚补数标错来源）。
 * 062 把判定改成三态（`marketdata/trading-day.rules.ts`），本门禁保证**下一个消费方没有机会
 * 重新发明这个错误**。
 *
 * 两条**正交**判据：
 *
 *   Check A — 跨 ctx 读日历必须用共享三态判据：
 *     `apps/server/src/` 下 **`marketdata/` 之外**的文件若**读** `tradingDay`，必须 import
 *     `marketdata/trading-day.rules.ts`，否则拒。报错文案给出两条合法路径（注入
 *     `TRADING_CALENDAR_PORT` / import 共享判据）。
 *
 *   Check B — 覆盖终点禁由 `max(date)` 派生（FR-003）：
 *     **写 `calendarCoverage` 的文件内** MUST NOT 出现 `tradingDay` 的「取最大日期」形状
 *     （`aggregate` / `_max` / `orderBy: { date: 'desc' }`）。
 *
 * 🚨 **B 补的正是 A 的射程盲区**：`max(date)` 派生覆盖终点的风险在 **marketdata 内部**，而
 * Check A 恰好扫不到那儿（属主读自己的表天然合法）。而 FR-003 是本 feature 最核心的一条
 * MUST NOT ——「用最大日期派生覆盖终点」= 又一次「库里没有的即为假」推断（最大值看不出区间
 * 中间的空洞），等于在修这个病的过程中原地重犯一次。2026-08-18 analyze 发现它此前**零机器强制**。
 *
 * 🚨 **与 `check-server-moat` 正交，不要合并**：moat 管「跨 ctx 读/注入**有没有注释**」，本门禁
 * 管「读完之后**有没有用对判据**」。两者都拦不住对方那一类：带了 `CROSS-CONTEXT-READ` 注释的
 * 裸查照样可以把 `unknown` 读成 `false`；而用对了判据也不代表那条边被标注出来了。
 *
 * ── Check A 的扫描面为什么是这个形状（每一条都有反例支撑，别凭直觉收紧或放宽）──
 *
 * · **含 `*.spec.ts`**：判定逻辑漏进测试替身同样会把错误的读法传下去。062 T010 完成后
 *   `optionsdesk/` 侧（含 spec）对 `prisma.tradingDay` 已零命中 ⇒ 含 spec 不需要任何白名单。
 * · **只扫读操作**：写操作（`createMany` / `deleteMany` …）是测试 seeding / 清理，不是「判定」；
 *   跨 ctx 写本就被 `check-server-moat` 的 `moat-write` 永久禁止（那条更严，且更早触发）。
 * · **区间聚合形状豁免**（`where` 里 `date: { gt/gte/lt/lte … }`）：那问的是「这段区间里有几个
 *   交易日」（如 `alert/evaluate-alerts.usecase.ts` 的估值 staleness 计数），三态判据对它无意义 ——
 *   强行要求 import 只会逼出一个 unused import。🚨 **这不是白名单**：判据认的是**问法的形状**，
 *   不是文件名；换个文件写同样的区间聚合照样放行，换成单日存在性判断照样被拒。
 * · **未识别的形状一律在扫描面内**（如整表 `findMany` 后自己 `includes(today)`）：极性刻意
 *   **fail-closed** —— 默认放行未识别形状的话，同一个病换个写法就能静默绕过。
 *
 * Usage: pnpm tsx scripts/checks/check-trading-day-read.ts
 * Exit:  0 全过 / 1 ≥1 违规
 *
 * Deps (@nvy/checks): ts-morph; run via root tsx。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';

/** 脚本自身位置推仓根（**别假设 cwd**：lefthook / CI / 手跑三处 cwd 不同）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_SRC = 'apps/server/src';
const SRC_GLOBS = [
  `${REPO_ROOT}/${SERVER_SRC}/**/*.ts`,
  `!${REPO_ROOT}/${SERVER_SRC}/generated/**`,
];

/** 交易日历表的属主 ctx —— 它读自己的表天然合法（US5 AS3）。 */
const OWNER_CTX = 'marketdata';
/** 共享三态判据模块（相对 `src/` 的路径，import specifier 的后缀由判据剥掉）。 */
const RULES_MODULE = `${OWNER_CTX}/trading-day.rules`;

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const COVERAGE_WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);
/** 区间过滤子：`date: { gt/gte/lt/lte }` ⇒ 问的是「区间内有几个」，不是「这一天是不是」。 */
const RANGE_KEYS = new Set(['gt', 'gte', 'lt', 'lte']);

export interface Violation {
  file: string;
  line: number;
  rule: 'trading-day-read-without-rules' | 'coverage-derived-from-max-date';
  message: string;
}

/** src/<seg>/... → seg (context); 非 src 内 → null。 */
function ctxOfFile(filePath: string): string | null {
  const m = filePath.replace(/\\/g, '/').match(/\/src\/([^/]+)\//);
  return m ? m[1] : null;
}

/** `X.<accessor>.<op>()` 形态的调用 → { accessor, op }；非该形态 → null。 */
function prismaCallOf(call: CallExpression): { accessor: string; op: string } | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const inner = callee.getExpression();
  if (!Node.isPropertyAccessExpression(inner)) return null;
  return { accessor: inner.getName(), op: callee.getName() };
}

/** 调用的首个实参文本（无实参 → 空串）。 */
function firstArgText(call: CallExpression): string {
  const arg = call.getArguments()[0];
  return arg ? arg.getText() : '';
}

/**
 * 该次读取是不是「区间聚合」——实参里存在 `date:` 且其值是含 gt/gte/lt/lte 的对象字面量。
 * 深搜（而非只看 `where.date`）是为了覆盖 `AND: [{ date: {...} }]` 这类嵌套写法。
 */
function isRangeDateRead(call: CallExpression): boolean {
  const arg = call.getArguments()[0];
  if (!arg) return false;
  for (const prop of arg.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== 'date') continue;
    const init = prop.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) continue;
    if (
      init.getProperties().some((p) => Node.isPropertyAssignment(p) && RANGE_KEYS.has(p.getName()))
    )
      return true;
  }
  return false;
}

/** 文件有没有 import 共享三态判据（后缀 `.js` / `.ts` / 无后缀都算）。 */
function importsSharedRules(sf: SourceFile): boolean {
  return sf.getImportDeclarations().some((d) => {
    const spec = d.getModuleSpecifierValue().replace(/\.(js|ts)$/, '');
    return spec.endsWith(RULES_MODULE);
  });
}

/**
 * 纯扫描核心（语法级遍历 SourceFile[]）。与 FS / glob 解耦 → 单测可喂 in-memory ts-morph
 * fixture（见 `check-trading-day-read.spec.ts`，两条 Check 各自双向反例）。
 */
export function scanTradingDayReads(sourceFiles: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const sf of sourceFiles) {
    checkCrossCtxRead(sf, violations);
    checkCoverageNotDerivedFromMaxDate(sf, violations);
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Check A — `marketdata/` 之外读 `tradingDay` 必须 import 共享三态判据。 */
function checkCrossCtxRead(sf: SourceFile, violations: Violation[]): void {
  const filePath = sf.getFilePath();
  const ctx = ctxOfFile(filePath);
  if (ctx === null || ctx === OWNER_CTX) return; // 属主自读天然合法
  if (importsSharedRules(sf)) return;

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const hit = prismaCallOf(call);
    if (hit === null || hit.accessor !== 'tradingDay' || !READ_OPS.has(hit.op)) continue;
    if (isRangeDateRead(call)) continue; // 「区间内有几个交易日」不是三态判定

    violations.push({
      file: filePath,
      line: call.getStartLineNumber(),
      rule: 'trading-day-read-without-rules',
      message:
        `${ctx} 直查 marketdata 的 trading_day ('tradingDay.${hit.op}()') 却没 import ` +
        `${SERVER_SRC}/${RULES_MODULE}.ts —— 「无记录」MUST NOT 被读成「不是交易日」(062 FR-018)。` +
        `两条合法路径: ① 有 module 边的 ctx (如 optionsdesk) **注入 TRADING_CALENDAR_PORT** 用 classify(); ` +
        `② 叶子 ctx (如 alert) 直查后 **import ${RULES_MODULE}.ts** 的 classifyTradingDay 判三态`,
    });
  }
}

/** Check B — 写 `calendarCoverage` 的文件内禁出现 `tradingDay` 的「取最大日期」形状（FR-003）。 */
function checkCoverageNotDerivedFromMaxDate(sf: SourceFile, violations: Violation[]): void {
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const writesCoverage = calls.some((call) => {
    const hit = prismaCallOf(call);
    return hit !== null && hit.accessor === 'calendarCoverage' && COVERAGE_WRITE_OPS.has(hit.op);
  });
  if (!writesCoverage) return;

  const filePath = sf.getFilePath();
  for (const call of calls) {
    const hit = prismaCallOf(call);
    if (hit === null || hit.accessor !== 'tradingDay') continue;

    const argText = firstArgText(call);
    const shape =
      hit.op === 'aggregate' && /_max/.test(argText)
        ? `aggregate + _max`
        : /_max\s*:/.test(argText)
          ? `_max`
          : /orderBy[\s\S]*?date\s*:\s*['"]desc['"]/.test(argText)
            ? `orderBy: { date: 'desc' }`
            : null;
    if (shape === null) continue;

    violations.push({
      file: filePath,
      line: call.getStartLineNumber(),
      rule: 'coverage-derived-from-max-date',
      message:
        `本文件写 calendar_coverage, 却用 '${shape}' 从 trading_day 取最大日期 —— ` +
        `FR-003: 覆盖终点 MUST NOT 由 max(date) 派生 (最大值看不出区间中间的空洞, ` +
        `那正是本 feature 要根治的「库里没有的即为假」推断)。` +
        `推进声明走 ${OWNER_CTX}/calendar-coverage.rules.ts 的 advanceCoverage(current, filled): ` +
        `终点只在某段**整段填充成功**后才前进`,
    });
  }
}

/** FS-driven 全量扫描（CLI 入口）。 */
export function scanServerTradingDayReads(opts?: { srcGlobs?: string[] }): Violation[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(opts?.srcGlobs ?? SRC_GLOBS);
  return scanTradingDayReads(project.getSourceFiles());
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(`${REPO_ROOT}/${SERVER_SRC}`)) {
    console.log('[check-trading-day-read] no apps/server/src (skip)');
    process.exit(0);
  }
  const violations = scanServerTradingDayReads();
  if (violations.length === 0) {
    console.log('[check-trading-day-read] ✓ 0 违规 (跨 ctx 读用对判据 + 覆盖终点非派生)');
    process.exit(0);
  }
  console.error('❌ check-trading-day-read: 发现交易日历读法违规 (062 FR-003 / FR-018)');
  for (const v of violations) {
    const rel = v.file.replace(`${REPO_ROOT}/`, '');
    console.error(`   - ${rel}:${v.line} [${v.rule}] ${v.message}`);
  }
  console.error(`\n[check-trading-day-read] ${violations.length} violation(s)`);
  process.exit(1);
}

// tsx 直跑时执行 CLI; 被 import (测试) 时不跑。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
