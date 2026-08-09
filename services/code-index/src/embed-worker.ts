import { makeEmbedder } from './embed.js';
import { IDLE_EXIT_MS } from './config.js';
import { touchHeartbeat, removeHeartbeat } from './lock.js';

/**
 * On-demand bge-m3 embedding worker (ADR-0060 §1-2). Forked by the query API's
 * EmbedSidecar. Loads the model once (cold ~5–15s), embeds queries over the IPC
 * channel (warm ms), refreshes the query heartbeat, and self-exits after
 * IDLE_EXIT_MS so the OS reclaims ORT arena memory (only process exit frees it).
 *
 * Protocol (process.send / 'message'):
 *   ↓ parent → worker:  { id: number, texts: string[] }
 *   ↑ worker → parent:  { ready: true, dim }  |  { id, vecs }  |  { id, error }
 */
const HEARTBEAT_REFRESH_MS = 30_000;

async function main() {
  const e = await makeEmbedder();

  let idleTimer: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(), IDLE_EXIT_MS);
    idleTimer.unref();
  };
  const shutdown = () => {
    removeHeartbeat();
    process.exit(0);
  };

  const hb = setInterval(touchHeartbeat, HEARTBEAT_REFRESH_MS);
  hb.unref();
  touchHeartbeat();
  resetIdle();
  process.on('exit', removeHeartbeat);

  process.on('message', async (msg: { id: number; texts: string[] }) => {
    resetIdle();
    touchHeartbeat();
    try {
      const vecs = await e.embed(msg.texts);
      process.send?.({ id: msg.id, vecs });
    } catch (err: any) {
      process.send?.({ id: msg.id, error: err?.message ?? String(err) });
    }
  });

  process.send?.({ ready: true, dim: e.dim });
}

main().catch((err) => {
  console.error('[embed-worker] fatal', err);
  process.exit(1);
});
