import { describe, it, expect } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BindWechatRequest } from './bind-wechat.request';

const errorsFor = (body: unknown) => validateSync(plainToInstance(BindWechatRequest, body));

describe('BindWechatRequest DTO 校验', () => {
  it('非空 authCode string → 0 错误', () => {
    expect(errorsFor({ authCode: 'wx_auth_code_xxx' })).toHaveLength(0);
  });

  it('缺失 authCode → 报错', () => {
    expect(errorsFor({}).length).toBeGreaterThan(0);
  });

  it('空 authCode → IsNotEmpty 报错', () => {
    expect(errorsFor({ authCode: '' }).length).toBeGreaterThan(0);
  });

  it('非 string authCode → IsString 报错', () => {
    expect(errorsFor({ authCode: 12345 }).length).toBeGreaterThan(0);
  });
});
