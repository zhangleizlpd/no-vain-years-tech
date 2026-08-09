import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { SERVICE_ROOT, DTYPE, MODEL } from './config.js';

// Cache ONNX weights inside the service dir so re-runs don't re-download.
env.cacheDir = process.env.CODE_INDEX_HF_CACHE || path.join(SERVICE_ROOT, '.hf-cache');
env.allowRemoteModels = true;
// huggingface.co is unreachable from CN — route downloads through the official
// mirror (overridable). transformers.js reads env.remoteHost for the HF host.
(env as any).remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

export interface Embedder {
  usedId: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export async function makeEmbedder(): Promise<Embedder> {
  let extractor: any = null;
  let usedId = '';
  for (const id of MODEL.ids) {
    try {
      extractor = await pipeline('feature-extraction', id, { dtype: DTYPE as any });
      usedId = id;
      break;
    } catch (e: any) {
      console.warn(`  [bge-m3] load failed ${id}: ${e?.message ?? e}`);
    }
  }
  if (!extractor) throw new Error(`no model loaded (${MODEL.ids.join(', ')})`);

  const run = async (texts: string[]): Promise<number[][]> => {
    const out = await extractor(texts, { pooling: MODEL.pooling, normalize: true });
    return out.tolist() as number[][];
  };

  // probe real dim (decouples table DDL from hardcoded dims / fallback model)
  const [probe] = await run(['dimension probe']);
  return { usedId, dim: probe.length, embed: run };
}

/** Embed one input at a time (batch=1). Per the 62 PoC (ADR-0060): batching to 16
 *  buys ~30% throughput but pushes RSS to the no-swap OOM edge — not worth it.
 *
 *  `onStore` runs right after each vector is produced, so the caller persists as it
 *  goes instead of collecting the whole batch first. That ordering is the difference
 *  between losing one chunk and losing all of them: on 2026-08-09 a 1426-chunk batch
 *  was SIGTERMed at the unit's start timeout after ~90min and, because the vectors
 *  were still in an in-memory array, all 98 files were left with text but no vector —
 *  invisible to vector search. Awaiting the callback also keeps the batch=1 RAM
 *  promise (nothing accumulates across iterations). */
export async function embedSequential(
  e: Embedder,
  texts: string[],
  onStore: (i: number, vec: number[]) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < texts.length; i++) {
    const [v] = await e.embed([texts[i]]);
    await onStore(i, v);
    onProgress?.(i + 1, texts.length);
  }
}
