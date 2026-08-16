import { Prisma } from '../generated/prisma/client';
import { parseAnchorTicker } from './anchor.rules';

/**
 * 059 模型导入通道的**输入校验**纯函数 (FR-003 / FR-004 / FR-005)。无 I/O、无 DI ——
 * 写侧 (`import-anchor-from-model.usecase.ts` / 提交端点) 调用, 抛出的错误由写侧折成 400。
 *
 * 🚨 **一律拒, 绝不归一**。导入方是程序不是人: 收到 400 就该改自己的输出, 而静默归一
 * (`AOS` → `us:AOS` / `us:pep` → `us:PEP`) 把上游 bug 藏进库里 —— 藏起来的形态是**建锚成功
 * 但行情永远为空**的僵尸锚 (行情投影按 canonical `market:code` 找标的, 找不到就跳过),
 * 且它与「该标的尚未被采集到」在界面上不可区分。
 *
 * ⚠️ **MUST NOT 复用 research 的 `normalizeSymbol`**: ESLint boundaries 硬拦跨 ctx import,
 * 且语义正相反 —— 那个是「随手写的都收」(研报投递方是人), 这个是「不规范就拒」。
 *
 * 校验只覆盖**新端点** (059 plan §7): 既有 JWT 写端点的同类缺口另记 backlog, 本片不动它们
 * —— 给既有 DTO 补校验会让 App 侧既有请求开始 400。
 */

/** 本期认的市场白名单 (FR-005): 美股 / 港股。其余一律拒且不落库。 */
export const IMPORTABLE_MARKETS = ['us', 'hk'] as const;

export type ImportableMarket = (typeof IMPORTABLE_MARKETS)[number];

/** = `schema.prisma` 的 `anchor.ticker` 列宽。超长在这里拒, 别让它穿透到 PG 变 22001。 */
export const ANCHOR_TICKER_MAX_LENGTH = 32;

/** 置信度量表闭区间 (10 分制, 045 起的既有口径)。两端**含**。 */
export const ANCHOR_CONFIDENCE_MIN = 0;
export const ANCHOR_CONFIDENCE_MAX = 10;

/**
 * 三个可区分的失败原因 (SC-006「拒绝原因可区分」)。写侧按前缀映射 400 并原样透出 message,
 * 体例同 `anchor.rules.ts` 的 `INVALID_ANCHOR_V`。
 */
export const INVALID_IMPORT_TICKER_CODE = 'INVALID_IMPORT_TICKER';
export const INVALID_IMPORT_MARKET_CODE = 'INVALID_IMPORT_MARKET';
export const INVALID_IMPORT_CONFIDENCE_CODE = 'INVALID_IMPORT_CONFIDENCE';

/** 代码段形态: 首位字母数字, 其后允许 `.` (`us:BRK.B`)。**大写**是 canonical 的一部分。 */
const IMPORTABLE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9.]*$/;

export function isImportableMarket(market: string): market is ImportableMarket {
  return (IMPORTABLE_MARKETS as readonly string[]).includes(market);
}

/**
 * canonical `market:code` 校验 (FR-003 + FR-005)。O(|ticker|)。
 *
 * 市场段大小写不对时报**写法**不合规而非市场越界 —— 报后者会让调用方去查「美股是不是不
 * 支持了」, 而真正要改的是那两个字母的大小写。
 */
export function assertImportableTicker(ticker: string): void {
  if (ticker.length > ANCHOR_TICKER_MAX_LENGTH) {
    throw new Error(`${INVALID_IMPORT_TICKER_CODE}: ticker 超过 ${ANCHOR_TICKER_MAX_LENGTH} 字符`);
  }
  const parsed = parseAnchorTicker(ticker);
  if (parsed === null) {
    throw new Error(`${INVALID_IMPORT_TICKER_CODE}: 须为 canonical \`market:code\` 写法`);
  }
  if (!isImportableMarket(parsed.market)) {
    if (isImportableMarket(parsed.market.toLowerCase())) {
      throw new Error(`${INVALID_IMPORT_TICKER_CODE}: 市场段须小写 (\`us\` / \`hk\`)`);
    }
    throw new Error(
      `${INVALID_IMPORT_MARKET_CODE}: 市场 ${parsed.market} 不在白名单 (${IMPORTABLE_MARKETS.join(' / ')})`,
    );
  }
  if (!IMPORTABLE_CODE_PATTERN.test(parsed.code)) {
    throw new Error(`${INVALID_IMPORT_TICKER_CODE}: 代码段须为大写字母 / 数字 (可含 \`.\`)`);
  }
}

/**
 * 置信度值域校验 (FR-004)。`Decimal` 构造异常也折成同一个校验失败 —— 越界 / 非数字
 * MUST 以「输入不合法」拒, MUST NOT 穿透到存储层变成 numeric overflow 那类 500。
 */
export function assertImportableConfidence(confidence: string | Prisma.Decimal): void {
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(confidence);
  } catch {
    throw new Error(`${INVALID_IMPORT_CONFIDENCE_CODE}: 须为数值`);
  }
  if (
    !value.isFinite() ||
    value.lessThan(ANCHOR_CONFIDENCE_MIN) ||
    value.greaterThan(ANCHOR_CONFIDENCE_MAX)
  ) {
    throw new Error(
      `${INVALID_IMPORT_CONFIDENCE_CODE}: 须落在 [${ANCHOR_CONFIDENCE_MIN}, ${ANCHOR_CONFIDENCE_MAX}] 量表内`,
    );
  }
}
