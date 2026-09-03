import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { assertImportableAnchorFacts } from './import-anchor-from-model.usecase';
import { assertUsableV, type AnchorDecimalInput } from './create-anchor.usecase';

/**
 * 059 —— 其他访客的估值提交 (FR-011)。**只写待审收件箱, 锚表零变化**。
 *
 * 🚨 本文件**绝不 import 锚的写侧 use case、绝不碰 `prisma.anchor`** —— FR-012
 * 「系统 MUST NOT 存在第二条写锚路径」在**本文件这一侧**的保证一字未变。
 * ⚠️ 但采纳动作自 072 起搬进了系统内 (`approve-anchor-submission.usecase.ts`, admin-only),
 * 不再是「本人在 DB 直连里看到后手工重放」。那条路径同样只经 `ImportAnchorFromModelUseCase`,
 * 且由 `check-server-moat.ts` 的 WRITE_ALLOWLIST 机器强制 (ADR-0069)。
 *
 * 与导入口**共用同一套输入判据** (`anchor-import.rules.ts`): 收件时不校验 = 把 400 推迟到
 * 采纳那一刻, 而那时人已经在等着它成为一只锚了。
 *
 * 范式 = ADR-0043 扁平 + 贫血: 直注 `PrismaService`, 无 repository。
 *
 * 🚨 **072 起本口幂等** (`(ticker, asof)` 上有 partial unique `WHERE status='PENDING'`):
 * 同一 (标的, 口径日) 重投 ⇒ 覆盖那条待审行并回**同一个 id**, 不再堆行。
 * 判据是实测: prod 里每一组重复都是逐值全等的误投 (详见 ADR-0069)。
 *
 * 🚨 **MUST NOT 用 `prisma.upsert`** —— 已实测会在运行时炸:
 * Prisma 把 partial unique 建模成**全表**复合唯一 (`ticker_asof`), 谓词在类型系统里消失 ⇒
 * 生成的 `INSERT ... ON CONFLICT (ticker, asof)` 撞上 PG 对部分索引的要求
 * (ON CONFLICT 必须带同样的谓词), 报 `no unique or exclusion constraint matching the
 * ON CONFLICT specification`。**类型全绿、运行时失败**, 单测的 mock Prisma 抓不到。
 * ⇒ 写成显式两段, 且**自己写出 `status: 'PENDING'` 条件**(类型系统不会替你带上)。
 * 结构性旁证: 谓词只活在 `schema.prisma` 的 `where: raw("((status)::text = 'PENDING'::text)")`
 * 与 migration `20260831_1741` 的 `CREATE UNIQUE INDEX ... WHERE status = 'PENDING'` 里,
 * 生成的 client 侧只剩一个无谓词的 `ticker_asof` 复合唯一。
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

    // 快路径: 该 (标的, 口径日) 已有一条待审 ⇒ 覆盖它。
    // 🚨 `status: 'PENDING'` 必须显式写出 —— partial 谓词不在 Prisma 的类型里, 漏了它会连
    //    CONSUMED / REJECTED 的历史行一起命中, 把早已处置完的记录改掉。
    const pending = await this.prisma.anchorSubmission.findFirst({
      where: { ticker: input.ticker, asof: input.asof, status: 'PENDING' },
      select: { id: true },
    });
    if (pending !== null) {
      return (await this.prisma.anchorSubmission.update({
        where: { id: pending.id },
        data: {
          submitter: input.submitter,
          v: input.v,
          method: input.method,
          confidence: input.confidence,
          note: input.note,
          // createdAt 不动 ——「这条待审最早什么时候来的」是归属信息, 重投不该抹掉它。
        },
      })) as AnchorSubmissionRow;
    }

    try {
      return (await this.prisma.anchorSubmission.create({
        data: {
          submitter: input.submitter,
          ticker: input.ticker,
          v: input.v,
          asof: input.asof,
          method: input.method,
          confidence: input.confidence,
          note: input.note,
          // 系统只写 PENDING —— 另两态由审批面写 (072 起), 本口永不写。
          status: 'PENDING',
        },
      })) as AnchorSubmissionRow;
    } catch (err) {
      // P2002 = 上面的 findFirst 与本次 create 之间另一路插进了同一 (ticker, asof)。
      // partial unique 才是真正的守门人, findFirst 只是快路径 ⇒ 这里重走一次覆盖分支。
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.prisma.anchorSubmission.findFirstOrThrow({
        where: { ticker: input.ticker, asof: input.asof, status: 'PENDING' },
        select: { id: true },
      });
      return (await this.prisma.anchorSubmission.update({
        where: { id: raced.id },
        data: {
          submitter: input.submitter,
          v: input.v,
          method: input.method,
          confidence: input.confidence,
          note: input.note,
        },
      })) as AnchorSubmissionRow;
    }
  }
}

/** P2002 = 唯一约束冲突 (这里只可能是那条 partial unique)。 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
