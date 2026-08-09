import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { materializeSystemGroups } from './materialize-system-groups';
import { ListWatchlistGroupsUseCase, type GroupListResult } from './list-watchlist-groups.usecase';

/**
 * 013 US1 EP2 — 建自定义组 (intra 写, ADR-0043 直注 PrismaService 无 repository)。
 *
 * tx 内 (D2 materialize-on-first-write):
 *  1. materialize 2 系统组 (ON CONFLICT DO NOTHING) → 使后续 item / 排序挂真实 groupId。
 *  2. name per-account 去重 (app 级软约束, D1 last-write-wins 容忍并发竞态) → 撞 →
 *     400 FORM_VALIDATION。
 *  3. order = 现有最大 order + 1 (排到末尾)。
 *  4. create custom 组 (type=custom, systemKind=null)。
 * 返回全量 groups (EP2 客户端对账)。
 */
@Injectable()
export class CreateWatchlistGroupUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: ListWatchlistGroupsUseCase,
  ) {}

  async execute(accountId: bigint, name: string): Promise<GroupListResult> {
    await this.prisma.$transaction(async (tx) => {
      await materializeSystemGroups(tx, accountId);

      const dup = await tx.group.findFirst({ where: { accountId, name } });
      if (dup) {
        throw new FormValidationException([{ field: 'name', messages: ['分组名已存在'] }]);
      }

      const max = await tx.group.aggregate({ where: { accountId }, _max: { order: true } });
      const order = (max._max.order ?? -1) + 1;

      await tx.group.create({
        data: { accountId, name, type: 'custom', systemKind: null, order },
      });
    });

    return this.lister.execute(accountId);
  }
}
