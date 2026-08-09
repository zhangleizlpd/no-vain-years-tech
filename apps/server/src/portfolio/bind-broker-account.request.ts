import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/**
 * POST /api/v1/portfolio/broker-accounts request body (EP2)。
 *
 * 浅校验 (类型 + 非空): 缺字段 / 类型错 / 空串 → 全局 ValidationPipe exceptionFactory →
 * FormValidationException → 400 `FORM_VALIDATION`。深度校验 (券商码 ∈ 字典 / clientNo 禁
 * 控制字符 + trim 后非空) 在 BindBrokerAccountUseCase (字典 + normalizeClientNo)。
 */
export class BindBrokerAccountRequest {
  @ApiProperty({ description: '券商码 (∈ 静态字典 12 家)', example: 'htai' })
  @IsString()
  @IsNotEmpty()
  brokerCode!: string;

  @ApiProperty({ description: '券商客户号 (raw 明文, 不限长)', example: '3119000002466' })
  @IsString()
  @IsNotEmpty()
  clientNo!: string;
}
