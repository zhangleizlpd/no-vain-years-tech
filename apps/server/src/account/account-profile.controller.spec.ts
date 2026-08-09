import { describe, it, expect, vi } from 'vitest';
import { AccountProfileController } from './account-profile.controller';
import { AccountStatus } from './account.rules';
import type { GetAccountProfileUseCase } from './get-account-profile.usecase';
import type { UpdateDisplayNameUseCase } from './update-display-name.usecase';
import type { UpdateBioUseCase } from './update-bio.usecase';
import type { UpdateGenderUseCase } from './update-gender.usecase';
import type { IssueUploadCredentialUseCase } from './issue-upload-credential.usecase';
import type { ConfirmProfileImageUseCase } from './confirm-profile-image.usecase';
import type { InspectWechatBindingUseCase } from './inspect-wechat-binding.usecase';

const PROFILE = {
  accountId: 99n,
  phone: '+8613800138000',
  displayName: 'Alice',
  bio: null,
  gender: null,
  status: AccountStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function build(bound: boolean) {
  const getExecute = vi.fn().mockResolvedValue(PROFILE);
  const inspectExecute = vi.fn().mockResolvedValue({ bound });
  const controller = new AccountProfileController(
    { execute: getExecute } as unknown as GetAccountProfileUseCase,
    {} as unknown as UpdateDisplayNameUseCase,
    {} as unknown as UpdateBioUseCase,
    {} as unknown as UpdateGenderUseCase,
    {} as unknown as IssueUploadCredentialUseCase,
    {} as unknown as ConfirmProfileImageUseCase,
    { execute: inspectExecute } as unknown as InspectWechatBindingUseCase,
  );
  return { controller, inspectExecute };
}

describe('AccountProfileController GET /me — wechatBound (010 FR-S07)', () => {
  it('绑定存在 → wechatBound:true', async () => {
    const { controller } = build(true);
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(res.wechatBound).toBe(true);
  });

  it('无绑定 → wechatBound:false', async () => {
    const { controller } = build(false);
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(res.wechatBound).toBe(false);
  });

  it('响应 MUST NOT 含 openid 任何字段 (FR-S07 仅暴露 boolean)', async () => {
    const { controller } = build(true);
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(Object.keys(res)).not.toContain('openid');
    expect(JSON.stringify(res)).not.toContain('openid');
  });
});
