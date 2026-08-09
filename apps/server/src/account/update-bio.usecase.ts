import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { AccountStatus, Gender, isActive, normalizeBio } from './account.rules';

export interface UpdateBioResult {
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
export class UpdateBioUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, rawBio: string): Promise<UpdateBioResult> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });

    // phone-null row 视为 not-found (沿用旧 repository 守卫语义)。
    if (!account || account.phone === null) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    let bio: string;
    try {
      bio = normalizeBio(rawBio);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('INVALID_BIO')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // 仅 ACTIVE 账号可改 bio (纵深防御 — JwtAuthGuard 已 isActive 拦一道)。
    if (!isActive(account)) {
      throw new Error('ACCOUNT_NOT_ACTIVE: only ACTIVE accounts may update bio');
    }

    // 空串归一为 null —— "未设置 bio" 的 canonical 形态，与新账号未设 bio 的 null 一致
    // (FR-S03 允许清空)。
    const bioToStore = bio === '' ? null : bio;

    await this.prisma.account.update({
      where: { id: accountId },
      data: { bio: bioToStore },
    });

    return {
      accountId: account.id,
      phone: account.phone,
      displayName: account.displayName,
      bio: bioToStore,
      gender: account.gender as Gender | null,
      avatarUrl: account.avatarUrl,
      backgroundImageUrl: account.backgroundImageUrl,
      status: account.status as AccountStatus,
      createdAt: account.createdAt,
    };
  }
}
