import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { PROFILE_IMAGE_TARGETS, type ProfileImageTarget } from './oss-policy';

/**
 * PATCH /api/v1/accounts/me/profile-image request body (009 FR-S03).
 *
 * `objectKey` is the key returned by EP1 and uploaded to by the client. The use
 * case re-validates it starts with `<target>/<accountId>/` (prevents writing
 * another account's prefix) before persisting.
 */
export class ConfirmProfileImageRequest {
  @ApiProperty({
    description: 'Which profile image is being confirmed',
    enum: PROFILE_IMAGE_TARGETS,
    example: 'avatar',
  })
  @IsIn(PROFILE_IMAGE_TARGETS)
  target!: ProfileImageTarget;

  @ApiProperty({
    description: 'OSS object key returned by the upload-credential endpoint',
    example: 'avatar/42/11111111-2222-3333-4444-555555555555/img',
  })
  @IsString()
  objectKey!: string;
}
