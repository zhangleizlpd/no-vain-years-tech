import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /api/v1/accounts/me request body (FR-003, FR-005).
 *
 * MaxLength(32) is a fast UTF-16 gate; FR-005 Unicode code-point rules
 * are enforced by DisplayName.create() in the use case.
 */
export class UpdateDisplayNameRequest {
  @ApiProperty({
    description: 'New display name; 1-32 Unicode code points after trim (FR-005)',
    example: 'Alice',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  displayName!: string;
}
