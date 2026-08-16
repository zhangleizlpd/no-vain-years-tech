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
import type { OssConfig } from '../config/oss.config';

const ALIYUN_CFG: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'nvy-profile-images',
  accessKeyId: 'AK',
  accessKeySecret: 'SK',
};

const AVATAR_KEY = 'avatar/99/uuid-1/img';

const PROFILE = {
  accountId: 99n,
  phone: '+8613800138000',
  displayName: 'Alice',
  bio: null,
  gender: null,
  avatarObjectKey: AVATAR_KEY,
  backgroundObjectKey: null,
  status: AccountStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function build(bound: boolean, cfg: OssConfig = ALIYUN_CFG) {
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
    cfg,
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

// DB 存 objectKey、响应给完整 URL —— 派生就发生在这一层，所以断言也钉在这一层。
describe('AccountProfileController GET /me — objectKey → 展示 URL 派生', () => {
  it('OSS 已配置 → avatarUrl 是默认域名下的完整 URL', async () => {
    const { controller } = build(true);
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(res.avatarUrl).toBe(
      `https://nvy-profile-images.oss-cn-shanghai.aliyuncs.com/${AVATAR_KEY}`,
    );
    expect(res.backgroundImageUrl).toBeNull();
  });

  it('publicBaseUrl 设了 → 用备案展示域，不用 OSS 默认域名', async () => {
    const { controller } = build(true, {
      ...ALIYUN_CFG,
      publicBaseUrl: 'https://img.shintongtech.com',
    });
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(res.avatarUrl).toBe(`https://img.shintongtech.com/${AVATAR_KEY}`);
  });

  // 反例: 派生不出基址时必须给 null。返回裸 key 会让客户端把它当相对路径拼到自己域名下,
  // 得到一个指向本站的 404 —— 那比「没有头像」更难查: 用户看到碎图, 服务端日志干净。
  it('OSS unconfigured → avatarUrl 为 null，绝不泄漏裸 objectKey（反例）', async () => {
    const { controller } = build(true, { kind: 'unconfigured' });
    const res = await controller.getProfile({ user: { accountId: 99n } });
    expect(res.avatarUrl).toBeNull();
    expect(JSON.stringify(res)).not.toContain(AVATAR_KEY);
  });
});
