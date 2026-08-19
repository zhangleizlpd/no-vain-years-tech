#!/usr/bin/env node
/**
 * check-time-semantics.ts — 时间语义词表的防复发门禁（[ADR-0066](../../docs/adr/0066-time-semantics-ubiquitous-language.md) §8）。
 *
 * 病根：「这批数据算哪一天」在仓内一度有**五种写法**，且读侧（查日历）与写侧（纯时钟、
 * 不问收没收盘）分成两套从未对过账 —— 结果是盘中触发落一根「半根 K」，而
 * `createMany(skipDuplicates)` 让它**永久驻留**、三层监控全绿（#103, 2026-08-19 prod 实证）。
 * ADR-0066 把词表收敛到 `marketdata/session-clock.ts` 单点，本门禁保证**它不会再长出第二个**。
 *
 * 🚨 **为什么必须是机器强制**：这一类偏差**永不报错** —— 基准差一天不会让任何断言变红，只会
 * 让落库的 K 线少半天成交量、让 `DTE ≤ 14` 这类带判据的边界腿静默进出带。通读式 review 抓不住。
 *
 * 两条**正交**判据：
 *
 *   Rule A — 市场时区表不得有第二份：
 *     单个文件内出现 **≥2 个不同**的市场 IANA 时区字面量 ⇒ 那就是一张「market → 时区」表的
 *     形状。只允许出现在 {@link TABLE_FILES}。
 *     📌 判据是「**≥2 个不同**」而不是「出现过」：单个时区字面量的合法用途很多 ——
 *     `@Cron(..., { timeZone })`（processing-time 轴，与市场无关）、vendor 时间戳解析的
 *     `VENDOR_UPDATE_TIME_ZONE`（L3 轴，ADR-0066 要求**逐端点**确认 offset）。一刀切会把
 *     这些合法形态全咬住，而门禁一旦开始误报就会被加白名单加到失效。
 *
 *   Rule B — 禁绕过词表裸做时区换算：
 *     `Intl.DateTimeFormat(..., { timeZone })` 只允许在 {@link TABLE_FILES} 与 vendor
 *     adapter（`*.adapter.ts`，L3 轴）。其余一律拒，报错指向 `session-clock.ts` 的词表。
 *
 * ## 🚨 Rule B 的存量豁免（{@link GRANDFATHERED_RAW_CONVERSIONS}）不是白名单，是账单
 *
 * 那 3 个文件各自用 `Intl.DateTimeFormat({timeZone:'Asia/Shanghai'})` 重新实现了一遍
 * `userToday()` —— 正是 ADR-0066 §3 要消灭的「各自发挥」。**没有随本门禁一起迁移**，因为
 * `userToday` 现在住在 `marketdata/`，而 `chat` / `portfolio` 要用它就得跨 bounded context
 * import 一个与行情无关的概念 —— 那是个该单独拍的边界问题，不该在装门禁时顺手定。
 * ⇒ 豁免的**解除条件**写在常量注释里；在那之前，本门禁至少保证不会出现第 4 个。
 *
 * 🚨 **与 `check-trading-day-read.ts` 正交，不要合并**：那条管「读日历有没有用对三态判据」
 * （062），本条管「日期换算有没有走词表」（063）。两者都拦不住对方那一类：用对了三态判据的
 * 文件照样可以自己 `new Intl.DateTimeFormat` 求一个不知道跟谁走的「今天」。
 *
 * Usage: pnpm tsx scripts/checks/check-time-semantics.ts
 * Exit:  0 全过 / 1 ≥1 违规
 *
 * Deps (@nvy/checks): ts-morph; run via root tsx。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';

/** 脚本自身位置推仓根（**别假设 cwd**：lefthook / CI / 手跑三处 cwd 不同）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_SRC = 'apps/server/src';
const SRC_GLOBS = [
  `${REPO_ROOT}/${SERVER_SRC}/**/*.ts`,
  `!${REPO_ROOT}/${SERVER_SRC}/generated/**`,
];

/**
 * 词表与时段表的**唯一**两个落点（ADR-0066 §3）。
 * - `session-clock.ts` —— event-time 轴：日历日 / 已收盘 session 水位 / 用户今天
 * - `market-session.rules.ts` —— 盘中时段（能不能成交 / 这一场进行中），另一件事，刻意分开
 */
const TABLE_FILES = ['marketdata/session-clock.ts', 'marketdata/market-session.rules.ts'];

/**
 * Rule B 的存量豁免。**解除条件**：`userToday()` 的归属被拍定（留在 `marketdata` 并放行
 * 跨 ctx import，或提升到 platform 层），此后这三处改调它、本常量清空。
 * 🚫 在那之前 MUST NOT 往这里加新条目 —— 加一条就等于承认门禁没拦住。
 */
const GRANDFATHERED_RAW_CONVERSIONS = [
  'chat/system-prompt.rules.ts',
  'optionsdesk/create-anchor.usecase.ts',
  'portfolio/holdings-import.controller.ts',
];

