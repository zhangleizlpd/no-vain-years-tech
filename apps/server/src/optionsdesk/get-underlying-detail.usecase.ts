import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import type { AnchorRow } from './create-anchor.usecase';
import { toAnchorView, type AnchorView } from './list-anchors.usecase';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';

/**
 * 046 US1 — 标的详情读端 (FR-002/FR-003/FR-004/FR-005/FR-011/FR-012/FR-013/FR-014/FR-020/
 * FR-032/FR-035, plan D8)。范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma row、
 * 直注 `PrismaService` 无 repository、业务不变量全在 `anchor.rules.ts` 纯函数里。
 *
 * 一次请求读两样东西, **两侧各带各的 `asOf`、各自独立降级** (FR-020):
 * 1. 本 ctx 自有的 `Anchor` → 锚卡字段 + 四区间边界, 投影**复用**锚列表的 {@link toAnchorView}
 *    (FR-003: 派生一律走 045 已实装的规则纯函数, 本片零重造);
 * 2. 跨 ctx **只读直查** marketdata 的 IV 日快照 → 聚合 IV + IVP + 快照日。
 *
 * 🚨 **档位系数禁字面量** (SC-005, `check-optionsdesk-rule-constants.ts` 在 PR 门无条件全扫):
 * 本文件对 W / 四区间 / 愿卖锚**一个数都不算**, 全部经 `toAnchorView` 落到 `anchor.rules.ts`。
 *
 * 🚨 **本 ctx 禁碰复权** (plan D2 / ADR-0053 绊线): 价格**序列**由客户端直接调 marketdata 的
 * bars 端点取 (前复权 + 时间桶聚合都归那边), 本端点只回锚派生的四区间边界与单点 IV 读数 ——
 * 这里 MUST NOT 出现任何 `adjusted-bars` 的 import 或自拼序列 (ESLint disallow 已守着)。
 *
 * 🚨 **跨 ctx 只读直查** (catalog Q7-B / FR-032): 走 `PrismaService` 直查 marketdata 两张表,
 * **禁 `@Inject()` marketdata 的 use case** (Q7-C)。`// CROSS-CONTEXT-READ:` 注释挂在
 * **prisma 调用语句上方** —— `check-server-moat.ts` 的 AST 探针只认「调用语句紧邻上方的连续
 * 注释」与「构造器注入参数上方」两处。跨 ctx **写**永远禁 (无逃生口)。
 *
 * 🚨 **降级纪律照抄 `marketdata/anchor-driven-sync-gate.ts`**: 跨 ctx 读整段 try/catch,
 * 读失败一律 `logger.warn` + 显式降级态, **不上抛** —— 上抛会让 marketdata 侧的一个小故障
 * 把整张锚卡也打成 500, 而锚是本 ctx 自有事实、当时明明读得到 (state_branch #15 的服务端半边)。
 *
 * 🚨 **无锚 = 404 而不是空壳 200** (FR-011): 前端据 `code` 渲染「尚未建锚 + 建锚入口」,
 * 而不是报错页。回 200 空壳会让「这只票没建锚」与「建了锚但字段全空」在客户端不可区分。
 *
 * **读端零写**: 与雷达不同 —— 雷达首页会推进复核锚状态机, 本端点**不推进任何状态**
 * (打开详情不是一次「可判定时点」, 且状态机推进属雷达那一屏的语义)。
 */

/** IV 读数四态 (FR-014: 缺失 / 不可算一律显式态, **MUST NOT 用 0 或空值冒充**)。 */
export const UNDERLYING_IV_STATES = [
  /** 直读值齐备 —— 显示口径单源 = 富途 `overview` 直读 (FR-035)。 */
  'available',
  /** 有快照但 vendor 未给分位 (历史窗口不足 252 交易日) ⇒ 呈现「分位不可算」(FR-014)。 */
  'percentile_unavailable',
  /** 该标的从未采到 IV 快照 (或未注册进 marketdata) ⇒ 呈现「暂无数据」, 区块仍渲染。 */
  'missing',
  /** 跨 ctx 读失败降级 —— 与「暂无数据」**蓄意分开**: 前者是事实, 后者是故障。 */
  'read_failed',
] as const;

export type UnderlyingIvState = (typeof UNDERLYING_IV_STATES)[number];

/** 无锚 404 的机器可读 code (FR-011 前端分支判据; ProblemDetail 只透传白名单字段)。 */
export const ANCHOR_NOT_FOUND_FOR_SYMBOL = 'ANCHOR_NOT_FOUND_FOR_SYMBOL';

/**
 * 单标的 IV 读数。
 *
 * 🚨 **字段口径 (FR-035)**: `iv` = 富途**标的聚合 IV** 直读值 —— **MUST NOT** 标注 / 命名为
 * 「IV30d」或任何暗示 30 天 / ATM 锁定的措辞 (p3 §9-1: 富途未文档化其 tenor / moneyness
 * 聚合规则, 标成 IV30d 等于宣称数据源并不保证的口径)。
 *
 * 🚨 **`iv_rank` 不在此** (FR-013): vendor 的 IVR 照常落库, 但详情页与 P7 列表的呈现字段里
 * MUST NOT 出现它 —— 机械保证 = 下面的查询 `select` 里根本没有那一列。
 *
 * 🚨 **T010 的自算分位也不在此** (FR-034): 双算对表只进采集侧告警面, 显示值恒为直读值。
 */
export interface UnderlyingIvReadout {
  state: UnderlyingIvState;
  /** 富途标的聚合 IV (`Decimal(12,8)`); 非 available 态一律 `null`。 */
  iv: Prisma.Decimal | null;
  /** IVP 直读值 (`Decimal(8,4)`); 窗口不足 / 缺失 ⇒ `null`, **禁 0**。 */
  ivPercentile: Prisma.Decimal | null;
  /** 该读数自身的业务日 (美股业务日 A′), 与行情 `asOf` 是两个独立的新鲜度 (FR-020)。 */
  asOf: Date | null;
}

