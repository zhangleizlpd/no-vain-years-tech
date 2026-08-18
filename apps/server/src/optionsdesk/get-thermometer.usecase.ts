import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import { marketsOfTickers, resolveLastClosedSessions } from './last-closed-session';
import { sessionOf } from './list-anchors.usecase';
import { noIv, type UnderlyingIvReadout } from './get-underlying-detail.usecase';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';

/**
 * 046 US2 — 波动温度计读端 (FR-015/FR-016/FR-017/FR-018/FR-027/FR-032/FR-035, plan D8)。
 * 范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma row、直注 `PrismaService` 无 repository。
 *
 * 一次请求读**两条互不依赖的线**, 各自独立降级:
 * 1. **指数维度** —— 跨 ctx 直查 `us_index_daily` 取 VIX / VVIX 各自最新一期 + 在 server 算
 *    VVIX/VIX 比 (带基准判定);
 * 2. **逐票 IVP 列表** —— 本 ctx 自有的全部 `Anchor` + 跨 ctx 批量直查各自最新一期 IV 快照。
 *
 * 🚨 **指数不依赖锚** (FR-027 的效果面 / FR-018 空态分支): 零锚时列表为空但**表盘照常返回**。
 * 采集侧 (T013) 已保证「指数维度不挂锚闸」, 读端这半边必须对得上 —— 否则零锚时表盘会连同列表
 * 一起变空, 采集侧那条纪律就白守了。
 *
 * 🚨 **VVIX/VIX 比在 server 算, 但带基准判定** (FR-016): VIX 与 VVIX 来自**两个独立的 CBOE
 * 历史文件**, 两侧最新可得日在生产上真的可能不同交易日 ⇒ **不同基准则不计算**并回显式标记。
 * 放前端等于每个消费方 (RN / 未来的 web / 契约冒烟) 都要重新实现一次基准纪律, 漏一个就悄悄
 * 出一个跨日比值 —— 那种错不会红、只会让人读错市场状态。
 *
 * 🚨 **指数不可得 → 显式不可用态, 禁 0** (FR-017): 指针停在 0 会被读成「极度平静」, 那是
 * **错误信息**而不是缺失信息。同理**只 select `close` + `date`** —— VVIX 的 open/high/low 在
 * 库里恒 NULL (CBOE 的 VVIX 文件只有 `DATE,VVIX` 两列), 不查出来就不可能被谁当 0 用。
 *
 * 🚨 **本响应不含 `regime` 读数** (FR-015 📌, 2026-08-03 拍板): vault §8 未给 N/X 的机械判据,
 * 且三处一手依据一致把 regime 定性为「温度计的极致读数 + 人判 + 无 gate」。呈现温度计本体即可,
 * regime 由人读表盘自行判定。⚠️ mockup 帧⑦ 画过 `regime N` —— `design/` 是历史留痕, 别抄回来。
 *
 * 🚨 **跨 ctx 只读直查** (catalog Q7-B / FR-032): 走 `PrismaService` 直查 marketdata 三张表,
 * **禁 `@Inject()` marketdata 的 use case** (Q7-C)。`// CROSS-CONTEXT-READ:` 注释挂在
 * **prisma 调用语句上方** —— `check-server-moat.ts` 的 AST 探针只认那一处。跨 ctx 写永远禁。
 *
 * 🚨 **降级纪律照抄 `marketdata/anchor-driven-sync-gate.ts`**: 跨 ctx 读整段 try/catch, 读失败
 * 一律 `logger.warn` + 显式降级态、**不上抛** —— 上抛会让 marketdata 侧一个小故障把整页 (含
 * 本 ctx 自有的锚列表) 打成 500。两条线各自 catch: 指数挂了不该连累列表, 反之亦然。
 *
 * ⚠️ **免责文案 (FR-019) 不在本端点**: 「不构成开仓理由」常驻是**纯 UI 呈现**, server 端满不了
 * (回一个文案字段也证明不了它在客户端常驻可见), 验证落 T024 e2e。别在 DTO 里塞字段"覆盖"它。
 *
 * ⚠️ **提醒状态档位 (FR-036) 不在本端点**: 25/70/90 三档由 IVP **纯派生**, 呈现侧 (T021/T022)
 * 各自派生即可; server 回一份档位标签等于把同一个纯函数实现两次。本端点只回 IVP 原值 + 态。
 *
 * **读端零写**: 不推进任何状态机 (打开温度计不是一次「可判定时点」, 那属雷达那一屏的语义)。
 */

/** CBOE 官方历史文件的两个指数代码 —— 采集侧 (T013) 的固定工作集, 读端按它寻址。 */
export const US_INDEX_CODES = { vix: 'VIX', vvix: 'VVIX' } as const;

