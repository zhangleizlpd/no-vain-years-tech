import { describe, expect, it, vi } from 'vitest';
import type { AlertResponse } from '@nvy/api-client';

// 纯函数/store 单测：mock @nvy/api-client（dist entry 在 vitest 不可解析；经
// use-alerts 间接触达 orval runtime hook，被测面不用）。镜像 use-alerts.spec 体例。
vi.mock('@nvy/api-client', () => ({
  useAlertsControllerListAll: vi.fn(),
  useAlertsControllerListForInstrument: vi.fn(),
  useAlertsControllerCreateBatch: vi.fn(),
  useAlertsControllerUpdate: vi.fn(),
  useAlertsControllerDeleteBatch: vi.fn(),
  getAlertsControllerListAllQueryKey: vi.fn(() => ['/v1/alert/alerts']),
  getAlertsControllerListForInstrumentQueryKey: vi.fn((market: string, code: string) => [
    `/v1/alert/instruments/${market}/${code}/alerts`,
  ]),
}));

import {
  conditionValid,
  draftSubmittable,
  isAdded,
  multiSelectQuota,
  newConditionDefaults,
  paramValid,
  reconcileConditions,
  removeCondition,
  thresholdValid,
  toConditionEntries,
  upsertCondition,
  useAlertDraft,
  type DraftCondition,
} from './use-alert-draft';

const cond = (type: string, param: number, threshold: string): DraftCondition =>
  ({ type, param, threshold }) as DraftCondition;

describe('upsertCondition — 键 (type, param) 共存 / 同键覆盖（FR-S07）', () => {
  it('新键 → 追加到尾部', () => {
    const next = upsertCondition([cond('PRICE_FALL_TO', 0, '13')], 'DAILY_LOSS_OVER', 0, '7');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ type: 'DAILY_LOSS_OVER', param: 0, threshold: '7' });
  });

  it('同 type 不同 param → 共存（MA5 + MA20）', () => {
    const next = upsertCondition([cond('MA_CROSS_UP', 5, '')], 'MA_CROSS_UP', 20, '');
    expect(next).toHaveLength(2);
    expect(next.map((c) => c.param)).toEqual([5, 20]);
  });

  it('同 type 同 param → 覆盖 threshold（位置保持）', () => {
    const next = upsertCondition(
      [cond('PRICE_FALL_TO', 0, '13'), cond('DAILY_LOSS_OVER', 0, '7')],
      'PRICE_FALL_TO',
      0,
      '12.5',
    );
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'PRICE_FALL_TO', param: 0, threshold: '12.5' });
  });
});

describe('removeCondition / isAdded — 按 (type, param) 精确', () => {
  it('按 type+param 剔除（不误伤同 type 异 param）', () => {
    const list = [cond('MA_CROSS_UP', 5, ''), cond('MA_CROSS_UP', 20, '')];
    expect(removeCondition(list, 'MA_CROSS_UP', 5)).toEqual([
      { type: 'MA_CROSS_UP', param: 20, threshold: '' },
    ]);
  });

  it('isAdded：同 type 异 param 视为未添加', () => {
    const list = [cond('MA_CROSS_UP', 5, '')];
    expect(isAdded(list, 'MA_CROSS_UP', 5)).toBe(true);
    expect(isAdded(list, 'MA_CROSS_UP', 20)).toBe(false);
  });
});

describe('paramValid — 白名单 / 无参 sentinel（server 同口径）', () => {
  it('无参类型必为 0', () => {
    expect(paramValid('MACD_GOLDEN_CROSS', 0)).toBe(true);
    expect(paramValid('MACD_GOLDEN_CROSS', 20)).toBe(false);
    expect(paramValid('PRICE_FALL_TO', 0)).toBe(true);
  });

  it('带参类型必在白名单', () => {
    expect(paramValid('MA_CROSS_UP', 20)).toBe(true);
    expect(paramValid('MA_CROSS_UP', 7)).toBe(false);
    expect(paramValid('NEW_HIGH', 250)).toBe(true);
    expect(paramValid('NEW_HIGH', 30)).toBe(false);
    expect(paramValid('PE_PCTL_BELOW', 3)).toBe(true);
    expect(paramValid('PE_PCTL_BELOW', 4)).toBe(false);
  });
});

