#!/usr/bin/env tsx
/**
 * check-commit-msg-parseable.ts — commit message 必须能被 **release-please 的解析器**解析。
 *
 * 🚨 **为什么 commitlint 绿了还需要这一道**：两者用的**不是同一个解析器**。
 *   - commitlint → `conventional-commits-parser`（正则版），只看 header，body 一律放行；
 *   - release-please → `@conventional-commits/parser`（PEG 文法版），**整条 message 都要过文法**。
 * 解析失败时 release-please 把**整条 commit 丢弃**，然后照常 exit 0、workflow 报 success，
 * 只是不起 Release PR —— 是一个**完全静默**的失败。
 *
 * 实证（2026-08-08 全史扫描 891 个 commit）：main 上 14 条解析失败，其中 4 条碰发版路径，
 * **3 条是 feature 且已静默丢过版**（`996f3c28` 003 refresh-token / `a8b74270` 011 portfolio /
 * `b169a77f` 028 chat），第 4 条 `cbc66a3f`（047 M2b）就是本闸门的直接起因：它让 server 的
 * Release PR 整个没起来，直到下一条可解析的 commit 才以**错误的 patch 级别**冒出来。
 * ⚠️ 代码本身从不受影响（镜像按 main 的树构建，与 release-please 无关），丢的是版本号语义
 * 与 CHANGELOG —— 而版本号语义正是回滚决策的输入。
 *
 * 🚫 **本脚本蓄意不复现「规则」，而是直接跑那个解析器本身。** 起初按「括号要配对」写判据，
 * 实测把它证伪了两轮（先以为是嵌套、再以为是段首），真实条件是下面这条 —— 靠肉眼归纳不出来，
 * 而一个错的判据会同时漏放和误杀。
 *
 * ── 实测触发条件（fixture 全部落在 .spec.ts 里）────────────────────────────────────
 *   **某一行的行首非空格串紧跟 `(`** 时，该行被当作 `type(scope)` 头来解析 ⇒ MUST 在**同一行**
 *   有配对 `)`，且中间**不得再出现 `(`**。（`(` 出现在行中间则完全无害。）
 *
 *     一个(窗数              ❌ 行首紧贴      一个 (窗数            ✅ 括号前留空格
 *     Math.ceil(x           ❌ 同上          一个（窗数             ✅ 全角括号
 *     一个(窗数 Math.ceil(x)) ❌ 同行嵌套      一个(窗数)后续         ✅ 同行闭合且不嵌套
 *                                          第二行有 一个(窗数      ✅ 不在行首 ⇒ 无害
 *
 * Full-scan 语义（不依赖 nx affected）。任一违反 → exit 1。
 * 扫描逻辑抽成纯函数 checkMessages（message 进、violation 出，无 fs / 无 git）→ 可单测。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parser } from '@conventional-commits/parser';

/** git 自动生成 / 临时性 message：它们本就不该过 conventional 文法，且都活不到 main。 */
const SKIP_PREFIXES = ['Merge ', 'Revert ', 'fixup!', 'squash!', 'amend!'];

export interface Violation {
  label: string;
  error: string;
  /** 1-based，取自解析器报错位置；解析器没给位置时为 null。 */
  line: number | null;
  column: number | null;
  /** 出错那一行的原文（便于直接指出改哪里）。 */
  sourceLine: string | null;
}

/** 纯函数：message 列表进，violation 列表出。 */
export function checkMessages(messages: { label: string; text: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { label, text } of messages) {
    const subject = text.split('\n', 1)[0] ?? '';
    if (SKIP_PREFIXES.some((p) => subject.startsWith(p))) continue;
    try {
      parser(text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const at = /at (\d+):(\d+)/.exec(error);
      const line = at ? Number(at[1]) : null;
      const column = at ? Number(at[2]) : null;
      violations.push({
        label,
        error,
        line,
        column,
        sourceLine: line !== null ? (text.split('\n')[line - 1] ?? null) : null,
      });
    }
  }
  return violations;
}

/**
 * 终端显示宽度：CJK / 全角标点占 2 列，其余占 1 列。
 *
 * 解析器给的 column 是**字符**序号，直接用它填充 caret 会在中文行上错开将近一倍
 * —— 而 caret 指错位置比不给 caret 更糟（本仓 commit message 几乎全中文）。
 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function render(v: Violation): string {
  const out = [`❌ ${v.label}`, `   ${v.error}`];
  if (v.sourceLine !== null && v.column !== null) {
    const gutter = ' '.repeat(String(v.line).length);
    const pad = '·'.repeat(displayWidth(v.sourceLine.slice(0, Math.max(0, v.column - 1))));
    out.push(`   ${v.line}| ${v.sourceLine}`, `   ${gutter}| ${pad}^`);
  }
  return out.join('\n');
}

const GUIDANCE = `
🚨 commit message 过不了 release-please 的文法 —— 合进 main 会让整条 commit 被静默丢弃
   （workflow 仍报 success，只是不起 Release PR / 版本号与 CHANGELOG 双双失真）。

触发条件（实测）：**某一行的行首非空格串紧跟左括号 \`(\`** 时，该行会被当作
\`type(scope)\` 头解析，于是要求同一行有配对 \`)\` 且中间不能再出现 \`(\`。
\`(\` 出现在行中间是完全无害的 —— 只有行首这一种位置有事。

   一个(窗数               ❌     一个 (窗数           ✅ 括号前留个空格
   Math.ceil(x            ❌     一个（窗数            ✅ 换成全角括号
   一个(窗数 Math.ceil(x))  ❌     一个(窗数)后续        ✅ 同行闭合且不嵌套
                                第二行有 一个(窗数     ✅ 不在行首就没事

改上面标 ^ 的那一行即可。commitlint 放行它是正常的 —— 两者不是同一个解析器。`;

function main(): void {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const rangeIdx = argv.indexOf('--range');
  let messages: { label: string; text: string }[];

  if (fileIdx !== -1) {
    const path = argv[fileIdx + 1];
    if (!path) throw new Error('--file 需要一个路径参数');
    messages = [{ label: `commit message (${path})`, text: readFileSync(path, 'utf8') }];
  } else if (rangeIdx !== -1) {
    const range = argv[rangeIdx + 1];
    if (!range) throw new Error('--range 需要一个 <base>..<head> 参数');
    // --no-merges: merge commit 走 squash 后不上 main，且其 message 本就不是 conventional 格式。
    const shas = execFileSync('git', ['rev-list', '--no-merges', range], { maxBuffer: 1e9 })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    messages = shas.map((sha) => ({
      label: `${sha.slice(0, 8)}  ${execFileSync('git', ['log', '-1', '--format=%s', sha]).toString().trim().slice(0, 60)}`,
      text: execFileSync('git', ['log', '-1', '--format=%B', sha], { maxBuffer: 1e9 }).toString(),
    }));
  } else {
    throw new Error('用法: check-commit-msg-parseable.ts (--file <path> | --range <base>..<head>)');
  }

  const violations = checkMessages(messages);
  if (violations.length === 0) {
    console.log(
      `✅ check-commit-msg-parseable: ${messages.length} 条 message 均可被 release-please 解析。`,
    );
    return;
  }
  for (const v of violations) console.error(render(v));
  console.error(GUIDANCE);
  process.exit(1);
}

// 被 .spec.ts import 时不执行 CLI。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
