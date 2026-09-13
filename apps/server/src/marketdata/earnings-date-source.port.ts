import type { EarningsReportKind } from './earnings-period.rules.js';

/**
 * 财报日期来源端口 (079 T009, FR-001 / FR-002 / FR-018, plan §D2)。
 *
 * 一个来源 = 一种「谁在说某标的某期财报哪天公布」的渠道 (富途财报日历 / 交易所公告 / 港交所
 * 董事會會議通知清单)。合并用例 (T013 / T014) **只认本契约**, 🚫 出现任何来源名分支 (FR-001):
 * 换源 / 加源 / 停源只改装配, 合并规则零改动 (SC-010)。
 *
 * ## DI: 注入的是**来源数组**, 不是单个端口
 *
 * token {@link EARNINGS_DATE_SOURCES} 绑定 `EarningsDateSource[]`, 由 `marketdata.module.ts`
 * 按非密 env `EARNINGS_DATE_SOURCES` 经 {@link assembleEarningsDateSources} 组装。
 *
 * ## 失败语义: `collect` 失败**直接抛**
 *
 * 按来源隔离是调用方 (合并用例) 的事 (FR-018): 它 try/catch 每个来源, 失败计入运行失败并让该来源
 * 本轮观测零写入。🚫 来源内部捕获后返回空结果 —— 空结果在下游读作「这个来源今天没有任何日期」,
 * 改版 / 换地址 / 停更就此静默。
 */

/** DI token —— 绑定 `EarningsDateSource[]`。 */
export const EARNINGS_DATE_SOURCES = Symbol('EARNINGS_DATE_SOURCES');

/**
 * 全部合法来源名 (落库 `earnings_date_observation.source` 的稳定名)。`EARNINGS_DATE_SOURCES`
 * 里出现此外的名字 ⇒ 装配期抛 {@link UnknownEarningsDateSourceError}。
 */
export const EARNINGS_DATE_SOURCE_NAMES = [
  'futu_calendar',
  'hkex_announcement',
  'hkex_board_meeting_list',
] as const;

export type EarningsDateSourceName = (typeof EARNINGS_DATE_SOURCE_NAMES)[number];

/** 取值口径, 合并优先级 `filed` > `explicit` > `structured` > `meeting` (plan §D8)。 */
export type EarningsDateBasis = 'filed' | 'explicit' | 'structured' | 'meeting';

/**
 * 前向日期语义: `announced_only` = 只给公司已公告的日期 (可据此确认);
 * `unconfirmed` = 含预估日期 (🚫 据此升级为确认, FR-011 / FR-021)。
 */
export type EarningsForwardSemantics = 'announced_only' | 'unconfirmed';

export interface EarningsDateSourceCapabilities {
  /** 前向日期语义; 该来源不给前向日期为 null。 */
  readonly forward: EarningsForwardSemantics | null;
  /** 是否产出会前通知信号 ({@link EarningsNoticeSignal})。 */
  readonly confirmationSignal: boolean;
  /** 是否产出刊发事实 (`filed` 口径观测)。 */
  readonly publicationFact: boolean;
}

export type EarningsDateCollectMode = 'daily' | 'backfill';

export interface EarningsDateCollectRequest {
  /** canonical market (`hk` / `us`)。 */
  readonly market: string;
  /** 本轮业务日 `YYYY-MM-DD` —— 该市场交易所当地日期。 */
  readonly businessDate: string;
  /** 本轮运行时刻 (UTC instant); 观测时刻一律取它, 🚫 来源内自取时钟。 */
  readonly now: Date;
  readonly mode: EarningsDateCollectMode;
}

/**
 * 一条已归一的来源观测, 与 `earnings_date_observation` 的来源侧列逐列对应。首次 / 最近观测时刻、
 * 上一个日期、偏差天数**不在此**: 它们由合并用例落库时维护 (FR-013 / FR-019)。
 *
 * 日期一律 `YYYY-MM-DD` 交易所当地日期。
 */
export interface EarningsDateSourceObservation {
  /** 已按主表解析的标的; 主表外代码由来源跳过并计入 `skippedUnknownInstruments`。 */
  readonly instrumentId: bigint;
  /** `P:` / `T:` / `D:` 三形态, 构造单点 `earnings-period.rules.ts`。 */
  readonly periodKey: string;
  readonly reportKind: EarningsReportKind | null;
  readonly periodEnd: string | null;
  /** 来源原文报告期, 原样。 */
  readonly periodText: string | null;
  readonly basis: EarningsDateBasis;
  readonly announceDate: string | null;
  readonly meetingDate: string | null;
  readonly publicationTime: Date | null;
  readonly filedDate: string | null;
  /** 凭据指针 (公告链接 / 清单页首日期)。 */
  readonly evidence: string | null;
}

