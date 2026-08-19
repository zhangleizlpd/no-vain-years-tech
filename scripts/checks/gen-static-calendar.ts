#!/usr/bin/env node
/**
 * gen-static-calendar.ts — HKEX 官方年历 → L2 静态离线日历数据 (044 FR / plan §L2 数据获取)。
 *
 * **离线人工年更工具，不在运行时跑**。产出 `apps/server/src/marketdata/static-calendar.data.ts`
 * 供 `StaticCalendarAdapter` (L2) 在 L1 活源失效时兜底。
 *
 * ★ **仓内零新依赖**: 解析的是 `pdftotext -layout` 的**文本输出**, 不是 PDF 本身。poppler 只是
 * dev 机年更时的一次性工具 (`brew install poppler`) —— **不进仓、不增运行时/构建面**。
 *
 * 用法 (年更, 见 `ops/runbook/scheduled-tasks.md`):
 *   1. 从 HKEX 官网取次年 Stock Connect 年历 PDF (Trading Calendar):
 *      https://www.hkex.com.hk/Mutual-Market/Stock-Connect/Reference-Materials/Trading-Hour,-Trading-and-Settlement-Calendar
 *   2. pdftotext -layout <year>-Calendar_pdf_e.pdf calendar.txt
 *   3. pnpm tsx scripts/checks/gen-static-calendar.ts --year <year> --in calendar.txt
 *
 * 🚨 **L2 必须源自「年初即发布全年」的官方年历** —— **不能**从我方 `trading_day` 历史快照生成:
 * 快照一生成即开始腐烂, 到年中就答不了「近 30 天」窗 (填充只问过去 30 天, 但静态表必须覆盖到
 * 今天)。这条排除了看似省事的那条路。
 *
 * 🚨 **解析规约 5 条** (PoC 实证, 每条都是盲写解析器会踩的坑; plan §解析规约):
 *   1. PDF 只列**工作日** (Mon–Fri) → 周末天然排除, 解析器**无需**自算周末。
 *   2. **空白 = 开市; `Holiday` = 休市**。
 *   3. 🚨 **`Half Day` = 交易日, 不是休市** (除夕/平安夜半日市)。实证: 2026-02-16 HK `Half Day`
 *      → 库里**有**该日。误当 Holiday → 每年丢掉数个交易日。
 *   4. 🚨🚨 **只取 `Hong Kong` / `Shanghai & Shenzhen` 行, 绝不可取 `Northbound/Southbound
 *      Trading` 行** —— Connect 关闭 **≠** 该市场休市。实证 4/4: 2026-07-01 港股回归日 HK
 *      `Holiday` + Connect 双向 `Closed`, 但 `Shanghai & Shenzhen` **空白**且库里 cn **有**该日。
 *      取错行 → cn 每年凭空丢掉所有「港股独有假期」。
 *   5. 列按**位置**对齐 (`-layout` 保留列位), **非按空格数切分** (`Half Day` 自带空格, 切分即错)。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const OUT_PATH = join(REPO_ROOT, 'apps/server/src/marketdata/static-calendar.data.ts');

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * 🚨 规约 4 —— 市场行 ↔ market key。**`Northbound Trading` / `Southbound Trading` 蓄意不在此表**:
 * 它们是 Connect 通道状态, 不是市场休市状态。想加 Connect 维度 → 另开字段, **别往这里加**。
 */
const MARKET_ROW_LABELS: Record<string, 'cn' | 'hk'> = {
  'Hong Kong': 'hk',
  'Shanghai & Shenzhen': 'cn',
};

/** Connect 行标签: 需被**识别**(以便残留物校验不误报) 但**不取值**。 */
const IGNORED_ROW_LABELS = ['Northbound Trading', 'Southbound Trading'];

const ALL_ROW_LABELS = [...Object.keys(MARKET_ROW_LABELS), ...IGNORED_ROW_LABELS];

/** 规约 2/3 —— 单元格状态词。`Half Day` 必须排在 `Holiday` 前 (交替匹配取先命中者)。 */
const STATUS_RE = /Half Day|Holiday|Closed/g;

/** 🚨 规约 3 —— **唯一**表示休市的状态词。`Half Day` 是交易日; `Closed` 只出现在 Connect 行。 */
const CLOSED_STATUS = 'Holiday';

