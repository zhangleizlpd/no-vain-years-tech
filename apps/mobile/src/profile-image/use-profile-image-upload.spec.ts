// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock api-client mutations + auth store so the real axios / expo-secure-store
// chain never loads (mirrors use-gender-edit.spec). expo-image-picker /
// -manipulator are mocked too: the native select/resize path is device/manual
// (SC-006), not vitest-covered — these mocks only keep the module importable.
const h = vi.hoisted(() => ({
  issueMutate: vi.fn(),
  confirmMutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useAccountProfileControllerIssueUploadCredential: vi.fn(() => ({ mutateAsync: h.issueMutate })),
  useAccountProfileControllerConfirmProfileImage: vi.fn(() => ({ mutateAsync: h.confirmMutate })),
}));
vi.mock('~/auth', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState: () => ({ accountId: '1' }) }),
}));
vi.mock('~/core/api/me-query-key', () => ({ meQueryKey: (id: string) => ['/me', id] }));
vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { WEBP: 'webp' },
}));

import {
  buildUploadFormData,
  ClientValidationError,
  executeUpload,
  mapUploadError,
  OssUploadError,
  type ProcessedImage,
  type UploadFlowDeps,
  useProfileImageUpload,
  validateImageFile,
} from './use-profile-image-upload';

const FIELDS = {
  key: 'avatar/1/uuid/img',
  policy: 'BASE64POLICY',
  'x-oss-signature-version': 'OSS4-HMAC-SHA256',
  'x-oss-credential': 'AK/20260601/cn-shanghai/oss/aliyun_v4_request',
  'x-oss-date': '20260601T000000Z',
  'x-oss-signature': 'deadbeef',
  success_action_status: '200',
} as const;

const WEB_IMAGE: ProcessedImage = {
  file: new Blob(['x'], { type: 'image/webp' }),
  filename: 'upload.webp',
  contentType: 'image/webp',
};

const credentialResponse = {
  host: 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com',
  objectKey: 'avatar/1/uuid/img',
  expiresAt: '2026-06-01T00:15:00.000Z',
  fields: FIELDS,
};

function makeDeps(overrides: Partial<UploadFlowDeps> = {}): UploadFlowDeps {
  return {
    issueCredential: vi.fn().mockResolvedValue(credentialResponse),
    ossPost: vi.fn().mockResolvedValue(200),
    confirm: vi.fn().mockResolvedValue(undefined),
    onSuccess: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildUploadFormData — PostObject 字段序', () => {
  it('fields.* 全部先 append、`file` 字段最后一个（OSS 忽略 file 之后字段）', () => {
    // spy on append 记录顺序（RN FormData 的 TS 类型无 DOM 的 keys() 迭代器）。
    const appendSpy = vi.spyOn(FormData.prototype, 'append');
    buildUploadFormData(FIELDS, WEB_IMAGE);
    const names = appendSpy.mock.calls.map((c) => c[0]);
    expect(names[names.length - 1]).toBe('file');
    // 7 个 policy/签名字段全部在 file 之前
    for (const k of Object.keys(FIELDS)) {
      expect(names.indexOf(k)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(k)).toBeLessThan(names.indexOf('file'));
    }
    appendSpy.mockRestore();
  });
});

describe('executeUpload — 编排顺序 + confirm 仅在直传成功后调', () => {
  it('happy path：EP1 → OSS POST → confirm(objectKey) → onSuccess', async () => {
    const deps = makeDeps();
    const key = await executeUpload('avatar', WEB_IMAGE, deps);
    expect(deps.issueCredential).toHaveBeenCalledWith({
      target: 'avatar',
      contentType: 'image/webp',
    });
    expect(deps.ossPost).toHaveBeenCalledWith(credentialResponse.host, expect.any(FormData));
    expect(deps.confirm).toHaveBeenCalledWith({ target: 'avatar', objectKey: 'avatar/1/uuid/img' });
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(key).toBe('avatar/1/uuid/img');
  });

  it('直传非 2xx → throw OssUploadError，confirm / onSuccess 不调（profile 不脏写）', async () => {
    const deps = makeDeps({ ossPost: vi.fn().mockResolvedValue(403) });
    await expect(executeUpload('avatar', WEB_IMAGE, deps)).rejects.toBeInstanceOf(OssUploadError);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
  });

  it('EP1 失败 → OSS POST / confirm 不调', async () => {
    const deps = makeDeps({
      issueCredential: vi.fn().mockRejectedValue({ isAxiosError: true, response: { status: 429 } }),
    });
    await expect(executeUpload('background', WEB_IMAGE, deps)).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(deps.ossPost).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});

describe('validateImageFile — client 先行拦截（FR-C08）', () => {
  it('非白名单类型 → ClientValidationError(type)', () => {
    expect(() => validateImageFile({ mimeType: 'image/gif', fileSize: 100 }, 'avatar')).toThrow(
      ClientValidationError,
    );
  });
  it('超 size → ClientValidationError(size)', () => {
    expect(() =>
      validateImageFile({ mimeType: 'image/png', fileSize: 6 * 1024 * 1024 }, 'avatar'),
    ).toThrowError(/size/);
  });
  it('白名单 + 限内 → 通过', () => {
    expect(() =>
      validateImageFile({ mimeType: 'image/webp', fileSize: 1024 }, 'background'),
    ).not.toThrow();
  });
});

describe('mapUploadError — 错误映射', () => {
  it('ClientValidationError(type/size/permission) → 对应文案', () => {
    expect(mapUploadError(new ClientValidationError('type'))).toContain('JPG');
    expect(mapUploadError(new ClientValidationError('size'))).toContain('过大');
    expect(mapUploadError(new ClientValidationError('permission'))).toContain('权限');
  });
  it('OssUploadError → 上传失败', () => {
    expect(mapUploadError(new OssUploadError(403))).toContain('上传失败');
  });
  it.each([
    [429, '操作过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
  ])('axios %s → %s', (status, toast) => {
    expect(mapUploadError({ isAxiosError: true, response: { status } })).toBe(toast);
  });
  it('axios 无 response（网络）→ 网络异常', () => {
    expect(mapUploadError({ isAxiosError: true })).toBe('网络异常，请重试');
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useProfileImageUpload — 忙态锁（重复触发忽略，FR-C03）', () => {
  beforeEach(() => {
    h.issueMutate.mockReset().mockResolvedValue({ data: credentialResponse });
    h.confirmMutate.mockReset().mockResolvedValue({ data: {} });
    // OSS 直传 fetch → 200
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200 } as Response);
  });

  it('上传 in-flight 时再次触发被忽略（issue 仅 1 次）', async () => {
    const { result } = renderHook(() => useProfileImageUpload('avatar'), { wrapper });
    await act(async () => {
      // 两次并发触发，busyRef 同步闸 → 第二次直接返回
      await Promise.all([
        result.current.uploadProcessed(WEB_IMAGE),
        result.current.uploadProcessed(WEB_IMAGE),
      ]);
    });
    expect(h.issueMutate).toHaveBeenCalledTimes(1);
    expect(h.confirmMutate).toHaveBeenCalledTimes(1);
    expect(result.current.isUploading).toBe(false);
  });

  it('上传失败 latch errorToast（profile 不脏写：confirm 不调）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 403 } as Response);
    const { result } = renderHook(() => useProfileImageUpload('avatar'), { wrapper });
    await act(async () => {
      await result.current.uploadProcessed(WEB_IMAGE);
    });
    expect(result.current.errorToast).toContain('上传失败');
    expect(h.confirmMutate).not.toHaveBeenCalled();
  });
});
