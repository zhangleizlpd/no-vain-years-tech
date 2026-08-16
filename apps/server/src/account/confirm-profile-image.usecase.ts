import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ossConfig, type OssConfig } from '../config/oss.config';
import { IMAGE_WHITELIST } from '../integrations/oss/oss.module';
import { PrismaService } from '../security/prisma.service';
import { AccountStatus, Gender, isActive } from './account.rules';
import { profileImagePublicUrl, type ProfileImageTarget } from './oss-policy';
import { OBJECT_EXISTS_PROBE, type ObjectExistsProbe } from './object-exists.probe';

export interface ConfirmProfileImageResult {
  accountId: bigint;
  phone: string;
  displayName: string | null;
  bio: string | null;
  gender: Gender | null;
  avatarObjectKey: string | null;
  backgroundObjectKey: string | null;
  status: AccountStatus;
  createdAt: Date;
}

/**
 * 009 EP2 — confirm a direct-uploaded profile image (account ctx, flat/anemic
 * per ADR-0043). Validates the objectKey belongs to this account's prefix
 * (anti cross-account write, FR-S03), HEAD-probes the public URL to confirm the
 * object truly exists + is an allowed image type (plan D3), then persists the
 * **objectKey** onto the account (展示 URL 由读侧 `profileImagePublicUrl()` 现拼,
 * 使换展示域 / 换云账号不再需要重写存量行) (overwrite semantics; old object not deleted —
 * FR-S08). Image bytes never touch the backend (SC-007).
 */
@Injectable()
export class ConfirmProfileImageUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
    @Inject(OBJECT_EXISTS_PROBE) private readonly probe: ObjectExistsProbe,
  ) {}

  async execute(
    accountId: bigint,
    target: ProfileImageTarget,
    objectKey: string,
  ): Promise<ConfirmProfileImageResult> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });

    // phone-null row 视为 not-found (沿用既有守卫语义)。
    if (!account || account.phone === null) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    // 仅 ACTIVE 账号可改 (纵深防御 — JwtAuthGuard 已 isActive 拦一道)。
    if (!isActive(account)) {
      throw new BadRequestException(
        'ACCOUNT_NOT_ACTIVE: only ACTIVE accounts may set a profile image',
      );
    }

    // 越权防御 (FR-S03): objectKey 必须属本账号 <target>/<accountId>/ 前缀。
    const prefix = `${target}/${accountId}/`;
    if (!objectKey.startsWith(prefix)) {
      throw new BadRequestException(`INVALID_OBJECT_KEY: must start with ${prefix}`);
    }

    // HEAD 探测打的是**公共 URL**(桶公共读, 匿名 HEAD 无需签名), 所以这里仍要拼一次
    // 完整 URL —— 但落库存的是 objectKey, 两者从本次起不再是同一个东西。
    // objectKey 在此必非空(是入参), 故 null 只可能来自 OSS unconfigured ⇒ 这一个
    // 判空同时替掉了原来那道单独的 `kind !== 'aliyun'` 守卫。
    const publicUrl = profileImagePublicUrl(this.ossCfg, objectKey);
    if (publicUrl === null) {
      throw new ServiceUnavailableException('OSS_NOT_CONFIGURED');
    }

    // HEAD 校验 (plan D3): 对象必须真存在 + content-type 合白名单, 否则拒不落库。
    const probed = await this.probe.head(publicUrl);
    // 🚨 「查不出来」必须先于「不存在」判 —— 否则 OSS 侧一次 5xx / 网络抖动 / 桶被停用
    // (欠费停用返回 403 而非 404) 都会变成 4xx「你上传的对象不存在」,对一个上传成功的
    // 用户说谎,而且把可重试的上游故障报成了客户端错误。
    if (probed.indeterminate) {
      throw new ServiceUnavailableException(
        'OBJECT_PROBE_UNAVAILABLE: cannot verify the uploaded object right now',
      );
    }
    if (!probed.exists) {
      throw new BadRequestException('OBJECT_NOT_FOUND: uploaded object does not exist');
    }
    if (
      probed.contentType &&
      !(IMAGE_WHITELIST as readonly string[]).includes(probed.contentType)
    ) {
      throw new BadRequestException(
        `INVALID_OBJECT_TYPE: ${probed.contentType} is not an allowed image type`,
      );
    }

    const field = target === 'avatar' ? 'avatarObjectKey' : 'backgroundObjectKey';
    await this.prisma.account.update({ where: { id: accountId }, data: { [field]: objectKey } });

    return {
      accountId: account.id,
      phone: account.phone,
      displayName: account.displayName,
      bio: account.bio,
      gender: account.gender as Gender | null,
      avatarObjectKey: target === 'avatar' ? objectKey : account.avatarObjectKey,
      backgroundObjectKey: target === 'background' ? objectKey : account.backgroundObjectKey,
      status: account.status as AccountStatus,
      createdAt: account.createdAt,
    };
  }
}
