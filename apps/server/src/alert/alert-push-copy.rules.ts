/**
 * 推送文案纯函数 (022 T003, FR-005) — 从 AlertTrigger 快照渲染通知标题 + 正文。
 *
 * 输入 = 触发流水快照字段 (instrumentName + conditionsSnapshot[{type,threshold,actual}],
 * 021 evaluate 写入, threshold/actual 均 `.toFixed(4)` string), **不回查活 Alert**。
 * 体例 = spec US1「招商银行 跌至 30.00 预警价（今日最低 29.80）」; 多条件 AND 用「；」
 * 拼接、未知类型原样回显、pct 正值补 + — 与 mobile alert-copy.ts 消息中心渲染语义同源
 * (分隔符 / 实际值标签 / 防御口径一致, 文案不进契约)。
 */

/** conditionsSnapshot 单条目 (alert-evaluation.rules.ts ConditionHit 同形, Json 列防御宽型)。 */
export interface PushConditionSnapshot {
  type: string;
  threshold: string;
  actual: string;
}

export interface PushCopyInput {
  instrumentName: string;
  conditionsSnapshot: PushConditionSnapshot[];
}

export interface PushCopy {
  title: string;
  body: string;
}

const PUSH_TITLE = '预警触发';

/** Decimal string → 2dp; 非法串原样回显兜底 (mobile fmt2 同款)。 */
function fmt2(s: string): string {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? s : n.toFixed(2);
}

/** 带符号 pct: 正值补 + (色盲友好, 014 口径); 非法串原样回显。 */
function signedPct(s: string): string {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? s : `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function renderCondition(c: PushConditionSnapshot): string {
  switch (c.type) {
    case 'PRICE_FALL_TO':
      return `跌至 ${fmt2(c.threshold)} 预警价（今日最低 ${fmt2(c.actual)}）`;
    case 'PRICE_RISE_TO':
      return `涨至 ${fmt2(c.threshold)} 预警价（今日最高 ${fmt2(c.actual)}）`;
    case 'DAILY_GAIN_OVER':
      return `日涨幅超 ${fmt2(c.threshold)}%（今日 ${signedPct(c.actual)}%）`;
    case 'DAILY_LOSS_OVER':
      return `日跌幅超 ${fmt2(c.threshold)}%（今日 ${signedPct(c.actual)}%）`;
    default:
      // 防御: 未来新增条件类型时旧 dispatch 不炸 — 原样回显 (mobile 同款)。
      return `${c.type} ${fmt2(c.threshold)}（今日 ${fmt2(c.actual)}）`;
  }
}

export function renderAlertPushCopy(input: PushCopyInput): PushCopy {
  const parts = input.conditionsSnapshot.map(renderCondition);
  const body =
    parts.length > 0
      ? `${input.instrumentName} ${parts.join('；')}`
      : `${input.instrumentName} 触发预警`;
  return { title: PUSH_TITLE, body };
}
