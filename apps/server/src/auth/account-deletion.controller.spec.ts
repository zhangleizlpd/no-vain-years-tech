import { describe, it, expect, vi } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AccountDeletionController } from './account-deletion.controller';
import { DeleteAccountRequest } from './delete-account.request';
import type { SendDeletionCodeUseCase } from './send-deletion-code.usecase';
import type { DeleteAccountUseCase } from './delete-account.usecase';

function build() {
  const sendExecute = vi.fn().mockResolvedValue(undefined);
  const deleteExecute = vi.fn().mockResolvedValue(undefined);
  const controller = new AccountDeletionController(
    { execute: sendExecute } as unknown as SendDeletionCodeUseCase,
    { execute: deleteExecute } as unknown as DeleteAccountUseCase,
  );
  return { sendExecute, deleteExecute, controller };
}

describe('AccountDeletionController', () => {
  describe('EP1 sendDeletionCodeForMe', () => {
    it('调 usecase(req.user.accountId) + 返回 void (204)', async () => {
      const { controller, sendExecute } = build();
      const res = await controller.sendDeletionCodeForMe({ user: { accountId: 99n } });
      expect(sendExecute).toHaveBeenCalledWith(99n);
      expect(res).toBeUndefined();
    });

    it('usecase 抛 (反枚举 401 / 503) → 控制器透传, 不吞', async () => {
      const { controller, sendExecute } = build();
      sendExecute.mockRejectedValue(new Error('mapped-by-usecase'));
      await expect(controller.sendDeletionCodeForMe({ user: { accountId: 1n } })).rejects.toThrow(
        'mapped-by-usecase',
      );
    });
  });

  describe('EP2 submitDeletionForMe', () => {
    it('调 usecase(req.user.accountId, body.code) + 返回 void (204)', async () => {
      const { controller, deleteExecute } = build();
      const res = await controller.submitDeletionForMe(
        { user: { accountId: 99n } },
        { code: '123456' },
      );
      expect(deleteExecute).toHaveBeenCalledWith(99n, '123456');
      expect(res).toBeUndefined();
    });

    it('usecase 抛 (401 INVALID_DELETION_CODE) → 控制器透传, 不吞', async () => {
      const { controller, deleteExecute } = build();
      deleteExecute.mockRejectedValue(new Error('INVALID_DELETION_CODE'));
      await expect(
        controller.submitDeletionForMe({ user: { accountId: 1n } }, { code: '000000' }),
      ).rejects.toThrow('INVALID_DELETION_CODE');
    });
  });

  describe('DeleteAccountRequest 校验 (码格式 → 400 FORM_VALIDATION)', () => {
    const validate = (code: unknown) =>
      validateSync(plainToInstance(DeleteAccountRequest, { code }));

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
});
