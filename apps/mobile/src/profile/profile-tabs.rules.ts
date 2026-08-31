// 072 T015 —「我的」三栏可见性的三条纯判定（FR-011 / sb-19 / sb-20 / US6）。
//
// 抽成纯函数的理由：可见性由**两个互不相关的位**决定 —— 编译期合规 flag
// (`FEATURE_MARKETS_ENABLED`) 与运行期 `/me.isAdmin`。散在 JSX 的 `&&` 里既没有单点可验，
// 也验不出「markets off ∧ admin」那格 —— 而那格正是公开构建的合规判据。
// 这里是唯一判定处，`profile.tsx` 消费它（T016）。

/** 三栏的键与**渲染顺序**：审批 → 消息 → 知识库（顺序不随可见性重排）。 */
export const PROFILE_TAB_KEYS = ['review', 'messages', 'kb'] as const;

export type ProfileTabKey = (typeof PROFILE_TAB_KEYS)[number];

/**
 * 可见栏集合：以 `kb` 收尾的**非空**元组。
 *
 * 知识库无条件可见是 `visibleProfileTabs` 的不变量；把它编进类型后，取首项的两处
 * （默认栏 / 渲染期回落）都不需要一个永远走不到的兜底分支
 * （`noUncheckedIndexedAccess` 下普通数组的 `[0]` 是 `| undefined`）。
 */
export type VisibleProfileTabs = readonly [...ProfileTabKey[], 'kb'];

export interface ProfileTabVisibility {
  /** 编译期 markets flag（`FEATURE_MARKETS_ENABLED`）—— 公开商店构建恒 false。 */
  marketsEnabled: boolean;
  /** `/me.isAdmin`；未落地时为 undefined（冷启动那一瞬）。 */
  isAdmin: boolean | null | undefined;
}

/**
 * 该渲染哪几栏。
 *
 * 判定序（合规闸在权限闸**之上**）：
 *  1. markets off → 审批与消息**两栏都不渲染**（sb-19）。这是公开发行版不呈现行情的一部分，
 *     `isAdmin` 在这一格里不参与判定 —— 管理员身份不构成合规豁免。
 *  2. markets on ∧ `isAdmin !== true` → 审批栏不渲染（sb-20）。写成 `!== true` 而非 `!isAdmin`
 *     是为了让 undefined（/me 未落地）走同一条 fail-closed 分支，而不是靠 falsy 巧合。
 *  3. 知识库恒渲染（三象限外没有「一栏都不剩」的态）。
 *
 * 🚨 客户端这一位只管**要不要渲染入口**；授权在服务端 `AdminOnlyGuard`（FR-010）。
 */
export function visibleProfileTabs({
  marketsEnabled,
  isAdmin,
}: ProfileTabVisibility): VisibleProfileTabs {
  if (!marketsEnabled) return ['kb'];
  return isAdmin === true ? ['review', 'messages', 'kb'] : ['messages', 'kb'];
}

/** 默认栏 = 可见集合的第一项（admin 落审批 / 普通用户落消息 / 公开构建落知识库）。 */
export function defaultProfileTab(opts: ProfileTabVisibility): ProfileTabKey {
  return visibleProfileTabs(opts)[0];
}

/**
 * 渲染期把「用户选过的栏」派生成「这一帧真正激活的栏」。
 *
 * ⚠️ 回落**必须发生在渲染期**，不能靠 `useEffect` 纠偏：`isAdmin` 会在 /me 落地那一刻
 * 由种子 false 翻真值（反向亦然），effect 版本会先把管理面渲出去一帧再收回。
 */
export function resolveActiveProfileTab(
  selected: ProfileTabKey | null,
  visible: VisibleProfileTabs,
): ProfileTabKey {
  if (selected !== null && visible.includes(selected)) return selected;
  return visible[0];
}
