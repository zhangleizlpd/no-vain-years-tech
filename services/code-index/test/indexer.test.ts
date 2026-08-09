import { describe, it, expect } from 'vitest';
import { chunkId, embedInput, recordsFromSource } from '../src/indexer.js';
import type { Chunk } from '../src/chunk.js';

const mk = (over: Partial<Chunk> = {}): Chunk => ({
  relPath: 'apps/server/src/foo.ts',
  kind: 'function_declaration',
  symbol: 'foo',
  startLine: 10,
  endLine: 20,
  text: 'body',
  ...over,
});

describe('chunkId', () => {
  it('is stable for the same (repo, path, line span)', () => {
    expect(chunkId('mono', mk())).toBe(chunkId('mono', mk()));
  });

  it('namespaces by repo', () => {
    expect(chunkId('mono', mk())).not.toBe(chunkId('other', mk()));
  });

  it('changes when the line span shifts', () => {
    expect(chunkId('mono', mk())).not.toBe(chunkId('mono', mk({ startLine: 11 })));
  });
});

describe('embedInput', () => {
  it('prefixes the path and truncates the body to EMBED_MAX_CHARS (1200)', () => {
    const text = 'x'.repeat(5000);
    const got = embedInput(mk({ text, relPath: 'a/b.prisma' }));
    expect(got.startsWith('// a/b.prisma\n')).toBe(true);
    expect(got.slice('// a/b.prisma\n'.length)).toHaveLength(1200);
  });
});

describe('recordsFromSource (prisma, no parser needed)', () => {
  const prisma = `
model Conversation {
  id        String   @id @default(cuid())
  title     String
  createdAt DateTime @default(now())
}

model Message {
  id             String @id @default(cuid())
  conversationId String
  body           String
}
`;
  it('splits prisma into per-model chunks with stable ids', () => {
    const a = recordsFromSource('mono', 'apps/server/prisma/schema.prisma', prisma);
    const b = recordsFromSource('mono', 'apps/server/prisma/schema.prisma', prisma);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id)); // deterministic
    expect(a.map((r) => r.symbol).sort()).toEqual(['Conversation', 'Message']);
    expect(a.every((r) => r.kind === 'prisma-model')).toBe(true);
    expect(a.every((r) => r.repo === 'mono')).toBe(true);
  });
});
