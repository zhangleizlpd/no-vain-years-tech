import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { EmbedSidecar } from '../src/embed-sidecar.js';

const fakeWorker = fileURLToPath(new URL('./fixtures/fake-worker.ts', import.meta.url));

describe('EmbedSidecar (forked worker lifecycle)', () => {
  let sc: EmbedSidecar | undefined;
  afterEach(() => {
    sc?.stop();
    sc = undefined;
    delete process.env.FAKE_IDLE_MS;
  });

  it('lazily forks the worker and embeds over IPC', async () => {
    sc = new EmbedSidecar(fakeWorker);
    const [v] = await sc.embed(['hello']);
    expect(v).toEqual([expect.any(Number), 5, 0]); // [pid, text.length, 0]
    expect(sc.dim).toBe(3);
  });

  it('multiplexes concurrent requests by id', async () => {
    sc = new EmbedSidecar(fakeWorker);
    const [a, b] = await Promise.all([sc.embed(['ab']), sc.embed(['abcd'])]);
    expect(a[0][1]).toBe(2);
    expect(b[0][1]).toBe(4);
  });

  it('respawns transparently after the worker self-exits on idle', async () => {
    process.env.FAKE_IDLE_MS = '150';
    sc = new EmbedSidecar(fakeWorker);
    const [v1] = await sc.embed(['x']);
    await new Promise((r) => setTimeout(r, 350)); // worker idle-exits
    const [v2] = await sc.embed(['x']);
    expect(v2[0]).not.toBe(v1[0]); // different pid → a fresh process
  });

  it('preheat() warms the worker so the next embed resolves', async () => {
    sc = new EmbedSidecar(fakeWorker);
    sc.preheat();
    const [v] = await sc.embed(['yo']);
    expect(v[0]).toEqual(expect.any(Number));
  });
});
