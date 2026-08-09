import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { CreateAlertsBatchUseCase } from './create-alerts-batch.usecase';
import { UpdateAlertUseCase } from './update-alert.usecase';
import { DeleteAlertsBatchUseCase } from './delete-alerts-batch.usecase';

// 021 T003 US1: 写侧三 UC (批量建 EP3 / 编辑 EP4 / 批量删 EP5)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('alert write usecases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createBatch: CreateAlertsBatchUseCase;
  let update: UpdateAlertUseCase;
  let deleteBatch: DeleteAlertsBatchUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    createBatch = new CreateAlertsBatchUseCase(prisma);
    update = new UpdateAlertUseCase(prisma);
    deleteBatch = new DeleteAlertsBatchUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(920_000 + ++seq);

  const baseInput = () => ({
    instruments: [{ market: 'cn', code: '603305' }],
    conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
    frequency: 'DAILY',
    note: null,
  });

  describe('CreateAlertsBatchUseCase (EP3, plan D5 单 tx 原子)', () => {
    it('批量 2 标的 × 同套 2 条件 → 各建一条独立预警 (含 conditions)', async () => {
      const accountId = nextAccountId();
      const created = await createBatch.execute(accountId, {
        instruments: [
          { market: 'cn', code: '603305' },
          { market: 'cn', code: '600519' },
        ],
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: 13 },
          { type: 'DAILY_LOSS_OVER', threshold: 7 },
        ],
        frequency: 'DAILY',
        note: '低吸观察',
      });

      expect(created).toHaveLength(2);
      expect(created.map((a) => a.code).sort()).toEqual(['600519', '603305']);
      for (const alert of created) {
        expect(alert.accountId).toBe(accountId);
        expect(alert.enabled).toBe(true);
        expect(alert.frequency).toBe('DAILY');
        expect(alert.note).toBe('低吸观察');
        expect(alert.conditions).toHaveLength(2);
        expect(alert.conditions.map((c) => c.type).sort()).toEqual([
          'DAILY_LOSS_OVER',
          'PRICE_FALL_TO',
        ]);
      }
      // 各自独立行
      const rows = await prisma.alert.count({ where: { accountId } });
      expect(rows).toBe(2);
    });

    it('同类型条件重复 → 400 FORM_VALIDATION (field=conditions), 零落库', async () => {
      const accountId = nextAccountId();
      const act = createBatch.execute(accountId, {
        ...baseInput(),
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: 13 },
          { type: 'PRICE_FALL_TO', threshold: 12 },
        ],
      });
      await expect(act).rejects.toThrow(FormValidationException);
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          conditions: [
            { type: 'PRICE_FALL_TO', threshold: 13 },
            { type: 'PRICE_FALL_TO', threshold: 12 },
          ],
        }),
      ).rejects.toMatchObject({
        invalidAttributes: [{ field: 'conditions', messages: [expect.any(String)] }],
      });
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('0 条件 → 400, 零落库', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, { ...baseInput(), conditions: [] }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('note 23 字 → 400 (field=note), 零落库', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, { ...baseInput(), note: '一'.repeat(23) }),
      ).rejects.toMatchObject({
        invalidAttributes: [{ field: 'note', messages: [expect.any(String)] }],
      });
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('任一标的 market 非法 → 整体 400, 零落库 (批量原子)', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          instruments: [
            { market: 'cn', code: '603305' },
            { market: 'hk', code: '00700' },
          ],
        }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });
  });

  describe('UpdateAlertUseCase (EP4, 404 反枚举)', () => {
    it('conditions 全量替换 + frequency/note/enabled 更新', async () => {
      const accountId = nextAccountId();
      const [alert] = await createBatch.execute(accountId, baseInput());

      const updated = await update.execute(accountId, alert.id, {
        conditions: [
          { type: 'PRICE_RISE_TO', threshold: 20 },
          { type: 'DAILY_GAIN_OVER', threshold: 5 },
        ],
        frequency: 'ONCE_DISABLE',
        note: '改备注',
        enabled: false,
      });

      expect(updated.frequency).toBe('ONCE_DISABLE');
      expect(updated.note).toBe('改备注');
      expect(updated.enabled).toBe(false);
      expect(updated.conditions.map((c) => c.type).sort()).toEqual([
        'DAILY_GAIN_OVER',
        'PRICE_RISE_TO',
      ]);
      // 旧条件被替换不残留
      expect(await prisma.alertCondition.count({ where: { alertId: alert.id } })).toBe(2);
    });

    it('patch 省略字段保持原值; note 显式 null 清空', async () => {
      const accountId = nextAccountId();
      const [alert] = await createBatch.execute(accountId, { ...baseInput(), note: '原备注' });

      const kept = await update.execute(accountId, alert.id, { enabled: false });
      expect(kept.note).toBe('原备注');
      expect(kept.frequency).toBe('DAILY');
      expect(kept.conditions).toHaveLength(1);

      const cleared = await update.execute(accountId, alert.id, { note: null });
      expect(cleared.note).toBeNull();
    });

    it('merge 后复验: patch 重复类型条件 → 400', async () => {
      const accountId = nextAccountId();
      const [alert] = await createBatch.execute(accountId, baseInput());
      await expect(
        update.execute(accountId, alert.id, {
          conditions: [
            { type: 'PRICE_FALL_TO', threshold: 13 },
            { type: 'PRICE_FALL_TO', threshold: 12 },
          ],
        }),
      ).rejects.toThrow(FormValidationException);
    });

    it('他人 alert → 404 NotFound (反枚举, 不泄露存在性)', async () => {
      const owner = nextAccountId();
      const attacker = nextAccountId();
      const [alert] = await createBatch.execute(owner, baseInput());
      await expect(update.execute(attacker, alert.id, { enabled: false })).rejects.toThrow(
        NotFoundException,
      );
      // 未被改动
      const row = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
      expect(row.enabled).toBe(true);
    });

    it('不存在 id → 404', async () => {
      await expect(
        update.execute(nextAccountId(), BigInt(999_999_999), { enabled: false }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── 023 T003: 带参条件 CRUD 接线 (param 落库 + threshold nullable) ──────────
  describe('023 带参条件建档/回显', () => {
    it('各 kind 建档: param/threshold 按 meta 形态落库 (2 预警覆盖 7 kind)', async () => {
      const accountId = nextAccountId();
      const [a1] = await createBatch.execute(accountId, {
        ...baseInput(),
        conditions: [
          { type: 'PE_BELOW', threshold: 10 }, // threshold/positive
          { type: 'MA_CROSS_UP', param: 20 }, // ma
          { type: 'VOLUME_RATIO_OVER', threshold: 2 }, // threshold/volume
          { type: 'BOLL_BREAK_LOWER' }, // none
        ],
      });
      const by1 = new Map(a1.conditions.map((c) => [c.type, c]));
      expect(by1.get('PE_BELOW')?.param).toBe(0);
      expect(by1.get('PE_BELOW')?.threshold?.toNumber()).toBe(10);
      expect(by1.get('MA_CROSS_UP')?.param).toBe(20);
      expect(by1.get('MA_CROSS_UP')?.threshold).toBeNull();
      expect(by1.get('BOLL_BREAK_LOWER')?.param).toBe(0);
      expect(by1.get('BOLL_BREAK_LOWER')?.threshold).toBeNull();

      const [a2] = await createBatch.execute(accountId, {
        ...baseInput(),
        instruments: [{ market: 'cn', code: '600519' }],
        conditions: [
          { type: 'NEW_HIGH', param: 250 }, // window
          { type: 'PERIOD_GAIN_OVER', param: 5, threshold: 10 }, // daysPct
          { type: 'PE_PCTL_BELOW', param: 3, threshold: 20 }, // pctile
          { type: 'RSI_OVERSOLD', threshold: 30 }, // rsi
        ],
      });
      const by2 = new Map(a2.conditions.map((c) => [c.type, c]));
      expect(by2.get('NEW_HIGH')?.param).toBe(250);
      expect(by2.get('NEW_HIGH')?.threshold).toBeNull();
      expect(by2.get('PERIOD_GAIN_OVER')?.param).toBe(5);
      expect(by2.get('PERIOD_GAIN_OVER')?.threshold?.toNumber()).toBe(10);
      expect(by2.get('PE_PCTL_BELOW')?.param).toBe(3);
      expect(by2.get('RSI_OVERSOLD')?.param).toBe(0);
      expect(by2.get('RSI_OVERSOLD')?.threshold?.toNumber()).toBe(30);
    });

    it('同 type 不同 param 共存 (MA5+MA20); 同 type 同 param → 400 零落库', async () => {
      const accountId = nextAccountId();
      const [coexist] = await createBatch.execute(accountId, {
        ...baseInput(),
        conditions: [
          { type: 'MA_CROSS_UP', param: 5 },
          { type: 'MA_CROSS_UP', param: 20 },
        ],
      });
      expect(coexist.conditions.map((c) => c.param).sort((x, y) => x - y)).toEqual([5, 20]);

      const before = await prisma.alert.count({ where: { accountId } });
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          instruments: [{ market: 'cn', code: '600519' }],
          conditions: [
            { type: 'MA_CROSS_UP', param: 20 },
            { type: 'MA_CROSS_UP', param: 20 },
          ],
        }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(before);
    });

    it('无参带 threshold / param 出白名单 → 400 零落库 (FR-S07)', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          conditions: [{ type: 'MACD_GOLDEN_CROSS', threshold: 5 }],
        }),
      ).rejects.toThrow(FormValidationException);
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          conditions: [{ type: 'MA_CROSS_UP', param: 15 }],
        }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('update 全量替换为带参条件; 021 旧 shape (无 param) 向后兼容回显', async () => {
      const accountId = nextAccountId();
      // 021 旧 shape 建档 → param 默认 0
      const [alert] = await createBatch.execute(accountId, baseInput());
      expect(alert.conditions[0].param).toBe(0);
      expect(alert.conditions[0].threshold?.toNumber()).toBe(13);

      // 替换为混类带参条件
      const updated = await update.execute(accountId, alert.id, {
        conditions: [{ type: 'MA_CROSS_DOWN', param: 60 }, { type: 'KDJ_OVERSOLD' }],
      });
      const byType = new Map(updated.conditions.map((c) => [c.type, c]));
      expect(byType.get('MA_CROSS_DOWN')?.param).toBe(60);
      expect(byType.get('MA_CROSS_DOWN')?.threshold).toBeNull();
      expect(byType.get('KDJ_OVERSOLD')?.param).toBe(0);

      // patch 不带 conditions 时 merge 现值复验仍通过 (含 threshold null 行)
      const kept = await update.execute(accountId, alert.id, { note: '只改备注' });
      expect(kept.conditions).toHaveLength(2);
      expect(kept.note).toBe('只改备注');
    });
  });

  // ── 024 T003: 盘中 5min 类 CRUD 接线 (词表 +2, 校验 meta 驱动天然覆盖) ──────────
  describe('024 盘中 5min 类建档/回显', () => {
    it('5min 涨超/跌超 + 到价类同 alert 共存 → param 0 / threshold 落库回显', async () => {
      const accountId = nextAccountId();
      const [alert] = await createBatch.execute(accountId, {
        ...baseInput(),
        conditions: [
          { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 }, // percent (0,100]
          { type: 'PRICE_FALL_5MIN_OVER', threshold: 5 },
          { type: 'PRICE_RISE_TO', threshold: 20 }, // 到价类共存
        ],
      });
      const by = new Map(alert.conditions.map((c) => [c.type, c]));
      expect(by.get('PRICE_RISE_5MIN_OVER')?.param).toBe(0);
      expect(by.get('PRICE_RISE_5MIN_OVER')?.threshold?.toNumber()).toBe(3);
      expect(by.get('PRICE_FALL_5MIN_OVER')?.param).toBe(0);
      expect(by.get('PRICE_FALL_5MIN_OVER')?.threshold?.toNumber()).toBe(5);
      expect(by.get('PRICE_RISE_TO')?.threshold?.toNumber()).toBe(20);
      expect(alert.conditions).toHaveLength(3);
    });

    it('threshold 出域 (>100) → 400 零落库 (percent 族)', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          conditions: [{ type: 'PRICE_RISE_5MIN_OVER', threshold: 101 }],
        }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('param 带非 0 → 400 零落库 (无参类型)', async () => {
      const accountId = nextAccountId();
      await expect(
        createBatch.execute(accountId, {
          ...baseInput(),
          conditions: [{ type: 'PRICE_FALL_5MIN_OVER', param: 5, threshold: 3 }],
        }),
      ).rejects.toThrow(FormValidationException);
      expect(await prisma.alert.count({ where: { accountId } })).toBe(0);
    });

    it('update 全量替换为 5min 类 → 回显; 021 旧 shape 向后兼容', async () => {
      const accountId = nextAccountId();
      const [alert] = await createBatch.execute(accountId, baseInput());
      const updated = await update.execute(accountId, alert.id, {
        conditions: [{ type: 'PRICE_RISE_5MIN_OVER', threshold: 3 }],
      });
      expect(updated.conditions).toHaveLength(1);
      expect(updated.conditions[0].type).toBe('PRICE_RISE_5MIN_OVER');
      expect(updated.conditions[0].param).toBe(0);
      expect(updated.conditions[0].threshold?.toNumber()).toBe(3);
    });
  });

  describe('DeleteAlertsBatchUseCase (EP5, 只删本账号命中)', () => {
    it('混入他人 id → 仅删本账号项, 返实删 count; conditions 级联', async () => {
      const owner = nextAccountId();
      const other = nextAccountId();
      const mine = await createBatch.execute(owner, {
        ...baseInput(),
        instruments: [
          { market: 'cn', code: '603305' },
          { market: 'cn', code: '600519' },
        ],
      });
      const [theirs] = await createBatch.execute(other, baseInput());

      const deleted = await deleteBatch.execute(owner, [mine[0].id, mine[1].id, theirs.id]);
      expect(deleted).toBe(2);

      expect(await prisma.alert.count({ where: { accountId: owner } })).toBe(0);
      expect(await prisma.alertCondition.count({ where: { alertId: mine[0].id } })).toBe(0);
      // 他人项不受影响
      expect(await prisma.alert.count({ where: { id: theirs.id } })).toBe(1);
    });

    it('空 ids → 0, 不报错', async () => {
      expect(await deleteBatch.execute(nextAccountId(), [])).toBe(0);
    });
  });
});
