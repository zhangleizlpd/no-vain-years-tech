import {
  ObjectStorageIndeterminateError,
  ObjectStorageRejectedError,
  type ObjectStoragePort,
  type PutObjectInput,
} from './object-storage.port.js';

/**
 * `ObjectStoragePort` 的默认实现 —— 用 Node 内建 `fetch`/`FormData`/`Blob`（undici）
 * 把 PostObject 表单 POST 给 OSS。零 OSS SDK，与 `oss-policy.ts` 的手写 V4 签名同一取向
 * （引 `ali-oss` 只用得上 1% 能力，却要付 Trivy 阻塞面与 prune 风险面）。
 *
 * ## 三个「写错了不会红、但真环境必崩」的点
 *
 * 1. **`file` 必须最后 append** —— OSS **忽略 `file` 之后的所有字段**，签名字段排在它后面
 *    等于没传，表现是 403 而报错完全不指向这里。
 * 2. **必须是带 `type` 的 `Blob`，不能是裸 `Buffer`** —— part 的 Content-Type 来自 Blob 的
 *    `type`，传裸 Buffer 会让该 part 没有 content-type，于是 policy 的 `$content-type`
 *    条件不满足 ⇒ 同样 403、同样不指向这里。
 * 3. **不要手设 `Content-Type` 请求头** —— 要让 undici 自己生成带 boundary 的那条。手设
 *    会丢掉 boundary，服务端无法切分 part。
 *
 * Phase 0 已用真凭证打真桶验过这条链路（写 `research/` 200 / 写前缀外 403 / 超
 * `content-length-range` 400），vendor spec 是它的回归版本。
 */
export class OssPostObjectAdapter implements ObjectStoragePort {
  async putObject({ credential, body, contentType, filename }: PutObjectInput): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(credential.fields)) {
      form.append(key, value);
    }
    // 🚨 最后一个 —— 见上文第 1 点。
    form.append('file', new Blob([body], { type: contentType }), filename);

    let res: Response;
    try {
      res = await fetch(credential.host, { method: 'POST', body: form });
    } catch (err) {
      // 超时 / 连接中断 / DNS —— 请求可能已经落地也可能没有，不可断言失败。
      throw new ObjectStorageIndeterminateError(err instanceof Error ? err.name : 'network error');
    }

    if (res.ok) return;

    const code = await readErrorCode(res);
    // 5xx = 对方自己也没给出结论（含网关错误、欠费停用期间的抖动）⇒ 不确定态。
    if (res.status >= 500) {
      throw new ObjectStorageIndeterminateError(`HTTP ${res.status} (code=${code})`);
    }
    throw new ObjectStorageRejectedError(res.status, code);
  }
}

/**
 * 从 OSS 的错误 XML 里**只**摘 `<Code>`。
 *
 * 🚨 刻意不返回响应体全文：`SignatureDoesNotMatch` 的响应体带 `<StringToSign>` 与
 * `<SignatureProvided>`，把它带进异常消息 = 签名素材进日志（异常最终会被 filter 记下来）。
 * 读体本身也可能失败（连接在读到一半时断），那时退回一个占位串而不是让读体的错误盖掉
 * 真正的 HTTP 状态。
 */
async function readErrorCode(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? 'unknown';
}
