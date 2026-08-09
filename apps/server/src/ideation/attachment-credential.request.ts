import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { IMAGE_WHITELIST, type ImageContentType } from '../integrations/oss/oss.module';

/**
 * POST /ideation/sessions/{id}/attachments/credential request body (036 T005,
 * FR-007 / US1 / US3)。
 *
 * 为本会话内单次图片直传签发 scope 受限的 OSS PostObject 凭证。`contentType` 可选 ——
 * 仅作 fast-fail 闸 (签名 policy 永远 whitelist 全部 image 类型, OSS 在直传时再据 client
 * 实际 content-type 校验); 不传则跳过 fast-fail (与 account issue-upload 同款语义)。
 * 仅 JPEG/PNG/WebP 白名单复用平台层 `IMAGE_WHITELIST` (单源, ADR-0058 平台层)。
 */
export class AttachmentCredentialRequest {
  @ApiPropertyOptional({
    description: '图片 content-type (可选 fast-fail 闸; 仅 JPEG/PNG/WebP)',
    enum: IMAGE_WHITELIST,
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsIn(IMAGE_WHITELIST)
  contentType?: ImageContentType;
}
