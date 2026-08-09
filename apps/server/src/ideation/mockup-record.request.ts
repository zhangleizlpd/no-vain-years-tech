import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * POST /api/v1/ideation/mockups request body (037 T006, US1 / FR-001 / FR-010)。
 *
 * **worker-token 端点** —— channel 直传 mockup HTML 成功后回报落 mockup 交付记录。
 * 归属 scope (accountId, sessionId) **永远**由 server 据 `eventId` 对应的 claimed event 派生,
 * channel **不得自报** account / session (FR-002)。`objectKey` 必须落在派生出的 scope 前缀内
 * (UC 层 `assertObjectKeyOwnership` 校, 防谎报他 session)。`screens` = 逐屏标签清单 (FR-010,
 * UC 层 `normalizeScreens` 兜底), `note` = channel 哨兵 note (可选, 0新token 自检 / 降级说明)。
 */
export class MockupRecordRequest {
  @ApiProperty({
    description: 'claimed ideation requirement 事件 id (worker 所认领任务; scope 据此派生)',
    example: '7b3e1c2a-0000-4000-8000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @ApiProperty({
    description: '已直传产物的对象 key (必须落在派生 scope 前缀内, 否则拒)',
    example: 'ideation-mockup/42/101/uuid/img',
  })
  @IsString()
  @IsNotEmpty()
  objectKey!: string;

  @ApiProperty({
    description: '逐屏标签清单 (per-screen labels, 无文档内锚点; 供 App 展示「含哪些状态屏」)',
    example: ['空态', '加载', '成功'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  screens!: string[];

  @ApiPropertyOptional({
    description: 'channel 哨兵 note (可选; 0新token 自检 / 降级说明)',
    example: '自检通过',
  })
  @IsOptional()
  @IsString()
  note?: string;
}
