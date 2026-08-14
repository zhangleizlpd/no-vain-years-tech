import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { daysToExpiry, marketDateFor } from '../marketdata/trading-day-gate';
import { parseAnchorTicker } from './anchor.rules';
import { recallCandidates, type RecallContext } from './leg-recall.rules';
import type {
  LegChainRow,
  LegRetrievalPort,
  LegRetrievalQuery,
  LegRetrievalResult,
} from './leg-retrieval.port';

/**
 * 052 检索 port 的 **Prisma 实现** (plan D-PORT-1) —— 整块承接 050 `get-legs.usecase.ts` 里的
 * `readChain`: 三张 marketdata 表的只读直查 + 逐腿 DTE + 召回判据。
 *
 * 🚨 **跨 ctx 只读直查** (catalog Q7-B / ADR-0043 §5): 每处 `prisma.<他 ctx 表>.find*` 上方
 * MUST 带 `// CROSS-CONTEXT-READ:` (`check-server-moat.ts` 机器强制); 跨 ctx **写**永远禁,
 * 零 `@Inject()` marketdata 的 use case (Q7-C)。**MUST NOT import `marketdata/*.rules.ts`**
 * (ADR-0053, ESLint `boundaries` 是绊线): spot 直接取快照行里 vendor 给的标的价, 不走复权换算。
 *
 * 🚨 **判据一条都不在本文件里** —— 成员判定全部经 `leg-recall.rules.ts` 的层入口
 * {@link recallCandidates}。假实现共用同一个入口, 于是「换实现 ⇒ 判据不变」是结构保证而非约定;
 * 反过来说, 在这里补一条 `filter` 就等于给召回开了第二个判据点, 而它**不会红**。
 *
 * 复杂度: 3 次跨 ctx 查询 (合约集 / 最近一期 / 该期全量) + `O(n)` 逐腿判据 (n = 该票当日快照
 * 行数, 实测上界 730)。DTE 按到期日缓存 —— 合约数百行但到期日只有几十个。
 * 📌 **有覆盖时多一趟 `O(n)` 纯 CPU 判定** (053 FR-009 的 `memberCount`): 查询次数不变。
 */
@Injectable()
export class PrismaLegRetrievalAdapter implements LegRetrievalPort {
  constructor(private readonly prisma: PrismaService) {}

  async retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
    const parsed = parseAnchorTicker(query.symbol);
    if (parsed === null) return null;
    const marketDate = marketDateFor(['us'], query.now);

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的 id
    // 寻址, 读法同 `get-underlying-detail.usecase.ts`。零写、零 @Inject() 对方 use case (Q7-C)。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) return null;

    // CROSS-CONTEXT-READ: marketdata.option_contract 只读直查 (Q7-B) —— 该标的的**适格**认沽
    // 合约集。两个过滤都在 SQL 端: `is_standard` (047 FR-008 非标不进选约表, 但采集侧照常落库
    // FR-033) + 到期日 **>** 当日 (047 FR-028a 已到期腿不可交易; 🚨 与完整性分母的 `≥` 故意
    // 不同, 047 Guardrail 7)。本片呈现面只含认沽, 采集侧的 CALL 照常在库里。
    const contracts = await this.prisma.optionContract.findMany({
      where: {
        underlyingInstrumentId: instrument.id,
        optionType: 'PUT',
        isStandard: true,
        expiryDate: { gt: utcMidnight(marketDate) },
      },
      select: { id: true, code: true, expiryDate: true, strikePrice: true },
    });
    if (contracts.length === 0) return null;

    const contractIds = contracts.map((c) => c.id);
    // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 先定位最近一期
    // 交易日, 再整批取该期。两步而非一次拉全史: 本表是全库增长最快的表 (约 6.4M 行/年)。
    const latest = await this.prisma.optionDailySnapshot.findFirst({
      where: { contractId: { in: contractIds } },
      orderBy: { sessionDate: 'desc' },
      select: { sessionDate: true },
    });
    if (latest === null) return null;

    // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 该期全部行。
    // 幂等键第三段是**来源** (047 FR-040) ⇒ 同一合约同一交易日可能有 eod 与 premarket_backfill
    // 两行, 按 `quote_as_of` 取新的那条 (下面 dedupe)。
    const snapshots = await this.prisma.optionDailySnapshot.findMany({
      where: { contractId: { in: contractIds }, sessionDate: latest.sessionDate },
    });
    const freshest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      const key = snapshot.contractId.toString();
      const kept = freshest.get(key);
      if (kept === undefined || snapshot.quoteAsOf.getTime() > kept.quoteAsOf.getTime()) {
        freshest.set(key, snapshot);
      }
    }
    if (freshest.size === 0) return null;

    const rows: { contract: (typeof contracts)[number]; snapshot: (typeof snapshots)[number] }[] =
      [];
    for (const contract of contracts) {
      const snapshot = freshest.get(contract.id.toString());
      if (snapshot !== undefined) rows.push({ contract, snapshot });
    }
    // 标的价缺失 = 这批快照本身有问题 ⇒ 显式「未就绪」。🚫 蓄意**不**拿锚表的 last_close 顶上:
    // 那会让「链坏了」看起来像正常, 正是本仓反复吃亏的那类静默。
    const spot = rows.map((r) => r.snapshot.underlyingSpot).find((v) => v !== null) ?? null;
    if (rows.length === 0 || spot === null) return null;

    const newest = rows.reduce((a, b) =>
      b.snapshot.quoteAsOf.getTime() > a.snapshot.quoteAsOf.getTime() ? b : a,
    ).snapshot;

    // DTE 按到期日缓存: 合约数百行、到期日只有几十个 ⇒ `daysToExpiry` 每个日期算一次。
    const dteByExpiry = new Map<string, number>();
    const legs: LegChainRow[] = rows.map(({ contract, snapshot }) => {
      const key = contract.expiryDate.toISOString().slice(0, 10);
      let dteDays = dteByExpiry.get(key);
      if (dteDays === undefined) {
        dteDays = daysToExpiry({ expiry: contract.expiryDate, now: query.now });
        dteByExpiry.set(key, dteDays);
      }
      return {
        code: contract.code,
        expiryDate: contract.expiryDate,
        dteDays,
        strike: contract.strikePrice,
        bid: snapshot.bid,
        ask: snapshot.ask,
        bidSize: numberOf(snapshot.bidSize),
        askSize: numberOf(snapshot.askSize),
        delta: numberOf(snapshot.delta),
        openInterest: numberOf(snapshot.openInterest),
        volume: numberOf(snapshot.volume),
        greeksComplete: snapshot.greeksComplete,
      };
    });

    const context: RecallContext = { spot };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      legs,
      query.candidateCap,
      query.override,
    );
    return {
      chain: {
        marketDate,
        sessionDate: latest.sessionDate,
        quoteAsOf: newest.quoteAsOf,
        oiAsOf: newest.oiAsOf,
        source: newest.source,
        spot,
      },
      ...outcome,
      // 053 FR-009: 无覆盖口径的成员数 —— 对**同一批已在内存的 `legs`** 再判一次, 零额外 DB
      // 往返 (上面三次查询与它无关)。语义与三条禁忌见 `LegRetrievalResult.memberCount`。
      memberCount:
        query.override === null
          ? outcome.candidates.length
          : recallCandidates(context, query.perspectives, legs, query.candidateCap).candidates
              .length,
    };
  }
}

/** 计数列与 Δ → number (张数与无量纲希腊值, 没有精度可丢; 金额列不走这里)。 */
function numberOf(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
