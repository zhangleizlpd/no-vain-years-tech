import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { CreateAlertsBatchUseCase } from './create-alerts-batch.usecase';
import { ListInstrumentAlertsUseCase } from './list-instrument-alerts.usecase';
import { ListAlertsUseCase } from './list-alerts.usecase';
import { toAlertListResponse, toAlertResponse } from './alert.response';

// 021 T004 US1: 读侧两 UC (个股预警 EP1 / 全部预警 EP2) + alert.response 投影。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('alert read usecases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createBatch: CreateAlertsBatchUseCase;
  let listInstrument: ListInstrumentAlertsUseCase;
  let listAll: ListAlertsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    createBatch = new CreateAlertsBatchUseCase(prisma);
    listInstrument = new ListInstrumentAlertsUseCase(prisma);
    listAll = new ListAlertsUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(930_000 + ++seq);

  describe('ListInstrumentAlertsUseCase (EP1)', () => {
    it('无预警 → 空数组 (不存在的标的同形, 零跨 ctx 读)', async () => {
      expect(await listInstrument.execute(nextAccountId(), 'cn', '603305')).toEqual([]);
    });

    it('仅返回该标的 + 本账号; conditions 内联; 创建序 (id asc)', async () => {
      const accountId = nextAccountId();
      const other = nextAccountId();
      // 同标的两条 (先后创建) + 异标的一条 + 他账号同标的一条
      const [first] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
        frequency: 'DAILY',
        note: null,
      });
      const [second] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [
          { type: 'PRICE_RISE_TO', threshold: 20 },
          { type: 'DAILY_GAIN_OVER', threshold: 5 },
        ],
        frequency: 'ONCE_DISABLE',
        note: '冲高观察',
      });
      await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '600519' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 1500 }],
        frequency: 'DAILY',
        note: null,
      });
      await createBatch.execute(other, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 12 }],
        frequency: 'DAILY',
        note: null,
      });

      const rows = await listInstrument.execute(accountId, 'cn', '603305');
      expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(rows[1].conditions.map((c) => c.type).sort()).toEqual([
        'DAILY_GAIN_OVER',
        'PRICE_RISE_TO',
      ]);
    });
  });

  describe('ListAlertsUseCase (EP2)', () => {
    it('无预警 → 空数组', async () => {
      expect(await listAll.execute(nextAccountId())).toEqual([]);
    });

    it('全账号预警平铺, market/code 相邻 + 组内创建序; 他账号隔离', async () => {
      const accountId = nextAccountId();
      const other = nextAccountId();
      // 交错创建两标的 (600519 后建却排前 — code asc), 验非纯 id 序
      const [a1] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
        frequency: 'DAILY',
        note: null,
      });
      const [b1] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '600519' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 1500 }],
        frequency: 'DAILY',
        note: null,
      });
      const [a2] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_RISE_TO', threshold: 20 }],
        frequency: 'DAILY',
        note: null,
      });
      await createBatch.execute(other, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 12 }],
        frequency: 'DAILY',
        note: null,
      });

      const rows = await listAll.execute(accountId);
      expect(rows.map((r) => r.id)).toEqual([b1.id, a1.id, a2.id]);
      expect(rows.every((r) => r.accountId === accountId)).toBe(true);
    });
  });

  describe('toAlertResponse / toAlertListResponse (015 体例投影)', () => {
    it('threshold Decimal → "13.0000" 串; id 数字串; createdAt ISO; note 透传', async () => {
      const accountId = nextAccountId();
      const [row] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: 13 },
          { type: 'DAILY_LOSS_OVER', threshold: 7.5 },
        ],
        frequency: 'DAILY',
        note: '低吸观察',
      });

      const dto = toAlertResponse(row);
      expect(dto.id).toBe(row.id.toString());
      expect(dto.id).toMatch(/^\d+$/);
      expect(new Map(dto.conditions.map((c) => [c.type, c.threshold]))).toEqual(
        new Map([
          ['PRICE_FALL_TO', '13.0000'],
          ['DAILY_LOSS_OVER', '7.5000'],
        ]),
      );
      expect(dto.note).toBe('低吸观察');
      expect(dto.enabled).toBe(true);
      expect(dto.frequency).toBe('DAILY');
      expect(dto.createdAt).toBe(row.createdAt.toISOString());
    });

    it('023: 带参条件投影 param 透传 + 无阈值条件 threshold null', async () => {
      const accountId = nextAccountId();
      const [row] = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [
          { type: 'MA_CROSS_UP', param: 20 },
          { type: 'PE_BELOW', threshold: 10 },
        ],
        frequency: 'DAILY',
        note: null,
      });

      const dto = toAlertResponse(row);
      expect(dto.conditions).toContainEqual({ type: 'MA_CROSS_UP', param: 20, threshold: null });
      expect(dto.conditions).toContainEqual({ type: 'PE_BELOW', param: 0, threshold: '10.0000' });
    });

    it('note null 保持 null (非 undefined/空串); 列表投影包 alerts 键', async () => {
      const accountId = nextAccountId();
      const rows = await createBatch.execute(accountId, {
        instruments: [{ market: 'cn', code: '603305' }],
        conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
        frequency: 'DAILY',
        note: null,
      });

      const list = toAlertListResponse(rows);
      expect(list.alerts).toHaveLength(1);
      expect(list.alerts[0].note).toBeNull();
    });
  });
});
