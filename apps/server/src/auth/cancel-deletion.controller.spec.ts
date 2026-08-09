import { describe, it, expect, vi } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CancelDeletionController } from './cancel-deletion.controller';
import { SendCancelCodeRequest } from './send-cancel-code.request';
import { CancelDeletionRequest } from './cancel-deletion.request';
import { InvalidPhoneFormatException } from './invalid-phone-format.exception';
import type { SendCancelDeletionCodeUseCase } from './send-cancel-deletion-code.usecase';
import type { CancelDeletionUseCase } from './cancel-deletion.usecase';

const VALID_PHONE = '+8613800138000';

function build() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const cancelExecute = vi.fn().mockResolvedValue({
    accountId: 88n,
    accessToken: 'access.jwt',
    refreshToken: 'refresh.raw',
  });
  const controller = new CancelDeletionController(
    { execute } as unknown as SendCancelDeletionCodeUseCase,
    { execute: cancelExecute } as unknown as CancelDeletionUseCase,
  );
  return { execute, cancelExecute, controller };
}

describe('CancelDeletionController', () => {
  describe('EP3 sendCancelCode', () => {
    it('合法 E.164 → 调 usecase(phone) + 返回 void (200)', async () => {
      const { controller, execute } = build();
      const res = await controller.sendCancelCode({ phone: VALID_PHONE });
      expect(execute).toHaveBeenCalledWith(VALID_PHONE);
      expect(res).toBeUndefined();
    });

    it('前后空白 → trim 后传 usecase', async () => {
      const { controller, execute } = build();
      await controller.sendCancelCode({ phone: `  ${VALID_PHONE}  ` });
      expect(execute).toHaveBeenCalledWith(VALID_PHONE);
    });

    it.each([
      ['非 +86', '+12025550100'],
      ['缺 + 前缀', '13800138000'],
      ['位数不足', '+861380013800'],
      ['含字母', '+861380013800a'],
      ['空串', ''],
    ])('非法 phone (%s) → 422 InvalidPhoneFormatException, usecase 未触', async (_label, phone) => {
      const { controller, execute } = build();
      await expect(controller.sendCancelCode({ phone })).rejects.toBeInstanceOf(
        InvalidPhoneFormatException,
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('usecase 抛 (503 SMS_SEND_FAILED) → 控制器透传, 不吞', async () => {
      const { controller, execute } = build();
      execute.mockRejectedValue(new Error('SMS_SEND_FAILED'));
      await expect(controller.sendCancelCode({ phone: VALID_PHONE })).rejects.toThrow(
        'SMS_SEND_FAILED',
      );
    });
  });

  describe('SendCancelCodeRequest 校验 (缺字段 / 非 string → 400 FORM_VALIDATION)', () => {
    const validate = (phone: unknown) =>
      validateSync(plainToInstance(SendCancelCodeRequest, { phone }));

    it('string phone → 无校验错误 (格式校验交控制器 422, 不在 DTO 层)', () => {
      expect(validate(VALID_PHONE)).toHaveLength(0);
      expect(validate('not-a-phone')).toHaveLength(0); // @IsString 通过; 格式 → 控制器 422
    });

    it.each([
      ['缺失', undefined],
      ['数字非字符串', 13800138000],
      ['null', null],
    ])('非 string phone (%s) → 有校验错误', (_label, phone) => {
      const errors = validate(phone);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.property).toBe('phone');
    });
  });

  describe('EP4 cancelDeletion', () => {
    it('合法 → 调 usecase(phone, code, device) + 映射 LoginResponse (accountId→string)', async () => {
      const { controller, cancelExecute } = build();
      const res = await controller.cancelDeletion(
        { phone: VALID_PHONE, code: '123456' },
        '1.2.3.4',
        'dev-1',
      );
      expect(cancelExecute).toHaveBeenCalledWith(VALID_PHONE, '123456', {
        deviceId: 'dev-1',
        clientIp: '1.2.3.4',
      });
      expect(res).toEqual({
        accountId: '88', // bigint→string
        accessToken: 'access.jwt',
        refreshToken: 'refresh.raw',
      });
    });

    it('非法 phone → 422 InvalidPhoneFormatException, usecase 未触', async () => {
      const { controller, cancelExecute } = build();
      await expect(
        controller.cancelDeletion({ phone: '12345', code: '123456' }, '1.2.3.4', undefined),
      ).rejects.toBeInstanceOf(InvalidPhoneFormatException);
      expect(cancelExecute).not.toHaveBeenCalled();
    });

    it('usecase 抛 (401 INVALID_CREDENTIALS) → 控制器透传, 不吞', async () => {
      const { controller, cancelExecute } = build();
      cancelExecute.mockRejectedValue(new Error('INVALID_CREDENTIALS'));
      await expect(
        controller.cancelDeletion({ phone: VALID_PHONE, code: '000000' }, '1.2.3.4', undefined),
      ).rejects.toThrow('INVALID_CREDENTIALS');
    });
  });

  describe('CancelDeletionRequest 校验 (缺字段 / 非 6 位码 → 400 FORM_VALIDATION)', () => {
    const validate = (body: Record<string, unknown>) =>
      validateSync(plainToInstance(CancelDeletionRequest, body));

    it('合法 {phone string, code 6 位} → 无校验错误', () => {
      expect(validate({ phone: VALID_PHONE, code: '123456' })).toHaveLength(0);
    });

    it.each([
      ['缺 phone', { code: '123456' }, 'phone'],
      ['缺 code', { phone: VALID_PHONE }, 'code'],
      ['code 非 6 位', { phone: VALID_PHONE, code: '12345' }, 'code'],
      ['code 含字母', { phone: VALID_PHONE, code: '12a456' }, 'code'],
    ])('非法 (%s) → 有校验错误 on %s', (_label, body, prop) => {
      const errors = validate(body);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === prop)).toBe(true);
    });
  });
});
