// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client upsert mutation + GET query-key fn so the real axios /
// expo-secure-store RN chain never loads. RHF + zodResolver + zod are
// platform-agnostic. The hook invalidates the GET /chat/preferences query key
// on success (account-scoped via JWT, no accountId param).
const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@nvy/api-client', () => ({
  useChatPreferenceControllerUpsert: vi.fn(() => ({
    mutateAsync: h.mutateAsync,
    isPending: false,
  })),
  getChatPreferenceControllerGetQueryKey: vi.fn(() => ['/api/v1/chat/preferences']),
}));

import {
  customInstructionErrorToast,
  useCustomInstructionForm,
} from './use-custom-instruction-form';

// useCustomInstructionForm calls useQueryClient → needs a QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useCustomInstructionForm (core)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset().mockResolvedValue({ data: { customInstruction: '' } });
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useCustomInstructionForm(''), { wrapper });
    expect(result.current.state).toBe('idle');
  });

  it('hydrates the form with the initial instruction (defaultValue)', () => {
    const { result } = renderHook(() => useCustomInstructionForm('请用中文回答'), { wrapper });
    expect(result.current.form.getValues('customInstruction')).toBe('请用中文回答');
  });

  it('submit maps to PUT body and moves to success', async () => {
    const { result } = renderHook(() => useCustomInstructionForm(''), { wrapper });
    act(() =>
      result.current.form.setValue('customInstruction', '回答要简洁', { shouldValidate: true }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { customInstruction: '回答要简洁' } });
    expect(result.current.state).toBe('success');
  });

  it('allows empty instruction (clear) — submits empty string, moves to success', async () => {
    const { result } = renderHook(() => useCustomInstructionForm('旧指令'), { wrapper });
    act(() => result.current.form.setValue('customInstruction', '', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { customInstruction: '' } });
    expect(result.current.state).toBe('success');
  });

  it('does NOT call the mutation when instruction exceeds 2000 chars (zod max)', async () => {
    const { result } = renderHook(() => useCustomInstructionForm(''), { wrapper });
    act(() =>
      result.current.form.setValue('customInstruction', 'a'.repeat(2001), {
        shouldValidate: true,
      }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.form.formState.isValid).toBe(false);
  });

  it('accepts exactly 2000 chars (boundary)', async () => {
    const { result } = renderHook(() => useCustomInstructionForm(''), { wrapper });
    const max = 'a'.repeat(2000);
    act(() => result.current.form.setValue('customInstruction', max, { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { customInstruction: max } });
  });

  it('derives submitting state from a single source (formState.isSubmitting)', async () => {
    let resolveMutation: (v: unknown) => void = () => undefined;
    h.mutateAsync.mockImplementationOnce(() => new Promise((res) => (resolveMutation = res)));
    const { result } = renderHook(() => useCustomInstructionForm(''), { wrapper });
    act(() => result.current.form.setValue('customInstruction', '生效', { shouldValidate: true }));
    // Fire submit without awaiting — the mutation promise stays pending.
    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.submit();
    });
    // While the mutation is in-flight, state derives 'submitting' from isSubmitting
    // (single source — no separate loading bool).
    await waitFor(() => expect(result.current.state).toBe('submitting'));
    await act(async () => {
      resolveMutation({ data: { customInstruction: '生效' } });
      await submitPromise;
    });
    expect(result.current.state).toBe('success');
  });
});

describe('customInstructionErrorToast (mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status ? { status } : undefined,
  });

  it.each([
    [400, '自定义指令不合法，请重试'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
  ])('axios %s → %s', (status, toast) => {
    expect(customInstructionErrorToast(ax(status as number))).toBe(toast);
  });

  it('axios without response (network/timeout) → 网络异常', () => {
    expect(customInstructionErrorToast(ax())).toBe('网络异常，请重试');
  });

  it('non-axios error → unknown', () => {
    expect(customInstructionErrorToast(new Error('boom'))).toBe('保存失败，请稍后重试');
  });
});
