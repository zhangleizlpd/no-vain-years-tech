import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 读账号级 chat 自定义指令 (031 T003, plan D1/R1) — chat 叶子 ctx, 扁平 + 贫血 +
 * 直注 PrismaService (无 repository, per ADR-0043)。偏好按 accountId 归属。
 *
 * **null 语义收敛 (U1/D9)**: 无记录 → 返空串 `''`(「未设置」= 行不存在或空串两态
 * 等价, 不引第三态 NULL)。调用方据此组装系统提示 (空串 → userCustomLayer 返 null,
 * 不注入用户层)。返回投影 `{customInstruction}`(controller 直透, 不下发其它内部列)。
 */

export interface GetChatPreferenceResult {
  customInstruction: string;
}

@Injectable()
export class GetChatPreferenceUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<GetChatPreferenceResult> {
    const pref = await this.prisma.chatPreference.findUnique({
      where: { accountId },
      select: { customInstruction: true },
    });
    // 无行 = 未设置 → 空串 (U1 两态等价)。
    return { customInstruction: pref?.customInstruction ?? '' };
  }
}
