import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ossConfig, type OssConfig } from '../config/index.js';
import {
  buildPostObjectCredential,
  type PostObjectCredential,
} from '../integrations/oss/oss.module.js';
import { ClaimedEventOwnershipProvider } from './claimed-event-ownership.js';
import { mockupKeyPrefix } from './mockup.rules.js';

/** Credential validity window — 15min (沿 036 ideation attachment / 009 plan D4)。 */
export const MOCKUP_UPLOAD_CREDENTIAL_TTL_MS = 15 * 60_000;

/** Per-upload byte ceiling — ≤5MB, 单自包含 HTML 文档 (内联 CSS, 多状态屏合并; 远小于图片)。 */
export const MOCKUP_MAX_BYTES = 5 * 1024 * 1024;

/** mockup 产物的 content-type 白名单 (单自包含 HTML; 不接 image / js / 其他)。 */
const MOCKUP_CONTENT_TYPE_WHITELIST = ['text/html'] as const;

/**
 * 037 T005 (US1 / FR-002 / FR-003) — 为 channel 所认领的 ideation requirement 任务签发 scope
 * 受限的 OSS PostObject 凭证 (worker-token 端点; ideation 叶子 ctx, 扁平 + 贫血 per ADR-0043)。
 *
 * 流程:
 *   ① **scope 据 claimed event 派生** —— (accountId, sessionId) 永远由 server 据 channel
 *      所认领的 `agentQueueEvent`(eventId) 派生, channel **不得自报** (防越权 + 混淆代理,
 *      FR-002 / Q2 终判)。派生失败 (事件不存在 / 非 claimed / bizType 不符 / bizId 非数字) →
 *      **404 字节级一致**, 不泄漏 (反枚举, 与 ideation 既有 SESSION_NOT_FOUND 同款)。
 *   ② OSS 未配置 (dev/test 默认 unconfigured) → 503 OSS_NOT_CONFIGURED, 不用空 creds 签名;
 *      降级不泄漏 vendor 细节 (FR-008)。
 *   ③ 签 V4 凭证, content-type 限 `text/html` + keyPrefix 严格 = `ideation-mockup/{accountId}/
 *      {sessionId}/` (本 session scope 锁) + size ≤5MB + 短 TTL。**永不写 DB, 永不碰字节**
 *      (ADR-0045 client 直传)。
 */
@Injectable()
export class IssueMockupCredentialUseCase {
  constructor(
    private readonly ownership: ClaimedEventOwnershipProvider,
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
  ) {}

  async execute(eventId: string): Promise<PostObjectCredential> {
    // ① scope 据 claimed event 派生; 失败 → 404 不泄漏 (channel 不自报 account/session)。
    const owner = await this.ownership.derive(eventId);
    if (!owner) {
      throw new NotFoundException('EVENT_NOT_FOUND');
    }

    // ② OSS 未配置 → 503 (不用空 creds 签名; 降级不泄漏 vendor 细节, FR-008)。
    if (this.ossCfg.kind !== 'aliyun') {
      throw new ServiceUnavailableException('OSS_NOT_CONFIGURED');
    }

    // ③ 签 V4 凭证, content-type=text/html + keyPrefix 锁本 session。
    return buildPostObjectCredential({
      region: this.ossCfg.region,
      bucket: this.ossCfg.bucket,
      accessKeyId: this.ossCfg.accessKeyId,
      accessKeySecret: this.ossCfg.accessKeySecret,
      keyPrefix: mockupKeyPrefix(owner.accountId, owner.sessionId),
      contentTypeWhitelist: MOCKUP_CONTENT_TYPE_WHITELIST,
      maxSizeBytes: MOCKUP_MAX_BYTES,
      ttlMs: MOCKUP_UPLOAD_CREDENTIAL_TTL_MS,
      now: new Date(),
      uuid: randomUUID(),
    });
  }
}
