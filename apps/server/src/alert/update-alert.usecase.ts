import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import {
  toInvalidAttributes,
  validateAlertDraft,
  type AlertConditionInput,
} from './alert-validation.rules';
import type { AlertWithConditions } from './create-alerts-batch.usecase';

export interface UpdateAlertPatch {
  /** 提供即**全量替换**条件集 (编辑页本地草稿一次提交, FR-M02)。 */
  conditions?: readonly AlertConditionInput[];
  frequency?: string;
  /** undefined = 保持原值; null = 清空备注。 */
  note?: string | null;
  enabled?: boolean;
}

/**
 * 021 US1 — 编辑预警 (EP4, intra 写)。
 *
 * 反枚举 (FR-S08)：scope `where {id, accountId}` 不命中 → 404 ALERT_NOT_FOUND
 * (他人资源与不存在不可区分)。校验：patch merge 现值后整体复验 (T002 rules) → 400。
 * 写侧 = 单 tx：conditional updateMany + affected-count 兜读写窗竞态 (并发删除 →
 * count 0 → 404, per server-impl-playbook 单行状态转换范式)；conditions 提供时
 * deleteMany + createMany 全量替换。
 */
@Injectable()
export class UpdateAlertUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    alertId: bigint,
    patch: UpdateAlertPatch,
  ): Promise<AlertWithConditions> {
    const existing = await this.prisma.alert.findFirst({
      where: { id: alertId, accountId },
      include: { conditions: true },
    });
    if (!existing) {
      throw new NotFoundException('ALERT_NOT_FOUND');
    }

    const draft = {
      market: existing.market,
      conditions:
        patch.conditions ??
        existing.conditions.map((c) => ({
          type: c.type,
          param: c.param,
          threshold: c.threshold === null ? null : c.threshold.toNumber(),
        })),
      frequency: patch.frequency ?? existing.frequency,
      note: patch.note === undefined ? existing.note : patch.note,
    };
    const errors = validateAlertDraft(draft);
    if (errors.length > 0) {
      throw new FormValidationException(toInvalidAttributes(errors));
    }

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.alert.updateMany({
        where: { id: alertId, accountId },
        data: {
          frequency: draft.frequency,
          note: draft.note,
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        },
      });
      if (res.count === 0) {
        // 读写窗内被并发删除 → 与不存在同折叠 (反枚举)。
        throw new NotFoundException('ALERT_NOT_FOUND');
      }
      if (patch.conditions !== undefined) {
        await tx.alertCondition.deleteMany({ where: { alertId } });
        await tx.alertCondition.createMany({
          data: patch.conditions.map((c) => ({
            alertId,
            type: c.type,
            param: c.param ?? 0, // 无参 sentinel (plan D3)
            threshold: c.threshold ?? null,
          })),
        });
      }
      return tx.alert.findFirstOrThrow({ where: { id: alertId }, include: { conditions: true } });
    });
  }
}
