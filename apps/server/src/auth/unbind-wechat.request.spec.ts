import { describe, it, expect } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UnbindWechatRequest } from './unbind-wechat.request';

const validate = (code: unknown) => validateSync(plainToInstance(UnbindWechatRequest, { code }));

describe('UnbindWechatRequest DTO 校验 (码格式 → 400 FORM_VALIDATION)', () => {
  it('合法 6 位码 → 无校验错误', () => {
    expect(validate('123456')).toHaveLength(0);
  });

  it.each([
    ['缺失', undefined],
    ['空串', ''],
    ['5 位', '12345'],
    ['7 位', '1234567'],
    ['含字母', '12a456'],
    ['数字非字符串', 123456],
  ])('非法 code (%s) → 有校验错误', (_label, code) => {
    const errors = validate(code);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.property).toBe('code');
  });
});
