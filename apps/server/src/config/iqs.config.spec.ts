import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { iqsConfig } from './iqs.config.js';

const ENV_KEYS = ['IQS_PROVIDER', 'IQS_API_KEY', 'IQS_BASE_URL'] as const;

describe('iqsConfig discriminated union', () => {
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

  it('defaults to kind=mock when IQS_PROVIDER unset (no key needed → boot safe)', () => {
    expect(iqsConfig()).toEqual({ kind: 'mock' });
  });

  it('returns kind=mock when IQS_PROVIDER=mock (no apiKey required)', () => {
    process.env.IQS_PROVIDER = 'mock';
    expect(iqsConfig()).toEqual({ kind: 'mock' });
  });

  it('throws when IQS_PROVIDER=aliyun but IQS_API_KEY missing', () => {
    process.env.IQS_PROVIDER = 'aliyun';
    expect(() => iqsConfig()).toThrow();
  });

  it('parses aliyun config with apiKey + default baseUrl', () => {
    process.env.IQS_PROVIDER = 'aliyun';
    process.env.IQS_API_KEY = 'key-123';
    expect(iqsConfig()).toEqual({
      kind: 'aliyun',
      apiKey: 'key-123',
      baseUrl: 'https://cloud-iqs.aliyuncs.com',
    });
  });

  it('honors IQS_BASE_URL override', () => {
    process.env.IQS_PROVIDER = 'aliyun';
    process.env.IQS_API_KEY = 'key-123';
    process.env.IQS_BASE_URL = 'https://iqs.example.com';
    expect(iqsConfig()).toMatchObject({ kind: 'aliyun', baseUrl: 'https://iqs.example.com' });
  });
});
