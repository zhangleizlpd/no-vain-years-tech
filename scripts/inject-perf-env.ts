#!/usr/bin/env node
/**
 * inject-perf-env.ts — derive EXPECTED_P95_MS_<ENDPOINT_SLUG> env vars from
 * spec.md frontmatter `perf_budgets:`, per ADR-0039 § 1 / § 3.
 *
 * Spec frontmatter is the single source of truth (SSOT) for perf budgets.
 * Perf IT tests should read `process.env.EXPECTED_P95_MS_<SLUG>` instead of
 * hard-coding numbers, so changing the budget happens in one place (spec.md).
 *
 * Endpoint → slug conversion:
 *   'POST /api/v1/phone-sms-auth' → 'PHONE_SMS_AUTH'
 *   'GET /api/v1/accounts/me'     → 'ACCOUNTS_ME'
 * (HTTP verb + leading /api/vN/ dropped; remaining path → UPPER_SNAKE_CASE)
 *
 * Modes:
 *   1. CLI shell-export emitter — `pnpm tsx scripts/inject-perf-env.ts <spec.md> [spec.md ...]`
 *      Prints `export KEY=value` lines on stdout so callers can `eval $(...)`.
 *
 *   2. Programmatic — `import { loadPerfBudgets } from './inject-perf-env'`
 *      Returns `Record<string, string>` for vitest globalSetup wiring.
 *
 *   3. vitest globalSetup default export — point `vitest.config.ts`
 *      `globalSetup` at this file; it scans `specs/<NNN-slug>/spec.md` files
 *      under PERF_SPECS_GLOB (default: all specs) and sets process.env.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { z } from 'zod';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

export type PerfBudget = z.infer<typeof PerfBudgetSchema>;

export function endpointToSlug(endpoint: string): string {
  return endpoint
    .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '')
    .replace(/^\/api\/v\d+\//, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function envVarsFromBudgets(budgets: PerfBudget[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of budgets) {
    const slug = endpointToSlug(b.endpoint);
    out[`EXPECTED_P95_MS_${slug}`] = String(b.p95_ms);
    out[`EXPECTED_P99_MS_${slug}`] = String(b.p99_ms);
    if (b.timing_defense) {
      out[`EXPECTED_TIMING_DEFENSE_DIFF_P95_MS_${slug}`] = String(b.timing_defense.diff_p95_ms);
    }
  }
  return out;
}

export function loadPerfBudgets(specPath: string): Record<string, string> {
  if (!existsSync(specPath)) {
    throw new Error(`spec not found: ${specPath}`);
  }
  const raw = readFileSync(specPath, 'utf8');
  const fm = matter(raw).data;
  const parsed = FrontmatterSchema.safeParse(fm);
  if (!parsed.success) {
    throw new Error(`invalid frontmatter in ${specPath}: ${parsed.error.message}`);
  }
  const budgets = parsed.data.perf_budgets ?? [];
  return envVarsFromBudgets(budgets);
}

function findAllSpecs(): string[] {
  const specsDir = join(REPO_ROOT, 'specs');
  if (!existsSync(specsDir)) return [];
  const entries = readdirSync(specsDir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const candidate = join(specsDir, e.name, 'spec.md');
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  return out;
}

// vitest globalSetup contract: default export is a setup fn returning a teardown
export default function vitestGlobalSetup(): () => void {
  const specs = findAllSpecs();
  for (const s of specs) {
    try {
      const env = loadPerfBudgets(s);
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
    } catch (e) {
      console.warn(`[inject-perf-env] skip ${s}: ${(e as Error).message}`);
    }
  }
  return () => {
    /* no teardown needed — env vars persist for the run */
  };
}

function mainCli(): void {
  const args = process.argv.slice(2);
  const specPaths = args.length > 0 ? args : findAllSpecs();
  for (const p of specPaths) {
    const abs = resolve(p);
    try {
      const env = loadPerfBudgets(abs);
      for (const [k, v] of Object.entries(env)) {
        console.log(`export ${k}=${v}`);
      }
    } catch (e) {
      console.error(`# error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

// Run CLI only when executed directly (not when imported as vitest globalSetup)
const isDirectExec = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExec) {
  try {
    mainCli();
  } catch (err) {
    console.error('inject-perf-env internal error:', err);
    process.exit(2);
  }
}
