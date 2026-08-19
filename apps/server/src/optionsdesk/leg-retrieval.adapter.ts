import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import { daysToExpiry } from '../marketdata/trading-day-gate';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotPort,
} from '../marketdata/option-snapshot.port';
import { parseAnchorTicker } from './anchor.rules';
import { recallCandidates, type RecallContext } from './leg-recall.rules';
import type {
  LegChainMeta,
  LegChainQuery,
  LegChainRow,
  LegChainSnapshot,
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
 * 🚨 **064 起本文件多一件事: 盘中实时报价的尾部覆盖** (plan D6)。插点是 {@link loadChain} 的
 * **尾部** —— 组装 `legs` 之后、`return` 之前。理由与 055 抽出 `loadChain` 的理由是同一条: 它是
 * `retrieveCandidates` 与 `retrieveChain` 的**共同根**, 插在这里两个 port 方法自动读到同一批行、
 * 同一个报价时刻 (064 FR-017 由此是**结构保证**而非纪律)。
 * 🚫 **MUST NOT 挪到 `recallCandidates` 之后再插一层** —— 那时候选集已经按收盘值筛过一轮,
 * 「按此刻的口径召回」这句话当场不成立, 而候选表照样渲染得出来。
 * 🚫 **MUST NOT 在 Prisma 事务里等这次外呼** (split-tx 心智): 本方法根本不开事务, 保持如此。
 *
 * 复杂度: 3 次跨 ctx 查询 (合约集 / 最近一期 / 该期全量) + `O(n)` 逐腿判据 (n = 该票当日快照
 * 行数, 实测上界 730)。DTE 按到期日缓存 —— 合约数百行但到期日只有几十个。
 * 📌 **有覆盖时多一趟 `O(n)` 纯 CPU 判定** (053 FR-009 的 `memberCount`): 查询次数不变。
 * 📌 **实时档多一次外呼 + 一趟 `O(n)` 覆盖**: 查询次数不变, 外呼次数每请求恒 1 (064 SC-003)。
 */
@Injectable()
export class PrismaLegRetrievalAdapter implements LegRetrievalPort {
  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的期权快照**读取口** (port token + interface, 非
    // use case —— catalog Q7-C 的放行判据见 064 plan D1)。强一致同步读: 这一屏要的就是**此刻**
    // 的盘口, 落表已来不及, 且本片零落库 (064 FR-019)。方向仍单向: marketdata 对本 ctx 零感知。
    // 🚨 **可空**: 解析不到 (或本次未开实时) 时行为与 064 之前**逐字节相同** —— 关态是默认态
    // (FR-016), 🚫 MUST NOT 让它变成一条「没配就报错」的硬依赖。
    // 🚫 **MUST NOT 换成采集口 `OPTION_SNAPSHOT_PORT`**: 那个 token 的意图是「产出必然被持久
    // 化」(054 逐 port 核过 consumer, 全是写手), 读路径复用它会让那条结构性保证当场变成假话。
    @Optional()
    @Inject(OPTION_SNAPSHOT_READ_PORT)
    private readonly snapshots: OptionSnapshotPort | null = null,
  ) {}

  async retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
    const snapshot = await this.loadChain(query);
    if (snapshot === null) return null;
    const { chain, legs } = snapshot;

    const context: RecallContext = { spot: chain.spot };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      legs,
      query.candidateCap,
      query.override,
    );
    return {
      chain,
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

  /**
   * 055 T005 —— 整条链, **不进召回**。查询与 {@link retrieveCandidates} 完全同一批
   * ({@link loadChain} 单点), 差别只在这里不把结果喂进 `recallCandidates`。
   */
  retrieveChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
    return this.loadChain(query);
  }

  /**
   * 三张 marketdata 表的只读直查 + 逐腿 DTE —— **两个 port 方法的共同根**。
   *
   * 🚨 抽出来是为了让「候选集与整条链读的是同一批行」成为结构保证: 各查一份的话, 两边照样都
   * 查得出数据, 只是可能落在不同的快照期上 —— 而那时报表的骨架与选约表的候选集会对不上, 且
   * 界面上一切正常。
   */
  private async loadChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
    // 064 T003: `query.realtime` 是**每次请求**的显式开关 (`FR-015` fail-closed, 无默认值)。
    // 本 task 只把开关与档位字段立起来, 两个读端一律传 `false` ⇒ 走到这里恒是收盘档;
    // 尾部 overlay 与真正的分支实装在 T004a。
    const parsed = parseAnchorTicker(query.symbol);
    if (parsed === null) return null;
    const marketDate = exchangeCalendarDate('us', query.now);

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
      // `expirationCycle` 是月度链标的判据输入 (#45) —— **同一次查询多带一列**, 零额外往返。
      select: { id: true, code: true, expiryDate: true, strikePrice: true, expirationCycle: true },
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
        // 🚫 原样带出, 不换算 —— 见 `LegChainRow.iv`。
        iv: numberOf(snapshot.iv),
        openInterest: numberOf(snapshot.openInterest),
        volume: numberOf(snapshot.volume),
        greeksComplete: snapshot.greeksComplete,
        // 🚫 vendor 原样带出, 不归一化大小写、不回落默认值 —— 判据是白名单 `=== 'MONTH'`,
        // 在这里「顺手」规整会让「vendor 换了取值」这件事在打标层看不出来 (`leg-mark.rules.ts`)。
        expirationCycle: contract.expirationCycle,
        // 064 T003: 库里读出来的就是收盘档 —— 这里是**唯一**的落点, 实时档由本方法尾部的
        // overlay 逐行改写 (T004a)。🚫 MUST NOT 在下游任何一层「补标」: 补标点有第二个,
        // 「这个数是什么时候的」就有两个答案, 而两个答案都渲染得出来。
        priceKind: 'eod_close',
      };
    });

    const chain: LegChainMeta = {
      marketDate,
      sessionDate: latest.sessionDate,
      quoteAsOf: newest.quoteAsOf,
      oiAsOf: newest.oiAsOf,
      source: newest.source,
      spot,
      priceKind: 'eod_close',
    };
    // 🚨 **overlay 的插点就在这里** —— `legs` 已组装、`return` 之前, 见类文件头。关态 (或读取口
    // 未绑定) 时**一行都不执行**, 结果与 064 之前逐字节相同 (FR-016 / SC-005)。
    if (!query.realtime || this.snapshots === null) return { chain, legs };
    return this.overlayRealtimeQuotes(this.snapshots, query.symbol, chain, legs);
  }

  /**
   * 用**此刻**的报价覆盖库内收盘档 —— 恰好七列 (064 FR-001 / FR-002)。
   *
   * 🚨 **写入面只有这七列**: `bid` / `ask` / `bidSize` / `askSize` / `delta` / `iv` / `volume`。
   * 派生量 (成交额 / 单笔权利金 / 价差及其相对值) 由下游从这七列现算 ⇒ 自动成为实时口径,
   * 🚫 MUST NOT 为它们另设覆盖路径 (FR-003: 派生量有第二个来源就等于同一个数在两处各算一份)。
   * 🚨 **持仓量三列 (`openInterest` / `netOpenInterest` / `oiAsOf`) 的保留是结构性的**
   * (FR-004 / plan D8): 前者不在下面的字面量里、后两者根本不在 {@link LegChainRow} 上 ——
   * 🚫 MUST NOT 为了「对称」把它们纳入再跳过, 那把编译期保证降级成一条注释。依据是实测:
   * 美股期权 OI 盘前更新、盘中冻结 ⇒ 此刻取回的与库内是同一个数。
   * 🚨 **不自己解信封**: 经读取口拿已解析好的 `OptionSnapshotBatch` (信封单点已由 PR #116 收口)。
   * 若发现自己在写第二处 `res?.rows` / `as_of` 解析, 说明走错了路。
   *
   * 📌 返回集里**库内不存在的合约直接忽略** (`state_branch` 10, 盘中新挂 —— 本片不在盘中重跑
   * 链发现, 次日收盘采集自然补上): 按库内 `legs` 逐条去查返回集, 多出来的那些结构上够不着。
   * 📌 **标的自身那行 (`isOption: false`) 本 task 不消费** —— 它是 T004b 的两个现价那件事。
   *
   * 复杂度: 1 次外呼 + `O(m)` 建索引 + `O(n)` 逐腿覆盖 (m = 返回行数, n = 库内腿数)。
   */
  private async overlayRealtimeQuotes(
    port: OptionSnapshotPort,
    symbol: string,
    chain: LegChainMeta,
    legs: readonly LegChainRow[],
  ): Promise<LegChainSnapshot> {
    const batch = await port.getSnapshots({
      underlyingSymbol: symbol,
      contractCodes: legs.map((leg) => leg.code),
    });
    const quoteByCode = new Map<string, (typeof batch.rows)[number]>();
    for (const row of batch.rows) {
      if (row.isOption) quoteByCode.set(row.code, row);
    }

    return {
      // 区块级时刻取**信封的采集时刻** (FR-010) —— 🚫 MUST NOT 用行内 `vendorUpdateTime` 顶替:
      // 那是最后成交时刻, 低流动性腿上它可以停在上周 (`OptionSnapshotRow.vendorUpdateTime`)。
      chain: { ...chain, quoteAsOf: batch.asOf, priceKind: 'realtime' },
      legs: legs.map((leg) => {
        const quote = quoteByCode.get(leg.code);
        // 未在返回集内 ⇒ 保留收盘值与收盘档。逐行处理**不是**页级降级 (FR-009 / FR-011),
        // 该分支的完整判据 (含单腿关键报价为空) 归 T005。
        if (quote === undefined) return leg;
        return {
          ...leg,
          bid: vendorDecimal(quote.bid),
          ask: vendorDecimal(quote.ask),
          bidSize: vendorNumber(quote.bidSize),
          askSize: vendorNumber(quote.askSize),
          delta: vendorNumber(quote.delta),
          // 🚫 原样带出, 不换算 —— 与库内那条同源纪律 (`LegChainRow.iv`)。
          iv: vendorNumber(quote.iv),
          volume: vendorNumber(quote.volume),
          priceKind: 'realtime',
        };
      }),
    };
  }
}

/** 计数列与 Δ → number (张数与无量纲希腊值, 没有精度可丢; 金额列不走这里)。 */
function numberOf(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * vendor 侧金额串 → `Decimal`。空串与 `null` 同为「没有这个数」。
 *
 * 🚫 **MUST NOT 回落成 0** (064 FR-011 / SC-004): 0 在买卖价上读作「有人挂到 0」, 与「没取到」
 * 是两件完全不同的事, 而两者在屏上都显示得出来。
 */
function vendorDecimal(value: string | null): Prisma.Decimal | null {
  return value === null || value === '' ? null : new Prisma.Decimal(value);
}

/** vendor 侧计数 / 无量纲希腊值串 → number; 空、非数一律 `null` (理由同上, 禁 0 冒充)。 */
function vendorNumber(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
