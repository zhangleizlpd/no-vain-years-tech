/**
 * CBOE 官方历史 CSV 解析纯函数 (046 T003, FR-025 / plan D6)。
 *
 * 源 = CBOE **官方历史文件** `VIX_History.csv`（`DATE,OPEN,HIGH,LOW,CLOSE`）与
 * `VVIX_History.csv`（`DATE,VVIX`），77 直连全量拉取后整文件 upsert。
 * 🚨 **MUST NOT** 接盘中报价端点 `delayed_quotes/quotes/*.json` —— 站点级 Terms 明文禁
 * 复制/存储进电子检索系统，官方免费的只有历史文件（p3b E1/E24）。解析层与采集层都不认识
 * 那个端点，「顺手加个实时值」的念头停在这里。
 *
 * ## 为什么手写而不引 CSV 库（plan § Dependencies 定案）
 *
 * 两个文件是**定长列的规整 CSV**（无引号包裹、无嵌入逗号 —— 2026-08-02 在 77 上实拉首尾行
 * 核过：471 KB / 9,242 行 与 108 KB / 5,074 行）。`split` 足够；引 `csv-parse` / `papaparse`
 * 反而把**非法行的处置语义**藏进库的默认行为里，而那恰恰是本函数唯一要显式控制的东西。
 * 另：本片硬指标是零新第三方运行时依赖（SC-007）。
 *
 * ## 三条处置纪律
 *
 * 1. **首行表头必须校验** —— 表头变了 = vendor 改格式 ⇒ 抛 {@link CboeCsvHeaderError}，
 *    而不是把表头当数据行吞下去。**空文件同样抛**：返回 0 行会被上游当成「今天没数据」
 *    静默接受，而空 body 实际是抓取坏了。BOM / CRLF / 大小写 / 列内空格是传输噪声，
 *    先归一再比，不算格式变更。
 * 2. **非法行跳过并计数** —— `skipped` 随返回值上抛（下游进 `SyncRun` 统计），禁静默丢。
 *    列数不符 / 数值非法 / 日期解析失败都算非法；**空白行不算**（是文件换行不是坏数据）。
 *    一行里任一列非法 ⇒ **整行**跳过，不落半行、不拿 `null` 冒充缺列。
 * 3. **VVIX 只有 CLOSE** ⇒ 其余 OHLC 产出 `null`，**禁填 0**（Guardrail 7 / FR-025）：
 *    填 0 会让「VVIX 开盘 0」这种假事实进库，且下游分不出「无此列」与「真是 0」。
 *
 * 数值**原样留字符串**不过 `Number()`：落库列是 `Decimal(18,4)`，字符串直喂 Prisma 无精度
 * 损失（Float 禁令）。解析层只判**格式**不判业务合理性（0 / 极值照落，异常归质量闸）。
 *
 * 复杂度 O(n)（n = 行数，单遍扫描，无排序无回溯）。
 */

/** VIX 历史文件表头（vendor 契约锚点，改了就是 vendor 改格式）。 */
export const CBOE_VIX_CSV_HEADER = 'DATE,OPEN,HIGH,LOW,CLOSE';

/** VVIX 历史文件表头 —— 单值列，**没有 OHLC**（E2 实测）。 */
export const CBOE_VVIX_CSV_HEADER = 'DATE,VVIX';

/** 非法行样本保留上限（进日志/告警便于定位）；`skipped` 计数本身是全量真值，不受此限。 */
export const CBOE_CSV_SKIPPED_SAMPLE_LIMIT = 5;

/** 本片采集的两个指数代码（`us_index_daily.index_code` 的值域）。 */
export type CboeIndexCode = 'VIX' | 'VVIX';

/** 解析产出的一日行情。数值为原样字符串（调用方直喂 Prisma Decimal）。 */
export interface CboeIndexDailyRow {
  /** `YYYY-MM-DD`（源文件是 `MM/DD/YYYY`）。 */
  date: string;
  /** VVIX 恒为 `null`（源文件无此列）—— **禁填 0**。 */
  open: string | null;
  /** 同上。 */
  high: string | null;
  /** 同上。 */
  low: string | null;
  /** 两个文件都有，非法即整行跳过 ⇒ 恒非空。 */
  close: string;
}

export interface CboeIndexCsvParseResult {
  indexCode: CboeIndexCode;
  rows: CboeIndexDailyRow[];
  /** 被跳过的非法行数（禁静默丢：下游把它计入 `SyncRun` 统计）。 */
  skipped: number;
  /** 前 {@link CBOE_CSV_SKIPPED_SAMPLE_LIMIT} 条非法行原文，供定位。 */
  skippedSamples: string[];
}

