import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IssueUploadCredentialUseCase,
  MAX_BYTES_BY_TARGET,
} from './issue-upload-credential.usecase';
import type { OssConfig } from '../config/oss.config';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const ALIYUN_CFG: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-profile-images',
  accessKeyId: 'LTAI-test-ak',
  accessKeySecret: 'test-sk',
};

const activeRow = {
  id: 42n,
  phone: '+8613800138001',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
  displayName: '张三',
  bio: null,
  gender: null,
  avatarUrl: null,
  backgroundImageUrl: null,
  freezeUntil: null,
  previousPhoneHash: null,
};

function build(cfg: OssConfig = ALIYUN_CFG): {
  useCase: IssueUploadCredentialUseCase;
  findUnique: Fn;
} {
  const findUnique = vi.fn().mockResolvedValue(activeRow);
  const prisma = { account: { findUnique } } as unknown as PrismaService;
  return { useCase: new IssueUploadCredentialUseCase(prisma, cfg), findUnique };
}

describe('IssueUploadCredentialUseCase — happy path (ACTIVE, whitelisted type)', () => {
  let useCase: IssueUploadCredentialUseCase;
  beforeEach(() => {
    useCase = build().useCase;
  });

  it('returns a credential scoped to <target>/<accountId>/ prefix', async () => {
    const cred = await useCase.execute(42n, 'avatar', 'image/jpeg');
    expect(cred.objectKey).toMatch(/^avatar\/42\/[0-9a-f-]+\/img$/);
    expect(cred.fields.key).toBe(cred.objectKey);
    expect(cred.host).toBe('https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com');
  });

  it('background target → background/ prefix + larger size ceiling in policy', async () => {
    const cred = await useCase.execute(42n, 'background', 'image/png');
    expect(cred.objectKey).toMatch(/^background\/42\//);
    const policy = JSON.parse(Buffer.from(cred.fields.policy, 'base64').toString('utf8'));
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1,
      MAX_BYTES_BY_TARGET.background,
    ]);
  });

  it('credential is V4 (OSS4-HMAC-SHA256) with a short expiry in the future', async () => {
    const before = Date.now();
    const cred = await useCase.execute(42n, 'avatar', 'image/webp');
    expect(cred.fields['x-oss-signature-version']).toBe('OSS4-HMAC-SHA256');
    expect(cred.fields['x-oss-signature']).toMatch(/^[0-9a-f]{64}$/);
    const expMs = new Date(cred.expiresAt).getTime();
    expect(expMs).toBeGreaterThan(before);
    expect(expMs).toBeLessThanOrEqual(before + 15 * 60_000 + 1000);
  });
});

describe('IssueUploadCredentialUseCase — validation', () => {
  it('non-whitelisted content-type → BadRequestException', async () => {
    const { useCase } = build();
    await expect(useCase.execute(42n, 'avatar', 'image/gif')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('account not found → NotFoundException', async () => {
    const { useCase, findUnique } = build();
    findUnique.mockResolvedValue(null);
    await expect(useCase.execute(1n, 'avatar', 'image/jpeg')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('non-ACTIVE account → BadRequestException (defense-in-depth)', async () => {
    const { useCase, findUnique } = build();
    findUnique.mockResolvedValue({ ...activeRow, status: 'FROZEN' });
    await expect(useCase.execute(42n, 'avatar', 'image/jpeg')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('OSS unconfigured → ServiceUnavailableException', async () => {
    const { useCase } = build({ kind: 'unconfigured' });
    await expect(useCase.execute(42n, 'avatar', 'image/jpeg')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
