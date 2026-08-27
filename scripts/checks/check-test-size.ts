#!/usr/bin/env node
/**
 * check-test-size.ts — enforce the machine-checkable half of the test taxonomy.
 *
 * SoT: docs/conventions/testing.md. That doc defines two orthogonal axes —
 *   size  (what resources a test needs)  → ENFORCED HERE, via filename suffix
 *   scope (how much code it validates)   → documented only, deliberately not enforced
 *
 * Suffixes are the whole vocabulary — there is no fourth one:
 *   *.spec.ts         Small   single process, no container / no network / no disk
 *   *.it.spec.ts      Medium  containers, localhost servers, browsers
 *   *.vendor.spec.ts  Large   real vendor network + real credentials, gated, default-skip
 *
 * Seven invariants (rationale per one in testing.md §6):
 *   1 small-stays-small        server src, non-`.it.` → no Testcontainers / shared-PG fixture
 *   2 vendor-must-be-gated     reads a real-vendor RUN_*_IT → must have a skipIf gate
 *   3 vendor-file-fully-gated  `*.vendor.spec.ts` → every top-level describe gated
 *   4 mobile-unit-is-logic-only  apps/mobile/src → no Playwright
 *   5 no-unknown-size-suffix   apps/server/test → only `.it.spec.ts` / `.vendor.spec.ts`
 *   6 e2e-stays-suffix-free    apps/mobile/e2e → no size suffixes (single-tier Medium dir)
 *   7 checks-stay-small        scripts/checks → no size suffixes + no container/browser imports
 *
 * Why any of this is machine-enforced rather than written down: the failure modes are
 * 100% silent. ADR-0040 recorded invariant 1's violation in 2026-05; with no gate it
 * grew from 37 to 46 files over three months, because a mis-sized test still passes —
 * it is just slower, and nobody looks. Invariant 2's failure mode is worse than slow:
 * CI really does hit the vendor with real credentials.
 *
 * 🚨 EVERY match runs on comment-stripped source. Three separate probe false-positives
 * on 2026-08-02 traced back to matching raw text; one flagged three adapter specs whose
 * comments merely CROSS-REFERENCE the vendor test that validates the real endpoint
 * ("真端点由 env-gated 真 vendor IT 校真 (…, RUN_MARKETDATA_IT)"). Those comments are
 * correct and must never be flagged.
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-test-size.ts
 *   pr-validation.yml `gate-checks` job runs it unconditionally on every PR.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Script lives at scripts/checks/ → repo root is two levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_ROOTS = [
  'apps/server/src',
  'apps/server/test',
  'apps/mobile/src',
  'apps/mobile/e2e',
  'scripts/checks',
] as const;
const SKIP_DIRS = new Set(['node_modules', 'generated', 'dist', 'out-tsc', '__snapshots__']);

export type SizeRule =
  | 'small-stays-small'
  | 'vendor-must-be-gated'
  | 'vendor-file-fully-gated'
  | 'mobile-unit-is-logic-only'
  | 'no-unknown-size-suffix'
  | 'e2e-stays-suffix-free'
  | 'checks-stay-small';

export interface SizeViolation {
  file: string;
  rule: SizeRule;
  reason: string;
}

/** `@testcontainers/*` import — matched on the specifier so an alias cannot slip past. */
const TESTCONTAINERS = /from\s+['"]@testcontainers\/[^'"]+['"]/;
/** Shared-PG fixture entry points (apps/server/test/_support/isolated-db.ts). */
const SHARED_PG = /\b(setupIsolatedDb|setupIsolatedStores|setupEmptyDb)\b/;
const PLAYWRIGHT = /from\s+['"]@playwright\/test['"]/;

/**
 * The scanner's own spec: its fixtures are violation SAMPLES (vendor envs, container
 * imports) embedded as string data, and stripComments cannot remove string contents.
 * Content-based rules (2, 7's import ban) skip these files; filename rules still apply.
 * Add a file here only when its FIXTURES, not its behavior, trip a rule.
 */
const FIXTURE_SPECS = new Set(['scripts/checks/check-test-size.spec.ts']);

/**
 * A *real-vendor* gate: `process.env.RUN_<X>_IT`. Two exclusions, both deliberate:
 *   RUN_PERF_IT        — timing test on local containers, i.e. Medium, not Large
 *   RUN_REAL_BACKEND_* — localhost server, likewise Medium
 */
const VENDOR_ENV = /process\.env\.RUN_(?!PERF_IT\b)(?!REAL_BACKEND)([A-Z0-9_]*_IT)\b/g;
/** Top-level `describe(` / `describe.skipIf(<cond>)(` — column 0 only, so nested ones don't count. */
const TOP_DESCRIBE = /^describe(?:\.skipIf\(([^\n]*?)\))?\s*\(/gm;
const ANY_SKIP_IF = /(?:describe|it|test)\.skipIf\(([^\n]*?)\)\s*\(/g;

/**
 * Strip block comments and whole-line `//`. See the 🚨 note in the header.
 *
 * 🚨 **不要「统一」成 check-shutdown-hooks 那个也剥行尾注释的版本。** 两者错误方向相反：
 * 本检查断言**违规文本不存在**（容器 import / 无门控的 `RUN_*_IT`），多剥 = 漏掉真违规
 * = 静默失守；而它断言**必需文本存在**，多剥只会更严。要剥行尾注释就得真 tokenize
 * （字符串字面量里可能含 `//`），代价不抵收益 —— 本检查宁可误报（红得响，人会去看）。
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Resolve one level of indirection: `const ENABLED = RUN_X_IT && URL !== ''` used in a skipIf. */
function gateAliases(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*RUN_[A-Z0-9_]*_IT[^;\n]*/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*([^;\n]*)/g)) {
    if ([...names].some((n) => new RegExp(`\\b${n}\\b`).test(m[2]))) names.add(m[1]);
  }
  return names;
}

function isVendorCondition(cond: string, aliases: Set<string>): boolean {
  if (/RUN_[A-Z0-9_]*_IT/.test(cond)) return true;
  return [...aliases].some((a) => new RegExp(`\\b${a}\\b`).test(cond));
}

/** Pure (no fs) so it is unit-testable. Keys are repo-relative paths. */
export function scanTestFiles(files: Record<string, string>): SizeViolation[] {
  const violations: SizeViolation[] = [];
  for (const [file, raw] of Object.entries(files)) {
    if (!/\.(spec|test)\.tsx?$/.test(file)) continue;
    const code = stripComments(raw);
    const isMedium = file.endsWith('.it.spec.ts');
    const isLarge = file.endsWith('.vendor.spec.ts');
    const aliases = gateAliases(code);

    // 1 — Small stays small.
    if (file.startsWith('apps/server/src/') && !isMedium && !isLarge) {
      if (TESTCONTAINERS.test(code) || SHARED_PG.test(code)) {
        violations.push({
          file,
          rule: 'small-stays-small',
          reason:
            'starts a container (or uses the shared-PG fixture) but is not named *.it.spec.ts — it would run in the `unit` project, which has no globalSetup and must stay Docker-free',
        });
      }
    }

    // 2 — Real-vendor code must be gated.
    //     ⚠️ Limitation, on purpose: this proves a gate EXISTS, not that it covers every
    //     vendor call — the latter is not statically decidable here. Invariant 3 closes
    //     the gap for whole-vendor files; mixed files stay a review concern.
    const envs = [...code.matchAll(VENDOR_ENV)].map((m) => m[1]);
    if (envs.length > 0 && !FIXTURE_SPECS.has(file)) {
      const gated = [...code.matchAll(ANY_SKIP_IF)].some((m) => isVendorCondition(m[1], aliases));
      if (!gated) {
        violations.push({
          file,
          rule: 'vendor-must-be-gated',
          reason: `reads real-vendor env RUN_${envs[0]} but has no describe/it.skipIf gate — CI would hit the real vendor network with real credentials`,
        });
      }
    }

    // 3 — A *.vendor.spec.ts must be gated all the way through, else the suffix lies.
    if (isLarge) {
      const tops = [...code.matchAll(TOP_DESCRIBE)];
      const ungated = tops.filter((m) => !m[1] || !isVendorCondition(m[1], aliases));
      if (tops.length === 0 || ungated.length > 0) {
        violations.push({
          file,
          rule: 'vendor-file-fully-gated',
          reason:
            tops.length === 0
              ? 'named *.vendor.spec.ts but has no top-level describe — cannot verify it is gated'
              : `named *.vendor.spec.ts but ${ungated.length}/${tops.length} top-level describe(s) are not vendor-gated — either gate them or rename the file to *.it.spec.ts`,
        });
      }
    }

    // 4 — Mobile unit tests stay logic-only.
    if (file.startsWith('apps/mobile/src/') && PLAYWRIGHT.test(code)) {
      violations.push({
        file,
        rule: 'mobile-unit-is-logic-only',
        reason:
          'imports @playwright/test — mobile vitest is logic-only; UI / render / a11y belong in apps/mobile/e2e',
      });
    }

    // 5 — No fourth size suffix. apps/server/test/ holds no Small tests by construction.
    if (file.startsWith('apps/server/test/') && !isMedium && !isLarge) {
      violations.push({
        file,
        rule: 'no-unknown-size-suffix',
        reason:
          'lives under apps/server/test/ but is neither *.it.spec.ts (Medium) nor *.vendor.spec.ts (Large) — every size must be one of the three known suffixes',
      });
    }

    // 6 — apps/mobile/e2e is single-tier Medium: the DIRECTORY is the size coordinate
    //     (testing.md §2.2). A size suffix there re-encodes a second meaning onto the
    //     same coordinate — exactly the §0 disease this whole taxonomy exists to prevent.
    if (file.startsWith('apps/mobile/e2e/') && (isMedium || isLarge)) {
      violations.push({
        file,
        rule: 'e2e-stays-suffix-free',
        reason:
          'lives under apps/mobile/e2e/ (single-tier Medium, the directory is the coordinate) but carries a size suffix — drop the suffix; if the test really is another size, it belongs elsewhere',
      });
    }

    // 7 — scripts/checks specs stay Small: they run in every PR gate and local full run.
    //     Content ban skips FIXTURE_SPECS — that file's fixtures ARE violations, as data.
    if (file.startsWith('scripts/checks/')) {
      if (isMedium || isLarge) {
        violations.push({
          file,
          rule: 'checks-stay-small',
          reason:
            'scripts/checks is single-tier Small — no .it. / .vendor. suffixes there; a governance check needing real resources belongs in apps/server/test',
        });
      } else if (
        !FIXTURE_SPECS.has(file) &&
        (TESTCONTAINERS.test(code) || SHARED_PG.test(code) || PLAYWRIGHT.test(code))
      ) {
        violations.push({
          file,
          rule: 'checks-stay-small',
          reason:
            'governance-check spec starts a container / uses the shared-PG fixture / imports Playwright — these specs must stay Small (single process); if the fixture merely QUOTES such code as sample data, add the file to FIXTURE_SPECS with a comment',
        });
      }
    }
  }
  return violations;
}

function collect(dir: string, files: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(path, files);
      continue;
    }
    if (!/\.(spec|test)\.tsx?$/.test(entry.name)) continue;
    files[path.slice(REPO_ROOT.length + 1)] = readFileSync(path, 'utf8');
  }
}

