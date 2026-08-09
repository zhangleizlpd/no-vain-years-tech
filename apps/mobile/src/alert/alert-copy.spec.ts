import { describe, expect, it } from 'vitest';

import {
  ALERT_CONDITION_META,
  ALERT_CONDITION_TYPES,
  conditionName,
  conditionUnit,
  conditionsByCategory,
  conditionValueLabel,
  formatConditionLine,
  formatMessageBody,
  formatMessageTime,
  formatRemainingQuota,
  metaOf,
  referencePlaceholder,
} from './alert-copy';

describe('词表 meta（34 type / 4 分类，server alert-condition-meta 镜像）', () => {
  it('恰 34 type', () => {
    expect(ALERT_CONDITION_TYPES).toHaveLength(34);
  });

  it('4 分类计数：价格 12 / 估值 10 / 成交量 2 / 技术 10', () => {
    expect(conditionsByCategory('price')).toHaveLength(12);
    expect(conditionsByCategory('valuation')).toHaveLength(10);
    expect(conditionsByCategory('volume')).toHaveLength(2);
    expect(conditionsByCategory('technical')).toHaveLength(10);
  });

  it('024 盘中 5min 类 meta 镜像（percent / 无参 / 价格分类；摘要 meta 驱动）', () => {
    expect(metaOf('PRICE_RISE_5MIN_OVER')).toMatchObject({
      category: 'price',
      kind: 'threshold',
      thresholdFamily: 'percent',
      unit: '%',
      paramWhitelist: [],
    });
    expect(metaOf('PRICE_FALL_5MIN_OVER')?.name).toBe('5分钟跌超');
    expect(formatConditionLine({ type: 'PRICE_RISE_5MIN_OVER', threshold: '3.0000' })).toBe(
      '5分钟涨超 3.00%',
    );
  });

  it('无参语义副标题（KDJ 超卖 = J < 10，spec 为准非 mockup J<0）', () => {
    expect(metaOf('KDJ_OVERSOLD')?.sub).toBe('J < 10');
    expect(metaOf('KDJ_OVERBOUGHT')?.sub).toBe('J > 100');
    expect(metaOf('MACD_GOLDEN_CROSS')?.sub).toBe('DIF 上穿 DEA');
    expect(metaOf('BOLL_BREAK_UPPER')?.sub).toBe('收盘价上穿布林上轨');
  });

  it('RSI 预填默认 70/30；无参类型 paramWhitelist 空', () => {
    expect(ALERT_CONDITION_META.RSI_OVERBOUGHT.defaultThreshold).toBe(70);
    expect(ALERT_CONDITION_META.RSI_OVERSOLD.defaultThreshold).toBe(30);
    expect(ALERT_CONDITION_META.MACD_GOLDEN_CROSS.paramWhitelist).toEqual([]);
    expect(ALERT_CONDITION_META.MA_CROSS_UP.paramWhitelist).toEqual([5, 10, 20, 60, 120, 250]);
  });

  it('conditionName / conditionUnit fallback（词表外原样 / 空串）', () => {
    expect(conditionName('PE_BELOW')).toBe('PE 低于');
    expect(conditionName('SOME_FUTURE_TYPE')).toBe('SOME_FUTURE_TYPE');
    expect(conditionUnit('PE_BELOW')).toBe('倍');
    expect(conditionUnit('MACD_GOLDEN_CROSS')).toBe('');
  });

  // 024 T015：add-condition 屏 2 新条目入「价格」分类 + 跨类搜索命中，全 meta 驱动
  // （add-condition-screen / value-input-sheet 零结构改）；组件渲染由 T016 E2E 验。
  it('024 5min 2 新条目入「价格」分类（rail 切价格即可见）', () => {
    const priceTypes = conditionsByCategory('price');
    expect(priceTypes).toContain('PRICE_RISE_5MIN_OVER');
    expect(priceTypes).toContain('PRICE_FALL_5MIN_OVER');
  });

  it('024 5min 2 新条目跨类搜索命中（add-condition-screen「5分钟」过滤口径）', () => {
    const hits = ALERT_CONDITION_TYPES.filter((t) => conditionName(t).includes('5分钟'));
    expect(hits).toEqual(['PRICE_RISE_5MIN_OVER', 'PRICE_FALL_5MIN_OVER']);
  });
});

