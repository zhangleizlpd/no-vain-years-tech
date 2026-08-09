// @vitest-environment happy-dom
// T005 — 本地暂存附件 hook 逻辑测（033 多模态壳 US2/US3）。client-only、无上传、无 OSS。
// 只覆盖 add（单/多选）/ remove / clear / 相册·相机权限被拒分支；mock `expo-image-picker`
// （native picker 路径不在 vitest 跑，mock 控制权限态 + 返回 assets，验逻辑分支）。
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reqLibrary: vi.fn(),
  reqCamera: vi.fn(),
  launchLibrary: vi.fn(),
  launchCamera: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: h.reqLibrary,
  requestCameraPermissionsAsync: h.reqCamera,
  launchImageLibraryAsync: h.launchLibrary,
  launchCameraAsync: h.launchCamera,
}));

import { useIdeationAttachments } from './use-ideation-attachments';

const granted = { granted: true };
const denied = { granted: false };

function libraryResult(uris: string[]) {
  return { canceled: false, assets: uris.map((uri) => ({ uri })) };
}
function cameraResult(uri: string) {
  return { canceled: false, assets: [{ uri }] };
}

beforeEach(() => {
  h.reqLibrary.mockReset().mockResolvedValue(granted);
  h.reqCamera.mockReset().mockResolvedValue(granted);
  h.launchLibrary.mockReset();
  h.launchCamera.mockReset();
});

describe('useIdeationAttachments — pickFromLibrary', () => {
  it('多选 2 张 → 追加 2 个 staged（各有 id + localUri）', async () => {
    h.launchLibrary.mockResolvedValue(libraryResult(['file://a.jpg', 'file://b.jpg']));
    const fireToast = vi.fn();
    const { result } = renderHook(() => useIdeationAttachments(fireToast));

    await act(async () => {
      await result.current.pickFromLibrary();
    });

    expect(result.current.attachments).toHaveLength(2);
    expect(result.current.attachments.map((a) => a.localUri)).toEqual([
      'file://a.jpg',
      'file://b.jpg',
    ]);
    // id 唯一
    const ids = result.current.attachments.map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    expect(fireToast).not.toHaveBeenCalled();
    // 多选 flag + images 限定传给 picker
    expect(h.launchLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: 'images', allowsMultipleSelection: true }),
    );
  });

  it('两次 pick 累加（第二次 append 不覆盖）', async () => {
    h.launchLibrary
      .mockResolvedValueOnce(libraryResult(['file://a.jpg']))
      .mockResolvedValueOnce(libraryResult(['file://b.jpg']));
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.pickFromLibrary();
    });
    await act(async () => {
      await result.current.pickFromLibrary();
    });

    expect(result.current.attachments.map((a) => a.localUri)).toEqual([
      'file://a.jpg',
      'file://b.jpg',
    ]);
  });

  it('canceled → 不追加', async () => {
    h.launchLibrary.mockResolvedValue({ canceled: true, assets: null });
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.pickFromLibrary();
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it('不做相册权限前置门：直接调起 picker（系统 picker 回传 scoped URI，无需 MEDIA_LIBRARY 读权限）', async () => {
    // 回归守卫：expo-image-picker 的 requestMediaLibraryPermissionsAsync 在 API 29–32 会申请已
    // 不可授予的 WRITE_EXTERNAL_STORAGE → 误返 not-granted、把选图永久卡死（真机 Mate50/API31
    // 实证）。相册选图本就不需要 app 持有读权限，故移除权限前置门、禁止再加回。
    h.launchLibrary.mockResolvedValue(libraryResult(['file://a.jpg']));
    const fireToast = vi.fn();
    const { result } = renderHook(() => useIdeationAttachments(fireToast));

    await act(async () => {
      await result.current.pickFromLibrary();
    });

    expect(h.reqLibrary).not.toHaveBeenCalled();
    expect(h.launchLibrary).toHaveBeenCalled();
    expect(fireToast).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(1);
  });
});

describe('useIdeationAttachments — captureFromCamera', () => {
  it('拍照 → 追加 1 个 staged', async () => {
    h.launchCamera.mockResolvedValue(cameraResult('file://shot.jpg'));
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.captureFromCamera();
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.localUri).toBe('file://shot.jpg');
    expect(h.launchCamera).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: 'images' }));
  });

  it('canceled → 不追加', async () => {
    h.launchCamera.mockResolvedValue({ canceled: true, assets: null });
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.captureFromCamera();
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it('相机权限被拒 → fireToast(permissionDenied) + 不拉相机', async () => {
    h.reqCamera.mockResolvedValue(denied);
    const fireToast = vi.fn();
    const { result } = renderHook(() => useIdeationAttachments(fireToast));

    await act(async () => {
      await result.current.captureFromCamera();
    });

    expect(fireToast).toHaveBeenCalledWith('请在系统设置开启相册/相机权限');
    expect(h.launchCamera).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(0);
  });
});

describe('useIdeationAttachments — remove / clear', () => {
  it('remove(id) 只删该附件，其余不动', async () => {
    h.launchLibrary.mockResolvedValue(libraryResult(['file://a.jpg', 'file://b.jpg']));
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.pickFromLibrary();
    });
    const targetId = result.current.attachments[0]?.id ?? '';
    act(() => {
      result.current.remove(targetId);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.localUri).toBe('file://b.jpg');
  });

  it('clear() 清空全部', async () => {
    h.launchLibrary.mockResolvedValue(libraryResult(['file://a.jpg', 'file://b.jpg']));
    const { result } = renderHook(() => useIdeationAttachments(vi.fn()));

    await act(async () => {
      await result.current.pickFromLibrary();
    });
    act(() => {
      result.current.clear();
    });

    expect(result.current.attachments).toHaveLength(0);
  });
});
