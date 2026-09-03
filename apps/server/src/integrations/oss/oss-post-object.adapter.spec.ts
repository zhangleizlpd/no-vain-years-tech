import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ObjectStorageIndeterminateError,
  ObjectStorageRejectedError,
  type PutObjectInput,
} from './object-storage.port.js';
import { OssPostObjectAdapter } from './oss-post-object.adapter.js';
import type { PostObjectCredential } from './oss-policy.js';

/** 签名值取一个显眼的哨兵串 —— 断言 ④ 靠它才能真失败。 */
const SIGNATURE = 'SIGNATURE-MUST-NOT-LEAK-0123456789abcdef';

const CREDENTIAL: PostObjectCredential = {
  host: 'https://bucket.oss-cn-shanghai.aliyuncs.com',
  objectKey: 'research/deadbeef/report.pdf',
  expiresAt: '2026-08-15T12:01:00.000Z',
  fields: {
    key: 'research/deadbeef/report.pdf',
    policy: 'BASE64POLICY',
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': 'AK/20260815/cn-shanghai/oss/aliyun_v4_request',
    'x-oss-date': '20260815T120000Z',
    'x-oss-signature': SIGNATURE,
    success_action_status: '200',
  },
};

const INPUT: PutObjectInput = {
  credential: CREDENTIAL,
  body: Buffer.from('%PDF-1.4 fake'),
  contentType: 'application/pdf',
  filename: 'report.pdf',
};

/** OSS 的 SignatureDoesNotMatch 响应体**真的**带签名素材 —— 整份进日志即泄漏。 */
const SIGNATURE_ERROR_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Error>' +
  '<Code>SignatureDoesNotMatch</Code>' +
  '<Message>The request signature we calculated does not match.</Message>' +
  `<StringToSign>BASE64POLICY</StringToSign><SignatureProvided>${SIGNATURE}</SignatureProvided>` +
  '</Error>';

function stubFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl as never);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 把 adapter 交给 fetch 的 FormData 序列化成真正上线的那串字节。 */
async function serialize(init: RequestInit): Promise<{ contentType: string; body: string }> {
  const res = new Response(init.body as never);
  return {
    contentType: res.headers.get('content-type') ?? '',
    body: await res.text(),
  };
}

describe('OssPostObjectAdapter — 上线字节形状', () => {
  it('① `file` 是 multipart 的最后一段（官方明文: file 必须为最后一个表单域）', async () => {
    let captured: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      captured = init;
      return new Response('', { status: 200 });
    });

    await new OssPostObjectAdapter().putObject(INPUT);

    const { contentType, body } = await serialize(captured!);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    // 前面那个 `[; ]` 不可省：否则 `filename="report.pdf"` 也会被当成一个 part 名字，
    // 于是「最后一段是 file」这条断言恒不成立（第一版实测就撞了这个）。
    const names = [...body.matchAll(/[; ]name="([^"]+)"/g)].map((m) => m[1]);
    expect(names[names.length - 1]).toBe('file');
    // 七个签名/policy 字段全部排在 file 之前，一个不漏。
    for (const k of Object.keys(CREDENTIAL.fields)) {
      expect(names.indexOf(k)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(k)).toBeLessThan(names.indexOf('file'));
    }
  });

  it('② `file` part 带 Content-Type: application/pdf（policy 的 $content-type 校验的就是它）', async () => {
    let captured: RequestInit | undefined;
    stubFetch(async (_url, init) => {
      captured = init;
      return new Response('', { status: 200 });
    });

    await new OssPostObjectAdapter().putObject(INPUT);

    const { body } = await serialize(captured!);
    const filePart = body.slice(body.indexOf('name="file"'));
    expect(filePart).toContain('Content-Type: application/pdf');
    expect(filePart).toContain('filename="report.pdf"');
  });

  it('POST 到凭证给出的 host，且不手设 Content-Type（要让 undici 自己生成带 boundary 那条）', async () => {
    let url = '';
    let captured: RequestInit | undefined;
    stubFetch(async (u, init) => {
      url = u;
      captured = init;
      return new Response('', { status: 200 });
    });

    await new OssPostObjectAdapter().putObject(INPUT);

    expect(url).toBe(CREDENTIAL.host);
    expect(captured?.method).toBe('POST');
    expect(captured?.headers).toBeUndefined();
  });
});

describe('OssPostObjectAdapter — 三态结局', () => {
  it('③ 4xx → ObjectStorageRejectedError，status 与 OSS Code 都不吞', async () => {
    stubFetch(async () => new Response(SIGNATURE_ERROR_XML, { status: 403 }));

    const err = await new OssPostObjectAdapter().putObject(INPUT).catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ObjectStorageRejectedError);
    const rejected = err as ObjectStorageRejectedError;
    expect(rejected.status).toBe(403);
    expect(rejected.code).toBe('SignatureDoesNotMatch');
    expect(rejected.message).toContain('403');
    expect(rejected.message).toContain('SignatureDoesNotMatch');
  });

  it('④ 异常消息不含 x-oss-signature 与任何签名素材', async () => {
    stubFetch(async () => new Response(SIGNATURE_ERROR_XML, { status: 403 }));

    const err = (await new OssPostObjectAdapter()
      .putObject(INPUT)
      .catch((e: unknown): unknown => e)) as Error;

    const dumped = `${err.message}${err.stack ?? ''}`;
    expect(dumped).not.toContain(SIGNATURE);
    expect(dumped).not.toContain('StringToSign');
    expect(dumped).not.toContain('x-oss-signature');
    expect(dumped).not.toContain('BASE64POLICY');
  });

  it('5xx → ObjectStorageIndeterminateError（MUST NOT 压成「被拒」）', async () => {
    stubFetch(
      async () => new Response('<Error><Code>InternalError</Code></Error>', { status: 503 }),
    );

    const err = await new OssPostObjectAdapter().putObject(INPUT).catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ObjectStorageIndeterminateError);
    expect(err).not.toBeInstanceOf(ObjectStorageRejectedError);
  });

  it('网络层抛错（超时 / 连接中断）→ ObjectStorageIndeterminateError', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const err = await new OssPostObjectAdapter().putObject(INPUT).catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ObjectStorageIndeterminateError);
  });

  it('200 → 正常返回（不抛）', async () => {
    stubFetch(async () => new Response('', { status: 200 }));
    await expect(new OssPostObjectAdapter().putObject(INPUT)).resolves.toBeUndefined();
  });
});
