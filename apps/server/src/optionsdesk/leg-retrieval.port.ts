import type {
  RecallCandidate,
  RecallContext,
  RecallLegInput,
  RecallOutcome,
  RetrievalOverride,
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
  /**
   * 本次的候选上限 (052 FR-027) —— 给下游限流的保险丝, **不是**用户可见条数。
   *
   * 📌 由调用方传而不是实现自己去读常量: 让「上限是多少」在调用点读得出来, 也让测试能用一个
   * 小值驱动截断路径 (真值取三千量级, 造那么多腿只为验一条分支是不划算的)。
   * 🚨 触及时**切掉多少条**由出参如实上报 (`droppedByCandidateCap`), 🚫 MUST NOT 只落日志。
   */
  readonly candidateCap: number;
  /**
   * 用户对**某一个视角**检索条件的覆盖 (052 FR-012); 无覆盖 ⇒ `null`, 三视角全走系统默认值。
   *
   * 📌 系统默认值**不进请求** —— 它们由召回层从链自身解出 (依赖 spot 与行权价网格) 并随出参
   * 下发。让调用方传默认值就等于让它先算一份, 那正是 FR-011 禁的「同一判据两处各算一份」。
   */
  readonly override: RetrievalOverride | null;
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
  /**
   * 隐含波动率, vendor 原样的**百分数** (`25.5` = 25.5%)。055 平值 IV 期限结构曲线的输入。
   *
   * 🚨 **🚫 MUST NOT 在任何一层再 ×100** —— 落库时就不做二次换算 (`schema.prisma`:「换算一次
   * 就再也说不清库里那个数是谁的口径」)。多乘一次会让曲线纵轴差两个数量级, 而**图照样画得出来**。
   * 📌 与 Δ 同为 `number`: 无量纲希腊值没有精度可丢, 且它只喂一条呈现用的曲线。
   */
  readonly iv: number | null;
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
  /**
   * 053 FR-009 —— **无覆盖口径**下的成员数。与 `candidates.length` (本次条件下的成员数) 成对
   * 使用, 让表达层的「筛后 N · 全量 M」算得出来。
   *
   * 🚨 **它为什么住在出参, 而不是由调用方现算**: 被当前条件挡下的链行**只存在于实现内部**
   * (召回层只吐视角归属非空的候选) ⇒ 用户收窄之后, 那些行在调用方那里**结构上取不回来**。
   * 📌 这是 053 FR-003 的 2026-08-14 裁定唯一松开的一处 —— **入参一字不动**, 只加这一个出参。
   *
   * 🚨 **MUST 由实现对同一批已取回的链行再判一次得出, 🚫 MUST NOT 为它多查一次库**: 数据层
   * 只下结构性谓词, 六维判据是取回后的纯函数 ⇒ 第二次判定是纯 CPU 的 `O(n)`。
   * 🚫 **MUST NOT 拿 052 的六维边际计数加总充当它** —— 边际口径下被两维同时挡下的腿两维都
   * 不计它, 且放宽一端放进来的腿本就不在无覆盖口径的成员里 ⇒ 加总**不等于**本数, 而两个数
   * 都出得来、都不会红。
   * 📌 未覆盖任何条件时它恒等于 `candidates.length` (实现直接短路, 不白跑第二趟)。
   */
  readonly memberCount: number;
}

/**
 * 整链检索入参 (055) —— **蓄意比 {@link LegRetrievalQuery} 窄三项**。
 *
 * 视角 / 候选上限 / 用户覆盖一个都不在: 它们全是**召回**的入参, 而这个口子要的是召回**之前**
 * 的那批行。把它们留在签名上等于让调用方以为可以在这里筛, 而筛出来的东西正是本方法不能给的。
 */
export interface LegChainQuery {
  readonly symbol: string;
  /** 请求时刻。DTE 基准恒为**交易所的今天**, 由实现按它算 (同 {@link LegRetrievalQuery.now})。 */
  readonly now: Date;
}

/** 该标的当前的**整条链** —— 未经召回、未排序、未截断。 */
export interface LegChainSnapshot {
  readonly chain: LegChainMeta;
  /**
   * 该期**全部**适格认沽腿的裸行, 含会被任何门槛挡下的那些。
   *
   * 🚨 **顺序无语义**, 🚫 MUST NOT 依赖它 —— 本方法不排序 (排序是召回下游的事)。
   */
  readonly legs: readonly LegChainRow[];
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

  /**
   * 取该标的当前的**整条链** (055 T005)。链未就绪返 `null`, 判据与上一个方法逐字相同。
   *
   * 🚨 **为什么它不能由 {@link retrieveCandidates} 顶替**: 候选集的成员判据是「至少进一个视角」
   * ⇒ 被权利金或活性门槛挡下的腿**结构上不在其中**。而 055 报表要在整条链上回答两个问题:
   * ① 网格总体是「过权利金门槛之后的整条链」(FR-005) —— 被**活性**挡下的腿 MUST 留在图上;
   * ② 一个格是「无合约」还是「有腿但全部太便宜」(FR-016) —— 后者的腿一条都不在候选集里,
   *    拿候选集数会把它们渲染成「该位置无合约」, 即 US2 反对的「给出错误信息而不是缺失信息」。
   * 两种错法**都渲染得出一张完整的网格**。
   *
   * 🚨 **本方法不做召回** —— 报表拿到裸行后在进程内自己跑 `leg-recall.rules.ts` 的层入口
   * (骨架一次、三视角归属一次, 均为纯 CPU)。🚫 MUST NOT 在这里补任何判据: 那就是给召回开第二个
   * 判据点, 而它**不会红**。
   * 📌 **不是第二条读链路** (plan D-CTX-1): 同一个 port、同一个实现、同一批查询, 只是不再把
   * 结果喂进召回就直接返回。
   */
  retrieveChain(query: LegChainQuery): Promise<LegChainSnapshot | null>;
}
