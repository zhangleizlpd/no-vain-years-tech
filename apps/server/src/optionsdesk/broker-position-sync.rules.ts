import type { BrokerMarket } from './broker-code.rules';

/**
 * 082 持仓**集合替换计划**纯函数 (plan D8; FR-014 / FR-015)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 输入「库内该连接的持仓」+「本次券商报告」, 输出增 / 改 / 删三组, 由调用方在**一个**事务内落库。
 *
 * - `reported` 必须是**已经过范围过滤**的集合 (FR-014, `broker-scope.rules.ts`) —— 本函数不判范围。
 * - `reported` 为空数组 = 拉取**成功**且券商报告无持仓 ⇒ 全部删除 (确实空仓, state_branch 9)。
 * - 🚨 **不存在「拉取失败」入参**: 失败时调用方根本不调用本函数, 既有持仓原样保留 (state_branch 8,
 *   由 T015 钉住)。在这里加一个失败分支, 等于让「空数组」多出一种含义。
 */

/** 持仓身份 = (market, code), 与表唯一键 `(connection_id, market, code)` 同构 (connection 由调用方限定)。 */
export interface BrokerPositionKey {
  market: BrokerMarket;
  code: string;
}

export interface ExistingBrokerPosition extends BrokerPositionKey {
  /** 首次发现时间, 开仓时间回落值 (FR-016)。更新时**保留**, 不随本次同步变化。 */
  firstSeenAt: Date;
}

export interface PositionSyncInput<E extends ExistingBrokerPosition, R extends BrokerPositionKey> {
  existing: readonly E[];
  reported: readonly R[];
}

export interface PositionSyncPlan<E extends ExistingBrokerPosition, R extends BrokerPositionKey> {
  /** 券商新报告、库里没有。首次发现时间由调用方在写入时刻给出。 */
  toInsert: R[];
  /** 两边都有: 用券商报告的新值覆盖, `firstSeenAt` 取库内原值。 */
  toUpdate: Array<{ reported: R; firstSeenAt: Date }>;
  /** 库里有、券商不再报告 (平仓 / 到期作废 / 被指派)。 */
  toDelete: E[];
}

/** market 值域不含 `:` ⇒ 首个 `:` 即分界, 键不会撞。 */
const keyOf = ({ market, code }: BrokerPositionKey): string => `${market}:${code}`;

/**
 * 生成替换计划。复杂度 O(n + m) (n = existing, m = reported): 两次建 Map + 两次单遍查找。
 * 输出顺序: insert / update 随 `reported`, delete 随 `existing`。入参不被修改。
 *
 * @throws `reported` 内同一 (market, code) 出现两次 —— 按键建 Map 会静默丢掉其中一行, 宁可让本次
 *   同步失败留痕 (库内唯一键同样容不下两行)。
 */
export function planPositionSync<E extends ExistingBrokerPosition, R extends BrokerPositionKey>({
  existing,
  reported,
}: PositionSyncInput<E, R>): PositionSyncPlan<E, R> {
  const reportedByKey = new Map<string, R>();
  for (const row of reported) {
    const key = keyOf(row);
    if (reportedByKey.has(key)) {
      throw new Error(`券商持仓报告含重复键 ${row.market} ${row.code}`);
    }
    reportedByKey.set(key, row);
  }
  const existingByKey = new Map<string, E>(existing.map((row) => [keyOf(row), row]));

  const toInsert: R[] = [];
  const toUpdate: Array<{ reported: R; firstSeenAt: Date }> = [];
  for (const [key, row] of reportedByKey) {
    const prior = existingByKey.get(key);
    if (prior === undefined) {
      toInsert.push(row);
    } else {
      toUpdate.push({ reported: row, firstSeenAt: prior.firstSeenAt });
    }
  }
  const toDelete = existing.filter((row) => !reportedByKey.has(keyOf(row)));

  return { toInsert, toUpdate, toDelete };
}
