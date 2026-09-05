/**
 * 期权链发现端口 (#361) —— 回答「**这个市场的链发现，最近一次把工作集问全，是什么时候**」。
 *
 * ## 为什么需要它
 *
 * 消费方 (optionsdesk 选约表) 要区分两件对用户完全相反的事:
 * - 「该标的的链还没采到」—— 会有的, 等;
 * - 「该标的根本没有挂牌期权」—— 永远不会有, 别等。
 *
 * 库里的期权合约计数为 0 **答不了这个问题**: 新建锚在链发现跑之前同样是 0。要分开, 必须知道
 * 「链发现有没有为这只锚问过 vendor」——而那是**本 ctx 的事实**, 不该让 optionsdesk 自己去翻
 * `sync_run`。本端口就是那条边界 (bounded-context catalog Q7-D: 注入 callee 导出的
 * port token + interface, 先例 `TRADING_CALENDAR_PORT` / `REALTIME_QUOTE_PORT`, ADR-0062)。
 *
 * 🚨 **蓄意没有布尔方法** (`hasDiscoveredChain(market): boolean`) —— 判据与
 * `TradingCalendarPort.classify` 删掉 `isTradingDay` 布尔那条**同源**: 布尔必然把「还没跑过」
 * 折进「跑过了、没有」, 而那正是本端口要消灭的 closed-world assumption。返回时刻, 让调用方
 * 拿自己那侧的事实 (锚何时建的) 去比 —— 时刻是事实, 布尔是判据, 判据归调用方。
 */
export const OPTION_CHAIN_DISCOVERY_PORT = Symbol('OPTION_CHAIN_DISCOVERY_PORT');

export interface OptionChainDiscoveryPort {
  /**
   * 该市场链发现维度**最近一轮「问全了」的开始时刻**; `null` = 从来没有过这样一轮
   * (⇒ 调用方 MUST fail-closed, 按「还没采到」处置)。
   *
   * ## 「问全了」的三条判据 (缺一不可)
   *
   * 1. `status = 'success'` —— 派生自 `deriveStatus` 的 `failed === 0`
   *    (`sync-run.recorder.ts`), 即工作集里**没有任何一只**的 vendor 调用失败;
   * 2. `skipped = 0` —— 🚨 **这条不能省**。链发现撞限频预算时把剩余标的整批
   *    `stats.skipped++` 顺延下一窗 (`sync-option-contract.usecase.ts` 「deferral ≠ failure」),
   *    而 `deriveStatus` 只看 `failed` ⇒ **一轮顺延掉一半标的的运行, status 仍是 `success`**。
   *    不卡这条, 一只每晚都被顺延的锚会被判成「没有期权」;
   * 3. 返回 **`started_at` 而不是 `finished_at`** —— 工作集在轮开始时装载, 一只锚必须在那之前
   *    就存在才会被问到。拿 `finished_at` 去比建锚时刻, 会把「轮跑到一半时建的锚」误判成已问过。
   *
   * 🚨 **返回的时刻只说明「这一轮问全了」, 不说明「这只标的有期权」** —— 后者由调用方把它与
   * 自己的合约计数合起来判。本端口 MUST NOT 替调用方下那个结论 (那会让判据散成两处)。
   *
   * @param market 市场代号 (`us` / `hk`)。未登记链发现维度的市场恒返 `null`。
   */
  lastCompleteDiscoveryAt(market: string): Promise<Date | null>;
}
