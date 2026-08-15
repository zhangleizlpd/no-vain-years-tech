#!/usr/bin/env node
/**
 * check-skill-snippets.ts — `.claude/skills/` 下所有 md 里的代码块是**照抄即跑**的契约，
 * 不是插图。skill 正文对执行方（人或 agent）说的是「直接照抄」，所以一个跑不起来的
 * 片段不是排版瑕疵，是会把执行方带进错误诊断的缺陷。
 *
 * 三条判据，全部来自真机踩坑（per .claude/rules/convention-authoring.md「新增 hook
 * 拦截规则前必须先有 🟢 实证」）：
 *
 *   1. bash / sh 块必须 `bash -n` 通过。
 *      🟢 2026-08-15：`PS=<script.ps1>` 被 bash 解析成输入重定向 + 悬空 `>`，照抄即
 *      `syntax error near unexpected token newline`。
 *   2. powershell 块必须纯 ASCII 且无 BOM。
 *      🟢 2026-08-15：载荷里一个 `⚠️` 让阿里云助手投递路径静默解析失败 —— InvocationStatus
 *      = Success / ExitCode = 0 / ErrorCode 空 / Output 空。**三项全报成功**，最恶劣的失败形态。
 *      注：PowerShell 自己的 `Parser::ParseInput` 抓不到（它在内存里按 UTF-8 解码），
 *      所以这条与「语法校验」管的不是同一件事，不能互相替代。
 *   3. 可执行块内不得出现**裸** `<占位符>`。引号包起来（`'<biggest-file>'`）才算合法。
 *      🟢 2026-08-15 × 2：PowerShell 侧报「< is reserved」，bash 侧报重定向语法错 —— 同一个
 *      坑跨两种语言各咬一次。占位符必须 copy-runnable，不能是元变量。
 *
 * 判据 2 的适用面：当前全仓 PowerShell 片段都走「base64 → 落文件 → 按本机编码读」这条
 * 投递路径，非 ASCII 在这条路上必炸。若将来出现不走这条路的 PowerShell，再议 opt-out ——
 * 现在不预留开关，fail-closed 与仓内其余 governance check 一致。
 *
 * 蓄意不扫 `speckit-` 前缀的 skill 目录（上游 preset 装入的 vendored 内容，不归本仓改），
 * 与 `.markdownlint-cli2` 的排除面一致。
 *
 * Always full-scan（lefthook glob 只决定跑不跑，不决定扫什么）。exit 0 pass / 1 fail。
 * Usage: pnpm tsx scripts/checks/check-skill-snippets.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = '.claude/skills';
/** vendored preset skill，不归本仓改 */
const SKIP_SKILL_PREFIX = 'speckit-';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** 走 bash 语法校验的块语言 */
const BASH_LANGS = new Set(['bash', 'sh', 'shell']);
/** 走 ASCII / BOM 校验的块语言 */
const PS_LANGS = new Set(['powershell', 'ps1', 'pwsh']);

export interface Block {
  /** 开栅栏后面的语言标注，小写；无标注为 '' */
  lang: string;
  code: string;
  /** 块内第一行代码在原文件中的 1-based 行号 */
  startLine: number;
}

export interface Finding {
  file: string;
  line: number;
  rule: 'bash-syntax' | 'ps-non-ascii' | 'bare-placeholder';
  message: string;
}

/**
 * 提取 fenced code block。O(n)，n = 行数。
 * 开栅栏允许缩进（列表内代码块）；语言标注取栅栏后第一个词。
 */
