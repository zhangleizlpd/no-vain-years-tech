// PG's default FTS has no CJK tokenizer (zhparser/pg_jieba not installed). Our
// corpus is Chinese prose (ADR/spec) + English code, so naive
// to_tsvector('simple', text) collapses each CJK run into ONE token → Chinese
// FTS is dead. Fix: expand CJK runs into character bigrams (standard trick),
// lowercase ASCII word tokens, and apply the SAME transform to queries.

const TOKEN_RE = /[一-鿿]+|[A-Za-z0-9_]+/g;

function tokenize(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) {
    const tok = m[0];
    if (tok.charCodeAt(0) >= 0x4e00 && tok.charCodeAt(0) <= 0x9fff) {
      if (tok.length === 1) out.push(tok);
      else for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
    } else {
      out.push(tok.toLowerCase());
    }
  }
  return out;
}

/** Document side: produce the string fed to to_tsvector('simple', ...). */
export function ftsDoc(text: string, relPath: string): string {
  // include path tokens so filename/dir match is searchable via FTS
  return tokenize(relPath + ' ' + text).join(' ');
}

/** Query side: an OR'd to_tsquery('simple', ...) string for recall. */
export function ftsQuery(text: string): string {
  const toks = Array.from(new Set(tokenize(text)));
  return toks.join(' | ');
}
