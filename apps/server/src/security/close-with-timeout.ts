/**
 * 给「自身不超时」的关停调用套一个上限。
 *
 * 存在理由（2026-08-02 实证，见 `docs/improvements/2026-08/08-02-bullmq-shutdown-order.md`）：
 * BullMQ 官方明确 `await worker.close()` 会**等所有 in-flight job 跑完（或失败）**，且
 * **该调用自身不超时**（https://docs.bullmq.io/guide/workers/graceful-shutdown）。
 * 没有上限 ⇒ 一个卡住的 job 就能让进程永远关不掉。
 *
 * 这与「连接先于 worker 被断开导致命令无限重试」是同一枚硬币的两面 —— 一个卡在重连、
 * 一个卡在等 job，表现都是**进程永不退出**。两条都必须堵：断连挂到关停第二段
 * （`onApplicationShutdown`，见 `marketdata-queue-connection.ts` 的 🚨 段），关停调用套本函数。
 *
 * 语义：**尽力而为，绝不抛**。关停路径上再抛异常只会把「关得慢」升级成「关不掉」；
 * 超时与失败都只记一行 warn 然后放行。BullMQ 侧的兜底是 stalled job 机制。
 *
 * EVIDENCE: 官方 https://docs.bullmq.io/guide/workers/stalled-jobs (2026-09-03 复核) ——
 * worker 拿到 job 会上锁并需周期续锁, 续不上即标 stalled, 「moved back to the waiting status
 * for another worker to process」。🚨 **但兜底不是无条件的**: 同一文档紧接着写「If a job
 * exceeds its maximum number of allowed stalls, it is moved to the failed set」——
 * 反复 stall 的 job 最终进 failed 而不是永远被接管。别把这条读成「关不掉也无所谓」。
 */
export async function closeWithTimeout(
  label: string,
  close: () => Promise<unknown>,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // 别让这个定时器把进程吊住 —— 它只是看门狗，不该成为「关不掉」的新原因。
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([close().then(() => 'closed' as const), timedOut]);
    if (outcome === 'timeout') {
      console.warn(`[shutdown] ${label}.close() 超过 ${timeoutMs}ms 未完成 — 放弃等待，继续关停`);
    }
  } catch (err) {
    console.warn(`[shutdown] ${label}.close() 抛错 — 忽略并继续关停:`, err);
  } finally {
    clearTimeout(timer);
  }
}
