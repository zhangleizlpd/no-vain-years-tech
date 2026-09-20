import type { Prisma } from '../generated/prisma/client';

/**
 * 085 T001 **FX 取数 port** —— optionsdesk 自持的汇率来源接缝 (plan D0 / D3)。
 *
 * ADR-0043 §4 把 port 三分 (自有表无 port / 3rd-party 留 port / 跨 ctx 发布契约留 port);
 * 汇率属第二类 —— 外部 vendor I/O, 留 port 使折算判据能脱离真 vendor 单测, 并让 mock 档绑
 * **调用即抛**的拒绝壳 (T004)。
 *
 * 🚨 **住本 ctx, 不经 marketdata**: FX 当前单消费者 (持仓列表的展示币种折算) ⇒ 按 ADR-0058
 * 准入「≥2 个 bounded context 复用才进 `integrations/`」留在 optionsdesk (plan Gate 0.4)。
 * 第二个 ctx 要汇率时回 ADR-0054 #2 + ADR-0058 重审「升 `integrations/` 还是升 marketdata port」。
 */

/** 折算涉及的币种值域 (spec Clarifications 定的三档)。 */
export const FX_CURRENCIES = ['USD', 'HKD', 'CNY'] as const;

export type FxCurrency = (typeof FX_CURRENCIES)[number];

/**
 * **直接向 vendor 请求的三个币对** —— 反向币对 (`CNYUSD` 等) 由 `invertRate` 取倒数得出。
 *
 * EVIDENCE: 反向三对 (`whCNYHKD` / `whHKDUSD` / `whCNYUSD`) 全 MISS —— plan 作者 2026-09-16
 * PoC P3 实拉 (`specs/085-optionsdesk-display-currency/plan.md` §plan 前验证)。
 *
 * 🚫 **链式交叉计算** (如 `USDHKD` 用 `USDCNY ÷ HKDCNY` 算): 腾讯三角自身不闭合约 0.057%、
 * 三对时间戳可差 2 分钟 (同上 PoC) ⇒ 交叉出来的数字**任何源都没直接给过**, 而它照样算得出来、
 * 看起来也合理。
 */
export const FX_PAIRS = ['USDCNY', 'HKDCNY', 'USDHKD'] as const;

export type FxPair = (typeof FX_PAIRS)[number];

/** 一个币对的即期汇率 + **我们自己的**采集时刻。 */
export interface FxRate {
  readonly pair: FxPair;
  /** 即期汇率 (1 个 from 币兑多少 to 币); 金额一律 `Prisma.Decimal`, 不经 Number 中转。 */
  readonly rate: Prisma.Decimal;
  /**
   * **我们采到这个数的时刻** (ingestion time, 绝对时刻 / ADR-0066 第二条轴)。
   *
   * 🚨 **🚫 用 vendor 自报的时间戳** (腾讯 `f5` / 新浪时间戳) —— 那是 vendor **刷新该条记录**
   * 的时刻: plan 作者 2026-09-16 的 3.5 分钟 10 轮采样中 `USDCNY` 的 `f5` 多次推进而 `f3`
   * 纹丝不动 (EVIDENCE: plan §plan 前验证「两条新发现」①)。照直写就是拿新时间戳给旧数字背书,
   * 而屏幕上一切正常 (plan D5)。vendor 时间戳只进日志作证据。
   */
  readonly capturedAt: Date;
}

/** DI token (沿 `leg-retrieval.port.ts` 等既有 port 的 `Symbol` 体例)。 */
export const FX_RATE_PORT = Symbol('FX_RATE_PORT');

export interface FxRatePort {
  /**
   * 取 {@link FX_PAIRS} **全部三对**的当前汇率。
   *
   * 🚨 **蓄意无入参**: 一次请求即可取全三对 (plan 作者 2026-09-16 PoC P1 实拉:
   * `qt.gtimg.cn/q=whUSDCNY,whHKDCNY,whUSDHKD` 单请求返 3 条) ⇒ 缓存天然是**单键**语义
   * (plan D4「一格存三对」)。留一个 `pairs` 参数就等于给缓存造出第二个维度, 而那个维度
   * 在真实调用点只会取到同一个值。
   *
   * 🚨 **少一对即抛, 不返部分结果** —— 部分结果会让那一屏悄悄走降级路径 (plan D3 解析契约①)。
   * 全源失败同样抛, 由 use case catch 成降级态 (T006)。
   */
  fetchRates(): Promise<readonly FxRate[]>;
}
