import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR } from '../src/config.js';
import { acquireBuilderLock, releaseBuilderLock, isIndexing } from '../src/lock.js';

// Unique per worker so a parallel run can't collide on the /tmp lock file.
const REPO = `test-lock-${process.pid}`;
const lockFile = path.join(LOCK_DIR, `code-index.${REPO}.indexing`);

afterEach(() => fs.rmSync(lockFile, { force: true }));

describe('builder lock — real mutual exclusion (≤1 builder, ADR-0060 §4)', () => {
  it('acquires when free and marks the repo indexing', () => {
    expect(acquireBuilderLock(REPO)).toBe(true);
    expect(isIndexing(REPO)).toBe(true);
  });

  it('refuses a second acquire while a LIVE holder owns it', () => {
    expect(acquireBuilderLock(REPO)).toBe(true); // our (alive) pid
    expect(acquireBuilderLock(REPO)).toBe(false); // live holder → no 2nd builder
  });

  it('reclaims a STALE lock left by a crashed builder (dead pid)', () => {
    fs.writeFileSync(lockFile, '2147483646'); // a pid that does not exist
    expect(acquireBuilderLock(REPO)).toBe(true);
    expect(Number(fs.readFileSync(lockFile, 'utf8'))).toBe(process.pid);
  });

  it('release frees the lock for re-acquire', () => {
    acquireBuilderLock(REPO);
    releaseBuilderLock(REPO);
    expect(isIndexing(REPO)).toBe(false);
    expect(acquireBuilderLock(REPO)).toBe(true);
  });
});
