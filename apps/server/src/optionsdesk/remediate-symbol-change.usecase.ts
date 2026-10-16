import { Inject, Injectable, Optional } from '@nestjs/common';

/** 修正命令的入参 (CLI 透传)。`market` + code 由编排拼成 canonical `market:code` ticker。 */
export interface RemediateSymbolChangeInput {
  market: string;
  oldCode: string;
  newCode: string;
  /** 交易所当地日历日 `'YYYY-MM-DD'` (与登记同轴)。 */
  effectiveDate: string;
  evidence: string;
  operator: string;
  /** 默认预览 (FR-012): 只调各步 `inspect`, 零写入。 */
  mode: RemediationMode;
  /**
   * 缺省 `remediate`。`revert` = 撤销编排 (FR-015, T012): 跑 `REMEDIATION_REVERT_STEPS`,
   * 同样受 `mode` 约束 (默认预览、apply 才写), 同样幂等 (已撤销 ⇒ skipped)。
   */
  direction?: RemediationDirection;
  /** 时钟注入点 (默认 `new Date()`), 透传给需要「今天」的步骤 (如迁锚的 `next_review`)。 */
  now?: Date;
}

export type RemediationMode = 'preview' | 'apply';

export type RemediationDirection = 'remediate' | 'revert';

/** 每步拿到的只读上下文: 入参 + 派生的 canonical ticker。 */
export interface RemediationContext {
  readonly market: string;
  readonly oldCode: string;
  readonly newCode: string;
  readonly effectiveDate: string;
  readonly evidence: string;
  readonly operator: string;
  /** `market:oldCode` */
  readonly oldTicker: string;
  /** `market:newCode` */
  readonly newTicker: string;
  readonly now: Date;
}

/**
 * `inspect` 的判定 (只读):
 * - `done`: 已完成 ⇒ apply 模式跳过 (FR-013 幂等 / 续跑);
 * - `pending`: 将要做什么 (detail 写给预览报告);
 * - `conflict`: 前置条件不满足, 编排停在这一步 (如新码已有锚, branch 17)。
 */
export type StepInspection =
  | { state: 'done'; detail: string }
  | { state: 'pending'; detail: string }
  | { state: 'conflict'; detail: string };

/** `apply` 的结局。抛错等价于 `failed` (由编排捕获, 不外溢)。 */
export interface StepApplyOutcome {
  status: 'ok' | 'conflict' | 'failed';
  detail: string;
}

/**
 * 编排中的一步。`inspect` 必须零写入 (预览只调它); `apply` 自己负责原子性 (单步内同 tx)。
 * 步骤间不共享可变状态: 后一步需要的事实由它自己的 `inspect` 从库里读。
 */
export interface RemediationStep {
  readonly name: string;
  inspect(ctx: RemediationContext): Promise<StepInspection>;
  apply(ctx: RemediationContext): Promise<StepApplyOutcome>;
}

export type RemediationStepStatus = 'ok' | 'skipped' | 'failed' | 'conflict';

/** 报告的一行 (plan D5「报告」): 预览中 `ok` 表示「将要做」, detail 即推算结果。 */
export interface RemediationStepReport {
  step: string;
  status: RemediationStepStatus;
  detail: string;
}

/** 步骤数组的 DI token。生产装配在 `optionsdesk.module.ts`; 测试直接 `new` 并传桩步骤。 */
export const REMEDIATION_STEPS = Symbol('REMEDIATION_STEPS');

/**
 * 撤销步骤数组的 DI token (T012)。与 {@link REMEDIATION_STEPS} 同一接口 —— 撤销步骤的 `inspect`
 * 判「已撤销 ⇒ done」, `apply` 做逆操作; 顺序由 `revertStepsOf` 钉死, 不是正向数组简单倒序。
 */
export const REMEDIATION_REVERT_STEPS = Symbol('REMEDIATION_REVERT_STEPS');

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 086 修正命令编排 (FR-012 / FR-013; plan D5)。
 *
 * 依次跑步骤数组, 每步两段式 (同 `auth/phone-sms-auth.usecase.ts` 的 Inspect / Commit):
 * 1. `inspect` (只读) —— 预览模式到此为止, `pending` 报 `ok` + 将要做什么;
 * 2. apply 模式下 `done` ⇒ `skipped`, 否则调 `apply`。
 * 任一步 `failed` / `conflict` ⇒ 停, 后续步骤不跑也不进报告 (续跑靠再执行一次 + 各步 `done` 跳过)。
 *
 * 复杂度: O(n) 步, 每步至多一次 inspect + 一次 apply。
 */
@Injectable()
export class RemediateSymbolChangeUseCase {
  constructor(
    @Inject(REMEDIATION_STEPS) private readonly steps: readonly RemediationStep[],
    @Optional()
    @Inject(REMEDIATION_REVERT_STEPS)
    private readonly revertSteps: readonly RemediationStep[] = [],
  ) {}

  async execute(input: RemediateSymbolChangeInput): Promise<RemediationStepReport[]> {
    const ctx: RemediationContext = {
      market: input.market,
      oldCode: input.oldCode,
      newCode: input.newCode,
      effectiveDate: input.effectiveDate,
      evidence: input.evidence,
      operator: input.operator,
      oldTicker: `${input.market}:${input.oldCode}`,
      newTicker: `${input.market}:${input.newCode}`,
      now: input.now ?? new Date(),
    };

    const report: RemediationStepReport[] = [];
    const steps = input.direction === 'revert' ? this.revertSteps : this.steps;
    for (const step of steps) {
      const line = await this.runStep(step, ctx, input.mode);
      report.push(line);
      if (line.status === 'failed' || line.status === 'conflict') break;
    }
    return report;
  }

  private async runStep(
    step: RemediationStep,
    ctx: RemediationContext,
    mode: RemediationMode,
  ): Promise<RemediationStepReport> {
    const report = (status: RemediationStepStatus, detail: string): RemediationStepReport => ({
      step: step.name,
      status,
      detail,
    });
    try {
      const inspection = await step.inspect(ctx);
      if (inspection.state === 'conflict') return report('conflict', inspection.detail);
      if (inspection.state === 'done') return report('skipped', inspection.detail);
      if (mode === 'preview') return report('ok', inspection.detail);
      const outcome = await step.apply(ctx);
      return report(outcome.status, outcome.detail);
    } catch (e) {
      return report('failed', errorMessage(e));
    }
  }
}
