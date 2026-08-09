// @vitest-environment happy-dom
// 锚表单 RHF hook 单测（logic-only —— 渲染 / a11y / 交互走 T025 Playwright E2E）。
// 覆盖 T022 verify 清单：RHF 错误映射 / 提交态 / EC-3 V ≤ 0 校验 / EC-7 409 映射 /
// model 来源下 confidence 无编辑入口。
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));

vi.mock('./use-anchor-mutations', () => ({
  useCreateAnchor: () => ({ mutateAsync: h.create, isPending: false }),
  useUpdateAnchor: () => ({ mutateAsync: h.update, isPending: false }),
  useDeleteAnchor: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReviewAnchor: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { useAnchorForm } from './use-anchor-form';
import type { AnchorFormValues } from './anchor-form.schema';

const COPY = OPTIONSDESK_COPY.anchorForm;

const VALID: AnchorFormValues = {
  ticker: 'us:LULU',
  tickerName: '露露乐蒙 Lululemon',
  v: '170.00',
  asof: '2026-07-12',
  method: 'DCF',
  confidence: '7.5',
  nextReview: '2026-08-20',
  excluded: false,
  excludeReason: '',
};

/** 最小 AnchorResponse 骨架（本 hook 只读其中几个字段）。 */
function anchorStub(over: Record<string, unknown> = {}) {
  return {
    id: '9',
    ticker: 'us:PEP',
    v: '170.00',
    asof: '2026-07-12',
    method: 'DCF',
    confidence: '8.0',
    confidenceSource: 'model',
    excluded: false,
    excludeReason: null,
    nextReview: '2026-08-20',
    ...over,
  } as never;
}

/** 整体灌值（RHF `reset` 一次写全字段，避免逐字段 setValue 的类型噪声）。 */
function fill(form: { reset: (v: AnchorFormValues) => void }, values: AnchorFormValues) {
  form.reset(values);
}

/** 取本次 update 调用的 payload（mock 未 typed，收口在一处做窄化）。 */
function updateBody(): Record<string, unknown> {
  const call = h.update.mock.calls[0] as unknown[] | undefined;
  const arg = (call?.[0] ?? {}) as { data?: Record<string, unknown> };
  return arg.data ?? {};
}

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ data: { id: '42', ticker: 'us:LULU' } });
  h.update.mockReset().mockResolvedValue({ data: { id: '9', ticker: 'us:PEP' } });
});

describe('useAnchorForm — 建锚（create）', () => {
  it('合法输入 → 调 create 并进 success（isSubmitting 单源：提交完回 idle 派生态）', async () => {
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, VALID));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ticker: 'us:LULU', v: '170.00', confidence: '7.5' }),
    });
    expect(result.current.state).toBe('success');
    expect(result.current.createdId).toBe('42');
  });

  it('🚨 EC-3 —— V ≤ 0 不放行（前端就拦住，不让它发出去）', async () => {
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, { ...VALID, v: '0' }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.create).not.toHaveBeenCalled();

    act(() => result.current.form.setValue('v', '-12', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('🚨 EC-2 —— ticker 空（没从标的库选中）不放行，不提供自由文本绕过', async () => {
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, { ...VALID, ticker: '', tickerName: '' }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('confidence 超出 10 分制 → 不放行', async () => {
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, { ...VALID, confidence: '11' }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('🚨 EC-7 —— 409 映射为「该票已有锚，去编辑」并记下 ticker 供定位既有锚', async () => {
    h.create.mockRejectedValue({ isAxiosError: true, response: { status: 409 } });
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, VALID));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe(COPY.duplicateAnchor);
    expect(result.current.duplicateTicker).toBe('us:LULU');
  });

  it('非 409 错误走通用映射，且不置 duplicateTicker', async () => {
    h.create.mockRejectedValue({ isAxiosError: true, response: { status: 500 } });
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, VALID));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.errorToast).toBe(COPY.network);
    expect(result.current.duplicateTicker).toBeNull();
  });

  it('clearError 把 error 拨回 idle（任一输入改动时调用）', async () => {
    h.create.mockRejectedValue({ isAxiosError: true, response: { status: 400 } });
    const { result } = renderHook(() => useAnchorForm(null));
    act(() => fill(result.current.form, VALID));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.clearError());
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
  });
});

describe('useAnchorForm — 编辑（update）', () => {
  it('预填既有锚字段', () => {
    const { result } = renderHook(() => useAnchorForm(anchorStub()));
    expect(result.current.form.getValues('ticker')).toBe('us:PEP');
    expect(result.current.form.getValues('v')).toBe('170.00');
    expect(result.current.isEdit).toBe(true);
  });

  it('🚨 confidence_source = model → confidenceEditable=false（无编辑入口）且 payload 不含 confidence', async () => {
    const { result } = renderHook(() => useAnchorForm(anchorStub({ confidenceSource: 'model' })));
    expect(result.current.confidenceEditable).toBe(false);
    await act(async () => {
      await result.current.submit();
    });
    expect(h.update).toHaveBeenCalledWith({ id: '9', data: expect.any(Object) });
    expect('confidence' in updateBody()).toBe(false);
  });

  it('confidence_source = manual → 可改且 payload 含 confidence', async () => {
    const { result } = renderHook(() => useAnchorForm(anchorStub({ confidenceSource: 'manual' })));
    expect(result.current.confidenceEditable).toBe(true);
    await act(async () => {
      await result.current.submit();
    });
    expect(updateBody().confidence).toBe('8.0');
  });

  it('🚨 表单保存不携带任何人工位（三处人工位是独立显式动作，FR-032 ①）', async () => {
    const { result } = renderHook(() => useAnchorForm(anchorStub()));
    await act(async () => {
      await result.current.submit();
    });
    const body = updateBody();
    expect('vManual' in body).toBe(false);
    expect('lLevelManual' in body).toBe(false);
    expect('positionCapManual' in body).toBe(false);
  });
});
