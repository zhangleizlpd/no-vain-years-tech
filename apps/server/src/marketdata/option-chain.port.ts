/**
 * 期权链发现端口 (047 T014, FR-039 / plan D-SHIM)。**capability-scoped** —— 一个端口 =
 * 一种能力, 不是一个 vendor 一个端口 (沿仓内既有 26 个端口的惯例): 「取一只标的的到期日阶梯 +
 * 取一个到期日窗内的合约静态属性」这件事, 换成 Schwab / IBKR 也是同一份接口, 只换 adapter。
 *
 * 两个方法蓄意同住一个端口 —— 链发现是**两步一体**的: 先取全部到期日, 再按 ≤30 天分窗
 * (`option-chain-window.rules.ts` 的 `planOptionChainWindows`) 逐窗取链, 最后拿两侧集合做
 * gap check (`gapCheckExpiryDates`)。拆成两个端口只会让唯一的消费者 DI 两次, 且让「跑完必须
 * 对表」这条纪律失去结构上的落点。
 *
 * ## 🚨 采集面无过滤 (plan D-DATA-3 / D-DATA-8, tasks Guardrail 3 & 4)
 *
 * 本端口**不接受**任何筛选入参: 无 `optionType` (恒取双边含 CALL)、无行权价带、无到期日上限
 * (含 LEAPS)、无 greeks/OI/IV 过滤。理由是不对称的 —— **期权快照漏采即永久缺口**
 * (vendor 不提供历史交易日的链快照), 而链接口一次返双边、**调用数完全不变**。
 * 「本片只含认沽」「非标不可交易」都是**呈现面**的话, 排除只发生在下游选约层。
 *
 * ## 失败语义显式 (T014 的承重设计)
 *
 * 传输纪律仍由 `VendorHttpClient` + profile 承担 (退避重试 / 熔断 / 超时), 本端口只把两类
 * **调用方必须区别对待**的结局提成具名错误:
 *
 * | 结局 | 错误 | 调用方处置 |
 * | --- | --- | --- |
 * | 限频耗尽 (429) | {@link OptionChainBudgetExhaustedError} | **顺延重入队, 不耗 attempts** (deferral ≠ failure) |
 * | 参数被永久拒绝 (400, 如窗越界) | {@link OptionChainRejectedError} | 计 failed 继续下一只, **重试无意义** |
 *
 * 其余 (5xx / 网络 / 契约变更) 原样上抛 —— 吞成上面任一类都会把「vendor 坏了」说成
 * 「预算用完了」或「参数写错了」, 两种都会让真故障静默顺延。
 *
 * 金融数值一律 `string | null` 跨边界 (FR-S08 全 marketdata 惯例): 落库列是 `Decimal`,
 * 中途走一趟 JS `number` 就把精度丢在半路。
 */

/** DI token。 */
export const OPTION_CHAIN_PORT = Symbol('OPTION_CHAIN_PORT');

/** 到期日阶梯一项 (`get_option_expiration_date` 一行)。 */
export interface OptionExpiry {
  /** `YYYY-MM-DD`。 */
  expiryDate: string;
  /** 到期周期 (vendor 原样, 如 `WEEK` / `MONTH`); 缺失 null。 */
  expirationCycle: string | null;
  /** vendor 直给的自然日 DTE; 缺失 null (**不回落 0** —— 0 的意思是「今天到期」)。 */
  daysToExpiry: number | null;
}

/**
 * 一个合约的静态属性 (`get_option_chain` 一行)。与 `marketdata.option_contract` 逐列对应,
 * 便于采集侧 1:1 落库。
 *
 * 🚫 **不含合约乘数** —— schema 明写 MUST NOT 存 (FR-028a): 非标合约的乘数根本表达不了
 * (`VICI1` 是 90 股 + 现金找零), 存一个 100 反而制造「看起来正常的错数」。
 */
