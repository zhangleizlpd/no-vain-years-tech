import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// services/code-index/src → up 1 = service root, up 3 = mono repo root.
export const SERVICE_ROOT = path.resolve(__dirname, '..');
const MONO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface SourceDir {
  dir: string;
  exts: string[];
  /** optional basename allowlist within the tree (specs → only spec.md, dropping
   *  the plan/tasks/analysis/checklist intent layer that also lives there) */
  only?: (relPath: string) => boolean;
}

/** A repo the service indexes. `root` is the local checkout it reads + git-diffs;
 *  env-overridable so the dedicated host (S2 plan) points at its own clone.
 *  `name` is the pgvector namespace (chunk.repo column) — keep it stable. */
export interface RepoCfg {
  name: string;
  root: string;
  sourceDirs: SourceDir[];
  /** high-value single files outside the indexed trees (constitution / README) */
  extraFiles: string[];
}

/** Corpus scoping (ADR-0059 / S1 语料边界结论): high-value SoT layer only —
 *  hand-written code + prisma schema + ADR/spec.md/conventions/constitution/README.
 *  Drop plan/tasks/design/generated (high-drift intent layer → local agentic grep).
 *  NOTE: the S1 spike indexed all of specs/**.md; production narrows to spec.md. */
const MONO_SOURCE_DIRS: SourceDir[] = [
  { dir: 'specs', exts: ['.md'], only: (rel) => path.basename(rel) === 'spec.md' },
  { dir: 'docs/adr', exts: ['.md'] },
  { dir: 'docs/conventions', exts: ['.md'] }, // naming / bounded-context / rules
  { dir: 'apps/server/src', exts: ['.ts'] },
  { dir: 'apps/server/prisma', exts: ['.prisma'] }, // data model = SoT
  { dir: 'apps/mobile/src', exts: ['.ts', '.tsx'] },
  { dir: 'packages', exts: ['.ts'] }, // shared types + api-client (dist/generated excluded)
];

// Single files the corpus decision names but that sit outside the trees above.
// constitution is the only true outsider — the repo has no root README, and the
// one high-value README (docs/adr/README.md, the ADR catalog) already falls under
// the docs/adr tree. scripts/* READMEs are tool-local, intentionally out of scope.
const MONO_EXTRA_FILES = ['.specify/memory/constitution.md'];

export const REPOS: Record<string, RepoCfg> = {
  mono: {
    name: 'mono',
    root: process.env.CODE_INDEX_REPO_MONO_ROOT || MONO_ROOT,
    sourceDirs: MONO_SOURCE_DIRS,
    extraFiles: MONO_EXTRA_FILES,
  },
};

export function resolveRepo(name: string): RepoCfg {
  const r = REPOS[name];
  if (!r) {
    throw new Error(`unknown repo '${name}' (known: ${Object.keys(REPOS).join(', ')})`);
  }
  return r;
}

/** Skip generated / test / type-decl noise — keeps the index on real source. */
export const EXCLUDE_RE =
  /(\.spec\.ts|\.test\.ts|\.d\.ts)$|[/\\](generated|node_modules|dist)[/\\]/;

/** Chunk kinds that are syntactic noise, not useful retrieval targets — dropped
 *  to cut ~23% volume (and embedding time) without losing real content. */
export const DROP_KINDS = new Set<string>([
  'comment',
  'comment-split',
  'import_statement',
  'decorator',
  'formal_parameters',
  'return_statement',
  'type_annotation',
  'class_heritage',
  'class_body',
  'statement_block',
  'parenthesized_expression',
  'jsx_opening_element',
  'jsx_expression',
  'expression_statement',
  'call_expression',
  'catch_clause',
  'try_statement',
  'for_in_statement',
  'if_statement',
  'switch_statement',
]);

/** Long prose chunks (ADR/spec/conventions md) dominate CPU embedding cost. The
 *  topic lives in the head, enough for retrieval, so truncate the embed INPUT —
 *  the full chunk text is still STORED (for FTS + display). 0 = no truncation.
 *  Per S1: the #1 throughput lever on the no-swap host. */
export const EMBED_MAX_CHARS = Number(process.env.CODE_INDEX_EMBED_MAX_CHARS || 1200);

/** The single self-hosted model (ADR-0060): bge-m3, vector-only α≈1.0 baseline.
 *  `ids` tried in order; first that loads wins (handles ONNX-port availability). */
export const MODEL = {
  ids: ['Xenova/bge-m3', 'BAAI/bge-m3'],
  pooling: 'cls' as const, // BGE family uses CLS pooling
  table: 'emb_bgem3',
  dim: 1024,
};

// ONNX precision. q8 is the realistic CPU deployment config (nobody serves fp32
// bge-m3 on CPU); override with CODE_INDEX_DTYPE=fp32 only to re-verify quality.
export const DTYPE = (process.env.CODE_INDEX_DTYPE as string) || 'q8';

export const DB = {
  host: process.env.CODE_INDEX_PG_HOST || 'localhost',
  port: Number(process.env.CODE_INDEX_PG_PORT || 5434),
  user: process.env.CODE_INDEX_PG_USER || 'codeindex',
  password: process.env.CODE_INDEX_PG_PASSWORD || 'codeindex',
  database: process.env.CODE_INDEX_PG_DB || 'codeindex',
};

// ── query-side runtime (S2.2, ADR-0060) ───────────────────────────────────────
export const SERVER_PORT = Number(process.env.CODE_INDEX_PORT || 7700);
/** Service token, read live (testable + rotatable without restart). Fail-closed:
 *  the server refuses to start if unset, and an empty token never authorizes. */
export const serviceToken = (): string => process.env.CODE_INDEX_SERVICE_TOKEN || '';
/** Query-worker liveness file. The bge-m3 worker touches it while resident; the
 *  cron builder (scripts/cron-tick.sh) skips a tick if it's fresh → ≤1 model in
 *  RAM. MUST match cron-tick.sh's CODE_INDEX_HEARTBEAT default. */
export const HEARTBEAT_PATH = process.env.CODE_INDEX_HEARTBEAT || '/tmp/code-index-query.heartbeat';
/** Idle timeout after which the warm bge-m3 worker self-exits to free ORT RAM
 *  (only process exit reclaims it — ADR-0060 §1). */
export const IDLE_EXIT_MS = Number(process.env.CODE_INDEX_IDLE_MS || 5 * 60_000);
/** Dir for builder `<repo>.indexing` locks (meta `status` + observability). */
export const LOCK_DIR = process.env.CODE_INDEX_LOCK_DIR || '/tmp';
export const DEFAULT_TOPK = Number(process.env.CODE_INDEX_TOPK || 8);
