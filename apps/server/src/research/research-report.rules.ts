import { createHash } from 'node:crypto';

/**
 * 研报投递的纯函数规则（057）。无 I/O、无 DI —— 归一 / 判型 / 兜底 / 定位四件事。
 *
 * 刻意**不复用** `marketdata` 的 `parseCanonicalSymbol`：research 是叶子 ctx，跨 ctx 面为 0
 * （ESLint boundaries 硬拦），且两者的语义要求不同 —— 那个是「解析已经 canonical 的串」，
 * 这个是「把外部投递方随手写的各种形态**归一**成 canonical，越界就拒」。
 */

/** 支持的市场，与 spec FR-005 一致。 */
const MARKETS = ['cn', 'hk', 'us'] as const;
/** 导出是因为它是 `splitSymbol` 返回值的一部分（058）。 */
export type Market = (typeof MARKETS)[number];

/** 归档对象的 key 前缀 —— RAM 策略的作用域恰好卡在它上面（Phase 0 反例实证）。 */
export const RESEARCH_KEY_PREFIX = 'research/';
/** 归档对象的 key 尾段。语义化后缀，便于在 OSS 控制台直接认出这是什么。 */
export const RESEARCH_KEY_LEAF = 'report.pdf';

/** 各市场代码的形态与归一方式。 */
const CODE_RULES: Record<Market, { pattern: RegExp; normalize: (code: string) => string }> = {
  // A 股 6 位数字（600519 / 000001）。
  cn: { pattern: /^\d{1,6}$/, normalize: (c) => c.padStart(6, '0') },
  // 港股 5 位数字，**补零**到 5 位 —— 仓内 canonical 就是这个形态（vendor 下发即如此）。
  // 去零存成 `hk:1698` 的话，将来按 `market:code` 关联行情库会一条都匹配不上，且不报错。
  hk: { pattern: /^\d{1,5}$/, normalize: (c) => c.padStart(5, '0') },
  // 美股按 ticker，统一大写；允许 `.`/`-`（BRK.B / BF-B 这类）。
  us: { pattern: /^[A-Za-z][A-Za-z0-9.-]{0,15}$/, normalize: (c) => c.toUpperCase() },
};

export type InvalidSymbolReason =
  /** 投递方对分隔符做了百分号编码 —— nginx 的 `$arg_*` 不解码，编码过的值撞不上市场闸。 */
  | 'percent-encoded'
  /** 市场段不在 cn|hk|us 白名单。 */
  | 'market'
  /** 整体形态不认（空 / 缺段 / 多标的 / 代码含非法字符 / 位数超限）。 */
  | 'format';

/**
 * 标的写法不合规。`reason` 让调用方能给出**可区分**的拒绝理由（SC-004：投递方是 agent，
 * 含糊的拒绝会让它反复重试）。
 */
export class InvalidSymbolError extends Error {
  constructor(
    readonly reason: InvalidSymbolReason,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidSymbolError';
  }
}

function isMarket(v: string): v is Market {
  return (MARKETS as readonly string[]).includes(v);
}

/** `.SH` / `.SZ` 这类交易所后缀也认，映射到 cn。 */
const EXCHANGE_TO_MARKET: Record<string, Market> = { sh: 'cn', sz: 'cn' };

function resolveMarket(seg: string): Market | undefined {
  const lower = seg.toLowerCase();
  return isMarket(lower) ? lower : EXCHANGE_TO_MARKET[lower];
}

/**
 * 拆出市场段与代码段。返回 `null` = 压根找不到分隔符；`market: null` = 找到了分隔符但那一段
 * 不是支持的市场（两者的拒绝理由不同，SC-004 要求可区分）。
 *
 * 🚨 **不能按 `[:.]` 无差别切段** —— 美股 ticker 自身可以带点（`BRK.B`），那样切会把它劈成
 * 三段而误拒。所以：有冒号就只按**第一个**冒号切；只有点时先试**最后一个**点（后缀式
 * `BRK.B.US`），再试**第一个**点（前缀式 `HK.01698`）。
 */