export interface UnderlyingDetail {
  /** canonical `market:code` (入参原样回显)。 */
  symbol: string;
  /** 锚卡投影 —— 与锚列表 / 雷达**同一个** {@link toAnchorView}, 派生口径单点。 */
  anchor: AnchorView;
  iv: UnderlyingIvReadout;
  /**
   * 该标的所属市场的「最近一个已收盘交易日」—— 行情 asOf 与 IV asOf **共用同一个基准**
   * (同一只票、同一个市场), 但它们各自的档位仍分开判 (FR-020: 两个独立的新鲜度)。
   */
  lastClosedSession: string | null;
}

/**
 * 非 available 态的空读数 (三值一律 null —— 禁 0 冒充, FR-014)。
 *
 * 导出供 046 T017 温度计读端复用 —— 两个端点的降级读数必须**逐字节同形**, 各写各的就会出现
 * 「详情说 missing、列表说 unavailable」这种同一事实两种说法。
 */
export function noIv(state: UnderlyingIvState): UnderlyingIvReadout {
  return { state, iv: null, ivPercentile: null, asOf: null };
}

@Injectable()
export class GetUnderlyingDetailUseCase {
  private readonly logger = new Logger(GetUnderlyingDetailUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 只取「最近一场已收盘交易日」当陈旧度基准 —— 062 T010 起该判据多了「覆盖声明」一维,
    // 自己直查会漂 (漂了只让档位悄悄错一档, 不报错)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * @param symbol canonical `market:code` (锚 ticker 全局唯一, 即标的身份)。
   * @param now 请求时刻 (注入以便测试钉住基准)。🚫 **调用侧 MUST NOT 省略** —— 省了就落回
   *   `new Date()`, 于是本 use case 的陈旧度基准 `lastClosedSession` 吃**真实时钟**、而调用方
   *   响应里的其余日期跟**注入时钟**走, 同一份响应就此分叉成两条时间轴。这类偏差**不报错**
   *   (`cross-timezone-date-semantics.md` §6 第 6 问), 只能靠测试钉住。
   * @throws NotFoundException 该 symbol 尚未建锚 (FR-011)。非法形态折叠进同一分支 ——
   *   与「没建锚」不可区分, 不给第二套校验面 (体例同 controller 的 `parseAnchorId`)。
   *
   * 复杂度: 三次点查 (锚唯一键 / instrument 唯一键 / IV 唯一键前缀 desc 取一), O(1) 往返。
   */
  async execute(symbol: string, now: Date = new Date()): Promise<UnderlyingDetail> {
    const row = (await this.prisma.anchor.findUnique({
      where: { ticker: symbol },
    })) as AnchorRow | null;
    if (row === null) {
      throw new NotFoundException({
        code: ANCHOR_NOT_FOUND_FOR_SYMBOL,
        message: `${ANCHOR_NOT_FOUND_FOR_SYMBOL}: ${symbol} 尚未建锚`,
      });
    }
    const lastClosedSession = await resolveLastClosedSessionForTicker(this.calendar, symbol, now);
    return {
      symbol,
      anchor: toAnchorView(row, lastClosedSession),
      iv: await this.readIvSafely(symbol),
      lastClosedSession,
    };
  }

  /**
   * 跨 ctx 读 marketdata 的 IV 日快照 —— **整段 try/catch 降级**, 形态照抄
   * `anchor-driven-sync-gate.ts`: 读失败只 `warn`, 返显式 `read_failed`, **不上抛**。
   *
   * 取**最近一期**而非「今天那期」: 当日尚未采到不等于没有数据 (state_branch #3) ——
   * 回最近一期 + 它自己的 `asOf`, 由呈现侧标「数据截至 X · 收盘」(FR-020)。
   */
  private async readIvSafely(symbol: string): Promise<UnderlyingIvReadout> {
    const parsed = parseAnchorTicker(symbol);
    if (parsed === null) return noIv('missing');
    try {
      // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的
      // id 寻址, 读法同 `sync-anchor-quote.ts`。零写、零 @Inject() 对方 use case (Q7-C)。
      const instrument = await this.prisma.instrument.findUnique({
        where: { market_code: { market: parsed.market, code: parsed.code } },
        select: { id: true },
      });
      if (instrument === null) return noIv('missing');

      // CROSS-CONTEXT-READ: marketdata.underlying_iv_daily 只读直查 (catalog Q7-B) —— vendor
      // 直读的最近一期 IV 快照。🚨 `select` **蓄意不含 `ivRank`**: FR-013 要求 IVR 只落库不
      // 上屏, 不查出来就不可能漏进任何投影 (同 `anchor-driven-sync-gate` 只 select ticker)。
      const latest = await this.prisma.underlyingIvDaily.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { date: 'desc' },
        select: { date: true, iv: true, ivPercentile: true },
      });
      if (latest === null) return noIv('missing');

      return {
        // 分位为空 = vendor 侧窗口不足 ⇒ 「分位不可算」而非 0 (FR-014); 聚合 IV 与 asOf 照常出。
        state: latest.ivPercentile === null ? 'percentile_unavailable' : 'available',
        iv: latest.iv,
        ivPercentile: latest.ivPercentile,
        asOf: latest.date,
      };
    } catch (err) {
      this.logger.warn(`IV 日快照跨 ctx 读降级 (${symbol}, 锚卡照常返回): ${String(err)}`);
      return noIv('read_failed');
    }
  }
}
