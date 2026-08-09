import { pool } from './db.js';
import { isIndexing } from './lock.js';

export interface RepoMeta {
  repo: string;
  lastSha: string;
  indexedAt: Date;
  chunkCount: number;
  status: 'ready' | 'indexing';
}

/** Repo catalog for the mobile repo selector (S3): each indexed repo with its
 *  last indexed commit/time, chunk count, and live ready/indexing status. */
export async function listRepos(): Promise<RepoMeta[]> {
  const r = await pool.query(
    `SELECT m.repo, m.last_sha, m.indexed_at, count(c.id)::int AS chunk_count
       FROM index_meta m
       LEFT JOIN chunk c ON c.repo = m.repo
      GROUP BY m.repo, m.last_sha, m.indexed_at
      ORDER BY m.repo`,
  );
  return r.rows.map((row) => ({
    repo: row.repo,
    lastSha: row.last_sha,
    indexedAt: row.indexed_at,
    chunkCount: row.chunk_count,
    status: isIndexing(row.repo) ? 'indexing' : 'ready',
  }));
}
