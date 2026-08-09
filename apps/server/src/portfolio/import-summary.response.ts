import { ApiProperty } from '@nestjs/swagger';

/**
 * 025 EP1 导入摘要 (FR-004/005 行级容错可追溯载体)。UC 直接组装本 shape 返回
 * (同 GroupListResult 体例, 无二次投影)。`row` = sheet 内数据行序 (1-based,
 * 不含表头; 解析层已滤全空幽灵行)。
 */
export class SkippedRowItem {
  @ApiProperty({ description: '数据行序 (1-based, 不含表头)', example: 3 })
  row!: number;

  @ApiProperty({ description: '跳过原因', example: '「汇总」聚合行' })
  reason!: string;
}

export class ImportSectionSummary {
  @ApiProperty({ description: '入库行数', example: 2 })
  imported!: number;

  @ApiProperty({ description: '跳过行明细 (带原因, FR-004)', type: [SkippedRowItem] })
  skipped!: SkippedRowItem[];

  @ApiProperty({
    description: '警示 (行入库但有兜底处理, 如未知交易类别按 unknown)',
    type: [String],
    example: [],
  })
  warnings!: string[];
}

/** POST `/portfolio/holdings/import` 响应 (200)。 */
export class ImportSummaryResponse {
  @ApiProperty({ description: '本批快照日 YYYY-MM-DD', example: '2026-06-06' })
  asOf!: string;

  @ApiProperty({ description: '持仓 sheet 摘要', type: ImportSectionSummary })
  holdings!: ImportSectionSummary;

  @ApiProperty({ description: '已清仓 sheet 摘要', type: ImportSectionSummary })
  closed!: ImportSectionSummary;

  @ApiProperty({ description: '交易记录 sheet 摘要', type: ImportSectionSummary })
  trades!: ImportSectionSummary;
}
