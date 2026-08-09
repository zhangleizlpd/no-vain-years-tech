import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AlertsController } from './alerts.controller';
import { AlertMessagesController } from './messages.controller';
import { FormValidationException } from '../security/form-validation.exception';
import type { ListInstrumentAlertsUseCase } from './list-instrument-alerts.usecase';
import type { ListAlertsUseCase } from './list-alerts.usecase';
import type { CreateAlertsBatchUseCase } from './create-alerts-batch.usecase';
import type { UpdateAlertUseCase } from './update-alert.usecase';
import type { DeleteAlertsBatchUseCase } from './delete-alerts-batch.usecase';
import type { ListMessagesUseCase } from './list-messages.usecase';
import type { GetUnreadCountUseCase } from './get-unread-count.usecase';
import type { MarkMessagesReadUseCase } from './mark-messages-read.usecase';

// 021 T006: 两 controller 薄透传 (accountId 来源 req.user / 路径 id 解析 / DTO 投影 / 默认值)。
// 限流桶/guard 行为不在此测 (T007 IT 覆盖 401/429)。

const ROW = {
  id: 101n,
  accountId: 42n,
  market: 'cn',
  code: '603305',
  frequency: 'DAILY',
  note: null,
  enabled: true,
  createdAt: new Date('2026-06-06T08:00:00.000Z'),
  updatedAt: new Date('2026-06-06T08:00:00.000Z'),
  conditions: [{ id: 1n, alertId: 101n, type: 'PRICE_FALL_TO', threshold: new Prisma.Decimal(13) }],
};

const REQ = { user: { accountId: 42n, deviceId: null } } as unknown as Parameters<
  AlertsController['listAll']
>[0];

function buildAlerts() {
  const listInstrument = { execute: vi.fn().mockResolvedValue([ROW]) };
  const listAll = { execute: vi.fn().mockResolvedValue([ROW]) };
  const createBatch = { execute: vi.fn().mockResolvedValue([ROW]) };
  const update = { execute: vi.fn().mockResolvedValue(ROW) };
  const deleteBatch = { execute: vi.fn().mockResolvedValue(2) };
  const controller = new AlertsController(
    listInstrument as unknown as ListInstrumentAlertsUseCase,
    listAll as unknown as ListAlertsUseCase,
    createBatch as unknown as CreateAlertsBatchUseCase,
    update as unknown as UpdateAlertUseCase,
    deleteBatch as unknown as DeleteAlertsBatchUseCase,
  );
  return { controller, listInstrument, listAll, createBatch, update, deleteBatch };
}

describe('AlertsController (EP1-EP5)', () => {
  it('EP1 → 透传 (accountId, market, code) + 投影 (threshold 串 / id 串)', async () => {
    const { controller, listInstrument } = buildAlerts();
    const res = await controller.listForInstrument(REQ, 'cn', '603305');
    expect(listInstrument.execute).toHaveBeenCalledWith(42n, 'cn', '603305');
    expect(res.alerts[0]).toMatchObject({
      id: '101',
      conditions: [{ type: 'PRICE_FALL_TO', threshold: '13.0000' }],
      note: null,
      createdAt: '2026-06-06T08:00:00.000Z',
    });
  });

  it('EP2 → 透传 accountId', async () => {
    const { controller, listAll } = buildAlerts();
    const res = await controller.listAll(REQ);
    expect(listAll.execute).toHaveBeenCalledWith(42n);
    expect(res.alerts).toHaveLength(1);
  });

  it('EP3 → frequency 缺省补 DAILY / note 缺省补 null, 201 投影', async () => {
    const { controller, createBatch } = buildAlerts();
    await controller.createBatch(REQ, {
      instruments: [{ market: 'cn', code: '603305' }],
      conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
    });
    expect(createBatch.execute).toHaveBeenCalledWith(42n, {
      instruments: [{ market: 'cn', code: '603305' }],
      conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
      frequency: 'DAILY',
      note: null,
    });
  });

  it('EP4 → id 数字串转 BigInt 透传; 非数字 id → 404 (UC 不被调, 反枚举)', async () => {
    const { controller, update } = buildAlerts();
    await controller.update(REQ, '101', { enabled: false });
    expect(update.execute).toHaveBeenCalledWith(42n, 101n, {
      conditions: undefined,
      frequency: undefined,
      note: undefined,
      enabled: false,
    });

    await expect(controller.update(REQ, 'abc', { enabled: false })).rejects.toThrow(
      NotFoundException,
    );
    expect(update.execute).toHaveBeenCalledTimes(1);
  });

  it('EP5 → ids 串转 BigInt[], 返 {deleted}', async () => {
    const { controller, deleteBatch } = buildAlerts();
    const res = await controller.deleteBatch(REQ, { ids: ['1', '2', '3'] });
    expect(deleteBatch.execute).toHaveBeenCalledWith(42n, [1n, 2n, 3n]);
    expect(res).toEqual({ deleted: 2 });
  });
});

function buildMessages() {
  const list = { execute: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }) };
  const unread = { execute: vi.fn().mockResolvedValue({ unread: 3 }) };
  const markRead = { execute: vi.fn().mockResolvedValue({ unread: 0 }) };
  const controller = new AlertMessagesController(
    list as unknown as ListMessagesUseCase,
    unread as unknown as GetUnreadCountUseCase,
    markRead as unknown as MarkMessagesReadUseCase,
  );
  return { controller, list, unread, markRead };
}

describe('AlertMessagesController (EP6-EP8)', () => {
  it('EP6 → cursor 透传 + limit 数字串转 number; 缺省全 undefined', async () => {
    const { controller, list } = buildMessages();
    await controller.list(REQ, '301', '50');
    expect(list.execute).toHaveBeenCalledWith(42n, { cursor: '301', limit: 50 });

    await controller.list(REQ);
    expect(list.execute).toHaveBeenCalledWith(42n, { cursor: undefined, limit: undefined });
  });

  it('EP6 非数字 limit → 400 FORM_VALIDATION (UC 不被调)', async () => {
    const { controller, list } = buildMessages();
    await expect(controller.list(REQ, undefined, 'abc')).rejects.toThrow(FormValidationException);
    expect(list.execute).not.toHaveBeenCalled();
  });

  it('EP7 / EP8 → 透传 accountId', async () => {
    const { controller, unread, markRead } = buildMessages();
    expect(await controller.unreadCount(REQ)).toEqual({ unread: 3 });
    expect(unread.execute).toHaveBeenCalledWith(42n);
    expect(await controller.markRead(REQ)).toEqual({ unread: 0 });
    expect(markRead.execute).toHaveBeenCalledWith(42n);
  });
});
