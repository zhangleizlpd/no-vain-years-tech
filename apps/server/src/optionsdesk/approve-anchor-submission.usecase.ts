import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import type { AnchorFallbackReportEntry } from './anchor-cascade';
import { type AnchorSubmissionStatus } from './anchor-import.rules';
import { parseAnchorTicker } from './anchor.rules';
import {
  asofNeedsAcknowledgement,
  classifyAsof,
  type AnchorSubmissionAsofFlag,
} from './anchor-submission.rules';
import { dateOnlyOf } from './date-only';
import {
  ImportAnchorFromModelUseCase,
  type AnchorImportAction,
} from './import-anchor-from-model.usecase';

/**
 * 072 采纳一条待审估值。
 *
 * 🚨🚨 **本 use case MUST 委托 {@link ImportAnchorFromModelUseCase}, MUST NOT 自己碰
 * `prisma.anchor.*`。** 059 FR-012「系统 MUST NOT 存在第二条写锚路径」当初由**拓扑**保证
 * (待审表到锚表根本没有代码路径); 本片建了这条边之后, 那个保证换成了这条委托纪律 ——
 * 而纪律由 `scripts/checks/check-server-moat.ts` 的 `WRITE_ALLOWLIST` (Check 3) 机器强制:
 * 本文件不在锚表写者名单里, 写一句 `prisma.anchor.update` 探针当场红。判据见 ADR-0069。
 *
 * 本文件对 `prisma` 的**唯一**用途是读自己的 `anchor_submission` 行、以及把状态翻掉。
 */

export type AnchorSubmissionFlipFailure = 'CONCURRENT_DISPOSITION';

export interface ApproveAnchorSubmissionInput {
  id: bigint;
  /** 审核后的值; 省略即沿用提交方原值。**`ticker` 不在其中 —— 蓄意不可编辑。** */
  v?: string;
  asof?: string;
  method?: string;
  confidence?: string;
  reviewNote?: string;
  /** 可疑 asof 的显式确认: `shift` = 用建议日, `accept` = 原样发。 */
  asofAck?: 'shift' | 'accept';
}

export interface ApproveAnchorSubmissionResult {
  action: AnchorImportAction;
  anchorId: string;
  ticker: string;
  /** 真正落库的口径日 —— 与提交行不同即说明被改过 (审核方改的或 shift 改的)。 */
  appliedAsof: string;
  asofFlag: AnchorSubmissionAsofFlag;
  fallbackEntries: readonly AnchorFallbackReportEntry[];
  /** 收件箱状态是否成功翻成 CONSUMED。**false 不是失败**, 见下方文件注释。 */
  statusFlipped: boolean;
  flipFailure: AnchorSubmissionFlipFailure | null;
  /** `action === 'create'` ⇒ 会排一个冷启动 job (分钟级, worker concurrency=1)。 */
  coldStartExpected: boolean;
}

