// GOLDEN SAMPLE — server 简单档（单 ctx CRUD 默认）。新单 ctx use case 起手对照此文件。
// 演示 flat 内构 + 贫血 Prisma row + `*.rules.ts` 纯函数校验（normalizeDisplayName）+
// 直注 PrismaService + 投影返回。三候选（bio / display-name / gender）中噪声最少：
// 必填非空、无空串→null 归一、无 nullable enum 分支。跨端配对样板 = mobile
// `app/(app)/settings/account-security/name-edit.tsx`（同一 display-name feature 两端）。
// 分层声明见 docs/conventions/server-impl-playbook.md § Golden Sample。
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { AccountStatus, Gender, isActive, normalizeDisplayName } from './account.rules';

export interface UpdateDisplayNameResult {
  accountId: bigint;
  phone: string;
  displayName: string | null;
  bio: string | null;
  gender: Gender | null;
  avatarUrl: string | null;
  backgroundImageUrl: string | null;
  status: AccountStatus;
  createdAt: Date;
}

@Injectable()
export class UpdateDisplayNameUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, rawDisplayName: string): Promise<UpdateDisplayNameResult> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });

    // phone-null row 视为 not-found (沿用旧 repository 守卫语义)。
    if (!account || account.phone === null) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    let displayName: string;
    try {
      displayName = normalizeDisplayName(rawDisplayName);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('INVALID_DISPLAY_NAME')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // 仅 ACTIVE 账号可改 display name (纵深防御 — JwtAuthGuard 已 isActive 拦一道)。
    if (!isActive(account)) {
      throw new Error('ACCOUNT_NOT_ACTIVE: only ACTIVE accounts may update display name');
    }

    await this.prisma.account.update({
      where: { id: accountId },
      data: { displayName },
    });

    return {
      accountId: account.id,
      phone: account.phone,
      displayName,
      bio: account.bio,
      gender: account.gender as Gender | null,
      avatarUrl: account.avatarUrl,
      backgroundImageUrl: account.backgroundImageUrl,
      status: account.status as AccountStatus,
      createdAt: account.createdAt,
    };
  }
}
