import {
  ObjectStorageIndeterminateError,
  ObjectStorageRejectedError,
  type ObjectStoragePort,
  type PutObjectInput,
} from './object-storage.port.js';

/**
 * 🚨 **测试专用。MUST NOT 注册进 `app.module` / 任何生产 module。**
 *
 * 给 usecase 单测与 IT 用的 `ObjectStoragePort` 替身：记下每次写入，并可预置结局，
 * 以便覆盖 `spec.md` 里那几条只能靠「让存储侧按剧本失败」才能到达的分支
 * （对象已写但元数据失败 / 续做时对象已存在 / 写入失败 / 可达性不确定）。
 *
 * 三态与真适配器**同构**（正常返回 / `ObjectStorageRejectedError` / `ObjectStorageIndeterminateError`），
 * 否则测试通过的分支与生产走的分支就不是同一套。
 */
export type FakePutOutcome = 'stored' | 'rejected' | 'indeterminate';

export class FakeObjectStorage implements ObjectStoragePort {
  /** 每次 `putObject` 的入参，按调用序。断言「没多写一份对象」靠它。 */
  readonly calls: PutObjectInput[] = [];

  /** 预置结局队列，逐次消费；空了之后回落到 {@link defaultOutcome}。 */
  private readonly queued: FakePutOutcome[] = [];

  /** 队列耗尽后的默认结局。 */
  defaultOutcome: FakePutOutcome = 'stored';

  /** 按序预置接下来几次调用的结局，如 `enqueue('indeterminate', 'stored')` 模拟重试成功。 */
  enqueue(...outcomes: FakePutOutcome[]): void {
    this.queued.push(...outcomes);
  }

  /** 已写入的对象 key，按调用序（重复 key 会重复出现 —— 幂等重写也是一次调用）。 */
  get objectKeys(): string[] {
    return this.calls.map((c) => c.credential.objectKey);
  }

  async putObject(input: PutObjectInput): Promise<void> {
    this.calls.push(input);
    const outcome = this.queued.shift() ?? this.defaultOutcome;
    if (outcome === 'rejected') {
      throw new ObjectStorageRejectedError(403, 'FakeRejected');
    }
    if (outcome === 'indeterminate') {
      throw new ObjectStorageIndeterminateError('fake: 无法确定');
    }
  }
}
