#!/usr/bin/env tsx
/**
 * check-cjk-var-fold.ts — CJK locale 下「裸变量折字节」守门（CI: pr-validation.yml gate-checks）。
 *
 * 拦的形态：shell 脚本里 `$NAME` **紧跟非 ASCII 字符**（`echo "收到 $TIME）"`）。
 * 在 CJK locale 下 bash 会把该字符的首字节折进变量名 → 变量名变成 `TIME` + 半个字节：
 *   · 带 `set -u` → 当场炸「未绑定的变量」，**盖掉本行本该输出的诊断文案**；
 *   · 不带 `set -u` → 静默展开成空串，输出少一截。
 *
 * 为什么值得机器守：`bash -n` 查不出；**只有走到那条错误路径才暴露**，happy path 永远碰不到；
 * 且它 locale 相关而非 bash 版本相关 —— 「我本机跑过没事」「77 上跑过没事」都不构成证据，
 * 脚本发给别人（中文 locale）就炸。踩过 #864（交付链 2 处）/ #865（scripts/ 3 处）。
 *
 * 规则面（2026-08-04 逐字符实测确定，非推断）：
 *   · **所有**非 ASCII 都折 —— 全角标点 / 汉字 / é ü ß / ° ± × / ✅ ❌ 🚨 / 框线符，无一例外；
 *   · 位置参数与特殊参数（`$1` / `$?` / `$#`）**不折** —— 单字符参数走另一条解析路径 ⇒ 不拦；
 *   · 三种修法均实测有效：`${NAME}` / `printf '…%s…' "$NAME"` / 变量放句末。
 *
 * 扫描面：全仓 `*.sh`（跳 node_modules 等）。整行注释（首个非空白字符是 `#`）不算 —— 注释里的
 * `$VAR）` 永不展开，且仓内多处注释**蓄意展示**这个坏形态作说明，拦它们纯属自噬。
 *
 * ⚠️ 已知盲区（守卫覆盖不到，靠人）：
 *   1. **未加引号 heredoc（`<<EOF`）体内的注释行** —— 那是外层 shell 在生成时展开的，本脚本
 *      按「整行注释」跳过 ⇒ 漏。加引号 heredoc（`<<'EOF'`）不展开，本就无风险。
 *   2. **单引号字面量**里的 `$VAR）` 不展开、无害，但本脚本会报 —— 属误报。改写措辞即可，
 *      别为了过闸把字面量改成 `${VAR}`（那会改变字面文本）。
 *   3. `lefthook.yml` / workflow `run:` 块里的内联 shell 不在扫描面（2026-08-04 复核为空）。
 *
 * Full-scan（不依赖 nx affected）—— 是 holistic invariant。任一违反 → exit 1。
 * 扫描逻辑抽成纯函数 scanCjkVarFold（file-map 进、violations 出，无 fs）→ 可单测（.spec.ts）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'coverage']);

const MAX_ASCII = 0x7f;

// 带名字的裸变量 + 紧跟的下一个码点。`u` flag 必须带：否则 emoji（代理对）只匹到高位半个，
// 报错里会打出孤立代理字符（乱码）。非 ASCII 的判定蓄意用码点比较而非字符类范围 —— 范围写法
// 要在源码里落 \x00-\x7F 转义，一旦被写成真的控制字节，文件当场变 binary（2026-08-04 踩过）。
// 位置/特殊参数（$1 / $? / $#）天然不在此正则内（名字须以字母/下划线开头）—— 实测它们不折。
const BARE_VAR_THEN_ANY = /\$([A-Za-z_][A-Za-z0-9_]*)(.)/gsu;

export interface CjkVarFoldViolation {
  file: string;
  line: number;
  varName: string;
  /** 紧跟其后、会被折进变量名的那个字符 */
  nextChar: string;
  /** 原始行（trim 后），用于报错时给上下文 */
  text: string;
}

/**
 * 纯扫描（无 fs）：files = {相对仓根路径: 内容}。只看 `*.sh`。
 * 复杂度 O(总字符数) —— 逐文件逐行一次线性正则扫描，无回溯放大。
 */
export function scanCjkVarFold(files: Record<string, string>): CjkVarFoldViolation[] {
  const violations: CjkVarFoldViolation[] = [];

  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith('.sh')) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue; // 整行注释：永不展开，且仓内有蓄意展示坏形态的说明注释

      BARE_VAR_THEN_ANY.lastIndex = 0; // 全局正则跨调用有状态，逐行前必须复位
      let m: RegExpExecArray | null;
      while ((m = BARE_VAR_THEN_ANY.exec(line)) !== null) {
        const nextChar = m[2];
        if ((nextChar.codePointAt(0) ?? 0) <= MAX_ASCII) continue;
        violations.push({
          file,
          line: i + 1,
          varName: m[1],
          nextChar,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

function main(): void {
  // cwd 无关：从脚本位置(scripts/checks/)反推仓根，免被调用方 cwd 漂移影响
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const files: Record<string, string> = {};
  const walk = (absDir: string): void => {
    for (const e of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(abs);
      } else if (e.name.endsWith('.sh')) {
        files[relative(root, abs)] = readFileSync(abs, 'utf8');
      }
    }
  };
  walk(root);

  const violations = scanCjkVarFold(files);
  const scanned = Object.keys(files).length;

  if (violations.length > 0) {
    console.error('❌ CJK locale 裸变量折字节守门失败：\n');
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}  \`$${v.varName}\` 紧跟 "${v.nextChar}"`);
      console.error(`      ${v.text}`);
      console.error(`      修：\`$${v.varName}\` → \`\${${v.varName}}\``);
    }
    console.error(
      '\n成因：CJK locale 下 bash 把该字符首字节折进变量名 —— `set -u` 当场炸「未绑定的变量」，' +
        '不带 `set -u` 则静默丢值。\n' +
        '三种修法任选：`${VAR}` / `printf \'…%s…\' "$VAR"` / 变量放句末。`bash -n` 查不出这个。\n' +
        '注：单引号字面量里的 `$VAR` 不展开，属误报 —— 改写措辞，别把字面文本改成 ${VAR}。',
    );
    process.exit(1);
  }
  console.log(`✅ CJK 裸变量折字节守门通过（扫 ${scanned} 个 .sh）。`);
}

// 仅作为脚本跑，不在被 .spec 导入时跑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
