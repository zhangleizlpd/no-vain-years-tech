import { Inject, Injectable } from '@nestjs/common';
import { AnchorDrivenSyncGate, ANCHOR_GATED_MARKETS } from '../marketdata/anchor-driven-sync-gate';
import { EnsureInstrumentUseCase } from '../marketdata/ensure-instrument.usecase';
import { GetInstrumentBarsUseCase } from '../marketdata/get-instrument-bars.usecase';
import { RegisterSymbolChangeUseCase } from '../marketdata/register-symbol-change.usecase';
import { RevokeSymbolChangeUseCase } from '../marketdata/revoke-symbol-change.usecase';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { PrismaService } from '../security/prisma.service';
import type { AnchorSubmissionStatus } from './anchor-import.rules';
import { shanghaiDateOnly } from './create-anchor.usecase';
import { MigrateAnchorTickerUseCase } from './migrate-anchor-ticker.usecase';
import { RejectAnchorSubmissionsUseCase } from './reject-anchor-submissions.usecase';
import type {
  RemediationContext,
  RemediationStep,
  StepApplyOutcome,
  StepInspection,
} from './remediate-symbol-change.usecase';
import { isAnchorOverdue } from './review-anchor.usecase';

/**
 * 086 修正命令的五个真步骤 (T011, FR-011 / FR-014; plan D5)。顺序由 `optionsdesk.module.ts` 的
 * `REMEDIATION_STEPS` 工厂钉死: 登记 → 迁锚 → 驳回待审提交 → 采集范围 → 验证。
 *
 * 纪律 (编排骨架约定): `inspect` 零写入、从库里读「已完成」的事实 (不靠内存); 跨 ctx 的写
 * 一律经 marketdata use case, 本 ctx 只对 `marketdata.instrument` 做带 `CROSS-CONTEXT-READ` 的只读直查。
 */

const PENDING: AnchorSubmissionStatus = 'PENDING';

/** 第 1 步: 代码变更登记。同参数未撤销登记已在 ⇒ 跳过; 同键不同新码 ⇒ 冲突停。 */
@Injectable()
export class RegisterSymbolChangeStep implements RemediationStep {
  readonly name = 'register';

  constructor(
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 登记代码变更 (登记表归 marketdata, 本 ctx 不直写)。
    private readonly register: RegisterSymbolChangeUseCase,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 撤销登记 (撤销编排, T012)。
    private readonly revoke: RevokeSymbolChangeUseCase,
  ) {}

  /** 同 (market, old, effective) 的未撤销登记 (至多一条, 部分唯一索引保证)。 */
  private async activeRegistration(ctx: RemediationContext) {
    return (await this.register.list(ctx.market)).find(
      (r) =>
        r.revokedAt === null && r.oldCode === ctx.oldCode && r.effectiveDate === ctx.effectiveDate,
    );
  }

  /** 撤销: 未撤销登记已不在 ⇒ 跳过; 同键登记指向别的新码 ⇒ 冲突停 (不撤别人的登记)。 */
  readonly revert: RemediationStep = {
    name: 'revoke-registration',
    inspect: async (ctx) => {
      const active = await this.activeRegistration(ctx);
      if (active === undefined) return { state: 'done', detail: '无未撤销登记 (或已撤销)' };
      if (active.newCode !== ctx.newCode) {
        return {
          state: 'conflict',
          detail: `同键未撤销登记指向 ${active.newCode} (id=${active.id}), 不是本次要撤的`,
        };
      }
      return { state: 'pending', detail: `将撤销登记 id=${active.id}` };
    },
    apply: async (ctx) => {
      const r = await this.revoke.execute(
        {
          market: ctx.market,
          oldCode: ctx.oldCode,
          effectiveDate: ctx.effectiveDate,
          revokedBy: ctx.operator,
          reason: ctx.evidence,
        },
        ctx.now,
      );
      return { status: 'ok', detail: r.status };
    },
  };

  async inspect(ctx: RemediationContext): Promise<StepInspection> {
    const active = await this.activeRegistration(ctx);
    if (active === undefined) {
      return {
        state: 'pending',
        detail: `将登记 ${ctx.oldTicker} → ${ctx.newCode} @ ${ctx.effectiveDate}`,
      };
    }
    if (active.newCode !== ctx.newCode) {
      return {
        state: 'conflict',
        detail: `同键已有未撤销登记指向 ${active.newCode} (id=${active.id})`,
      };
    }
    return { state: 'done', detail: `登记已在 (id=${active.id})` };
  }

