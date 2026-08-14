// 055 T015 — 报表入口与深链闸（`FR-035`–`FR-037a`, `state_branch` 6）。
//
// 🚨 **`FR-037a` 的两个落点在这里合成一份判据** —— 详情屏「入口出不出现」与报表屏「深链放不
//    放行」问的是同一个问题：**这只票有没有锚**。分开各写一份必然漂移（一处改了另一处照样
//    渲染得出来），而漂移的形态恰好是 `FR-037a` 明禁的那两种：入口通往一个进不去的屏 / 深链
//    直达一张缺一角的报表。
//
// 🚨 **两个落点在「还不知道」上蓄意不对称，别对齐**：
//    · 入口 **fail-closed** —— 不确定就不给。给了会在取数落定后闪掉，而闪掉的入口比没有更糟。
//    · 深链 **fail-open** —— 只有确知无锚才拦。拿「还在飞 / 读挂了」去拦，等于把读故障说成
//      「你还没建锚」，用户会跑去建一个已经有了的锚。
//    机械防线在 `chain-report-entry.rules.spec.ts` 那条「至少一处答案相反」的断言上。
//
// 📌 拦下时呈的是**建锚引导**而不是报错页（与 046 `FR-011` 同源取舍，`FR-037a` 明写「此判据
//    与 046 既有取舍同源」）⇒ 文案直接复用 `OPTIONSDESK_COPY.underlyingDetail.noAnchor`，
//    🚫 不在 `chainReport` 段另写一份同义的字串。

/** 锚在不在。**三值**——「不知道」是独立一档，🚫 MUST NOT 折成布尔（折了就得挑一边默认）。 */
export type ChainReportAnchorPresence = 'present' | 'absent' | 'unknown';

export interface ChainReportAnchorInput {
  /** 端点明确说「这只票没建锚」（详情屏 = `page === 'no_anchor'`；报表屏 = 404 判别）。 */
  readonly anchorMissing: boolean;
  /** 锚已到手（详情屏 = 锚卡 `ready`；报表屏 = 报表非 `null`）。 */
  readonly anchorLoaded: boolean;
}

/**
 * 两个屏各自的取数态 → 锚在不在。`O(1)`。
 *
 * 🚨 `anchorMissing` **压过** `anchorLoaded`：陈旧缓存还在手上、而这一轮已经 404 时，
 * 判据必须跟当前这一轮走 —— 否则锚删掉之后入口还能再点进去一次。
 */
export function chainReportAnchorPresence(
  input: ChainReportAnchorInput,
): ChainReportAnchorPresence {
  if (input.anchorMissing) return 'absent';
  return input.anchorLoaded ? 'present' : 'unknown';
}

/** 详情屏入口行是否呈现（`FR-037a` 前半，**fail-closed**）。`O(1)`。 */
export function chainReportEntryVisible(presence: ChainReportAnchorPresence): boolean {
  return presence === 'present';
}

/** 报表屏是否拦下改呈建锚引导（`FR-037a` 后半，含深链直达，**fail-open**）。`O(1)`。 */
export function chainReportBlocksReport(presence: ChainReportAnchorPresence): boolean {
  return presence === 'absent';
}
