import { ApiProperty } from '@nestjs/swagger';
import type { MessageMetadata } from './send-message.usecase';

/**
 * 027 chat 读侧投影 (建会话 / 取消息共用)。贫血 Prisma row → 响应映射 (纯函数,
 * controller/UC 共用)。id BigInt → 数字串 (013 watchlist / 021 alert 体例,
 * orval 既有处理); 时间 → ISO-8601 string。nullable string 字段显式 `type:'string'`
 * (per 012 PR1 教训, 否则 orval 误生成 `{[k]:unknown}|null`) —— 本 feature 当前无
 * nullable string 投影字段, 但保留约定注释供 T007/028 扩展时遵循。
 */

/** 贫血 conversation row 投影所需子集 (UC 返回 Raw Prisma row, 这里只读用到的列)。 */
export interface ConversationRow {
  id: bigint;
  title: string;
  model: string;
}

/** 贫血 message row 投影所需子集 (030: metadata 联网来源/降级, 旧消息 null)。 */
export interface MessageRow {
  id: bigint;
  role: string;
  content: string;
  status: string;
  createdAt: Date;
  /** 联网作答元数据 (Prisma Json?, 旧消息/非联网 = null)。 */
  metadata?: unknown;
}

export class ConversationResponse {
  @ApiProperty({ description: '会话 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '会话标题 (首条消息派生; 空兜底「新对话」)', example: '新对话' })
  title!: string;

  @ApiProperty({
    description: '该会话使用的逻辑模型 (029: flash | pro; 历史会话可能含 legacy 值)',
    example: 'flash',
  })
  model!: string;
}

/** 单条编号引用来源 (030 D6 metadata.sources; 与 web-search.rules NumberedSource 同构)。 */
export class ChatSourceResponse {
  @ApiProperty({ description: '全局唯一编号 (1-based)', example: 1 })
  index!: number;

  @ApiProperty({ description: '来源标题', example: '某新闻标题' })
  title!: string;

  @ApiProperty({ description: '来源链接 (http/https)', example: 'https://example.com/a' })
  url!: string;

  @ApiProperty({
    description: '发布时间 (epoch ms); 缺省表示来源未提供',
    type: 'number',
    required: false,
    nullable: true,
    example: 1_700_000_000_000,
  })
  publishedAt?: number;
}

/** 联网作答元数据 (030 D6; 030 A1: webSearch→searched; 旧消息/user 消息为 null)。 */
export class ChatMessageMetadataResponse {
  @ApiProperty({ description: '本条作答是否实际发生了联网检索', example: true })
  searched!: boolean;

  @ApiProperty({ description: '是否降级 (检索失败基于已有知识作答)', example: false })
  degraded!: boolean;

  @ApiProperty({ description: '编号引用来源 (去重; 空 → [])', type: [ChatSourceResponse] })
  sources!: ChatSourceResponse[];
}

// 注: schema 名带 Chat 前缀避开 alert ctx 既有 MessageResponse/MessageListResponse
// 同名 OpenAPI component (NestJS swagger 以 class 名作 component 名, 全局唯一)。
export class ChatMessageResponse {
  @ApiProperty({ description: '消息 id (数字串)', example: '5001' })
  id!: string;

  @ApiProperty({ description: '角色 (user | assistant)', example: 'user' })
  role!: string;

  @ApiProperty({ description: '消息内容', example: '帮我分析一下这只股票' })
  content!: string;

  @ApiProperty({ description: '状态 (completed | stopped)', example: 'completed' })
  status!: string;

  @ApiProperty({ description: '创建时间 ISO-8601', example: '2026-06-14T08:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    description: '联网作答元数据 (030; 非联网/旧消息缺省)',
    type: ChatMessageMetadataResponse,
    required: false,
    nullable: true,
  })
  metadata?: ChatMessageMetadataResponse;
}

/** GET /chat/conversations/{id}/messages 列表响应 (按插入序)。 */
export class ChatMessageListResponse {
  @ApiProperty({ description: '消息列表 (按插入序; 空会话 → [])', type: [ChatMessageResponse] })
  messages!: ChatMessageResponse[];
}

export function toConversationResponse(row: ConversationRow): ConversationResponse {
  return {
    id: row.id.toString(),
    title: row.title,
    model: row.model,
  };
}

/** 贫血 conversation 列表 row 投影所需子集 (含 updatedAt, 028 列表用)。 */
export interface ConversationListItemRow {
  id: bigint;
  title: string;
  model: string;
  updatedAt: Date;
}

/** GET /chat/conversations 列表项 (含 updatedAt 供客户端时间分组; 不返消息预览)。 */
export class ConversationListItemResponse {
  @ApiProperty({ description: '会话 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '会话标题', example: '分析贵州茅台' })
  title!: string;

  @ApiProperty({
    description: '该会话使用的逻辑模型 (029: flash | pro; 历史会话可能含 legacy 值)',
    example: 'flash',
  })
  model!: string;

  @ApiProperty({
    description: '最近更新时间 ISO-8601 (创建/首条标题/改名刷新; 客户端时间分组依据)',
    example: '2026-06-14T08:00:00.000Z',
  })
  updatedAt!: string;
}

/** GET /chat/conversations 列表响应 (cursor 分页; nextCursor 缺省 → 无更多页)。 */
export class ConversationListResponse {
  @ApiProperty({
    description: '会话列表 (按 updatedAt desc, id desc; 空 → [])',
    type: [ConversationListItemResponse],
  })
  items!: ConversationListItemResponse[];

  @ApiProperty({
    description: '下一页游标 (base64 编码 {updatedAt,id}); 无更多页则缺省',
    type: 'string',
    required: false,
    nullable: true,
    example: 'eyJ1IjoiMjAyNi0wNi0xNFQwODowMDowMC4wMDBaIiwiaSI6IjEwMSJ9',
  })
  nextCursor?: string;
}

/** 贫血 rename row 投影所需子集 (028 改名回显)。 */
export interface RenamedConversationRow {
  id: bigint;
  title: string;
  updatedAt: Date;
}

/** PATCH /chat/conversations/{id} 改名回显 (id + 新 title + 刷新后的 updatedAt)。 */
export class RenamedConversationResponse {
  @ApiProperty({ description: '会话 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '改名后的标题', example: '分析贵州茅台估值' })
  title!: string;

  @ApiProperty({
    description: '改名后刷新的 updatedAt ISO-8601',
    example: '2026-06-14T09:00:00.000Z',
  })
  updatedAt!: string;
}

export function toRenamedConversationResponse(
  row: RenamedConversationRow,
): RenamedConversationResponse {
  return {
    id: row.id.toString(),
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toConversationListItemResponse(
  row: ConversationListItemRow,
): ConversationListItemResponse {
  return {
    id: row.id.toString(),
    title: row.title,
    model: row.model,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toConversationListResponse(result: {
  items: readonly ConversationListItemRow[];
  nextCursor?: string;
}): ConversationListResponse {
  return {
    items: result.items.map(toConversationListItemResponse),
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
  };
}

/** 单个可选模型元数据 (029 GET /chat/models 列表项; 驱动客户端选择器渲染)。 */
export class ModelMetaResponse {
  @ApiProperty({ description: '逻辑模型 id (flash | pro | minimax)', example: 'flash' })
  id!: string;

  @ApiProperty({ description: '选择器展示名', example: '快速' })
  label!: string;

  @ApiProperty({ description: '选择器副标题/描述', example: '响应迅速，适合日常问答' })
  description!: string;

  @ApiProperty({ description: '是否可用 (false = 留位 disabled, 不可选)', example: true })
  available!: boolean;
}

/** GET /chat/models 响应 (029 模型元数据清单; 常量派生, 非用户私有)。 */
export class ModelListResponse {
  @ApiProperty({
    description: '可选模型清单 (flash/pro 可用 + MiniMax 留位不可用)',
    type: [ModelMetaResponse],
  })
  models!: ModelMetaResponse[];
}

/** 贫血 set-model row 投影所需子集 (029 会话级 model 写回显)。 */
export interface SetConversationModelRow {
  id: bigint;
  model: string;
  updatedAt: Date;
}

/** PATCH /chat/conversations/{id} 设 model 回显 (id + 新 model + 刷新后的 updatedAt)。 */
export class ConversationModelResponse {
  @ApiProperty({ description: '会话 id (数字串)', example: '101' })
  id!: string;

  @ApiProperty({ description: '切换后的逻辑模型 id (flash | pro)', example: 'pro' })
  model!: string;

  @ApiProperty({
    description: '切换后刷新的 updatedAt ISO-8601',
    example: '2026-06-14T09:00:00.000Z',
  })
  updatedAt!: string;
}

export function toConversationModelResponse(
  row: SetConversationModelRow,
): ConversationModelResponse {
  return {
    id: row.id.toString(),
    model: row.model,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 贫血 JSON narrow: Prisma Json? → metadata 响应形状 (无 mapper class, 直透字段)。 */
function narrowMetadata(raw: unknown): ChatMessageMetadataResponse | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const m = raw as Partial<MessageMetadata>;
  return {
    searched: m.searched === true,
    degraded: m.degraded === true,
    sources: Array.isArray(m.sources)
      ? m.sources.map((s) => ({
          index: s.index,
          title: s.title,
          url: s.url,
          ...(s.publishedAt !== undefined ? { publishedAt: s.publishedAt } : {}),
        }))
      : [],
  };
}

export function toMessageResponse(row: MessageRow): ChatMessageResponse {
  const metadata = narrowMetadata(row.metadata);
  return {
    id: row.id.toString(),
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function toMessageListResponse(rows: readonly MessageRow[]): ChatMessageListResponse {
  return { messages: rows.map(toMessageResponse) };
}

/**
 * GET /chat/preferences 响应 (031 T004, plan D5)。账号级自定义指令回显。
 * 未设置 → `customInstruction` 为空串 (U1 两态等价, UC 层无行返 '')。
 * `type:'string'` 显式 → 防 orval 误生 objectmap (012 PR1 教训)。
 */
export class ChatPreferenceResponse {
  @ApiProperty({
    type: 'string',
    description: '账号级自定义指令 (未设置 → 空串)',
    example: '请用简洁中文回答, 先给结论再展开。',
  })
  customInstruction!: string;
}
