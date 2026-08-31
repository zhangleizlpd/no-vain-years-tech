import { describe, expect, it } from 'vitest';

import {
  approveChanges,
  approveErrorToast,
  asofEdited,
  asofGateExits,
  detailNotice,
  isAsofShiftUnresolvableError,
  isAsofSuspectError,
  isHalfCommitted,
  isSubmissionNotPendingError,
} from './anchor-submission-detail.rules';
import type { AnchorSubmissionFormValues } from './anchor-submission.schema';

// 072 T019 — 审批详情判定（FR-002 / FR-005 / US2 / US3）。logic-only：sheet 渲染归 e2e。

const DETAIL = {
  v: '80.0000',
  asof: '2026-08-29',
  method: 'dcf',
  confidence: '7.50',
};

const FORM: AnchorSubmissionFormValues = {
  v: '80.0000',
  asof: '2026-08-29',
  method: 'dcf',
  confidence: '7.50',
  reviewNote: '',
};

const axios409 = (code: string) => ({
  isAxiosError: true,
  response: { status: 409, data: { code } },
});

describe('asofGateExits — 三出口 / 两出口（sb-5, sb-6; US3）', () => {
  it('日历解得出建议日 → 三出口，改送在最前（主出口）', () => {
    expect(asofGateExits('2026-08-28')).toEqual(['shift', 'accept', 'cancel']);
  });

  it('🚨 解不出 → 「改送」**整个出口不渲染**（不是 disabled —— 系统不猜）', () => {
    expect(asofGateExits(null)).toEqual(['accept', 'cancel']);
    expect(asofGateExits(null)).not.toContain('shift');
  });

  it('两种情形都保留「取消」—— 任何时候都能退出去不处置', () => {
    expect(asofGateExits('2026-08-28')).toContain('cancel');
    expect(asofGateExits(null)).toContain('cancel');
  });
});

describe('detailNotice — noop 优先于人工位警告（sb-11）', () => {
  it('willBeNoop → noop 提示，**零警告**（什么都不写的操作不配最吓人的警告）', () => {
    expect(detailNotice({ willBeNoop: true, fallbackPreview: [] })).toBe('noop');
  });

  it('🚨 即便上游同时给了预览，noop 仍压过它 —— 不替上游做「不可能发生」的假设', () => {
    expect(
      detailNotice({
        willBeNoop: true,
        fallbackPreview: [
          { ticker: 'hk:02359', slot: 'v', manualValue: '58.0000', fallbackValue: '62.0000' },
        ],
      }),
    ).toBe('noop');
  });

  it('有人工位会被冲掉 → fallback 警告', () => {
    expect(
      detailNotice({
        willBeNoop: false,
        fallbackPreview: [
          { ticker: 'hk:02359', slot: 'v', manualValue: '58.0000', fallbackValue: '62.0000' },
        ],
      }),
    ).toBe('fallback');
  });

  it('既不 noop 也无人工位 → 无提示（常态建锚不吓人）', () => {
    expect(detailNotice({ willBeNoop: false, fallbackPreview: [] })).toBe('none');
  });
});

describe('approveChanges — 只带改过的字段', () => {
  it('一个字段都没改 → 空载荷（审核方没改过就不留改动痕迹）', () => {
    expect(approveChanges(FORM, DETAIL)).toEqual({});
  });

  it('改了 V 与置信度 → 只带这两个', () => {
    expect(approveChanges({ ...FORM, v: '82.0000', confidence: '8.00' }, DETAIL)).toEqual({
      v: '82.0000',
      confidence: '8.00',
    });
  });

  it('审核备注非空才带；纯空白按空处理', () => {
    expect(approveChanges({ ...FORM, reviewNote: '  ' }, DETAIL)).toEqual({});
    expect(approveChanges({ ...FORM, reviewNote: ' 采纳，理由充分 ' }, DETAIL)).toEqual({
      reviewNote: '采纳，理由充分',
    });
  });

  it('asofAck 显式传入才带（缺省 ⇒ 服务端撞可疑档就 409，这正是我们要的 fail-closed）', () => {
    expect(approveChanges(FORM, DETAIL).asofAck).toBeUndefined();
    expect(approveChanges(FORM, DETAIL, 'shift').asofAck).toBe('shift');
    expect(approveChanges(FORM, DETAIL, 'accept').asofAck).toBe('accept');
  });

  it('数值一律原样透传字符串（尾零不被吞，永不经 JS number）', () => {
    expect(approveChanges({ ...FORM, v: '80.0000' }, { ...DETAIL, v: '80.0' }).v).toBe('80.0000');
  });
});

describe('asofEdited — 改过口径日则本地那份 flag/suggested 不作数', () => {
  it('没改 → false', () => {
    expect(asofEdited(FORM, DETAIL)).toBe(false);
  });

  it('改了 → true（此后建议日只能由服务端判，客户端不猜）', () => {
    expect(asofEdited({ ...FORM, asof: '2026-08-27' }, DETAIL)).toBe(true);
  });
});

describe('409 三码判别 + 文案分流', () => {
  it('ASOF_SUSPECT / ASOF_SHIFT_UNRESOLVABLE / SUBMISSION_NOT_PENDING 互不串台', () => {
    expect(isAsofSuspectError(axios409('ASOF_SUSPECT'))).toBe(true);
    expect(isAsofSuspectError(axios409('ASOF_SHIFT_UNRESOLVABLE'))).toBe(false);
    expect(isAsofShiftUnresolvableError(axios409('ASOF_SHIFT_UNRESOLVABLE'))).toBe(true);
    expect(isSubmissionNotPendingError(axios409('SUBMISSION_NOT_PENDING'))).toBe(true);
    expect(isSubmissionNotPendingError(axios409('ASOF_SUSPECT'))).toBe(false);
  });

  it('非 axios 错误 / 无 code → 不误判成口径日闸', () => {
    expect(isAsofSuspectError(new Error('boom'))).toBe(false);
    expect(isAsofSuspectError({ isAxiosError: true, response: { status: 409, data: {} } })).toBe(
      false,
    );
  });

  it('「日历解不出」有自己的文案，MUST NOT 混进通用失败（那句话是让人改走另一个出口）', () => {
    const shiftToast = approveErrorToast(axios409('ASOF_SHIFT_UNRESOLVABLE'));
    expect(shiftToast).not.toBe(approveErrorToast(axios409('WHATEVER')));
    expect(shiftToast).toContain('不猜');
  });

  it('「已被别处处置过」也单列 —— 与「不存在」是两件事（sb-8）', () => {
    expect(approveErrorToast(axios409('SUBMISSION_NOT_PENDING'))).toContain('处置过');
  });

  it('网络不可达（无 response）与 429 各有各的话', () => {
    const network = approveErrorToast({ isAxiosError: true });
    const limited = approveErrorToast({ isAxiosError: true, response: { status: 429, data: {} } });
    expect(network).not.toBe(limited);
  });
});

describe('isHalfCommitted — 半截态不是失败（sb-13）', () => {
  it('statusFlipped=false → 半截态（锚已写，状态没翻）', () => {
    expect(isHalfCommitted({ statusFlipped: false })).toBe(true);
  });

  it('statusFlipped=true → 正常完成', () => {
    expect(isHalfCommitted({ statusFlipped: true })).toBe(false);
  });
});