describe('formatConditionLine — 卡片 C 摘要矩阵（含参，恒 2dp / 021 口径）', () => {
  it('threshold 价格类（元，空格）— 021 零变化', () => {
    expect(formatConditionLine({ type: 'PRICE_FALL_TO', threshold: '13.0000' })).toBe(
      '股价跌到 13.00 元',
    );
    expect(formatConditionLine({ type: 'PRICE_RISE_TO', threshold: '40' })).toBe(
      '股价涨到 40.00 元',
    );
  });

  it('threshold 涨跌幅类（% 紧贴）— 021 零变化', () => {
    expect(formatConditionLine({ type: 'DAILY_LOSS_OVER', threshold: '7.0000' })).toBe(
      '日跌幅超 7.00%',
    );
  });

  it('threshold 估值/成交量（倍 空格 / % 紧贴）', () => {
    expect(formatConditionLine({ type: 'PE_BELOW', threshold: '10' })).toBe('PE 低于 10.00 倍');
    expect(formatConditionLine({ type: 'VOLUME_RATIO_OVER', threshold: '1.8' })).toBe(
      '量比超 1.80 倍',
    );
    expect(formatConditionLine({ type: 'TURNOVER_RATE_OVER', threshold: '5.5' })).toBe(
      '换手率超 5.50%',
    );
  });

  it('ma 均线穿越：上穿/跌破 MA{param}', () => {
    expect(formatConditionLine({ type: 'MA_CROSS_UP', param: 20, threshold: null })).toBe(
      '股价上穿 MA20',
    );
    expect(formatConditionLine({ type: 'MA_CROSS_DOWN', param: 5, threshold: null })).toBe(
      '股价跌破 MA5',
    );
  });

  it('window 新高新低：创{param}日新高/低', () => {
    expect(formatConditionLine({ type: 'NEW_HIGH', param: 250, threshold: null })).toBe(
      '创250日新高',
    );
    expect(formatConditionLine({ type: 'NEW_LOW', param: 60, threshold: null })).toBe('创60日新低');
  });

  it('daysPct 累计涨跌幅：{param}日涨/跌幅超 {2dp}%', () => {
    expect(formatConditionLine({ type: 'PERIOD_GAIN_OVER', param: 5, threshold: '8' })).toBe(
      '5日涨幅超 8.00%',
    );
    expect(formatConditionLine({ type: 'PERIOD_LOSS_OVER', param: 3, threshold: '3' })).toBe(
      '3日跌幅超 3.00%',
    );
  });

  it('pctile 估值分位：{name} {2dp}%（{param}年）', () => {
    expect(formatConditionLine({ type: 'PE_PCTL_BELOW', param: 3, threshold: '30' })).toBe(
      'PE 分位低于 30.00%（3年）',
    );
    expect(formatConditionLine({ type: 'PB_PCTL_ABOVE', param: 5, threshold: '70' })).toBe(
      'PB 分位高于 70.00%（5年）',
    );
  });

  it('rsi：{name}(2dp)', () => {
    expect(formatConditionLine({ type: 'RSI_OVERSOLD', threshold: '30' })).toBe('RSI 超卖(30.00)');
    expect(formatConditionLine({ type: 'RSI_OVERBOUGHT', threshold: '70' })).toBe(
      'RSI 超买(70.00)',
    );
  });

  it('none 无参技术指标：仅名称', () => {
    expect(formatConditionLine({ type: 'MACD_GOLDEN_CROSS', threshold: null })).toBe('MACD 金叉');
    expect(formatConditionLine({ type: 'KDJ_OVERSOLD', threshold: null })).toBe('KDJ 超卖');
  });

  it('词表外 type → 原样回显兜底（防御）', () => {
    expect(formatConditionLine({ type: 'SOME_FUTURE_TYPE', threshold: null })).toBe(
      'SOME_FUTURE_TYPE',
    );
    expect(formatConditionLine({ type: 'PRICE_FALL_TO', threshold: 'abc' })).toBe(
      '股价跌到 abc 元',
    );
  });
});

