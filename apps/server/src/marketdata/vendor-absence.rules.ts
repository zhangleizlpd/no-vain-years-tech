/**
 * vendor **缺失语义**归一化纯函数 (#172)。无 I/O、无 DI (ADR-0043 §4: rules 文件持无副作用
 * 业务规则)。
 *
 * ## 这个文件存在的理由
 *
 * 富途**不用 null 表达「没有」** —— 它用**带内哨兵** (in-band sentinel): 数值列用 `0`、
 * 字符串列用 `'N/A'`。而 adapter 里 `numToString` 的 null 判据是为**带外缺失** (out-of-band:
 * 字段不下发 / 非有限数 / 空串) 设计的 ⇒ 那道闸在这个 vendor 上**恒不触发**。
 *
 * 实测坐实 (2026-08-24, prod 全表 185918 行): 除 `iv` 外**没有任何数值列曾经是 NULL**,
 * 而 `bid = 0` 有 37340 行、`volume = 0` 有 134653 行。adapter 注释承诺的「0 与『没给』是
 * 两件事」在数据里根本不存在。
 *
 * 后果分两半, 同源于一个哨兵撞上落库前硬门 (`option-snapshot-guard.rules.ts` 门 ④):
 *   · 虚值腿 内在价值 = 0 ⇒ 下界 −0.05 ⇒ `ask = 0` **放行** ⇒ 假报价入库
 *   · 实值腿 内在价值 > 0.05 ⇒ `ask = 0` **被拒** ⇒ 当日快照**永久缺口** (vendor 不提供
 *     历史期权快照, 买不回来)
 *
 * ## 🚨 判据必须**成对**, MUST NOT 只看价格
 *
 * OPRA Binary Participant Interface 明写「**Zero in the bid price field represents a valid
 * Bid Price**」⇒ 零价可以是合法报价。写成 `if (price === 0) return null` 会静默吃掉真实
 * 报价, 且不会红。可靠判据是 `(price, size)` **同时为 0** —— 这也是 NautilusTrader 的做法
 * (`has_bid()` = 顶档存在 **且** 该档非空), 且与本仓实测的 523 + 185395 行零例外相符。
 *
 * ## 🚨 不一致形态**原样保留**并报 `inconsistent`, 不猜、不丢行
 *
 * 富途 OpenAPI **没有文档化**缺失时返什么 (2026-08-24 核 `get-market-snapshot` 官方页,
 * 四个字段都只列了类型) ⇒ 上面那条判据是**从数据反推的**, 而反推出来的东西会过期,
 * 且过期时**不会报错**。`price = 0 ∧ size > 0` 这类形态就是「哨兵理论破裂」的唯一信号,
 * 把它归一掉等于把警报器拆了。调用方据 `form` 抬 WARN, 行照常入库。
 *
 * ## 职责分层 (这次缺陷的根因是它没被定死, 见 ADR-0067)
 *
 * | 层 | 管什么 |
 * | --- | --- |
 * | 网关 shim (`mappers.clean_value`) | **传输形态**归一: 空值 / 非有限数 |
 * | 本文件 + adapter | **业务语义**归一: vendor 哨兵 → null |
 *
 * `'N/A'` 当初漏进库正是因为两层都以为对方管了。
 */

/** vendor 在**字符串列**上表达「没有值」用的字面量哨兵 (066 T01 实测: 港股链 132/132 行)。 */
export const VENDOR_STRING_NULL_SENTINEL = 'N/A';

/**
 * 盘口某一侧归一化后的形态。
 *
 * · `quoted`       —— 有价有量, 正常报价
 * · `absent`       —— 该侧没有挂单 (哨兵命中, 或 vendor 整个没下发)
 * · `inconsistent` —— **哨兵理论不成立的形态**。原值原样保留, 供调用方告警
 */
export type QuoteSideForm = 'quoted' | 'absent' | 'inconsistent';