/** VIX / VVIX 是 CBOE 的**美股**波动率指数 ⇒ 新鲜度基准恒按 us 交易日历判。 */
export const US_INDEX_MARKET = 'us';

/**
 * 指数读数三态 (FR-017: 缺失一律显式态, **MUST NOT 用 0 冒充**)。
 *
 * 词汇与 `UNDERLYING_IV_STATES` **同源**, 只是少了 `percentile_unavailable` (指数没有分位这个
 * 概念) —— 别为同一件事造第二套同义词。`missing` 与 `read_failed` 的分工同样是蓄意的:
 * 前者是**事实**(还没采到), 后者是**故障**(采到了但读不出来), 把故障说成「暂无数据」是撒谎。
 */
export const US_INDEX_STATES = ['available', 'missing', 'read_failed'] as const;

export type UsIndexState = (typeof US_INDEX_STATES)[number];

/**
 * VVIX/VIX 比四态。`basis_mismatch` 是本端点**唯一新增**的语义 —— 两侧都有数、但不同交易日,
 * 既不是「缺」也不是「故障」, 必须能与它们分开呈现 (FR-016 要求显式标注「基准不一致」)。
 */
export const VVIX_VIX_RATIO_STATES = [
  'available',
  'basis_mismatch',
  'missing',
  'read_failed',
] as const;

export type VvixVixRatioState = (typeof VVIX_VIX_RATIO_STATES)[number];

export interface UsIndexReadout {
  state: UsIndexState;
  /** 收盘值 (`Decimal(18,4)`); 非 available 态一律 `null`, **禁 0** (FR-017)。 */
  close: Prisma.Decimal | null;
  /** 该指数自身的业务日 —— 来自 CBOE 文件的 `DATE` 列, **不是采集日** (FR-020 同款口径)。 */
  asOf: Date | null;
}

export interface VvixVixRatio {
  state: VvixVixRatioState;
  /** VVIX ÷ VIX; 非 available 态一律 `null` (**禁**用单侧值推算, FR-016)。 */
  value: Prisma.Decimal | null;
  /** 该比值成立的**共同**基准日; 非 available 态为 `null`。 */
  basisDate: Date | null;
}

export interface ThermometerUnderlyingRow {
  /** canonical `market:code`。 */
  ticker: string;
  /**
   * 交易意愿排除 —— **照常在列表内并带标记** (045 语义: 锚 = 采集意愿、`excluded` = 交易意愿,
   * 采集照常 ⇒ 温度计照常显示)。⚠️ 与雷达相反, 别为「统一」把两者合成一个查询。
   */
  excluded: boolean;
  excludeReason: string | null;
  /** 该票的 IV 读数 —— **复用**详情读端的四态与形状 (`UnderlyingIvReadout`), 无第二套词汇。 */
  iv: UnderlyingIvReadout;
  /** 该票所属市场的「最近一个已收盘交易日」—— IV asOf 新鲜度档的判据基准 (FR-020)。 */
  lastClosedSession: string | null;
}

export interface Thermometer {
  vix: UsIndexReadout;
  vvix: UsIndexReadout;
  vvixVixRatio: VvixVixRatio;
  /** 全部锚定标的 (ticker 升序); 「分位不可算」与 `excluded` 的行都在内 (FR-018)。 */
  underlyings: ThermometerUnderlyingRow[];
  total: number;
  /**
   * **us** 的「最近一个已收盘交易日」—— VIX / VVIX 两个读数的新鲜度基准。
   * 与逐票的基准分开: 指数那条线不看 anchors 一眼 (FR-027), 零锚时它照样要能判档。
   */
  indexLastClosedSession: string | null;
}

/** 非 available 态的空读数 (两值一律 null —— 禁 0 冒充, FR-017)。 */
function noIndex(state: UsIndexState): UsIndexReadout {
  return { state, close: null, asOf: null };
}

function noRatio(state: VvixVixRatioState): VvixVixRatio {
  return { state, value: null, basisDate: null };
}

/**
 * VVIX/VIX 比的**基准判定 + 计算** (FR-016)。纯函数, 无 I/O, O(1)。
 *
 * 四条分支, 顺序不可换:
 * 1. 任一侧 `read_failed` → 比值也是**故障**态 (不能说成「暂无数据」);
 * 2. 任一侧非 `available` → `missing`; 🚨 **MUST NOT** 拿另一侧单独推算 (US2-AS2);
 * 3. 两侧 `asOf` **不同交易日** → `basis_mismatch`, **不计算**;
 * 4. 分母非正 → 折进 `missing`。VIX 收盘 ≤ 0 在现实里不存在 (脏数据 / 上游解析错), 对用户
 *    而言与「缺一侧」是同一句「比值不可用」, 不值得为它造第五个态。
 */
