import { Injectable } from '@nestjs/common';
import { exchangeLocalDateTime } from '../marketdata/session-clock';
import { PrismaService } from '../security/prisma.service';

/**
 * 083 US4 —— 冷启动结局页**券商历史补齐状态**读端 (FR-018; plan D12)。
 *
 * 🚨 **只读** (Guardrail 1): 零写路径; 🚫 在这里触发补齐 (补齐记录由 082
 * `broker-history-backfill.subscriber.ts` 在新建锚时插入, `target` = 锚 ticker, plan V6)。
 *
 * 🚨 **账号隔离在查询条件里** (Guardrail 2): `where` 带 `accountId`。
 *
 * 对每个请求的 ticker 取该账号 `kind='backfill'` ∧ `target=ticker` 的**最新一条** (`createdAt` 降序):
 * 同一 ticker 先失败后重试成功, 要报的是成功那条。无记录的 ticker 不出现 (mobile 显示「未触发」)。
 */

export interface BrokerBackfillRunView {
  ticker: string;
  status: string;
  /** 与状态对应的时刻 (见 {@link instantOf}); 缺失 ⇒ null。 */
  at: Date | null;
  /** 同上, 交易所当地 `YYYY-MM-DD HH:mm:ss` (市场取 ticker 前缀)。 */
  atLocal: string | null;
}

interface RunInstants {
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextAttemptAt: Date | null;
}

/** 状态 → 该展示的时刻: 终态取结束、执行中取开始、待执行取下次尝试; 其余状态 ⇒ null。O(1)。 */
function instantOf(run: RunInstants): Date | null {
  switch (run.status) {
    case 'succeeded':
    case 'failed':
      return run.finishedAt;
    case 'running':
      return run.startedAt;
    case 'pending':
      return run.nextAttemptAt;
    default:
      return null;
  }
}

@Injectable()
export class ListBrokerBackfillRunsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 复杂度: 1 次查询 (`target in (...)`, 排序在 DB) + O(r) 按 target 取首条 + O(n) 按请求顺序输出;
   * r = 命中的补齐记录数, n = 去重后的 ticker 数 (≤ 50, 由 DTO 限定)。
   */
  async execute(accountId: bigint, tickers: readonly string[]): Promise<BrokerBackfillRunView[]> {
    const requested = [...new Set(tickers)];
    const runs = await this.prisma.brokerSyncRun.findMany({
      where: { accountId, kind: 'backfill', target: { in: requested } },
      // `id` 只做同一时刻并列时的确定性兜底, 🚫 替代 `createdAt` (插入顺序不是记录新旧)。
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        target: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        nextAttemptAt: true,
      },
    });

    const latest = new Map<string, RunInstants>();
    for (const run of runs) {
      if (!latest.has(run.target)) latest.set(run.target, run);
    }

    return requested.flatMap((ticker) => {
      const run = latest.get(ticker);
      if (run === undefined) return [];
      const at = instantOf(run);
      // ticker 形态 `<market>:<code>` 已由 DTO 校验 (`^(us|hk):`)。
      const market = ticker.slice(0, ticker.indexOf(':'));
      return [
        {
          ticker,
          status: run.status,
          at,
          atLocal: at === null ? null : exchangeLocalDateTime(market, at),
        },
      ];
    });
  }
}
