import { describe, it, expect } from 'vitest';
import {
  buildPostObjectCredential,
  IMAGE_WHITELIST,
  type PostObjectCredentialInput,
} from './oss-policy.js';

const BASE: PostObjectCredentialInput = {
  region: 'oss-cn-shanghai',
  bucket: 'nvy-profile-images',
  accessKeyId: 'LTAI-test-ak',
  accessKeySecret: 'test-sk',
  keyPrefix: 'avatar/42/',
  maxSizeBytes: 5 * 1024 * 1024,
  ttlMs: 15 * 60_000,
  now: new Date('2026-06-01T12:00:00.000Z'),
  uuid: '11111111-2222-3333-4444-555555555555',
};

function decodePolicy(base64: string): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

describe('buildPostObjectCredential — object key (anti-enumeration, parameterized prefix)', () => {
  it('key = <keyPrefix><uuid>/img, locked to the caller-supplied prefix', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(cred.objectKey).toBe('avatar/42/11111111-2222-3333-4444-555555555555/img');
    expect(cred.fields.key).toBe(cred.objectKey);
  });

  it('any caller prefix flows through verbatim — no avatar/background enum baked in', () => {
    const avatar = buildPostObjectCredential({ ...BASE, keyPrefix: 'avatar/42/' });
    const background = buildPostObjectCredential({ ...BASE, keyPrefix: 'background/42/' });
    const ideation = buildPostObjectCredential({ ...BASE, keyPrefix: 'ideation/42/' });
    expect(avatar.objectKey).toBe('avatar/42/11111111-2222-3333-4444-555555555555/img');
    expect(background.objectKey).toBe('background/42/11111111-2222-3333-4444-555555555555/img');
    expect(ideation.objectKey).toBe('ideation/42/11111111-2222-3333-4444-555555555555/img');
  });

  it('signed policy starts-with constrains $key to the given prefix', () => {
    const cred = buildPostObjectCredential({ ...BASE, keyPrefix: 'ideation/77/' });
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toContainEqual(['starts-with', '$key', 'ideation/77/']);
  });
});

describe('buildPostObjectCredential — object key leaf (parameterized, 057)', () => {
  it('explicit keyLeaf replaces the img leaf', () => {
    const cred = buildPostObjectCredential({
      ...BASE,
      keyPrefix: 'research/',
      keyLeaf: 'report.pdf',
    });
    expect(cred.objectKey).toBe('research/11111111-2222-3333-4444-555555555555/report.pdf');
    expect(cred.fields.key).toBe(cred.objectKey);
  });

  it('omitting keyLeaf → /img (backward compatible: the three image callers stay byte-identical)', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(cred.objectKey).toBe('avatar/42/11111111-2222-3333-4444-555555555555/img');
  });

  it('keyLeaf is NOT signed — the policy constrains the prefix only, so the leaf is free', () => {
    const img = buildPostObjectCredential(BASE);
    const pdf = buildPostObjectCredential({ ...BASE, keyLeaf: 'report.pdf' });
    expect(img.fields['x-oss-signature']).toBe(pdf.fields['x-oss-signature']);
    expect(decodePolicy(pdf.fields.policy).conditions).toContainEqual([
      'starts-with',
      '$key',
      'avatar/42/',
    ]);
  });
});

describe('buildPostObjectCredential — region double-form', () => {
  it('host endpoint keeps the oss- prefix', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(cred.host).toBe('https://nvy-profile-images.oss-cn-shanghai.aliyuncs.com');
  });

  it('x-oss-credential scope uses the bare region (no oss- prefix)', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(cred.fields['x-oss-credential']).toBe(
      'LTAI-test-ak/20260601/cn-shanghai/oss/aliyun_v4_request',
    );
  });
});

