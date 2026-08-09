import { ApiProperty } from '@nestjs/swagger';

/**
 * 013 自选分组列表单项 (EP1-EP5 共用，返回全量分组最新态)。
 *
 * `id` 为 string (BigInt JSON-safety, 同 broker-account-item)；**新账号零写库 GET 投影的
 * 虚拟系统组 id = systemKind 字符串** ('watchlist'/'holdings')，真实组 (custom + 已
 * materialize 系统组) id = 数字串 (plan D9)。客户端视 id 为不透明 token；EP6/EP7 收到
 * keyword 形 id → materialize 对应系统组再操作 (T007)。`itemCount` = 组内 WatchlistItem 数
 * (虚拟组恒 0；持仓组 V1 派生空 → 0)。
 */
export class GroupItem {
  @ApiProperty({
    description: '分组 id (虚拟系统组=systemKind 字符串; 真实组=数字串)',
    example: 'watchlist',
  })
  id!: string;

  @ApiProperty({
    description: '分组名 (系统组「自选」「持仓」; 自定义组用户输入)',
    example: '自选',
  })
  name!: string;

  @ApiProperty({ description: '分组类型', enum: ['system', 'custom'], example: 'system' })
  type!: 'system' | 'custom';

  @ApiProperty({
    description: '系统组语义 (自定义组为 null)',
    enum: ['watchlist', 'holdings'],
    nullable: true,
    type: 'string',
    example: 'watchlist',
  })
  systemKind!: 'watchlist' | 'holdings' | null;

  @ApiProperty({ description: '是否可见 (主列表 Tab 显示; 可隐藏持久化)', example: true })
  visible!: boolean;

  @ApiProperty({ description: '拖拽序 (账号内, 升序)', example: 0 })
  order!: number;

  @ApiProperty({ description: '组内自选标的数 (虚拟组/持仓组 V1 为 0)', example: 0 })
  itemCount!: number;
}

/**
 * GET/POST/PATCH/DELETE `/api/v1/portfolio/watchlist-groups` 响应体 (EP1-EP5)。
 * `groups[]` 按 `order` 升序；系统组「自选」「持仓」恒在 (投影 / materialize)。
 * 写端点 (EP2-EP5) 返回全量最新态，客户端直接对账乐观更新。
 */
export class GroupListResponse {
  @ApiProperty({ description: '分组列表 (按 order 升序, 系统组恒在)', type: [GroupItem] })
  groups!: GroupItem[];
}
