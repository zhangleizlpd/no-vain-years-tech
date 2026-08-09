import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * POST /api/v1/accounts/refresh-token request body (EP1, FR-S04)。
 * 空 / 缺失 refreshToken → ValidationPipe 400 (与凭据路径 401 区分)。
 */
export class RefreshTokenRequest {
  @ApiProperty({
    description: 'Opaque refresh token issued at login / previous rotation',
    example: 'dGhpcy1pcy1hLXJlZnJlc2gtdG9rZW4tc2FtcGxl',
  })
  @IsString()
  @IsNotEmpty({ message: 'refreshToken must not be empty' })
  refreshToken!: string;
}