describe('buildPostObjectCredential — policy conditions', () => {
  it('embeds the V4 trio + key prefix + content-type whitelist + size + status', () => {
    const cred = buildPostObjectCredential(BASE);
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toEqual([
      { bucket: 'nvy-profile-images' },
      { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' },
      { 'x-oss-credential': 'LTAI-test-ak/20260601/cn-shanghai/oss/aliyun_v4_request' },
      { 'x-oss-date': '20260601T120000Z' },
      ['starts-with', '$key', 'avatar/42/'],
      ['in', '$content-type', [...IMAGE_WHITELIST]],
      ['content-length-range', 1, 5 * 1024 * 1024],
      ['eq', '$success_action_status', '200'],
    ]);
  });

  it('expiration = now + ttl, millis zeroed (.000Z)', () => {
    const cred = buildPostObjectCredential(BASE);
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.expiration).toBe('2026-06-01T12:15:00.000Z');
    expect(cred.expiresAt).toBe('2026-06-01T12:15:00.000Z');
  });

  it('maxSizeBytes flows into content-length-range', () => {
    const cred = buildPostObjectCredential({ ...BASE, maxSizeBytes: 1234 });
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 1234]);
  });
});

describe('buildPostObjectCredential — content-type whitelist (parameterized, 037)', () => {
  it('omitting contentTypeWhitelist → defaults to IMAGE_WHITELIST (backward compatible)', () => {
    const cred = buildPostObjectCredential(BASE);
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toContainEqual(['in', '$content-type', [...IMAGE_WHITELIST]]);
  });

  it('explicit contentTypeWhitelist flows into the signed policy verbatim', () => {
    const cred = buildPostObjectCredential({ ...BASE, contentTypeWhitelist: ['text/html'] });
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toContainEqual(['in', '$content-type', ['text/html']]);
    // image whitelist must NOT leak in when an explicit list is given
    expect(policy.conditions).not.toContainEqual(['in', '$content-type', [...IMAGE_WHITELIST]]);
  });

  it('multi-entry contentTypeWhitelist is preserved in order', () => {
    const cred = buildPostObjectCredential({
      ...BASE,
      contentTypeWhitelist: ['text/html', 'application/json'],
    });
    const policy = decodePolicy(cred.fields.policy);
    expect(policy.conditions).toContainEqual([
      'in',
      '$content-type',
      ['text/html', 'application/json'],
    ]);
  });

  it('different content-type whitelist → different signature (whitelist is signed)', () => {
    const a = buildPostObjectCredential(BASE);
    const b = buildPostObjectCredential({ ...BASE, contentTypeWhitelist: ['text/html'] });
    expect(a.fields['x-oss-signature']).not.toBe(b.fields['x-oss-signature']);
  });
});

describe('buildPostObjectCredential — form fields shape (V4)', () => {
  it('exposes exactly the V4 form fields', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(Object.keys(cred.fields).sort()).toEqual(
      [
        'key',
        'policy',
        'success_action_status',
        'x-oss-credential',
        'x-oss-date',
        'x-oss-signature',
        'x-oss-signature-version',
      ].sort(),
    );
    expect(cred.fields['x-oss-signature-version']).toBe('OSS4-HMAC-SHA256');
    expect(cred.fields.success_action_status).toBe('200');
    expect(cred.fields['x-oss-date']).toBe('20260601T120000Z');
  });
});

describe('buildPostObjectCredential — signature (deterministic, lowercase hex)', () => {
  it('signature is 64-char lowercase hex', () => {
    const cred = buildPostObjectCredential(BASE);
    expect(cred.fields['x-oss-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input → same signature (determinism via injected now+uuid)', () => {
    const a = buildPostObjectCredential(BASE);
    const b = buildPostObjectCredential(BASE);
    expect(a.fields['x-oss-signature']).toBe(b.fields['x-oss-signature']);
  });

  it('different secret → different signature', () => {
    const a = buildPostObjectCredential(BASE);
    const b = buildPostObjectCredential({ ...BASE, accessKeySecret: 'other-sk' });
    expect(a.fields['x-oss-signature']).not.toBe(b.fields['x-oss-signature']);
  });

  it('different keyPrefix → different signature (key prefix is signed)', () => {
    const a = buildPostObjectCredential(BASE);
    const b = buildPostObjectCredential({ ...BASE, keyPrefix: 'background/99/' });
    expect(a.fields['x-oss-signature']).not.toBe(b.fields['x-oss-signature']);
  });

  it('different signing day → different signature (date is signed)', () => {
    const a = buildPostObjectCredential(BASE);
    const b = buildPostObjectCredential({ ...BASE, now: new Date('2026-06-02T12:00:00.000Z') });
    expect(a.fields['x-oss-signature']).not.toBe(b.fields['x-oss-signature']);
  });
});
