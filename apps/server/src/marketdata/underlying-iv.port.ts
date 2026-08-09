/**
 * 标的级 IV 端口 (046 T007, FR-023/FR-024)。**capability-scoped** —— 一个端口 = 一种能力,
 * 不是一个 vendor 一个端口 (沿仓内既有端口惯例): 「取标的的隐含波动率读数」这件事,
 * 换成 Schwab / IBKR 也是同一份接口, 只换 adapter。
 *
 * 两个方法对应同一能力的两个时间面, 蓄意同住一个端口 —— 采集侧的双算对表 (FR-034) 必须
 * 同时拿到「当日直读」与「历史序列」才成立, 拆成两个端口只会让消费者去 DI 两次。
 *
 * 🚨 **口径**: 这里的 IV 是**富途标的聚合 IV**, 非严格 30d-ATM 锁定 (p3 §9-1 采纳声明)。
 * 富途未文档化其 tenor/moneyness 聚合规则。展示与文档一律写「富途标的聚合 IV」,
 * **禁写「IV30d」** (FR-035)。
 *
 * 金融数值一律 `string | null` 跨边界 (FR-S08 全 marketdata 惯例): 落库列是 `Decimal`,
 * 中途走一趟 JS `number` 就把精度丢在半路; `null` = 该项无值, **不是 0** ——
 * IV 分位上 0 的意思是「一年最低」, 与「没有值」方向相反 (FR-014 全片纪律)。
 */
export const UNDERLYING_IV_PORT = Symbol('UNDERLYING_IV_PORT');

/**
 * 标的级 IV 当日快照 (富途 `get_option_underlying_overview` 直读)。
 *
 * 字段与 `marketdata.underlying_iv_daily` 逐列对应, 便于采集侧 1:1 落库。HV 阶梯每档带
 * 自己的百分位, 一并留存 —— 它们与 IV 分位同源同时点, 拆开取就没法对表了。
 */
export interface UnderlyingIvSnapshot {
  /** canonical `market:code` (由请求侧回填; vendor 返的是 `US.PEP` 形态)。 */
  symbol: string;
  /** 当前隐含波动率 (百分数口径, 如 `'24.8'` = 24.8%)。 */
  iv: string | null;
  /** IV rank (0–100)。 */
  ivRank: string | null;
  /** IV percentile (0–100)。**显示口径单源就是它** (FR-035), 自算值只用于对表。 */
  ivPercentile: string | null;
  /** 前一交易日 IV。 */
  preIv: string | null;
  hv30: string | null;
  hv30Percentile: string | null;
  hv60: string | null;
  hv60Percentile: string | null;
  hv90: string | null;
  hv90Percentile: string | null;
  hv120: string | null;
  hv120Percentile: string | null;
  hv365: string | null;
  hv365Percentile: string | null;
  callVolume: string | null;
  putVolume: string | null;
  /** 看涨持仓量 (vendor 标注 T-1 延迟)。 */
  callOi: string | null;
  /** 看跌持仓量 (vendor 标注 T-1 延迟)。 */
  putOi: string | null;
}

/** 历史序列区间入参。闭区间; 两端可省 (省略 = 由 vendor 定默认窗)。 */
export interface UnderlyingIvHistoryQuery {
  /** canonical `market:code` (单只; vendor 无批量历史接口)。 */
  symbol: string;
  /** `YYYY-MM-DD`; 省略 = vendor 默认窗起点。 */
  from?: string;
  /** `YYYY-MM-DD`; 省略 = 至最新。 */
  to?: string;
}

/** 历史序列单点 (富途 `get_option_underlying_his_volatility` 一行)。 */
export interface UnderlyingIvHistoryPoint {
  /** `YYYY-MM-DD`。 */
  date: string;
  iv: string | null;
  /** 历史波动率 (与 IV 同为百分数口径)。 */
  hv: string | null;
  /** 当日标的收盘价 (当日为标记价)。 */
  underlyingPrice: string | null;
}

export interface UnderlyingIvPort {
  /**
   * 批量取当日 IV 快照。**批量是这条能力的要点** —— 12 只锚一轮是一次调用, 不是 12 次。
   *
   * 超过 vendor 单批上限时由 adapter 内部**分批**, 对调用方透明。无期权的标的可能整行缺席,
   * 故返回长度 ≤ 请求长度 (不是错误)。取数失败 → **throw**, 禁静默返空 (返空会被同步管线
   * 记成「这些标的今天没有 IV」= 一次成功的空采集)。
   */
  getIvSnapshots(symbols: readonly string[]): Promise<UnderlyingIvSnapshot[]>;

  /**
   * 单只标的的 IV/HV 日序列, 按 `date` **升序**返回 (vendor 侧是降序, 由 adapter 翻正)。
   *
   * 🚨 **单次调用 = 单个窗口**, adapter 不做区间切分: vendor 单次跨度上限由 shim 侧硬校验
   * (超限 400, 不静默截断), 切分是回填侧的事 (`splitBackfillWindows`, T004)。同一段逻辑
   * 写两遍必然漂移。区间内无数据 → 空数组 (非错误)。
   */
  getIvHistoryRange(query: UnderlyingIvHistoryQuery): Promise<UnderlyingIvHistoryPoint[]>;
}
