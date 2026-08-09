import { ApiProperty } from '@nestjs/swagger';

/**
 * GET /api/v1/auth/devices 列表项 (FR-S02)。
 *
 * **无 `ipAddress` 字段** —— FR-S04 反枚举: 原始 IP 绝不序列化进响应,位置仅以
 * ip2region 解析后的中文省市 `location` 呈现 (私网 / 不可解析 → null)。
 * `id` 为 refresh_token 行 PK (string for JSON-safety vs BigInt),撤销路径参数。
 */
export class DeviceListItem {
  @ApiProperty({
    description: 'refresh_token 行 PK (撤销路径参数; string for JSON-safety vs BigInt)',
    example: '1001',
  })
  id!: string;

  @ApiProperty({ description: '设备稳定标识 (NOT NULL)', example: 'a1b2c3d4-...' })
  deviceId!: string;

  @ApiProperty({
    description: '可读设备名; 采集补强前的存量行为 null (FR-S14)',
    nullable: true,
    type: 'string',
    example: 'iPhone 15',
  })
  deviceName!: string | null;

  @ApiProperty({
    description: '设备类型 (PHONE / TABLET / DESKTOP / WEB / UNKNOWN)',
    example: 'PHONE',
  })
  deviceType!: string;

  @ApiProperty({
    description: 'ip2region 解析后的中文省市; 私网 / 不可解析 → null。原始 IP 绝不外露 (FR-S04)',
    nullable: true,
    type: 'string',
    example: '江苏省南京市',
  })
  location!: string | null;

  @ApiProperty({ description: '登录方式 (轮换继承)', example: 'PHONE_SMS' })
  loginMethod!: string;

  @ApiProperty({
    description: '该会话建立 / 上次轮换时刻 (= refresh_token.createdAt 投影, ISO 8601)',
    type: 'string',
    format: 'date-time',
    example: '2026-05-26T08:00:00.000Z',
  })
  lastActiveAt!: string;

  @ApiProperty({
    description: '是否当前设备 (请求 x-device-id 头与本行 deviceId 相等; 缺头 → 全 false)',
    example: false,
  })
  isCurrent!: boolean;
}

/**
 * GET /api/v1/auth/devices 分页响应 envelope (FR-S01)。
 * `size` 回显实际生效页大小 (上限 100 截断后); `totalPages` 据之算。
 */
export class DeviceListResponse {
  @ApiProperty({ description: '当前页 (0-based)', example: 0 })
  page!: number;

  @ApiProperty({ description: '每页条数 (生效值, 上限 100)', example: 10 })
  size!: number;

  @ApiProperty({ description: '账号活跃设备总数', example: 3 })
  totalElements!: number;

  @ApiProperty({ description: '总页数', example: 1 })
  totalPages!: number;

  @ApiProperty({ description: '设备项 (createdAt DESC)', type: [DeviceListItem] })
  items!: DeviceListItem[];
}
