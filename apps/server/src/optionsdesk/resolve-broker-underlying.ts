import { exchangeClock } from '../marketdata/session-clock';
import type { PrismaService } from '../security/prisma.service';
import type { BrokerAccountPort } from './broker-account.port';
import { parseBrokerCode, type BrokerMarket } from './broker-code.rules';

/**
 * 082 券商代码 → 正股 canonical ticker 的**判定链 + 缓存** (plan D5; FR-006 / FR-007)。
 *
 * 非 rules: 含 I/O —— 读自有表 `broker_contract_ref`、跨 ctx **只读** marketdata 的
 * `option_contract` / `instrument` (catalog Q7-B)、兜底打券商 port。🚫 任何跨 ctx 写。
 *
 * 判定顺序 (每个码短路):
 * 1. 字面解析不出 ⇒ `null`; 正股码 ⇒ 自身 ticker (不查任何表)。
 * 2. 期权码: `broker_contract_ref` 缓存。
 * 3. 「市场 + 词根」映射 —— 覆盖已过期合约与调整合约 (`CMCS1` → `us:CMCSA`), 🚫 截字面还原。
 * 4. 仍未命中且**在挂** (到期日 ≥ 交易所当地今天) ⇒ 批量 `fetchStockOwners`。
 *    已过期码不送: 券商对未知码整批 502 ⇒ 被判基础设施失败反复重试 (port 文档)。
 * 5. 2 / 3 / 4 判出的结果写缓存 (记来源); 仍判不出 ⇒ `null` (未解析, **不落缓存**, 下次重判)。
 *
 * 生命周期 = **一次同步 × 一个市场** 一个实例: 词根映射在首次需要时按市场一次性顺扫
 * (`option_contract.root` 无索引, 🚫 逐行查), 本实例内判过的码 (含 `null`) 记忆, 同一次同步
 * 里成交 / 订单 / 持仓多次调用不重复打库与券商。
 */
