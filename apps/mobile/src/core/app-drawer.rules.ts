// 045 T021 — 全局抽屉的两条纯判定（FR-023 / FR-024 / EC-16 / EC-17）。
//
// 抽成纯函数的理由：题头 leading 的三态是**跨屏不变量**，散在各屏 JSX 里就没有单点可验；
// 这里是唯一判定处，`DrawerMenuButton` 消费它（vitest 只测这两个函数，render 归 T025 e2e）。
import type { AppStateStatus } from 'react-native';

/** 题头左上角渲什么：一级 tab 屏汉堡 / 二级页返回箭头 / 全屏子屏什么都不渲。 */
export type HeaderLeading = 'hamburger' | 'back' | 'none';

/** (tabs) 下唯一的嵌套 stack —— 灵感（045 起不占 tab 槽但路由留在原地，FR-025 / plan D10-2）。 */
const NESTED_STACK_SEGMENT = 'ideation';

/** 灵感「全屏」子屏：本就隐藏底部栏与 FAB，题头由各屏自持 headerTransparent 的 navigator header。 */
const IDEATION_FULLSCREEN_SEGMENTS = ['[id]', 'image-viewer', 'image-annotate'];

/**
 * expo-router `useSegments()` → 题头 leading 三态。
 *
 * 判定序（**必须**先 EC-17 再 FR-024）：
 *  1. 灵感全屏子屏 → `none`：这些屏已有自己的返回箭头，再渲汉堡就是「悬空汉堡 / 双返回」（EC-17）。
 *  2. 二级页 → `back`：(tabs) 之外的兄弟栈（settings / portfolio / alert / optionsdesk）+ (tabs)
 *     内的嵌套 stack（灵感）。返回箭头一律由 navigator header 出，屏内不重复渲（FR-024）。
 *  3. 其余（即 (tabs) 直属屏）→ `hamburger`：一级 tab 屏开全局抽屉（FR-023）。
 *
 * ⚠️ 默认分支**故意 fail-open 到 hamburger** —— 穷举 tab 名会在改名时静默丢汉堡；反过来
 * 「非 (tabs) 即 back」是结构性判据，不随 tab 集合变动。
 * ASSUMED: 「tab 根屏的 segments 尾段可能是 `['(app)','(tabs)']` 也可能带 `'index'`，随
 * expo-router 版本变」—— 本仓**没有跨版本实测**。写在这里是因为本函数**刻意不依赖它**：
 * 判据只看 `includes('(tabs)')`，两种形态都命中。⇒ 它错了本函数照样对；但别拿它去论证
 * 别处该怎么读 segments。
 */
export function headerLeadingFor(segments: readonly string[]): HeaderLeading {
  const last = segments[segments.length - 1] ?? '';
  const inIdeation = segments.includes(NESTED_STACK_SEGMENT);

  if (inIdeation && IDEATION_FULLSCREEN_SEGMENTS.includes(last)) return 'none';
  if (!segments.includes('(tabs)') || inIdeation) return 'back';
  return 'hamburger';
}

/**
 * EC-16：抽屉打开时切后台再回前台的确定态。
 *
 * spec 给的是「保持或关闭二选一」，本片取**关闭**：切走那一刻就关，回前台一定是关的。
 * 取关闭而非保持的理由 —— 关闭是唯一无残留的终态：保持要求滑入动画的 sharedValue 在
 * 跨前后台后仍与 `open` 一致，任一侧漂移就退化成 spec 明令禁止的「半开 / 遮罩不可点」。
 */
export function nextDrawerOpenOnAppState(open: boolean, nextState: AppStateStatus): boolean {
  return nextState === 'active' ? open : false;
}
