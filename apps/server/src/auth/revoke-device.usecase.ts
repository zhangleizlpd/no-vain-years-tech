import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { DEVICE_REVOKED_EVENT_TYPE, buildDeviceRevokedEvent } from './device-revoked.event';
import { DeviceNotFoundException } from './device-not-found.exception';
import { CannotRemoveCurrentDeviceException } from './cannot-remove-current-device.exception';

/**
 * RevokeDevice (auth 编排, authed, **持 tx**) —— 远程撤销单设备 (FR-S06~S12)。
 *
 * 防自撤前置 (FR-S12): currentDeviceId (x-device-id 头) 缺失 → 401 (无法判定当前设备,
 * 拒绝以保证 FR-S07 前置)。404/409 guard 基于 findById 快照 (tx 外读):
 *   - row 不存在 OR row.accountId !== 本账号 → 404 字节级折叠 (反枚举, 不泄露归属 FR-S08)
 *   - row.deviceId === 当前设备 → 409 (引导走「退出登录」FR-S07)
 * tx 内 (READ COMMITTED): security.revokeOneForAccount affected-count 乐观锁 → won ?
 * outbox.publish(tx, auth.device.revoked) : skip (幂等 FR-S09); 任一步抛整 tx 回滚 (FR-S11)。
 *
 * 并发 (FR-S09 / SC-S06): N 并发撤同行 → 行写锁串行化, 恰 1 won=true (发 1 事件), 其余
 * won=false 幂等 200 不发事件。guard 与 tx 间被并发撤 → tx 内 count=0 → won=false 幂等无害。
 */
@Injectable()
export class RevokeDeviceUseCase {
  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: auth → security 撤单行 token 失败回滚整请求 (R2 写, 同 tx)
    private readonly refreshTokenService: RefreshTokenService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(
    accountId: bigint,
    recordId: bigint,
    currentDeviceId: string | null,
  ): Promise<void> {
    // FR-S12 防自撤前置: 无 x-device-id 无法判定当前设备 → 401。
    if (currentDeviceId === null) {
      throw new UnauthorizedException();
    }

    // 404/409 guard (tx 外快照): null OR 跨账号 → 404 折叠 (反枚举); 当前设备 → 409。
    const row = await this.refreshTokenService.findById(recordId);
    if (row === null || row.accountId !== accountId) {
      throw new DeviceNotFoundException();
    }
    if (row.deviceId === currentDeviceId) {
      throw new CannotRemoveCurrentDeviceException();
    }

    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        const { won } = await this.refreshTokenService.revokeOneForAccount(
          recordId,
          accountId,
          now,
          tx,
        );
        if (won) {
          // CROSS-CONTEXT-ASYNC: auth.device.revoked (R3, 同 tx 落 outbox)
          const payload = buildDeviceRevokedEvent(accountId, recordId, row.deviceId, now);
          await this.outboxPublisher.publish(
            tx,
            DEVICE_REVOKED_EVENT_TYPE,
            payload as unknown as Record<string, unknown>,
          );
        }
        // won=false (已撤 / 竞态败者) → skip publish (幂等 200, FR-S09)
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
