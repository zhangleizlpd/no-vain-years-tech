import { describe, it, expect } from 'vitest';
import { ftsDoc, ftsQuery } from '../src/fts.js';

describe('fts CJK bigram tokenizer', () => {
  it('expands a CJK run into character bigrams', () => {
    const toks = ftsDoc('会话删除', 'x.ts').split(' ');
    expect(toks).toContain('会话');
    expect(toks).toContain('话删');
    expect(toks).toContain('删除');
  });

  it('keeps a single CJK char as itself', () => {
    expect(ftsDoc('删', 'x.ts').split(' ')).toContain('删');
  });

  it('lowercases ASCII word tokens and includes path tokens', () => {
    const toks = ftsDoc('Hello World', 'apps/Server/Foo.ts').split(' ');
    expect(toks).toContain('hello');
    expect(toks).toContain('world');
    expect(toks).toContain('apps');
    expect(toks).toContain('foo'); // path token, lowercased
  });

  it('builds an OR query and dedupes tokens', () => {
    const q = ftsQuery('会话 会话 session');
    expect(q.split(' | ')).toContain('session');
    // '会话' appears once despite the repeated input word
    expect(q.split(' | ').filter((t) => t === '会话')).toHaveLength(1);
  });
});
