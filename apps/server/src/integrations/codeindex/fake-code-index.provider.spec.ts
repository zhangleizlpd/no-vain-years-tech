import { describe, it, expect } from 'vitest';
import { FakeCodeIndexProvider } from './fake-code-index.provider.js';
import type { CodeChunk, RepoCatalogEntry } from './code-index.port.js';

const hitA: CodeChunk = {
  relPath: 'apps/server/src/a.ts',
  kind: 'function',
  symbol: 'doA',
  startLine: 1,
  endLine: 10,
  score: 0.9,
  text: 'function doA() {}',
};
const hitB: CodeChunk = { ...hitA, relPath: 'apps/server/src/b.ts', symbol: 'doB' };

const repoReady: RepoCatalogEntry = {
  repo: 'mono',
  lastSha: 'abc123',
  indexedAt: '2026-06-23T00:00:00.000Z',
  chunkCount: 42,
  status: 'ready',
};

describe('FakeCodeIndexProvider', () => {
  describe('search — 确定性命中 + 命名空间隔离', () => {
    it('returns configured hits for a repo present in hitsByRepo', async () => {
      const p = new FakeCodeIndexProvider({ hitsByRepo: { mono: [hitA] } });
      await expect(p.search('mono', 'q')).resolves.toEqual([hitA]);
    });

    it('isolates namespaces — repoA hits A, repoB hits B', async () => {
      const p = new FakeCodeIndexProvider({
        hitsByRepo: { repoA: [hitA], repoB: [hitB] },
      });
      await expect(p.search('repoA', 'q')).resolves.toEqual([hitA]);
      await expect(p.search('repoB', 'q')).resolves.toEqual([hitB]);
    });

    it('returns [] (0 命中) for an unconfigured repo — NOT a throw (FR-009 分流)', async () => {
      const p = new FakeCodeIndexProvider({ hitsByRepo: { mono: [hitA] } });
      await expect(p.search('unknown', 'q')).resolves.toEqual([]);
    });

    it('returns [] when no hitsByRepo configured', async () => {
      const p = new FakeCodeIndexProvider();
      await expect(p.search('mono', 'q')).resolves.toEqual([]);
    });
  });

  describe('listRepos', () => {
    it('returns configured catalog', async () => {
      const p = new FakeCodeIndexProvider({ repos: [repoReady] });
      await expect(p.listRepos()).resolves.toEqual([repoReady]);
    });

    it('returns [] (空态) by default', async () => {
      const p = new FakeCodeIndexProvider();
      await expect(p.listRepos()).resolves.toEqual([]);
    });
  });

  describe('unreachable 态 — 驱动 FR-008 降级 / catalog 错误态', () => {
    it('search throws when unreachable injected', async () => {
      const p = new FakeCodeIndexProvider({ unreachable: true, hitsByRepo: { mono: [hitA] } });
      await expect(p.search('mono', 'q')).rejects.toThrow(/UNREACHABLE/);
    });

    it('listRepos throws when unreachable injected', async () => {
      const p = new FakeCodeIndexProvider({ unreachable: true, repos: [repoReady] });
      await expect(p.listRepos()).rejects.toThrow(/UNREACHABLE/);
    });
  });

  describe('abort 尊重', () => {
    it('search throws when signal already aborted', async () => {
      const p = new FakeCodeIndexProvider({ hitsByRepo: { mono: [hitA] } });
      await expect(p.search('mono', 'q', AbortSignal.abort())).rejects.toThrow(/ABORTED/);
    });

    it('listRepos throws when signal already aborted', async () => {
      const p = new FakeCodeIndexProvider({ repos: [repoReady] });
      await expect(p.listRepos(AbortSignal.abort())).rejects.toThrow(/ABORTED/);
    });
  });
});
