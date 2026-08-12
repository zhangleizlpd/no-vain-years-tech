import type {
  RecallCandidate,
  RecallContext,
  RecallLegInput,
  RecallOutcome,
} from './leg-recall.rules';
import type { LegTab } from './leg-tab.rules';

/**
 * 052 **检索 port** —— 召回层的数据来源接缝 (ADR-0064 决策 4, plan D-PORT-1)。
 *
 * ADR-0043 §4 按场景把 port 三分 (自有表无 port / 3rd-party SDK 留 port / 跨 ctx 发布契约留
 * port)。期权链检索属**第四类: 跨 ctx 只读查询**, ADR-0064 决策 4 追加了它的处置 = 保留 port,
 * 本文件是该类的首个实施。
 *
 * 🚨 **存在理由是「跨 ctx 只读的显式接缝 + 可 mock」, 不是「为了换存储引擎」** (ADR-0064 逐字)。
 * 后者正是 ADR-0043 §决策依据 1 判死的动机 —— 换存储只是这个接缝的副产品, 不是它的存在理由。
 * 接缝的直接收益是**召回判据可以脱离真库单测** (FR-032 / SC-009): 假实现喂裸行、判据照常跑。
 *
 * 🚫 **接口 MUST NOT 出现存储侧概念** (FR-031): 查询片段 / 游标 / 分页 token / `LIMIT OFFSET`
 * 语义 / 任何 ORM 类型。漏进去等于换实现时接口照样要重写, 接缝白留。机器判据 =
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #5 (剥注释后扫本文件, 零命中)。
 * 📌 金额量纲经 {@link RecallLegInput} / {@link RecallContext} 带入 —— 它们是**召回判据的入参
 * 类型**, 让「port 的腿侧字段」与「判据吃的字段」同型, 而不是各写一份必 drift 的镜像。
 *
 * 📌 本 port 只管**候选集检索**。财报日 / 交易日历 / 最近已收盘 session 那三处跨 ctx 读是**打标
 * 与呈现的输入**, 不是召回, 仍留在 use case 侧直查 (同为 Q7-B 只读 + `CROSS-CONTEXT-READ`)。
 */

/** DI token (沿 `volatility.port.ts` 等既有 port 的 `Symbol` 体例)。 */
export const LEG_RETRIEVAL_PORT = Symbol('LEG_RETRIEVAL_PORT');

/** 检索入参 —— 三项全是业务语义 (FR-031)。 */
export interface LegRetrievalQuery {
  /** 标的 canonical `market:code`。 */
  readonly symbol: string;
  /**
   * 请求时刻。DTE 基准恒为**交易所的今天**, 由实现按它算。
   * 🚫 MUST NOT 换成算好的日期串 —— 那会让注入时钟对 DTE 失效 (与 use case 上那条同源纪律)。
   */
  readonly now: Date;
  /**
   * 本次要的视角。不在其内的视角不产候选。
   *
   * 📌 今天恒为全集 (047 FR-005: 三个视角是同一份派生结果的三种视图, 一次请求全返), 拆成每
   * 视角独立请求归 053 —— 该参数先立在接口上, 到时不必改签名。
   */
  readonly perspectives: readonly LegTab[];
}

/**
 * 候选腿的**裸值** —— 召回判据的入参 (经 {@link RecallLegInput}) + 下游派生与呈现所需的其余列。
 *
 * 📌 计数列 (挂牌量 / OI / 成交量) 与 Δ 在此已是 `number`: 它们是**张数与无量纲希腊值**,
 * 没有精度可丢; 金额列 (行权价 / 双边报价) 保持十进制量纲不降级 (沿 `leg-derive.rules.ts` 纪律)。
 * 🚨 Δ 是 vendor 原始**有符号**值, 取绝对值归下游 —— 本层不做任何语义加工。
 * 📌 **OI 与成交量不在本接口上重复声明** —— 052 起它们是持仓量条件的入参, 已由
 * {@link RecallLegInput} 带入。在这里再写一遍等于让「判据吃的字段」与「port 给的字段」成为两份
 * 必 drift 的镜像。
 */
export interface LegChainRow extends RecallLegInput {
  /** vendor 合约代码 (行身份)。 */
  readonly code: string;
  /** 到期日 (UTC 午夜)。 */
  readonly expiryDate: Date;
  readonly bidSize: number | null;
  readonly askSize: number | null;
  readonly delta: number | null;
  /** greeks 是否齐全 —— `false` 的腿**照常进候选** (FR-013 / 050 FR-009)。 */
  readonly greeksComplete: boolean;
}

/** 链级上下文 —— 候选集之外、每票每请求算一次的那几项。 */
export interface LegChainMeta {
  /**
   * 本次检索所用的**交易所的今天** (`YYYY-MM-DD`)。
   *
   * 🚨 下游打标窗口 MUST 复用它, 别再算一次 —— 两处各算必 drift, 而 drift 只在换日那一刻
   * 才看得见 (per `cross-timezone-date-semantics.md`)。
   */
  readonly marketDate: string;
  /** 快照归属交易日 (区块级 `asOf`)。 */
  readonly sessionDate: Date;
  /** 本批报价的实际采集时刻。 */
  readonly quoteAsOf: Date;
  /** 🚨 OI 的归属交易日 —— 与上面两个**不是同一天** (美股期权 OI 盘前更新)。 */
  readonly oiAsOf: Date;
  /** 快照来源 (`eod` / `premarket_backfill`) —— 「靠兜底续命」要看得见。 */
  readonly source: string;
  /** vendor 随链下发的标的价, **未复权**; 与召回上下文同型 (十进制金额, 不降 `number`)。 */
  readonly spot: RecallContext['spot'];
}

/** 一条候选 —— 层间传递的单元 (召回吐出、粗排合并、特征加工与精排消费)。 */
export type LegCandidate = RecallCandidate<LegChainRow>;

/** 出参 = 候选集 (裸行 + 已判定的视角归属) + 两道门槛的排除计数 + 链级上下文。 */
export interface LegRetrievalResult extends RecallOutcome<LegChainRow> {
  readonly chain: LegChainMeta;
}

export interface LegRetrievalPort {
  /**
   * 取该标的当前的候选集。
   *
   * 🚨 **链未就绪返 `null`** —— 与「链有数据但一条候选都没有」是两件事: 前者是采集还没轮到
   * (标的没进 instrument / 没采到合约或快照 / 快照缺标的价), 后者是判据把腿全挡了。混成一个
   * 值会让「缺口」看起来像「正常的空」, 正是本仓反复吃亏的那类静默。
   */
  retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null>;
}
