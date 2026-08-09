#!/usr/bin/env node
/**
 * plan-compiler.ts — derive auto-managed sections of plan.md from spec.md
 * frontmatter, per ADR-0039 § 2 (plan.md derived, no hand-edit).
 *
 * Current scope (PR-6c): `## Performance Budget` section from
 * `perf_budgets:` in spec frontmatter.
 *
 * The generated block is wrapped in BEGIN/END HTML-comment sentinels.
 * Subsequent runs idempotently replace the block; if no sentinels exist
 * the block is appended to plan.md.
 *
 * Usage:
 *   pnpm tsx scripts/checks/plan-compiler.ts specs/<NNN-slug>/
 *   pnpm tsx scripts/checks/plan-compiler.ts --check specs/<NNN-slug>/   # exit 1 if plan.md would change
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

const PerfBudgetSchema = z.object({
  endpoint: z.string().min(1),
  p95_ms: z.number().positive(),
  p99_ms: z.number().positive(),
  timing_defense: z
    .object({
      diff_p95_ms: z.number().positive(),
    })
    .optional(),
});
const FrontmatterSchema = z.object({
  perf_budgets: z.array(PerfBudgetSchema).optional(),
});

type PerfBudget = z.infer<typeof PerfBudgetSchema>;

const SENTINEL_BEGIN =
  '<!-- BEGIN auto-generated: performance-budget (from spec.md frontmatter; do not edit) -->';
const SENTINEL_END = '<!-- END auto-generated: performance-budget -->';

function renderPerfBudgetSection(budgets: PerfBudget[]): string {
  if (budgets.length === 0) {
    return `${SENTINEL_BEGIN}\n\n## Performance Budget\n\n_No \`perf_budgets\` in spec.md frontmatter._\n\n${SENTINEL_END}\n`;
  }
  const hasTiming = budgets.some((b) => b.timing_defense !== undefined);
  const head = hasTiming
    ? '| Endpoint | P95 (ms) | P99 (ms) | Timing-defense diff P95 (ms) |\n| --- | ---: | ---: | ---: |'
    : '| Endpoint | P95 (ms) | P99 (ms) |\n| --- | ---: | ---: |';
  const rows = budgets
    .map((b) => {
      if (hasTiming) {
        const td = b.timing_defense ? String(b.timing_defense.diff_p95_ms) : '—';
        return `| \`${b.endpoint}\` | ${b.p95_ms} | ${b.p99_ms} | ${td} |`;
      }
      return `| \`${b.endpoint}\` | ${b.p95_ms} | ${b.p99_ms} |`;
    })
    .join('\n');
  return `${SENTINEL_BEGIN}\n\n## Performance Budget\n\n${head}\n${rows}\n\n_Edit \`perf_budgets:\` in spec.md frontmatter to change. Regenerate this block with \`pnpm tsx scripts/checks/plan-compiler.ts <spec-dir>\`._\n\n${SENTINEL_END}\n`;
}

function spliceBlock(planContent: string, newBlock: string): string {
  const blockContent = newBlock.trim();
  const beginIdx = planContent.indexOf(SENTINEL_BEGIN);
  const endIdx = planContent.indexOf(SENTINEL_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = planContent.slice(0, beginIdx).replace(/\s+$/, '');
    const after = planContent.slice(endIdx + SENTINEL_END.length).replace(/^\s+/, '');
    if (after.length === 0) {
      return `${before}\n\n${blockContent}\n`;
    }
    return `${before}\n\n${blockContent}\n\n${after}`;
  }
  const trimmedPlan = planContent.replace(/\s+$/, '');
  return `${trimmedPlan}\n\n${blockContent}\n`;
}

function processFeatureDir(featureDir: string, checkOnly: boolean): boolean {
  const specPath = join(featureDir, 'spec.md');
  const planPath = join(featureDir, 'plan.md');
  if (!existsSync(specPath)) {
    console.error(`spec.md not found at ${specPath}`);
    return false;
  }
  if (!existsSync(planPath)) {
    console.error(`plan.md not found at ${planPath}`);
    return false;
  }
  const fm = matter(readFileSync(specPath, 'utf8')).data;
  const parsed = FrontmatterSchema.safeParse(fm);
  if (!parsed.success) {
    console.error(`invalid frontmatter in ${specPath}: ${parsed.error.message}`);
    return false;
  }
  const budgets = parsed.data.perf_budgets ?? [];
  const block = renderPerfBudgetSection(budgets);

  const before = readFileSync(planPath, 'utf8');
  const after = spliceBlock(before, block);
  if (before === after) {
    console.log(`✓ ${planPath} — already up-to-date`);
    return true;
  }

  if (checkOnly) {
    console.error(`✗ ${planPath} — would change (run without --check to write)`);
    return false;
  }
  writeFileSync(planPath, after, 'utf8');
  console.log(`✓ ${planPath} — wrote ${block.split('\n').length} lines`);
  return true;
}

function main(): void {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const dirs = args.filter((a) => a !== '--check');
  if (dirs.length === 0) {
    console.error('Usage: pnpm tsx scripts/checks/plan-compiler.ts [--check] <spec-dir> [...]');
    console.error('  e.g. pnpm tsx scripts/checks/plan-compiler.ts specs/001-phone-sms-auth/');
    process.exit(2);
  }
  let allOk = true;
  for (const d of dirs) {
    const ok = processFeatureDir(resolve(d), checkOnly);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main();
