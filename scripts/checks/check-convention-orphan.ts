#!/usr/bin/env node
/**
 * check-convention-orphan.ts — 每份 docs/conventions/*.md 必须「可达」：
 * 在 referrer 面（CLAUDE.md / .claude/** / 兄弟 convention / ops/** / .specify/**）
 * 至少一处按文件名被引用。全仓零引用 = 按需表 / rules 都路由不到 = 等于不存在，
 * 且这种失联 100% 静默（没有任何信号会报出来）。
 *
 * referrer 面蓄意收窄（不含 docs/private/plans / docs/improvements）：plan / improvement 是
 * 冻结历史留档，只被历史文档提过的 convention 对「当下路由」依然是孤儿。
 * 自引用不算 rescue（文件提自己名字不构成可达）。
 *
 * 匹配按 basename 子串（如 `testing.md`）——引用形态多样（md 链接 / 反引号 / prose），
 * 子串是零漏报的必要条件判据；误救（碰巧同名字符串）理论存在、实际 basename 足够独特。
 *
 * Always full-scan（lefthook glob 只决定跑不跑，不决定扫什么）。exit 0 pass / 1 fail。
 * Usage: pnpm tsx scripts/checks/check-convention-orphan.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONVENTIONS_DIR = 'docs/conventions';
/** referrer 面：这些位置任一处提到 basename 即算可达 */
const REFERRER_ROOTS = ['CLAUDE.md', '.claude', 'docs/conventions', 'ops', '.specify'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
/** 只读文本类扩展（referrer 面里可能引用 convention 的载体） */
const TEXT_EXT = /\.(md|json|jsonc|ya?ml|sh|ts|tsx|mjs|cjs|zsh|txt)$/;

export function findOrphans(
  conventionNames: string[],
  referrers: Record<string, string>,
): string[] {
  return conventionNames.filter((name) => {
    for (const [path, text] of Object.entries(referrers)) {
      if (path.endsWith(`${CONVENTIONS_DIR}/${name}`)) continue; // 自引用不算 rescue
      if (text.includes(name)) return false;
    }
    return true;
  });
}

function collectFiles(root: string, out: string[]): void {
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    out.push(root);
    return;
  }
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    collectFiles(join(root, entry), out);
  }
}

function main(): void {
  const conventionNames = readdirSync(CONVENTIONS_DIR).filter((f) => f.endsWith('.md'));

  const paths: string[] = [];
  for (const root of REFERRER_ROOTS) collectFiles(root, paths);

  const referrers: Record<string, string> = {};
  for (const p of paths) {
    if (!TEXT_EXT.test(p)) continue;
    try {
      referrers[p] = readFileSync(p, 'utf-8');
    } catch {
      // 读不了的文件不构成 referrer，跳过
    }
  }

  const orphans = findOrphans(conventionNames, referrers);
  if (orphans.length > 0) {
    console.error(
      '❌ check-convention-orphan: 以下 convention 全仓无人指向（路由不到 = 等于不存在）：\n',
    );
    for (const o of orphans) console.error(`  - ${CONVENTIONS_DIR}/${o}`);
    console.error(
      '\n修法（任选其一）：CLAUDE.md 按需表加行 / .claude/rules 指过来 / 兄弟 convention 指过来 /' +
        ' 若确实作废则删除。referrer 面 = CLAUDE.md, .claude/**, docs/conventions/**, ops/**, .specify/**' +
        '（蓄意不含 plans / improvements —— 冻结历史不构成当下路由）。' +
        '\n约定 SoT：docs/conventions/docs-organization.md + .claude/rules/convention-authoring.md',
    );
    process.exit(1);
  }
  console.log(
    `✅ convention 可达性通过（${conventionNames.length} 份 convention × ${Object.keys(referrers).length} 个 referrer 文件）。`,
  );
}

// 仅作为脚本跑，不在被 .spec 导入时跑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
