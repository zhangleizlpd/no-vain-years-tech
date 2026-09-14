/**
 * 交易所公告分类规则 (079 T002, FR-004 / FR-005 / plan §D6) —— **单一维护点**。
 *
 * 输入是 `marketdata.announcement` 的一行 (`linkText` 标题 + `types` 分类标签)，两个判定：
 *
 * 1. {@link classifyNoticeTitle} —— 会前通知信号：只看标题，🚫 读正文。
 * 2. {@link isResultsPublication} —— 业绩刊发事实：只认 `types` 含 `fs_main`。
 *
 * ## 为什么排除词只查「剥掉强写法之后」的余下文本
 *
 * 真通知的标题本身就可能含排除词：`hk:01299`「董事會委任的委員會會議」含「委任」，
 * `hk:09961`「( 1 ) 審計委員會會議日期及…業績公告日期及( 2 ) 有關現金股息的董事會決議日期」含「決議」。
 * 排除词若对整条标题一票否决，这两类会被静默漏掉 —— 确认时刻退回首次观测、且不报错。
 * 故先剥掉命中的强写法再查排除词，且「決議」只以会后决议的形态 (`決議公告` / `決議案`) 出现才排除。
 * EVIDENCE: 本机 evidence `poc8_results.json` 425 份候选 (181 份正文判定为会前通知)：本规则
 * 命中 181 / 误判 0 / 漏 0；把「決議」按裸词排除 ⇒ 漏 `hk:09961` 2025-02-11 那一份 (T002 impl 期回放)。
 *
 * ## 🚫 不按标题认 `all` 类为刊发
 *
 * EVIDENCE: A+H 公司季报另以 `all` 类「海外監管公告」刊发，锚表港股两年 22 份同日均有 `fs_main` 行
 * (plan §D6 / spec.md 取证)；按标题认 `all` 会把「…業績公告日期」「盈利公布及審議會否派發股息」这类
 * **通知**认成刊发 (poc8 PoC 实撞，`poc8.mjs` 注释)。
 *
 * 复杂度 O(n)，n = 标题长度 (常数条正则各扫一遍)。
 */

/**
 * 强通知写法。EVIDENCE: spec.md 取证「来源 B」通知标题写法 + plan §D6 列表；锚表港股两年回放
 * 181 份会前通知全部落在这些写法内 (plan §D6)。
 */
export const NOTICE_TITLE_PATTERN =
  /董事會會議(?:召開日期|通告|通知|日期)|董事會召開日期|召開董事會的日期|業績公告日期|盈利公布及審議|審議會否派發|委員會會議日期|董事會委任的委員會會議/g;

/** 余下文本含这些 ⇒ 会后决议 / 董事名单 / 委员会章程类，不作信号。 */
export const NOTICE_TITLE_EXCLUSION = /決議公告|決議案|名單|委任|職權範圍|工作細則/;

/** 带这些字样但不是通知 ⇒ 「长得像通知」，只计数 (`state_branches` 12)。 */
const NOTICE_LOOKALIKE = /董事|委員會|決議|名單|委任|職權範圍|工作細則/;

const RESULTS_ANNOUNCEMENT_TYPE = 'fs_main';

/** 補充 / 更正 类只在**不含**业绩公告本体时排除 (FR-004：`hk:09992` 2026-08-20 真实刊发标题带「補充公告」)。 */
const SUPPLEMENT_OR_CORRECTION = /補充|更正/;
const RESULTS_ANNOUNCEMENT_BODY = /業績公告|業績公佈/;

export type NoticeTitleClass = 'notice' | 'lookalike' | 'other';

/**
 * 会前通知信号判定：`notice` = 作为确认信号；`lookalike` = 带「董事」等字样但非通知写法，只计数；
 * `other` = 无关 (含业绩公告本身)。
 */
export function classifyNoticeTitle(title: string, types: readonly string[]): NoticeTitleClass {
  if (types.includes(RESULTS_ANNOUNCEMENT_TYPE)) return 'other';
  const remainder = title.replace(NOTICE_TITLE_PATTERN, '');
  const hasStrongPhrase = remainder !== title;
  if (hasStrongPhrase && !NOTICE_TITLE_EXCLUSION.test(remainder)) return 'notice';
  return NOTICE_LOOKALIKE.test(title) ? 'lookalike' : 'other';
}

/** 业绩刊发事实判定：`types` 含 `fs_main`，且不是「不含业绩公告本体的補充 / 更正」。 */
export function isResultsPublication(title: string, types: readonly string[]): boolean {
  if (!types.includes(RESULTS_ANNOUNCEMENT_TYPE)) return false;
  return !SUPPLEMENT_OR_CORRECTION.test(title) || RESULTS_ANNOUNCEMENT_BODY.test(title);
}