export function computeVvixVixRatio(vix: UsIndexReadout, vvix: UsIndexReadout): VvixVixRatio {
  if (vix.state === 'read_failed' || vvix.state === 'read_failed') return noRatio('read_failed');
  if (vix.state !== 'available' || vvix.state !== 'available') return noRatio('missing');
  if (vix.close === null || vvix.close === null || vix.asOf === null || vvix.asOf === null) {
    return noRatio('missing');
  }
  if (vix.asOf.getTime() !== vvix.asOf.getTime()) return noRatio('basis_mismatch');
  if (!vix.close.greaterThan(0)) return noRatio('missing');
  return { state: 'available', value: vvix.close.div(vix.close), basisDate: vix.asOf };
}

/** 读端只取这几列 —— `select` 即契约的机械面。 */
interface AnchorListRow {
  ticker: string;
  excluded: boolean;
  excludeReason: string | null;
}

@Injectable()
export class GetThermometerUseCase {
  private readonly logger = new Logger(GetThermometerUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 只取「最近一场已收盘交易日」当陈旧度基准 —— 062 T010 起该判据多了「覆盖声明」一维,
    // 自己直查会漂 (漂了只让档位悄悄错一档, 不报错)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * 复杂度: **与锚数无关的固定往返数** —— 1 次锚全量 + 2 次指数点查 + 3 次批量跨 ctx 查
   * (instrument 批量寻址 → 每票最新快照日 `groupBy` → 按 (标的, 日) 取行)。O(n) 内存归并,
   * n = 锚数 (上限约 1000)。🚨 **禁逐票 await** —— N+1 在 12 只锚时看不出来, 到 100 只就把
   * 50ms 的 `perf_budgets` 吃穿了。
   */
  async execute(): Promise<Thermometer> {
    const anchors = (await this.prisma.anchor.findMany({
      orderBy: { ticker: 'asc' },
      select: { ticker: true, excluded: true, excludeReason: true },
    })) as AnchorListRow[];

    // 新鲜度基准: 逐票所属市场 + 指数固定的 us (零锚时也要有 us, 否则表盘判不了档)。
    const sessions = await resolveLastClosedSessions(this.calendar, [
      ...marketsOfTickers(anchors.map((a) => a.ticker)),
      US_INDEX_MARKET,
    ]);

    // 两条线彼此不依赖 ⇒ 并行发, 各自 catch。指数那条**不看 anchors 一眼** (FR-027)。
    const [indices, underlyings] = await Promise.all([
      this.readIndicesSafely(),
      this.readUnderlyingsSafely(anchors, sessions),
    ]);

    return {
      vix: indices.vix,
      vvix: indices.vvix,
      vvixVixRatio: computeVvixVixRatio(indices.vix, indices.vvix),
      underlyings,
      total: underlyings.length,
      indexLastClosedSession: sessions.get(US_INDEX_MARKET) ?? null,
    };
  }

  /**
   * 两个指数各取最新一期。**整段 try/catch 降级**: 读失败只 `warn` + 两侧 `read_failed`,
   * 不上抛 —— 表盘不可用不该让锚列表一起 500。
   *
   * 两侧共用一次 catch 是蓄意的: 它们走同一个连接、同一张表, 一侧抛错时另一侧的成败已无参考
   * 价值, 分开报只会让客户端看到「VIX 故障 + VVIX 暂无数据」这种自相矛盾的组合。
   */
  private async readIndicesSafely(): Promise<{ vix: UsIndexReadout; vvix: UsIndexReadout }> {
    try {
      const [vix, vvix] = await Promise.all([
        this.readIndex(US_INDEX_CODES.vix),
        this.readIndex(US_INDEX_CODES.vvix),
      ]);
      return { vix, vvix };
    } catch (err) {
      this.logger.warn(`指数日线跨 ctx 读降级 (IVP 列表照常返回): ${String(err)}`);
      return { vix: noIndex('read_failed'), vvix: noIndex('read_failed') };
    }
  }

  private async readIndex(indexCode: string): Promise<UsIndexReadout> {
    // CROSS-CONTEXT-READ: marketdata.us_index_daily 只读直查 (catalog Q7-B) —— 按 index_code 取
    // 最新一期。🚨 `select` **蓄意只有 close + date**: VVIX 的 open/high/low 恒 NULL (CBOE 那个
    // 文件只有 `DATE,VVIX`), 不查出来就不可能被下游当 0 用 (FR-025 / FR-017)。零写、零 @Inject()。
    const row = await this.prisma.usIndexDaily.findFirst({
      where: { indexCode },
      orderBy: { date: 'desc' },
      select: { date: true, close: true },
    });
    // 当日尚未采到 ≠ 没有数据: 回最近一期 + 它自己的 asOf, 由呈现侧标「数据截至 X · 收盘」。
    if (row === null) return noIndex('missing');
    return { state: 'available', close: row.close, asOf: row.date };
  }

  /**
   * 逐票 IVP —— **批量**跨 ctx 读, 整段 try/catch 降级 (失败则每行 `read_failed`, 锚仍在列)。
   *
   * 三步都是集合操作, 与锚数无关的固定往返数:
   * 1. `Instrument` 批量寻址 (ticker → 标的 id);
   * 2. `groupBy` 求每只标的的**最新快照日** (SQL 端聚合, 不把整段历史捞进内存);
   * 3. 按 (标的, 该日) 取那几行。
   */
  private async readUnderlyingsSafely(
    anchors: readonly AnchorListRow[],
    sessions: ReadonlyMap<string, string | null>,
  ): Promise<ThermometerUnderlyingRow[]> {
    // 🚨 零锚: 直接返回空列表 —— 一次跨 ctx 查都不发, 且**指数那条线不受影响** (FR-027)。
    if (anchors.length === 0) return [];

    const parsed = anchors.map((anchor) => ({ anchor, parsed: parseAnchorTicker(anchor.ticker) }));
    const row = (anchor: AnchorListRow, iv: UnderlyingIvReadout): ThermometerUnderlyingRow => ({
      ticker: anchor.ticker,
      excluded: anchor.excluded,
      excludeReason: anchor.excludeReason,
      iv,
      lastClosedSession: sessionOf(sessions, anchor.ticker),
    });

    try {
      const pairs = parsed
        .map(({ parsed: p }) => p)
        .filter((p): p is { market: string; code: string } => p !== null);

      // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的 id
      // 批量寻址, 读法同 `sync-anchor-quote.ts` 的单点版。零写、零 @Inject() 对方 use case (Q7-C)。
      const instruments =
        pairs.length === 0
          ? []
          : await this.prisma.instrument.findMany({
              where: { OR: pairs },
              select: { id: true, market: true, code: true },
            });
      const idByTicker = new Map(instruments.map((i) => [`${i.market}:${i.code}`, i.id]));
      const ids = instruments.map((i) => i.id);

      // CROSS-CONTEXT-READ: marketdata.underlying_iv_daily 只读直查 (catalog Q7-B) —— 每只标的的
      // 最新快照日。聚合放 SQL 端: 三年历史约 750 行/票, 捞回内存再挑最大值是白读一整段序列。
      const latest =
        ids.length === 0
          ? []
          : await this.prisma.underlyingIvDaily.groupBy({
              by: ['instrumentId'],
              where: { instrumentId: { in: ids } },
              _max: { date: true },
            });
      const keys: { instrumentId: bigint; date: Date }[] = [];
      for (const group of latest) {
        if (group._max.date !== null) {
          keys.push({ instrumentId: group.instrumentId, date: group._max.date });
        }
      }

      // CROSS-CONTEXT-READ: marketdata.underlying_iv_daily 只读直查 (catalog Q7-B) —— 上一步那几个
      // (标的, 日) 的行。🚨 `select` **蓄意不含 `ivRank`**: FR-013 要求 IVR 只落库不上屏, 不查
      // 出来就不可能漏进任何投影 (同详情读端)。
      const snapshots =
        keys.length === 0
          ? []
          : await this.prisma.underlyingIvDaily.findMany({
              where: { OR: keys },
              select: { instrumentId: true, date: true, iv: true, ivPercentile: true },
            });
      const byInstrument = new Map(snapshots.map((s) => [s.instrumentId, s]));

      return parsed.map(({ anchor, parsed: p }) => {
        // ticker 非 canonical / 标的未注册进 marketdata ⇒ missing (跨 ctx 缺行是事实不是故障)。
        const id = p === null ? undefined : idByTicker.get(`${p.market}:${p.code}`);
        const snapshot = id === undefined ? undefined : byInstrument.get(id);
        if (snapshot === undefined) return row(anchor, noIv('missing'));
        return row(anchor, {
          // 分位为空 = vendor 侧窗口不足 ⇒ 「分位不可算」而非 0 (FR-014); 聚合 IV 与 asOf 照常出。
          state: snapshot.ivPercentile === null ? 'percentile_unavailable' : 'available',
          iv: snapshot.iv,
          ivPercentile: snapshot.ivPercentile,
          asOf: snapshot.date,
        });
      });
    } catch (err) {
      this.logger.warn(`IV 日快照跨 ctx 批量读降级 (锚仍照常在列): ${String(err)}`);
      return parsed.map(({ anchor }) => row(anchor, noIv('read_failed')));
    }
  }
}