/** 会前通知信号 (标题识别, 不落表, 每轮现算; plan §D3 / §D6)。 */
export interface EarningsNoticeSignal {
  readonly instrumentId: bigint;
  /** 通知刊发日 `YYYY-MM-DD` (交易所当地日期)。 */
  readonly noticeDate: string;
  readonly title: string;
  readonly link: string;
}

export interface EarningsDateCollectResult {
  readonly observations: readonly EarningsDateSourceObservation[];
  readonly noticeSignals: readonly EarningsNoticeSignal[];
  /** 主表查不到而跳过的代码数 (监控信号, 🚫 为保 FK 改幂等键)。 */
  readonly skippedUnknownInstruments: number;
  /**
   * 富途来源 (079 T010): 本轮去重后公布日 ≥ 业务日的行数, **含主表外代码** —— plan §D5 缺失语义③
   * 的运行时不变量 (港股前向行天然稀疏, 塌到 0 要能被 notice 看见)。其余来源不给。
   */
  readonly forwardRows?: number;
}

export interface EarningsDateSource {
  /** 稳定来源名 (见 {@link EARNINGS_DATE_SOURCE_NAMES}); 落库与 finding `symbol` 用它。 */
  readonly name: string;
  /** 该来源对 `market` 的能力; 不支持该市场返回 null。 */
  capabilities(market: string): EarningsDateSourceCapabilities | null;
  /** 失败直接抛 (见文件头「失败语义」)。 */
  collect(request: EarningsDateCollectRequest): Promise<EarningsDateCollectResult>;
}

/** `EARNINGS_DATE_SOURCES` 含非法来源名 —— 装配期抛, 让 boot 失败而不是少跑一个来源。 */
export class UnknownEarningsDateSourceError extends Error {
  constructor(readonly sourceName: string) {
    super(
      `EARNINGS_DATE_SOURCES 含未知来源名 ${JSON.stringify(sourceName)} —— 合法值: ` +
        `${EARNINGS_DATE_SOURCE_NAMES.join(', ')}。拼错的名字若被静默忽略, 该来源会从此不跑且零告警。`,
    );
    this.name = 'UnknownEarningsDateSourceError';
  }
}

function isEarningsDateSourceName(name: string): name is EarningsDateSourceName {
  return (EARNINGS_DATE_SOURCE_NAMES as readonly string[]).includes(name);
}

/**
 * 按配置顺序从「来源名 → 实例」表取出启用的来源。O(n), n = 启用名个数。
 *
 * - 未知名 ⇒ 抛 {@link UnknownEarningsDateSourceError}; 重复名 / 空清单 ⇒ 抛。
 * - 注册表值为 `null` = **已知但尚未接线**的来源 (079 T010–T012 逐个接入前的中间态) ⇒ 不进数组、
 *   不抛。与「未知名」刻意分开: 前者是本仓还没写完, 后者是配置写错。
 *   🚨 最后一个来源接线后 (T012), 注册表类型应收紧为非空, 让这条分支在类型层消失。
 */
export function assembleEarningsDateSources(
  enabled: readonly string[],
  registry: Readonly<Record<EarningsDateSourceName, EarningsDateSource | null>>,
): EarningsDateSource[] {
  if (enabled.length === 0) {
    throw new Error('EARNINGS_DATE_SOURCES 为空 —— 零来源的维度每轮空跑且全绿, 至少启用一个来源。');
  }
  const seen = new Set<EarningsDateSourceName>();
  const sources: EarningsDateSource[] = [];
  for (const name of enabled) {
    if (!isEarningsDateSourceName(name)) throw new UnknownEarningsDateSourceError(name);
    if (seen.has(name)) {
      throw new Error(
        `EARNINGS_DATE_SOURCES 重复来源名 ${JSON.stringify(name)} —— 同一来源跑两遍会让观测与失败计数翻倍。`,
      );
    }
    seen.add(name);
    const source = registry[name];
    if (source !== null) sources.push(source);
  }
  return sources;
}
