// 055 T017 — 屏级降级合成（spec `§ Edge Cases` / `§ Assumptions`, `state_branch` 4/7/8/20）。
//
// 🚨 **「链未就绪」与「全被门槛挡下」MUST 可分辨**（`state_branch` 7）—— 两者都能印出一句
//    「没有可看的腿」，但前者是**采集还没轮到**（等就有）、后者是**这条链就长这样**（等也没有），
//    用户该做的事完全相反。合成同一态时屏上照样有话说，只是那句话对一半。
//
// 🚨 **「全被门槛挡下」照常渲染整张网格 + 页脚三计数**（mockup 帧 ⑦ 第二格）—— 只留一句话的话，
//    用户看不到「哪一档哪一列有腿被挡」，而三个计数还挂在页脚上，读起来像界面坏了。
//    ⇒ 它是**唯一一个「有说明句、但网格照画」**的态。
//
// 🚨 **页头 IV 分位按自己的四态独立降级，不被网格失败波及** —— 它来自另一条读链路（046 那份
//    读端，`FR-031`）。网格挂了 IV 明明读得到，把页头一起藏掉是**多丢一块能用的信息**。
//    ⇒ `header` 只看「响应到没到手」，与 `page` 无关。
//
// 🚫 **加载期 MUST NOT 画骨架网格** —— 列数取决于链上实际存在的到期日，加载前未知 ⇒ 骨架
//    必然跳变（先画 5 列、回来变 11 列）。宁可一个 spinner。
//
// 📌 **页态是链级的，与当前格值无关**（`state_branch` 4）：四种格值跑在不同召回集上，某一种下
//    一格都没有是**正确行为**（实测填充率 建仓 6.3%），那时骨架与行列标签照常渲染。
//    结构上做不到按格值分支 —— 本函数的入参里根本没有「当前格值」这一项。
import type { ChainReportGateCountsResponse, ChainReportResponse } from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

/**
 * 屏级页态。**六态**（五种降级 + 常态），两两不同。
 * 📌 `all_gated` 是降级态里唯一一个**网格照画**的 —— 它描述的是数据形态，不是「读不到」。
 */
export type ChainReportPageState =
  | 'loading'
  | 'read_failed'
  | 'chain_not_ready'
  | 'no_spot'
  | 'all_gated'
  | 'ready';

export interface ChainReportNotice {
  readonly title: string;
  readonly text: string;
  /** 🚨 只有**读故障**给重试 —— 未就绪与无现价是事实不是故障，重试一百次也一样。 */
  readonly retry: boolean;
}

export interface ChainReportComposition {
  readonly page: ChainReportPageState;
  /** 页头（IV 分位 + 现价 + 三时点）。🚨 只看响应到没到手，**与 `page` 无关**。 */
  readonly header: boolean;
  /** 网格 + 曲线 + 格值切换 + 读数面板这一整块。 */
  readonly grid: boolean;
  /** 屏中央那块说明（未就绪 / 无现价 / 读失败）；网格照画的两态 ⇒ `null`。 */
  readonly notice: ChainReportNotice | null;
  /** 「全被门槛挡下」压在网格**下方**的那两句；其余 ⇒ `null`。 */
  readonly gatedBanner: ChainReportNotice | null;
}

export interface ChainReportCompositionInput {
  readonly isPending: boolean;
  readonly isError: boolean;
  /** 尚未到手 ⇒ `null`（🚫 不造一个空报表）。 */
  readonly report: Pick<ChainReportResponse, 'state' | 'spot' | 'gateCounts'> | null;
}

function notice(title: string, text: string, retry: boolean): ChainReportNotice {
  return { title, text, retry };
}

/**
 * 「链上有合约、但没有一条落到图上」。`O(1)`。
 *
 * 🚨 `total > 0` 是必要条件 —— 一条腿都没有的链上说「全被门槛挡下」是**假话**（那时没有
 * 任何合约可谈门槛）。两种情形都印得出同一句，故这一刀必须显式。
 */
function isAllGated(counts: ChainReportGateCountsResponse): boolean {
  return counts.total > 0 && counts.valued === 0;
}

/**
 * 取数态 + 链级三字段 → 屏级合成。**判定顺序即语义**：取数过程 → 数据形态。`O(1)`。
 *
 * 📌 五种降级里前三个由**数据形态**决定（未就绪 / 无现价 / 全被挡），后两个由**取数过程**
 * 决定（加载 / 失败）——「服务端说读故障」归后者：它与网络失败对用户是同一件事。
 */
export function composeChainReport(input: ChainReportCompositionInput): ChainReportComposition {
  const { report } = input;
  const header = report !== null;

  if (report === null) {
    // 🚫 加载期不给骨架、也不给说明句（那时没有任何可说的事实）。
    if (input.isPending) {
      return { page: 'loading', header, grid: false, notice: null, gatedBanner: null };
    }
    return {
      page: 'read_failed',
      header,
      grid: false,
      notice: notice(COPY.degraded.readFailed.title, COPY.degraded.readFailed.text, true),
      gatedBanner: null,
    };
  }

  if (input.isError || report.state === 'read_failed') {
    return {
      page: 'read_failed',
      header,
      grid: false,
      notice: notice(COPY.degraded.readFailed.title, COPY.degraded.readFailed.text, true),
      gatedBanner: null,
    };
  }

  if (report.state === 'chain_not_ready') {
    return {
      page: 'chain_not_ready',
      header,
      grid: false,
      notice: notice(COPY.degraded.chainNotReady.title, COPY.degraded.chainNotReady.text, false),
      gatedBanner: null,
    };
  }

  // 🚨 现价是价外幅度的分母 ⇒ 缺了行轴无从定义。🚫 MUST NOT 渲染一个行标签全为占位的网格：
  //    那张表看起来是完整的，只是每一行说的都不是它自己。
  if (report.spot === null) {
    return {
      page: 'no_spot',
      header,
      grid: false,
      notice: notice(COPY.degraded.noSpot.title, COPY.degraded.noSpot.text, false),
      gatedBanner: null,
    };
  }

  if (isAllGated(report.gateCounts)) {
    return {
      page: 'all_gated',
      header,
      // 🚨 网格照画 —— 说明句压在它**下方**，🚫 不取代它。
      grid: true,
      notice: null,
      gatedBanner: notice(COPY.degraded.allGated.title, COPY.degraded.allGated.text, false),
    };
  }

  return { page: 'ready', header, grid: true, notice: null, gatedBanner: null };
}
