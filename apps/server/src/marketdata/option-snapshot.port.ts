/**
 * 期权逐日快照端口 (047 T016, FR-030 / FR-039 / plan D-SHIM)。**capability-scoped** ——
 * 「按一批合约 code 取当日盘口 + greeks + OI」这件事换成嘉信 / IBKR 也是同一份接口, 只换 adapter
 * (沿仓内既有 27 个端口的惯例)。
 *
 * ## 🚨 标的 spot 不另发一次调用 (shim `/option-snapshot` 契约)
 *
 * 把**标的自身的 code 并进同一批** `codes`, 它的 `last_price` 与期权行一起回来, 期权行的
 * `stock_owner` 就是关联键。⇒ 本端口入参是 `{underlyingSymbol, contractCodes}` 而不是一个裸
 * code 数组: 标的 code 的**拼法是 vendor 方言** (`us:PEP` → `US.PEP`), 让调用方去拼等于把
 * 前缀知识漏进 use case, 而拼错只会表现为「那批合约今天没有 spot」(门 ④ 与有效成本一起静默失效)。
 *
 * ## 分批的落点: 切在调用方, 上限在这里 (与 T014 链发现同一处置)
 *
 * shim 对 **> 400 codes 直接 400 拒绝, 绝不静默截断**。本端口**一次调用 = 一批**, 切分由调用方
 * 按 {@link OPTION_SNAPSHOT_MAX_CONTRACT_CODES} 做 —— 同一段边界逻辑写两遍必漂移 (同
 * `option-chain.port.ts` 对 ≤30 天窗的处置)。adapter 侧只做**前置拒绝**(零外呼), 不替调用方切。
 *
 * ## 失败语义显式 —— **镜像** `option-chain.port.ts` 那一对, 不新造第三套
 *
 * | 结局 | 错误 | 调用方处置 |
 * | --- | --- | --- |
 * | 限频耗尽 (429) | {@link OptionSnapshotBudgetExhaustedError} | **顺延重入队, 不耗 attempts** (deferral ≠ failure) |
 * | 参数被永久拒绝 (400, 如超批量上限) | {@link OptionSnapshotRejectedError} | 计 failed 继续下一只, **重试无意义** |
 *
 * 其余 (5xx / 网络 / 契约变更) 原样上抛。两套错误各自 scoped 到自己的能力: 共用一套会让
 * 「链发现被限频」与「快照被限频」在 catch 处不可区分, 而两个维度**跑在不同的桶上**
 * (`option_chain` 10/30 s vs `snapshot` 60/30 s), 顺延的是哪一条必须能说清。
 *
 * 金融数值一律 `string | null` 跨边界 (FR-S08 全 marketdata 惯例): 落库列是 `Decimal`,
 * 中途走一趟 JS `number` 就把精度丢在半路。
 */

/** DI token。 */
export const OPTION_SNAPSHOT_PORT = Symbol('OPTION_SNAPSHOT_PORT');

/**
 * vendor 单批 `codes` 上限 (shim `SNAPSHOT_MAX_CODES` 同值)。超出 shim **直接 400**,
 * 不截断 —— 被悄悄裁掉的尾巴在下游读作「那些合约今天没数据」, 与真缺口无法区分。
 */
export const OPTION_SNAPSHOT_MAX_CODES = 400;

/**
 * 单批可放的**合约** code 上限 = 批量上限 − 1: 标的自身占掉一个位 (spot 与期权行同批回来,
 * 见文件头)。调用方按此值切批。
 */
export const OPTION_SNAPSHOT_MAX_CONTRACT_CODES = OPTION_SNAPSHOT_MAX_CODES - 1;

/** 单批快照查询。 */
export interface OptionSnapshotQuery {
  /** 标的 canonical `market:code` (`us:PEP`); adapter 翻成 vendor code 后并入同一批。 */
  underlyingSymbol: string;
  /**
   * vendor **原样**合约 code (含市场前缀, `US.PEP260918P130000` —— 正是 `option_contract.code`
   * 落库的口径, 剥前缀再拼回来只会拼错)。长度 MUST ≤ {@link OPTION_SNAPSHOT_MAX_CONTRACT_CODES}。
   */
  contractCodes: string[];
}