/** 市场级 IANA 时区字面量（Rule A 只认这三个 —— 它们是本仓 market 值域的时区）。 */
const MARKET_TIME_ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'America/New_York'];

export interface Violation {
  file: string;
  line: number;
  rule: 'timezone-table-duplicated' | 'raw-timezone-conversion';
  message: string;
}

/** 路径是否落在给定的仓内相对后缀集里（in-memory 测试与真实 FS 路径通用）。 */
function matchesAny(filePath: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => filePath.endsWith(s));
}

/** vendor adapter：ADR-0066 的 L3 轴，**要求**逐端点各自确认 offset，故放行。 */
function isVendorAdapter(filePath: string): boolean {
  return filePath.endsWith('.adapter.ts');
}

/** Rule A：单文件内 ≥2 个**不同**的市场时区字面量 = 一张 market→时区表。 */
function scanTimezoneTable(sf: SourceFile, out: Violation[]): void {
  const filePath = sf.getFilePath();
  if (matchesAny(filePath, TABLE_FILES)) return;

  const seen = new Map<string, number>(); // zone → 首次出现行号
  for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = lit.getLiteralValue();
    if (!MARKET_TIME_ZONES.includes(value)) continue;
    if (!seen.has(value)) seen.set(value, lit.getStartLineNumber());
  }
  if (seen.size < 2) return;

  const zones = [...seen.keys()].join(' / ');
  out.push({
    file: filePath,
    line: Math.min(...seen.values()),
    rule: 'timezone-table-duplicated',
    message:
      `本文件出现 ${seen.size} 个不同的市场时区字面量 (${zones}) —— 那是一张「market → 时区」` +
      `表的形状, 而全仓只允许有一份 (ADR-0066 §3)。两份必漂, 且漂的表现只是某个市场的日期` +
      `悄悄错一天、**不报错**。⇒ 改为从 marketdata/session-clock.ts 取 ` +
      `exchangeCalendarDate / sessionWatermark / userToday`,
  });
}

/** Rule B：裸 `Intl.DateTimeFormat(..., { timeZone })`。 */
function scanRawConversion(sf: SourceFile, out: Violation[]): void {
  const filePath = sf.getFilePath();
  if (matchesAny(filePath, TABLE_FILES)) return;
  if (isVendorAdapter(filePath)) return;
  if (matchesAny(filePath, GRANDFATHERED_RAW_CONVERSIONS)) return;

  for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (nw.getExpression().getText() !== 'Intl.DateTimeFormat') continue;
    const hasTimeZone = nw
      .getArguments()
      .some(
        (arg) => Node.isObjectLiteralExpression(arg) && arg.getProperty('timeZone') !== undefined,
      );
    if (!hasTimeZone) continue;

    out.push({
      file: filePath,
      line: nw.getStartLineNumber(),
      rule: 'raw-timezone-conversion',
      message:
        `裸 Intl.DateTimeFormat({ timeZone }) —— 时区换算 MUST 走 ` +
        `marketdata/session-clock.ts 的词表 (ADR-0066 §3): 交易所今天用 ` +
        `exchangeCalendarDate / 已收盘 session 用 sessionWatermark / 人工节奏用 userToday。` +
        `自己转一次就是给「谁的今天」这个判断开第二个答案, 而答错**不会报错** —— ` +
        `只会让数字悄悄差一天 (#103 的形状)`,
    });
  }
}

/** 纯扫描（单测直喂 in-memory SourceFile[]）。复杂度 O(AST 节点数)。 */
export function scanTimeSemantics(sourceFiles: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const sf of sourceFiles) {
    scanTimezoneTable(sf, out);
    scanRawConversion(sf, out);
  }
  return out;
}

/** FS-driven 全量扫描（CLI 入口）。 */
export function scanServerTimeSemantics(opts?: { srcGlobs?: string[] }): Violation[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(opts?.srcGlobs ?? SRC_GLOBS);
  return scanTimeSemantics(project.getSourceFiles());
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(): void {
  if (!existsSync(`${REPO_ROOT}/${SERVER_SRC}`)) {
    console.log('[check-time-semantics] no apps/server/src (skip)');
    process.exit(0);
  }
  const violations = scanServerTimeSemantics();
  if (violations.length === 0) {
    console.log('[check-time-semantics] ✓ 0 违规 (时区表单点 + 日期换算走词表)');
    process.exit(0);
  }
  console.error('❌ check-time-semantics: 发现时间语义违规 (ADR-0066 §8)');
  for (const v of violations) {
    const rel = v.file.replace(`${REPO_ROOT}/`, '');
    console.error(`   - ${rel}:${v.line} [${v.rule}] ${v.message}`);
  }
  console.error(`\n[check-time-semantics] ${violations.length} violation(s)`);
  process.exit(1);
}

// tsx 直跑时执行 CLI; 被 import (测试) 时不跑。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
