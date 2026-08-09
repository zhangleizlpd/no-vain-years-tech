import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ossConfig, type OssConfig } from '../config/index.js';
import {
  buildPostObjectCredential,
  IMAGE_WHITELIST,
  type PostObjectCredential,
} from '../integrations/oss/oss.module.js';
import { PrismaService } from '../security/prisma.service.js';

/** Credential validity window — 15min (009 plan D4; same as account upload). */
export const IDEATION_UPLOAD_CREDENTIAL_TTL_MS = 15 * 60_000;

/** Per-upload byte ceiling — ≤10MB, aligned to the M3 vision image limit (spec Assumptions)。 */
export const IDEATION_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function isAllowedImageType(ct: string): boolean {
  return (IMAGE_WHITELIST as readonly string[]).includes(ct);
}

/**
 * 036 T005 (FR-007 / FR-013 / US1 / US3) — 为本会话内单次图片直传签发 scope 受限的 OSS
 * PostObject 凭证 (ideation 叶子 ctx, 扁平 + 贫血 per ADR-0043)。
 *
 * 流程:
 *   ① scope 校验 session 归属本 accountId → 他人/不存在 session 一律 **字节级一致 404**
 *      (反枚举 FR-013, 不区分「不存在」vs「他人的」; 与 get/delete/clarify 同款
 *      SESSION_NOT_FOUND)。**直注 PrismaService 读自己 ctx 表** (ideaSession),
 *      NEVER 跨 ctx 读 account 表 (护城河)。
 *   ② contentType (可选) fast-fail 白名单闸 (不在白名单 → 400)。签名 policy 永远 whitelist
 *      全部 image 类型, OSS 在直传时再据 client 实际 content-type 校验 → contentType 只是
 *      早失败, 不是签名输入 (与 account issue-upload-credential 同款)。
 *   ③ OSS 未配置 (dev/test 默认 unconfigured) → 503 OSS_NOT_CONFIGURED (misconfig 显式化,
 *      不用空 creds 签名)。降级不泄漏 vendor 细节 (FR-011): 凭证签发失败统一 ProblemDetail,
 *      不暴露 vendor 内部 / 凭证内容。
 *   ④ 签 V4 凭证, keyPrefix 严格 = `ideation/<accountId>/` (account-scoped 隔离), size ≤10MB。
 *      **永不写 DB, 永不碰图片字节** (SC-007 / ADR-0045 client 直传)。
 */
@Injectable()
export class IssueIdeaAttachmentCredentialUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
  ) {}

  async execute(
    accountId: bigint,
    sessionId: bigint,
    contentType?: string,
  ): Promise<PostObjectCredential> {
    // ① scope 校验归属: 查不到本人 session 即 404 (反枚举字节级一致, FR-013)。
    //    凭证签发不限 status (open/converged/handed-off 皆可附图; 与 clarify 的 open-only
    //    续问语义无关 —— 这里只判归属)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // ② contentType (可选) fast-fail 白名单闸。
    if (contentType !== undefined && !isAllowedImageType(contentType)) {
      throw new BadRequestException(
        `INVALID_CONTENT_TYPE: must be one of ${IMAGE_WHITELIST.join(' / ')}, got ${contentType}`,
      );
    }

    // ③ OSS 未配置 → 503 (不用空 creds 签名; 降级不泄漏 vendor 细节, FR-011)。
    if (this.ossCfg.kind !== 'aliyun') {
      throw new ServiceUnavailableException('OSS_NOT_CONFIGURED');
    }

    // ④ 签 V4 凭证, keyPrefix 严格 account-scoped。平台签名器业务无关 (036 D3)。
    return buildPostObjectCredential({
      region: this.ossCfg.region,
      bucket: this.ossCfg.bucket,
      accessKeyId: this.ossCfg.accessKeyId,
      accessKeySecret: this.ossCfg.accessKeySecret,
      keyPrefix: `ideation/${accountId}/`,
      maxSizeBytes: IDEATION_ATTACHMENT_MAX_BYTES,
      ttlMs: IDEATION_UPLOAD_CREDENTIAL_TTL_MS,
      now: new Date(),
      uuid: randomUUID(),
    });
  }
}
