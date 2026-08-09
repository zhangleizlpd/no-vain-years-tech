import { describe, it, expect, vi } from 'vitest';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WechatBindingController } from './wechat-binding.controller';
import type { BindWechatUseCase } from './bind-wechat.usecase';
import type { SendUnbindWechatCodeUseCase } from './send-unbind-wechat-code.usecase';
import type { UnbindWechatUseCase } from './unbind-wechat.usecase';
import { UnbindWechatRequest } from './unbind-wechat.request';
import { WechatAlreadyBoundException } from './wechat-already-bound.exception';

function build() {
  const bindExecute = vi.fn().mockResolvedValue(undefined);
  const sendUnbindExecute = vi.fn().mockResolvedValue(undefined);
  const unbindExecute = vi.fn().mockResolvedValue(undefined);
  const controller = new WechatBindingController(
    { execute: bindExecute } as unknown as BindWechatUseCase,
    { execute: sendUnbindExecute } as unknown as SendUnbindWechatCodeUseCase,
    { execute: unbindExecute } as unknown as UnbindWechatUseCase,
  );
  return { bindExecute, sendUnbindExecute, unbindExecute, controller };
}

describe('WechatBindingController', () => {
  describe('EP1 bindWechatForMe', () => {
    it('调 usecase(req.user.accountId, body.authCode) + 返回 void (201)', async () => {
      const { controller, bindExecute } = build();
      const res = await controller.bindWechatForMe(
        { user: { accountId: 99n } },
        { authCode: 'wx_auth_code_xxx' },
      );
      expect(bindExecute).toHaveBeenCalledWith(99n, 'wx_auth_code_xxx');
      expect(res).toBeUndefined();
    });

    it('usecase 抛 409 (WechatAlreadyBound) → 控制器透传, 不吞', async () => {
      const { controller, bindExecute } = build();
      bindExecute.mockRejectedValue(new WechatAlreadyBoundException());
      await expect(
        controller.bindWechatForMe({ user: { accountId: 1n } }, { authCode: 'x' }),
      ).rejects.toBeInstanceOf(WechatAlreadyBoundException);
    });
  });

  describe('EP2 sendUnbindCodeForMe', () => {
    it('调 usecase(req.user.accountId) + 返回 void (204)', async () => {
      const { controller, sendUnbindExecute } = build();
      const res = await controller.sendUnbindCodeForMe({ user: { accountId: 99n } });
      expect(sendUnbindExecute).toHaveBeenCalledWith(99n);
      expect(res).toBeUndefined();
    });
  });

  describe('EP3 unbindWechatForMe', () => {
    it('调 usecase(req.user.accountId, body.code) + 返回 void (204)', async () => {
      const { controller, unbindExecute } = build();
      const res = await controller.unbindWechatForMe(
        { user: { accountId: 99n } },
        { code: '123456' },
      );
      expect(unbindExecute).toHaveBeenCalledWith(99n, '123456');
      expect(res).toBeUndefined();
    });
  });

  describe('UnbindWechatRequest 校验 (码格式 → 400 FORM_VALIDATION)', () => {
    const validate = (code: unknown) =>
      validateSync(plainToInstance(UnbindWechatRequest, { code }));

    it('合法 6 位码 → 无校验错误', () => {
      expect(validate('123456')).toHaveLength(0);
    });

    it.each([
      ['缺失', undefined],
      ['空串', ''],
      ['5 位', '12345'],
      ['含字母', '12a456'],
    ])('非法 code (%s) → 有校验错误', (_label, code) => {
      expect(validate(code).length).toBeGreaterThan(0);
    });
  });
});
