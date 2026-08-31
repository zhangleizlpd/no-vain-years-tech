import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AdminOnlyGuard } from '../account/admin-only.guard';
import { JwtAuthGuard } from '../account/jwt-auth.guard';
import { AnchorSubmissionController } from './anchor-submission.controller';

/**
 * 断言派生自 spec **FR-010**（「审批面 MUST admin-only，且 MUST 由**类级** guard 保证
 * ——方法级是会被未来某个 PR 漏掉的纪律」）。
 *
 * 🚨 本文件存在的**首要理由**是那条元数据断言：plan §D7 论证了「类级是保证、方法级是纪律」，
 * 但论证本身不是保证。没有这条断言，任何人把 `AdminOnlyGuard` 从类装饰器上摘掉、或新增一个
 * 忘了挂 guard 的路由，**没有任何东西会红**，而后果是管理面对每个登录账号敞开。
 */
function classGuards(): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, AnchorSubmissionController) as unknown[]) ?? [];
}

function makeController() {
  const listSubmissions = { execute: vi.fn(), getDetail: vi.fn() };
  const approveSubmission = { execute: vi.fn() };
  const rejectSubmissions = { execute: vi.fn() };
  const controller = new AnchorSubmissionController(
    listSubmissions as never,
    approveSubmission as never,
    rejectSubmissions as never,
  );
  return { controller, listSubmissions, approveSubmission, rejectSubmissions };
}

describe('AnchorSubmissionController — FR-010 类级准入', () => {
  it('AdminOnlyGuard 挂在**类级** (整个面 admin-only)', () => {
    expect(classGuards()).toContain(AdminOnlyGuard);
  });

  it('JwtAuthGuard 排在 AdminOnlyGuard 之前 (后者依赖前者填 request.user)', () => {
    const guards = classGuards();
    const jwtAt = guards.indexOf(JwtAuthGuard);
    const adminAt = guards.indexOf(AdminOnlyGuard);
    expect(jwtAt).toBeGreaterThanOrEqual(0);
    expect(adminAt).toBeGreaterThan(jwtAt);
  });
});

describe('AnchorSubmissionController — 路由行为', () => {
  it('非数字 id → 404 (与不存在不可区分)', async () => {
    const { controller } = makeController();
    await expect(controller.getOne('abc')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('详情查不到 → 404', async () => {
    const { controller, listSubmissions } = makeController();
    listSubmissions.getDetail.mockResolvedValue(null);
    await expect(controller.getOne('7')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('列表把 truncated 与条数如实透出 (不分页, 截断必须可见)', async () => {
    const { controller, listSubmissions } = makeController();
    listSubmissions.execute.mockResolvedValue({ items: [], truncated: true });
    const res = await controller.list({ status: 'PENDING' } as never);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(0);
  });

  it('驳回把 ids 转成 bigint 交给 use case (数字串契约)', async () => {
    const { controller, rejectSubmissions } = makeController();
    rejectSubmissions.execute.mockResolvedValue({ rejected: 2, skipped: [] });
    await controller.reject({ ids: ['3', '4'], reviewNote: 'x' } as never);
    expect(rejectSubmissions.execute).toHaveBeenCalledWith({ ids: [3n, 4n], reviewNote: 'x' });
  });

  it('采纳把 asofAck 原样透传 (fail-closed 闸的钥匙不能在 controller 层被吞掉)', async () => {
    const { controller, approveSubmission } = makeController();
    approveSubmission.execute.mockResolvedValue({
      action: 'create',
      anchorId: '9',
      ticker: 'us:CFG',
      appliedAsof: '2026-08-28',
      asofFlag: 'NON_TRADING',
      fallbackEntries: [],
      statusFlipped: true,
      flipFailure: null,
      coldStartExpected: true,
    });
    await controller.approve('5', { asofAck: 'shift' } as never);
    expect(approveSubmission.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5n, asofAck: 'shift' }),
    );
  });
});
