import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * PUT /api/v1/portfolio/market-preferences/{market} request body (EP2)。
 *
 * 仅 `active` 一个布尔字段 (单 toggle 即时持久化语义)。缺字段 / 类型错 → 全局
 * ValidationPipe exceptionFactory → FormValidationException → 400 `FORM_VALIDATION`
 * (per main.ts; 区别于业务不变性违反的 422)。市场码在 path param, 不入 body。
 */
export class UpdateMarketPreferenceRequest {
  @ApiProperty({ description: '目标激活态 (true=激活 / false=关闭)', example: true })
  @IsBoolean()
  active!: boolean;
}
