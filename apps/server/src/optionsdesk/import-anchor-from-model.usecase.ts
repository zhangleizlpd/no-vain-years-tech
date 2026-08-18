import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { type LLevel } from './anchor.rules';
import {
  buildImportFallbackReport,
  buildModelImportPatch,
  type AnchorFallbackReportEntry,
  type AnchorManualState,
} from './anchor-cascade';
import {
  ANCHOR_IMPORT_INVALID_PREFIX,
  assertImportableConfidence,
  assertImportableTicker,
} from './anchor-import.rules';
import { buildAnchorChange, toAnchorSnapshot } from './anchor-history';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  CreateAnchorUseCase,
  assertUsableV,
  toAnchorWriteResult,
  toUtcDateOnly,
  type AnchorDecimalInput,
  type AnchorRow,
  type AnchorWriteResult,
} from './create-anchor.usecase';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';

/**
 * 059 —— 按**标的**寻址的模型估值导入 (FR-001 / FR-002 / FR-006 ~ FR-009 / FR-016)。
 * 无锚则建、有锚则按模型语义刷新, 调方不必知道任何系统内部标识。
 *
 * 🚨 **为什么不复用 `UpdateAnchorUseCase`** (三个雷, 逐个都是真的, plan §1):
 * 1. 它按内部 `anchorId` 寻址, 调方拿不到; 而 `POST /anchors` 对同 ticker **蓄意 409**
 *    (静默 upsert 会覆盖已录的估值结论) ⇒ 每天第二次导入全红。
 * 2. `UpdateAnchorPatch` 无 `confidenceSource` 字段 ⇒ 翻不了 `'model'`; 且它走
 *    `cascadeOnManualConfidenceChange` (路径 ③, **不冲 `vManual`**), 而模型 import 该走
 *    路径 ① (`cascadeOnModelImport`, 三处人工位一并回落)。
 * 3. 🚨 **最致命**: `update-anchor.usecase.ts` 对 `confidence_source==='model'` 的锚**拒改
 *    confidence** ⇒ 首日导入把来源写成 `'model'` 后, **次日再导入同一只锚会被自己的门控
 *    400 掉**。这条踩了当天不会红 (首日全绿), 第二天才炸。
 * ⇒ 本文件新建, `update-anchor.usecase.ts` **一行不改**, 045 的只读门控原样保留。
 *
 * 范式 = ADR-0043 扁平 + 贫血: 直注 `PrismaService` + 同 ctx 的 `CreateAnchorUseCase`,
 * 无 repository / Domain Class。业务不变式全在 `anchor-import.rules.ts` / `anchor-cascade.ts`
 * 纯函数, 本文件只做「读现状 → 判要不要写 → 写库 → 投影」。
 *
 * 并发: 单行走 conditional `updateMany` + affected-count (READ COMMITTED); count === 0 ⇒
 * 读写窗内被并发删除, 与不存在同折叠 404 且**不写孤儿痕迹**。**禁** `FOR UPDATE` /
 * Serializable (server-impl-playbook)。
 */

/** FR-016: 每次导入都要能看出是新建还是更新 —— 新建锚会让当日采集多做一整轮历史回填。 */
export type AnchorImportAction = 'create' | 'update' | 'noop';

export interface ImportAnchorFromModelInput {
  /** canonical `market:code`; 白名单 + 写法校验在 `anchor-import.rules.ts` 单点。 */
  ticker: string;
  v: AnchorDecimalInput;
  asof: Date;
  method: string;
  confidence: AnchorDecimalInput;
}

export interface ImportAnchorFromModelResult {
  action: AnchorImportAction;
  anchor: AnchorWriteResult;
  /**
   * FR-007 差异报告: 本次导入冲掉的人工调整逐条列出 (哪一项 / 原值 / 回落值)。**禁静默回落**。
   * 无人工调整时为空数组, MUST NOT 编造条目。
   *
   * 📌 **不为它建第二份存储** (plan §5): `anchor_change` 痕迹里 `changedFields` 含被清空的
   * 人工位、`beforeValues` 含其原值 ⇒ 痕迹表天然就是差异报告的持久面, 本字段只是同一信息的
   * 即时呈现。
   */
  fallbackEntries: readonly AnchorFallbackReportEntry[];
}

