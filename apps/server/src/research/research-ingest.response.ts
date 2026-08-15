import { ApiProperty } from '@nestjs/swagger';

/** POST `/v1/research/reports` 响应（201）。 */
export class ResearchIngestResponse {
  @ApiProperty({
    description: '归档标识，可据此反查这份研报的元数据行',
    example: '42',
  })
  reportId!: string;

  @ApiProperty({
    description: '归一后的标的（`market:code`）',
    example: 'hk:01698',
  })
  symbol!: string;

  @ApiProperty({
    description:
      '归档对象位置。由内容指纹导出，与投递方无关 —— 同一份文件被多个投递方投递时复用同一个位置',
    example: 'research/<sha256>/report.pdf',
  })
  objectKey!: string;

  @ApiProperty({
    description: 'true = 这份之前已归档过，本次未新增任何对象或记录（重复投递是安全的）',
    example: false,
  })
  deduplicated!: boolean;
}