  async apply(ctx: RemediationContext): Promise<StepApplyOutcome> {
    const r = await this.register.execute(
      {
        market: ctx.market,
        oldCode: ctx.oldCode,
        newCode: ctx.newCode,
        effectiveDate: ctx.effectiveDate,
        // `SYMBOL_CHANGE_SOURCE.MANUAL` 的字面量 —— rules 文件不对 optionsdesk 开放 (eslint boundaries);
        // 登记 use case 不校验该值, 由 remediate IT ① 断言落库值钉住。
        source: 'manual',
        evidence: ctx.evidence,
        registeredBy: ctx.operator,
      },
      ctx.now,
    );
    if (r.status === 'rejected') return { status: 'failed', detail: `${r.reason}: ${r.message}` };
    return { status: 'ok', detail: `${r.status} (id=${r.id})` };
  }
}

/** 第 2 步: 迁锚 (T009)。旧码无锚 ⇒ 跳过; 新码已有锚 ⇒ 冲突停 (branch 17)。 */
@Injectable()
export class MigrateAnchorStep implements RemediationStep {
  readonly name = 'migrate-anchor';

  constructor(
    private readonly prisma: PrismaService,
    private readonly migrate: MigrateAnchorTickerUseCase,
  ) {}

  /** 撤销: 新码锚回旧码并恢复原 `next_review` (T009 `revert`)。新码无锚 ⇒ 跳过。 */
  readonly revert: RemediationStep = {
    name: 'revert-migrate-anchor',
    inspect: async (ctx) => {
      const current = await this.prisma.anchor.findUnique({
        where: { ticker: ctx.newTicker },
        select: { id: true },
      });
      if (current === null) return { state: 'done', detail: '新码无锚 (或已撤销)' };
      const occupant = await this.prisma.anchor.findUnique({
        where: { ticker: ctx.oldTicker },
        select: { id: true },
      });
      if (occupant !== null) {
        return { state: 'conflict', detail: `旧码已有锚 (id=${occupant.id})` };
      }
      return { state: 'pending', detail: `锚 ${ctx.newTicker} → ${ctx.oldTicker}, 恢复原复核日` };
    },
    apply: async (ctx) => {
      const r = await this.migrate.revert({ oldTicker: ctx.oldTicker, newTicker: ctx.newTicker });
      switch (r.kind) {
        case 'reverted':
          return { status: 'ok', detail: `锚 id=${r.anchorId} 已回到 ${ctx.oldTicker}` };
        case 'conflict':
          return { status: 'conflict', detail: `旧码已有锚 (id=${r.existingAnchorId})` };
        case 'not_migrated':
          return {
            status: 'conflict',
            detail: `新码锚 id=${r.anchorId} 不是从 ${ctx.oldTicker} 迁来的, 不动`,
          };
        case 'no_anchor':
          return { status: 'failed', detail: '新码锚在执行前消失 (并发改动), 重跑即可' };
      }
    },
  };

  async inspect(ctx: RemediationContext): Promise<StepInspection> {
    const old = await this.prisma.anchor.findUnique({
      where: { ticker: ctx.oldTicker },
      select: { id: true },
    });
    if (old === null) return { state: 'done', detail: '旧码无锚 (或已迁过)' };
    const occupant = await this.prisma.anchor.findUnique({
      where: { ticker: ctx.newTicker },
      select: { id: true },
    });
    if (occupant !== null) {
      return { state: 'conflict', detail: `新码已有锚 (id=${occupant.id})` };
    }
    return {
      state: 'pending',
      detail: `锚 ${ctx.oldTicker} → ${ctx.newTicker}, 进入复核逾期, 清空旧价`,
    };
  }

