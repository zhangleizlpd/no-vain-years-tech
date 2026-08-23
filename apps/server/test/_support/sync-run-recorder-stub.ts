import type { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';

/**
 * `MarketdataSyncWorker` 的 `SyncRunRecorder` 依赖占位 —— **给没有 PG 的 IT 用**（#165 起构造器第 6 位）。
 *
 * ## 🚨 它与 `coldStartUnused()` 刻意**不同**：那个抛，这个返 0
 *
 * 两条理由，缺一它就该改成抛：
 *
 * 1. **它在正常路径上就会被调**。`processDimension` 每个维度 job 开工前都会走一次
 *    `convergeInterruptedRuns(job.id, SUPERSEDED_BY_RETRY)`（#137 收敛触发点 A）——
 *    不是异常出口。而 `coldStartUnused` 守的是「维度 job 被路由进冷启动」，那**是**事故。
 * 2. **抛也没用**。`convergeInterruptedRuns` 里那次调用外面就是 `try/catch`，源码注释写明
 *    「🚨 不抛 …… 失败走 WARN」⇒ 桩抛出去会被吞成一条 WARN，测试照样绿。
 *    一个吞得掉的守卫等于没有守卫，不如老实返稳态值。
 *
 * 返 `0` = **没有僵尸行可收**，正是「全新 Redis + 无 PG」的真实稳态（源码：0 行不打 log）。
 *
 * 🚫 **要验收敛行为本身的用例 MUST NOT 用本桩** —— 那种用例得有真 PG，走
 * `new SyncRunRecorder(prisma)`（先例见 `marketdata.backfill-cli.it.spec.ts`）。
 */
export function syncRunRecorderNoop(): SyncRunRecorder {
  return { convergeInterrupted: async (): Promise<number> => 0 } as unknown as SyncRunRecorder;
}
