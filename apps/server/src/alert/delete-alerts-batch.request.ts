import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, Matches } from 'class-validator';

/**
 * POST /api/v1/alert/alerts/delete-batch request body (EP5 批量删除)。
 *
 * ids = alert id 数字串 (BigInt 序列化 string, 015 体例)；`@Matches(^\d+$)` 保证
 * controller `BigInt(id)` 转换安全。只删本账号命中项 (UC 层 scope, 反枚举)。
 */
export class DeleteAlertsBatchRequest {
  @ApiProperty({ description: '预警 id 列表 (数字串)', type: [String], example: ['1', '2'] })
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^\d+$/, { each: true })
  ids!: string[];
}
