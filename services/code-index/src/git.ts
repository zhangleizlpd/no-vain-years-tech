import { execFileSync } from 'node:child_process';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function headSha(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** Pull remote refs without touching the working tree (the host indexes whatever
 *  the checkout's HEAD resolves to; cron decides whether HEAD actually moved). */
export function gitFetch(root: string): void {
  git(root, ['fetch', '--quiet']);
}

export interface DiffResult {
  /** added / modified / rename-or-copy targets — re-chunk + re-embed */
  changed: string[];
  /** deleted / rename sources — drop their chunks */
  deleted: string[];
}

/** Parse `git diff --name-status` output. Renames (Rxxx) and copies (Cxxx) carry
 *  old\tnew; we treat new as changed and (for renames) old as deleted, so a moved
 *  file's stale chunks don't linger. Pure — unit-testable on sample output. */
export function parseNameStatus(out: string): DiffResult {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    if (status.startsWith('R')) {
      deleted.push(parts[1]);
      changed.push(parts[2]);
    } else if (status.startsWith('C')) {
      changed.push(parts[2]);
    } else if (status.startsWith('D')) {
      deleted.push(parts[1]);
    } else {
      // A, M, T (type change) — re-index the path
      changed.push(parts[1]);
    }
  }
  return { changed, deleted };
}

/** `git diff --name-status from..to` → corpus-agnostic change set. */
export function diffNameStatus(root: string, fromSha: string, toSha = 'HEAD'): DiffResult {
  return parseNameStatus(git(root, ['diff', '--name-status', fromSha, toSha]));
}