export function extractBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let open: { lang: string; startLine: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```(\S*)\s*$/.exec(lines[i]);
    if (!fence) {
      if (open) open.body.push(lines[i]);
      continue;
    }
    if (open) {
      blocks.push({ lang: open.lang, code: open.body.join('\n'), startLine: open.startLine });
      open = null;
    } else {
      open = { lang: fence[1].toLowerCase(), startLine: i + 2, body: [] };
    }
  }
  // 未闭合的栅栏：按已收集内容处理，不静默丢弃
  if (open) {
    blocks.push({ lang: open.lang, code: open.body.join('\n'), startLine: open.startLine });
  }
  return blocks;
}

/** `bash -n`（只解析不执行）。返回 stderr 首行，通过则返回 null。 */
export function checkBashSyntax(code: string): string | null {
  try {
    execFileSync('bash', ['-n'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim();
    return stderr.split('\n')[0] || 'bash -n failed';
  }
}

/**
 * 非 ASCII / BOM 扫描。允许 \t 与 0x20-0x7E；\n 由分行消化。
 * 返回 [块内 1-based 行号, 说明][]。
 */
export function findNonAscii(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (i === 0 && line.charCodeAt(0) === 0xfeff) {
      out.push([1, 'UTF-8 BOM']);
      line = line.slice(1); // 剥掉再扫，免得同一处又以 U+FEFF 报第二遍
    }
    for (const ch of line) {
      const c = ch.codePointAt(0) ?? 0;
      if (ch === '\t' || (c >= 0x20 && c <= 0x7e)) continue;
      out.push([i + 1, `U+${c.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)}`]);
      break; // 每行报一个足够定位，避免一行 CJK 刷屏
    }
  }
  return out;
}

/**
 * 裸 `<占位符>` 扫描。**先剥引号串再剥注释**，顺序不能反：
 *   - 先剥引号 → `echo "a # b" <foo>` 里的 `#` 不会被误当注释起点
 *   - 后剥注释 → 注释里讲解 `<x>` 的散文不算缺陷（本文件头部就有这种句子）
 * 引号内的 `'<biggest-file>'` 因此天然豁免 —— 那正是修法。
 */
export function findBarePlaceholders(code: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/#.*$/, '');
    const m = /<[A-Za-z][A-Za-z0-9 ._-]*>/.exec(stripped);
    if (m) out.push([i + 1, m[0]]);
  }
  return out;
}

export function scanDoc(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const block of extractBlocks(text)) {
    const isBash = BASH_LANGS.has(block.lang);
    const isPs = PS_LANGS.has(block.lang);
    if (!isBash && !isPs) continue;

    if (isBash) {
      const err = checkBashSyntax(block.code);
      if (err) {
        findings.push({
          file,
          line: block.startLine,
          rule: 'bash-syntax',
          message: `bash -n 不通过：${err}`,
        });
      }
    }
    if (isPs) {
      for (const [ln, why] of findNonAscii(block.code)) {
        findings.push({
          file,
          line: block.startLine + ln - 1,
          rule: 'ps-non-ascii',
          message: `PowerShell 载荷含非 ASCII：${why}`,
        });
      }
    }
    for (const [ln, ph] of findBarePlaceholders(block.code)) {
      findings.push({
        file,
        line: block.startLine + ln - 1,
        rule: 'bare-placeholder',
        message: `裸占位符 ${ph} —— 照抄即语法错误；改成具体值，或用引号包住`,
      });
    }
  }
  return findings;
}

function collectMarkdown(root: string, out: string[]): void {
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (root.endsWith('.md')) out.push(root);
    return;
  }
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    collectMarkdown(join(root, entry), out);
  }
}

function main(): void {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(SKIP_SKILL_PREFIX))
    .map((d) => join(SKILLS_DIR, d.name));

  const files: string[] = [];
  for (const s of skills) collectMarkdown(s, files);

  const findings: Finding[] = [];
  for (const f of files) findings.push(...scanDoc(f, readFileSync(f, 'utf-8')));

  if (findings.length > 0) {
    console.error('❌ check-skill-snippets: skill 正文里的代码块照抄跑不起来：\n');
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
    }
    console.error(
      '\nskill 正文对执行方说的是「直接照抄」——片段跑不起来会把它带进错误诊断，' +
        '而不是让它看见一个明显的排版问题。\n' +
        '修法：bash-syntax → 本地 `bash -n` 复跑；ps-non-ascii → 注释改英文、去 emoji ' +
        '（PowerShell 自己的 Parser 抓不到这条，别拿语法校验替代）；bare-placeholder → ' +
        '换成可直接运行的具体值。',
    );
    process.exit(1);
  }
  console.log(`✅ skill 片段可跑性通过（${skills.length} 个 skill × ${files.length} 份 md）。`);
}

// 仅作为脚本跑，不在被 .spec 导入时跑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
