import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

const WECHAT_PROVIDER = 'WECHAT';

/**
 * InspectWechatBinding — 微信绑定存在性只读探查 (010 FR-S07, 两段式委托读半段)。
 * account context 独占 `wechat_binding` 表读, 供:
 * - auth 编排 (send-unbind-wechat-code) 跨 moat 读绑定门槛 (R2 只读)
 * - account 自身 /me (get-account-profile) 内 ctx 读 wechatBound (无跨 ctx 注释)
 *
 * provider 谓词隔离: 仅判 WECHAT 绑定, 不被未来其他 provider 误判。
 */
@Injectable()
export class InspectWechatBindingUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<{ bound: boolean }> {
    const count = await this.prisma.wechatBinding.count({
      where: { accountId, provider: WECHAT_PROVIDER },
    });
    return { bound: count > 0 };
  }
}
