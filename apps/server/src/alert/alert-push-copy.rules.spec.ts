import { describe, it, expect } from 'vitest';
import { renderAlertPushCopy } from './alert-push-copy.rules.js';

describe('renderAlertPushCopy (022 T003, FR-005 快照渲染纯函数)', () => {
  it('PRICE_FALL_TO →「跌至 X 预警价（今日最低 Y）」体例', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '招商银行',
      conditionsSnapshot: [{ type: 'PRICE_FALL_TO', threshold: '30.0000', actual: '29.8000' }],
    });
    expect(copy.title).toBe('预警触发');
    expect(copy.body).toBe('招商银行 跌至 30.00 预警价（今日最低 29.80）');
  });

  it('PRICE_RISE_TO →「涨至 X 预警价（今日最高 Y）」', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '旭升集团',
      conditionsSnapshot: [{ type: 'PRICE_RISE_TO', threshold: '15.5000', actual: '15.7200' }],
    });
    expect(copy.body).toBe('旭升集团 涨至 15.50 预警价（今日最高 15.72）');
  });

  it('DAILY_GAIN_OVER → 正 pct 补 +（014 色盲友好口径，与 mobile 消息中心同源）', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '招商银行',
      conditionsSnapshot: [{ type: 'DAILY_GAIN_OVER', threshold: '7.0000', actual: '7.4300' }],
    });
    expect(copy.body).toBe('招商银行 日涨幅超 7.00%（今日 +7.43%）');
  });

  it('DAILY_LOSS_OVER → 负 pct 原符号', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '招商银行',
      conditionsSnapshot: [{ type: 'DAILY_LOSS_OVER', threshold: '7.0000', actual: '-7.4300' }],
    });
    expect(copy.body).toBe('招商银行 日跌幅超 7.00%（今日 -7.43%）');
  });

  it('多条件 AND →「；」拼接（mobile formatMessageBody 同源分隔符）', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '旭升集团',
      conditionsSnapshot: [
        { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
        { type: 'DAILY_LOSS_OVER', threshold: '7.0000', actual: '-7.4300' },
      ],
    });
    expect(copy.body).toBe(
      '旭升集团 跌至 13.00 预警价（今日最低 12.80）；日跌幅超 7.00%（今日 -7.43%）',
    );
  });

  it('未知条件类型 → 原样回显兜底不炸（服务端演进防御，mobile 同款）', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '招商银行',
      conditionsSnapshot: [{ type: 'VOLUME_OVER', threshold: '1000.0000', actual: '1200.0000' }],
    });
    expect(copy.body).toBe('招商银行 VOLUME_OVER 1000.00（今日 1200.00）');
  });

  it('非法数值串 → 原样回显兜底（mobile fmt2 同款防御）', () => {
    const copy = renderAlertPushCopy({
      instrumentName: '招商银行',
      conditionsSnapshot: [{ type: 'PRICE_FALL_TO', threshold: 'abc', actual: 'xyz' }],
    });
    expect(copy.body).toBe('招商银行 跌至 abc 预警价（今日最低 xyz）');
  });

  it('快照缺失/空数组 → body 仅股票名 + 触发兜底（不回查活 Alert, FR-005）', () => {
    const copy = renderAlertPushCopy({ instrumentName: '招商银行', conditionsSnapshot: [] });
    expect(copy.title).toBe('预警触发');
    expect(copy.body).toBe('招商银行 触发预警');
  });
});