function splitMarketAndCode(s: string): { market: Market | null; code: string } | null {
  const colon = s.indexOf(':');
  if (colon >= 0) {
    if (colon === 0 || colon === s.length - 1) return null;
    return { market: resolveMarket(s.slice(0, colon)) ?? null, code: s.slice(colon + 1) };
  }

  const lastDot = s.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === s.length - 1) return null;

  const suffixMarket = resolveMarket(s.slice(lastDot + 1));
  if (suffixMarket !== undefined) return { market: suffixMarket, code: s.slice(0, lastDot) };

  const firstDot = s.indexOf('.');
  const prefixMarket = resolveMarket(s.slice(0, firstDot));
  if (prefixMarket !== undefined) return { market: prefixMarket, code: s.slice(firstDot + 1) };

  // 有点、但两端都不是市场段（如 `BRK.B` 没写市场）。
  return { market: null, code: s };
}

/**
 * 把投递方给的标的写法归一成 canonical `market:code`。
 *
 * 认得的形态：前缀式 `hk:1698` / `HK.01698`、后缀式 `1698.HK` / `600519.SH`，大小写随意，
 * 首尾空白无所谓。归一是**幂等**的。
 *
 * @throws {InvalidSymbolError} 市场越界、百分号编码、或形态根本不认。
 */
export function normalizeSymbol(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('%')) {
    throw new InvalidSymbolError(
      'percent-encoded',
      '标的里出现百分号编码（如 hk%3A1698）。请直接写 hk:1698，**不要**对冒号做 URL 编码。',
    );
  }
  // 一次只收一个标的：逗号 / 空白 / 分号都视为「给了多个」。
  if (/[,;\s]/.test(trimmed)) {
    throw new InvalidSymbolError('format', `标的形态不认: ${trimmed}（一次只能投递一个标的）`);
  }

  const split = splitMarketAndCode(trimmed);
  if (split === null) {
    throw new InvalidSymbolError(
      'format',
      `标的形态不认: ${trimmed}（应为 hk:00700 或 00700.HK 这类）`,
    );
  }
  if (split.market === null) {
    throw new InvalidSymbolError(
      'market',
      `市场不在支持范围: ${trimmed}（仅支持 ${MARKETS.join(' / ')}）`,
    );
  }
  const { market, code } = split as { market: Market; code: string };

  const rule = CODE_RULES[market];
  // 补零只补短的：位数超限说明这不是该市场的代码，不该被静默截断或接受。
  const bare = market === 'us' ? code : code.replace(/^0+(?=\d)/, '');
  if (!rule.pattern.test(bare)) {
    throw new InvalidSymbolError('format', `${market} 市场的代码形态不认: ${code}`);
  }
  return `${market}:${rule.normalize(bare)}`;
}

/**
 * 把**已归一**的 canonical `market:code` 拆回两段（058 FR-016）。
 *
 * 输入必须是 `normalizeSymbol` 的产物，即**最终落库的 `row.symbol`**，不是投递方的原始写法
 * （幂等命中时二者归一后必然相同，但写法可能不同：`00700.HK` vs `hk:00700`）。
 *
 * 🚨 **对未归一的写法抛错，而不是尽力而为地拆** —— 尽力而为会把 `00700.HK` 拆成
 * `{ market: '00700', code: 'HK' }` 这种半成品，拿它去查标的目录只会静默查不到；而名称回显
 * 是 fail-open 的（FR-014 / FR-015），「查不到」与「拆错了」对外完全不可区分 ⇒ 一个本可以在
 * 这里红掉的错误会一路静默到线上。要归一请先走 `normalizeSymbol`。
 *
 * @throws {InvalidSymbolError} 不是 canonical `market:code` 形态，或市场段越界。
 */
export function splitSymbol(symbol: string): { market: Market; code: string } {
  const colon = symbol.indexOf(':');
  // canonical 形态的全部结构要求：恰好一个冒号，且两侧都非空。
  if (colon <= 0 || colon === symbol.length - 1 || symbol.includes(':', colon + 1)) {
    throw new InvalidSymbolError(
      'format',
      `不是归一后的 market:code 形态: ${symbol}（应为 normalizeSymbol 的产物，如 hk:00700）`,
    );
  }

  const market = symbol.slice(0, colon);
  if (!isMarket(market)) {
    throw new InvalidSymbolError(
      'market',
      `市场段不在支持范围: ${symbol}（仅支持 ${MARKETS.join(' / ')}）`,
    );
  }
  // 代码段不再按 CODE_RULES 复验：那是归一时的事，此处重复一遍只会与 normalizeSymbol 双头维护。
  return { market, code: symbol.slice(colon + 1) };
}