describe('thresholdValid — per family（server isThresholdInRange 同口径）', () => {
  it('price/positive：>0', () => {
    expect(thresholdValid('PRICE_RISE_TO', '13.5')).toBe(true);
    expect(thresholdValid('PRICE_FALL_TO', '0')).toBe(false);
    expect(thresholdValid('PE_BELOW', '9999')).toBe(true);
    expect(thresholdValid('PE_BELOW', '-1')).toBe(false);
  });

  it('percent：(0,100]', () => {
    expect(thresholdValid('DAILY_GAIN_OVER', '100')).toBe(true);
    expect(thresholdValid('DAILY_LOSS_OVER', '101')).toBe(false);
    expect(thresholdValid('DAILY_LOSS_OVER', '0')).toBe(false);
  });

  it('pctile：[0,100]（含 0）', () => {
    expect(thresholdValid('PE_PCTL_BELOW', '0')).toBe(true);
    expect(thresholdValid('PE_PCTL_BELOW', '100')).toBe(true);
    expect(thresholdValid('PE_PCTL_BELOW', '101')).toBe(false);
  });

  it('rsi：(0,100) 开区间', () => {
    expect(thresholdValid('RSI_OVERSOLD', '30')).toBe(true);
    expect(thresholdValid('RSI_OVERBOUGHT', '100')).toBe(false);
    expect(thresholdValid('RSI_OVERBOUGHT', '0')).toBe(false);
  });

  it('无阈值类型（none/ma/window）→ 恒合法（不校验）', () => {
    expect(thresholdValid('MACD_GOLDEN_CROSS', '')).toBe(true);
    expect(thresholdValid('MA_CROSS_UP', '')).toBe(true);
    expect(thresholdValid('NEW_HIGH', '')).toBe(true);
  });

  it('有阈值类型空串/非数值 → 不合法', () => {
    expect(thresholdValid('PRICE_RISE_TO', '')).toBe(false);
    expect(thresholdValid('PE_BELOW', 'abc')).toBe(false);
  });
});

describe('newConditionDefaults — 参数 sheet 新建 seed（T016）', () => {
  it('带参类型 → 首个白名单值 + 空阈值', () => {
    expect(newConditionDefaults('MA_CROSS_UP')).toEqual({ param: 5, threshold: '' });
    expect(newConditionDefaults('NEW_HIGH')).toEqual({ param: 60, threshold: '' });
    expect(newConditionDefaults('PERIOD_GAIN_OVER')).toEqual({ param: 3, threshold: '' });
    expect(newConditionDefaults('PE_PCTL_BELOW')).toEqual({ param: 3, threshold: '' });
  });

  it('RSI → 预填默认阈值（FR-S04 70/30）+ 无参 sentinel', () => {
    expect(newConditionDefaults('RSI_OVERBOUGHT')).toEqual({ param: 0, threshold: '70' });
    expect(newConditionDefaults('RSI_OVERSOLD')).toEqual({ param: 0, threshold: '30' });
  });

  it('纯阈值 / 无参类型 → 无参 sentinel + 空阈值', () => {
    expect(newConditionDefaults('PRICE_FALL_TO')).toEqual({ param: 0, threshold: '' });
    expect(newConditionDefaults('MACD_GOLDEN_CROSS')).toEqual({ param: 0, threshold: '' });
  });
});

describe('conditionValid / draftSubmittable', () => {
  it('带参条件合法（MA20 无阈值 / 分位有阈值+年限）', () => {
    expect(conditionValid(cond('MA_CROSS_UP', 20, ''))).toBe(true);
    expect(conditionValid(cond('PE_PCTL_BELOW', 3, '30'))).toBe(true);
    expect(conditionValid(cond('MA_CROSS_UP', 7, ''))).toBe(false); // param 出域
  });

  it('0 条件 → 拒绝', () => {
    expect(draftSubmittable([], '')).toBe(false);
  });

  it('1..4 条全合法 + note ≤22 → 可提交', () => {
    expect(
      draftSubmittable([cond('MA_CROSS_UP', 20, ''), cond('RSI_OVERSOLD', 0, '30')], '达到预期'),
    ).toBe(true);
  });

  it('note 超 22 code point → 拒绝（surrogate pair 算 1，D10）', () => {
    expect(draftSubmittable([cond('PRICE_FALL_TO', 0, '13')], '字'.repeat(23))).toBe(false);
    expect(draftSubmittable([cond('PRICE_FALL_TO', 0, '13')], '𝒳'.repeat(22))).toBe(true);
  });

  it('含非法阈值/参数 → 拒绝', () => {
    expect(draftSubmittable([cond('PRICE_FALL_TO', 0, '0')], '')).toBe(false);
    expect(draftSubmittable([cond('NEW_HIGH', 30, '')], '')).toBe(false);
  });
});

