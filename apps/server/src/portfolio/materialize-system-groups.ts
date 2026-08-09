import type { Prisma } from '../generated/prisma/client';
import { defaultSystemGroups } from './watchlist.rules';
import { GroupNotFoundException } from './group-not-found.exception';

/**
 * 013 系统组 materialize-on-first-write (D2): 在 tx 内 `INSERT ... ON CONFLICT
 * (account_id, system_kind) DO NOTHING` 落 2 系统组 (自选/持仓) 真实行 (createMany
 * skipDuplicates → ON CONFLICT DO NOTHING)。幂等: 已存在则不动 (order 仅 insert 时设)。
 *
 * 由首次写 UC 共用 (create-group / reorder-groups / add-item)，使 item / 自定义组排序
 * 永远挂真实 groupId。GET (EP1) 不调用 (零写库投影虚拟系统组, plan D2/D9)。
 */
export async function materializeSystemGroups(
  tx: Prisma.TransactionClient,
  accountId: bigint,
): Promise<void> {
  await tx.group.createMany({
    data: defaultSystemGroups(accountId).map((s) => ({
      accountId: s.accountId,
      name: s.name,
      type: s.type,
      systemKind: s.systemKind,
      visible: s.visible,
      order: s.order,
    })),
    skipDuplicates: true,
  });
}

/** systemKind keyword 形 id (虚拟系统组寻址, plan D9)。 */
export function isSystemKindKeyword(id: string): id is 'watchlist' | 'holdings' {
  return id === 'watchlist' || id === 'holdings';
}

/** 数字串 groupId → bigint; 非法 (非 keyword 又非数字) → 404 GROUP_NOT_FOUND (反枚举折叠)。 */
export function parseGroupId(groupId: string): bigint {
  try {
    return BigInt(groupId);
  } catch {
    throw new GroupNotFoundException();
  }
}
