import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

/**
 * PUT /api/v1/alert/push-binding request body (EP9 设备绑定上报)。
 *
 * registrationId = 极光 SDK 注册标识 (设备级, 全局唯一, clarify Q1)；platform V1
 * 仅 'android' (iOS 无 Apple 账号留后续, 出域 → 400)。转绑/刷新语义在
 * UpsertPushBindingUseCase。
 */
export class UpsertPushBindingRequest {
  @ApiProperty({
    description: '极光 RegistrationID (非空 ≤64)',
    example: '1507bfd3f7c466c355c',
    maxLength: 64,
  })
  @IsString()
  @Length(1, 64)
  registrationId!: string;

  @ApiProperty({ description: '平台 (V1 仅 android)', enum: ['android'], example: 'android' })
  @IsIn(['android'])
  platform!: string;
}
