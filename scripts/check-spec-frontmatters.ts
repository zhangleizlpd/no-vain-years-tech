#!/usr/bin/env node
/**
 * check-spec-frontmatters.ts — validate spec.md frontmatter against
 * SpecFrontmatterSchema (mono-orchestrator-ready 0.2.0).
 *
 * Layout when installed into mono:
 *   <repo>/scripts/check-spec-frontmatters.ts         ← this file
 *   <repo>/.specify/schemas/mono-orchestrator-ready/spec.zod.ts
 *
 * The import path below resolves relative to <repo>/scripts/ post-install.
 * In the preset source repo (michael-speckit-presets) it appears unresolved —
 * that is expected (preset repo has no TS toolchain; .ts files are artifacts
 * shipped to target repos).
 *
 * Usage:
 *   pnpm tsx scripts/check-spec-frontmatters.ts                # scan all specs/*\/spec.md
 *   pnpm tsx scripts/check-spec-frontmatters.ts <file> [...]   # specific files (lefthook hook)
 *
 * Exit codes:
 *   0  all pass
 *   1  ≥ 1 file fails schema; details printed to stderr
 *
 * Deps (mono root devDeps): zod, gray-matter, tsx
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
// @ts-expect-error preset-install layout — resolved post-install in mono repo
import { SpecFrontmatterSchema } from "../.specify/schemas/mono-orchestrator-ready/spec.zod.ts";

function findAllSpecFiles(): string[] {
  const specsDir = "specs";
  if (!existsSync(specsDir)) return [];
  return readdirSync(specsDir)
    .map((d) => join(specsDir, d))
    .filter((p) => statSync(p).isDirectory())
    .map((d) => join(d, "spec.md"))
    .filter(existsSync);
}

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args.filter((f) => f.endsWith("spec.md") && existsSync(f))
    : findAllSpecFiles();

if (files.length === 0) {
  console.log("[check-spec-frontmatters] no spec.md files to check (skip)");
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf-8");
  const { data } = matter(raw);
  const result = SpecFrontmatterSchema.safeParse(data);
  if (result.success) {
    console.log(`✅ ${file}`);
  } else {
    failed += 1;
    console.error(`❌ ${file}`);
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      console.error(`   - ${path}: ${issue.message}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n[check-spec-frontmatters] ${failed} file(s) failed schema`);
  process.exit(1);
}
console.log(`\n[check-spec-frontmatters] ${files.length} file(s) ✓`);