/** 把纯函数抛的 `INVALID_IMPORT_*` 折成 400 (体例同 `assertUsableV` 折 `INVALID_ANCHOR_V`)。 */
export function assertImportableAnchorFacts(ticker: string, confidence: AnchorDecimalInput): void {
  try {
    assertImportableTicker(ticker);
    assertImportableConfidence(confidence);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(ANCHOR_IMPORT_INVALID_PREFIX)) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

/**
 * 「这次导入什么都没改」的判据 (FR-006)。四个模型事实全等 **且**来源已是 model。
 *
 * 🚨 比的是**值**不是字符串: `'50'` 与 `'50.00'` 是同一个估值, 按字符串比会让每天的例行导入
 * 都写一遍库、并顺手冲掉三处人工位。
 *
 * 🚨 为什么把 `confidence_source` 也算进来: 手工锚的数字恰好与模型一致时, 这次导入**确实
 * 改了东西** —— 它把 provenance 翻成 model (FR-002 的 MUST)。判成 noop 会让那只锚继续显示
 * 「人工来源、可编辑」, 与实际写入路径不符。
 */
function isUnchangedByImport(row: AnchorRow, input: ImportAnchorFromModelInput): boolean {
  return (
    row.confidenceSource === 'model' &&
    row.v.equals(new Prisma.Decimal(input.v)) &&
    row.confidence.equals(new Prisma.Decimal(input.confidence)) &&
    toUtcDateOnly(row.asof).getTime() === toUtcDateOnly(input.asof).getTime() &&
    row.method === input.method
  );
}

@Injectable()
export class ImportAnchorFromModelUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly createAnchor: CreateAnchorUseCase,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 只取「最近一场已收盘交易日」当陈旧度基准 —— 062 T010 起该判据多了「覆盖声明」一维,
    // 自己直查会漂 (漂了只让档位悄悄错一档, 不报错)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  async execute(input: ImportAnchorFromModelInput): Promise<ImportAnchorFromModelResult> {
    assertImportableAnchorFacts(input.ticker, input.confidence);
    assertUsableV(input.v);

    const existing = (await this.prisma.anchor.findUnique({
      where: { ticker: input.ticker },
    })) as AnchorRow | null;

    if (existing === null) {
      // 🚨 `confidenceSource` 与 `source` 是**两个独立参数, 都要显式传** (Guardrail 3):
      // `CreateAnchorUseCase` 的 `source` 缺省是 `'manual'`, 漏传的表现是锚建出来了、痕迹却
      // 记成人工 —— 没有任何断言会红。
      const created = await this.createAnchor.execute({
        ticker: input.ticker,
        v: input.v,
        asof: input.asof,
        method: input.method,
        confidence: input.confidence,
        confidenceSource: 'model',
        source: 'model',
      });
      return { action: 'create', anchor: created, fallbackEntries: [] };
    }

    // 🚨 noop 短路**必须在算差异报告之前** (Guardrail 4): 顺序反了会先算一遍回落报告再发现
    // 不用写, 白算且日志里出现「回落了」的假信号。
    if (isUnchangedByImport(existing, input)) {
      return {
        action: 'noop',
        anchor: toAnchorWriteResult(
          existing,
          await resolveLastClosedSessionForTicker(this.calendar, existing.ticker),
        ),
        fallbackEntries: [],
      };
    }

    const manual: AnchorManualState = {
      vManual: existing.vManual,
      lLevelManual: existing.lLevelManual as LLevel | null,
      positionCapManual: existing.positionCapManual,
    };
    const fallbackEntries = buildImportFallbackReport([
      { ticker: existing.ticker, manual, next: { v: input.v, confidence: input.confidence } },
    ]);
    const patch = buildModelImportPatch({
      v: input.v,
      confidence: input.confidence,
      asof: input.asof,
      method: input.method,
    });
    // interface 无隐式 index signature (TS 已知限制) → 经 unknown 转 Record 喂 buildAnchorChange。
    const change = buildAnchorChange(
      toAnchorSnapshot(existing),
      patch as unknown as Record<string, unknown>,
      'model',
    );

    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.anchor.updateMany({ where: { id: existing.id }, data: patch });
      if (res.count === 0) {
        throw new NotFoundException('ANCHOR_NOT_FOUND');
      }
      if (change !== null) {
        await tx.anchorChange.create({
          data: {
            anchorId: existing.id,
            changedFields: [...change.changedFields],
            beforeValues: change.beforeValues,
            source: change.source,
          },
        });
      }
      return (await tx.anchor.findUniqueOrThrow({ where: { id: existing.id } })) as AnchorRow;
    });

    // 新鲜度基准在 tx 外取 (只读、与本次写无因果) —— 别把跨 ctx 读拖进写事务。
    return {
      action: 'update',
      anchor: toAnchorWriteResult(
        row,
        await resolveLastClosedSessionForTicker(this.calendar, row.ticker),
      ),
      fallbackEntries,
    };
  }
}
