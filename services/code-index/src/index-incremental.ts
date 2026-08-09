import { resolveRepo, MODEL } from './config.js';
import { initParser } from './chunk.js';
import { makeEmbedder } from './embed.js';
import {
  pool,
  initSchema,
  deleteChunksForPaths,
  getMeta,
  setMeta,
  countChunks,
  countEmb,
} from './db.js';
import { inCorpus } from './corpus.js';
import { indexFiles } from './indexer.js';
import { headSha, diffNameStatus } from './git.js';
import { acquireBuilderLock, releaseBuilderLock } from './lock.js';

/**
 * Incremental build: re-index only what changed between the last indexed SHA and
 * the checkout's current HEAD (git is the Merkle tree). The host runs this; cron
 * does the `git fetch` + fast-forward, then spawns this one-shot process so RAM is
 * reclaimed on exit (ADR-0060 §1). Deleted/renamed files drop their stale chunks.
 *
 * Usage: tsx src/index-incremental.ts [repo=mono] [--since <sha>]
 */
async function main() {
  const args = process.argv.slice(2);
  const sinceFlag = args.indexOf('--since');
  const sinceArg = sinceFlag >= 0 ? args[sinceFlag + 1] : undefined;
  const sinceValueIdx = sinceFlag >= 0 ? sinceFlag + 1 : -1;
  const repoName = args.find((a, i) => !a.startsWith('--') && i !== sinceValueIdx) || 'mono';

  const repo = resolveRepo(repoName);
  if (!acquireBuilderLock(repo.name)) {
    console.log(
      `another builder is already indexing '${repo.name}' — skipping (≤1 bge-m3, ADR-0060)`,
    );
    await pool.end();
    return;
  }
  try {
    await initSchema();
    const from = sinceArg || (await getMeta(repo.name))?.lastSha;
    if (!from) {
      throw new Error(
        `no baseline SHA for repo '${repo.name}' — run \`tsx src/index-full.ts ${repo.name}\` (or pass --since <sha>) first`,
      );
    }
    const to = headSha(repo.root);
    console.log(`→ incremental: repo=${repo.name} ${from.slice(0, 8)}..${to.slice(0, 8)}`);

    if (from === to) {
      console.log('  HEAD unchanged — nothing to do');
      return;
    }

    const diff = diffNameStatus(repo.root, from, to);
    const changed = diff.changed.filter((p) => inCorpus(repo, p));
    const deleted = diff.deleted.filter((p) => inCorpus(repo, p));
    console.log(`  corpus delta: ${changed.length} changed · ${deleted.length} deleted`);

    // delete stale chunks for both changed (boundaries shift) and removed files
    await deleteChunksForPaths(repo.name, [...new Set([...changed, ...deleted])]);

    let chunks = 0;
    if (changed.length) {
      await initParser();
      const e = await makeEmbedder();
      if (e.dim !== MODEL.dim) {
        throw new Error(`embedder dim ${e.dim} ≠ schema dim ${MODEL.dim} (${MODEL.table})`);
      }
      ({ chunks } = await indexFiles(repo.name, e, repo.root, changed, (d, t) => {
        if (d % 25 === 0 || d === t) process.stdout.write(`\r  embed ${d}/${t}   `);
      }));
      process.stdout.write('\n');
    }

    await setMeta(repo.name, to); // advance baseline even if delta was deletions-only
    const [nc, ne] = [await countChunks(repo.name), await countEmb(repo.name)];
    console.log(`✓ incremental done: +${chunks} chunks · stored ${nc} · vectors ${ne}`);
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
