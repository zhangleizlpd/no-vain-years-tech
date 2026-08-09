import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfirmProfileImageUseCase } from './confirm-profile-image.usecase';
import type { OssConfig } from '../config/oss.config';
import type { ObjectExistsProbe, ObjectHeadResult } from './object-exists.probe';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

const ALIYUN_CFG: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-profile-images',
  accessKeyId: 'AK',
  accessKeySecret: 'SK',
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

function build(opts?: { row?: unknown; head?: ObjectHeadResult; cfg?: OssConfig }): {
  useCase: ConfirmProfileImageUseCase;
  update: Fn;
  head: Fn;
} {
  const findUnique = vi.fn().mockResolvedValue(opts?.row === undefined ? activeRow : opts.row);
  const update = vi.fn().mockResolvedValue(undefined);
  const prisma = { account: { findUnique, update } } as unknown as PrismaService;
  const head = vi.fn().mockResolvedValue(opts?.head ?? { exists: true, contentType: 'image/jpeg' });
  const probe = { head } as unknown as ObjectExistsProbe;
  return {
    useCase: new ConfirmProfileImageUseCase(prisma, opts?.cfg ?? ALIYUN_CFG, probe),
    update,
    head,
  };
}

const KEY = 'avatar/42/uuid-1/img';

describe('ConfirmProfileImageUseCase — happy path', () => {
  it('valid own-prefix key + HEAD hit → persists publicUrl + returns it', async () => {
    const { useCase, update } = build();
    const result = await useCase.execute(42n, 'avatar', KEY);
    const expectedUrl = `https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com/${KEY}`;
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { avatarUrl: expectedUrl } });
    expect(result.avatarUrl).toBe(expectedUrl);
    expect(result.backgroundImageUrl).toBeNull();
  });

  it('background target writes backgroundImageUrl', async () => {
    const { useCase, update } = build();
    const key = 'background/42/uuid-2/img';
    const result = await useCase.execute(42n, 'background', key);
    expect(update).toHaveBeenCalledWith({
      where: { id: 42n },
      data: { backgroundImageUrl: expect.stringContaining(key) },
    });
    expect(result.backgroundImageUrl).toContain(key);
  });

  it('overwrites an existing avatarUrl', async () => {
    const { useCase, update } = build({
      row: { ...activeRow, avatarUrl: 'https://old/url' },
    });
    const result = await useCase.execute(42n, 'avatar', KEY);
    expect(result.avatarUrl).toContain(KEY);
    expect(update).toHaveBeenCalledOnce();
  });

  it('publicBaseUrl set → persists the custom-domain URL, not the OSS endpoint', async () => {
    const { useCase, update } = build({
      cfg: { ...ALIYUN_CFG, publicBaseUrl: 'https://img.shintongtech.com' },
    });
    const result = await useCase.execute(42n, 'avatar', KEY);
    const expectedUrl = `https://img.shintongtech.com/${KEY}`;
    expect(update).toHaveBeenCalledWith({ where: { id: 42n }, data: { avatarUrl: expectedUrl } });
    expect(result.avatarUrl).toBe(expectedUrl);
  });
});

describe('ConfirmProfileImageUseCase — rejections (no DB write)', () => {
  it('cross-account prefix → BadRequest, no update', async () => {
    const { useCase, update } = build();
    await expect(useCase.execute(42n, 'avatar', 'avatar/99/uuid/img')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('target/prefix mismatch → BadRequest', async () => {
    const { useCase, update } = build();
    await expect(useCase.execute(42n, 'background', KEY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('HEAD miss (object absent) → BadRequest, no update', async () => {
    const { useCase, update } = build({ head: { exists: false, contentType: null } });
    await expect(useCase.execute(42n, 'avatar', KEY)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('HEAD content-type not an image → BadRequest, no update', async () => {
    const { useCase, update } = build({ head: { exists: true, contentType: 'text/html' } });
    await expect(useCase.execute(42n, 'avatar', KEY)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('account not found → NotFound', async () => {
    const { useCase } = build({ row: null });
    await expect(useCase.execute(1n, 'avatar', 'avatar/1/uuid/img')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('non-ACTIVE account → BadRequest', async () => {
    const { useCase } = build({ row: { ...activeRow, status: 'FROZEN' } });
    await expect(useCase.execute(42n, 'avatar', KEY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('OSS unconfigured → ServiceUnavailable', async () => {
    const { useCase } = build({ cfg: { kind: 'unconfigured' } });
    await expect(useCase.execute(42n, 'avatar', KEY)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("null content-type from HEAD is tolerated (can't verify) → persists", async () => {
    const { useCase, update } = build({ head: { exists: true, contentType: null } });
    await useCase.execute(42n, 'avatar', KEY);
    expect(update).toHaveBeenCalledOnce();
  });
});