function main(): void {
  const files: Record<string, string> = {};
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) collect(abs, files);
  }

  const violations = scanTestFiles(files);
  if (violations.length) {
    console.error('❌ check-test-size failed:\n');
    for (const v of violations) console.error(`  - [${v.rule}] ${v.file}\n      ${v.reason}`);
    console.error('\nFix (docs/conventions/testing.md §4 has the full decision flow):');
    console.error('  small-stays-small        → rename to `<name>.it.spec.ts` (keep it in place —');
    console.error(
      '                             src/*.it.spec.ts stay colocated by design, testing.md §3.1;',
    );
    console.error(
      '                             test/** is typechecked + linted too), then take the DB from',
    );
    console.error(
      '                             setupIsolatedDb / setupIsolatedStores / setupEmptyDb',
    );
    console.error(
      '                             — pick per the table atop test/_support/isolated-db.ts.',
    );
    console.error(
      '  vendor-must-be-gated     → wrap in describe.skipIf(!RUN_<VENDOR>_IT) and register',
    );
    console.error('                             the env in check-env-sync.ts ALLOWLIST.');
    console.error(
      '  vendor-file-fully-gated  → gate the remaining describe(s), or rename to *.it.spec.ts',
    );
    console.error(
      '                             if the file is really Medium with one vendor block.',
    );
    console.error('  mobile-unit-is-logic-only → move the spec to apps/mobile/e2e.');
    console.error(
      '  no-unknown-size-suffix   → use one of the three suffixes; do not invent a fourth.',
    );
    console.error(
      '  e2e-stays-suffix-free    → drop the suffix (apps/mobile/e2e is all-Medium by dir).',
    );
    console.error(
      '  checks-stay-small        → keep governance-check specs single-process; fixtures',
    );
    console.error('                             quoting violations go in FIXTURE_SPECS.');
    process.exit(1);
  }

  console.log(
    `✅ check-test-size: ${Object.keys(files).length} specs scanned — all seven size invariants hold.`,
  );
}

// Run only as a script, not when imported by the spec.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
