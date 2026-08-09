/**
 * 美股波动率指数日线端口 (046 T012, FR-025)。**capability-scoped** —— 一个端口 = 一种能力,
 * 不是一个 vendor 一个端口 (沿仓内既有端口惯例):「取美股波动率指数的日线历史」这件事,
 * 换成 Cboe Global Indices Feed / 任何转售商也是同一份接口, 只换 adapter。
 *
 * 🚨 **工作集是两个固定代码, 与锚表无关** (FR-027 / plan D1): `us_index_daily` 维度的
 * executor 直接遍历 {@link US_INDEX_CODES}, **不查 `Instrument`、不挂 `need_sync` 锚闸** ——
 * 富途与东财均不收录这两个代码 (p3b E4/E26), 库里根本不存在对应的 `Instrument` 行; 且挂了
 * 闸零锚时指数采集会**静默不跑**, 与「指数表盘不依赖锚, 零锚照常渲染」直接矛盾。
 *
 * 金融数值一律 `string | null` 跨边界 (FR-S08 全 marketdata 惯例): 落库列是 `Decimal`,
 * 中途走一趟 JS `number` 就把精度丢在半路。`null` = **该列在源里不存在**, 不是 0 ——
 * VVIX 只有 CLOSE 一列 (Guardrail 7), 填 0 会让「VVIX 开盘 0」这种假事实进库。
 */
export const US_INDEX_PORT = Symbol('US_INDEX_PORT');

/**
 * 本能力覆盖的指数代码全集 —— 同时**就是** `us_index_daily` 维度的全部工作集 (FR-027)。
 *
 * 值即 `us_index_daily.index_code` 的值域。加第三个指数 = 此处加一值 + adapter 的 URL 表加
 * 一行, executor 零改动 (它只遍历本常量)。
 */
export const US_INDEX_CODES = ['VIX', 'VVIX'] as const;

export type UsIndexCode = (typeof US_INDEX_CODES)[number];

/**
 * 指数日线单点。字段与 `marketdata.us_index_daily` 逐列对应, 便于采集侧 1:1 落库。
 *
 * ⚠️ **VVIX 的 `open`/`high`/`low` 恒为 `null`** —— 官方历史文件只有 `DATE,VVIX` 两列
 * (p3b E2 实测), 不是「今天恰好没值」。
 */
export interface UsIndexDailyPoint {
  /** `YYYY-MM-DD`。 */
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  /** 两个指数都有 ⇒ 恒非空 (非法即整行被 adapter 跳过并计数)。 */
  close: string;
}

/**
 * 一个指数的**全量历史**。
 *
 * 源是**覆盖式全量文件**、无增量端点 (plan D6) ⇒ 本方法一次返回整段历史 (VIX 约 9.2k 行 /
 * VVIX 约 5.1k 行), 没有区间入参。幂等由落库侧的唯一键 `(index_code, date)` 承担。
 */
export interface UsIndexHistory {
  indexCode: UsIndexCode;
  /** 按源文件顺序 (由旧到新)。 */
  rows: UsIndexDailyPoint[];
  /**
   * 被跳过的非法行数。**必须随返回值上抛**、由采集侧计入 `SyncRun` 统计 (plan D6「禁静默丢」)
   * —— 静默丢行会让「源格式悄悄变了」以「最近的数据越来越少」的形式存在很久没人知道。
   */
  skipped: number;
  /** 前若干条非法行原文, 供定位 (计数本身是全量真值, 不受样本上限影响)。 */
  skippedSamples: string[];
}

export interface UsIndexPort {
  /**
   * 取单个指数的全量日线历史。
   *
   * 取数失败 (HTTP 非 200 / 源格式变更) → **throw**, 禁静默返空: 返空会被同步管线记成
   * 「今天这个指数没数据」= 一次成功的空采集, 比一次响亮的失败难发现得多。
   */
  getIndexHistory(indexCode: UsIndexCode): Promise<UsIndexHistory>;
}
