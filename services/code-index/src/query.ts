import { pool } from './db.js';
import { MODEL, DEFAULT_TOPK } from './config.js';
import { type EmbedSidecar } from './embed-sidecar.js';

export interface SearchHit {
  relPath: string;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

/**
 * Vector-only retrieval (ADR-0060 §3: α≈1.0 is the S1-measured optimum → no FTS
 * fusion, no rerank in baseline). Embeds the query via the on-demand bge-m3 worker
 * (same vector space as the documents), then HNSW cosine top-k within the repo
 * namespace. Returns chunk text + source (path/lines/symbol) for the RAG consumer.
 */
export async function search(
  sidecar: EmbedSidecar,
  repo: string,
  query: string,
  topK: number = DEFAULT_TOPK,
): Promise<SearchHit[]> {
  const [qvec] = await sidecar.embed([query]);
  const r = await pool.query(
    `SELECT c.rel_path, c.kind, c.symbol, c.start_line, c.end_line, c.text,
            1 - (e.vec <=> $1::vector) AS score
       FROM ${MODEL.table} e JOIN chunk c ON c.id = e.chunk_id
      WHERE c.repo = $2
      ORDER BY e.vec <=> $1::vector ASC
      LIMIT $3`,
    [`[${qvec.join(',')}]`, repo, topK],
  );
  return r.rows.map((row) => ({
    relPath: row.rel_path,
    kind: row.kind,
    symbol: row.symbol,
    startLine: row.start_line,
    endLine: row.end_line,
    score: Number(row.score),
    text: row.text,
  }));
}