describe('toConditionEntries — 按 kind 决定携带 param/threshold', () => {
  it('threshold 类：仅 threshold（无 param）', () => {
    expect(toConditionEntries([cond('PE_BELOW', 0, '10')])).toEqual([
      { type: 'PE_BELOW', threshold: 10 },
    ]);
  });

  it('ma 类：仅 param（无 threshold）', () => {
    expect(toConditionEntries([cond('MA_CROSS_UP', 20, '')])).toEqual([
      { type: 'MA_CROSS_UP', param: 20 },
    ]);
  });

  it('daysPct/pctile 类：param + threshold', () => {
    expect(toConditionEntries([cond('PE_PCTL_BELOW', 3, '30')])).toEqual([
      { type: 'PE_PCTL_BELOW', param: 3, threshold: 30 },
    ]);
  });

  it('none 类：仅 type', () => {
    expect(toConditionEntries([cond('MACD_GOLDEN_CROSS', 0, '')])).toEqual([
      { type: 'MACD_GOLDEN_CROSS' },
    ]);
  });
});

describe('024 盘中 5min 差分类 — 键 (type,param) param=0 + percent 阈值（meta 泛型驱动）', () => {
  it('newConditionDefaults：纯阈值 percent → 无参 sentinel + 空阈值', () => {
    expect(newConditionDefaults('PRICE_RISE_5MIN_OVER')).toEqual({ param: 0, threshold: '' });
    expect(newConditionDefaults('PRICE_FALL_5MIN_OVER')).toEqual({ param: 0, threshold: '' });
  });

  it('paramValid：无参类型必为 0（白名单空）', () => {
    expect(paramValid('PRICE_RISE_5MIN_OVER', 0)).toBe(true);
    expect(paramValid('PRICE_RISE_5MIN_OVER', 5)).toBe(false);
  });

  it('thresholdValid：percent (0,100]', () => {
    expect(thresholdValid('PRICE_RISE_5MIN_OVER', '3')).toBe(true);
    expect(thresholdValid('PRICE_FALL_5MIN_OVER', '100')).toBe(true);
    expect(thresholdValid('PRICE_RISE_5MIN_OVER', '0')).toBe(false);
    expect(thresholdValid('PRICE_RISE_5MIN_OVER', '101')).toBe(false);
  });

  it('upsert 键 (type,param) param=0：同 type 覆盖、与到价类共存', () => {
    const next = upsertCondition([cond('PRICE_RISE_TO', 0, '40')], 'PRICE_RISE_5MIN_OVER', 0, '3');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ type: 'PRICE_RISE_5MIN_OVER', param: 0, threshold: '3' });
  });

  it('toConditionEntries：percent 阈值 only（无 param）', () => {
    expect(toConditionEntries([cond('PRICE_RISE_5MIN_OVER', 0, '3')])).toEqual([
      { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 },
    ]);
  });
});

describe('reconcileConditions — 批量对齐选中集（026 FR-007/009）', () => {
  it('新增：选中多 param 全 upsert（纯周期 threshold 空串）', () => {
    const next = reconcileConditions([], 'NEW_HIGH', [60, 120], '');
    expect(next).toEqual([
      { type: 'NEW_HIGH', param: 60, threshold: '' },
      { type: 'NEW_HIGH', param: 120, threshold: '' },
    ]);
  });

  it('移除：取消勾选的同 type 旧 param 被删', () => {
    const list = [cond('NEW_HIGH', 60, ''), cond('NEW_HIGH', 120, '')];
    expect(reconcileConditions(list, 'NEW_HIGH', [60], '')).toEqual([
      { type: 'NEW_HIGH', param: 60, threshold: '' },
    ]);
  });

  it('覆盖阈值：组合类多 param 共用同阈值（同键原位更新）', () => {
    const list = [cond('PERIOD_GAIN_OVER', 3, '5'), cond('PERIOD_GAIN_OVER', 5, '5')];
    const next = reconcileConditions(list, 'PERIOD_GAIN_OVER', [3, 5], '8');
    expect(next).toEqual([
      { type: 'PERIOD_GAIN_OVER', param: 3, threshold: '8' },
      { type: 'PERIOD_GAIN_OVER', param: 5, threshold: '8' },
    ]);
  });

  it('其余 type 原样保留（只对齐目标 type）', () => {
    const list = [cond('PRICE_FALL_TO', 0, '13'), cond('NEW_HIGH', 60, '')];
    const next = reconcileConditions(list, 'NEW_HIGH', [120], '');
    expect(next).toEqual([
      { type: 'PRICE_FALL_TO', param: 0, threshold: '13' },
      { type: 'NEW_HIGH', param: 120, threshold: '' },
    ]);
  });

  it('幂等：选中集与现状一致 → 内容不变', () => {
    const list = [cond('NEW_HIGH', 60, ''), cond('NEW_HIGH', 120, '')];
    expect(reconcileConditions(list, 'NEW_HIGH', [60, 120], '')).toEqual(list);
  });

  it('空选中集 → 清掉该 type 全部（其余保留）', () => {
    const list = [cond('NEW_HIGH', 60, ''), cond('PRICE_FALL_TO', 0, '13')];
    expect(reconcileConditions(list, 'NEW_HIGH', [], '')).toEqual([
      { type: 'PRICE_FALL_TO', param: 0, threshold: '13' },
    ]);
  });
});

