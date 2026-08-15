import type { PostObjectCredential } from './oss-policy.js';

/**
 * 对象写入 port —— 平台层 OSS 出站 I/O（ADR-0043 port 三分法第三类：外部服务留 port）。
 *
 * 存在的理由是**测试隔离**：`buildPostObjectCredential` 是纯函数、无 port 也可测，但
 * 「组 FormData + POST 到 OSS」有真网络 I/O，没有 port 的话 IT 会真打云上的桶
 * （既慢、又要真凭证、还会往生产桶里塞垃圾对象 —— 而这把 AK 没有删除权限，塞进去清不掉）。
 *
 * ## 三态结局（`putObject` 的契约）
 *
 * 1. **确认写入成功** —— 正常返回。
 * 2. **确认被拒** —— 抛 {@link ObjectStorageRejectedError}。对方明确说「不行」：签名不符 /
 *    超出 policy 的 content-length-range / 前缀越界被 RAM 拒。**重试无意义**。
 * 3. **无法确定** —— 抛 {@link ObjectStorageIndeterminateError}。超时、连接中断、5xx ——
 *    请求可能已经落地，也可能没有。
 *
 * 🚨 **2 与 3 绝不可压成一态**（FR-008）。把「无法确定」当「被拒」，用户明明可能已经传成功，
 * 却被告知失败，于是重传 —— 而对象存储侧我们**没有读权限**（FR-018），无法事后回查验证。
 * 这也是本 port 不提供 `head` / `exists` 的原因：那类补偿手段在这套 RAM 策略下根本不可用，
 * 判定只能基于写入动作**自身**的响应。
 */
export interface PutObjectInput {
  /** 由 `buildPostObjectCredential` 现签的一次性表单凭证（host + fields 全在里面）。 */
  credential: PostObjectCredential;
  /** 对象字节。签名时 `content-length-range` 的上界必须已经覆盖它。 */
  body: Buffer;
  /** part 的 Content-Type，必须落在凭证 policy 的白名单内（如 `application/pdf`）。 */
  contentType: string;
  /** multipart 里 `file` part 的 filename，仅供 OSS 侧日志可读，不参与签名。 */
  filename: string;
}

export interface ObjectStoragePort {
  /**
   * 写一个对象。成功即正常返回；失败按上文三态抛两种具名异常之一。
   */
  putObject(input: PutObjectInput): Promise<void>;
}

export const OBJECT_STORAGE_PORT = Symbol('OBJECT_STORAGE_PORT');

/**
 * 确认被拒（对方明确说不行）。
 *
 * 🚨 `code` 只装 OSS 错误 XML 里的 `<Code>` 一个字段，**绝不装响应体全文**：
 * OSS 的 `SignatureDoesNotMatch` 响应体里带 `<StringToSign>` 与 `<SignatureProvided>`，
 * 整份塞进异常消息 = 签名素材进日志。这条不是洁癖，是本类存在 `code` 而非 `body` 的原因。
 */
export class ObjectStorageRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`对象存储拒绝了写入请求 (HTTP ${status}, code=${code})`);
    this.name = 'ObjectStorageRejectedError';
  }
}

/** 无法确定（超时 / 连接中断 / 5xx）—— 既不能断言成功，也不能断言失败。 */
export class ObjectStorageIndeterminateError extends Error {
  constructor(readonly reason: string) {
    super(`对象存储可达性不确定: ${reason}`);
    this.name = 'ObjectStorageIndeterminateError';
  }
}
