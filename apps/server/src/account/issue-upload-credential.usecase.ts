import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ossConfig, type OssConfig } from '../config/oss.config';
import {
  buildPostObjectCredential,
  IMAGE_WHITELIST,
  type PostObjectCredential,
} from '../integrations/oss/oss.module';
import { PrismaService } from '../security/prisma.service';
import { isActive } from './account.rules';
import { type ProfileImageTarget } from './oss-policy';

/** Credential validity window — 15min (009 plan D4). */
export const UPLOAD_CREDENTIAL_TTL_MS = 15 * 60_000;

/** Per-target byte ceilings (009 plan D4); enforced server-side by OSS. */
export const MAX_BYTES_BY_TARGET: Record<ProfileImageTarget, number> = {
  avatar: 5 * 1024 * 1024,
  background: 10 * 1024 * 1024,
};

function isAllowedImageType(ct: string): boolean {
  return (IMAGE_WHITELIST as readonly string[]).includes(ct);
}

/**
 * 009 EP1 — issue a scope-restricted OSS PostObject upload credential (account
 * ctx, flat/anemic per ADR-0043). Reads the account row (defense-in-depth
 * isActive check on top of JwtAuthGuard), validates the content-type whitelist,
 * then signs a V4 credential locked to this account's `<target>/<accountId>/`
 * key prefix. **Never writes the DB, never touches image bytes** (SC-007).
 */
@Injectable()
export class IssueUploadCredentialUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
  ) {}

  async execute(
    accountId: bigint,
    target: ProfileImageTarget,
    contentType: string,
  ): Promise<PostObjectCredential> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });

    // phone-null row 视为 not-found (沿用既有守卫语义)。
    if (!account || account.phone === null) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    if (!isAllowedImageType(contentType)) {
      throw new BadRequestException(
        `INVALID_CONTENT_TYPE: must be one of ${IMAGE_WHITELIST.join(' / ')}, got ${contentType}`,
      );
    }

    // 纵深防御 — JwtAuthGuard 已 isActive 拦一道。
    if (!isActive(account)) {
      throw new BadRequestException(
        'ACCOUNT_NOT_ACTIVE: only ACTIVE accounts may request an upload credential',
      );
    }

    if (this.ossCfg.kind !== 'aliyun') {
      // OSS not provisioned in this env (dev/test default). Surfacing 503 keeps
      // the misconfiguration explicit rather than signing with empty creds.
      throw new ServiceUnavailableException('OSS_NOT_CONFIGURED');
    }

    // The signed policy whitelists ALL allowed image types (OSS enforces the
    // client's actual content-type against it at upload), so contentType is a
    // fast-fail gate above, not a signing input.
    // Map the account-domain target → object-key prefix + byte ceiling; the
    // platform signer itself is business-agnostic (036 D3).
    return buildPostObjectCredential({
      region: this.ossCfg.region,
      bucket: this.ossCfg.bucket,
      accessKeyId: this.ossCfg.accessKeyId,
      accessKeySecret: this.ossCfg.accessKeySecret,
      keyPrefix: `${target}/${accountId}/`,
      maxSizeBytes: MAX_BYTES_BY_TARGET[target],
      ttlMs: UPLOAD_CREDENTIAL_TTL_MS,
      now: new Date(),
      uuid: randomUUID(),
    });
  }
}
