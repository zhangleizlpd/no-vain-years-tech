import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { seedInstrumentCreateData } from './sync-universe.usecase.js';

export interface EnsureInstrumentResult {
  /** `existed` = 该行不是本次写入的 (零写入, 含并发下被另一路抢先补齐); `created` = 本次补齐。 */
  status: 'existed' | 'created';
  id: bigint;
}

/**
 * 同步补齐标的行 (086 T004, FR-011; plan D5 第 4 步)。
 *
 * 代码变更修正编排在「采集范围」一步先调它, 再重算采集闸: 冷启动经 outbox 异步补行, 若闸先于
 * 它重算, 新码不会被纳入采集 (analyze F1)。所以标的行在这里**同步**补, 不依赖冷启动是否已跑。
 *
 * 写法同冷启动兜底 seed (`anchor-cold-start.usecase.ts` `seedInstrument`): 先读快路径, 缺行再
 * `upsert` + 空 `update` —— 已有行的 name / syncTier / needSync 一个都不冲掉。create payload 取
 * {@link seedInstrumentCreateData} (默认值的唯一定义)。
 *
 * 空 `update` 的 upsert **不是原子的**: 两路并发补齐同一码时后到的一路抛 P2002
 * (`uk_instrument_market_code`)。EVIDENCE: test/integration/marketdata-086.bars-splice.it.spec.ts
 * T004 ③ 去掉下方 catch 即红「Unique constraint failed on the fields: (`market`, `code`)」
 * (2026-10-16, Prisma 7.8.0)。所以 P2002 在这里折叠为 `existed` 并重读 id, 唯一索引才是守门人。
 */
@Injectable()
export class EnsureInstrumentUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(market: string, code: string): Promise<EnsureInstrumentResult> {
    const existing = await this.prisma.instrument.findUnique({
      where: { market_code: { market, code } },
      select: { id: true },
    });
    if (existing !== null) return { status: 'existed', id: existing.id };

    try {
      const seeded = await this.prisma.instrument.upsert({
        where: { market_code: { market, code } },
        create: seedInstrumentCreateData(market, code),
        update: {},
        select: { id: true },
      });
      return { status: 'created', id: seeded.id };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const raced = await this.prisma.instrument.findUniqueOrThrow({
        where: { market_code: { market, code } },
        select: { id: true },
      });
      return { status: 'existed', id: raced.id };
    }
  }
}
