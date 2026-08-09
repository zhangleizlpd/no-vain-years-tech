import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { wechatConfig } from './wechat.config.js';

const ENV_KEYS = ['WECHAT_GATEWAY', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET'] as const;

describe('wechatConfig discriminated union', () => {
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

  it('defaults to kind=mock when WECHAT_GATEWAY unset', () => {
    expect(wechatConfig()).toEqual({ kind: 'mock' });
  });

  it('returns kind=mock when WECHAT_GATEWAY=mock (no real creds required)', () => {
    process.env.WECHAT_GATEWAY = 'mock';
    expect(wechatConfig()).toEqual({ kind: 'mock' });
  });

  it('throws when WECHAT_GATEWAY=real but appSecret missing', () => {
    process.env.WECHAT_GATEWAY = 'real';
    process.env.WECHAT_APP_ID = 'wx_app_id';
    expect(() => wechatConfig()).toThrow();
  });

  it('throws when WECHAT_GATEWAY=real but appId missing', () => {
    process.env.WECHAT_GATEWAY = 'real';
    process.env.WECHAT_APP_SECRET = 'secret';
    expect(() => wechatConfig()).toThrow();
  });

  it('parses full real config when both WECHAT_APP_ID + WECHAT_APP_SECRET set', () => {
    process.env.WECHAT_GATEWAY = 'real';
    process.env.WECHAT_APP_ID = 'wx_app_id';
    process.env.WECHAT_APP_SECRET = 'secret';
    expect(wechatConfig()).toEqual({
      kind: 'real',
      appId: 'wx_app_id',
      appSecret: 'secret',
    });
  });
});
