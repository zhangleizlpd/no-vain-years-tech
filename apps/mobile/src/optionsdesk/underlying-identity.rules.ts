// 045 plan D13 —— 「这是哪只票」在屏上怎么写。三处共用：击球区雷达行首 / 锚管理列表行首 /
// 标的详情题头。
//
// 🚨 **判据只此一处**。D13 定的是「标的标识（ticker + 中文名）」，名字取不到才退回代号；
//    三个屏各写一遍的话，「名字缺失怎么办」迟早分叉成三种答案（而分叉不报错，只是屏上不一致）。
import type { AnchorResponse } from '@nvy/api-client';

/** canonical `market:code` → 展示用 code（解析失败退回原串，不丢信息）。 */
export function tickerCode(ticker: string): string {
  return ticker.split(':')[1] ?? ticker;
}

/**
 * 主位显示串 = **标的名**；取不到才退回代号。
 *
 * 🚨 名字取不到（该 ticker 未在行情库注册，server 下发 `null`）⇒ **退回代号**，退化成 045
 * 初版的样子。MUST NOT 拿 ticker 拼一个假名字 —— 那会让「名字没同步上」和「这票就叫这个」
 * 在屏上分不开。
 *
 * ⚠️ 空串与 `null` 同处置：两者都不是「这票就叫这个」。server 侧 `marketdata.instrument.name`
 * 是 NOT NULL 列，理论上不会是空串，但这层不替它做「不可能发生」的假设。
 */
export function underlyingDisplayName(a: Pick<AnchorResponse, 'name' | 'ticker'>): string {
  return a.name !== null && a.name.length > 0 ? a.name : tickerCode(a.ticker);
}