export interface NormalizedQuoteSide {
  /** Decimal-safe 字符串; `absent` 时为 `null`。 */
  price: string | null;
  /** 与 `price` **同进同退** —— 只 null 掉价格会留下「无价有量」的自相矛盾行。 */
  size: string | null;
  form: QuoteSideForm;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 / 空串 → null。
 *
 * 🚨 这是**传输形态**层的判据, 只认带外缺失。带内哨兵 (`0`) 归 {@link normalizeQuoteSide} 管。
 * 复杂度 O(1)。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/** 已归一为字符串的数值是否恰为 0（`'0'` / `'0.00'` / `'-0'` 同判）。O(1)。 */
function isZero(s: string | null): boolean {
  return s !== null && Number(s) === 0;
}

/** 已归一为字符串的数值是否严格为正。O(1)。 */
function isPositive(s: string | null): boolean {
  return s !== null && Number(s) > 0;
}

/**
 * 盘口单侧 `(price, size)` 成对归一化 (#172)。**永不抛异常、永不丢行**。
 *
 * 真值表 —— 每一行都有对应用例, 改这里必先改 `vendor-absence.rules.spec.ts`:
 *
 * | price | size | form | 输出 |
 * | --- | --- | --- | --- |
 * | 缺失 | 缺失 | `absent` | `(null, null)` |
 * | `0` | `0` | `absent` | `(null, null)` —— **哨兵命中** |
 * | `> 0` | `> 0` | `quoted` | 原样 |
 * | 其余一切 | | `inconsistent` | **原样**, 交调用方告警 |
 *
 * 复杂度 **O(1)**。
 */
export function normalizeQuoteSide(rawPrice: unknown, rawSize: unknown): NormalizedQuoteSide {
  const price = numToString(rawPrice);
  const size = numToString(rawSize);

  // 带外缺失: vendor 整个没下发这一侧 (或下发了非有限数)。
  if (price === null && size === null) return { price: null, size: null, form: 'absent' };

  // 带内哨兵: 成对的 0 = 该侧无挂单。**只有这一档才 null 化**。
  if (isZero(price) && isZero(size)) return { price: null, size: null, form: 'absent' };

  // 正常报价。
  if (isPositive(price) && isPositive(size)) return { price, size, form: 'quoted' };

  // 🚨 其余全部是「哨兵理论破裂」的形态 —— 含合法零价买盘 (OPRA) 与单边缺失。
  // 原样保留: 猜错的代价 (静默吃掉真实报价 / 静默造出假报价) 远高于留一行待查数据。
  return { price, size, form: 'inconsistent' };
}

/**
 * 非空字符串 → 原样 trim；空串 / 非字符串 / {@link VENDOR_STRING_NULL_SENTINEL} → null。
 *
 * 收编自 `futu-option-chain.adapter.ts` 的同名逻辑 (066 T01) —— 两个 adapter 各写一份必 drift,
 * 而 drift 的表现是「某一列悄悄存进字面量 `'N/A'`」, 不会红。复杂度 O(1)。
 */
export function strOrNullSentinelAware(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' || trimmed.toUpperCase() === VENDOR_STRING_NULL_SENTINEL ? null : trimmed;
}

/**
 * 🚨 **`0` 与「没有值」在这些列上分不出来 —— 本地无解, 显式登记而非留白。**
 *
 * 判据是**有没有伴生字段可消歧**。盘口价有 `*_vol` 作伴生 ⇒ 可判 (见 {@link normalizeQuoteSide});
 * 下列各列的 `0` 是**合法取值**(今天真没成交 / 真没持仓 / 真零成交额), 且 vendor 不另给
 * 「有没有值」的标志位 ⇒ 属 vendor 契约层的信息丢失。
 *
 * 🚫 **MUST NOT 把这些列也 `0 → null`** —— 那会把「真的是 0」抹成「不知道」, 方向与本次修复
 * 正好相反, 且同样不会红。
 *
 * 📌 `last_price` / `prev_close_price` **刻意不在本表**: 实测两者的 0 值计数完全相等
 * (3312 / 3312, 疑似「从未成交的合约」), 但**不能凭数据断言**语义 —— 待向 vendor 求证后
 * 再决定归属, 在此之前维持原样不动。
 */
export const INDISTINGUISHABLE_ZERO_FIELDS: ReadonlySet<string> = new Set([
  'volume',
  'turnover',
  'open_interest',
  'net_open_interest',
]);
