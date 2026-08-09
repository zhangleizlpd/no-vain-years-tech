import { describe, it, expect } from 'vitest';
import { inCorpus } from '../src/corpus.js';
import { REPOS } from '../src/config.js';

const mono = REPOS.mono;

describe('inCorpus (git-diff → indexed-corpus filter)', () => {
  it('accepts source under a configured dir with a matching ext', () => {
    expect(inCorpus(mono, 'apps/server/src/foo.ts')).toBe(true);
    expect(inCorpus(mono, 'apps/mobile/src/a.tsx')).toBe(true);
    expect(inCorpus(mono, 'apps/server/prisma/schema.prisma')).toBe(true);
    expect(inCorpus(mono, 'packages/types/src/index.ts')).toBe(true);
    expect(inCorpus(mono, 'docs/adr/0060.md')).toBe(true);
  });

  it('rejects test / decl / generated noise', () => {
    expect(inCorpus(mono, 'apps/server/src/foo.spec.ts')).toBe(false);
    expect(inCorpus(mono, 'apps/server/src/foo.d.ts')).toBe(false);
    expect(inCorpus(mono, 'apps/server/src/generated/api.ts')).toBe(false);
  });

  it('within specs/ indexes spec.md only, dropping the intent layer', () => {
    expect(inCorpus(mono, 'specs/032-x/spec.md')).toBe(true);
    expect(inCorpus(mono, 'specs/032-x/plan.md')).toBe(false);
    expect(inCorpus(mono, 'specs/032-x/tasks.md')).toBe(false);
    expect(inCorpus(mono, 'specs/032-x/analysis.md')).toBe(false);
    expect(inCorpus(mono, 'specs/032-x/design/notes.md')).toBe(false);
  });

  it('rejects plans and wrong exts; accepts named extra files', () => {
    expect(inCorpus(mono, 'docs/private/plans/2026-06/x.md')).toBe(false);
    expect(inCorpus(mono, 'apps/server/src/foo.md')).toBe(false); // wrong ext for dir
    expect(inCorpus(mono, '.specify/memory/constitution.md')).toBe(true); // extra file
    expect(inCorpus(mono, 'docs/adr/README.md')).toBe(true); // via docs/adr tree
  });
});
