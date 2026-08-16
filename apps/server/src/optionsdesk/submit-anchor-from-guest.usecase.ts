import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { assertImportableAnchorFacts } from './import-anchor-from-model.usecase';
import { assertUsableV, type AnchorDecimalInput } from './create-anchor.usecase';

/**
 * 059 —— 其他访客的估值提交 (FR-011)。**只写待审收件箱, 锚表零变化**。
 *
 * 🚨 本文件**绝不 import 锚的写侧 use case、绝不碰 `prisma.anchor`** —— 那是 FR-012
 * 「系统 MUST NOT 存在第二条写锚路径」的实现级保证。采纳动作发生在系统外: 本人在 DB 直连里
 * 看到条目后, 用**自己的**凭证把同样的值经导入口重放一次 ⇒ 落锚的路径始终只有那一条。
 *
 * 与导入口**共用同一套输入判据** (`anchor-import.rules.ts`): 收件时不校验 = 把 400 推迟到
 * 采纳那一刻, 而那时人已经在等着它成为一只锚了。
 *
 * 范式 = ADR-0043 扁平 + 贫血: 直注 `PrismaService`, 单条 `create`, 无 repository。
 */
export interface SubmitAnchorFromGuestInput {
  /** 通道无条件覆写的 `X-Guest` 头值。**仅作归属, 绝不作授权**。 */
  submitter: string;
  ticker: string;
  v: AnchorDecimalInput;
  asof: Date;
  method: string;
  confidence: AnchorDecimalInput;
  note: string | null;
}

export interface AnchorSubmissionRow {
  id: bigint;
  submitter: string;
  ticker: string;
  status: string;
  createdAt: Date;
}

@Injectable()
export class SubmitAnchorFromGuestUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(input: SubmitAnchorFromGuestInput): Promise<AnchorSubmissionRow> {
    assertImportableAnchorFacts(input.ticker, input.confidence);
    assertUsableV(input.v);

    return (await this.prisma.anchorSubmission.create({
      data: {
        submitter: input.submitter,
        ticker: input.ticker,
        v: input.v,
        asof: input.asof,
        method: input.method,
        confidence: input.confidence,
        note: input.note,
        // 系统只写 PENDING —— 另两态是本人处置后手工置的留痕 (本片零审阅面)。
        status: 'PENDING',
      },
    })) as AnchorSubmissionRow;
  }
}