describe('conditionValueLabel — 编辑屏值 chip（值-only，021 原串口径）', () => {
  it('阈值类保留输入原串（非 2dp）+ 单位贴合（元/倍/%）', () => {
    expect(conditionValueLabel({ type: 'PRICE_FALL_TO', threshold: '13' })).toBe('13元');
    expect(conditionValueLabel({ type: 'PE_BELOW', threshold: '10.0' })).toBe('10.0倍');
    expect(conditionValueLabel({ type: 'DAILY_LOSS_OVER', threshold: '7' })).toBe('7%');
  });

  it('带参类显参（ma/window/daysPct/pctile）', () => {
    expect(conditionValueLabel({ type: 'MA_CROSS_UP', param: 20, threshold: '' })).toBe('MA20');
    expect(conditionValueLabel({ type: 'NEW_HIGH', param: 250, threshold: '' })).toBe('250日');
    expect(conditionValueLabel({ type: 'PERIOD_GAIN_OVER', param: 5, threshold: '10' })).toBe(
      '5日 10%',
    );
    expect(conditionValueLabel({ type: 'PB_PCTL_BELOW', param: 5, threshold: '30' })).toBe(
      '30%·5年',
    );
  });

  it('RSI 无单位显原串；无参类空串（无可编辑值）', () => {
    expect(conditionValueLabel({ type: 'RSI_OVERBOUGHT', threshold: '70' })).toBe('70');
    expect(conditionValueLabel({ type: 'MACD_GOLDEN_CROSS', threshold: '' })).toBe('');
    expect(conditionValueLabel({ type: 'KDJ_OVERSOLD', threshold: null })).toBe('');
  });

  it('词表外 type → 原串兜底', () => {
    expect(conditionValueLabel({ type: 'SOME_FUTURE_TYPE', threshold: '9' })).toBe('9');
    expect(conditionValueLabel({ type: 'SOME_FUTURE_TYPE', threshold: null })).toBe('');
  });
});

describe('formatMessageBody — 卡片 D 正文（actual + 估值日，新旧兜底）', () => {
  it('021 价格 + 日跌幅（今日最低 / 今日带负号）— 零变化', () => {
    expect(
      formatMessageBody({
        instrumentName: '旭升集团',
        code: '603305',
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000', param: 0 },
          { type: 'DAILY_LOSS_OVER', threshold: '7.0000', actual: '-7.4300', param: 0 },
        ],
      }),
    ).toBe(
      '旭升集团(603305) 触发预警：股价跌到 13.00 元（今日最低 12.80 元）；日跌幅超 7.00%（今日 -7.43%）。',
    );
  });

  it('估值类（带 dataDate）：当前 X，估值日 MM/DD', () => {
    expect(
      formatMessageBody({
        instrumentName: '招商银行',
        code: '600036',
        conditions: [
          {
            type: 'PE_BELOW',
            threshold: '10.0000',
            actual: '9.8200',
            param: 0,
            dataDate: '2026-06-05',
          },
        ],
      }),
    ).toBe('招商银行(600036) 触发预警：PE 低于 10.00 倍（当前 9.82，估值日 06/05）。');
  });

  it('新高新低（今日最低 元）+ 均线穿越（今日收盘 元）+ 累计涨跌幅（近N日 带符号）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600000',
        conditions: [
          { type: 'NEW_LOW', threshold: null, actual: '29.1000', param: 60 },
          { type: 'MA_CROSS_UP', threshold: null, actual: '29.5000', param: 20 },
          { type: 'PERIOD_GAIN_OVER', threshold: '8.0000', actual: '9.3000', param: 5 },
        ],
      }),
    ).toBe(
      '某股(600000) 触发预警：创60日新低（今日最低 29.10 元）；股价上穿 MA20（今日收盘 29.50 元）；5日涨幅超 8.00%（近5日 +9.30%）。',
    );
  });

  it('RSI（当前 X）+ 换手率（今日换手率 X%）+ MACD（当前 X）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600001',
        conditions: [
          { type: 'RSI_OVERSOLD', threshold: '30.0000', actual: '28.5000', param: 0 },
          { type: 'TURNOVER_RATE_OVER', threshold: '5.0000', actual: '6.2000', param: 0 },
          { type: 'MACD_GOLDEN_CROSS', threshold: null, actual: '0.1500', param: 0 },
        ],
      }),
    ).toBe(
      '某股(600001) 触发预警：RSI 超卖(30.00)（当前 28.50）；换手率超 5.00%（今日换手率 6.20%）；MACD 金叉（当前 0.15）。',
    );
  });

  it('旧消息缺新字段（param/dataDate 省略）→ 不炸，按基础口径渲染', () => {
    // 估值类旧消息缺 dataDate → 落 default 分支（当前 X），仍可读不报错。
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600002',
        conditions: [{ type: 'PB_BELOW', threshold: '1.0000', actual: '0.9000' }],
      }),
    ).toBe('某股(600002) 触发预警：PB 低于 1.00 倍（当前 0.90）。');
  });

  it('词表外类型 → 原样回显兜底（服务端演进新类型不炸）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600003',
        conditions: [{ type: 'SOME_FUTURE_TYPE', threshold: '30.0000', actual: '28.5000' }],
      }),
    ).toBe('某股(600003) 触发预警：SOME_FUTURE_TYPE 30.00（今日 28.50）。');
  });
});

