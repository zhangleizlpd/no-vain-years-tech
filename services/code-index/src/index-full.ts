import { resolveRepo, MODEL } from './config.js';
import { initParser } from './chunk.js';
import { makeEmbedder } from './embed.js';
import { pool, initSchema, deleteRepo, setMeta, countChunks, countEmb } from './db.js';
import { walkCorpus } from './corpus.js';
import { indexFiles } from './indexer.js';
import { headSha } from './git.js';
import { acquireBuilderLock, releaseBuilderLock } from './lock.js';

/**
 * Cold full build. Per the 62 PoC (ADR-0060): the no-swap host can't afford the
 * 5–9h cold build, so this runs OFF-BOX on a fast machine, then `pg_dump -Fc` →
 * scp → `pg_restore` into the host's pgvector. The host only ever runs increments.
 *
 * Usage: tsx src/index-full.ts [repo=mono]
 */
async function main() {
  const repoName = process.argv[2] || 'mono';
  const repo = resolveRepo(repoName);
  console.log(`→ full build: repo=${repo.name} root=${repo.root}`);

  if (!acquireBuilderLock(repo.name)) {
    console.log(
      `another builder is already indexing '${repo.name}' — skipping (≤1 bge-m3, ADR-0060)`,
    );
    await pool.end();
    return;
  }
  try {
    await initParser();
    await initSchema();
    const e = await makeEmbedder();
    console.log(`  model=${e.usedId} dim=${e.dim}`);
    if (e.dim !== MODEL.dim) {
      throw new Error(`embedder dim ${e.dim} ≠ schema dim ${MODEL.dim} (${MODEL.table})`);
    }

    const sha = headSha(repo.root);
    const files = walkCorpus(repo);
    console.log(`  ${files.length} files @ ${sha.slice(0, 8)}`);

    await deleteRepo(repo.name); // clean rebuild of this namespace only
    const t0 = Date.now();
    const { chunks } = await indexFiles(repo.name, e, repo.root, files, (d, t) => {
      if (d % 50 === 0 || d === t) process.stdout.write(`\r  embed ${d}/${t}   `);
    });
    process.stdout.write('\n');

    await setMeta(repo.name, sha);
    const [nc, ne] = [await countChunks(repo.name), await countEmb(repo.name)];
    console.log(
      `✓ full build done: ${chunks} chunks · stored ${nc} · vectors ${ne} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (nc !== ne) console.warn(`⚠ chunk/vector mismatch (${nc} ≠ ${ne})`);
  } finally {
    releaseBuilderLock(repo.name);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
