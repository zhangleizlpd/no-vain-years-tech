import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { type LLevel } from './anchor.rules';
import {
  cascadeOnManualConfidenceChange,
  cascadeOnManualLLevelChange,
  cascadeOnUndoManualSlot,
  resolveEffectiveAnchorValues,
  type AnchorManualState,
} from './anchor-cascade';
import { buildAnchorChange, toAnchorSnapshot, type AnchorChangeSource } from './anchor-history';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  assertUsableV,
  toAnchorWriteResult,
  type AnchorDecimalInput,
  type AnchorRow,
  type AnchorWriteResult,
} from './create-anchor.usecase';

/**
 * 045 US1 — 改锚 (FR-001 / FR-003a / FR-006 / FR-032 / FR-033 / FR-035, plan D3 + D9)。
 *
 * 与建锚同范式 (ADR-0043 扁平 + 贫血 + 直注 PrismaService)。三条本文件独有的语义:
 *
 * 1. **`confidence` 来源门控** (FR-001): `confidence_source = model` 的锚写侧**拒改**
 *    `confidence` (界面只读的服务端对应面, 纵深防御); `manual` 手工锚可改 (EC-8) ——
 *    手工锚的 confidence 若不可改, 填错只能删锚重建, 而删锚另起锚身份会把变更痕迹劈成
 *    两段, 正好毁掉 FR-031 的 PIT 还原。
 * 2. **两级链回落** (plan D9): 语义在 `anchor-cascade.ts` 纯函数, 本文件只按它写库。App
 *    能触发的是路径 ② (人工改 L 层) 与 ③ (手工锚改 confidence); 路径 ① (模型批量 import)
 *    走 import 脚本消费同一组函数。撤销 = 人工位传 `null` ⇒ 自身立即回落 + 下游随之。
 * 3. **生效 L 层写入求值** (plan D3): 每次写入都由 `resolveEffectiveAnchorValues` 重算并
 *    落列 (幂等自愈)。MUST NOT 出现第二份生效 L 层 (FR-006 末句); 单票上限**无**生效列
 *    (请求时派生, FR-003a ①)。
 *
 * 并发: 单行状态转换走 conditional `updateMany` + affected-count (READ COMMITTED),
 * count === 0 ⇒ 读写窗内被并发删除 → 与不存在同折叠 404。**禁** `FOR UPDATE` / Serializable
 * (server-impl-playbook)。
 */
export interface UpdateAnchorPatch {
  v?: AnchorDecimalInput;
  asof?: Date;
  method?: string;
  confidence?: AnchorDecimalInput;
  excluded?: boolean;
  /** 显式 `null` = 清空; `undefined` = 保持原值。 */
  excludeReason?: string | null;
  nextReview?: Date | null;
  /** 人工位三列 (FR-032 ① 显式动作): 传值 = 置人工态, 传 `null` = 撤销并回落。 */
  vManual?: AnchorDecimalInput | null;
  lLevelManual?: LLevel | null;
  positionCapManual?: AnchorDecimalInput | null;
}

