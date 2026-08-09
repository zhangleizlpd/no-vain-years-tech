import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SERVER_PORT, serviceToken, DEFAULT_TOPK } from './config.js';
import { EmbedSidecar } from './embed-sidecar.js';
import { extractToken, isAuthorized } from './auth.js';
import { search } from './query.js';
import { listRepos } from './meta.js';

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** Build the query API over an injected sidecar (so tests can pass a fake one).
 *  /healthz is public; every other route requires the service token. */
export function buildServer(sidecar: EmbedSidecar): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

      if (!isAuthorized(extractToken(req.headers.authorization))) {
        return send(res, 401, { error: 'unauthorized' });
      }

      if (method === 'POST' && path === '/preheat') {
        sidecar.preheat(); // SSE-connect hook (S3): warm bge-m3 while user types
        return send(res, 200, { preheating: true });
      }
      if (method === 'GET' && path === '/repos') {
        return send(res, 200, { repos: await listRepos() });
      }
      if (method === 'POST' && path === '/search') {
        const body = await readJson(req);
        const repo = String(body.repo ?? '');
        const query = String(body.query ?? '');
        if (!repo || !query) {
          return send(res, 400, { error: 'repo and query are required' });
        }
        const topK = Number.isFinite(body.topK)
          ? Math.min(50, Math.max(1, Math.trunc(body.topK)))
          : DEFAULT_TOPK;
        return send(res, 200, { results: await search(sidecar, repo, query, topK) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err: any) {
      send(res, 500, { error: err?.message ?? 'internal error' });
    }
  });
}

async function main() {
  if (!serviceToken()) {
    console.error('refusing to start: CODE_INDEX_SERVICE_TOKEN unset (fail-closed)');
    process.exit(1);
  }
  const sidecar = new EmbedSidecar();
  const server = buildServer(sidecar);
  server.listen(SERVER_PORT, () => console.log(`code-index query API on :${SERVER_PORT}`));
  const shutdown = () => {
    server.close();
    sidecar.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// run only when executed directly (not when imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