@Injectable()
export class ApproveAnchorSubmissionUseCase {
  private readonly logger = new Logger(ApproveAnchorSubmissionUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly importAnchor: ImportAnchorFromModelUseCase,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 —— asof fail-closed 闸
    // 的三态判定与改期建议日。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  async execute(
    input: ApproveAnchorSubmissionInput,
    now: Date = new Date(),
  ): Promise<ApproveAnchorSubmissionResult> {
    const row = await this.prisma.anchorSubmission.findUnique({ where: { id: input.id } });
    if (row === null) throw new NotFoundException('SUBMISSION_NOT_FOUND');
    // 409 而不是 404 ——「已处理过, 多半是你在另一台设备上批的」与「它消失了」是两件事,
    // 客户端要能分开呈现。
    if (row.status !== ('PENDING' satisfies AnchorSubmissionStatus)) {
      throw new ConflictException('SUBMISSION_NOT_PENDING');
    }

    const ticker = row.ticker;
    const market = parseAnchorTicker(ticker)?.market;
    if (market === undefined) throw new ConflictException('SUBMISSION_TICKER_UNPARSEABLE');

    // 🚨 闸判的是**最终 asof**, 不是存储的那个。反过来就让编辑框成了闸的绕过口:
    //    审核方把坏日期改好 ⇒ 不该再要 ack; 把好日期改成周末 ⇒ 闸必须响。
    const requestedAsof = input.asof ?? dateOnlyOf(row.asof);
    const gate = await this.gateAsof(market, requestedAsof, input.asofAck, now);

    const result = await this.importAnchor.execute({
      ticker, // ← 永不可编辑: 改它 =「给另一只票建锚, 顺手把这条提交标成已采纳」, 归属链撒谎
      v: input.v ?? row.v,
      asof: new Date(`${gate.appliedAsof}T00:00:00Z`),
      method: input.method ?? row.method,
      confidence: input.confidence ?? row.confidence,
    });

    // 🚨 **严格后置于导入成功**。反过来会在导入失败时把条目从待审箱里弄丢
    //    (逐字继承 anchor-approve.sh 的同一条纪律)。
    // 🚨 **MUST NOT 把两者包进同一个 $transaction**: CreateAnchorUseCase 在自己的 tx 内发
    //    outbox 事件、且 seedLastClose 有同步 vendor 调用 —— 把 vendor 往返拖进更长事务是
    //    playbook 明禁的; 而回滚锚写入还得「取消发布」冷启动事件, 那恰是 outbox 做不到的事。
    const flip = await this.prisma.anchorSubmission.updateMany({
      where: { id: input.id, status: 'PENDING' }, // 条件更新 = READ COMMITTED 下的并发闸
      data: {
        status: 'CONSUMED',
        consumedAnchorId: result.anchor.id,
        ...(input.reviewNote === undefined ? {} : { reviewNote: input.reviewNote }),
      },
    });

    const statusFlipped = flip.count === 1;
    if (!statusFlipped) {
      // 锚**已经写了**, 只是收件箱没翻。回 5xx 会让客户端重试并写第二遍, 所以照实回 200 +
      // statusFlipped:false, 由呈现层醒目提示人工核对。consumed_anchor_id 让这种半截态可查。
      this.logger.error(
        `[approve-submission] 导入成功但状态未翻转 (id=${input.id}, anchorId=${result.anchor.id}) —— 并发处置抢跑, 需人工核对`,
      );
    }

    return {
      action: result.action,
      anchorId: result.anchor.id.toString(),
      ticker,
      appliedAsof: gate.appliedAsof,
      asofFlag: gate.flag,
      fallbackEntries: result.fallbackEntries,
      statusFlipped,
      flipFailure: statusFlipped ? null : 'CONCURRENT_DISPOSITION',
      coldStartExpected: result.action === 'create',
    };
  }

  /**
   * asof fail-closed 闸。
   *
   * 这道闸不是设计出来的, 是 059 那轮实测逼出来的: 只给能力目录时 `asof` **13/13 全错**,
   * 且**收敛地错** (每次错成同一个值, 重复采样发现不了)。搬到线上不能把它丢掉。
   *
   * **409 而不是 400**: 仓里 class-validator 失败统一折成 `400 FORM_VALIDATION`; 用 400 会让
   * 这道闸掉进客户端「你数字填错了」那个桶, 三出口对话框永远渲染不出来。语义上 409 也更对 ——
   * 请求本身合法, 冲突的是这条待审记录当前那个可疑的口径日。
   */
  private async gateAsof(
    market: string,
    requestedAsof: string,
    ack: 'shift' | 'accept' | undefined,
    now: Date,
  ): Promise<{ appliedAsof: string; flag: AnchorSubmissionAsofFlag }> {
    const flag = classifyAsof({
      asof: requestedAsof,
      exchangeToday: exchangeCalendarDate(market, now),
      calendarStatus: await this.calendar.classify(market, requestedAsof),
    });

    if (!asofNeedsAcknowledgement(flag)) return { appliedAsof: requestedAsof, flag };

    if (ack === undefined) {
      const suggested = await this.calendar.previousTradingDay(market, requestedAsof);
      throw new ConflictException({
        code: 'ASOF_SUSPECT',
        asofFlag: flag,
        // ⚠️ 072 T019 实测：这两个扩展字段**到不了客户端** —— `ProblemDetailFilter` 只透传
        // code / freezeUntil / retryAfterSeconds / invalidAttributes 四个白名单字段
        // (045 EC-7 在 anchor-form.rules.ts 已踩过同一处)。客户端的「改送前一交易日」出口
        // 因此取详情响应里的 asofSuggested; 审核方改过口径日时它没有新的建议日, 按「解不出」
        // 渲染 —— 与这里的「不猜」同一个态度。留着这两个字段是给日志与将来放宽白名单用。
        asofSuggested: suggested,
      });
    }

    if (ack === 'accept') return { appliedAsof: requestedAsof, flag };

    const suggested = await this.calendar.previousTradingDay(market, requestedAsof);
    // 🚨 **不猜**。逐字继承 shell 的硬停: 日历解不出前一交易日就停下, 不拿「最接近的日期」凑。
    if (suggested === null) throw new ConflictException({ code: 'ASOF_SHIFT_UNRESOLVABLE' });
    return { appliedAsof: suggested, flag };
  }
}
