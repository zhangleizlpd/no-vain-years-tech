import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 022 US3 — 设备解绑 (EP10, intra 写)。
 *
 * `deleteMany where {registrationId, accountId}`: 只删本账号命中 (0|1)，他人
 * regId / 不存在 → 0 无杂音 (反枚举, 与 EP5 批量删同范式, FR-003)。幂等。
 */
@Injectable()
export class DeletePushBindingUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, registrationId: string): Promise<number> {
    const res = await this.prisma.pushBinding.deleteMany({
      where: { registrationId, accountId },
    });
    return res.count;
  }
}
