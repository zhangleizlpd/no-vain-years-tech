// 046 T023 — optionsdesk 路由常量单测（Small，logic-only）。
//
// 🚨 **门控的真验不在这里** —— `EXPO_PUBLIC_FEATURE_MARKETS` 是 Metro **打包期内联常量**，
//    运行期改 env 无效、只有换 bundle 才算真验。OFF 断言落
//    `apps/mobile/e2e/markets-feature-gate.spec.ts`（`playwright.markets-off.config.ts` 的
//    `testMatch` 锁死该单文件），跑 `nx run mobile:e2e-public`。
//
//    本文件验的是那条真验依赖的**结构前提**：每个 optionsdesk 路由都长在受
//    `MarketsRouteGuard` 覆盖的前缀下。前提一破（比如新屏挂到 `/(app)/thermometer`），
//    e2e 里没有对应深链就**扫不到**，门控形同虚设且不会红（FR-022）。
import { describe, expect, it } from 'vitest';

import {
  OPTIONSDESK_ANCHORS_ROUTE,
  OPTIONSDESK_ANCHOR_NEW_ROUTE,
  OPTIONSDESK_RADAR_ROUTE,
  OPTIONSDESK_THERMOMETER_ROUTE,
  OPTIONSDESK_UNDERLYING_PATHNAME,
  optionsdeskAnchorEditRoute,
  optionsdeskChainReportRoute,
  optionsdeskUnderlyingRoute,
} from './optionsdesk-routes';

/** tab 落地屏走 tab-screen 门；其余全在二级页栈里，走 `optionsdesk/_layout` 的 route-stack 门。 */
const TAB_LANDING = '/(app)/(tabs)/optionsdesk';
const GATED_STACK_PREFIX = '/(app)/optionsdesk/';

/** 全部对外路由（含两个函数式的产物）—— 新增路由必须加进这张表。 */
const ALL_ROUTES = [
  OPTIONSDESK_RADAR_ROUTE,
  OPTIONSDESK_ANCHORS_ROUTE,
  OPTIONSDESK_ANCHOR_NEW_ROUTE,
  OPTIONSDESK_THERMOMETER_ROUTE,
  optionsdeskAnchorEditRoute('anchor-1'),
  optionsdeskUnderlyingRoute('us:AAPL'),
  optionsdeskChainReportRoute('us:AAPL'),
  OPTIONSDESK_UNDERLYING_PATHNAME,
];

describe('046 T023 —— 两个新屏的路由常量', () => {
  it('温度计挂在期权台二级页栈下（⇒ 继承 _layout 的 route-stack 门）', () => {
    expect(OPTIONSDESK_THERMOMETER_ROUTE).toBe('/(app)/optionsdesk/thermometer');
  });

  it('标的详情按 canonical ticker 深链，且 `market:code` 的冒号被转义', () => {
    expect(optionsdeskUnderlyingRoute('us:AAPL')).toBe('/(app)/optionsdesk/underlying/us%3AAAPL');
    expect(optionsdeskUnderlyingRoute('hk:00700')).toBe('/(app)/optionsdesk/underlying/hk%3A00700');
  });

  it('转义只碰路径段，不吞掉标的身份（解码后逐字还原）', () => {
    const symbol = 'us:BRK.B';
    const segment = optionsdeskUnderlyingRoute(symbol).split('/').pop() ?? '';
    expect(decodeURIComponent(segment)).toBe(symbol);
  });
});

describe('055 T010 —— 链分析报表的路由常量', () => {
  it('报表挂在期权台二级页栈下（⇒ 继承 _layout 的 route-stack 门，SC-009）', () => {
    expect(optionsdeskChainReportRoute('us:ACN')).toBe('/(app)/optionsdesk/chain-report/us%3AACN');
  });

  // 🚨 FR-040：报表是**独立屏**，不是详情屏的子路径 —— 做成 `underlying/<sym>/chain-report`
  // 会把它挂回详情那棵手势树下，而两个横滑消费者相争在 web 上未必看得出来。
  it('🚨 报表不是详情屏的子路径', () => {
    expect(optionsdeskChainReportRoute('us:ACN')).not.toContain('/underlying/');
  });
});

describe('055 T016 —— 下钻落点的动态段模板', () => {
  // 🚨 带 query 参数下钻时走的是**模板**：`symbol` 与预填值一起交给 router 编码。
  //    拿上面那个已编码好的串当 `pathname` 会把 `%3A` 再编一次（`us%253AACN`），
  //    解出来是一个查不到的标的 —— 屏照样渲染，只是变成了无锚引导。
  it('模板留着动态段本身，🚫 不是拼好的具体路径', () => {
    expect(OPTIONSDESK_UNDERLYING_PATHNAME).toContain('[symbol]');
    expect(OPTIONSDESK_UNDERLYING_PATHNAME).not.toContain('%');
  });
});

describe('🚨 FR-022 —— 全部 optionsdesk 路由都落在 markets 受控前缀下', () => {
  it('每条路由要么是 tab 落地屏、要么在二级页栈里（没有第三种落点）', () => {
    const escaped = ALL_ROUTES.filter(
      (r) => r !== TAB_LANDING && !r.startsWith(GATED_STACK_PREFIX),
    );
    expect(escaped, `逃出 markets 门控的路由:\n${escaped.join('\n')}`).toEqual([]);
  });

  it('路由表非空且无重复（防「扫了个空表所以全绿」+ 防复制粘贴撞车）', () => {
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(ALL_ROUTES).size).toBe(ALL_ROUTES.length);
  });
});
