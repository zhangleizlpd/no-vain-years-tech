import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import type { Prisma } from '../generated/prisma/client';
import {
  toInvalidAttributes,
  validateAlertDraft,
  type AlertConditionInput,
  type AlertValidationError,
} from './alert-validation.rules';

/** alert 行 + 内联 conditions (贫血 Prisma payload, 读写 UC 共用返回形)。 */
export type AlertWithConditions = Prisma.AlertGetPayload<{ include: { conditions: true } }>;

export interface CreateAlertsBatchInput {
  instruments: readonly { market: string; code: string }[];
  conditions: readonly AlertConditionInput[];
  frequency: string;
  note?: string | null;
}

/**
 * 021 US1 — 批量创建预警 (EP3, intra 写, ADR-0043 直注 PrismaService)。
 *
 * 批量语义 (clarify #1 / plan D5)：同一套 conditions/frequency/note 应用到 N 只标的，
 * **每只各建一条独立预警** (建后各自独立编辑/启停)。单 `$transaction` 全建或全拒——
 * 任一标的 market 非法 / 任一草稿校验失败 → 整体 400，不部分成功。
 *
 * 校验：T002 rules 逐标的复验 (错误按 code 去重并列) → 400 FORM_VALIDATION。
 * 同 (类型,参数) 限 1 的 DB 双保险 = `@@unique(alert_id, type, param)` (校验已拦, 撞到即 bug 直抛)。
 */
@Injectable()
export class CreateAlertsBatchUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, input: CreateAlertsBatchInput): Promise<AlertWithConditions[]> {
    const errors: AlertValidationError[] = [];
    if (input.instruments.length === 0) {
      throw new FormValidationException([
        { field: 'instruments', messages: ['至少选择 1 只标的'] },
      ]);
    }
    for (const ins of input.instruments) {
      for (const e of validateAlertDraft({
        market: ins.market,
        conditions: input.conditions,
        frequency: input.frequency,
        note: input.note,
      })) {
        if (!errors.some((x) => x.code === e.code)) errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new FormValidationException(toInvalidAttributes(errors));
    }

    return this.prisma.$transaction(async (tx) => {
      const created: AlertWithConditions[] = [];
      for (const ins of input.instruments) {
        created.push(
          await tx.alert.create({
            data: {
              accountId,
              market: ins.market,
              code: ins.code,
              frequency: input.frequency,
              note: input.note ?? null,
              conditions: {
                create: input.conditions.map((c) => ({
                  type: c.type,
                  param: c.param ?? 0, // 无参 sentinel (plan D3)
                  threshold: c.threshold ?? null,
                })),
              },
            },
            include: { conditions: true },
          }),
        );
      }
      return created;
    });
  }
}
