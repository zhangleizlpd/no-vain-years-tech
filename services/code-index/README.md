# @nvy/code-index

Centralized code-index service for **ideation grounding** — the cloud chat (repo-blind)
queries it to retrieve relevant code/docs chunks. tree-sitter chunk → bge-m3 embed →
pgvector. Graduated from the S1 spike.

> **Standalone**: NOT in the nx/pnpm workspace. Own `package.json` + lockfile,
> deploys to a dedicated host. Install with `pnpm install --ignore-workspace`.

- Architecture: [ADR-0059](../../docs/adr/0059-ideation-repo-grounding-code-index.md)
  (双路接地 + 中心化 pgvector RAG) · [ADR-0060](../../docs/adr/0060-ideation-index-runtime-ondemand-models.md)
  (单机按需自托管单模型 + vector-only)
- Plan / decisions: [S2 plan](../../docs/private/plans/2026-06/06-22-ideation-index-s2-service.md)
  (locked: bge-m3 · vector-only α≈1.0 · batch=1 · git-diff-by-SHA increments · 62 host)

## Scope (S2.1 index side + S2.2 query side)

| Built here                                                                                              | Not here                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **S2.1** schema (chunk + emb_bgem3 HNSW + index_meta), full + incremental builders, cron trigger        | systemd units + swapfile + dump/restore deploy → **S2.3** |
| **S2.2** query API (vector-only HNSW), on-demand warm bge-m3 sidecar, repo catalog, builder×query mutex | mobile repo selector + chat tool wiring → **S3**          |

## Corpus (ADR-0059 / S1 语料边界)

High-value SoT layer only: hand-written `apps/server/src` (.ts) + `apps/mobile/src`
(.ts/.tsx) + `packages` (.ts) + `apps/server/prisma` (.prisma) + `docs/adr` (.md) +
`docs/conventions` (.md) + `specs/**/spec.md` + `.specify/memory/constitution.md`.

**Dropped** (high-drift intent layer → local agentic grep): `docs/private/plans`, and within
`specs/` everything but `spec.md` (plan/tasks/analysis/checklist/design). Generated /
test / `.d.ts` excluded everywhere. See `src/config.ts` to adjust per repo.

## Commands

```bash
pnpm install --ignore-workspace   # standalone deps (onnxruntime/sharp/tree-sitter wasm)
pnpm db:up                        # dedicated pgvector PG (compose, port 5434)
pnpm index:full [repo=mono]       # COLD full build — run OFF-BOX (see deploy)
pnpm index:incremental [repo=mono] [--since <sha>]   # re-index lastSha..HEAD
pnpm serve                        # query API (needs CODE_INDEX_SERVICE_TOKEN set)
pnpm typecheck && pnpm test       # local gate (no CI yet — see Gaps)
```

### Deploy model (per 62 PoC, ADR-0060)

The host (62, ~2c/3.4G/no-swap) throughput is 0.2–0.5 chunk/s → a cold full build of
the whole corpus is 5–9h there. So:

1. **Cold build runs off-box** on a fast machine (`pnpm index:full`, ~29min on a Mac).
2. `pg_dump -Fc` → scp → `pg_restore` into the host's pgvector.
3. The host **only ever runs increments** (`scripts/cron-tick.sh`, wrapped by a systemd
   timer in S2.3): every ~2min `git fetch` → compare SHA → fast-forward → spawn one
   `index:incremental` (one-shot process; RAM reclaimed on exit per ADR-0060 §1).

## Schema

- `chunk(id, repo, rel_path, kind, symbol, start_line, end_line, text, tsv)` — `repo` is
  the namespace; `id = sha1(repo:path:lines)[:16]` (stable → upsert in place); `tsv` is a
  CJK-bigram FTS doc (`src/fts.ts`, PG has no zh tokenizer).
- `emb_bgem3(chunk_id → chunk, vec vector(1024))` + HNSW (cosine). `ON DELETE CASCADE`
  so dropping a chunk drops its vector.
- `index_meta(repo, last_sha, indexed_at)` — incremental baseline.

`initSchema()` is idempotent (CREATE IF NOT EXISTS, no DROP) — safe on every run.

## Query API (S2.2, ADR-0060)

A long-running HTTP server that holds **no model**. On first query it lazily forks an
on-demand **bge-m3 worker** (cold ~5–15s), keeps it warm for the session (queries ms),
and the worker self-exits after `CODE_INDEX_IDLE_MS` idle — only process exit reclaims
ORT arena RAM. All routes but `/healthz` require `Authorization: Bearer <token>`
(constant-time check, fail-closed: no `CODE_INDEX_SERVICE_TOKEN` → refuses to start).

| route           | body / result                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`  | `{ok:true}` (public)                                                                                                                     |
| `POST /search`  | `{repo, query, topK?}` → `{results:[{relPath,kind,symbol,startLine,endLine,score,text}]}` — vector-only HNSW top-k in the repo namespace |
| `GET /repos`    | `{repos:[{repo,lastSha,indexedAt,chunkCount,status}]}` — catalog for the S3 repo selector                                                |
| `POST /preheat` | warms the worker — the SSE-connect hook (S3) so the first query isn't a cold start                                                       |

**builder×query mutex**: the warm worker touches the heartbeat file; `cron-tick.sh`
skips an index tick while it's fresh → ≤1 bge-m3 in RAM (query > index priority).

## Env

| var                                          | default                           | use                                          |
| -------------------------------------------- | --------------------------------- | -------------------------------------------- |
| `CODE_INDEX_REPO_MONO_ROOT`                  | mono root (3 up)                  | the checkout the host indexes                |
| `CODE_INDEX_PG_{HOST,PORT,USER,PASSWORD,DB}` | localhost:5434 / codeindex×3      | pgvector connection                          |
| `CODE_INDEX_HF_CACHE`                        | `./.hf-cache`                     | ONNX weight cache                            |
| `CODE_INDEX_EMBED_MAX_CHARS`                 | 1200                              | embed-input truncation (#1 throughput lever) |
| `CODE_INDEX_DTYPE`                           | q8                                | ONNX precision                               |
| `HF_ENDPOINT`                                | hf-mirror.com                     | HF host (CN can't reach hf.co)               |
| `CODE_INDEX_SERVICE_TOKEN`                   | — (fail-closed)                   | query API bearer token (required to serve)   |
| `CODE_INDEX_PORT`                            | 7700                              | query API port                               |
| `CODE_INDEX_IDLE_MS`                         | 300000                            | warm-worker idle self-exit                   |
| `CODE_INDEX_HEARTBEAT`                       | `/tmp/code-index-query.heartbeat` | mutex file (MUST match cron-tick.sh)         |
| `CODE_INDEX_LOCK_DIR`                        | `/tmp`                            | builder `indexing` lock dir (meta status)    |
| `CODE_INDEX_TOPK`                            | 8                                 | default search top-k                         |

## Gaps (deferred)

- **No CI yet** — `.nxignore`d like `scripts/jobs/holdings-sync` (nx's plugins would else
  false-detect it and run typecheck/lint in `nx affected`, but CI's frozen workspace
  install never installs these outside-workspace deps → red). Gate is local
  `pnpm typecheck && pnpm test`; a path-filtered dedicated CI job lands in **S2.3**.
- `symbol` is null on exported declarations (`export function`/`class` parse as an
  `export_statement` wrapper the chunker doesn't unwrap) — cosmetic; the name lives in
  the chunk text, which is what retrieval scores. Validated bake-off (REPORT 4/4) ran
  with this behavior; not changed here.