  async apply(ctx: RemediationContext): Promise<StepApplyOutcome> {
    const r = await this.migrate.execute({
      oldTicker: ctx.oldTicker,
      newTicker: ctx.newTicker,
      now: ctx.now,
    });
    switch (r.kind) {
      case 'migrated':
        return { status: 'ok', detail: `锚 id=${r.anchorId} 已迁到 ${ctx.newTicker}` };
      case 'conflict':
        return { status: 'conflict', detail: `新码已有锚 (id=${r.existingAnchorId})` };
      case 'no_anchor':
        // inspect 与 apply 之间旧码锚被并发挪走 —— 如实报, 不当成功。
        return { status: 'failed', detail: '旧码锚在执行前消失 (并发改动), 重跑即可' };
    }
  }
}

/** 第 3 步: 驳回旧码的 PENDING 提交, 理由含新码。无 PENDING ⇒ 跳过。 */
@Injectable()
export class RejectOldCodeSubmissionsStep implements RemediationStep {
  readonly name = 'reject-submissions';

  constructor(
    private readonly prisma: PrismaService,
    private readonly reject: RejectAnchorSubmissionsUseCase,
  ) {}

  /** 撤销: 驳回的提交**不复原** (驳回零副作用, 要重来让提交方再交一次) —— 只进报告。 */
  readonly revert: RemediationStep = {
    name: 'restore-submissions',
    inspect: async () => ({ state: 'done', detail: '驳回的待审提交不复原 (驳回零副作用)' }),
    apply: async () => ({ status: 'ok', detail: '驳回的待审提交不复原' }),
  };

