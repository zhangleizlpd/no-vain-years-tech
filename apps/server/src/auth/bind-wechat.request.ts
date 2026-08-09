import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * POST /v1/accounts/me/wechat-binding (EP1, 010 FR-S02) request body。
 * `authCode` = client 经微信授权拿到的不透明授权码 (O2 seam: server 仅 code→openid,
 * AppSecret 留服务端)。缺失 / 非 string / 空 → ValidationPipe 400 `FORM_VALIDATION`。
 */
export class BindWechatRequest {
  @ApiProperty({
    description: 'Opaque WeChat authorization code (client-obtained, server resolves to openid)',
    example: 'wx_auth_code_xxx',
  })
  @IsString()
  @IsNotEmpty()
  authCode!: string;
}
