import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { AccountStatus, Gender, isActive, normalizeGender } from './account.rules';

export interface UpdateGenderResult {
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
export class UpdateGenderUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, rawGender: string | null): Promise<UpdateGenderResult> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });

    // phone-null row 视为 not-found (沿用旧 repository 守卫语义)。
    if (!account || account.phone === null) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    let gender: Gender | null;
    try {
      gender = normalizeGender(rawGender);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('INVALID_GENDER')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // 仅 ACTIVE 账号可改 gender (纵深防御 — JwtAuthGuard 已 isActive 拦一道)。
    if (!isActive(account)) {
      throw new Error('ACCOUNT_NOT_ACTIVE: only ACTIVE accounts may update gender');
    }

    await this.prisma.account.update({
      where: { id: accountId },
      data: { gender },
    });

    return {
      accountId: account.id,
      phone: account.phone,
      displayName: account.displayName,
      bio: account.bio,
      gender,
      avatarUrl: account.avatarUrl,
      backgroundImageUrl: account.backgroundImageUrl,
      status: account.status as AccountStatus,
      createdAt: account.createdAt,
    };
  }
}
