// 064 T008 — 区块级档位条 + 行级档位标的纯函数（FR-009/FR-010/FR-013/FR-014, plan §D10）。
// 组件与版面在 `leg-tier-bar.tsx`；本文件零 JSX、零 IO，判定全部可 vitest 覆盖。
//
// 🚨 **粒度即档位**（FR-010）：实时档的时点是**我方采集时刻**（含秒），收盘档的时点是该批快照
//    自身的**归属交易日**。两档混成一种形态**不会红任何一处** —— 收盘档带上时分秒会被读成
//    此刻的盘口，实时档只给日期则把唯一要紧的那件事抹掉了。
//
// 🚨 **OI 列恒取 `oiAsOf`，MUST NOT 取区块级 `quoteAsOf`**（FR-014）：美股期权持仓量盘前更新、
//    盘中冻结 ⇒ 实时档下 OI 三列仍是收盘值，归属日照旧是 T−1。区块级翻成 realtime 之后
//    `quoteAsOf` 是**今天此刻**，拿它去标 OI 列就是用标签掩盖真实归属，而两个数都渲染得出来。
//
// 🚨 **配色两条禁令**（plan §D10 / tasks Guardrail 9 · 10）：
//    ① 本 DS 里 `--nvy-info` **就是** `--nvy-primary`（`info-soft` = `primary-soft`）⇒ 品牌蓝
//       归档位（实时）一家，别的语义拿它会撞脸。
//    ② `--nvy-quote-up` / `--nvy-quote-down` **一处不用** —— 档位不是涨跌方向，误用会让「实时」
//       被读成「涨」。机械防线是 {@link legTierBarClassNames}（值面扫描，见其注释）。
import type {
  LegResponsePriceKind,
  LegTableResponsePriceKind,
  LegTableResponseRealtimeDegrade,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { LegBlockState } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

/**
 * 区块级档位（契约值域 `'eod_close' | 'realtime'`，与每腿的那个是**同值域不同数**）。
 * 🚫 MUST NOT 在本仓再造第二套档位枚举 —— 两套会让「实时」在同一个响应里有两个来源。
 */
export type LegBlockPriceKind = LegTableResponsePriceKind;

/** 行级档位。orval 为两处各生成一个同值域的字面量联合，结构上互相可赋值。 */
export type LegRowPriceKind = LegResponsePriceKind;

/**
 * 链级降级标（064 T007a 契约新增，**已含 `null`**）——「本该给实时却没给成」。
 *
 * 🚨 **直接吃生成类型**，🚫 MUST NOT 在 mobile 侧照抄一套字面量：契约那边加一个类别时，
 *    抄来的那份不会红，只会**静默走到 fallback**，于是新出的那类故障在屏上长得像正常收盘档。
 * 📌 值域不含 `partial_miss`（服务端已用 `Exclude` 排除）—— 部分缺失是**逐行**的事，
 *    由 {@link LegQuoteTierInput.eodRowCount} 那一路承载。
 */
export type LegBlockRealtimeDegrade = LegTableResponseRealtimeDegrade;

/** 非 null 的降级类别 —— 文案穷举 `Record` 的键（契约加一类即编译红）。 */
export type LegDegradeKind = NonNullable<LegBlockRealtimeDegrade>;

// ═══════════════════ ① 两档的时间格式化 ═══════════════════

/**
 * ISO 时刻 → 设备本地 `HH:mm:ss`；非法串 / 缺失 → `null`（调用方据此不渲染，绝不渲染裸时点）。
 *
 * 🚨 **本地时区**（同 `~/format/as-of` 的 `clockHm`）—— 这是给人读的墙钟：境内用户盯美股盘中，
 *    看到的必须是自己表上的钟点。
 * 🚨 **秒不能省**（FR-010 / mockup 帧 ①）：本片的时点是「这一批数取于何时」，下拉刷新后它要
 *    向前推进得**看得见**；`~/format/as-of` 的 `HH:mm` 服务的是 061 雷达那种分钟级面，两处
 *    刻意不同粒度，🚫 别为「统一」把这里降成分钟。
 * 复杂度 O(1)。
 */
export function formatQuoteClock(asOf: string | null | undefined): string | null {
  if (!asOf) return null;
  // 🚨 **先卡形态再解析**：`new Date('2026-08-18')` 是合法的（按 UTC 零点解），于是一个纯交易日
  //    串会解出一个**像模像样的时刻**（境内渲成 `08:00:00`）—— 那正是「昨收伪装成此刻」。
  //    形态不对一律 null，让调用方落到显式未就绪。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(asOf)) return null;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 交易日 `YYYY-MM-DD` → 档位条上的短形 `MM-DD`；非法 / 缺失 → `null`。
 *
 * 📌 完整业务日由**区块头**那一行承担（`legAsOfLabel`），档位条只求一眼认得出是哪天 ——
 * 同一个完整日期在 30px 的条里再写一遍只会挤掉原因那一格。复杂度 O(1)。
 */
export function formatQuoteSessionDay(asOf: string | null | undefined): string | null {
  if (!asOf) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(5, 10) : null;
}

// ═══════════════════ ② 区块级档位条 ═══════════════════

/**
 * 档位条四形态。
 *
 * 🚨 **`eod_close` 与 `degraded` 是同一个 `priceKind` 下的两件事**（064 T008a）：前者是境内
 *    白天的常态（美股休市，天天如此），后者是「美股开着、我们却没给成实时」。T008 时契约还
 *    分不出这两者，收盘档只能走中性 + 一句两可的文案；T007a 下发 `realtimeDegrade` 之后
 *    这一格才真正分得开。
 * 🚫 **MUST NOT 给所有 `eod_close` 刷告警底** —— 那样境内用户白天每次打开都看见它，
 *    「永远为真的告警等于没有告警」（同 `legAsOfLabel` / `freshnessOf` 的同款长注）。
 *    机器判据是 {@link legQuoteTier} 的核心反例单测（收盘档 + 降级标 `null` ⇒ 零 warn token）。
 */
export type LegQuoteTierVariant = 'realtime' | 'eod_close' | 'degraded' | 'not_ready' | 'busy';

/**
 * 这一批的在途相位（064 T009 / FR-022）。
 *
 * 🚨 **首屏与刷新中是两件事，MUST NOT 合并**：首屏屏上**还没有表**（走等待态，且刻意不先出
 *    一份收盘档），刷新中屏上**有一批完整的表**（保留不动、不遮罩不置灰，到齐后整体替换）。
 *    合并成一个 `isLoading` 之后，两者只能共用一套文案与一种处置，而它们该说的话正相反。
 */
export type LegQuotePhase = 'settled' | 'first_load' | 'refreshing';

/**
 * 区块态 + 刷新中 → 相位。复杂度 O(1)。
 * 📌 `loading` 优先：`isRefreshing` 在首屏恒 `false`（hook 侧已由 `isPending` 分开），
 *    这里再判一次是**结构冗余不是重复判据** —— 它让本函数对任意入参组合都有确定输出。
 */
export function legQuotePhase(block: LegBlockState, isRefreshing: boolean): LegQuotePhase {
  if (block === 'loading') return 'first_load';
  return isRefreshing ? 'refreshing' : 'settled';
}

export interface LegQuoteTierInput {
  /** 区块级档位；契约未到手 ⇒ `null`（**不默认成收盘档**，那是替服务端作答）。 */
  readonly priceKind: LegBlockPriceKind | null;
  /** 区块级时点：实时 ⇒ ISO 时刻（含秒）；收盘 ⇒ 交易日 `YYYY-MM-DD`。 */
  readonly quoteAsOf: string | null;
  /** 🚨 区块标 realtime **而行标 eod_close** 的条数（FR-011 逐行降级）；其余情形恒 0。 */
  readonly eodRowCount: number;
  /**
   * 链级降级标（契约 `realtimeDegrade`）——「本该给实时却没给成」，正常收盘档恒 `null`。
   *
   * 🚨 **必填、蓄意不给默认值**：默认成 `null` 的话，哪天有人接漏了这根线，屏上拿到的是
   *    「一切正常」的中性态 —— 而那正是本 feature 要消灭的那张脸（表看着正常、数是昨天的）。
   *    必填让「忘了接」当场编译红，而不是在真出事那天才被发现。
   * 🚫 MUST NOT 由 {@link priceKind} 反推：收盘档在两种情形下都是同一个值。
   */
  readonly realtimeDegrade: LegBlockRealtimeDegrade;
  /** 在途相位（FR-022）。缺省 `'settled'` —— 只有 T009 的两条等待路径要显式传。 */
  readonly phase?: LegQuotePhase;
}

export interface LegQuoteTierView {
  variant: LegQuoteTierVariant;
  /** 「实时」/「收盘档」/「未就绪」。 */
  name: string;
  /** 时刻含秒（实时）/ `MM-DD`（收盘）/ `null`（未就绪 —— **不给看似正常的时点**）。 */
  stamp: string | null;
  /**
   * 时点**前面**的限定语（刷新中的「屏上这批仍是」）；其余形态恒 `null`。
   * 🚨 位置是语义的一部分：跟在时点后面会被读成「这批取于 X 之后」，而它说的是「屏上这个数
   *    还是 X 那一批的」。
   */
  note: string | null;
  /**
   * 🚨 **收盘档与未就绪两档恒非空**（FR-011：显式标降级且说得出所以然）——
   *    🚫 MUST NOT 退化成「加载失败」那种零信息文案。实时档只在**部分缺失**时非空。
   */
  reason: string;
  container: string;
  nameClass: string;
  stampClass: string;
  dotClass: string;
}

/** 三形态的视觉（穷举 `Record` —— 形态加一格即编译红）。 */
const TIER_TONE: Readonly<
  Record<
    LegQuoteTierVariant,
    Pick<LegQuoteTierView, 'container' | 'nameClass' | 'stampClass' | 'dotClass'>
  >
> = {
  // 实时 = 品牌蓝（「活的」）。
  realtime: {
    container: 'bg-brand-soft',
    nameClass: 'text-brand-500',
    stampClass: 'text-brand-500',
    dotClass: 'bg-brand-500',
  },
  // 收盘 = 中性（「静的」），刻意不抢眼：它是境内白天的常态。
  eod_close: {
    container: 'bg-surface-alt',
    nameClass: 'text-ink-muted',
    stampClass: 'text-ink-muted',
    dotClass: 'bg-line-strong',
  },
  // 降级 = 与未就绪**同一套 warn 视觉**（064 T008a）。🚫 蓄意不给它第三种颜色：这两者对用户
  // 是同一件事的两种成因（「屏上这个数不是你以为的那个」），多一种色只会多一层要查的图例；
  // 区分它们的是 `reason` 那一句话，不是底色。
  degraded: {
    container: 'border-l-[3px] border-warn bg-warn-soft',
    nameClass: 'text-ink',
    stampClass: 'text-ink',
    dotClass: 'bg-warn',
  },
  // 未就绪 = warning 底 + 3px 左边框 + **正文色**的字。🚫 不用 err/danger —— 这是被设计过的
  // 已知状态，不是错误（同 046 起的「数据缺口体系 ≠ 红标体系」纪律）。
  not_ready: {
    container: 'border-l-[3px] border-warn bg-warn-soft',
    nameClass: 'text-ink',
    stampClass: 'text-ink',
    dotClass: 'bg-warn',
  },
  // 在途 = 与收盘档同一档中性（mockup `.tier-busy` 逐值）。🚫 **蓄意不给它自己的颜色** ——
  // 「正在取」是过程不是结论，染成品牌蓝会让人以为已经拿到了实时。
  busy: {
    container: 'bg-surface-alt',
    nameClass: 'text-ink-muted',
    stampClass: 'text-ink-muted',
    dotClass: 'bg-line-strong',
  },
};

/**
 * 四类降级各自的原因（穷举 `Record` —— 契约的值域加一个类别，这里漏配当场编译红）。
 *
 * 🚨 **一类一句**（FR-011）：前两条用户自己能动手（收窄条件 / 下拉重试），后两条只能等 ——
 * 收敛成一句通用文案就等于把「你现在能做什么」抹掉，而那张表照样渲染得出来。
 */
const DEGRADE_REASON: Readonly<Record<LegDegradeKind, string>> = {
  window_over_cap: COPY.tierDegradeOverCap,
  window_basis_stale: COPY.tierDegradeBasisStale,
  source_unavailable: COPY.tierDegradeSourceDown,
  gate_unknown: COPY.tierDegradeGateUnknown,
};

/** 时点的**粒度随它自己的档位走**（刷新中要报「上次」那一批的时点，档位没变）。O(1)。 */
function stampOf(priceKind: LegBlockPriceKind | null, quoteAsOf: string | null): string | null {
  return priceKind === 'realtime' ? formatQuoteClock(quoteAsOf) : formatQuoteSessionDay(quoteAsOf);
}

/**
 * 区块级档位条的呈现决策。复杂度 O(1)。
 *
 * 判定序（**先看有没有可用时点**，再看档位）：
 * 1. `priceKind === 'realtime'` 且时点解得出时刻 → 实时档（部分缺失时带出条数与去处）。
 * 2. `priceKind === 'eod_close'` 且时点解得出交易日 → 再看降级标：`null` → 收盘档常态
 *    （中性 + 原因）；非 `null` → 降级态（warn 视觉 + **按类别**的具体原因）。
 * 3. 其余（契约未到手 / 时点缺失 / 粒度对不上档位）→ 未就绪，**不渲染任何时点**。
 *
 * 🚨 第 3 支覆盖的是「档位说实时、时点却不是个时刻」这类**自相矛盾**的响应：宁可显式未就绪，
 *    也 MUST NOT 把交易日当成时刻渲上去 —— 那正好制造出「昨收伪装成此刻」的那张表。
 */
export function legQuoteTier(input: LegQuoteTierInput): LegQuoteTierView {
  // 🚨 在途相位**压过档位**（FR-022）：这一批还没到齐，屏上的档位说的是**上一批**的事 ——
  //    在它上面继续渲「实时 21:47:32」会让人以为时点已经推进了。
  if (input.phase === 'first_load') {
    return {
      variant: 'busy',
      name: COPY.tierBusyFirstLoad,
      // 🚫 首屏不给任何时点 —— 屏上还没有任何一批数，写上去就是凭空的。
      stamp: null,
      note: null,
      reason: COPY.tierBusyFirstLoadNote,
      ...TIER_TONE.busy,
    };
  }
  if (input.phase === 'refreshing') {
    return {
      variant: 'busy',
      name: COPY.tierBusyRefreshing,
      // 「上次」的时点 —— 屏上这批仍是它，粒度照旧随**它自己的**档位走。
      stamp: stampOf(input.priceKind, input.quoteAsOf),
      note: COPY.tierBusyKeptNote,
      reason: '',
      ...TIER_TONE.busy,
    };
  }
  if (input.priceKind === 'realtime') {
    const stamp = formatQuoteClock(input.quoteAsOf);
    if (stamp !== null) {
      return {
        variant: 'realtime',
        name: COPY.tierLive,
        stamp,
        note: null,
        // 逐行降级的**去处**（FR-009：档位逐行成立）—— 整页统一标实时与整页统一降级都渲染得出
        // 一张完整的表，只有把「有几条不是此刻的」说出来，人才知道要去行内找那枚「收」标。
        reason: input.eodRowCount > 0 ? COPY.tierPartialMiss(input.eodRowCount) : '',
        ...TIER_TONE.realtime,
      };
    }
  }
  if (input.priceKind === 'eod_close') {
    const stamp = formatQuoteSessionDay(input.quoteAsOf);
    if (stamp !== null) {
      const degrade = input.realtimeDegrade;
      // 🚨 **核心分叉**（T008a）：同一个 `eod_close`，降级标 `null` 是常态、非 null 才是告警。
      //    🚫 MUST NOT 按 `priceKind` 一刀切 —— 那会让境内白天的每一次打开都染上告警底。
      if (degrade === null) {
        return {
          variant: 'eod_close',
          name: COPY.tierEod,
          stamp,
          note: null,
          reason: COPY.tierEodReason,
          ...TIER_TONE.eod_close,
        };
      }
      return {
        variant: 'degraded',
        // 📌 名字仍是「收盘档」—— 屏上确实就是收盘盘口，改名字等于换了个说法说同一件事；
        //    「本该是实时」那半句由 warn 视觉 + `reason` 承担。
        name: COPY.tierEod,
        stamp,
        note: null,
        reason: DEGRADE_REASON[degrade],
        ...TIER_TONE.degraded,
      };
    }
  }
  return {
    variant: 'not_ready',
    name: COPY.tierNotReady,
    stamp: null,
    note: null,
    reason: COPY.tierNotReadyReason,
    ...TIER_TONE.not_ready,
  };
}

// ═══════════════════ ③ 两个列头副标：OI 归属日 + 成交量口径 ═══════════════════

/** 列头副标要用的三元组（结构子集吃 —— 测试可造小 fixture，且**两个时点必须同时在场**）。 */
export interface LegQuoteColumnInput {
  readonly priceKind: LegBlockPriceKind | null;
  /** 区块级时点。🚨 **OI 列不许碰它**，它在实时档下是今天此刻。 */
  readonly quoteAsOf: string | null;
  /** OI 自身的归属交易日（契约独立出参）。 */
  readonly oiAsOf: string | null;
}

export interface LegQuoteColumnSubs {
  /** OI 列副标 —— 恒取 `oiAsOf`。 */
  oi: string;
  /** 成交量列副标 —— 实时档「至此刻」/ 收盘档「当日」（FR-013）。 */
  vol: string;
}

/**
 * OI / 成交量两列的列头副标。复杂度 O(1)。
 *
 * 🚨 **本函数同时吃到两个时点是刻意的**：它是 FR-014 的机器判据落点 —— 单测喂两个不同的时间，
 *    断言 OI 那格取的是 `oiAsOf`。若哪天有人改成读 `quoteAsOf`，实时档下 OI 列会跟着变成今天，
 *    而那一列的数字一个都没变 ⇒ **屏幕上不会有任何东西红**。
 * 🚨 **档位未知时成交量副标走「当日」**（保守）：「至此刻」是实时档才成立的口径，契约还没到手就
 *    先挂上去，等于替服务端作答。
 */
export function legQuoteColumnSubs(input: LegQuoteColumnInput): LegQuoteColumnSubs {
  const day = formatQuoteSessionDay(input.oiAsOf);
  return {
    oi: COPY.oiAsOfSub(day ?? COPY.noValue),
    vol: input.priceKind === 'realtime' ? COPY.volSubRealtime : COPY.volSubEod,
  };
}

// ═══════════════════ ④ 行级档位标 ═══════════════════

/**
 * 该行要不要挂「收」角标 + 把 bid/ask 数字降为次级墨色。复杂度 O(1)。
 *
 * 🚨 **只在「区块实时、该行收盘」时为真**（FR-009 的逐行档位在此落地）。
 * 🚫 **MUST NOT 在整表收盘档时逐行打标** —— 那时每一行都是收盘档，一行一枚角标只是噪点，
 *    且把 bid 数字全体降灰会**吃掉 053 的四档色**（档位色只着 bid 单元格，是那一片的全部信号）。
 *    整表档位由档位条统一承担，行内不重复表达。
 */
export function legRowEodMarked(
  blockPriceKind: LegBlockPriceKind | null,
  rowPriceKind: LegRowPriceKind,
): boolean {
  return blockPriceKind === 'realtime' && rowPriceKind === 'eod_close';
}

/**
 * 区块标 realtime 而行标 eod_close 的条数（喂 {@link legQuoteTier} 的 `eodRowCount`）。
 * 复杂度 O(n)，n = 本视角腿数。
 */
export function legEodRowCount(
  blockPriceKind: LegBlockPriceKind | null,
  legs: readonly { readonly priceKind: LegRowPriceKind }[],
): number {
  if (blockPriceKind !== 'realtime') return 0;
  let n = 0;
  for (const leg of legs) if (leg.priceKind === 'eod_close') n += 1;
  return n;
}

// ═══════════════════ ⑤ 配色禁令的机械防线 ═══════════════════

/**
 * 本模块**实际会吐到屏幕上**的全部 class 串（Guardrail 9 / 10 的值面扫描用）。
 *
 * ⚠️ 断言面刻意是**值面而非源码 grep**：Small 档禁磁盘 I/O，且 `quote` / `info` 字样合法地出现在
 * 上方警示注释里 —— 文本 grep 必假红，还会诱人删注释来「修绿」。值面还更强：间接拼出来的
 * class 也逃不掉。复杂度 O(形态数) = O(1)。
 */
export function legTierBarClassNames(): string[] {
  const out: string[] = [];
  for (const tone of Object.values(TIER_TONE)) {
    out.push(tone.container, tone.nameClass, tone.stampClass, tone.dotClass);
  }
  return out;
}
