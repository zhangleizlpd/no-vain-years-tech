import { ApiProperty } from '@nestjs/swagger';
import type { SessionMockupListItem } from './mockup-list.usecase';

/**
 * 037 T007 读侧投影 (account-token 读列表)。贫血 row + 派生字段 → 响应映射 (纯函数,
 * controller 调用)。id BigInt → 数字串 (013/021 体例, orval 既有处理); createdAt → ISO-8601。
 * `mockupUrl` nullable string 显式 `type:'string'` + `nullable:true` (per 012 PR1 教训,
 * 否则 orval 误生成 `{[k]:unknown}|null`); OSS 未配 → null, App 据此走渲染降级。
 * `screens` 为逐屏标签字符串数组 (FR-010); `versionRank` append-only 派生序 (最新 = 1)。
 */
export class SessionMockupResponse {
  @ApiProperty({ description: 'mockup 交付记录 id (数字串)', example: '9001' })
  id!: string;

  @ApiProperty({
    description: '产物对象键 (OSS object key)',
    example: 'ideation-mockup/42/101/uuid/img',
  })
  objectKey!: string;

  @ApiProperty({
    description: '备案展示域内联 URL (域名配置化派生; OSS 未配 → null, App 走渲染降级)',
    type: 'string',
    nullable: true,
    required: false,
    example: 'https://img.example.com/ideation-mockup/42/101/uuid/img',
  })
  mockupUrl!: string | null;

  @ApiProperty({
    description: '逐屏标签清单 (per-screen labels; 供 App 展示「含哪些状态屏」)',
    type: [String],
    example: ['空态', '加载', '成功'],
  })
  screens!: string[];

  @ApiProperty({ description: '交付时间 (ISO-8601)', example: '2026-06-27T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    description: 'append-only 版本序号 (createdAt 倒序派生, 最新 = 1; 不落列)',
    example: 1,
  })
  versionRank!: number;
}

export class SessionMockupListResponse {
  @ApiProperty({
    type: [SessionMockupResponse],
    description: '本 session mockup 列表 (createdAt desc, 最新版在前)',
  })
  items!: SessionMockupResponse[];
}

/** 贫血 list item → 响应投影 (纯函数; BigInt→数字串, Date→ISO)。 */
export function toSessionMockupListResponse(
  items: SessionMockupListItem[],
): SessionMockupListResponse {
  return {
    items: items.map((item) => ({
      id: item.id.toString(),
      objectKey: item.objectKey,
      mockupUrl: item.mockupUrl,
      screens: item.screens,
      createdAt: item.createdAt.toISOString(),
      versionRank: item.versionRank,
    })),
  };
}
