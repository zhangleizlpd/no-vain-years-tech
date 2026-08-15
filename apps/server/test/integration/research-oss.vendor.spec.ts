import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildPostObjectCredential } from '../../src/integrations/oss/oss-policy.js';
import {
  ObjectStorageRejectedError,
  type PutObjectInput,
} from '../../src/integrations/oss/object-storage.port.js';
import { OssPostObjectAdapter } from '../../src/integrations/oss/oss-post-object.adapter.js';

/**
 * 研报归档 OSS 真 vendor IT（057；账号 C 的私有桶）——  Phase 0 那次一次性 PoC 的**回归版**。
 *
 * 验的是三件只有真桶能回答的事：跨账号公网 endpoint 真的可用 / RAM 策略的作用域真的卡在
 * `research/` 前缀上 / policy 的 `content-length-range` 真的是云侧硬闸。
 *
 * 🚨 **第 2 条是反例，缺了它整个文件就没有意义** —— 只跑「写得进去」的话，一个权限过宽的
 * 策略（比如给了整桶 PutObject）同样全绿。FR-018「凭证只具写入能力」在代码侧**没有任何
 * 可断言的载体**（服务端怎么写都改变不了凭证权限），这条断言是它唯一的回归防线。
 * ⇒ **每次轮换 AK 之后必须手工重跑本文件**。
 *
 * **默认 skip**（env-gated）：会往真桶里写对象，而这把 AK **没有删除权限**，写进去的清不掉
 * （每次跑留一个几百字节的小对象）。CI / 常规 `nx affected` 不跑。
 *
 * **本地启用**（真值只经内存，别手工粘 token 进终端）：
 *   RUN_RESEARCH_OSS_IT=1 RESEARCH_OSS_REGION=oss-cn-shanghai RESEARCH_OSS_BUCKET=<桶> \
 *   sops exec-env ~/.nvy/secrets.enc.env \
 *     'pnpm exec nx test server research-oss.vendor'
 */
const RUN_RESEARCH_OSS_IT = process.env.RUN_RESEARCH_OSS_IT === '1';

/** 一份最小合法 PDF（`%PDF-` 魔数 + trailer），约 300 字节。 */
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

describe.skipIf(!RUN_RESEARCH_OSS_IT)('研报 OSS 真 vendor IT (env-gated, 默认 skip)', () => {
  const region = process.env.RESEARCH_OSS_REGION ?? '';
  const bucket = process.env.RESEARCH_OSS_BUCKET ?? '';
  const accessKeyId = process.env.RESEARCH_OSS_ACCESS_KEY_ID ?? '';
  const accessKeySecret = process.env.RESEARCH_OSS_ACCESS_KEY_SECRET ?? '';

  function input(keyPrefix: string, maxSizeBytes: number): PutObjectInput {
    // 缺 env 时用空串去打云端只会拿到一个无意义的错误 —— 让它在这里就炸，且指出缺哪个。
    for (const [name, value] of Object.entries({
      RESEARCH_OSS_REGION: region,
      RESEARCH_OSS_BUCKET: bucket,
      RESEARCH_OSS_ACCESS_KEY_ID: accessKeyId,
      RESEARCH_OSS_ACCESS_KEY_SECRET: accessKeySecret,
    })) {
      if (!value) throw new Error(`缺少环境变量 ${name}`);
    }
    return {
      credential: buildPostObjectCredential({
        region,
        bucket,
        accessKeyId,
        accessKeySecret,
        keyPrefix,
        maxSizeBytes,
        contentTypeWhitelist: ['application/pdf'],
        keyLeaf: 'report.pdf',
        ttlMs: 60_000, // server 自签自用，不需要客户端直传那个 15min
        now: new Date(),
        uuid: randomUUID(),
      }),
      body: TINY_PDF,
      contentType: 'application/pdf',
      filename: 'vendor-spec.pdf',
    };
  }

  it('写 research/ 前缀 → 成功（跨账号公网 endpoint 可用）', async () => {
    await expect(
      new OssPostObjectAdapter().putObject(input('research/', 16 * 1024 * 1024)),
    ).resolves.toBeUndefined();
  });

  it('反例：写 research/ 之外 → 403 AccessDenied（RAM 作用域生效，凭证权限不过宽）', async () => {
    const err = await new OssPostObjectAdapter()
      .putObject(input('notallowed/', 16 * 1024 * 1024))
      .catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ObjectStorageRejectedError);
    expect((err as ObjectStorageRejectedError).status).toBe(403);
    expect((err as ObjectStorageRejectedError).code).toBe('AccessDenied');
  });

  it('反例：超 content-length-range → 被云侧体积闸拒（我们代码有 bug 也绕不过的那道）', async () => {
    // 上界 100 字节 < TINY_PDF 的约 300 字节。
    const err = await new OssPostObjectAdapter()
      .putObject(input('research/', 100))
      .catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ObjectStorageRejectedError);
    expect((err as ObjectStorageRejectedError).status).toBe(400);
  });
});
