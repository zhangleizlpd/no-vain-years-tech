/**
 * 082 券商同步**范围判定单点** (plan D6; FR-005 / FR-006 / FR-014)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 持仓 / 成交 / 订单三类写入调用**同一个**函数 —— 三处各写一份判据会各自漂移。
 *
 * 锚集由调用方在每次同步开始时组装: 锚表**全部**行, 含被标 `excluded` 的 (plan D6 / U8)。
 * 本函数只收 ticker 集合, 不接触 excluded 概念。ticker 形态与锚一致 (`us:BRK.B` / `hk:00700`,
 * 由 `broker-code.rules.ts` 产出)。
 */

/** 同步范围: `anchored` = 只收锚标的相关; `full` = 全账户。取值由配置 `BROKER_SYNC_SCOPE` 给出。 */
export type BrokerSyncScope = 'anchored' | 'full';

export interface BrokerScopeInput {
  scope: BrokerSyncScope;
  /** 锚表全部行 (含 `excluded`) 的 ticker 集合。 */
  anchoredTickers: ReadonlySet<string>;
  /** 该行判定出的正股 ticker; 未解析 ⇒ `null`。 */
  underlyingTicker: string | null;
  /** 🚫 现阶段**不参与判定** —— 入参保留给按账号分范围 (master §12-A4 预留), 调用点先接上。 */
  accountId: bigint;
}

/**
 * 该行是否在同步范围内。复杂度 O(1) (Set 查找)。
 */
export function inBrokerScope({
  scope,
  anchoredTickers,
  underlyingTicker,
}: BrokerScopeInput): boolean {
  if (scope === 'full') return true;
  // 🚨 未解析恒保留 (FR-006): 判不出正股 ≠ 与锚无关。写成 false 不报错, 只让这些行被静默丢掉。
  if (underlyingTicker === null) return true;
  return anchoredTickers.has(underlyingTicker);
}
