import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IssueIdeaAttachmentCredentialUseCase,
  IDEATION_ATTACHMENT_MAX_BYTES,
} from './attachment-credential.usecase';
import type { OssConfig } from '../config/index';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const ALIYUN_CFG: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-profile-images',
  accessKeyId: 'LTAI-test-ak',
  accessKeySecret: 'test-sk',
};

/**
 * UC-level data stub: prisma.ideaSession.findFirst 直接喂归属判定结果 (own → row / 他人/不存在
 * → null)。**非 Guard lifecycle mock** —— Guard 真 DI 留 T007 IT (per plan「NO LIFECYCLE MOCKING」)。
 */
function build(opts?: { cfg?: OssConfig; session?: { id: bigint } | null }): {
  useCase: IssueIdeaAttachmentCredentialUseCase;
  findFirst: Fn;
} {
  // opts.session 显式传 null = 他人/不存在分支; 未传 = own (默认 {id:7n})。用 `in` 判键存在,
  // 不用 `??` (会把显式 null 折成默认值)。
  const session = opts && 'session' in opts ? opts.session : { id: 7n };
  const findFirst = vi.fn().mockResolvedValue(session);
  const prisma = { ideaSession: { findFirst } } as unknown as PrismaService;
  return {
    useCase: new IssueIdeaAttachmentCredentialUseCase(prisma, opts?.cfg ?? ALIYUN_CFG),
    findFirst,
  };
}

describe('IssueIdeaAttachmentCredentialUseCase — happy path (own session, configured OSS)', () => {
  it('returns a credential scoped to ideation/<accountId>/ prefix', async () => {
    const { useCase } = build();
    const cred = await useCase.execute(42n, 7n, 'image/jpeg');
    expect(cred.objectKey).toMatch(/^ideation\/42\/[0-9a-f-]+\/img$/);
    expect(cred.fields.key).toBe(cred.objectKey);
    expect(cred.host).toBe('https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com');
  });

  it('signs ≤10MB content-length-range into the policy (M3 vision limit)', async () => {
    const { useCase } = build();
    const cred = await useCase.execute(42n, 7n, 'image/png');
    const policy = JSON.parse(Buffer.from(cred.fields.policy, 'base64').toString('utf8'));
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1,
      IDEATION_ATTACHMENT_MAX_BYTES,
    ]);
  });

  it('omitted contentType is allowed (signature whitelists all image types)', async () => {
    const { useCase } = build();
    const cred = await useCase.execute(42n, 7n);
    expect(cred.fields['x-oss-signature-version']).toBe('OSS4-HMAC-SHA256');
    expect(cred.fields['x-oss-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scopes the ownership query by {id, accountId} (anti-enumeration gate)', async () => {
    const { useCase, findFirst } = build();
    await useCase.execute(42n, 7n, 'image/jpeg');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7n, accountId: 42n } }),
    );
  });
});

describe('IssueIdeaAttachmentCredentialUseCase — failure / scope branches', () => {
  it('other-account or unknown session → NotFoundException (byte-identical, FR-013)', async () => {
    const { useCase } = build({ session: null });
    await expect(useCase.execute(42n, 99n, 'image/jpeg')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('non-whitelisted content-type → BadRequestException', async () => {
    const { useCase } = build();
    await expect(useCase.execute(42n, 7n, 'image/gif')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('OSS unconfigured → ServiceUnavailableException (no vendor detail, FR-011)', async () => {
    const { useCase } = build({ cfg: { kind: 'unconfigured' } });
    await expect(useCase.execute(42n, 7n, 'image/jpeg')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
