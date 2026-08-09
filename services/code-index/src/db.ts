import pg from 'pg';
import { DB, MODEL } from './config.js';

export const pool = new pg.Pool(DB);

/** Idempotent migration — safe to run on every builder invocation (full or
 *  incremental). No DROP: existing data + HNSW index survive (unlike the spike,
 *  which rebuilt the embedding table each run). */
export async function initSchema(): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunk (
      id         text PRIMARY KEY,
      repo       text NOT NULL,
      rel_path   text NOT NULL,
      kind       text NOT NULL,
      symbol     text,
      start_line int  NOT NULL,
      end_line   int  NOT NULL,
      text       text NOT NULL,
      tsv        tsvector
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON chunk USING gin(tsv)');
  // namespace + path lookups (incremental delete-by-path, repo-scoped counts)
  await pool.query('CREATE INDEX IF NOT EXISTS chunk_repo_path_idx ON chunk (repo, rel_path)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MODEL.table} (
      chunk_id text PRIMARY KEY REFERENCES chunk(id) ON DELETE CASCADE,
      vec      vector(${MODEL.dim})
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${MODEL.table}_vec_idx ON ${MODEL.table} USING hnsw (vec vector_cosine_ops)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS index_meta (
      repo        text PRIMARY KEY,
      last_sha    text NOT NULL,
      indexed_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

/** Drop a whole repo namespace (cascades to embeddings) — used by the cold full
 *  build to rebuild from scratch without touching other repos. */
export async function deleteRepo(repo: string): Promise<void> {
  await pool.query('DELETE FROM chunk WHERE repo = $1', [repo]);
}

/** Drop all chunks of the given files (cascades to embeddings). Incremental
 *  re-index deletes a changed file's old chunks before re-inserting, because
 *  chunk boundaries (and thus ids) shift when the file content changes. */
export async function deleteChunksForPaths(repo: string, relPaths: string[]): Promise<void> {
  if (!relPaths.length) return;
  await pool.query('DELETE FROM chunk WHERE repo = $1 AND rel_path = ANY($2)', [repo, relPaths]);
}

export async function upsertChunk(c: {
  id: string;
  repo: string;
  relPath: string;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  text: string;
  ftsDoc: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO chunk (id, repo, rel_path, kind, symbol, start_line, end_line, text, tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('simple', $9))
     ON CONFLICT (id) DO UPDATE SET
       repo = EXCLUDED.repo, rel_path = EXCLUDED.rel_path, kind = EXCLUDED.kind,
       symbol = EXCLUDED.symbol, start_line = EXCLUDED.start_line,
       end_line = EXCLUDED.end_line, text = EXCLUDED.text, tsv = EXCLUDED.tsv`,
    [c.id, c.repo, c.relPath, c.kind, c.symbol, c.startLine, c.endLine, c.text, c.ftsDoc],
  );
}

export async function upsertEmb(chunkId: string, vec: number[]): Promise<void> {
  await pool.query(
    `INSERT INTO ${MODEL.table} (chunk_id, vec) VALUES ($1, $2::vector)
     ON CONFLICT (chunk_id) DO UPDATE SET vec = EXCLUDED.vec`,
    [chunkId, `[${vec.join(',')}]`],
  );
}

export interface IndexMeta {
  repo: string;
  lastSha: string;
  indexedAt: Date;
}

export async function getMeta(repo: string): Promise<IndexMeta | null> {
  const r = await pool.query('SELECT repo, last_sha, indexed_at FROM index_meta WHERE repo = $1', [
    repo,
  ]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { repo: row.repo, lastSha: row.last_sha, indexedAt: row.indexed_at };
}

export async function setMeta(repo: string, sha: string): Promise<void> {
  await pool.query(
    `INSERT INTO index_meta (repo, last_sha, indexed_at) VALUES ($1, $2, now())
     ON CONFLICT (repo) DO UPDATE SET last_sha = EXCLUDED.last_sha, indexed_at = now()`,
    [repo, sha],
  );
}

export async function countChunks(repo: string): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM chunk WHERE repo = $1', [repo]);
  return r.rows[0].n;
}

export async function countEmb(repo: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM ${MODEL.table} e JOIN chunk c ON c.id = e.chunk_id WHERE c.repo = $1`,
    [repo],
  );
  return r.rows[0].n;
}