/**
 * 半日市状态词 (063 Phase 2)。**它一直被解析出来, 只是此前在输出那一步被折叠掉了** ——
 * 规约 3 只用它答「是不是交易日」(是), 于是「这天几点收盘」这个事实被丢在半路。
 *
 * 消费方是 `session_kind` 三态: 有了它, 半日市当天的收盘时刻才表达得出来 (否则常量说 16:00,
 * 而 hk 那天 12:00 就收了 —— 偏差方向安全但当天建锚会误判 `intraday_skipped`)。
 */
const HALF_DAY_STATUS = 'Half Day';

export interface StaticCalendar {
  cn: string[];
  hk: string[];
  /**
   * market → 该年**半日市**日期 (`YYYY-MM-DD` 升序)，是 `cn` / `hk` 的**子集**。
   *
   * 🚨 **「不在本表」= whole, 不是 unknown** —— 仅在静态层**自己的覆盖区间内**如此: 官方年历
   * 对区间内每一天都表了态 (空白 / `Half Day` / `Holiday`), 故这里的补集是**有据的 whole**,
   * 不是「库里没有的即为假」。区间外由 adapter 的 Guardrail 7 直接 throw, 够不到这个推断。
   */
  halfDays: Record<'cn' | 'hk', string[]>;
  /**
   * PDF 列出的**全部工作日** (`YYYY-MM-DD` 升序) —— 完整性锚, 非交易日历。
   *
   * ⚠️ 必须独立于 cn/hk 统计: **两市场同日皆休市**时 (如元旦 / 春节 2026-02-17..19) 该日
   * **不在 cn 也不在 hk**, 故「cn ∪ hk」**恒少于**全年工作日数 (2026 实测 253 vs 261),
   * 拿它当完整性锚会误报。此字段是解析产物 (供 `assertFullYearCoverage`), **不入产物数据文件**。
   */
  weekdays: string[];
}

interface Span {
  text: string;
  /** 字符中心位 —— 列对齐的锚 (规约 5)。 */
  center: number;
}

function spansOf(line: string, re: RegExp): Span[] {
  const out: Span[] = [];
  const r = new RegExp(re.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(line)) !== null) {
    out.push({ text: m[0], center: m.index + m[0].length / 2 });
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 🚨 规约 5 —— **列位对齐**: 把一行状态词按字符中心位归到日号列。
 *
 * 朴素「最近中心」**不够**: `-layout` 渲染下窄词 (`Closed` 6 字符) 比宽词 (`Holiday` 7 字符)
 * 排得更紧, 逐列累积左漂 → 实测 Feb Connect 行两个词双双抢到同一日号 (2026 PDF 实证)。
 * 由于**日号列与状态词均严格升序、且状态词只能落在日号的递增子序列上**, 改用**单调贪心**
 * (每个词只能落在上一个词之后的列) → 全年 12 块 × 4 行 **0 冲突** (实证)。
 *
 * 复杂度 O(D × T) —— D = 月内工作日数 (≤ 23), T = 行内状态词数 (≤ D); 单月常数级。
 */
function assignByColumn(days: Span[], tokens: Span[], ctx: string): Map<string, string> {
  const assigned = new Map<string, string>();
  let lowerBound = 0;
  for (const token of tokens) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = lowerBound; i < days.length; i++) {
      const dist = Math.abs(days[i].center - token.center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      throw new Error(`[gen-static-calendar] ${ctx}: 状态词多于日号列 (无法解析, PDF 结构已变?)`);
    }
    assigned.set(days[bestIdx].text, token.text);
    lowerBound = bestIdx + 1;
  }
  return assigned;
}

/**
 * 校验行内除「标签 + 已识别状态词」外无残留可见字符 —— PDF 若新增状态词 (如 `Typhoon`),
 * 静默忽略会把休市日当成开市日 (**无声毒饵**)。**响亮 throw** 才符合本 feature 立意。
 */
function assertNoUnknownTokens(rest: string, tokens: Span[], ctx: string): void {
  let residue = rest;
  for (const t of tokens) {
    residue = residue.replace(t.text, ' '.repeat(t.text.length));
  }
  if (/\S/.test(residue)) {
    throw new Error(
      `[gen-static-calendar] ${ctx}: 未知状态词 ${JSON.stringify(residue.trim())} ` +
        `(PDF 结构已变 → 拒绝静默当成开市)`,
    );
  }
}

/**
 * `pdftotext -layout` 文本 → { cn, hk } 交易日集 (`YYYY-MM-DD` 升序)。
 *
 * **纯函数** —— 可用真实文本片段 (单月/多月块) 直接单测。整年完整性校验属 CLI 侧
 * (`assertFullYearCoverage`), 不在此处, 以便 fixture 用局部块。
 *
 * 复杂度 O(L + M × D × T) —— L = 行数, M = 月块数 (≤ 12)。
 */
