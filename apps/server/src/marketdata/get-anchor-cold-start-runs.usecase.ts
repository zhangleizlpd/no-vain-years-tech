import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import { coldStartNeedsAttention } from './anchor-cold-start.rules.js';

/**
 * 072 冷启动结局读侧。`anchor_cold_start_run` 是 marketdata 自有表 ⇒ **R1, 零跨 ctx 面**。
 *
 * 🚨 **端点落在 marketdata 而不是折进 optionsdesk 的待审详情**, 三条理由:
 * ① 冷启动结局**不是采纳的决策输入**, 是采纳**之后**才看的东西 —— 折进列表会让每次请求为
 *    一个对绝大多数行毫无意义的 join 买单 (只有刚建的锚有 run 行, 且只有短短一阵);
 * ② 两个面的刷新节奏**不相容**: 冷启动要在串行队列排空前 15–30s 轮询一次, 待审列表走全局
 *    30s staleTime 且不轮询 —— 一个响应对象扛不住两种节奏, 必有一个是错的;
 * ③ 它的主键是 `anchor_id`, 走待审条目绕一跳还得多一次 join, 而 045/046 的锚屏日后要的是
 *    同一份数据 —— marketdata 端点直接就能服务它们, 待审专属的端口不行。
 *
 * 🚨 **查不到的 anchorId 就是不返回, MUST NOT 编一个占位 outcome**: 「还没出行」= 排队中或
 * 正在跑, 而十档结局**全是终态**。`anchor-approve.sh watch` 的 `got/expect` 进度计数正是靠
 * 「缺席有意义」才成立的 —— 编个 pending 塞进去, 那个语义当场消失。
 */
export interface AnchorColdStartRunView {
  anchorId: bigint;
  ticker: string;
  outcome: string;
  reason: string | null;
  /** 本次瞄准的交易日; 早退分支 (市场未开通 / 日历缺行) 定位不到 ⇒ null。 */
  targetSession: Date | null;
  lastRunAt: Date;
  /** 是否需要人工介入 —— 判据单点在 `anchor-cold-start.rules.ts`, 不在呈现层。 */
  needsAttention: boolean;
}

/** 单次可查的锚上限 —— 与待审箱一次能采纳的量级同数量级, 纯常识性防护。 */
export const COLD_START_RUN_QUERY_CAP = 100;

@Injectable()
export class GetAnchorColdStartRunsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(anchorIds: readonly bigint[]): Promise<AnchorColdStartRunView[]> {
    const ids = [...new Set(anchorIds)].slice(0, COLD_START_RUN_QUERY_CAP);
    if (ids.length === 0) return [];

    const rows = await this.prisma.anchorColdStartRun.findMany({
      where: { anchorId: { in: ids } },
      orderBy: { lastRunAt: 'asc' },
    });

    return rows.map((row) => ({
      anchorId: row.anchorId,
      ticker: row.ticker,
      outcome: row.outcome,
      reason: row.reason,
      targetSession: row.targetSession,
      lastRunAt: row.lastRunAt,
      needsAttention: coldStartNeedsAttention(row.outcome),
    }));
  }
}
