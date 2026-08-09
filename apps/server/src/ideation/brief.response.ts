import { ApiProperty } from '@nestjs/swagger';

/**
 * 032 T009 brief 生成/导出响应 DTO。briefJson 自由 Json 透传 (additionalProperties,
 * 形状由 brief.schema 约束)。missing 缺段列表 (未收敛信号, 客户端据此「继续追问缺失段」)。
 */

/** POST /ideation/sessions/{id}/brief 响应 (生成/重生)。 */
export class GenerateBriefResponse {
  @ApiProperty({
    description: '是否收敛 (T1 五段齐 → true 落 brief; 缺段 → false 不落 + missing)',
    example: true,
  })
  converged!: boolean;

  @ApiProperty({
    description: 'brief 结构化 JSON (收敛时返; 未收敛为 null)',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  briefJson!: unknown;

  @ApiProperty({
    description: '缺失的 T1 段 key 列表 (未收敛时非空, 客户端据此继续追问)',
    type: [String],
    example: [],
  })
  missing!: string[];
}

/** GET /ideation/sessions/{id}/brief/export 响应 (导出 markdown)。 */
export class ExportBriefResponse {
  @ApiProperty({
    description: 'brief 渲染后的 markdown (粘进 /speckit-specify)',
    example: '## 问题 / 动机\n\n...',
  })
  markdown!: string;

  @ApiProperty({
    description: '会话状态 (导出后 handed-off)',
    example: 'handed-off',
  })
  status!: string;
}
