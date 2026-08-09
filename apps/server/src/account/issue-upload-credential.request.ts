import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { IMAGE_WHITELIST } from '../integrations/oss/oss.module';
import { PROFILE_IMAGE_TARGETS, type ProfileImageTarget } from './oss-policy';

/**
 * POST /api/v1/accounts/me/profile-image/upload-credential request body (009 FR-S02).
 *
 * `target` picks the key prefix (avatar/ vs background/); `contentType` is the
 * MIME the client intends to upload. Both are re-validated server-side in the
 * use case (the policy's content-type whitelist is the load-bearing check —
 * OSS rejects a mismatching upload), so the DTO gate is a fast-fail courtesy.
 */
export class IssueUploadCredentialRequest {
  @ApiProperty({
    description: 'Which profile image to upload a credential for',
    enum: PROFILE_IMAGE_TARGETS,
    example: 'avatar',
  })
  @IsIn(PROFILE_IMAGE_TARGETS)
  target!: ProfileImageTarget;

  @ApiProperty({
    description: 'Intended image MIME type (must be one of the allowed image types)',
    enum: IMAGE_WHITELIST,
    example: 'image/jpeg',
  })
  @IsString()
  contentType!: string;
}