/** 表头与预期不符（含空文件）—— vendor 改格式的硬信号，调用方 MUST 让本轮采集失败。 */
export class CboeCsvHeaderError extends Error {
  constructor(
    readonly indexCode: CboeIndexCode,
    readonly expectedHeader: string,
    readonly actualHeader: string,
  ) {
    super(
      `[cboe] ${indexCode} CSV 表头不符 (vendor 改格式?): 期望 "${expectedHeader}", 实得 "${actualHeader}"`,
    );
    this.name = 'CboeCsvHeaderError';
  }
}

const EXPECTED_HEADER: Readonly<Record<CboeIndexCode, string>> = {
  VIX: CBOE_VIX_CSV_HEADER,
  VVIX: CBOE_VVIX_CSV_HEADER,
};

/** 十进制数字面量（无科学计数、无千分位 —— 源文件两者都不出现）。 */
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;

/** `MM/DD/YYYY`；月/日允许 1-2 位（vendor 若哪天去掉补零不至于整份文件报废）。 */
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** UTF-8 BOM（U+FEFF）。源码里禁写字面量（`no-irregular-whitespace` 是 error），按码点构造。 */
const BOM = String.fromCharCode(0xfeff);

/** 表头归一：去列内空格 / 统一大写 —— 传输噪声不算 vendor 改格式。 */
function normalizeHeader(line: string): string {
  return line
    .split(',')
    .map((cell) => cell.trim().toUpperCase())
    .join(',');
}

/** `MM/DD/YYYY` → `YYYY-MM-DD`；格式不符或日期不存在（如 02/30）→ null。 */
function toIsoDate(raw: string): string | null {
  const m = US_DATE_RE.exec(raw);
  if (m === null) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  // 日历有效性：靠 UTC 构造回读 —— JS 会把 02/30 滚成 03/01，回读不等即非法。
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 合法十进制数 → 原样字符串（不过 Number，避免 Float 精度损失）；否则 null。 */
function numericOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  return NUMERIC_RE.test(v) ? v : null;
}

/**
 * 解析 CBOE 官方历史 CSV。
 *
 * @throws {CboeCsvHeaderError} 表头与 {@link CBOE_VIX_CSV_HEADER} / {@link CBOE_VVIX_CSV_HEADER}
 *   不符，或文件无有效内容行（空 body = 抓取坏了，不是「今天没数据」）。
 */
export function parseCboeIndexCsv(csv: string, indexCode: CboeIndexCode): CboeIndexCsvParseResult {
  const expected = EXPECTED_HEADER[indexCode];
  const columnCount = expected.split(',').length;
  // BOM 只可能出现在文件首字节；CRLF 统一按 \n 切后逐行 trim 掉残留的 \r。
  const lines = (csv.startsWith(BOM) ? csv.slice(BOM.length) : csv).split('\n');

  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++;
  const headerLine = cursor < lines.length ? lines[cursor]!.trim() : '';
  if (normalizeHeader(headerLine) !== expected) {
    throw new CboeCsvHeaderError(indexCode, expected, headerLine);
  }

  const rows: CboeIndexDailyRow[] = [];
  const skippedSamples: string[] = [];
  let skipped = 0;

  for (let i = cursor + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue; // 空白行 = 文件换行，不是坏数据（不计入 skipped）。

    const skip = (): void => {
      skipped++;
      if (skippedSamples.length < CBOE_CSV_SKIPPED_SAMPLE_LIMIT) skippedSamples.push(line);
    };

    const cells = line.split(',');
    if (cells.length !== columnCount) {
      skip();
      continue;
    }

    const date = toIsoDate(cells[0]!.trim());
    if (date === null) {
      skip();
      continue;
    }

    if (indexCode === 'VVIX') {
      const close = numericOrNull(cells[1]);
      if (close === null) {
        skip();
        continue;
      }
      // 🚨 OHLC 恒 null 而非 0 —— 源文件根本没有这三列（Guardrail 7 / FR-025）。
      rows.push({ date, open: null, high: null, low: null, close });
      continue;
    }

    const open = numericOrNull(cells[1]);
    const high = numericOrNull(cells[2]);
    const low = numericOrNull(cells[3]);
    const close = numericOrNull(cells[4]);
    if (open === null || high === null || low === null || close === null) {
      skip(); // 任一列非法 → 整行跳过，不落半行。
      continue;
    }
    rows.push({ date, open, high, low, close });
  }

  return { indexCode, rows, skipped, skippedSamples };
}
