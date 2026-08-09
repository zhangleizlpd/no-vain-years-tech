// @vitest-environment happy-dom
// 032 T013 — 创建会话标题表单单测：RHF 4 铁律可测面（schema 校验 / isSubmitting 单源 /
// 空标题挡发 / 建会话成功导航回调）+ errorToast 映射。屏 render / 浮层交互留 T017 e2e。
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 失效会话列表逻辑已下沉到 useCreateSession（use-session-mutations，由其单独 spec 覆盖 onSuccess
// 接线）；本 hook 只编排表单 → 直接 mock wrapper，无需碰 @nvy/api-client / QueryClient。
const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('./use-session-mutations', () => ({
  useCreateSession: vi.fn(() => ({ mutateAsync: h.mutateAsync, isPending: false })),
}));

import { createSessionFormSchema, TITLE_MAX_LENGTH } from './create-session-form.schema';
import { createSessionErrorToast } from './ideation-copy';
import { useCreateSessionForm } from './use-create-session-form';

describe('createSessionFormSchema (标题校验，与 server DTO 互锚)', () => {
  it('接受 trim 后非空、≤60 的标题', () => {
    expect(createSessionFormSchema.safeParse({ title: '行情页收藏功能' }).success).toBe(true);
  });

  it('拒空串（TITLE_REQUIRED）', () => {
    const r = createSessionFormSchema.safeParse({ title: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('TITLE_REQUIRED');
  });

  it('拒纯空白（trim 后空 → TITLE_REQUIRED）', () => {
    const r = createSessionFormSchema.safeParse({ title: '   ' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('TITLE_REQUIRED');
  });

  it('拒超长（>60 → TITLE_TOO_LONG）', () => {
    const r = createSessionFormSchema.safeParse({ title: 'x'.repeat(TITLE_MAX_LENGTH + 1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('TITLE_TOO_LONG');
  });
});

describe('useCreateSessionForm (RHF 4 铁律可测面)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset().mockResolvedValue({ data: { id: '9001', title: '行情页收藏' } });
  });

  it('起手 idle，errorToast 为 null', () => {
    const { result } = renderHook(() => useCreateSessionForm(vi.fn()));
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
  });

  it('空标题（默认空串）submit 被 zodResolver 挡，不发起 create', async () => {
    const { result } = renderHook(() => useCreateSessionForm(vi.fn()));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('建会话成功 → POST body 带 trim 后 title + onCreated 收到 server 返回 id（导航单源）', async () => {
    const onCreated = vi.fn();
    const { result } = renderHook(() => useCreateSessionForm(onCreated));
    act(() => result.current.form.setValue('title', '  行情页收藏  ', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { title: '行情页收藏' } });
    expect(onCreated).toHaveBeenCalledWith('9001');
    expect(result.current.state).toBe('success');
  });

  it('建会话失败 → error 态 + errorToast，不调 onCreated', async () => {
    h.mutateAsync.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500 } });
    const onCreated = vi.fn();
    const { result } = renderHook(() => useCreateSessionForm(onCreated));
    act(() => result.current.form.setValue('title', '行情页收藏', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorToast).toBe('网络异常，请检查网络后重试');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('clearError 把 error 态拨回 idle 并清 toast', async () => {
    h.mutateAsync.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500 } });
    const { result } = renderHook(() => useCreateSessionForm(vi.fn()));
    act(() => result.current.form.setValue('title', '行情页收藏', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.state).toBe('error'));
    act(() => result.current.clearError());
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
  });
});

describe('createSessionErrorToast (建会话错误映射)', () => {
  it('400 → 标题不合法', () => {
    expect(createSessionErrorToast({ isAxiosError: true, response: { status: 400 } })).toBe(
      '标题不合法，请修改后重试',
    );
  });
  it('429 → 限流', () => {
    expect(createSessionErrorToast({ isAxiosError: true, response: { status: 429 } })).toBe(
      '操作过于频繁，请稍后再试',
    );
  });
  it('无 response（网络/超时）→ 网络', () => {
    expect(createSessionErrorToast({ isAxiosError: true })).toBe('网络异常，请检查网络后重试');
  });
  it('非 AxiosError → 未知', () => {
    expect(createSessionErrorToast(new Error('boom'))).toBe('创建失败，请稍后再试');
  });
});