export function parseHkexCalendarText(text: string, year: number): StaticCalendar {
  const lines = text.split('\n');
  const trading: Record<'cn' | 'hk', Set<string>> = { cn: new Set(), hk: new Set() };
  const halfDays: Record<'cn' | 'hk', Set<string>> = { cn: new Set(), hk: new Set() };
  const weekdays = new Set<string>();
  const monthBlockRe = new RegExp(`^(\\s{2,})(${MONTH_NAMES.join('|')})\\s{2,}\\d`);

  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = monthBlockRe.exec(lines[i]);
    if (!head) continue;
    blocks++;
    const month = MONTH_NAMES.indexOf(head[2] as (typeof MONTH_NAMES)[number]) + 1;
    const ctx = `${year}-${pad2(month)}`;

    // 规约 1 —— 日号行只列工作日; 月名无数字 ⇒ 全行取 `\d+` 即日号列。
    const days = spansOf(lines[i], /\d+/);
    const dows = spansOf(lines[i + 1] ?? '', /[A-Z][a-z]{2}/);
    if (dows.length !== days.length) {
      throw new Error(
        `[gen-static-calendar] ${ctx}: 星期行列数 ${dows.length} ≠ 日号行列数 ${days.length}`,
      );
    }

    // ★ **星期交叉校验** —— 用真实日历独立验证「月份 + 日号」解析正确 (标签只在正确年份下全中)。
    // 顺带兜住「年份传错 / 月块错位 / 日号漏列」三类漂移, 且**零成本**。
    for (let k = 0; k < days.length; k++) {
      const real = DOW_NAMES[new Date(Date.UTC(year, month - 1, Number(days[k].text))).getUTCDay()];
      if (real !== dows[k].text) {
        throw new Error(
          `[gen-static-calendar] ${ctx}-${pad2(Number(days[k].text))}: 星期不符 ` +
            `(PDF 标 ${dows[k].text}, ${year} 年实为 ${real}) —— 年份传错或 PDF 结构已变`,
        );
      }
      weekdays.add(`${ctx}-${pad2(Number(days[k].text))}`);
    }

    // 每块紧随 4 行市场/通道行。
    for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
      const label = ALL_ROW_LABELS.find((l) =>
        lines[j].startsWith(l, lines[j].length - lines[j].trimStart().length),
      );
      if (!label) continue;
      const rest = lines[j].slice(lines[j].indexOf(label) + label.length);
      const tokens = spansOf(rest, STATUS_RE).map((s) => ({
        ...s,
        center: s.center + lines[j].indexOf(label) + label.length,
      }));
      assertNoUnknownTokens(rest, tokens, `${ctx} ${label}`);

      // 🚨 规约 4 —— Connect 行到此为止: 只做残留物校验, **不取值**。
      const market = MARKET_ROW_LABELS[label];
      if (!market) continue;

      const statuses = assignByColumn(days, tokens, `${ctx} ${label}`);
      for (const day of days) {
        // 规约 2/3 —— 空白 + `Half Day` 皆为交易日; 仅 `Holiday` 休市。
        const status = statuses.get(day.text);
        if (status === CLOSED_STATUS) continue;
        const date = `${ctx}-${pad2(Number(day.text))}`;
        trading[market].add(date);
        // 063 Phase 2: 交易日**之上**再记「这天是不是只开半天」—— 不改变它算不算交易日。
        if (status === HALF_DAY_STATUS) halfDays[market].add(date);
      }
    }
  }

  if (blocks === 0) {
    throw new Error(
      '[gen-static-calendar] 未解析到任何月块 (PDF 结构已变? 检查 pdftotext -layout)',
    );
  }
  return {
    cn: [...trading.cn].sort(),
    hk: [...trading.hk].sort(),
    halfDays: { cn: [...halfDays.cn].sort(), hk: [...halfDays.hk].sort() },
    weekdays: [...weekdays].sort(),
  };
}

