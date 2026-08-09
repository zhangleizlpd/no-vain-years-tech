#!/usr/bin/env node
/**
 * check-adr-frontmatters.ts — validate docs/adr/*.md frontmatter against
 * AdrFrontmatterSchema (adr-governance preset 0.1.0).
 *
 * Layout when installed into mono:
 *   <repo>/scripts/check-adr-frontmatters.ts          ← this file
 *   <repo>/.specify/schemas/adr-governance/adr.zod.ts
 *
 * Usage:
 *   pnpm tsx scripts/check-adr-frontmatters.ts                # scan all docs/adr/*.md
 *   pnpm tsx scripts/check-adr-frontmatters.ts <file> [...]   # specific files (lefthook hook)
 *
 * Cross-check: adr_id frontmatter must equal the filename's NNNN prefix
 *   (e.g. docs/adr/0042-foo-bar.md MUST have adr_id: ADR-0042).
 *
 * Exit codes:
 *   0  all pass
 *   1  ≥ 1 file fails schema or filename<->adr_id cross-check
 *
 * Deps (mono root devDeps): zod, gray-matter, tsx
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import matter from 'gray-matter';
// @ts-expect-error preset-install layout — resolved post-install in mono repo
import { AdrFrontmatterSchema } from '../.specify/schemas/adr-governance/adr.zod.ts';

function findAllAdrFiles(): string[] {
  const adrDir = 'docs/adr';
  if (!existsSync(adrDir)) return [];
  return readdirSync(adrDir)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .map((f) => join(adrDir, f));
}

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args.filter((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f) && existsSync(f))
    : findAllAdrFiles();

if (files.length === 0) {
  console.log('[check-adr-frontmatters] no docs/adr/*.md files to check (skip)');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf-8');
  const { data } = matter(raw);
  const result = AdrFrontmatterSchema.safeParse(data);
  if (!result.success) {
    failed += 1;
    console.error(`❌ ${file}`);
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      console.error(`   - ${path}: ${issue.message}`);
    }
    continue;
  }

  // Cross-check: filename NNNN ↔ frontmatter adr_id
  const m = basename(file).match(/^(\d{4})-/);
  if (m) {
    const expected = `ADR-${m[1]}`;
    if (result.data.adr_id !== expected) {
      failed += 1;
      console.error(
        `❌ ${file}\n   - adr_id mismatch: frontmatter '${result.data.adr_id}' vs filename '${expected}'`,
      );
      continue;
    }
  }

  console.log(`✅ ${file}`);
}

if (failed > 0) {
  console.error(`\n[check-adr-frontmatters] ${failed} file(s) failed`);
  process.exit(1);
}
console.log(`\n[check-adr-frontmatters] ${files.length} file(s) ✓`);
