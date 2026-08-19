/**
 * futu-shim 响应信封的**校验单点** —— 三道闸的唯一实现。
 *
 * shim 的每个 rows 型端点都返回同一个信封形状:
 *
 * ```json
 * { "as_of": "2026-08-19T13:47:32+00:00", "count": 285, "rows": [ ... ] }
 * ```
 *
 * ## 三道闸各自对应一个**会静默出错**的失效
 *
 * | 闸 | 不过意味着 | 继续下去会怎样 |
 * | --- | --- | --- |
 * | ① `rows` 非数组 | 契约变更 | 把「shim 换了形状」读成「今天没数据」 |
 * | ② `count` ≠ 实收 | 传输层截断 | 少一截数据, **外表完全正常** |
 * | ③ `as_of` 不可解析 | 采集时刻没了 | 拿本机时钟顶替 = 把「这行什么时候采的」换成「代码什么时候跑到这句」 |
 *
 * 🚨 闸③ 最要命: `as_of` 是**唯一**的新鲜度依据。行内那个 `update_time` 是 vendor 的
 * **最后成交时刻**不是报价时刻 (实测低流动性标的盘中滞后中位 40 s / p95 292 s / max 672 s,
 * p3b E33) —— 拿它判新鲜度会把活跃标的稳定误判成陈旧, 而这个错**不会红**。
 *
 * ## 为什么必须是单点 (本文件的存在理由)
 *
 * 抽取前闸① 有 **8 份**、闸② **7 份**、闸③ **2 份**逐字节相同的实现散在各 adapter 里。这类
 * 重复的危害不是「难维护」, 是**将来给信封加第四道闸时漏掉一处不会红** —— 漏掉的那条通路
 * 继续接收坏响应并认为它完好, 前三道闸照样全绿。
 *
 * 📌 **本模块只管校验, 不碰 HTTP**: 各 adapter 的 `fetchRows` / `fetchEnvelope` 保留自己的
 * 请求与**失败语义映射** (429 → 顺延 / 400 → 永久拒绝 / 一律原样上抛, 逐 adapter 不同且是
 * 刻意的)。把那层也收进来会把三种不同的错误策略压成一种。
 *
 * 🚫 **MUST NOT 顺手收紧闸②** —— 现行语义是「`count` 缺失或非 number ⇒ 跳过对账」。改成
 * 「必须有 count」会让不带该字段的端点全部炸掉, 那是行为变化不是重构 (单测钉着这条)。
 */

/** shim 信封的裸形状 —— 三个字段一律 `unknown`, 校验在本模块内做。 */
export interface ShimEnvelope {
  as_of?: unknown;
  count?: unknown;
  rows?: unknown;
}

/**
 * 闸① + 闸②。用于**不消费 `as_of`** 的端点 (链 / 财报 / IV / universe / kline …)。
 *
 * @param what 供定位的上下文串 (如 `option-chain us:ACN`), 原样进报错文案
 * @returns `res.rows` **原样引用** (不拷贝、不过滤 —— 过滤是调用方的语义)
 * @throws 任一闸不过 → `Error`, **不返回半份数据**
 *
 * 复杂度 `O(1)`。
 */
export function parseShimRows(res: ShimEnvelope | undefined, what: string): unknown[] {
  const rows = res?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`[futu] ${what} 响应缺 rows[] (契约变更?)`);
  }
  if (typeof res?.count === 'number' && res.count !== rows.length) {
    throw new Error(
      `[futu] ${what} 行数与信封 count 不符 (疑截断): count=${res.count} rows=${rows.length}`,
    );
  }
  return rows;
}

/**
 * 闸① + 闸② + 闸③。用于**要落 / 要判新鲜度**的端点 (option-snapshot 的两个消费方)。
 *
 * 🚨 闸序刻意是 rows → count → as_of: 契约变更比时刻缺失更根本, 先报它更好定位。
 *
 * 复杂度 `O(1)`。
 */
export function parseShimEnvelope(
  res: ShimEnvelope | undefined,
  what: string,
): { asOf: Date; rows: unknown[] } {
  const rows = parseShimRows(res, what);
  const asOf = new Date(String(res?.as_of ?? ''));
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`[futu] ${what} 响应缺可解析的 as_of (采集时刻, 契约变更?)`);
  }
  return { asOf, rows };
}
