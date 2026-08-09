import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 032 — 可运营 LLM 文案读取（`ideation.prompt_config` 表，key 寻址）。访谈人设 / brief
 * 产出指令等 system prompt 的运行期取值出口：优先读表内 key 行（后续管理控制台维护，改文案
 * 不发版），行缺失 / 内容空 / 读库失败 → 回落调用方传入的 DEFAULT 常量（单一默认源，表不
 * 预 seed 防双源 drift）。clarify-turn / generate-brief 两 UC 共享。
 *
 * 缓存：进程级 key→{content,expiresAt}，TTL 60s（后台改表最迟 60s 生效，避免每轮读库）。
 * 读库失败兜底 DEFAULT —— 人设是增强非硬依赖，不让配置读取拖垮澄清 / 产出主流程。
 */
const CACHE_TTL_MS = 60_000;

@Injectable()
export class PromptConfigService {
  /** key → {内容, 过期时刻}；进程级单例跨请求复用。 */
  private readonly cache = new Map<string, { content: string; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 取 key 对应文案：表内非空行优先，否则回落 fallback。60s 进程缓存；读库失败回落 fallback。
   * @param key prompt_config 主键（如 interview_persona / brief_emit_persona）。
   * @param fallback 表内缺失时的默认文案（DEFAULT 常量）。
   */
  async get(key: string, fallback: string): Promise<string> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      return hit.content;
    }
    let content = fallback;
    try {
      const row = await this.prisma.promptConfig.findUnique({
        where: { key },
        select: { content: true },
      });
      if (row !== null && row.content.trim().length > 0) {
        content = row.content;
      }
    } catch {
      // 读库失败 → 用 fallback（增强项不阻断主流程）。
    }
    this.cache.set(key, { content, expiresAt: now + CACHE_TTL_MS });
    return content;
  }
}