export interface BrokerUnderlyingResolver {
  /** 入参全部属本实例的市场; 返回 Map 对每个入参码恰有一个键。 */
  resolve(codes: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

type ContractRefSource = 'root_map' | 'stock_owner';

export function createBrokerUnderlyingResolver(
  { prisma, port }: { prisma: PrismaService; port: BrokerAccountPort },
  { market, now }: { market: BrokerMarket; now: Date },
): BrokerUnderlyingResolver {
  const memo = new Map<string, string | null>();
  let rootMap: Promise<ReadonlyMap<string, string>> | null = null;

  /**
   * 「词根 → 正股 ticker」。同一词根映射到 ≥ 2 只正股 (数据异常) ⇒ 该词根不入映射,
   * 落到下一环 —— 宁未解析不误判 (误判在 anchored 范围下会被静默滤掉)。
   *
   * 复杂度: 1 次 GROUP BY 顺扫该市场合约 + 1 次按 id 点查标的, O(C + R), C = 合约行数、R = 去重词根对数。
   */
  const loadRootMap = async (): Promise<ReadonlyMap<string, string>> => {
    // CROSS-CONTEXT-READ: marketdata.option_contract 只读聚合 (catalog Q7-B) —— 按市场一次性去重
    // (root, underlying_instrument_id), 零写。
    const pairs = await prisma.optionContract.groupBy({
      by: ['root', 'underlyingInstrumentId'],
      where: { market },
    });
    const ids = [...new Set(pairs.map((p) => p.underlyingInstrumentId))];
    // CROSS-CONTEXT-READ: marketdata.instrument 只读点查 (catalog Q7-B) —— 取正股代码拼 canonical
    // ticker (形态同锚 `us:BRK.B` / `hk:00700`), 零写。
    const instruments = await prisma.instrument.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    const codeById = new Map(instruments.map((i) => [i.id, i.code]));

    const tickersByRoot = new Map<string, Set<string>>();
    for (const { root, underlyingInstrumentId } of pairs) {
      const code = codeById.get(underlyingInstrumentId);
      if (code === undefined) continue;
      const set = tickersByRoot.get(root) ?? new Set<string>();
      set.add(`${market}:${code}`);
      tickersByRoot.set(root, set);
    }
    const map = new Map<string, string>();
    for (const [root, tickers] of tickersByRoot) {
      if (tickers.size === 1) map.set(root, [...tickers][0] as string);
    }
    return map;
  };

  /** 字面解析: 判得出的 (解析失败 / 正股) 直接记忆, 返回待判期权码。复杂度 O(n)。 */
  const parsePending = (codes: readonly string[]) => {
    const pending = new Map<string, { root: string; expiry: string }>();
    for (const code of new Set(codes)) {
      if (memo.has(code)) continue;
      const parsed = parseBrokerCode(code);
      if (parsed === null) {
        memo.set(code, null);
      } else if (parsed.market !== market) {
        throw new Error(`[broker] 正股判定: ${code} 不属于市场 ${market} (调用方未按市场分组)`);
      } else if (parsed.kind === 'stock') {
        memo.set(code, parsed.ticker);
      } else {
        pending.set(code, { root: parsed.root, expiry: parsed.expiry });
      }
    }
    return pending;
  };

  /**
   * 复杂度: O(n) 字面解析 + 至多 1 次缓存 `IN` 查询 + (首次) 词根映射加载 + 至多 1 次券商批量
   * 调用 + 至多 1 次缓存批量写; n = 入参码数。
   */
  const resolve = async (codes: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
    const pending = parsePending(codes);

    if (pending.size > 0) {
      const cached = await prisma.brokerContractRef.findMany({
        where: { market, code: { in: [...pending.keys()] } },
        select: { code: true, underlyingTicker: true },
      });
      for (const { code, underlyingTicker } of cached) {
        memo.set(code, underlyingTicker);
        pending.delete(code);
      }
    }

    const learned: { code: string; underlyingTicker: string; source: ContractRefSource }[] = [];
    if (pending.size > 0) {
      rootMap ??= loadRootMap();
      const roots = await rootMap;
      for (const [code, { root }] of pending) {
        const ticker = roots.get(root);
        if (ticker === undefined) continue;
        learned.push({ code, underlyingTicker: ticker, source: 'root_map' });
        memo.set(code, ticker);
        pending.delete(code);
      }
    }

    const today = exchangeClock(market, now).date;
    // `YYYY-MM-DD` 字典序 = 时间序。
    const live = [...pending].filter(([, { expiry }]) => expiry >= today).map(([code]) => code);
    if (live.length > 0) {
      const owners = await port.fetchStockOwners(market, live);
      for (const code of live) {
        const ticker = owners.get(code) ?? null;
        if (ticker === null) continue;
        learned.push({ code, underlyingTicker: ticker, source: 'stock_owner' });
        memo.set(code, ticker);
        pending.delete(code);
      }
    }
    for (const code of pending.keys()) memo.set(code, null);

    if (learned.length > 0) {
      // 并发同步各自学到同一码 ⇒ 结论同源, 先到者为准。
      await prisma.brokerContractRef.createMany({
        data: learned.map((row) => ({ market, ...row })),
        skipDuplicates: true,
      });
    }

    return new Map(codes.map((code) => [code, memo.get(code) ?? null]));
  };

  return { resolve };
}

/**
 * 订单的正股归属 (FR-007): 组合单按各腿 —— 各腿正股一致取之, 不一致或任一腿未解析 ⇒ `null`;
 * 🚫 解析组合单合成 `code`。非组合单按自身代码。`resolved` 须已含全部腿码。复杂度 O(腿数)。
 */
export function underlyingOfOrder(
  order: { code: string; comboLegCodes: readonly string[] },
  resolved: ReadonlyMap<string, string | null>,
): string | null {
  if (order.comboLegCodes.length === 0) return resolved.get(order.code) ?? null;
  const tickers = new Set(order.comboLegCodes.map((leg) => resolved.get(leg) ?? null));
  if (tickers.size !== 1 || tickers.has(null)) return null;
  return [...tickers][0] as string;
}
