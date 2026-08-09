import { ApiProperty } from '@nestjs/swagger';
import { BrokerAccountItem } from './broker-account-item.response';

/**
 * GET /api/v1/portfolio/broker-accounts 响应体 (EP1)。
 * accounts[0] 恒为系统默认账户 (isDefault=true), 其后为本账号已绑券商按 createdAt asc。
 */
export class BrokerAccountListResponse {
  @ApiProperty({ description: '券商账户列表 (默认账户置顶 + 已绑券商)', type: [BrokerAccountItem] })
  accounts!: BrokerAccountItem[];
}
