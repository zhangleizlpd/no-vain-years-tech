import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ossConfig, ossPublicBaseUrl, type OssConfig } from '../config/index.js';
import { PrismaService } from '../security/prisma.service';
import { deriveVersionRank, normalizeScreens } from './mockup.rules.js';

/**
 * 单条 mockup 列表项 (贫血 row 投影 + 派生字段; controller 再投影响应)。
 *
 * - `mockupUrl` = objectKey → 备案展示域 URL 派生 (域名配置化, 复用 `ossPublicBaseUrl`;
 *   OSS 未配 → null, App 据此走渲染降级)。
 * - `versionRank` = append-only 多版按 createdAt 倒序派生 (最新 = 1; 不落 version 列, FR-006)。
 * - `screens` = 逐屏标签清单 (落库 Json 经 `normalizeScreens` 再兜底一道, 旧脏数据防御)。
 */
export interface SessionMockupListItem {
  id: bigint;
  objectKey: string;
  mockupUrl: string | null;
  screens: string[];
  createdAt: Date;
  versionRank: number;
}

/**
 * 037 T007 (US1 / US2 / FR-006 / FR-007) — 列某 session 已交付的 mockup (account-token, app
 * 消费; ideation 叶子 ctx, 扁平 + 贫血 + 直注 PrismaService per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 先校验 session 归属-存在 (镜像 `get-session.usecase`:
 * 查不到本人 session → `NotFoundException('SESSION_NOT_FOUND')`), 他人 / 不存在 session 一律
 * 字节级一致 404 (反枚举, 沿 036 FR-013, 与 ideation 既有读端点统一)。通过后再列 mockup
 * (本人空 session → 200 `{items:[]}`, 与他人 404 现可区分, 这是 404 约定的预期)。
 *
 * 排序: `createdAt desc` (命中 `ix_idea_mockup_session_created`), 最新版在前。`versionRank` 据
 * 同一查询结果倒序派生 (rows 已 desc → rank = [1,2,3…]), 不落 version 列 (senior 测可派生)。
 *
 * 复杂度: O(n), n = 本 session mockup 版本数 (量级低, 不分页)。
 */
@Injectable()
export class ListSessionMockupsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
  ) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<SessionMockupListItem[]> {
    // scope 校验归属 (镜像 get-session.usecase): 查不到本人 session 即 404 (他人 / 不存在不可区分, 反枚举)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // 归属确认后再列 mockup; (sessionId, accountId) 双谓词仍保留 (归属冗余防御, 本人空 session → [])。
    const rows = await this.prisma.ideationMockup.findMany({
      where: { sessionId, accountId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, objectKey: true, screens: true, createdAt: true },
    });

    // versionRank 与 rows 一一对位 (rows 已 createdAt desc → rank 自然 [1,2,3…])。
    const ranks = deriveVersionRank(rows);

    // 备案展示域 base (OSS 未配 → null; objectKey 拼前缀派生内联 URL)。
    const base =
      this.ossCfg.kind === 'aliyun'
        ? ossPublicBaseUrl(this.ossCfg.region, this.ossCfg.bucket, this.ossCfg.publicBaseUrl)
        : null;

    return rows.map((row, index) => ({
      id: row.id,
      objectKey: row.objectKey,
      mockupUrl: base ? `${base}/${row.objectKey}` : null,
      screens: normalizeScreens(row.screens),
      createdAt: row.createdAt,
      versionRank: ranks[index],
    }));
  }
}
