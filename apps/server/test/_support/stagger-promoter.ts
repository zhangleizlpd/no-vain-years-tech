import type { Queue } from 'bullmq';
import { MARKET_SYNC_STAGGER } from '../../src/marketdata/sync-flow-assembler.js';

/**
 * 整轮 tick 的 e2e IT 用: 把**采集错开**那几个 delay 提前, 免去真等墙钟。
 *
 * 🚨 为什么需要它 (075 T005): `option_daily_snapshot` 在装配期被挂上 30 分钟的错开 delay,
 * 而这个 delay 是在上游 `option_contract` 完成的**那一刻**才由 BullMQ 写进 `delayed` 集的
 * (组树时 job 先处于 `waiting-children`) ⇒ 测试没法在 tick 之后一次性把它摘掉, 只能在跑的
 * 过程中盯。整夜链路的 IT 断的是**拓扑与执行序**, 不是错开时长 —— 错开本身由
 * `src/marketdata/sync-flow-stagger.it.spec.ts` (真 Redis 时序) 单独钉。
 *
 * 🚫 **蓄意不无差别 promote 全部 delayed job**: 重试 backoff 与预算截断顺延也在同一个
 * `delayed` 集里, 而 tier / night e2e 两个 IT 自己就在断言那些 job 的 delayed 态。判据收窄
 * 成「job 名 = 错开表里的下游维度 **且** `opts.delay` 恰为该市场的取值」, 只认本片挂上去的
 * 那一个。
 */
const STAGGERED = new Set(
  MARKET_SYNC_STAGGER.filter((r) => r.delayMs > 0).map((r) => `sync:${r.downstream}:${r.delayMs}`),
);

/** 起轮询器, 返回停止函数 (幂等)。表里全为 0 时它整轮不做任何事。 */
export function startStaggerPromoter(queue: Queue, intervalMs = 20): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        for (const job of await queue.getDelayed()) {
          if (STAGGERED.has(`${job.name}:${job.opts.delay ?? 0}`)) await job.promote();
        }
      } catch {
        // 队列被 obliterate / 连接关闭途中的竞态 —— 轮询器不该把测试搞红。
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