/** 该年工作日 (Mon–Fri) 总数 —— PDF 应逐个列出, 用作完整性下界锚。 */
function weekdayCountOf(year: number): number {
  let n = 0;
  for (
    let d = new Date(Date.UTC(year, 0, 1));
    d.getUTCFullYear() === year;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/**
 * 整年完整性闸 (CLI 侧) —— 年更漏页 / PDF 只抽到一半 → **响亮失败**, 别产出半份日历。
 * 半份静态表 = 缺失日被当成非交易日 = 第二个 push2delay。
 */
export function assertFullYearCoverage(cal: StaticCalendar, year: number): void {
  const months = new Set(cal.weekdays.map((d) => d.slice(0, 7)));
  if (months.size !== 12) {
    throw new Error(
      `[gen-static-calendar] ${year} 年仅解析到 ${months.size} 个月 (须 12) —— PDF 抽取不完整`,
    );
  }
  // PDF 逐个列出全年工作日 ⇒ 解析到的日号列数须与真实工作日数**精确相等** (多一天/少一天都是
  // 结构漂移)。锚用 `weekdays` 而非「cn ∪ hk」—— 见 `StaticCalendar.weekdays` 注释。
  const expected = weekdayCountOf(year);
  if (cal.weekdays.length !== expected) {
    throw new Error(
      `[gen-static-calendar] ${year} 年解析到 ${cal.weekdays.length} 个工作日 ≠ 应有 ${expected} —— 日号列有漏`,
    );
  }
}

function renderDataFile(cal: StaticCalendar, year: number): string {
  // 空列表必须渲成 `[]` 单行: 留一行空白会被 prettier 改掉, 而产物标着「请勿手改」——
  // 那就成了每次重跑都 diff 的假变更 (cn 全年零半日市, 天然会走到这个分支)。
  const list = (dates: string[]): string => dates.map((d) => `    '${d}',`).join('\n');
  const block = (dates: string[]): string =>
    dates.length === 0 ? '[],' : `[\n${list(dates)}\n  ],`;
  return `// 🤖 GENERATED by \`scripts/checks/gen-static-calendar.ts\` —— **请勿手改**。
// 源: HKEX 官方 Stock Connect 年历 PDF (${year}) → \`pdftotext -layout\` → 解析。
// 年更方式见该脚本头注释 + \`ops/runbook/scheduled-tasks.md\`。
//
// 🚨 **不含 us** —— 044 当时的理由 (无 \`{us}\`-only 维度) 已于 2026-07-31 失效, 但**结论未变**:
// us 改由 \`[富途 L1, 腾讯 L2]\` 两活源承担, 蓄意不补静态层 (取舍论证见
// \`static-calendar.adapter.ts\` 的绊线段, 别在这里下判断)。

/** 静态表覆盖的**闭区间** —— 请求区间须被其**完全包含**, 否则 L2 必须 throw (禁返部分)。 */
export const STATIC_CALENDAR_COVERAGE = {
  from: '${year}-01-01',
  to: '${year}-12-31',
} as const;

/** market → 该市场 ${year} 年交易日 (\`YYYY-MM-DD\` 升序)。\`Half Day\` 已计为交易日。 */
export const STATIC_CALENDAR_DATES: Readonly<Record<string, readonly string[]>> = {
  cn: [
${list(cal.cn)}
  ],
  hk: [
${list(cal.hk)}
  ],
};

/**
 * market → 该市场 ${year} 年**半日市**日期 (\`YYYY-MM-DD\` 升序)，是 {@link STATIC_CALENDAR_DATES}
 * 的**子集** (063 Phase 2)。
 *
 * 🚨 **覆盖区间内「不在本表」= whole, 不是 unknown**: 官方年历对区间内每个工作日都表了态
 * (空白 / \`Half Day\` / \`Holiday\`), 故补集是**有据的 whole**。区间外由 adapter 的
 * Guardrail 7 直接 throw, 够不到这个推断。
 */
export const STATIC_CALENDAR_HALF_DAYS: Readonly<Record<string, readonly string[]>> = {
  cn: ${block(cal.halfDays.cn)}
  hk: ${block(cal.halfDays.hk)}
};
`;
}

function mainCli(): void {
  const args = process.argv.slice(2);
  const argOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const year = Number(argOf('--year'));
  const input = argOf('--in');
  if (!Number.isInteger(year) || !input) {
    throw new Error('用法: gen-static-calendar.ts --year <YYYY> --in <pdftotext -layout 输出.txt>');
  }

  const cal = parseHkexCalendarText(readFileSync(resolve(input), 'utf8'), year);
  assertFullYearCoverage(cal, year);
  writeFileSync(OUT_PATH, renderDataFile(cal, year), 'utf8');
  console.log(
    `[gen-static-calendar] ${year}: cn ${cal.cn.length} 交易日 / hk ${cal.hk.length} 交易日 → ${OUT_PATH}`,
  );
}

const isDirectExec = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectExec) {
  try {
    mainCli();
  } catch (err) {
    console.error(`[gen-static-calendar] 失败: ${(err as Error).message}`);
    process.exit(1);
  }
}
