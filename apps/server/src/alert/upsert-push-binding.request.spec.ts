import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpsertPushBindingRequest } from './upsert-push-binding.request';

// 022 T004: EP9 请求 DTO 浅校验 (registrationId 非空≤64 / platform 仅 android) — 无 DB。
describe('UpsertPushBindingRequest validation', () => {
  const validate = (body: unknown) =>
    validateSync(plainToInstance(UpsertPushBindingRequest, body)).map((e) => e.property);

  it('合法 android + regId → 通过', () => {
    expect(validate({ registrationId: '1507bfd3f7c466c355c', platform: 'android' })).toEqual([]);
  });

  it('platform 出域 (ios / 空 / 缺失) → 校验失败 (→ 400 FORM_VALIDATION)', () => {
    expect(validate({ registrationId: 'r1', platform: 'ios' })).toContain('platform');
    expect(validate({ registrationId: 'r1', platform: '' })).toContain('platform');
    expect(validate({ registrationId: 'r1' })).toContain('platform');
  });

  it('registrationId 空 / 超长(>64) / 缺失 → 校验失败', () => {
    expect(validate({ registrationId: '', platform: 'android' })).toContain('registrationId');
    expect(validate({ registrationId: 'X'.repeat(65), platform: 'android' })).toContain(
      'registrationId',
    );
    expect(validate({ platform: 'android' })).toContain('registrationId');
  });
});