describe('multiSelectQuota — 名额按非本 type 条数算（026 FR-008 / plan D4）', () => {
  it('空草稿：max = 上限 4，remaining = 4', () => {
    expect(multiSelectQuota([], 'NEW_HIGH')).toEqual({ max: 4, remaining: 4 });
  });

  it('别 type 占 2 条 → max = 2（本 type 0 条 → remaining = 2）', () => {
    const list = [cond('PRICE_FALL_TO', 0, '13'), cond('DAILY_GAIN_OVER', 0, '7')];
    expect(multiSelectQuota(list, 'NEW_HIGH')).toEqual({ max: 2, remaining: 2 });
  });

  it('本 type 已存 = 预勾选不永久占额：max 仍按别 type 算', () => {
    // 1 别 type + 2 本 type → max = 4-1 = 3，remaining = 3-2 = 1
    const list = [
      cond('PRICE_FALL_TO', 0, '13'),
      cond('NEW_HIGH', 60, ''),
      cond('NEW_HIGH', 120, ''),
    ];
    expect(multiSelectQuota(list, 'NEW_HIGH')).toEqual({ max: 3, remaining: 1 });
  });

  it('满额（别 type 占满 4）→ max = 0，remaining 夹到 0', () => {
    const list = [
      cond('PRICE_FALL_TO', 0, '13'),
      cond('PRICE_RISE_TO', 0, '20'),
      cond('DAILY_GAIN_OVER', 0, '7'),
      cond('DAILY_LOSS_OVER', 0, '7'),
    ];
    expect(multiSelectQuota(list, 'NEW_HIGH')).toEqual({ max: 0, remaining: 0 });
  });
});

describe('useAlertDraft store — reconcile action', () => {
  it('reconcile 批量对齐目标 type（保留别 type）', () => {
    useAlertDraft.getState().startNew('rk', [{ market: 'cn', code: '603305' }]);
    useAlertDraft.getState().upsert('PRICE_FALL_TO', 0, '13');
    useAlertDraft.getState().reconcile('NEW_HIGH', [60, 120], '');
    expect(useAlertDraft.getState().conditions).toEqual([
      { type: 'PRICE_FALL_TO', param: 0, threshold: '13' },
      { type: 'NEW_HIGH', param: 60, threshold: '' },
      { type: 'NEW_HIGH', param: 120, threshold: '' },
    ]);
  });
});

describe('useAlertDraft store — start*/reset 编排', () => {
  it('startNew 清空旧草稿并落 instruments', () => {
    useAlertDraft.getState().startNew('k1', [{ market: 'cn', code: '603305' }]);
    useAlertDraft.getState().upsert('PRICE_FALL_TO', 0, '13');
    useAlertDraft.getState().startNew('k2', [{ market: 'cn', code: '600519' }]);
    const s = useAlertDraft.getState();
    expect(s.initKey).toBe('k2');
    expect(s.conditions).toEqual([]);
    expect(s.frequency).toBe('DAILY');
    expect(s.instruments).toEqual([{ market: 'cn', code: '600519' }]);
  });

  it('startEdit 回填 alert 全字段（param/threshold/note null 兜底）', () => {
    const alert = {
      id: '9',
      market: 'cn',
      code: '603305',
      conditions: [
        { type: 'MA_CROSS_UP', param: 20, threshold: null },
        { type: 'PRICE_FALL_TO', param: 0, threshold: '13.00' },
      ],
      frequency: 'ONCE_DISABLE',
      note: null,
      enabled: true,
      createdAt: '2026-06-07T00:00:00Z',
    } as AlertResponse;
    useAlertDraft.getState().startEdit('edit:9', alert);
    const s = useAlertDraft.getState();
    expect(s.alertId).toBe('9');
    expect(s.conditions).toEqual([
      { type: 'MA_CROSS_UP', param: 20, threshold: '' },
      { type: 'PRICE_FALL_TO', param: 0, threshold: '13.00' },
    ]);
    expect(s.frequency).toBe('ONCE_DISABLE');
    expect(s.note).toBe('');
  });

  it('reset 回初始态', () => {
    useAlertDraft.getState().reset();
    expect(useAlertDraft.getState().initKey).toBeNull();
    expect(useAlertDraft.getState().alertId).toBeNull();
  });
});
