/**
 * 代码变更的**连续身份规则** (086 T002, plan D2; FR-002 / FR-005 / FR-008)。纯函数、零 I/O、
 * 无 DI (ADR-0043 §4)。消费方: 登记 use case 的入库前校验、日线读时拼接 (get-instrument-bars)。
 *
 * 日期一律 `'YYYY-MM-DD'` 字符串, 语义 = **交易所当地日历日**, 与 `daily_bar.trade_date` 同一条轴
 * (ADR-0066); 字典序即时间序, 本文件不做任何时区换算。「今天」由调用方用
 * `exchangeCalendarDate(market, now)` (session-clock.ts) 算好传入。
 *
 * 入参的登记数组须**已过滤撤销** (撤销 = 从未登记, FR-003); 他市场的登记在函数内被忽略。
 *
 * 复杂度: 登记总数 n 很小 (年个位数), 不建索引结构 ——
 * - {@link resolveLineage}: 回溯每一步对 n 条线性扫一次, O(链长 × n);
 * - {@link validateRegistration}: 各项检查 O(n), 成环检查对同日子图 DFS, O(n²) 上界。
 */

/** 事件类型值域。v1 只有改名 / 存续延续; 分拆 / 退市不可登记 (branch 11)。 */
export const SYMBOL_CHANGE_EVENT_TYPE = { RENAME: 'rename' } as const;

/** 登记来源值域 (`symbol_change.source`)。 */
export const SYMBOL_CHANGE_SOURCE = { MANUAL: 'manual', CANDIDATE: 'candidate' } as const;

export interface SymbolChangeRegistration {
  market: string;
  oldCode: string;
  newCode: string;
  /** 交易所当地日历日 `'YYYY-MM-DD'`。 */
  effectiveDate: string;
  eventType: string;
}

/** 连续身份的一段: `[from, toExclusive)`, `null` = 该侧不设界。 */
export interface LineageSegment {
  code: string;
  from: string | null;
  toExclusive: string | null;
}

export type SymbolChangeRejectReason =
  | 'unsupported_event_type'
  | 'same_code'
  | 'future_effective_date'
  | 'duplicate'
  | 'cycle'
  | 'overlap';

export type RegistrationVerdict =
  | { ok: true }
  | { ok: false; reason: SymbolChangeRejectReason; message: string };

/**
 * 某码在 `before` (不含; `null` = 不设上界) 之前**最近一次**涉及它的登记日 —— 作新码 (改入)
 * 或作旧码 (改走) 都算。作旧码那一半就是**回收防误拼下界**: 码被改走之后再出现的数据属于
 * 回收它的那家, 段起点不得早于改走日 (branch 4、5)。O(n)。
 */
function latestEventBefore(
  regs: readonly SymbolChangeRegistration[],
  code: string,
  before: string | null,
): string | null {
  let latest: string | null = null;
  for (const r of regs) {
    if (r.oldCode !== code && r.newCode !== code) continue;
    if (before !== null && !(r.effectiveDate < before)) continue;
    if (latest === null || r.effectiveDate > latest) latest = r.effectiveDate;
  }
  return latest;
}

/**
 * 查询码的连续身份, 按日期升序的段列表。
 *
 * 1. 末段 = 查询码自身, 起点 = 它最近一次被改入或改走的日期 (都没有 ⇒ 不设下界)。
 * 2. 若起点恰是一条「改入本码」的登记日, 前接该登记旧码的一段 (止于起点), 再以同样规则求
 *    那一段的起点 (只看严格早于本段起点的登记); 起点来自「改走」或没有起点 ⇒ 停止。
 *
 * 链式 A → B → C 自然成立 (branch 6); 新码生效日前的自有数据因段起点 = 生效日被排除
 * (branch 7)。每步 `before` 严格递减 ⇒ 必然终止, 改回原码 A → B → A 不会死循环。
 * 复杂度 O(链长 × n)。
 */
export function resolveLineage(
  registrations: readonly SymbolChangeRegistration[],
  market: string,
  code: string,
): LineageSegment[] {
  const regs = registrations.filter((r) => r.market === market);
  const segments: LineageSegment[] = [];
  let current = code;
  let toExclusive: string | null = null;
  for (;;) {
    const from = latestEventBefore(regs, current, toExclusive);
    segments.unshift({ code: current, from, toExclusive });
    if (from === null) break;
    const predecessor = regs.find((r) => r.newCode === current && r.effectiveDate === from);
    if (!predecessor) break;
    current = predecessor.oldCode;
    toExclusive = from;
  }
  return segments;
}