describe('formatMessageBody — 024 盘中价口径（priceContext，FR-007）', () => {
  it('到价类盘中触发：标「盘中价 X 元」（区别 EOD「今日最高」）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600100',
        conditions: [
          {
            type: 'PRICE_RISE_TO',
            threshold: '40.0000',
            actual: '40.5000',
            param: 0,
            priceContext: 'intraday',
          },
        ],
      }),
    ).toBe('某股(600100) 触发预警：股价涨到 40.00 元（盘中价 40.50 元）。');
  });

  it('5min 差分类盘中触发：标「盘中 带符号%」（涨/跌方向）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600101',
        conditions: [
          {
            type: 'PRICE_RISE_5MIN_OVER',
            threshold: '3.0000',
            actual: '3.5200',
            param: 0,
            priceContext: 'intraday',
          },
        ],
      }),
    ).toBe('某股(600101) 触发预警：5分钟涨超 3.00%（盘中 +3.52%）。');
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600102',
        conditions: [
          {
            type: 'PRICE_FALL_5MIN_OVER',
            threshold: '5.0000',
            actual: '-5.1000',
            param: 0,
            priceContext: 'intraday',
          },
        ],
      }),
    ).toBe('某股(600102) 触发预警：5分钟跌超 5.00%（盘中 -5.10%）。');
  });

  it('priceContext=eod 显式 → 走 EOD 收盘口径（非盘中价）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600103',
        conditions: [
          {
            type: 'PRICE_RISE_TO',
            threshold: '40.0000',
            actual: '40.5000',
            param: 0,
            priceContext: 'eod',
          },
        ],
      }),
    ).toBe('某股(600103) 触发预警：股价涨到 40.00 元（今日最高 40.50 元）。');
  });

  it('旧消息缺 priceContext → EOD 路径兜底（向后兼容，不炸）', () => {
    expect(
      formatMessageBody({
        instrumentName: '某股',
        code: '600104',
        conditions: [{ type: 'PRICE_RISE_TO', threshold: '40.0000', actual: '40.5000', param: 0 }],
      }),
    ).toBe('某股(600104) 触发预警：股价涨到 40.00 元（今日最高 40.50 元）。');
  });
});

describe('formatMessageTime — 触发时间 MM/DD HH:mm', () => {
  it('ISO 无时区 → 本地时间渲染（与设备时区一致）', () => {
    expect(formatMessageTime('2026-06-06T16:30:00')).toBe('06/06 16:30');
  });

  it('零填充：个位月/日/时/分', () => {
    expect(formatMessageTime('2026-01-05T09:02:00')).toBe('01/05 09:02');
  });

  it('非法串 → 空串兜底（防御，不应出现）', () => {
    expect(formatMessageTime('not-a-date')).toBe('');
  });
});

describe('referencePlaceholder — 到价类参考占位（026 FR-014/015）', () => {
  it('到价类 + 行情就位 → 「最新价 <last>」', () => {
    expect(referencePlaceholder('PRICE_RISE_TO', '1291.91')).toBe('最新价 1291.91');
    expect(referencePlaceholder('PRICE_FALL_TO', '12.80')).toBe('最新价 12.80');
  });

  it('到价类 + 行情未就位（--）→ 退回通用「输入数值」（不显 --）', () => {
    expect(referencePlaceholder('PRICE_RISE_TO', '--')).toBe('输入数值');
    expect(referencePlaceholder('PRICE_FALL_TO', '--')).toBe('输入数值');
  });

  it('非到价阈值类 → 「0.00」占位（不强加行情参考，就位与否都一样）', () => {
    expect(referencePlaceholder('DAILY_GAIN_OVER', '1291.91')).toBe('0.00');
    expect(referencePlaceholder('PE_ABOVE', '--')).toBe('0.00');
    expect(referencePlaceholder('RSI_OVERBOUGHT', '50.00')).toBe('0.00');
  });
});

describe('formatRemainingQuota — 多选剩余名额提示（026 FR-008）', () => {
  it('N 代入文案', () => {
    expect(formatRemainingQuota(1)).toBe('最多再选 1 项');
    expect(formatRemainingQuota(3)).toBe('最多再选 3 项');
  });
});
