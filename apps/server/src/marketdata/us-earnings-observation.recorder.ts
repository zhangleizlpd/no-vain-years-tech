import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { EarningsCalendarEvent } from './earnings-calendar.port.js';
import {
  FUTU_CALENDAR_SOURCE,
  loadFutuObservationLookup,
  toSourceObservations,
} from './futu-calendar.source.js';
import { SyncEarningsDatesUseCase } from './sync-earnings-dates.usecase.js';
import type { EarningsObservationRecorder } from './sync-earnings-event.usecase.js';
import { emptyStats } from './sync-run.recorder.js';

const US_MARKET = 'us';

/**
 * 美股钩子记录器 (079 T020, FR-021 / SC-008, plan §D9)：`earnings_event` 本轮已取到的富途事件 →
 * 观测层 → 增量合并出美股事件 (恒 `unconfirmed`，富途美股口径含预估，FR-021)。
 *
 * 三步 (查找表 + 映射 → 观测落库 → 增量合并) 顺序执行、失败直接抛；调用方
 * `SyncEarningsEventUseCase` 用**同一个** try/catch 包住整个 `record`。
 *
 * 复杂度：2 次读 (查找表) + {@link SyncEarningsDatesUseCase.recordObservations} +
 * O(K) 个事件的合并读写 (K = 本批观测键数)。零 vendor 调用。
 */
@Injectable()
export class UsEarningsObservationRecorder implements EarningsObservationRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dates: SyncEarningsDatesUseCase,
  ) {}

  async record(events: readonly EarningsCalendarEvent[], now: Date): Promise<void> {
    const lookup = await loadFutuObservationLookup(this.prisma, US_MARKET);
    const { observations } = toSourceObservations(events, US_MARKET, lookup);
    if (observations.length === 0) return;
    // 🚨 临时 stats：recordObservations 会 addWritten，传现役 stats 就改写了 earnings_event 的 written。
    await this.dates.recordObservations(
      FUTU_CALENDAR_SOURCE,
      US_MARKET,
      observations,
      now,
      emptyStats(),
    );
    // 🚨 必须合并 (plan §D9 ⑤)：只写观测时美股事件恒 0 行。传本批**全部**键而非仅新插入的键 ——
    // 既有观测改期后，其事件同样要重算。
    await this.dates.mergeIncremental({
      market: US_MARKET,
      now,
      keys: observations.map(({ instrumentId, periodKey }) => ({ instrumentId, periodKey })),
    });
  }
}