export interface OptionContractStatic {
  /** canonical market (`us`)。 */
  market: string;
  /**
   * vendor 合约代码**原样**, 含市场前缀 (`US.PEP260918P130000`)。
   *
   * 不剥前缀是刻意的: 这串正是喂回 `/option-snapshot?codes=…` 的键, 剥了还得拼回来,
   * 而拼错只会表现为「那批合约今天没数据」。schema 的幂等键 `(market, code)` 同此口径。
   */
  code: string;
  /**
   * 期权 root (`PEP` / 调整后的 `VICI1`)。**非标合约照常返回**, root 只是打标不是过滤条件
   * (Guardrail 4)。
   */
  root: string;
  /** 标的 canonical `market:code` (vendor 的 `stock_owner` 翻译而来)。 */
  underlyingSymbol: string;
  /** `YYYY-MM-DD`。 */
  expiryDate: string;
  /** 行权价, Decimal-safe string。 */
  strikePrice: string;
  optionType: 'PUT' | 'CALL';
  /** 到期周期 (vendor 原样); 缺失 null。 */
  expirationCycle: string | null;
  /** 结算方式 (vendor 原样, 如 `PM` / `AM`); 缺失 null。 */
  settlementMode: string | null;
  /**
   * 是否标准合约。**只是打标** —— 排除发生在下游选约层 (FR-008 / FR-033)。
   * 判据见 adapter 的 `isStandardContract`。
   */
  isStandard: boolean;
}

/** 单窗链查询。`start` / `end` 闭区间, 且**恒取真实到期日本身** (分窗纯函数的产出)。 */
export interface OptionChainWindowQuery {
  /** canonical `market:code` (单只; vendor 无批量链接口)。 */
  symbol: string;
  /** `YYYY-MM-DD`, 窗起 (含)。 */
  start: string;
  /** `YYYY-MM-DD`, 窗止 (含)。 */
  end: string;
}

/**
 * vendor 限频预算耗尽 (429 且退避重试后仍未过)。
 *
 * 🚨 **这不是失败, 是顺延信号** —— 调用方 MUST 转成 `ExecutorResult.budgetExhausted`
 * 让 worker 延迟重入队且**不耗 attempts** (D5 deferral ≠ failure)。判成 failure 会把
 * 「等 30 秒就能继续」的一轮记成红, 并白白吃掉重试次数。
 */
export class OptionChainBudgetExhaustedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[option-chain] vendor 限频预算耗尽 (429), 应顺延重入队: ${what}`);
    this.name = 'OptionChainBudgetExhaustedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 请求被 vendor / shim **永久拒绝** (400): 窗跨度越界 · 非法 code · 非法日期。
 *
 * 🚨 **不可重试** —— 窗宽是永久事实, 重试只是把同一个 400 再要一遍。调用方计 failed
 * 后继续下一只/下一窗, MUST NOT 走顺延路径 (那会让一个永久性的参数错无限期占着队列)。
 */
export class OptionChainRejectedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[option-chain] 请求被永久拒绝 (400, 不可重试): ${what}`);
    this.name = 'OptionChainRejectedError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface OptionChainPort {
  /**
   * 单只标的的**全部**可得到期日, 按 `expiryDate` 升序。
   *
   * 🚫 **不做任何裁剪** (FR-032): 远月 LEAPS 照常返回。截掉远端不会报错, 只会让那一整批腿
   * 永远采不到 —— 而漏采即永久缺口。该票无期权链 → 空数组 (合法状态, 非错误)。
   */
  getExpiryDates(symbol: string): Promise<OptionExpiry[]>;

  /**
   * 单窗链合约静态属性。**单次调用 = 单个窗**, adapter 不做窗切分 —— 切分由
   * `planOptionChainWindows` 承担; 同一段边界逻辑写两遍必然漂移, 且真切错了 shim 会以
   * 400 说出来 (它不静默截断)。
   *
   * 恒取**双边** (`option_type=ALL`, Guardrail 3), 非标合约照常返回 (Guardrail 4)。
   * 窗内无合约 → 空数组 (非错误)。
   */
  getChainWindow(query: OptionChainWindowQuery): Promise<OptionContractStatic[]>;
}
