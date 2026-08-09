import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { isSystemGroup } from './watchlist.rules';
import { isSystemKindKeyword, parseGroupId } from './materialize-system-groups';
import { SystemGroupProtectedException } from './system-group-protected.exception';
import { GroupNotFoundException } from './group-not-found.exception';
import { ListWatchlistGroupsUseCase, type GroupListResult } from './list-watchlist-groups.usecase';

/**
 * 013 US1 EP3 — 自定义组改名 (intra 写)。
 *
 * groupId 为 systemKind keyword (虚拟系统组, D9) → 必为系统组 → 422 SYSTEM_GROUP_PROTECTED
 * (短路, 无需建库)。数字串 → findFirst 本账号; 不存在 → 404 GROUP_NOT_FOUND (反枚举);
 * type=system → 422。改名前 per-account 去重 (排除自身) → 撞 400 FORM_VALIDATION。
 */
@Injectable()
export class UpdateWatchlistGroupUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: ListWatchlistGroupsUseCase,
  ) {}

  async execute(accountId: bigint, groupId: string, name: string): Promise<GroupListResult> {
    if (isSystemKindKeyword(groupId)) {
      throw new SystemGroupProtectedException();
    }
    const id = parseGroupId(groupId);

    const row = await this.prisma.group.findFirst({ where: { id, accountId } });
    if (!row) {
      throw new GroupNotFoundException();
    }
    if (isSystemGroup(row)) {
      throw new SystemGroupProtectedException();
    }

    const dup = await this.prisma.group.findFirst({
      where: { accountId, name, id: { not: id } },
    });
    if (dup) {
      throw new FormValidationException([{ field: 'name', messages: ['分组名已存在'] }]);
    }

    await this.prisma.group.update({ where: { id }, data: { name } });
    return this.lister.execute(accountId);
  }
}