/** 同一生效日内, 从 `start` 沿「旧码 → 新码」边能否走到 `target`。DFS, O(n²) 上界。 */
function reachableSameDay(
  regs: readonly SymbolChangeRegistration[],
  date: string,
  start: string,
  target: string,
): boolean {
  const edges = regs.filter((r) => r.effectiveDate === date);
  const seen = new Set<string>();
  const stack = [start];
  for (let code = stack.pop(); code !== undefined; code = stack.pop()) {
    if (code === target) return true;
    if (seen.has(code)) continue;
    seen.add(code);
    for (const e of edges) if (e.oldCode === code) stack.push(e.newCode);
  }
  return false;
}

/**
 * 某码的时间线上是否出现「连续两次改入、中间没有改走」—— 即同一个码同时被两条已登记的身份
 * 占用, 区间重叠。同日的改走排在改入之前 (同日交接合法)。连续两次改走合法: 改走后到下次
 * 改走之间是回收它的那家, 不属于任何已登记身份。O(n log n)。
 */
function hasOverlappingArrivals(regs: readonly SymbolChangeRegistration[], code: string): boolean {
  const events: { date: string; arrive: boolean }[] = [];
  for (const r of regs) {
    if (r.oldCode === code) events.push({ date: r.effectiveDate, arrive: false });
    if (r.newCode === code) events.push({ date: r.effectiveDate, arrive: true });
  }
  events.sort((a, b) =>
    a.date === b.date ? Number(a.arrive) - Number(b.arrive) : a.date < b.date ? -1 : 1,
  );
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1].arrive && events[i].arrive) return true;
  }
  return false;
}

const reject = (reason: SymbolChangeRejectReason, message: string): RegistrationVerdict => ({
  ok: false,
  reason,
  message,
});

/**
 * 入库前校验一条候选登记 (FR-002 / FR-008)。`existing` = 同库未撤销登记 (他市场的被忽略);
 * `today` = 该市场交易所当地今天。跨市场登记在类型上不可表达 (旧码 / 新码共用一个 market)。
 *
 * 成环只指**同一生效日**内的环 (A → B 与 B → A 同日): 不同日期的改回原码 A → B → A 是合法
 * 历史, 由 {@link resolveLineage} 按日期切段。复杂度见文件头。
 */
export function validateRegistration(
  existing: readonly SymbolChangeRegistration[],
  candidate: SymbolChangeRegistration,
  today: string,
): RegistrationVerdict {
  const { market, oldCode, newCode, effectiveDate, eventType } = candidate;
  if (eventType !== SYMBOL_CHANGE_EVENT_TYPE.RENAME) {
    return reject(
      'unsupported_event_type',
      `只能登记改名 (rename), 收到 ${eventType}; 分拆 / 退市不是存续延续, 不拼接`,
    );
  }
  if (oldCode === newCode) {
    return reject('same_code', `旧码与新码相同 (${oldCode})`);
  }
  if (effectiveDate > today) {
    return reject(
      'future_effective_date',
      `生效日 ${effectiveDate} 晚于 ${market} 交易所当地今天 ${today}`,
    );
  }
  const regs = existing.filter((r) => r.market === market);
  const duplicate = regs.find((r) => r.oldCode === oldCode && r.effectiveDate === effectiveDate);
  if (duplicate) {
    return reject(
      'duplicate',
      `已存在 ${market} ${oldCode} @ ${effectiveDate} 的登记 (→ ${duplicate.newCode})`,
    );
  }
  if (reachableSameDay(regs, effectiveDate, newCode, oldCode)) {
    return reject('cycle', `${effectiveDate} 当日的登记会与 ${oldCode} → ${newCode} 构成环`);
  }
  const merged = [...regs, candidate];
  for (const code of [oldCode, newCode]) {
    if (hasOverlappingArrivals(merged, code)) {
      return reject('overlap', `${code} 会同时属于两条已登记的身份 (区间重叠)`);
    }
  }
  return { ok: true };
}
