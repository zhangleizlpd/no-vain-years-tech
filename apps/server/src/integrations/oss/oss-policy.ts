import { createHmac } from 'node:crypto';

/**
 * Aliyun OSS PostObject form-direct-upload credential signer — generic vendor
 * I/O port (ADR-0058 平台层; moved here from `account/oss-policy.ts` per 036 D3
 * so account + ideation can both consume one signing path). Pure function, zero
 * OSS SDK, Node built-in `crypto` only. Server signs a scope-restricted one-shot
 * credential; the client POSTs the image bytes straight to OSS (backend never
 * proxies bytes, SC-007).
 *
 * **平台层 — 不绑任何业务 ctx**: the caller supplies the object-key prefix
 * (`keyPrefix`) and the per-upload byte ceiling (`maxSizeBytes`); the signer
 * knows nothing about account `avatar`/`background` targets or ideation
 * attachments. (Before 036 D3 the signer hard-bound an `avatar|background`
 * enum — that account concept now lives in `account/oss-policy.ts` and the
 * caller maps it to a prefix.)
 *
 * Signature primitive = **OSS V4 (OSS4-HMAC-SHA256)**, the form the provisioned
 * bucket requires. (NB: plan.md/tasks.md EP1 sketched a V1-style `fields` list —
 * `OSSAccessKeyId`/`signature` — which the real bucket rejects with 403
 * SignatureDoesNotMatch. V4 is implemented here per the verified provisioning.)
 *
 * Algorithm (verified against Aliyun SDK v2 post_object samples):
 *  1. policy.conditions carry the V4 trio (signature-version / credential / date)
 *     as objects AND constrain key-prefix + content-type whitelist + size + the
 *     200 success status. The trio must appear in BOTH the signed policy and the
 *     client form — missing either side → 403.
 *  2. `policy` field = base64(UTF-8 JSON); this base64 string is also the signed
 *     message.
 *  3. signing key = 4-layer HMAC-SHA256 derivation, first key = the literal
 *     string `"aliyun_v4" + secret`: yyyymmdd → bareRegion → "oss" →
 *     "aliyun_v4_request".
 *  4. signature = HMAC-SHA256(signingKey, base64Policy) → lowercase hex.
 *  5. region double-form: the V4 credential scope uses the *bare* region
 *     (`cn-shanghai`); the host endpoint keeps the `oss-` prefix
 *     (`oss-cn-shanghai`). Mixing them up → 403.
 *
 * `now` + `uuid` are injected (not read from the ambient clock / RNG) so the
 * signature is deterministic and unit-testable.
 */

export const IMAGE_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageContentType = (typeof IMAGE_WHITELIST)[number];

export interface PostObjectCredentialInput {
  /** Endpoint-form region incl. the `oss-` prefix, e.g. `oss-cn-shanghai`. */
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  /**
   * Object-key prefix the credential is locked to (signed via `starts-with`),
   * e.g. `avatar/42/` or `ideation/42/`. Caller-supplied so the platform signer
   * stays business-agnostic; conventionally ends with `/`.
   */
  keyPrefix: string;
  /** Per-upload byte ceiling enforced server-side by OSS (content-length-range). */
  maxSizeBytes: number;
  /**
   * Content-type whitelist the credential constrains the upload to (signed via
   * `['in', '$content-type', [...]]`). Caller-supplied so the platform signer
   * stays business-agnostic — image callers (account avatar/background,
   * ideation attachment) omit it and inherit `IMAGE_WHITELIST`; the mockup
   * caller passes `['text/html']`. Optional → defaults to `IMAGE_WHITELIST`
   * (backward compatible: existing callers stay byte-identical).
   */
  contentTypeWhitelist?: readonly string[];
  /**
   * Trailing object-key segment appended after the per-upload uuid, e.g.
   * `report.pdf`. Caller-supplied so non-image payloads get a semantic leaf;
   * the signed policy constrains the *prefix* only, so the leaf is free.
   * Optional → defaults to `img` (backward compatible: the three image callers
   * stay byte-identical).
   */
  keyLeaf?: string;
  /** Credential validity window in ms (e.g. 15min). */
  ttlMs: number;
  /** Injected signing instant (determinism). */
  now: Date;
  /** Injected object-key uuid, e.g. crypto.randomUUID() at the call site. */
  uuid: string;
}

export interface PostObjectCredentialFields {
  key: string;
  policy: string;
  'x-oss-signature-version': 'OSS4-HMAC-SHA256';
  'x-oss-credential': string;
  'x-oss-date': string;
  'x-oss-signature': string;
  success_action_status: '200';
}

export interface PostObjectCredential {
  /** Bucket root URL the client POSTs the multipart form to. */
  host: string;
  /** Pre-allocated object key (also embedded in `fields.key`). */
  objectKey: string;
  /** ISO-8601 credential expiration (ms zeroed), for client display / EP1 echo. */
  expiresAt: string;
  fields: PostObjectCredentialFields;
}

/** yyyymmddTHHmmssZ (compact basic-format, UTC) from an ISO instant. */
function compactDateTime(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** yyyymmdd (UTC) from an ISO instant. */
function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function buildPostObjectCredential(input: PostObjectCredentialInput): PostObjectCredential {
  const {
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    keyPrefix,
    maxSizeBytes,
    contentTypeWhitelist = IMAGE_WHITELIST,
    keyLeaf = 'img',
    ttlMs,
    now,
    uuid,
  } = input;

  const bareRegion = region.replace(/^oss-/, '');
  const host = `https://${bucket}.${region}.aliyuncs.com`;

  const objectKey = `${keyPrefix}${uuid}/${keyLeaf}`;

  // expiration: floor to whole seconds so the JSON carries `.000Z` (OSS V4 expects
  // millis zeroed); x-oss-date is the signing instant (now), not the expiration.
  const expiresAt = new Date(Math.floor((now.getTime() + ttlMs) / 1000) * 1000).toISOString();
  const xOssDate = compactDateTime(now);
  const yyyymmdd = dateStamp(now);

  const credential = `${accessKeyId}/${yyyymmdd}/${bareRegion}/oss/aliyun_v4_request`;

  const policy = {
    expiration: expiresAt,
    conditions: [
      { bucket },
      { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' },
      { 'x-oss-credential': credential },
      { 'x-oss-date': xOssDate },
      ['starts-with', '$key', keyPrefix],
      ['in', '$content-type', [...contentTypeWhitelist]],
      ['content-length-range', 1, maxSizeBytes],
      ['eq', '$success_action_status', '200'],
    ],
  };

  const base64Policy = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');

  // 4-layer signing-key derivation; first key = literal "aliyun_v4" + secret.
  const dateKey = createHmac('sha256', `aliyun_v4${accessKeySecret}`).update(yyyymmdd).digest();
  const regionKey = createHmac('sha256', dateKey).update(bareRegion).digest();
  const serviceKey = createHmac('sha256', regionKey).update('oss').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aliyun_v4_request').digest();

  const signature = createHmac('sha256', signingKey).update(base64Policy).digest('hex');

  return {
    host,
    objectKey,
    expiresAt,
    fields: {
      key: objectKey,
      policy: base64Policy,
      'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': credential,
      'x-oss-date': xOssDate,
      'x-oss-signature': signature,
      success_action_status: '200',
    },
  };
}
