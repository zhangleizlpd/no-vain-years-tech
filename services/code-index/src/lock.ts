import fs from 'node:fs';
import path from 'node:path';
import { HEARTBEAT_PATH, LOCK_DIR } from './config.js';

// File-based signals between the long-running query API, the on-demand bge-m3
// worker, and the cron builder. Single host (ADR-0060) → the filesystem is the IPC.

/** Query worker is resident → refresh liveness. cron-tick.sh reads this mtime and
 *  skips indexing while fresh, so ≤1 bge-m3 is ever in RAM (query > index). */
export function touchHeartbeat(): void {
  try {
    const now = new Date();
    fs.writeFileSync(HEARTBEAT_PATH, String(now.getTime()));
  } catch {
    /* best-effort */
  }
}

export function removeHeartbeat(): void {
  try {
    fs.rmSync(HEARTBEAT_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}

function builderLockPath(repo: string): string {
  return path.join(LOCK_DIR, `code-index.${repo}.indexing`);
}

/** Is a process still alive? `kill(pid, 0)` signals nothing but errors if the pid
 *  is gone (ESRCH); EPERM means it exists but isn't ours to signal. */
function isPidAlive(pid: number): boolean {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Acquire an EXCLUSIVE builder lock for a repo. Returns false if another LIVE
 *  builder already holds it — the caller then exits, so ≤1 bge-m3 is ever in RAM
 *  (ADR-0060 §4). This guards EVERY invocation path: systemd serializes the timer,
 *  but a manual / out-of-band `index-incremental` run would otherwise load a 2nd
 *  model concurrently and OOM the no-swap host. A stale lock left by a crashed
 *  builder (pid no longer alive) is reclaimed. Also drives meta `status` display. */
export function acquireBuilderLock(repo: string): boolean {
  const p = builderLockPath(repo);
  try {
    const fd = fs.openSync(p, 'wx'); // O_CREAT | O_EXCL — atomic create-or-fail
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    const holder = Number(fs.readFileSync(p, 'utf8').trim());
    if (isPidAlive(holder)) return false; // a live builder owns it → refuse
    fs.writeFileSync(p, String(process.pid)); // stale (crashed builder) → reclaim
    return true;
  }
}

export function releaseBuilderLock(repo: string): void {
  try {
    fs.rmSync(builderLockPath(repo), { force: true });
  } catch {
    /* best-effort */
  }
}

export function isIndexing(repo: string): boolean {
  return fs.existsSync(builderLockPath(repo));
}
