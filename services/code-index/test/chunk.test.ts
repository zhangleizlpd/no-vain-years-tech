import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, chunkFile } from '../src/chunk.js';

// `export function`/`export class` parse as an export_statement wrapper, which the
// chunker emits without drilling for a name → symbol is null on exported decls (a
// spike characteristic; the name still lives in the chunk text, which is what
// retrieval scores). A plain (non-exported) declaration DOES surface its symbol.
const TS = `function computeSomething(a: number, b: number): number {
  const x = a + b;
  const y = x * 2;
  return y - a + b * 3 + x - y;
}

export class Widget {
  private value = 0;
  increment(by: number): void {
    this.value = this.value + by + 1;
  }
}
`;

describe('chunkFile (tree-sitter)', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('surfaces the symbol of a plain top-level declaration', () => {
    const chunks = chunkFile('apps/server/src/foo.ts', TS);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.symbol)).toContain('computeSomething');
  });

  it('keeps the declaration name in the chunk text (retrieval signal)', () => {
    const text = chunkFile('apps/server/src/foo.ts', TS)
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('computeSomething');
    expect(text).toContain('Widget');
  });

  it('is deterministic across runs', () => {
    const a = chunkFile('apps/server/src/foo.ts', TS);
    const b = chunkFile('apps/server/src/foo.ts', TS);
    expect(a).toEqual(b);
  });

  it('returns nothing for an unsupported extension', () => {
    expect(chunkFile('foo.txt', 'whatever')).toEqual([]);
  });
});
