import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { SERVICE_ROOT } from './config.js';

const WASM_DIR = path.join(SERVICE_ROOT, 'node_modules', 'tree-sitter-wasms', 'out');
const wasm = (n: string) => path.join(WASM_DIR, `tree-sitter-${n}.wasm`);

export interface Chunk {
  relPath: string;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  text: string;
}

const MAX = 1500; // chars; ~ embedding-friendly window
const MIN = 80; // below this a node coalesces with neighbours
const MIN_GROUP = 40; // drop trivially short coalesced groups

let inited = false;
const langs: Record<string, any> = {};

export async function initParser(): Promise<void> {
  if (inited) return;
  await Parser.init({
    locateFile: (f: string) => path.join(SERVICE_ROOT, 'node_modules', 'web-tree-sitter', f),
  });
  langs.typescript = await Language.load(wasm('typescript'));
  langs.tsx = await Language.load(wasm('tsx'));
  langs.javascript = await Language.load(wasm('javascript'));
  inited = true;
}

function langFor(ext: string): any | null {
  if (ext === '.ts') return langs.typescript;
  if (ext === '.tsx') return langs.tsx;
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return langs.javascript;
  return null;
}

function nameOf(node: any): string | null {
  const n = node.childForFieldName?.('name');
  return n ? n.text : null;
}

function mk(
  kind: string,
  symbol: string | null,
  a: any,
  b: any,
  text: string,
  relPath: string,
): Chunk {
  return {
    relPath,
    kind,
    symbol,
    startLine: a.startPosition.row + 1,
    endLine: b.endPosition.row + 1,
    text,
  };
}

function lineSplit(node: any, source: string, relPath: string, out: Chunk[]) {
  const lines = source.slice(node.startIndex, node.endIndex).split('\n');
  const baseRow = node.startPosition.row;
  const WIN = 50;
  for (let i = 0; i < lines.length; i += WIN) {
    const slice = lines.slice(i, i + WIN).join('\n');
    if (slice.trim().length < MIN_GROUP) continue;
    out.push({
      relPath,
      kind: node.type + '-split',
      symbol: null,
      startLine: baseRow + i + 1,
      endLine: baseRow + Math.min(i + WIN, lines.length),
      text: slice,
    });
  }
}

/** AST-aware recursive chunking: emit each named node that fits the window,
 *  recurse into oversized nodes, coalesce runs of tiny nodes (imports/consts). */
function chunkChildren(node: any, source: string, relPath: string, out: Chunk[]) {
  let pending: any[] = [];
  const flush = () => {
    if (!pending.length) return;
    const a = pending[0];
    const b = pending[pending.length - 1];
    const text = source.slice(a.startIndex, b.endIndex);
    if (text.trim().length >= MIN_GROUP) out.push(mk('group', null, a, b, text, relPath));
    pending = [];
  };
  for (const child of node.namedChildren) {
    const size = child.endIndex - child.startIndex;
    if (size > MAX) {
      flush();
      if (child.namedChildren.length) chunkChildren(child, source, relPath, out);
      else lineSplit(child, source, relPath, out);
    } else if (size >= MIN) {
      flush();
      out.push(mk(child.type, nameOf(child), child, child, child.text, relPath));
    } else {
      pending.push(child);
      if (pending[pending.length - 1].endIndex - pending[0].startIndex > MAX) flush();
    }
  }
  flush();
}

function chunkMarkdown(source: string, relPath: string): Chunk[] {
  const lines = source.split('\n');
  const out: Chunk[] = [];
  let start = 0;
  let header: string | null = null;
  let buf: string[] = [];
  const flush = (endIdx: number) => {
    const text = buf.join('\n');
    if (text.trim().length < MIN_GROUP) return;
    if (text.length <= MAX * 2) {
      out.push({
        relPath,
        kind: 'md-section',
        symbol: header,
        startLine: start + 1,
        endLine: endIdx,
        text,
      });
    } else {
      // oversize section: window by lines, keep header on each piece
      const WIN = 60;
      for (let i = 0; i < buf.length; i += WIN) {
        const piece = buf.slice(i, i + WIN).join('\n');
        if (piece.trim().length < MIN_GROUP) continue;
        out.push({
          relPath,
          kind: 'md-section-split',
          symbol: header,
          startLine: start + i + 1,
          endLine: start + Math.min(i + WIN, buf.length),
          text: (header ? `# ${header}\n` : '') + piece,
        });
      }
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i])) {
      flush(i);
      start = i;
      header = lines[i].replace(/^#+\s/, '').trim();
      buf = [lines[i]];
    } else {
      buf.push(lines[i]);
    }
  }
  flush(lines.length);
  return out;
}

// Prisma has no tree-sitter-wasms grammar; split on top-level blocks
// (model/enum/type/view/generator/datasource) — natural per-entity granularity.
function chunkPrisma(source: string, relPath: string): Chunk[] {
  const lines = source.split('\n');
  const out: Chunk[] = [];
  const blockRe = /^(model|enum|type|view|generator|datasource)\s+(\w+)/;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(blockRe);
    if (!m) {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let seen = false;
    do {
      depth += (lines[i].match(/\{/g) || []).length;
      depth -= (lines[i].match(/\}/g) || []).length;
      if (depth > 0) seen = true;
      i++;
    } while (i < lines.length && (!seen || depth > 0));
    const text = lines.slice(start, i).join('\n');
    if (text.trim().length >= MIN_GROUP)
      out.push({
        relPath,
        kind: `prisma-${m[1]}`,
        symbol: m[2],
        startLine: start + 1,
        endLine: i,
        text,
      });
  }
  return out;
}

export function chunkFile(relPath: string, source: string): Chunk[] {
  const ext = path.extname(relPath);
  if (ext === '.md') return chunkMarkdown(source, relPath);
  if (ext === '.prisma') return chunkPrisma(source, relPath);
  const lang = langFor(ext);
  if (!lang) return [];
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return [];
  const out: Chunk[] = [];
  chunkChildren(tree.rootNode, source, relPath, out);
  tree.delete?.();
  return out;
}
