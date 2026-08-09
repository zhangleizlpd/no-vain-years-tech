import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { BrokerAccountsController } from './broker-accounts.controller';
import type { ListBrokerAccountsUseCase } from './list-broker-accounts.usecase';
import type { BindBrokerAccountUseCase } from './bind-broker-account.usecase';
import type { DeleteBrokerAccountUseCase } from './delete-broker-account.usecase';
import type { BrokerAccountListItem } from './portfolio.rules';
import { FormValidationException } from '../security/form-validation.exception';
import { BrokerAccountDuplicateException } from './broker-account-duplicate.exception';
import { DefaultAccountNotDeletableException } from './default-account-not-deletable.exception';

const DEFAULT_ITEM: BrokerAccountListItem = {
  id: '42',
  brokerCode: null,
  brokerName: '默认账户',
  clientNo: null,
  isDefault: true,
  createdAt: null,
};

const BOUND_ITEM: BrokerAccountListItem = {
  id: '7',
  brokerCode: 'htai',
  brokerName: '华泰证券',
  clientNo: '3119000002466',
  isDefault: false,
  createdAt: '2026-06-02T08:00:00.000Z',
};

function build() {
  const listExecute = vi.fn().mockResolvedValue({ accounts: [DEFAULT_ITEM, BOUND_ITEM] });
  const bindExecute = vi.fn().mockResolvedValue(BOUND_ITEM);
  const deleteExecute = vi.fn().mockResolvedValue(undefined);
  const controller = new BrokerAccountsController(
    { execute: listExecute } as unknown as ListBrokerAccountsUseCase,
    { execute: bindExecute } as unknown as BindBrokerAccountUseCase,
    { execute: deleteExecute } as unknown as DeleteBrokerAccountUseCase,
  );
  return { controller, listExecute, bindExecute, deleteExecute };
}

const REQ = { user: { accountId: 42n } };

describe('BrokerAccountsController', () => {
  it('GET → 200 默认置顶 + 已绑列表 (delegates accountId)', async () => {
    const { controller, listExecute } = build();
    const res = await controller.list(REQ);
    expect(listExecute).toHaveBeenCalledWith(42n);
    expect(res.accounts).toHaveLength(2);
    expect(res.accounts[0].isDefault).toBe(true);
    expect(res.accounts[1].brokerCode).toBe('htai');
  });

  it('POST → 201 透传 (accountId, brokerCode, clientNo) + 返新条', async () => {
    const { controller, bindExecute } = build();
    const res = await controller.bind(REQ, { brokerCode: 'htai', clientNo: '3119000002466' });
    expect(bindExecute).toHaveBeenCalledWith(42n, 'htai', '3119000002466');
    expect(res.id).toBe('7');
    expect(res.isDefault).toBe(false);
  });

  it('POST 透传 usecase 重复异常 (409 由 filter 映射)', async () => {
    const { controller, bindExecute } = build();
    bindExecute.mockRejectedValueOnce(new BrokerAccountDuplicateException());
    await expect(
      controller.bind(REQ, { brokerCode: 'htai', clientNo: '3119000002466' }),
    ).rejects.toBeInstanceOf(BrokerAccountDuplicateException);
  });

  it('DELETE 合法 id → 204 透传 (accountId, BigInt(id))', async () => {
    const { controller, deleteExecute } = build();
    await controller.delete(REQ, '7');
    expect(deleteExecute).toHaveBeenCalledWith(42n, 7n);
  });

  it('DELETE 非数字 id → 400 FORM_VALIDATION (不调 usecase)', async () => {
    const { controller, deleteExecute } = build();
    await expect(controller.delete(REQ, 'abc')).rejects.toBeInstanceOf(FormValidationException);
    expect(deleteExecute).not.toHaveBeenCalled();
  });

  it('DELETE 透传 usecase 默认不可删异常 (400)', async () => {
    const { controller, deleteExecute } = build();
    deleteExecute.mockRejectedValueOnce(new DefaultAccountNotDeletableException());
    await expect(controller.delete(REQ, '42')).rejects.toBeInstanceOf(
      DefaultAccountNotDeletableException,
    );
  });

  it('DELETE 透传 usecase 反枚举 404', async () => {
    const { controller, deleteExecute } = build();
    deleteExecute.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.delete(REQ, '999')).rejects.toBeInstanceOf(NotFoundException);
  });
});
