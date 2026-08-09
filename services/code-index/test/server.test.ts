import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildServer } from '../src/server.js';
import type { EmbedSidecar } from '../src/embed-sidecar.js';

const TOKEN = 'unit-token';
let preheated = false;
const fakeSidecar = {
  preheat() {
    preheated = true;
  },
  async embed() {
    return [[0, 0, 0]];
  },
} as unknown as EmbedSidecar;

let server: Server;
let base: string;
const savedToken = process.env.CODE_INDEX_SERVICE_TOKEN;

beforeAll(async () => {
  process.env.CODE_INDEX_SERVICE_TOKEN = TOKEN;
  server = buildServer(fakeSidecar);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  if (savedToken === undefined) delete process.env.CODE_INDEX_SERVICE_TOKEN;
  else process.env.CODE_INDEX_SERVICE_TOKEN = savedToken;
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('query API routing + auth', () => {
  it('GET /healthz is public', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('rejects an unauthenticated protected route with 401', async () => {
    const r = await fetch(`${base}/repos`);
    expect(r.status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    const r = await fetch(`${base}/repos`, { headers: { authorization: 'Bearer nope' } });
    expect(r.status).toBe(401);
  });

  it('POST /preheat warms the sidecar', async () => {
    preheated = false;
    const r = await fetch(`${base}/preheat`, { method: 'POST', headers: auth });
    expect(r.status).toBe(200);
    expect(preheated).toBe(true);
  });

  it('POST /search 400s on missing repo/query (before touching the DB)', async () => {
    const r = await fetch(`${base}/search`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'mono' }),
    });
    expect(r.status).toBe(400);
  });

  it('404s an unknown route', async () => {
    const r = await fetch(`${base}/nope`, { headers: auth });
    expect(r.status).toBe(404);
  });
});
