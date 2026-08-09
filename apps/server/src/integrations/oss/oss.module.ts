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
 * SDK, Node `crypto` only) —— 无需 DI provider, 本 module 仅 re-export 签名函数 + DTO 类型,
 * 让消费 ctx 直接 import 调用 (account 传 avatar/background 对应 keyPrefix + size, ideation 传
 * 自己的前缀)。vendor creds (region/bucket/ak/sk) 由各 ctx 从自己 ConfigModule 的 `ossConfig`
 * 读出后作参数传入, 平台层不渗 env 语义。
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

@Module({})
export class OssModule {}
