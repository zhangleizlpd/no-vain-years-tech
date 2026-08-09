#!/usr/bin/env node
/**
 * check-adr-index.ts — keep docs/adr/README.md「现状索引」table in sync with
 * the actual docs/adr/NNNN-*.md frontmatter (per realign-P1 PR-1 机械防护).
 *
 * Guards two drift classes:
 *   1. presence — every ADR file has exactly one index row, and every index
 *      row maps to an existing file (no phantom / missing rows).
 *   2. status   — each row's status column == that file's frontmatter `status`.
 *
 * topic / applies_to columns are descriptive prose and intentionally NOT
 * machine-checked here (narrative drift is a PR-review concern, not a gate).
 *
 * Always does a full scan regardless of args — consistency is holistic, so the
 * lefthook hook's glob only decides *whether* to run, never *what* to scan.
 * Mirrors check-adr-frontmatters.ts conventions (exit 0 pass / 1 fail).
 *
 * Usage: pnpm tsx scripts/checks/check-adr-index.ts
 *
 * Deps (@nvy/checks): gray-matter; run via root tsx.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

const ADR_DIR = 'docs/adr';
const README = join(ADR_DIR, 'README.md');

if (!existsSync(ADR_DIR)) {
  console.log('[check-adr-index] no docs/adr dir (skip)');
  process.exit(0);
}
if (!existsSync(README)) {
  console.error(`❌ check-adr-index: ${README} not found`);
  process.exit(1);
}

// 1. actual files → Map<'0018', 'Accepted'>
const fileStatus = new Map<string, string>();
for (const f of readdirSync(ADR_DIR)) {
  const m = f.match(/^(\d{4})-.+\.md$/);
  if (!m) continue;
  const { data } = matter(readFileSync(join(ADR_DIR, f), 'utf-8'));
  fileStatus.set(m[1], String(data.status ?? ''));
}

// 2. README index rows → Map<'0018', 'Accepted'>
//    A row is any markdown table line whose first cell is a 4-digit ADR number;
//    the status is the last non-empty cell. Other tables in the README
//    (frontmatter field reference etc.) never lead with a 4-digit cell, so this
//    selector isolates the「现状索引」table without locating section headers.
const indexStatus = new Map<string, string>();
for (const line of readFileSync(README, 'utf-8').split('\n')) {
  if (!line.trimStart().startsWith('|')) continue;
  const cells = line
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (cells.length < 2 || !/^\d{4}$/.test(cells[0])) continue;
  indexStatus.set(cells[0], cells[cells.length - 1]);
}

// 3. diff both directions
const errors: string[] = [];
for (const [id, status] of fileStatus) {
  if (!indexStatus.has(id)) {
    errors.push(`ADR-${id}: file exists but missing from README index table`);
  } else if (indexStatus.get(id) !== status) {
    errors.push(`ADR-${id}: index status '${indexStatus.get(id)}' ≠ frontmatter '${status}'`);
  }
}
for (const id of indexStatus.keys()) {
  if (!fileStatus.has(id)) {
    errors.push(`ADR-${id}: in README index table but no docs/adr/${id}-*.md file`);
  }
}

if (errors.length > 0) {
  console.error('❌ check-adr-index: README 索引与 frontmatter 不一致');
  for (const e of errors) console.error(`   - ${e}`);
  console.error(
    `\n[check-adr-index] ${errors.length} drift(s) — 重生 docs/adr/README.md 索引表使 status 列 == frontmatter`,
  );
  process.exit(1);
}
console.log(`[check-adr-index] ${fileStatus.size} ADR(s) ✓ index == frontmatter`);
