#!/usr/bin/env node
/**
 * check-golden-sample-registry.ts — golden-sample-registry.md ↔ 代码 `// GOLDEN SAMPLE` banner
 * 必须双向一致：
 *   1. 注册表里每条样板路径（反引号里 apps/ | packages/ | scripts/ 开头的 .ts/.tsx）必须存在，
 *      且文件内含 `GOLDEN SAMPLE` banner —— 索引指向一个没 banner 的文件，读者打开看不出它是样板；
 *   2. 仓内每个带 banner 的文件必须被注册表提到（全路径，或去掉 apps/server/src/ | apps/mobile/src/
 *      | apps/mobile/ 前缀的 companion 简写）—— banner 在、索引没有 = /sdd-auto-impl 派单永远找不到它。
 *
 * 两个方向都 100% 静默（没有任何测试会因 banner 缺失而红），故机器守。
 * SoT: docs/conventions/golden-sample-registry.md + .claude/skills/golden-sample-creator（「样板文件永远加 banner」）。
 *
 * Always full-scan（lefthook glob 只决定跑不跑）。exit 0 pass / 1 fail。
 * Usage: pnpm tsx scripts/checks/check-golden-sample-registry.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'docs/conventions/golden-sample-registry.md';
const BANNER = 'GOLDEN SAMPLE';
const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'generated', '.expo', 'coverage']);
const CODE_EXT = /\.(ts|tsx)$/;
/** companion 简写允许省略的前缀（注册表里 `account/commit-phone-login.usecase.ts` 这类写法） */
const SHORTHAND_PREFIXES = ['apps/server/src/', 'apps/mobile/src/', 'apps/mobile/'];

export interface Drift {
  missingFile: string[];
  missingBanner: string[];
  orphanBanner: string[];
}

/** 从注册表正文抽全路径样板（只认反引号内、仓根相对的 .ts/.tsx）。 */
export function extractRegistryPaths(registryText: string): string[] {
  const out = new Set<string>();
  for (const m of registryText.matchAll(/`((?:apps|packages|scripts)\/[^`\s]+\.(?:ts|tsx))`/g))
    out.add(m[1]);
  return [...out].sort();
}

/** banner 文件是否被注册表提到（全路径或 companion 简写）。 */
export function isRegistered(registryText: string, file: string): boolean {
  if (registryText.includes(file)) return true;
  return SHORTHAND_PREFIXES.some(
    (p) => file.startsWith(p) && registryText.includes(file.slice(p.length)),
  );
}

/**
 * 纯函数核心：registryText = 注册表正文；bannerFiles = 仓内所有含 banner 的文件；
 * exists(path) / hasBanner(path) 由调用方注入（CLI 走磁盘，spec 走 fixture）。
 */
export function findDrift(
  registryText: string,
  bannerFiles: string[],
  exists: (p: string) => boolean,
  hasBanner: (p: string) => boolean,
): Drift {
  const registered = extractRegistryPaths(registryText);
  const missingFile = registered.filter((p) => !exists(p));
  const missingBanner = registered.filter((p) => exists(p) && !hasBanner(p));
  const orphanBanner = bannerFiles.filter((f) => !isRegistered(registryText, f)).sort();
  return { missingFile, missingBanner, orphanBanner };
}

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (CODE_EXT.test(name)) acc.push(p);
  }
}

function main(): void {
  const registryText = readFileSync(REGISTRY, 'utf8');
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const bannerFiles = files.filter((f) => readFileSync(f, 'utf8').includes(BANNER));
  const drift = findDrift(
    registryText,
    bannerFiles,
    (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    (p) => readFileSync(p, 'utf8').includes(BANNER),
  );
  const n = drift.missingFile.length + drift.missingBanner.length + drift.orphanBanner.length;
  if (n === 0) {
    console.log(
      `✅ golden-sample registry ↔ banner 一致（注册 ${extractRegistryPaths(registryText).length} 条 / banner ${bannerFiles.length} 个）。`,
    );
    return;
  }
  console.error('❌ check-golden-sample-registry failed:\n');
  for (const f of drift.missingFile)
    console.error(`  - [missing-file]   注册表引用的文件不存在: ${f}`);
  for (const f of drift.missingBanner)
    console.error(`  - [missing-banner] 注册表样板缺 \`// ${BANNER}\` banner: ${f}`);
  for (const f of drift.orphanBanner)
    console.error(`  - [orphan-banner]  有 banner 但注册表未登记: ${f}`);
  console.error(
    `\nFix: 补 banner（格式见 .claude/skills/golden-sample-creator）或在 ${REGISTRY} 加行 / 改路径。`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
