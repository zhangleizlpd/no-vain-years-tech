// 锚表单纯函数单测（logic-only）：错误映射 / confidence 门控 / 人工态临时语义文案 / payload 映射。
import { describe, expect, it } from 'vitest';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  anchorSubmitErrorToast,
  findAnchorIdByTicker,
  formatPositionCap,
  isConfidenceEditable,
  isDuplicateAnchorError,
  manualSlotHint,
  toCreateRequest,
  toUpdateRequest,
} from './anchor-form.rules';
import type { AnchorFormValues } from './anchor-form.schema';

const COPY = OPTIONSDESK_COPY.anchorForm;
const ax = (status?: number) => ({ isAxiosError: true, response: status ? { status } : undefined });

const values: AnchorFormValues = {
  ticker: 'us:LULU',
  tickerName: '露露乐蒙 Lululemon',
  v: '170.00',
  asof: '2026-07-12',
  method: 'DCF · 估值报告 #24',
  confidence: '7.5',
  nextReview: '2026-08-20',
  excluded: false,
  excludeReason: '',
};

describe('anchorSubmitErrorToast（提交错误映射）', () => {
  it('🚨 EC-7 —— 409 重复 ticker 映射为「该票已有锚，去编辑」', () => {
    expect(anchorSubmitErrorToast(ax(409))).toBe('该票已有锚，去编辑');
    expect(anchorSubmitErrorToast(ax(409))).toBe(COPY.duplicateAnchor);
  });

  it('400 → 输入不合法（server 的 V ≤ 0 等写侧拒也落这条）', () => {
    expect(anchorSubmitErrorToast(ax(400))).toBe(COPY.invalidInput);
  });

  it('429 → 限流', () => {
    expect(anchorSubmitErrorToast(ax(429))).toBe(COPY.rateLimit);
  });

  it('无 response（网络 / 超时）与 5xx → 网络异常', () => {
    expect(anchorSubmitErrorToast(ax())).toBe(COPY.network);
    expect(anchorSubmitErrorToast(ax(503))).toBe(COPY.network);
  });

  it('非 axios 错误 → 未知', () => {
    expect(anchorSubmitErrorToast(new Error('boom'))).toBe(COPY.unknown);
  });
});

describe('isDuplicateAnchorError + findAnchorIdByTicker（EC-7 定位既有锚）', () => {
  it('409 判为重复；其余状态不判', () => {
    expect(isDuplicateAnchorError(ax(409))).toBe(true);
    expect(isDuplicateAnchorError(ax(400))).toBe(false);
    expect(isDuplicateAnchorError(new Error('boom'))).toBe(false);
  });

  it('ProblemDetail 不透传 existingAnchorId ⇒ 按刚提交的 ticker 在列表里定位既有锚', () => {
    const items = [
      { id: '7', ticker: 'us:PEP' },
      { id: '9', ticker: 'us:LULU' },
    ];
    expect(findAnchorIdByTicker(items, 'us:LULU')).toBe('9');
    expect(findAnchorIdByTicker(items, 'us:AOS')).toBeNull();
    expect(findAnchorIdByTicker(items, null)).toBeNull();
  });
});

describe('isConfidenceEditable（FR-001 来源门控）', () => {
  it('🚨 model 来源 → 不可编辑（界面无编辑入口，不是 disabled 输入框）', () => {
    expect(isConfidenceEditable('model')).toBe(false);
  });

  it('manual 来源（手工建锚）→ 可改', () => {
    expect(isConfidenceEditable('manual')).toBe(true);
  });
});

describe('manualSlotHint（FR-032 ② 临时语义措辞）', () => {
  it('🚨 文案含「将回落」—— 表达临时语义，与 2026-08-01 前的「永久覆盖」区分', () => {
    expect(COPY.manualBadge).toContain('将回落');
    expect(manualSlotHint('映射档 L2')).toContain('将回落');
  });

  it('同屏带出派生值（FR-032 ②「标明其派生值」）', () => {
    expect(manualSlotHint('映射档 L2')).toContain('映射档 L2');
    expect(manualSlotHint('模型值 166.00')).toContain('模型值 166.00');
  });
});

describe('formatPositionCap（单票上限展示）', () => {
  it('小数比例 → 百分比', () => {
    expect(formatPositionCap('0.0500')).toBe('5%');
    expect(formatPositionCap('0.2500')).toBe('25%');
    expect(formatPositionCap('0.0200')).toBe('2%');
  });

  it('🚨 L4 上限 = null（策略 SoT 未定义）→ 展示「—」，不自造值', () => {
    expect(formatPositionCap(null)).toBe(COPY.noValue);
  });
});

describe('toCreateRequest / toUpdateRequest（payload 映射）', () => {
  it('create：ticker 取自搜票选中值；空的 next_review / excludeReason 送 null', () => {
    expect(toCreateRequest(values)).toEqual({
      ticker: 'us:LULU',
      v: '170.00',
      asof: '2026-07-12',
      method: 'DCF · 估值报告 #24',
      confidence: '7.5',
      excluded: false,
      excludeReason: null,
      nextReview: '2026-08-20',
    });
    expect(toCreateRequest({ ...values, nextReview: '', excludeReason: '' }).nextReview).toBeNull();
  });

  it('🚨 update ∧ confidence 只读（model 来源）→ payload 不含 confidence 键（server 写侧会 400）', () => {
    const body = toUpdateRequest(values, { confidenceEditable: false });
    expect('confidence' in body).toBe(false);
    expect(body.v).toBe('170.00');
  });

  it('update ∧ confidence 可改（manual 来源）→ payload 含 confidence', () => {
    expect(toUpdateRequest(values, { confidenceEditable: true }).confidence).toBe('7.5');
  });

  it('🚨 update 不带任何人工位键 —— 三处人工位走独立显式动作（FR-032 ①），不混进表单保存', () => {
    const body = toUpdateRequest(values, { confidenceEditable: true });
    expect('vManual' in body).toBe(false);
    expect('lLevelManual' in body).toBe(false);
    expect('positionCapManual' in body).toBe(false);
  });
});
