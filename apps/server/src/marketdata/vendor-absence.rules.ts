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
 * **成交价类**数值的带内哨兵归一: `0` = 「没有这个价」, 不是价格。适用 `last_price` /
 * `prev_close_price`(期权行与标的行同判)。缺失 / 非有限 / 空串照旧 null。复杂度 O(1)。
 *
 * ## 🚨 为什么这里**允许单列判**, 而盘口价 ({@link normalizeQuoteSide}) 必须成对
 *
 * 两者判据不同**不是疏忽, 是反向约束不同**, MUST NOT 互相套用:
 *
 * | | 反向约束 | 判据 |
 * | --- | --- | --- |
 * | 盘口 `bid` / `ask` | OPRA 明写「Zero in the bid price field represents a **valid** Bid Price」⇒ **零价可能是真报价** | `(price, size)` 成对为 0 |
 * | 成交价 `last` / `prev_close` | 富途官方: 期权**最小价位 > 0**, 成交价恒为正 ⇒ **不存在真实的 0** | 单列 `= 0` |
 *
 * ## 判据出处 = vendor **书面答复**, 不是从数据反推 (ADR-0067 D5 第 3 问的最强那一档)
 *
 * py-futu-api#258 (2026-08-27, 官方 `hughex`): SDK 侧 `last_price = record.basic.curPrice` /
 * `prev_close_price = record.basic.lastClosePrice` **直接透传**, 无空值转换; OpenD 侧
 * `QotRealTimeData.cpp` 新建缓存条目时默认 `set_curprice(0) / set_lastcloseprice(0)`,
 * **`0` 就是「无价格数据」的占位**。⇒ 本判据不会像 D2 那样「过期时不报错」。
 *
 * ## 📌 `last = 0 ∧ volume > 0` 这个形态**存在, 且蓄意不报警**
 *
 * 实测 2 行 (`HK.ALB260904P122000` / `…P124000`, 2026-08-24, 有 13.7 万港元成交额却无成交价)。
 * 官方已把它解释为**新挂牌合约首个交易日**「价格字段尚未填充」—— 仍是「无值」, **不是**
 * 哨兵理论破裂 ⇒ 归一即可。不为它抬 WARN 的理由与 ADR-0067 拒绝把稀疏事件流塞进探针同源:
 * 港股周度合约每周都新挂, 报它就是长期噪音。**形态写在这里, 不写进运行时。**
 * ⚠️ 官方对「为何首日有成交却无价」只答「尚未填充」, 未给机制根因; 我们的数据把它框在
 * 「首日 + 从未成交」两档内 (5509/5511 是 `volume=0 ∧ open_interest=0`), 够用但不是封闭解释。
 */
export function tradedPriceOrNull(raw: unknown): string | null {
  const price = numToString(raw);
  return isZero(price) ? null : price;
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
 * 📌 `last_price` / `prev_close_price` **已求证, 归属已定, 不在本表**: 曾因「0 值计数完全相等
 * 但不能凭数据断言语义」挂起; 富途官方于 py-futu-api#258 (2026-08-27) 书面确认 `0` 即无值 ⇒
 * 归 {@link tradedPriceOrNull} 单列归一。**别再把它们往回搬进本表。**
 */
export const INDISTINGUISHABLE_ZERO_FIELDS: ReadonlySet<string> = new Set([
  'volume',
  'turnover',
  'open_interest',
  'net_open_interest',
]);
