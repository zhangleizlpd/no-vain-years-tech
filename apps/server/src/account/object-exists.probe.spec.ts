import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpObjectExistsProbe } from './object-exists.probe';

/**
 * HttpObjectExistsProbe 的状态映射单测（Small：只 stub 全局 fetch，无网络无容器）。
 *
 * 这个 probe 的**全部价值**就在于把 HTTP 状态分成三档；分错档的后果不在本文件里可见，
 * 而在 ConfirmProfileImageUseCase：把「查不出来」当成「对象不在」会对一个上传成功的
 * 用户回 4xx「你上传的对象不存在」。所以这里逐档钉死。
 */

const URL_ = 'https://bucket.example.com/avatar/1/x.jpg';

function stubFetch(impl: () => Promise<Response> | never): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function res(status: number, contentType?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k === 'content-type' ? (contentType ?? null) : null) },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpObjectExistsProbe — 命中', () => {
  it('200 → exists，并带回 content-type', async () => {
    stubFetch(async () => res(200, 'image/jpeg'));
    await expect(new HttpObjectExistsProbe().head(URL_)).resolves.toEqual({
      exists: true,
      contentType: 'image/jpeg',
    });
  });

  it('200 但无 content-type → exists，contentType 为 null（调用方容忍）', async () => {
    stubFetch(async () => res(200));
    await expect(new HttpObjectExistsProbe().head(URL_)).resolves.toEqual({
      exists: true,
      contentType: null,
    });
  });
});

describe('HttpObjectExistsProbe — 404 是唯一能断言「确实不在」的状态', () => {
  it('404 → exists:false 且**不**标 indeterminate', async () => {
    stubFetch(async () => res(404));
    const r = await new HttpObjectExistsProbe().head(URL_);
    expect(r.exists).toBe(false);
    expect(r.indeterminate).toBeFalsy();
  });
});

describe('HttpObjectExistsProbe — 查不出来的一律标 indeterminate', () => {
  // 403 是**真实踩过**的那个：云厂商欠费停用返回 403 UserDisable,不是 404。
  // 旧实现把它当「对象不存在」,于是故障期间用户被告知「你没上传」。
  it.each([
    [403, '桶被停用 / 无权限'],
    [401, '鉴权失败'],
    [429, '限流'],
    [500, '上游 5xx'],
    [503, '上游不可用'],
  ])('%i（%s）→ indeterminate:true', async (status) => {
    stubFetch(async () => res(status));
    const r = await new HttpObjectExistsProbe().head(URL_);
    expect(r.exists).toBe(false);
    expect(r.indeterminate).toBe(true);
  });

  it('fetch 抛错（网络断 / DNS 失败）→ indeterminate:true，不当成「对象不在」', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const r = await new HttpObjectExistsProbe().head(URL_);
    expect(r.exists).toBe(false);
    expect(r.indeterminate).toBe(true);
  });
});
