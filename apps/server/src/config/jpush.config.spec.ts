import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { jpushConfig } from './jpush.config.js';

const ENV_KEYS = ['JPUSH_GATEWAY', 'JPUSH_APP_KEY', 'JPUSH_MASTER_SECRET'] as const;

describe('jpushConfig discriminated union (022 T002)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to kind=mock when JPUSH_GATEWAY unset', () => {
    expect(jpushConfig()).toEqual({ kind: 'mock' });
  });

  it('returns kind=mock when JPUSH_GATEWAY=mock (no jpush creds required)', () => {
    process.env.JPUSH_GATEWAY = 'mock';
    expect(jpushConfig()).toEqual({ kind: 'mock' });
  });

  it('throws when JPUSH_GATEWAY=jpush but creds partial (appKey only)', () => {
    process.env.JPUSH_GATEWAY = 'jpush';
    process.env.JPUSH_APP_KEY = 'k';
    expect(() => jpushConfig()).toThrow();
  });

  it('throws when JPUSH_GATEWAY=jpush but creds partial (masterSecret only)', () => {
    process.env.JPUSH_GATEWAY = 'jpush';
    process.env.JPUSH_MASTER_SECRET = 's';
    expect(() => jpushConfig()).toThrow();
  });

  it('parses full jpush config when both creds set', () => {
    process.env.JPUSH_GATEWAY = 'jpush';
    process.env.JPUSH_APP_KEY = 'k';
    process.env.JPUSH_MASTER_SECRET = 's';
    expect(jpushConfig()).toEqual({ kind: 'jpush', appKey: 'k', masterSecret: 's' });
  });
});
