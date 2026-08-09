#!/usr/bin/env node
/**
 * check-e2e-seed-auth-mock.ts — guard the Expo Web e2e backend boundary.
 *
 * Invariant (per docs/private/plans/2026-05/05-29-e2e-backend-boundary-hardening.md P1):
 *   Any seed-authed e2e spec (one that injects a fake `nvy-auth` session via
 *   `page.addInitScript`) MUST also intercept `GET /me` at the network boundary.
 *
 * Why: a seeded session has no accessToken (web keeps it in-memory only), so on
 * boot AuthGate's useMe fires `GET /accounts/me`. If that call is NOT stubbed it
 * leaks to whatever happens to be on :3000 — a real backend returns 401, the
 * fake refresh fails, clearSession bounces to /login, and the suite "passes" only
 * because CI happens to lack a backend. That env-dependent flake is the exact
 * anti-pattern this guard prevents from regressing (profile.spec.ts was the
 * named offender — pure addInitScript seed, zero network stub).
 *
 * Interception is helper-agnostic on purpose: it counts either a `mockJson(...,
 * 'GET')` stub on /me OR a raw `page.route(ME_URL, ...)` registration. The
 * latter is how tokens-refresh.spec.ts legitimately drives its stateful,
 * header-conditional refresh SUT (which a fixed-response mockJson cannot express).
 * The invariant is "the GET /me boundary is controlled", not "use this helper".
 *
 * Scope: only the well-defined seed-authed shape (addInitScript + nvy-auth).
 * Login-flow-authed specs (e.g. cancel-deletion, which authenticates mid-test
 * via a mocked endpoint) are out of static reach and stay covered by review.
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-e2e-seed-auth-mock.ts   # scan apps/mobile/e2e
 *   lefthook pre-commit triggers on staged apps/mobile/e2e/**\/*.spec.ts changes
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Script lives at scripts/checks/ → repo root is two levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const E2E_DIR = join(REPO_ROOT, 'apps/mobile/e2e');

export interface SeedAuthViolation {
  file: string;
  reason: string;
}

// A spec seeds a fake auth session when it injects the zustand-persist key
// `nvy-auth` through an init script.
const SEEDS_AUTH = /addInitScript/;
const NVY_AUTH = /nvy-auth/;

// Opt-out for the ONE intentionally non-hermetic spec: the 真后端 smoke
// (real-backend.spec.ts, per 05-29-...-hardening P2). It seeds a REAL
// refreshToken and MUST hit the real backend (refresh + GET /me), so requiring
// a /me stub would defeat its purpose. The marker is explicit + grep-able so
// the exemption can never apply by accident — a spec must declare it
// deliberately. Tested on raw content (it is a comment, which stripLineComments
// would otherwise strip).
const REAL_BACKEND_EXEMPT = /e2e-seed-auth-mock-check:\s*real-backend-exempt/;

// Strip whole-line comments so a commented-out example can't falsely satisfy
// the interception check (mirrors check-env-sync's comment handling).
function stripLineComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

// A GET /me stub via the shared helper: mockJson(page, ME_URL|'.../accounts/me',
// status, body, 'GET'). The body arg may be an object literal OR a helper call
// that returns one (e.g. meBody(wechatBound) in wechat-binding.spec.ts), so the
// match window is bounded by the statement terminator `;` rather than the first
// ')' — a function-call body's inner parens would otherwise truncate the match
// before 'GET'. Negated class stays inside one statement since every mockJson
// call ends with ';'.
const ME_MOCKJSON_GET =
  /mockJson\(\s*page\s*,\s*(?:ME_URL|['"`][^'"`]*accounts\/me[^'"`]*['"`])[^;]*?['"`]GET['"`]\s*,?\s*\)/;

// A raw page.route registration on the /me URL (stateful / header-conditional
// handlers, e.g. tokens-refresh). The handler answers GET /me itself.
const ME_PAGE_ROUTE = /page\.route\(\s*(?:ME_URL|['"`][^'"`]*accounts\/me[^'"`]*['"`])/;

/**
 * Scan a map of {specPath: fileContent}. Returns one violation per seed-authed
 * spec that fails to intercept GET /me. Pure (no fs) so it is unit-testable.
 */
export function scanSpecFiles(files: Record<string, string>): SeedAuthViolation[] {
  const violations: SeedAuthViolation[] = [];
  for (const [file, raw] of Object.entries(files)) {
    if (!SEEDS_AUTH.test(raw) || !NVY_AUTH.test(raw)) continue;
    if (REAL_BACKEND_EXEMPT.test(raw)) continue;
    const content = stripLineComments(raw);
    const interceptsMe = ME_MOCKJSON_GET.test(content) || ME_PAGE_ROUTE.test(content);
    if (!interceptsMe) {
      violations.push({
        file,
        reason:
          'seeds a fake nvy-auth session but does not intercept GET /me — boot useMe will leak to a real :3000',
      });
    }
  }
  return violations;
}

function main(): void {
  if (!existsSync(E2E_DIR)) {
    console.log(`ℹ️  ${E2E_DIR} absent — skipping e2e seed-auth mock check`);
    return;
  }
  const files: Record<string, string> = {};
  for (const name of readdirSync(E2E_DIR)) {
    if (!name.endsWith('.spec.ts')) continue;
    const path = join(E2E_DIR, name);
    files[`apps/mobile/e2e/${name}`] = readFileSync(path, 'utf8');
  }

  const violations = scanSpecFiles(files);
  if (violations.length) {
    console.error('❌ check-e2e-seed-auth-mock failed:\n');
    for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`);
    console.error('\nFix:');
    console.error(
      "  - Stub GET /me so the spec is hermetic: mockJson(page, ME_URL, 200, { ...profile }, 'GET')",
    );
    console.error(
      "    (import { mockJson } from './_support/api-mock'), OR register page.route(ME_URL, ...) for",
    );
    console.error(
      '    a stateful handler. See docs/private/plans/2026-05/05-29-e2e-backend-boundary-hardening.md P1.',
    );
    process.exit(1);
  }

  console.log('✅ check-e2e-seed-auth-mock: every seed-authed e2e spec intercepts GET /me.');
}

// Run only as a script, not when imported by the spec.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
