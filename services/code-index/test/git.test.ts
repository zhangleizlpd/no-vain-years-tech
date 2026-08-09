import { describe, it, expect } from 'vitest';
import { parseNameStatus } from '../src/git.js';

describe('parseNameStatus', () => {
  it('maps A/M/T to changed and D to deleted', () => {
    const out = [
      'M\tapps/server/src/foo.ts',
      'A\tdocs/adr/0099.md',
      'D\tapps/mobile/src/old.tsx',
      'T\tpackages/types/src/t.ts',
    ].join('\n');
    const { changed, deleted } = parseNameStatus(out);
    expect(changed).toEqual([
      'apps/server/src/foo.ts',
      'docs/adr/0099.md',
      'packages/types/src/t.ts',
    ]);
    expect(deleted).toEqual(['apps/mobile/src/old.tsx']);
  });

  it('treats a rename as new=changed + old=deleted', () => {
    const { changed, deleted } = parseNameStatus('R100\told/path.ts\tnew/path.ts');
    expect(changed).toEqual(['new/path.ts']);
    expect(deleted).toEqual(['old/path.ts']);
  });

  it('treats a copy as new=changed only', () => {
    const { changed, deleted } = parseNameStatus('C75\tsrc/a.ts\tsrc/b.ts');
    expect(changed).toEqual(['src/b.ts']);
    expect(deleted).toEqual([]);
  });

  it('ignores blank lines', () => {
    const { changed, deleted } = parseNameStatus('\n\n');
    expect(changed).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
