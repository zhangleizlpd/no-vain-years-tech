import { ApiProperty } from '@nestjs/swagger';
import type { GetSessionResult } from './get-session.usecase';
import type { SessionListRow } from './list-sessions.usecase';

/**
 * 032 ideation 读侧投影 (建/列/查/重开共用)。贫血 Prisma row → 响应映射 (纯函数,
 * controller 调用)。id BigInt → 数字串 (013/021 体例, orval 既有处理); 时间 → ISO-8601
 * string。nullable string 字段 (`repo`) 显式 `type:'string'` + `nullable:true`
 * (per 012 PR1 教训, 否则 orval 误生成 `{[k]:unknown}|null`)。suggestion / briefJson
 * 为自由 Json 透传 (additionalProperties, 形状由 ideation-tools / brief.schema 约束)。
 */

/** 会话头投影 (列表项 / 建会话 / 重开返回)。 */
export class SessionResponse {
  @ApiProperty({ description: '会话 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '会话标题', example: '给行情页加收藏' })
  title!: string;

  @ApiProperty({ description: '会话状态 (open | converged | handed-off)', example: 'open' })
  status!: string;

  @ApiProperty({
    description: '接地仓 (本期不暴露 UI, 恒 null)',
    type: 'string',
    nullable: true,
    required: false,
    example: null,
  })
  repo!: string | null;

  @ApiProperty({ description: '创建时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: '最近更新时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  updatedAt!: string;
}

export class SessionListResponse {
  @ApiProperty({ type: [SessionResponse], description: '本账号会话列表 (updatedAt desc)' })
  items!: SessionResponse[];
}

/** 单轮附件投影 (036 FR-009; 会话重载可重展示带图轮缩略)。 */
export class SessionTurnAttachmentResponse {
  @ApiProperty({
    description: '附件 OSS 对象键 (mobile 经 ossThumbUrl 派生缩略重展示)',
    type: 'string',
    example: 'ideation/42/uuid/img',
  })
  ossKey!: string;
}

/** 单轮投影 (会话详情内)。 */
export class SessionTurnResponse {
  @ApiProperty({ description: '轮次 id (数字串)', example: '5001' })
  id!: string;

  @ApiProperty({ description: '角色 (user | assistant)', example: 'assistant' })
  role!: string;

  @ApiProperty({ description: '轮次正文', example: '复用现有自选股清单还是独立收藏?' })
  content!: string;

  @ApiProperty({
    description: '本轮 chips 建议 (assistant 轮可携; 无则 null)',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  suggestion!: unknown;

  @ApiProperty({
    type: [SessionTurnAttachmentResponse],
    description: '本轮带图附件 (036 FR-009; 带图 user 轮可携, 纯文本轮为空数组)',
  })
  attachments!: SessionTurnAttachmentResponse[];

  @ApiProperty({ description: '创建时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  createdAt!: string;
}

/** brief 投影 (会话详情内, 可能 null)。 */
export class SessionBriefResponse {
  @ApiProperty({
    description: 'brief 结构化 JSON (T1 五段 + T2/T3 可选段)',
    type: 'object',
    additionalProperties: true,
  })
  briefJson!: unknown;

  @ApiProperty({ description: '创建时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: '最近更新时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  updatedAt!: string;
}

export class SessionDetailResponse extends SessionResponse {
  @ApiProperty({ type: [SessionTurnResponse], description: '会话轮次 (插入序 id asc)' })
  turns!: SessionTurnResponse[];

  @ApiProperty({
    type: SessionBriefResponse,
    description: 'brief (1:1; 未收敛则 null)',
    nullable: true,
    required: false,
  })
  brief!: SessionBriefResponse | null;
}

// ── 投影函数 (贫血 row → 响应) ────────────────────────────────────────────────

/** 会话头 row → SessionResponse。 */
export function toSessionResponse(row: SessionListRow): SessionResponse {
  return {
    id: row.id.toString(),
    title: row.title,
    status: row.status,
    repo: row.repo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 会话列表 → SessionListResponse。 */
export function toSessionListResponse(rows: SessionListRow[]): SessionListResponse {
  return { items: rows.map(toSessionResponse) };
}

/** 会话详情 row (含 turns + brief) → SessionDetailResponse。 */
export function toSessionDetailResponse(result: GetSessionResult): SessionDetailResponse {
  return {
    id: result.id.toString(),
    title: result.title,
    status: result.status,
    repo: result.repo,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
    turns: result.turns.map((t) => ({
      id: t.id.toString(),
      role: t.role,
      content: t.content,
      suggestion: t.suggestion ?? null,
      attachments: t.attachments.map((a) => ({ ossKey: a.ossKey })),
      createdAt: t.createdAt.toISOString(),
    })),
    brief: result.brief
      ? {
          briefJson: result.brief.briefJson,
          createdAt: result.brief.createdAt.toISOString(),
          updatedAt: result.brief.updatedAt.toISOString(),
        }
      : null,
  };
}