/** 人工位列的「是否真的变了」判定 (Decimal 需值比较, 不能靠引用)。 */
function decimalEquals(a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/**
 * 按 patch 解算回落后的人工位状态 (plan D9 路径 ② / ③ + 撤销)。
 * 顺序: 先按 confidence 变动沿链回落, 再落本次显式的人工位动作 —— 显式动作是用户当下的
 * 意图, 优先级高于同一请求内的链式回落。
 */
function resolveManualState(
  before: AnchorManualState,
  patch: UpdateAnchorPatch,
): AnchorManualState {
  // 路径 ③: 改 confidence 冲掉 L 层与上限 (走到此处的必是 manual 来源, model 来源已在上游拒)。
  let manual =
    patch.confidence !== undefined
      ? cascadeOnManualConfidenceChange(before).manualStateAfter
      : before;

  if (patch.vManual !== undefined) {
    manual =
      patch.vManual === null
        ? cascadeOnUndoManualSlot(manual, 'v').manualStateAfter
        : { ...manual, vManual: new Prisma.Decimal(patch.vManual) };
  }
  if (patch.lLevelManual !== undefined) {
    manual =
      patch.lLevelManual === null
        ? cascadeOnUndoManualSlot(manual, 'lLevel').manualStateAfter
        : // 路径 ②: 置人工 L 层 ⇒ 先冲下游单票上限, 再落新人工档。
          {
            ...cascadeOnManualLLevelChange(manual).manualStateAfter,
            lLevelManual: patch.lLevelManual,
          };
  }
  if (patch.positionCapManual !== undefined) {
    manual =
      patch.positionCapManual === null
        ? cascadeOnUndoManualSlot(manual, 'positionCap').manualStateAfter
        : { ...manual, positionCapManual: new Prisma.Decimal(patch.positionCapManual) };
  }
  return manual;
}

/** patch 的核心字段 → update data (未提供的字段不进 data, 不整行覆盖)。 */
function toCoreFieldData(patch: UpdateAnchorPatch): Prisma.AnchorUpdateManyMutationInput {
  const data: Prisma.AnchorUpdateManyMutationInput = {};
  if (patch.v !== undefined) data.v = patch.v;
  if (patch.asof !== undefined) data.asof = patch.asof;
  if (patch.method !== undefined) data.method = patch.method;
  if (patch.confidence !== undefined) data.confidence = patch.confidence;
  if (patch.excluded !== undefined) data.excluded = patch.excluded;
  if (patch.excludeReason !== undefined) data.excludeReason = patch.excludeReason;
  if (patch.nextReview !== undefined) data.nextReview = patch.nextReview;
  return data;
}

@Injectable()
export class UpdateAnchorUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    anchorId: bigint,
    patch: UpdateAnchorPatch,
    source: AnchorChangeSource = 'manual',
  ): Promise<AnchorWriteResult> {
    const existing = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as AnchorRow | null;
    if (existing === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }

    if (patch.confidence !== undefined && existing.confidenceSource === 'model') {
      throw new BadRequestException(
        'ANCHOR_CONFIDENCE_READONLY: confidence_source=model 的锚 confidence 只读 (模型说了算)',
      );
    }
    // EC-3: 模型 V 与 V 人工位都要 > 0 —— 生效 V = COALESCE(v_manual, v), 任一为非正都会
    // 让 W / 四区间失去意义。
    if (patch.v !== undefined) assertUsableV(patch.v);
    if (patch.vManual !== undefined && patch.vManual !== null) assertUsableV(patch.vManual);

    const manualBefore: AnchorManualState = {
      vManual: existing.vManual,
      lLevelManual: existing.lLevelManual as LLevel | null,
      positionCapManual: existing.positionCapManual,
    };
    const manual = resolveManualState(manualBefore, patch);
    const effective = resolveEffectiveAnchorValues(
      { v: patch.v ?? existing.v, confidence: patch.confidence ?? existing.confidence },
      manual,
    );

    const data: Prisma.AnchorUpdateManyMutationInput = {
      ...toCoreFieldData(patch),
      lLevelEffective: effective.lLevel,
    };
    // 人工位只在真变了时才写: 未被本次触碰的位不进 data (无噪声写入, 且这组列恰是 T008
    // 痕迹要记的 changed_fields)。
    if (!decimalEquals(manual.vManual, manualBefore.vManual)) data.vManual = manual.vManual;
    if (manual.lLevelManual !== manualBefore.lLevelManual) data.lLevelManual = manual.lLevelManual;
    if (!decimalEquals(manual.positionCapManual, manualBefore.positionCapManual)) {
      data.positionCapManual = manual.positionCapManual;
    }

    // 一次变更 = 一行痕迹 (FR-031): 与主行写同一个 tx; 值没真变则不落行。
    const change = buildAnchorChange(toAnchorSnapshot(existing), data, source);

    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.anchor.updateMany({ where: { id: anchorId }, data });
      if (res.count === 0) {
        throw new NotFoundException('ANCHOR_NOT_FOUND');
      }
      if (change !== null) {
        await tx.anchorChange.create({
          data: {
            anchorId,
            changedFields: [...change.changedFields],
            beforeValues: change.beforeValues,
            source: change.source,
          },
        });
      }
      return (await tx.anchor.findUniqueOrThrow({ where: { id: anchorId } })) as AnchorRow;
    });
    // 新鲜度基准在 tx 外取 (只读、与本次写无因果) —— 别把跨 ctx 读拖进写事务。
    return toAnchorWriteResult(
      row,
      await resolveLastClosedSessionForTicker(this.prisma, row.ticker),
    );
  }
}
