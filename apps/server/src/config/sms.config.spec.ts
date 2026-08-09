import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { smsConfig } from './sms.config.js';

const ENV_KEYS = [
  'SMS_GATEWAY',
  'ALIYUN_ACCESS_KEY_ID',
  'ALIYUN_ACCESS_KEY_SECRET',
  'ALIYUN_SMS_SIGN_NAME',
  'ALIYUN_SMS_TEMPLATE_CODE',
  'ALIYUN_SMS_TEMPLATE_CODE_DELETE_ACCOUNT',
  'ALIYUN_SMS_TEMPLATE_CODE_CANCEL_DELETION',
] as const;

describe('smsConfig discriminated union', () => {
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

  it('defaults to kind=mock when SMS_GATEWAY unset', () => {
    expect(smsConfig()).toEqual({ kind: 'mock' });
  });

  it('returns kind=mock when SMS_GATEWAY=mock (no aliyun creds required)', () => {
    process.env.SMS_GATEWAY = 'mock';
    expect(smsConfig()).toEqual({ kind: 'mock' });
  });

  it('throws when SMS_GATEWAY=aliyun but ALIYUN_* env partial', () => {
    process.env.SMS_GATEWAY = 'aliyun';
    process.env.ALIYUN_ACCESS_KEY_ID = 'k';
    expect(() => smsConfig()).toThrow();
  });

  it('parses full aliyun config when all 4 ALIYUN_* set', () => {
    process.env.SMS_GATEWAY = 'aliyun';
    process.env.ALIYUN_ACCESS_KEY_ID = 'k';
    process.env.ALIYUN_ACCESS_KEY_SECRET = 's';
    process.env.ALIYUN_SMS_SIGN_NAME = 'sn';
    process.env.ALIYUN_SMS_TEMPLATE_CODE = 'tc';
    expect(smsConfig()).toEqual({
      kind: 'aliyun',
      accessKeyId: 'k',
      accessKeySecret: 's',
      signName: 'sn',
      templateCode: 'tc',
    });
  });

  // compose 的 `KEY: ${VAR:-}` 与 `.env*` 里的 `KEY=""` 都产出**空串**（不是 undefined）。
  // `.env.example` 对这两个键明写「Blank → AliyunSmsGateway falls back to
  // ALIYUN_SMS_TEMPLATE_CODE (login template)」,故空串必须等价于未配。不折叠则
  // `.min(1)` 在 aliyun 模式下直接崩 boot —— 而 prod 就是 SMS_GATEWAY=aliyun。
  it('treats blank per-purpose template codes as absent (compose `${VAR:-}` / `KEY=""`)', () => {
    process.env.SMS_GATEWAY = 'aliyun';
    process.env.ALIYUN_ACCESS_KEY_ID = 'k';
    process.env.ALIYUN_ACCESS_KEY_SECRET = 's';
    process.env.ALIYUN_SMS_SIGN_NAME = 'sn';
    process.env.ALIYUN_SMS_TEMPLATE_CODE = 'tc';
    process.env.ALIYUN_SMS_TEMPLATE_CODE_DELETE_ACCOUNT = '';
    process.env.ALIYUN_SMS_TEMPLATE_CODE_CANCEL_DELETION = '';
    expect(smsConfig()).toEqual({
      kind: 'aliyun',
      accessKeyId: 'k',
      accessKeySecret: 's',
      signName: 'sn',
      templateCode: 'tc',
    });
  });

  it('parses optional per-purpose template codes (T007 注销/撤销码独立模板)', () => {
    process.env.SMS_GATEWAY = 'aliyun';
    process.env.ALIYUN_ACCESS_KEY_ID = 'k';
    process.env.ALIYUN_ACCESS_KEY_SECRET = 's';
    process.env.ALIYUN_SMS_SIGN_NAME = 'sn';
    process.env.ALIYUN_SMS_TEMPLATE_CODE = 'tc';
    process.env.ALIYUN_SMS_TEMPLATE_CODE_DELETE_ACCOUNT = 'tc_del';
    process.env.ALIYUN_SMS_TEMPLATE_CODE_CANCEL_DELETION = 'tc_cancel';
    const cfg = smsConfig();
    expect(cfg).toMatchObject({
      kind: 'aliyun',
      templateCode: 'tc',
      deleteAccountTemplateCode: 'tc_del',
      cancelDeletionTemplateCode: 'tc_cancel',
    });
  });
});