/** PDF 魔数。判据**基于内容**，与文件名和调用方声明的类型无关（FR-003）。 */
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

/** 字节是不是 PDF。魔数必须在**开头** —— 内容里晚一点出现不算。 */
export function looksLikePdf(bytes: Buffer): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  return bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** 工具链给文件名附加的 uuid 后缀（`---3f2a1b4c-5d6e-...`）。 */
const UUID_SUFFIX = /[-_\s]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_TITLE = '未命名研报';

/**
 * 缺标题时由文件名兜底。去扩展名 + 去掉工具链附加的 uuid 后缀。
 *
 * ⚠️ 只吃**完整 uuid** 那种后缀，不吃普通连字符 —— 「某公司-中报点评」里的横杠是标题的一部分。
 */
export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const cleaned = stem.replace(UUID_SUFFIX, '').trim();
  return cleaned === '' ? FALLBACK_TITLE : cleaned;
}

/**
 * 归档位置**由内容指纹单独导出**，与投递方无关。
 *
 * 这是「不同投递方投递同一字节 → 各留一行元数据、但复用同一份归档对象」成立的机制
 * （spec Clarifications Q1）：函数签名里根本没有投递方这个参数。
 *
 * 🚨 与 `buildPostObjectCredential({ keyPrefix: RESEARCH_KEY_PREFIX, uuid: contentHash,
 * keyLeaf: RESEARCH_KEY_LEAF })` 的产物**必须逐字节相同** —— 两处一旦漂移，续做时的幂等
 * 重写会写到另一个位置，且不会有任何东西报错。`research-report.rules.spec.ts` 有一条
 * 断言把两者钉在一起。
 */
export function buildObjectKey(contentHash: string): string {
  return `${RESEARCH_KEY_PREFIX}${contentHash}/${RESEARCH_KEY_LEAF}`;
}

/** 内容指纹 = 文件字节的 sha256 hex。归档位置与幂等判据都从它导出。 */
export function contentHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 单份上限 16MB。两份真实样例分别约 2.02MB / 2.15MB，留出约 8 倍余量。
 *
 * 🚨 **四层体积天花板必须显式排序**（由外到内）：nginx `client_max_body_size`（20MB，
 * 413 + HTML 页，server 日志什么都没有，最难诊断）> **multipart `fileSize`（= 本常量，
 * 唯一能给干净 ProblemDetail 的那层）** < OSS `content-length-range` 上界（本常量 + slack）。
 * 让中间那层先跳闸 —— 外面两层各留 slack，本常量取准值。
 */
export const RESEARCH_MAX_BYTES = 16 * 1024 * 1024;

/** OSS policy 的 `content-length-range` 上界。留 slack 让 multipart 那层先跳闸。 */
export const RESEARCH_OSS_MAX_BYTES = RESEARCH_MAX_BYTES + 1024 * 1024;

/**
 * 单投递方配额 8GB（按样例约 2MB/份估算约 4000 份/人，两人合计仍远低于 40G 总容量）。
 *
 * 落成常量而非 env：这个值在有人真的撞到它之前不会有人调，而多一个 env 就要多过一遍
 * 九位置同步闸。要调就改这里 + 部署（spec Assumptions 说的「可配置」是这个意思）。
 */
export const RESEARCH_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * 研报日期：只认 `YYYY-MM-DD`，按 **UTC** 落成日历日。
 *
 * 🚨 不用 `new Date(raw)` 的本地时区解析 —— 那会让「2026-08-01」在 UTC+8 的进程里存成
 * 前一天，而这类偏差**不报错**，只让数字悄悄差一天
 * （per `docs/conventions/cross-timezone-date-semantics.md`）。研报日期取投递方声明值，
 * 系统不从 PDF 内容反推、也不与投递时刻做一致性校验。
 */
export function parseReportDate(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // `2026-02-31` 这类会被 Date 静默滚到 3 月 —— 回读比对挡掉。
  return d.toISOString().slice(0, 10) === raw ? d : null;
}
