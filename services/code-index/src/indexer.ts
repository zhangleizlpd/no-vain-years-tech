import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DROP_KINDS, EMBED_MAX_CHARS } from './config.js';
import { chunkFile, type Chunk } from './chunk.js';
import { ftsDoc } from './fts.js';
import { type Embedder, embedSequential } from './embed.js';
import { upsertChunk, upsertEmb } from './db.js';

export interface ChunkRecord {
  id: string;
  repo: string;
  relPath: string;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  text: string;
  ftsDoc: string;
  /** input fed to the embedder (path-prefixed + head-truncated) */
  embedInput: string;
}

/** Stable, namespace-safe id: same (repo, path, line span) → same id across runs,
 *  so re-indexing an unchanged chunk upserts in place. */
export function chunkId(repo: string, c: Chunk): string {
  return crypto
    .createHash('sha1')
    .update(`${repo}:${c.relPath}:${c.startLine}-${c.endLine}`)
    .digest('hex')
    .slice(0, 16);
}

/** path comment prefix gives the embedder a filename/dir signal (Cursor-style);
 *  truncate the body to the head to cap embedding cost on long prose chunks. */
export function embedInput(c: Chunk): string {
  const body = EMBED_MAX_CHARS > 0 ? c.text.slice(0, EMBED_MAX_CHARS) : c.text;
  return `// ${c.relPath}\n${body}`;
}

/** Pure: source text → chunk records (drops syntactic noise). No fs / no DB —
 *  unit-testable for id stability + noise dropping. Requires initParser() first. */
export function recordsFromSource(repo: string, relPath: string, source: string): ChunkRecord[] {
  const out: ChunkRecord[] = [];
  for (const c of chunkFile(relPath, source)) {
    if (DROP_KINDS.has(c.kind)) continue;
    out.push({
      id: chunkId(repo, c),
      repo,
      relPath: c.relPath,
      kind: c.kind,
      symbol: c.symbol,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      ftsDoc: ftsDoc(c.text, c.relPath),
      embedInput: embedInput(c),
    });
  }
  return out;
}

/** Read + chunk a set of repo-relative paths (skips missing/unreadable files —
 *  a path can appear in a git diff yet be gone by the time we read it). */
export function collectRecords(repo: string, root: string, relPaths: string[]): ChunkRecord[] {
  const out: ChunkRecord[] = [];
  for (const rel of relPaths) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    try {
      out.push(...recordsFromSource(repo, rel, src));
    } catch (e: any) {
      console.warn(`  chunk fail ${rel}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/** Insert chunks then embed (batch=1), persisting each vector as it is produced.
 *  Pure insert — callers delete stale chunks first (full: deleteRepo; incremental:
 *  deleteChunksForPaths). Vectors land one by one so a builder killed mid-batch
 *  leaves the files it already got through searchable (see embedSequential). */
export async function indexFiles(
  repo: string,
  e: Embedder,
  root: string,
  relPaths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: number; chunks: number }> {
  const records = collectRecords(repo, root, relPaths);
  for (const r of records) await upsertChunk(r);
  await embedSequential(
    e,
    records.map((r) => r.embedInput),
    (i, vec) => upsertEmb(records[i].id, vec),
    onProgress,
  );
  return { files: relPaths.length, chunks: records.length };
}
