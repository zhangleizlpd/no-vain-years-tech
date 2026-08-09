import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { PrismaService } from '../security/prisma.service';
import { CommitWechatUnbindUseCase } from '../account/commit-wechat-unbind.usecase';
import { DeletionCodeStore } from './deletion-code.store';
import { SmsPurpose, verifyDeletionCode } from './deletion-code.rules';

/**
 * UnbindWechat (auth 编排, authed) —— 提交解绑码 → 删微信绑定 (010 FR-S04,
 * 1:1 镜像 DeleteAccount 但更简: 仅删 1 表, 无 token revoke / 无事件, O6)。
 *
 * **auth 持 tx 跨 account ctx**: auth 自开 `$transaction`(READ COMMITTED), 内顺序
 * 委托 markUsed (码消费) + commitWechatUnbind (删绑定), 任一失败整 tx 回滚。auth
 * 不碰 `prisma.wechatBinding.*` —— 经 CommitWechatUnbindUseCase。
 *
 * 码校验 (findActive + HMAC compare) 在 **tx 外**: 4 类失败 (未找 / 哈希不符 /
 * 过期 / 已用) 折叠字节级一致 401 `INVALID_UNBIND_CODE` (FR-S04 反枚举)。
 *
 * 并发裁决 (exactly-once, affected-count): tx 内 markUsed 的 count 是闸 —— 5 并发持
 * 同码恰 1 won; 其余 count=0 折叠 401 回滚。commitWechatUnbind won=false (绑定已被
 * 并发删) 同折叠 401 回滚 (不双删)。
 */
@Injectable()
export class UnbindWechatUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletionCodeStore: DeletionCodeStore,
    // CROSS-CONTEXT-SYNC: auth→account 删微信绑定 (R2 写, 失败回滚整请求)
    private readonly commitWechatUnbind: CommitWechatUnbindUseCase,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(accountId: bigint, code: string): Promise<void> {
    const now = new Date();

    // 码校验 (tx 外): 4 类失败折叠 401 (findActive 滤 expired+used → null 覆盖 3 类;
    // verifyDeletionCode 覆盖 hash-mismatch)。
    const stored = await this.deletionCodeStore.findActive(
      accountId,
      SmsPurpose.UNBIND_WECHAT,
      now,
    );
    if (!stored || !verifyDeletionCode(code, stored.codeHash, this.authCfg.smsCodeHmacSecret)) {
      throw new UnauthorizedException('INVALID_UNBIND_CODE');
    }

    await this.prisma.$transaction(
      async (tx) => {
        // exactly-once 闸: 行写锁串行化同码并发, 恰 1 won; 输者 count=0 → 折叠 401 回滚。
        const claimed = await this.deletionCodeStore.markUsed(stored.id, now, tx);
        if (!claimed) {
          throw new UnauthorizedException('INVALID_UNBIND_CODE');
        }

        // 删绑定 (R2): won=false → 绑定已被并发删 → 折叠 401 回滚 (不双删)。
        const { won } = await this.commitWechatUnbind.execute(tx, accountId);
        if (!won) {
          throw new UnauthorizedException('INVALID_UNBIND_CODE');
        }
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
