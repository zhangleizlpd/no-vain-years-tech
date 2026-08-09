import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /ideation/sessions/{id}/turns request body (032 T008, FR-003/004; 036 T006 多模态)。
 *
 * 提交一轮澄清的用户输入 (自由文本 / chips 选择回填后的文本)。**不在 DTO 层 trim/拒空白**
 * —— 空白拒由 UC (`ClarifyTurnUseCase`) 显式判定 (与 chat send-message 同款: 空白 → 400 +
 * user turn 不落, 落库语义归 UC)。仅校验 string 类型 (非 string body 由 ValidationPipe 拒)。
 *
 * 036 T006 带图轮 (可选, 向后兼容): `attachmentKeys` = 本轮直传成功的烧录图 OSS key 列表
 * (US1 标注图 / US3 原图); `annotationText` = SoM 同编号合成文字 (`1：… 2：…`)。两者均空 →
 * 纯文本轮, 行为零回归 (SC-005)。带图轮由 UC 校验 key 归属 + 组多模态 Msg + 路由视觉模型。
 */
export class ClarifyTurnRequest {
  @ApiProperty({
    description: '本轮用户澄清输入 (自由文本; 空白由 UC 拒 → 400)',
    example: '复用现有自选股清单',
  })
  @IsString()
  content!: string;

  @ApiPropertyOptional({
    description: '本轮烧录图 OSS key 列表 (036 带图轮; 归属由 UC 校验 → 否则 404)',
    type: [String],
    example: ['ideation/42/uuid/img'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsString({ each: true })
  attachmentKeys?: string[];

  @ApiPropertyOptional({
    description: 'SoM 同编号合成标注文字 (036 带图轮; 注入视觉模型 text part)',
    example: '1：天空改蓝 2：塔变红',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  annotationText?: string;
}
