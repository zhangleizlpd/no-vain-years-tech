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
 * **读取口** DI token (064 T002, FR-015 前置, plan D1) —— 与上面那个采集口**同一个 interface、
 * 同一个 adapter 实例, 不同的意图**。
 *
 * ```text
 * OPTION_SNAPSHOT_PORT        采集口 · collectionPort() · mock→拒绝壳     ← 047
 * OPTION_SNAPSHOT_READ_PORT   读取口 · 裸 provider      · mock→显式降级   ← 064
 *                                      └── 同一个 FutuOptionSnapshotAdapter 实例
 * ```
 *
 * ## 🚨 为什么不直接注入 {@link OPTION_SNAPSHOT_PORT}
 *
 * 它经 `marketdata.module.ts` 的 `collectionPort()` helper 注册, 那是**采集口**语义: 054 给它
 * 立的判据原文是「采集口的产出**必然被持久化** (逐 port 核过 consumer, 全是写手), 故 mock 下
 * 必须拒绝而不是给 fixture —— 否则伪造行情与真行情同形落进真表」。
 *
 * 064 走的是**读路径、零落库** (FR-019): 拿到的报价只覆盖一次响应, 一个字节都不进表。让读路径
 * 复用采集口, 「逐 port 核过 consumer, 全是写手」当场变成假话 —— 054 建立的意图分类
 * (采集口 / 读取口 / 搜索口) 就此失去依据。🚨 **这不是会报错的问题, 是把一条结构性保证降级成
 * 一句过期注释**, 只能靠人守。
 *
 * ## mock 下是「显式降级」而不是「拒绝壳」
 *
 * 采集口在 mock 下抛, 是因为**返回假数据会污染真表**; 读取口没有这个风险, 它的正确行为是让
 * 上游**落到收盘档** —— 那正是 dev/test 下选约表想要的形态。⇒ mock 绑
 * {@link unavailableOptionSnapshotReadPort}: 调用即抛一个**具名且可与拒绝壳区分**的
 * {@link RealtimeOptionSnapshotUnavailableError}, 上游 catch 它就降级。两者若混同, dev 里的
 * 「本来就没有实时源」会看起来像一次故障。
 *
 * 🚨 **live 分支 MUST 复用采集口那**一个**`FutuOptionSnapshotAdapter` 实例, MUST NOT 新 `new`**:
 * shim 侧限频是 per-capability 单桶, 而客户端每个 `VendorHttpClient` 实例各持一个令牌桶 ⇒
 * 多起一个 = 上游允许值的 2 倍, 撞 429。同一病灶在 prod 上让链发现每 30 分钟顺延一次、12 只锚
 * 永远只采到前 2 只 (`futu-shim.constraint-profile.ts` 的 08-09 事故段)。
 */
export const OPTION_SNAPSHOT_READ_PORT = Symbol('OPTION_SNAPSHOT_READ_PORT');

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

/**
 * 本环境**没有实时行情源** (064 T002) —— `MARKETDATA_PROVIDER=mock` 下读取口的绑定物抛它。
 *
 * 🚨 **它是「配置使然」不是「故障」**, 与 `MockCollectionRefusedError` **刻意分成两个类型**:
 * 采集口那个说的是「我拒绝给你假数据」(dev 里每次出现都值得看一眼), 这个说的是「这里本来就
 * 没有实时源, 请走收盘档」(dev 里每次都会出现, 且是想要的行为)。混成一个类型, 上游就只能靠
 * 消息文本去分辨该降级还是该告警。
 *
 * 📌 与 {@link OptionSnapshotBudgetExhaustedError} / {@link OptionSnapshotRejectedError} 同居
 * 本文件的理由一样: 它是这个端口的**失败语义**之一, 调用方要按类型分流。
 */
export class RealtimeOptionSnapshotUnavailableError extends Error {
  constructor(what: string) {
    super(
      `[option-snapshot] 本环境无实时行情源 (MARKETDATA_PROVIDER=mock), 无法取盘中快照: ${what} —— ` +
        '这是配置使然, 不是故障; 上游应落到收盘档。要打真 vendor 请设 MARKETDATA_PROVIDER=live。',
    );
    this.name = 'RealtimeOptionSnapshotUnavailableError';
  }
}

/**
 * `MARKETDATA_PROVIDER=mock` 下 {@link OPTION_SNAPSHOT_READ_PORT} 的绑定物: 调用即抛
 * {@link RealtimeOptionSnapshotUnavailableError}。
 *
 * 🚫 **MUST NOT 改成返回 fixture** —— 读路径虽零落库, 但假报价会一路走到候选集判据上, 让 dev
 * 看到一张「按伪造盘口筛出来的」选约表, 且它与真实时档在界面上完全同形。抛出来才让上游按
 * FR-010 落到收盘档 (dev 想要的正是这个)。
 * 📌 **不走 `refusingCollectionPort` 那个 Proxy**: 那个壳的语义是采集拒绝, 且它抛的错误类型
 * 正是这里要区分开的那个。本端口只有一个方法, 直接写一个对象字面量比套 Proxy 更小更清楚。
 */
export function unavailableOptionSnapshotReadPort(): OptionSnapshotPort {
  return {
    async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
      throw new RealtimeOptionSnapshotUnavailableError(
        `${query.underlyingSymbol} (${query.contractCodes.length} codes)`,
      );
    },
  };
}
