import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { researchOssConfig } from './research-oss.config.js';

const ENV_KEYS = [
  'RESEARCH_OSS_REGION',
  'RESEARCH_OSS_BUCKET',
  'RESEARCH_OSS_ACCESS_KEY_ID',
  'RESEARCH_OSS_ACCESS_KEY_SECRET',
] as const;

describe('researchOssConfig presence gate', () => {
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

  it('defaults to kind=unconfigured when no RESEARCH_OSS_* set (dev/test boot stays green)', () => {
    expect(researchOssConfig()).toEqual({ kind: 'unconfigured' });
  });

  it('treats all-empty RESEARCH_OSS_* as unconfigured (compose ${VAR:-} feeds "" not undefined)', () => {
    for (const k of ENV_KEYS) process.env[k] = '';
    expect(researchOssConfig()).toEqual({ kind: 'unconfigured' });
  });

  it('throws when partially configured (bucket + ak set, secret missing)', () => {
    process.env.RESEARCH_OSS_REGION = 'oss-cn-shanghai';
    process.env.RESEARCH_OSS_BUCKET = 'research-bucket';
    process.env.RESEARCH_OSS_ACCESS_KEY_ID = 'AK';
    // RESEARCH_OSS_ACCESS_KEY_SECRET left unset
    expect(() => researchOssConfig()).toThrow();
  });

  it('throws when only one key is set (半配 = boot 期报错，不静默降级成 unconfigured)', () => {
    process.env.RESEARCH_OSS_BUCKET = 'research-bucket';
    expect(() => researchOssConfig()).toThrow();
  });

  it('parses the aliyun variant when all four are set', () => {
    process.env.RESEARCH_OSS_REGION = 'oss-cn-shanghai';
    process.env.RESEARCH_OSS_BUCKET = 'research-bucket';
    process.env.RESEARCH_OSS_ACCESS_KEY_ID = 'AK';
    process.env.RESEARCH_OSS_ACCESS_KEY_SECRET = 'SK';
    expect(researchOssConfig()).toEqual({
      kind: 'aliyun',
      region: 'oss-cn-shanghai',
      bucket: 'research-bucket',
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
    });
  });

  it('a blank among otherwise-set keys still throws (空串折叠后仍是「缺」，不是「有」)', () => {
    process.env.RESEARCH_OSS_REGION = 'oss-cn-shanghai';
    process.env.RESEARCH_OSS_BUCKET = 'research-bucket';
    process.env.RESEARCH_OSS_ACCESS_KEY_ID = 'AK';
    process.env.RESEARCH_OSS_ACCESS_KEY_SECRET = '';
    expect(() => researchOssConfig()).toThrow();
  });
});
