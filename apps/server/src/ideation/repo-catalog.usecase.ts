import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CODE_INDEX,
  type CodeIndexProvider,
  type RepoCatalogEntry,
} from '../integrations/codeindex/code-index.module';

/**
 * 拉可接地仓目录 (034 T005, FR-004 / FR-010 / US2) —— 透传 CODE_INDEX 端口 `listRepos()`
 * 供 mobile「选择代码库」。ideation 叶子 ctx, 直注平台端口 (platform integration, 与
 * LLM_PROVIDER 同类, 无护城河注释要求 per ADR-0041)。贫血: 端口 DTO 原样返, 控制层映射。
 *
 * 🚨 降级 (FR-010 / ADR-0060): 端口不可达 (停服 / 超时 / 网络错 / 鉴权失败 → throw) →
 * catch → 转 `ServiceUnavailableException('CODE_INDEX_UNAVAILABLE')` → ProblemDetailFilter
 * 映射 503 + RFC 9457 (前端可重试)。**底层错误细节不外泄** (仅通用 code/message, 不回 token /
 * stack / 内部状态)。空列表 (端口正常返 `[]`) 与不可达严格分流: 空列表正常返 `[]` (非错误)。
 */
@Injectable()
export class RepoCatalogUseCase {
  private readonly logger = new Logger(RepoCatalogUseCase.name);

  constructor(@Inject(CODE_INDEX) private readonly codeIndex: CodeIndexProvider) {}

  async execute(): Promise<RepoCatalogEntry[]> {
    try {
      return await this.codeIndex.listRepos();
    } catch (err) {
      // 不可达: 仅记内部日志 (含底层错误), 对外只暴露通用 503, 不泄露 token / stack。
      this.logger.warn(
        `code-index listRepos unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 对外只暴露 domain code + 通用 message (ProblemDetailFilter 读 body.code, 同
      // SmsSendFailedException 范式); 底层错误细节仅入日志, 不回前端。
      throw new ServiceUnavailableException({
        code: 'CODE_INDEX_UNAVAILABLE',
        message: '索引服务暂不可用,请稍后重试',
      });
    }
  }
}
