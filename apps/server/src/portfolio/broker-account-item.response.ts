import { ApiProperty } from '@nestjs/swagger';

/**
 * 012 券商账户列表单项 (EP1)。默认账户 = 虚拟置顶条目 (id=accountId, isDefault=true,
 * brokerCode/clientNo/createdAt=null); 已绑券商 = brokerCode∈字典 + raw clientNo 明文
 * (FR-S07 脱敏在客户端) + createdAt ISO。`id` 为 string (BigInt JSON-safety, 同 device-list)。
 */
export class BrokerAccountItem {
  @ApiProperty({
    description: '条目 id (默认账户=accountId; 已绑=broker_account.id)',
    example: '42',
  })
  id!: string;

  @ApiProperty({
    description: '券商码 (∈ 字典); 默认账户为 null',
    nullable: true,
    type: 'string',
    example: 'htai',
  })
  brokerCode!: string | null;

  @ApiProperty({ description: '券商中文名 (默认账户为「默认账户」)', example: '华泰证券' })
  brokerName!: string;

  @ApiProperty({
    description: 'raw 客户号明文 (脱敏在客户端); 默认账户为 null',
    nullable: true,
    type: 'string',
    example: '3119000002466',
  })
  clientNo!: string | null;

  @ApiProperty({ description: '是否系统默认账户 (恒置顶)', example: false })
  isDefault!: boolean;

  @ApiProperty({
    description: '绑定时间 ISO 8601 (默认账户为 null)',
    nullable: true,
    type: 'string',
    example: '2026-06-02T08:00:00.000Z',
  })
  createdAt!: string | null;
}
