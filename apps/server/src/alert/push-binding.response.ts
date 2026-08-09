import { ApiProperty } from '@nestjs/swagger';

/** EP9 绑定响应 (boundAt = 本次上报落库时间, 同账号重报即刷新)。 */
export class PushBindingResponse {
  @ApiProperty({ description: '极光 RegistrationID', example: '1507bfd3f7c466c355c' })
  registrationId!: string;

  @ApiProperty({ description: '平台 (V1 仅 android)', example: 'android' })
  platform!: string;

  @ApiProperty({ description: '绑定时间 ISO-8601', example: '2026-06-07T08:00:00.000Z' })
  boundAt!: string;
}

/** EP10 解绑响应 (仅删本账号命中 0|1, 他人/不存在 → 0 无杂音, 反枚举)。 */
export class DeletePushBindingResponse {
  @ApiProperty({ description: '实删条数 (0|1)', example: 1 })
  deleted!: number;
}

/** 贫血 Prisma row → 响应投影 (纯映射)。 */
export function toPushBindingResponse(row: {
  registrationId: string;
  platform: string;
  updatedAt: Date;
}): PushBindingResponse {
  return {
    registrationId: row.registrationId,
    platform: row.platform,
    boundAt: row.updatedAt.toISOString(),
  };
}
