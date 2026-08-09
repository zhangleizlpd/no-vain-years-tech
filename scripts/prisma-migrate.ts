#!/usr/bin/env node
/**
 * prisma-migrate.ts — `prisma migrate` wrapper enforcing ADR-0035 § 1
 * timestamp-hybrid naming + auto-scrubbing the recurring spurious trgm DROP.
 *
 * Output dir format: <yyyymmdd>_<hhmm>_<verb_obj>
 *   Examples: 20260520_1430_add_phone_to_account
 *             20260521_0900_drop_legacy_session_table
 *
 * Usage:
 *   pnpm db:migrate "add phone to account"
 *   pnpm db:migrate --dry-run "add phone to account"   # print name, don't execute
 *
 * Pipeline (full-auto, per 2026-06-26 decision — Prisma 7 changed behavior):
 *   1. `prisma migrate dev --create-only --name <slug>` — generate, don't apply.
 *      Prisma 7 force-prepends its own `<yyyymmddhhmmss>_` prefix.
 *   2. Rename the generated dir to the repo convention `<yyyymmdd>_<hhmm>_<slug>`
 *      (Prisma 7's 14-digit prefix violates the convention + lefthook check).
 *   3. Scrub the spurious `DROP INDEX ix_instrument_pinyin_abbr_trgm` that
 *      `migrate dev` re-emits every run (GIN trgm index built by raw SQL in
 *      20260602_1430 — Prisma schema can't express gin_trgm_ops). Prepend the
 *      standard note header.
 *   4. `prisma migrate deploy` — apply without the post-diff that would
 *      otherwise re-trigger the trgm prompt / hang on stdin.
 *   5. `prisma generate` — deploy doesn't regenerate the client.
 *
 * The lefthook `migration-naming-check` hook (lefthook.yml) enforces the
 * format for any newly added prisma/migrations/<NAME>/ directory.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, renameSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = resolve(REPO_ROOT, 'apps/server');
const MIGRATIONS_DIR = resolve(SERVER_DIR, 'prisma/migrations');

// GIN 三元组拼音索引 (20260602_1430 raw SQL 建; Prisma schema 表达不了 gin_trgm_ops),
// `migrate dev` 每次误生成 DROP, 需剔除。见各既有 migration 头部注释。
const TRGM_INDEX = 'ix_instrument_pinyin_abbr_trgm';
const TRGM_NOTE_HEADER = [
  `-- 注: prisma migrate dev 误生成的 \`DROP INDEX ${TRGM_INDEX}\` 已剔除 —`,
  '-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),',
  '-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。',
].join('\n');

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function timestampPrefix(d = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function listMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((e) => {
    try {
      return statSync(join(MIGRATIONS_DIR, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Run prisma in apps/server cwd. Prisma 7's `pnpm -C` form fails to parse;
 *  spawning with cwd=SERVER_DIR + `pnpm exec prisma` is the reliable form. */
function runPrisma(args: string[]): number {
  const res = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    stdio: 'inherit',
    cwd: SERVER_DIR,
  });
  return res.status ?? 1;
}

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** Remove the spurious trgm DropIndex block; prepend note header if changed. */
function scrubTrgmDrop(sql: string): { sql: string; scrubbed: boolean } {
  if (!sql.includes(TRGM_INDEX)) return { sql, scrubbed: false };

  const lines = sql.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('DROP INDEX') && line.includes(TRGM_INDEX)) {
      // drop a preceding `-- DropIndex` comment line if present
      if (out.length > 0 && out[out.length - 1].trim() === '-- DropIndex') {
        out.pop();
      }
      // collapse one trailing blank line so we don't leave a double gap
      if (lines[i + 1] !== undefined && lines[i + 1].trim() === '') i++;
      continue;
    }
    out.push(line);
  }
  return { sql: `${TRGM_NOTE_HEADER}\n\n${out.join('\n')}`, scrubbed: true };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const nameArg = args
    .filter((a) => a !== '--dry-run')
    .join(' ')
    .trim();

  if (!nameArg) {
    console.error('Usage: pnpm db:migrate "<verb obj>"');
    console.error('  e.g. pnpm db:migrate "add phone to account"');
    console.error('  --dry-run prints the final name without invoking prisma');
    process.exit(2);
  }

  const slug = slugify(nameArg);
  if (!slug) die(`Invalid name after slugify: ${JSON.stringify(nameArg)}`, 2);

  const conventionName = `${timestampPrefix()}_${slug}`;
  console.log(`migration name → ${conventionName}`);

  if (dryRun) {
    console.log('(dry-run — skipping prisma migrate)');
    return;
  }

  // 1. create-only (Prisma 7 prepends its own 14-digit timestamp prefix).
  const before = new Set(listMigrationDirs());
  if (runPrisma(['migrate', 'dev', '--create-only', '--name', slug]) !== 0) {
    die('prisma migrate dev --create-only failed');
  }

  const created = listMigrationDirs().filter((d) => !before.has(d));
  if (created.length === 0) {
    console.log('No migration created (schema already in sync). Nothing to do.');
    return;
  }
  // create-only emits exactly one dir; if >1, the one ending _<slug> is ours.
  const genDir =
    created.length === 1 ? created[0] : (created.find((d) => d.endsWith(`_${slug}`)) ?? created[0]);

  // 2. rename to the repo convention <yyyymmdd>_<hhmm>_<slug>.
  if (genDir !== conventionName) {
    renameSync(join(MIGRATIONS_DIR, genDir), join(MIGRATIONS_DIR, conventionName));
    console.log(`renamed ${genDir} → ${conventionName}`);
  }

  // 3. scrub the spurious trgm DROP.
  const sqlPath = join(MIGRATIONS_DIR, conventionName, 'migration.sql');
  const { sql, scrubbed } = scrubTrgmDrop(readFileSync(sqlPath, 'utf8'));
  if (scrubbed) {
    writeFileSync(sqlPath, sql);
    console.log(`scrubbed spurious DROP INDEX ${TRGM_INDEX}`);
  }

  // 4. apply (deploy = no post-diff, no interactive prompt).
  if (runPrisma(['migrate', 'deploy']) !== 0) die('prisma migrate deploy failed');

  // 5. regenerate the client (deploy doesn't).
  if (runPrisma(['generate']) !== 0) die('prisma generate failed');

  console.log(`✓ migration ${conventionName} created, applied, client regenerated`);
}

main();
