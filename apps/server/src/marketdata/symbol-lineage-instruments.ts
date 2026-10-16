import type { PrismaService } from '../security/prisma.service.js';
import { symbolChangeDateFromDb, symbolChangeDateToDb } from './register-symbol-change.usecase.js';
import { resolveLineage, type LineageSegment } from './symbol-lineage.rules.js';

/** lineage 一段落到标的行上: `[from, toExclusive)` 同 {@link LineageSegment}, 日期 = 交易所当地日。 */
export interface LineageInstrumentSegment extends LineageSegment {
  instrumentId: bigint;
}

/**
 * 读时拼接的共享入口 (086 T005 / T006, plan D3 / D4): 读该市场**未撤销**登记 →
 * `resolveLineage` → 每段码解析 instrument 行, 标的表里没有的段**跳过**。返回按日期升序。
 *
 * 无登记 ⇒ 单段、两侧不设界, 调用方据此走与改动前逐条一致的查询 (FR-007)。
 * 两次查询 (登记 + 标的行), 与链长无关; rules 侧复杂度见 `symbol-lineage.rules.ts`。
 */
export async function resolveLineageInstruments(
  prisma: PrismaService,
  market: string,
  code: string,
): Promise<LineageInstrumentSegment[]> {
  const regs = await prisma.symbolChange.findMany({
    where: { market, revokedAt: null },
    select: { market: true, oldCode: true, newCode: true, effectiveDate: true, eventType: true },
  });
  const segments = resolveLineage(
    regs.map((r) => ({ ...r, effectiveDate: symbolChangeDateFromDb(r.effectiveDate) })),
    market,
    code,
  );
  const rows = await prisma.instrument.findMany({
    where: { market, code: { in: [...new Set(segments.map((s) => s.code))] } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(rows.map((r) => [r.code, r.id]));
  return segments.flatMap((s) => {
    const instrumentId = idByCode.get(s.code);
    return instrumentId === undefined ? [] : [{ ...s, instrumentId }];
  });
}

/**
 * 段区间 `[from, toExclusive)` → Prisma 日期过滤片段 (`@db.Date` 列)。两侧都不设界 ⇒ `undefined`,
 * 调用方据此省掉该条件, 与改动前的查询形状一致。
 */
export function segmentDateRange(seg: LineageSegment): { gte?: Date; lt?: Date } | undefined {
  if (seg.from === null && seg.toExclusive === null) return undefined;
  return {
    ...(seg.from !== null ? { gte: symbolChangeDateToDb(seg.from) } : {}),
    ...(seg.toExclusive !== null ? { lt: symbolChangeDateToDb(seg.toExclusive) } : {}),
  };
}