/**
 * 一行快照 (`get_market_snapshot` 一行)。含**标的自身那行** (`isOption=false`) —— 它是 spot
 * 的来源, 不是噪音。
 *
 * 🚨 **缺字段一律 `null`, 禁 0 冒充**: greeks 整块缺失是数学固有现象 (实值腿 bid 跌破内在
 * 价值 ⇒ IV 无解, 实测 227/2150 行), 这些行 MUST 照常返回 (FR-007) —— 在这里丢掉, 下游连
 * 「这条腿存在但算不出档」都无从知道, 而那与「今天整行没采到」是两回事。
 */
export interface OptionSnapshotRow {
  /** vendor 原样 code, 含市场前缀。 */
  code: string;
  /** 是否期权行 (vendor `option_valid`)。`false` = 标的自身那行。 */
  isOption: boolean;
  /** vendor 原样 `stock_owner` (含前缀); 非期权行 null。 */
  underlyingCode: string | null;
  bid: string | null;
  ask: string | null;
  bidSize: string | null;
  askSize: string | null;
  last: string | null;
  prevClose: string | null;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  vega: string | null;
  theta: string | null;
  rho: string | null;
  openInterest: string | null;
  netOpenInterest: string | null;
  volume: string | null;
  turnover: string | null;
  /**
   * vendor 时间戳。🚨 **是最后成交时刻, 不是报价时刻** (p3b E33) —— 新鲜度看
   * {@link OptionSnapshotBatch.asOf}, 两者别互相顶替 (停牌腿的 `update_time` 可以是上周)。
   */
  vendorUpdateTime: Date | null;
  /**
   * greeks 完整性标记。`null` ⟺ 非期权行 (不适用); **期权行恒为 boolean** —— vendor 漏发该
   * 字段时由 adapter 按六个 greeks/IV 字段现算 (标 `false` 会被读作「这只票 greeks 缺失」)。
   */
  greeksComplete: boolean | null;
}

export interface OptionSnapshotBatch {
  /**
   * 本批**实际采集时刻** (shim envelope 的 `as_of`) —— 落 `option_daily_snapshot.quote_as_of`。
   * 🚫 MUST NOT 用行内 `vendorUpdateTime` 顶替 (那是最后成交时刻, 停牌腿会把采集时刻说成上周)。
   */
  asOf: Date;
  rows: OptionSnapshotRow[];
}

/**
 * vendor 限频预算耗尽 (429 且退避重试后仍未过)。
 *
 * 🚨 **这不是失败, 是顺延信号** —— 调用方 MUST 转成 `ExecutorResult.budgetExhausted` 让 worker
 * 延迟重入队且**不耗 attempts** (D5 deferral ≠ failure)。判成 failure 会把「等 30 秒就能继续」
 * 的一轮记成红, 并白白吃掉重试次数。
 */
export class OptionSnapshotBudgetExhaustedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[option-snapshot] vendor 限频预算耗尽 (429), 应顺延重入队: ${what}`);
    this.name = 'OptionSnapshotBudgetExhaustedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 请求被 vendor / shim **永久拒绝** (400): 批量超上限 · 非法 code。
 *
 * 🚨 **不可重试** —— 批量宽度是永久事实, 重试只是把同一个 400 再要一遍。调用方计 failed 后
 * 继续下一只, MUST NOT 走顺延路径 (那会让一个永久性的参数错无限期占着队列)。
 */
export class OptionSnapshotRejectedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[option-snapshot] 请求被永久拒绝 (400, 不可重试): ${what}`);
    this.name = 'OptionSnapshotRejectedError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface OptionSnapshotPort {
  /**
   * 单批快照。**一次调用 = 一批**, adapter 不做批切分 (见文件头)。
   *
   * 返回行含标的自身那行; vendor 未返回某个请求内的 code → 该 code 在 `rows` 中缺席
   * (合法状态: 停牌 / 刚摘牌), **不是错误** —— 覆盖率核对是 FR-045 的事, 不在本端口。
   */
  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch>;
}
