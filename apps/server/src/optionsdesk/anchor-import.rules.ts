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
export const ANCHOR_IMPORT_INVALID_PREFIX = 'INVALID_IMPORT_';
export const INVALID_IMPORT_TICKER_CODE = `${ANCHOR_IMPORT_INVALID_PREFIX}TICKER`;
export const INVALID_IMPORT_MARKET_CODE = `${ANCHOR_IMPORT_INVALID_PREFIX}MARKET`;
export const INVALID_IMPORT_CONFIDENCE_CODE = `${ANCHOR_IMPORT_INVALID_PREFIX}CONFIDENCE`;

/**
 * 建锚入口 (045 App 手工建锚) 的同类失败码 —— 与上面 059 导入侧**判据同源、字符串另起**。
 *
 * 建锚失败报「IMPORT」读起来是错的; 而 059 的码有 IT 在断言 (`optionsdesk-059.anchor-import.it.spec.ts`)
 * ⇒ **MUST NOT 改它**。重复的只是错误字符串 (无害), 判据仍单点在 {@link assertImportableTicker}
 * —— 会漂的是那个, 不是字符串。前缀体例同 `anchor.rules.ts` 的 `INVALID_ANCHOR_V`。
 */
export const ANCHOR_CREATE_INVALID_PREFIX = 'INVALID_ANCHOR_';
export const INVALID_ANCHOR_TICKER_CODE = `${ANCHOR_CREATE_INVALID_PREFIX}TICKER`;
export const INVALID_ANCHOR_MARKET_CODE = `${ANCHOR_CREATE_INVALID_PREFIX}MARKET`;

/**
 * 待审收件箱三态 (059 FR-011)。**人工处置的留痕, 不是状态机**: 系统只写 `PENDING`,
 * 另两态由本人在 DB 直连处置后手工置 —— 本片刻意零审阅面 (plan §6)。
 */
export const ANCHOR_SUBMISSION_STATUSES = ['PENDING', 'CONSUMED', 'REJECTED'] as const;

export type AnchorSubmissionStatus = (typeof ANCHOR_SUBMISSION_STATUSES)[number];

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
 * 建锚入口的 ticker 校验 + **市场归属单点派生** (065 FR-013 / FR-014, plan §D0)。
 * O(|ticker|)。
 *
 * 判据整个委托 {@link assertImportableTicker}, 本函数只做两件事:
 *   ① 把 059 的 `INVALID_IMPORT_` 前缀换成建锚侧的 `INVALID_ANCHOR_`, message 体一字不改;
 *   ② 把已经解析出来的市场段**返回**给写侧, 免得它再解析一次。
 *
 * 🚨 调用方 MUST 用返回值写 `anchor.market`, MUST NOT 自己再调一次 `parseAnchorTicker`
 *    —— 「写入侧单点求值」是这一列不会 drift 的三个前提之一 (schema.prisma 该列注释)。
 *
 * 🚨 canonical 的多段代码是 `us:BRK.B` (**点**)。`parseAnchorTicker` 按首个冒号切、code 段
 *    原样保留, 所以 `us:BRK:B` 在它那里解得出 `code = 'BRK:B'` —— 但 {@link IMPORTABLE_CODE_PATTERN}
 *    不含冒号, 建锚**拒**它。两者方向相反, 别照直觉当成受支持。
 */
export function assertCreatableTicker(ticker: string): ImportableMarket {
  try {
    assertImportableTicker(ticker);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(ANCHOR_IMPORT_INVALID_PREFIX)) {
      throw new Error(
        ANCHOR_CREATE_INVALID_PREFIX + err.message.slice(ANCHOR_IMPORT_INVALID_PREFIX.length),
      );
    }
    throw err;
  }
  const parsed = parseAnchorTicker(ticker);
  if (parsed === null || !isImportableMarket(parsed.market)) {
    // 到不了 —— 上面那句已判过「可解析」与「市场在白名单」。留着是 TS 收窄所需, 且真到了
    // 这里, 静默返回一个空/越界市场会让 T03 的 NOT NULL + CHECK 拖到部署期才炸。
    throw new Error(`${INVALID_ANCHOR_TICKER_CODE}: 须为 canonical \`market:code\` 写法`);
  }
  return parsed.market;
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

// ─────────────────────────────────────────────────────────────────────────────
// 「这次导入什么都没改」的判据 (FR-006)
// ─────────────────────────────────────────────────────────────────────────────

/** {@link isImportNoop} 要比的锚侧字段 —— 结构化窄类型, 使本文件不依赖任何 use case。 */
export interface ImportComparableAnchor {
  v: Prisma.Decimal;
  asof: Date;
  method: string;
  confidence: Prisma.Decimal;
  confidenceSource: string;
}

/** {@link isImportNoop} 要比的入参侧字段。 */
export interface ImportComparableInput {
  v: string | Prisma.Decimal;
  asof: Date;
  method: string;
  confidence: string | Prisma.Decimal;
}

/** UTC 午夜折平 —— `@db.Date` 列读回来就是这个基准, 只比日期不比时刻。 */
function utcDateOnly(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * 四个模型事实全等 **且**来源已是 `model` ⇒ 本次导入什么都不会写 (FR-006)。
 *
 * 🚨 比的是**值**不是字符串: `'50'` 与 `'50.00'` 是同一个估值, 按字符串比会让每天的例行导入
 * 都写一遍库、并顺手冲掉三处人工位。
 *
 * 🚨 为什么把 `confidence_source` 也算进来: 手工锚的数字恰好与模型一致时, 这次导入**确实
 * 改了东西** —— 它把 provenance 翻成 model (FR-002 的 MUST)。判成 noop 会让那只锚继续显示
 * 「人工来源、可编辑」, 与实际写入路径不符。
 *
 * 📌 **072 起它从 use case 私有函数搬到这里**, 因为**读侧也要用**: 审批详情页要在采纳**之前**
 * 告诉人「这次会不会真的写」。没有它, 一条与现有锚逐值相同的提交会被预览成
 * 「将刷新, 并清掉你的 3 处人工位」—— 一个**什么都不会写**的操作配上最吓人的警告,
 * 而那正是训练人闭眼点确认的机制。
 */
export function isImportNoop(row: ImportComparableAnchor, input: ImportComparableInput): boolean {
  return (
    row.confidenceSource === 'model' &&
    row.v.equals(new Prisma.Decimal(input.v)) &&
    row.confidence.equals(new Prisma.Decimal(input.confidence)) &&
    utcDateOnly(row.asof).getTime() === utcDateOnly(input.asof).getTime() &&
    row.method === input.method
  );
}
