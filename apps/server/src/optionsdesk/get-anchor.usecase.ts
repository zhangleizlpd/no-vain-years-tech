import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { AnchorRow } from './create-anchor.usecase';
import { resolveInstrumentName } from './instrument-name';
import { toAnchorView, type AnchorView } from './list-anchors.usecase';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';

/**
 * 045 US1 — 单锚详情读端 (FR-001, plan D6)。
 *
 * 与列表共用同一套投影 ({@link toAnchorView}) —— 详情页与列表行显示的派生值必须逐项一致,
 * 各写一套是口径分叉的经典源头 (FR-006)。
 *
 * `excluded = true` 的锚**照常可读** (FR-005: 锚管理侧可见并显示 `exclude_reason`);
 * 排除只作用于雷达默认视图 (Guardrail 12)。
 */
@Injectable()
export class GetAnchorUseCase {
  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 只取「最近一场已收盘交易日」当陈旧度基准 —— 062 T010 起该判据多了「覆盖声明」一维,
    // 自己直查会漂 (漂了只让档位悄悄错一档, 不报错)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  async execute(anchorId: bigint): Promise<AnchorView> {
    const row = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as AnchorRow | null;
    if (row === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }
    return toAnchorView(
      row,
      await resolveLastClosedSessionForTicker(this.calendar, row.ticker),
      await resolveInstrumentName(this.prisma, row.ticker),
    );
  }
}