  private pendingIds(ctx: RemediationContext): Promise<{ id: bigint }[]> {
    return this.prisma.anchorSubmission.findMany({
      where: { ticker: ctx.oldTicker, status: PENDING },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }

  async inspect(ctx: RemediationContext): Promise<StepInspection> {
    const rows = await this.pendingIds(ctx);
    if (rows.length === 0) return { state: 'done', detail: '旧码无待审提交' };
    return { state: 'pending', detail: `将驳回旧码待审提交 ${rows.length} 条` };
  }

  async apply(ctx: RemediationContext): Promise<StepApplyOutcome> {
    const ids = (await this.pendingIds(ctx)).map((r) => r.id);
    const r = await this.reject.execute({
      ids,
      reviewNote: `代码已改为 ${ctx.newTicker} (生效日 ${ctx.effectiveDate})`,
    });
    const skipped = r.skipped.length > 0 ? `, 并发已被处置 ${r.skipped.length} 条` : '';
    return { status: 'ok', detail: `已驳回 ${r.rejected} 条${skipped}` };
  }
}

/** us 由锚驱动采集闸; hk / cn 全量采集 (`anchor-driven-sync-gate.ts` 的 `ANCHOR_GATED_MARKETS`)。 */
const isGated = (market: string): boolean => ANCHOR_GATED_MARKETS.includes(market);

/**
 * hk / cn 的处置结论 (tasks T013): 不写 `needSync`、不写 `sync_blacklist`, 只在报告里写明。
 * EVIDENCE: 2026-10-16 主 agent 在 prod 实测 (tasks T013) —— 理杏仁 hk / cn 批量接口
 * (`/company/fundamental/non_financial`、`/company/fs/non_financial`) 混入不存在代码 ⇒ HTTP 200、
 * 正常代码照常返回、未知代码静默略过; 近 10 天含 21 只消失码的批次 failed=0。
 */
const UNGATED_NOTE =
  '该市场采集范围不随锚变化; 旧码留在批次里不影响同批采集 (2026-10-16 prod POC, tasks T013)';

const KEEP_INSTRUMENT_NOTE = '补齐的新码标的行不删';

/**
 * 第 4 步: 采集范围。先**同步**补齐新码标的行 (不靠冷启动事件, Guardrail 5 / branch 16),
 * us 再立即重算采集闸; hk / cn 只报告 (见 {@link UNGATED_NOTE})。
 * 「已完成」= 新码标的行在, 且 (us) 新旧两码的 `needSync` 与「有没有锚」一致。
 */
@Injectable()
export class CollectionScopeStep implements RemediationStep {
  readonly name = 'collection-scope';

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 同步补齐新码标的行 (标的表归 marketdata)。
    private readonly ensureInstrument: EnsureInstrumentUseCase,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 立即按锚表重算 us 采集闸 (`needSync` 受保护列,
    // 唯一合法写入方在 marketdata; 本 ctx 不新增写入方)。
    private readonly syncGate: AnchorDrivenSyncGate,
  ) {}

  /**
   * 撤销: us 按锚表重算采集闸 (锚已回旧码 ⇒ 旧码开、新码关); 补齐的新码标的行**不删**
   * (标的行是全市场清单的一部分, universe 同步本来也会建它)。hk / cn 无事可做。
   */
  readonly revert: RemediationStep = {
    name: 'recalc-sync-gate',
    inspect: async (ctx) => {
      if (!isGated(ctx.market)) {
        return { state: 'done', detail: `${UNGATED_NOTE}; ${KEEP_INSTRUMENT_NOTE}` };
      }
      // 新码仍有锚 = 锚还没回旧码 (预览时前一步尚未执行) ⇒ 闸此刻「一致」不代表撤销已完成。
      const stillOnNew = await this.prisma.anchor.findUnique({
        where: { ticker: ctx.newTicker },
        select: { id: true },
      });
      if (stillOnNew === null && (await this.gateConsistent(ctx))) {
        return { state: 'done', detail: `采集闸已与锚一致; ${KEEP_INSTRUMENT_NOTE}` };
      }
      return { state: 'pending', detail: `将重算 us 采集闸; ${KEEP_INSTRUMENT_NOTE}` };
    },
    apply: async () => {
      const gate = await this.syncGate.recalcSafely();
      if (gate === null) return { status: 'failed', detail: '采集闸重算降级 (见 warn 日志)' };
      return {
        status: 'ok',
        detail: `采集闸重算 opened=${gate.opened} closed=${gate.closed}; ${KEEP_INSTRUMENT_NOTE}`,
      };
    },
  };

  /** us: 新旧两码中**存在的**标的行, `needSync` 是否都等于「该 ticker 有锚」。 */
  private async gateConsistent(ctx: RemediationContext): Promise<boolean> {
    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 判采集闸是否已重算。
    const rows = await this.prisma.instrument.findMany({
      where: { market: ctx.market, code: { in: [ctx.oldCode, ctx.newCode] } },
      select: { code: true, needSync: true },
    });
    const anchored = new Set(
      (
        await this.prisma.anchor.findMany({
          where: { ticker: { in: [ctx.oldTicker, ctx.newTicker] } },
          select: { ticker: true },
        })
      ).map((a) => a.ticker),
    );
    return rows.every((r) => r.needSync === anchored.has(`${ctx.market}:${r.code}`));
  }

  private async newInstrumentExists(ctx: RemediationContext): Promise<boolean> {
    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 新码标的行在不在。
    const row = await this.prisma.instrument.findUnique({
      where: { market_code: { market: ctx.market, code: ctx.newCode } },
      select: { id: true },
    });
    return row !== null;
  }

  async inspect(ctx: RemediationContext): Promise<StepInspection> {
    const exists = await this.newInstrumentExists(ctx);
    const gated = isGated(ctx.market);
    if (exists && (!gated || (await this.gateConsistent(ctx)))) {
      return {
        state: 'done',
        detail: gated ? '新码标的行已在, 采集闸已与锚一致' : `新码标的行已在; ${UNGATED_NOTE}`,
      };
    }
    const parts = [exists ? '新码标的行已在' : `将补齐标的行 ${ctx.newTicker}`];
    parts.push(gated ? '重算 us 采集闸' : UNGATED_NOTE);
    return { state: 'pending', detail: parts.join('; ') };
  }

  async apply(ctx: RemediationContext): Promise<StepApplyOutcome> {
    const ensured = await this.ensureInstrument.execute(ctx.market, ctx.newCode);
    const instrument = `标的行 ${ctx.newTicker} ${ensured.status}`;
    if (!isGated(ctx.market)) return { status: 'ok', detail: `${instrument}; ${UNGATED_NOTE}` };
    const gate = await this.syncGate.recalcSafely();
    // recalcSafely 降级返 null (读失败一行不动) ⇒ 本步未完成, 停下让人重跑。
    if (gate === null)
      return { status: 'failed', detail: `${instrument}; 采集闸重算降级 (见 warn 日志)` };
    return {
      status: 'ok',
      detail: `${instrument}; 采集闸重算 opened=${gate.opened} closed=${gate.closed}`,
    };
  }
}

/**
 * 第 5 步: 验证 (只读)。不判「已完成」—— 每次 apply 都重验一遍; 预览只报将验证什么。
 * 硬失败: 旧码仍有锚 / 新码标的行不在 / (us 且新码有锚) `needSync` 不为真。
 * 其余是报告项: 复核逾期与否、新码日线首末日期与缺口数 (按交易日历), 收盘价「待下一拍」。
 */
@Injectable()
export class VerifyRemediationStep implements RemediationStep {
  readonly name = 'verify';

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 读新码的拼接日线 (086 lineage 读时拼接只在该 use case)。
    private readonly bars: GetInstrumentBarsUseCase,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口, 只数首末日期间的交易日。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  async inspect(ctx: RemediationContext): Promise<StepInspection> {
    return {
      state: 'pending',
      detail: `将验证: 旧码无锚、${ctx.newTicker} 锚 / 标的行 / 采集闸、日线首末与缺口数`,
    };
  }

  async apply(ctx: RemediationContext): Promise<StepApplyOutcome> {
    const problems: string[] = [];
    const notes: string[] = [];

    const [oldAnchor, newAnchor] = await Promise.all([
      this.prisma.anchor.findUnique({ where: { ticker: ctx.oldTicker }, select: { id: true } }),
      this.prisma.anchor.findUnique({
        where: { ticker: ctx.newTicker },
        select: { nextReview: true },
      }),
    ]);
    if (oldAnchor !== null) problems.push('旧码仍在锚表');
    if (newAnchor === null) {
      notes.push('新码无锚');
    } else {
      const overdue = isAnchorOverdue(newAnchor.nextReview, shanghaiDateOnly(ctx.now));
      notes.push(`新码锚复核逾期=${overdue ? '是' : '否'}`);
    }

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 新码标的行与采集闸。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: ctx.market, code: ctx.newCode } },
      select: { needSync: true },
    });
    if (instrument === null) {
      problems.push('新码标的行不存在');
    } else if (isGated(ctx.market) && newAnchor !== null && !instrument.needSync) {
      problems.push('新码 need_sync 不为真');
    }

    if (instrument !== null) notes.push(await this.barsSummary(ctx));
    notes.push('收盘价待下一拍');

    const detail = [...problems, ...notes].join('; ');
    return problems.length > 0 ? { status: 'failed', detail } : { status: 'ok', detail };
  }

  /** 新码 lineage 日线首末日期 + 缺口数 = (首, 末] 交易日数 + 1 − 实有根数。日历不可判定 ⇒ 如实报。 */
  private async barsSummary(ctx: RemediationContext): Promise<string> {
    const series = await this.bars.execute({
      symbol: ctx.newTicker,
      adjust: 'none',
      period: 'day',
    });
    const head = series.items[0];
    const tail = series.items[series.items.length - 1];
    if (head === undefined || tail === undefined) return '新码日线为空 (历史待冷启动补齐)';
    const first = head.tradeDate;
    const last = tail.tradeDate;
    const between = await this.calendar.countTradingDays(ctx.market, first, last);
    const gaps =
      between === null ? '不可判定 (日历缺行)' : String(between + 1 - series.items.length);
    return `日线 ${first} ~ ${last} 共 ${series.items.length} 根, 缺口 ${gaps}`;
  }
}

/**
 * 撤销编排的步骤顺序 (FR-015 / T012; plan D5「撤销」): 迁锚回旧码 → 撤销登记 → 重算采集闸,
 * 末尾一行报告「驳回的提交不复原」。**不是**正向数组的倒序 —— 采集闸按锚表重算, 必须排在锚回旧码之后。
 * 第 5 步验证无逆操作。生产装配 (`optionsdesk.module.ts`) 与 IT 共用本函数, 顺序只有这一处。
 */
export function revertStepsOf(steps: {
  register: RegisterSymbolChangeStep;
  migrate: MigrateAnchorStep;
  reject: RejectOldCodeSubmissionsStep;
  scope: CollectionScopeStep;
}): RemediationStep[] {
  return [steps.migrate.revert, steps.register.revert, steps.scope.revert, steps.reject.revert];
}
