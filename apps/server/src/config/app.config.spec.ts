import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appConfig } from './app.config.js';

const ENV_KEYS = ['NODE_ENV', 'PORT', 'LOG_LEVEL', 'CORS_ALLOWED_ORIGINS'] as const;

describe('appConfig', () => {
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

  it('applies defaults when env unset', () => {
    expect(appConfig()).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      corsAllowedOrigins: '*',
    });
  });

  it('coerces PORT string → number', () => {
    process.env.PORT = '8080';
    expect(appConfig().port).toBe(8080);
  });

  it('throws on PORT out of range (65536)', () => {
    process.env.PORT = '65536';
    expect(() => appConfig()).toThrow();
  });

  it('throws on invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(() => appConfig()).toThrow();
  });
});
