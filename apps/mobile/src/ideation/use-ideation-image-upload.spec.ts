// @vitest-environment happy-dom
// 036 T009 — ideation 图片上传纯逻辑单测（错误映射 / FormData 顺序 / 编排调凭证 fn / 直传失败）。
// 复用 profile-image 上传 4 步流范式；唯一差异 = 签名 EP 换 ideation 凭证 fn + 无 confirm。
// 交互 + 流式禁用走 T015 e2e（本组只测纯逻辑，per 测试分层 vitest=logic）。
import { describe, expect, it, vi } from 'vitest';

// Mock api-client + expo-image-manipulator so the real axios / native resize
// chain never loads (mirrors profile-image/use-profile-image-upload.spec). The
// native compress path (compressForUpload) is device/manual + T015 e2e seam,
// not vitest-covered — these mocks only keep the module importable.
vi.mock('@nvy/api-client', () => ({
  attachmentCredentialControllerIssue: vi.fn(),
}));
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { WEBP: 'webp' },
}));

import type { AttachmentCredentialFieldsResponse } from '@nvy/api-client';

import {
  buildIdeationUploadFormData,
  executeIdeationUpload,
  IdeationOssUploadError,
  IDEATION_IMAGE_WHITELIST,
  IDEATION_MAX_UPLOAD_BYTES,
  IDEATION_RESIZE_WIDTH,
  mapIdeationUploadError,
  type ProcessedIdeationImage,
} from './use-ideation-image-upload';

const FIELDS: AttachmentCredentialFieldsResponse = {
  key: 'ideation/acc-1/abc.webp',
  policy: 'base64policy',
  'x-oss-signature-version': 'OSS4-HMAC-SHA256',
  'x-oss-credential': 'cred',
  'x-oss-date': '20260625T000000Z',
  'x-oss-signature': 'deadbeef',
  success_action_status: '200',
} as AttachmentCredentialFieldsResponse;

const WEB_PROCESSED: ProcessedIdeationImage = {
  file: new Blob(['x'], { type: 'image/webp' }),
  filename: 'ideation-upload.webp',
  contentType: 'image/webp',
};

describe('mapIdeationUploadError', () => {
  it('OSS 直传非 2xx → 上传失败文案', () => {
    expect(mapIdeationUploadError(new IdeationOssUploadError(403))).toBe('图片上传失败，请重试');
  });

  it('axios 429 → 限流文案', () => {
    expect(mapIdeationUploadError({ isAxiosError: true, response: { status: 429 } })).toBe(
      '操作过于频繁，请稍后再试',
    );
  });

  it('axios 无 response（断网）→ 网络文案', () => {
    expect(mapIdeationUploadError({ isAxiosError: true })).toBe('网络异常，请重试');
  });

  it('axios 5xx → 网络文案', () => {
    expect(mapIdeationUploadError({ isAxiosError: true, response: { status: 502 } })).toBe(
      '网络异常，请重试',
    );
  });

  it('RN fetch 直传连接层失败（TypeError: Network request failed）→ 网络文案（真机无外网实证）', () => {
    expect(mapIdeationUploadError(new TypeError('Network request failed'))).toBe(
      '网络异常，请重试',
    );
  });

  it('非 axios 未知错误 → 兜底文案（不泄 vendor 细节）', () => {
    expect(mapIdeationUploadError(new Error('boom'))).toBe('上传失败，请稍后重试');
  });
});

describe('压缩参数（对齐 M3 + size 上限）', () => {
  it('白名单 = JPEG/PNG/WebP', () => {
    expect([...IDEATION_IMAGE_WHITELIST]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('上限 = 10MB（对齐 server keyPrefix size 上限）', () => {
    expect(IDEATION_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('resize 长边收敛', () => {
    expect(IDEATION_RESIZE_WIDTH).toBe(1280);
  });
});

describe('buildIdeationUploadFormData', () => {
  it('fields.* 先 append、file 最后（OSS 官方明文的顺序要求）', () => {
    const form = buildIdeationUploadFormData(FIELDS, WEB_PROCESSED);
    const entries = [
      ...(form as unknown as { entries: () => Iterable<[string, unknown]> }).entries(),
    ];
    const keys = entries.map(([k]) => k);
    expect(keys[keys.length - 1]).toBe('file');
    expect(keys).toContain('policy');
    expect(keys).toContain('key');
  });
});

describe('executeIdeationUpload（编排：凭证 EP → OSS POST → objectKey，无 confirm）', () => {
  it('happy：调凭证 fn 传 sessionId+contentType → 直传 2xx → 返 objectKey', async () => {
    const issueCredential = vi.fn().mockResolvedValue({
      host: 'https://bucket.oss.example',
      objectKey: 'ideation/acc-1/abc.webp',
      expiresAt: '2026-06-25T01:00:00Z',
      fields: FIELDS,
    });
    const ossPost = vi.fn().mockResolvedValue(204);

    const key = await executeIdeationUpload('sess-1', WEB_PROCESSED, { issueCredential, ossPost });

    expect(issueCredential).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      contentType: 'image/webp',
    });
    expect(ossPost).toHaveBeenCalledOnce();
    expect(ossPost).toHaveBeenCalledWith('https://bucket.oss.example', expect.anything());
    expect(key).toBe('ideation/acc-1/abc.webp');
  });

  it('直传非 2xx → throw IdeationOssUploadError（不返 key、不脏写）', async () => {
    const issueCredential = vi.fn().mockResolvedValue({
      host: 'https://bucket.oss.example',
      objectKey: 'ideation/acc-1/abc.webp',
      expiresAt: '2026-06-25T01:00:00Z',
      fields: FIELDS,
    });
    const ossPost = vi.fn().mockResolvedValue(403);

    await expect(
      executeIdeationUpload('sess-1', WEB_PROCESSED, { issueCredential, ossPost }),
    ).rejects.toBeInstanceOf(IdeationOssUploadError);
  });
});
