import type { AnchorColdStartUseCase } from '../../src/marketdata/anchor-cold-start.usecase';

/**
 * `MarketdataSyncWorker` 的冷启动依赖占位 (060 T007)。
 *
 * 手工 `new MarketdataSyncWorker(...)` 的 IT 全是**维度**路由用例, 一条
 * `sync:anchor-cold-start` 都不会入队 ⇒ 这个桩**被调到就是路由串了**。
 *
 * 故它不返回假数据而是**直接抛** —— 返回一个无害的空结果会把「维度 job 被路由进冷启动」
 * 这种事故变成一条绿测试。
 */
export function coldStartUnused(): AnchorColdStartUseCase {
  const boom = (): never => {
    throw new Error('本 IT 不该路由到 AnchorColdStartUseCase (维度路由用例)');
  };
  return { run: boom, recordRetryExhausted: boom } as unknown as AnchorColdStartUseCase;
}
