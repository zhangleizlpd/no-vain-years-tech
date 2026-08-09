import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * PATCH /api/v1/accounts/me/bio request body (007 FR-S01..S03).
 *
 * MaxLength(480) is a coarse UTF-16 DoS gate only — ≤120 Unicode code points is
 * ≤240 UTF-16 units worst-case (surrogate pairs), 480 leaves slack. The precise
 * ≤120 code-point + forbidden-char rules are enforced by normalizeBio() in the
 * use case. NO @IsNotEmpty — empty string is a valid "clear bio" (FR-S03),
 * unlike UpdateDisplayNameRequest which requires a non-empty name.
 */
export class UpdateBioRequest {
  @ApiProperty({
    description: 'Personal bio; 0-120 Unicode code points after trim; empty string clears (FR-S03)',
    example: '美股研究员 / 量化交易',
    maxLength: 120,
  })
  @IsString()
  @MaxLength(480)
  bio!: string;
}
