import { Module } from '@nestjs/common';

/**
 * integrations/oss — 平台层 OSS (对象存储凭证签发) vendor I/O 适配器 (ADR-0058 第四位租户,
 * 紧随 llm/asr/codeindex;036 图片标注 D3)。
 *
 * **非 bounded context**: 无 Prisma schema / 无 moat owner / 无业务域 —— 像 security/ 与
 * integrations/llm·asr 一样被业务 ctx **单向 import** 的基础设施层 (account 现在 / ideation
 * 后续, 两 ctx 单一 PostObject V4 签名维护点)。依赖方向: 业务 ctx → 可 import integrations;
 * integrations **禁** import 任何业务 ctx (ESLint boundaries `integrations` 元素强制叶子方向)。
 *
 * **本 module 形状 (与 llm/asr.module 同)**: `buildPostObjectCredential` 是**纯函数** (零 OSS
 * SDK, Node `crypto` only) —— 无需 DI provider, 本 module 仅 re-export 签名函数 + DTO 类型
 * **以及对象写入 port 的接口 / 令牌 / 默认适配器**, 让消费 ctx 直接 import (account 传
 * avatar/background 对应 keyPrefix + size, ideation 传自己的前缀, research 传 research/)。
 * vendor creds (region/bucket/ak/sk) 由各 ctx 从自己 ConfigModule 的 config (`ossConfig` /
 * `researchOssConfig`) 读出后作参数传入, 平台层不渗 env 语义。
 *
 * ⚠️ **`OBJECT_STORAGE_PORT` 的绑定不在这里做**, 由消费 ctx 自己在 module 里
 * `{ provide: OBJECT_STORAGE_PORT, useClass: OssPostObjectAdapter }` —— 这样 IT 能按 ctx
 * 各自 `useValue` 换成 fake, 而本 module 保持「零 provider 的 re-export 锚」这个形状
 * (与 llm/asr.module 一致)。`FakeObjectStorage` 是**测试专用**, 永不进生产 module。
 *
 * 本 module 当前为 re-export 锚 + 未来若有平台级共享 OSS 设施 (如 object-exists 探针 / 统一
 * 限流) 的挂载点。
 */

export {
  buildPostObjectCredential,
  IMAGE_WHITELIST,
  type ImageContentType,
  type PostObjectCredentialInput,
  type PostObjectCredentialFields,
  type PostObjectCredential,
} from './oss-policy.js';

export {
  OBJECT_STORAGE_PORT,
  ObjectStorageRejectedError,
  ObjectStorageIndeterminateError,
  type ObjectStoragePort,
  type PutObjectInput,
} from './object-storage.port.js';

export { OssPostObjectAdapter } from './oss-post-object.adapter.js';

@Module({})
export class OssModule {}
