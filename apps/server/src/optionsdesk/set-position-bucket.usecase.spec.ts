import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service';
import { POSITION_BUCKETS, resolvePositionBucket } from './intent-matrix.rules';
import { SetPositionBucketRequest, toPositionBucketResponse } from './optionsdesk.dto';
import { SetPositionBucketUseCase } from './set-position-bucket.usecase';

type Fn = ReturnType<typeof vi.fn>;

const ANCHOR_ID = 7n;
const TICKER = 'us:PEP';
const T1 = new Date('2026-08-04T02:15:00.000Z');
/** 第二次手选 —— 与 T1 差 90 秒, 用来钉「更新时刻前进」。 */
const T2 = new Date('2026-08-04T02:16:30.000Z');

interface PrismaMock {
  prisma: PrismaService;
  findUnique: Fn;
  updateMany: Fn;
  changeCreate: Fn;
}

function buildPrismaMock(existing: { ticker: string } | null = { ticker: TICKER }): PrismaMock {
  const findUnique = vi.fn().mockResolvedValue(existing);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    anchor: { findUnique, updateMany },
    anchorChange: { create: changeCreate },
  } as unknown as PrismaService;
  return { prisma, findUnique, updateMany, changeCreate };
}

/**
 * 「非法枚举 → 400」的机器判据落在**通道层 DTO**, 不在 usecase —— usecase 的入参已被
 * `@IsIn(POSITION_BUCKETS)` 收窄成联合类型, 在它内部再判一次字面量正是 FR-017 禁的第二处值域。
 * 故此处直接跑 `ValidationPipe` 用的同一套 class-validator 元数据 (Small: 单进程, 无 I/O)。
 */
describe('SetPositionBucketRequest — 三选一值域 (非法值 → 400)', () => {
  const errorsFor = (payload: unknown): number =>
    validateSync(plainToInstance(SetPositionBucketRequest, payload)).length;

  it('三个合法档位各自通过', () => {
    for (const bucket of POSITION_BUCKETS) {
      expect(errorsFor({ positionBucket: bucket })).toBe(0);
    }
  });

  it('🚨 缺字段 → 拒 (服务端 MUST NOT 自造默认档, FR-017 替人做方向性假设)', () => {
    expect(errorsFor({})).toBeGreaterThan(0);
  });

  it('🚨 显式 null → 拒 (未选是初始态, 不是本端点可达的动作)', () => {
    expect(errorsFor({ positionBucket: null })).toBeGreaterThan(0);
  });

  it('值域外的字符串 / 空串 / 非字符串 → 拒', () => {
    for (const raw of ['half', 'LT_ONE_THIRD', '', 'one_third', 1, true, {}]) {
      expect(errorsFor({ positionBucket: raw })).toBeGreaterThan(0);
    }
  });
});

describe('resolvePositionBucket — 档位与来源标严格成对 (读写共用单点)', () => {
  it('已选 → 档位 + 来源标 manual + 手选时刻三项齐出', () => {
    expect(resolvePositionBucket('gte_two_thirds', T1)).toEqual({
      bucket: 'gte_two_thirds',
      source: 'manual',
      setAt: T1,
    });
  });

  it('🚨 未选 (null) → 三项全 null, MUST NOT 落任何档位 (常驻分支不是过渡态)', () => {
    expect(resolvePositionBucket(null, null)).toEqual({
      bucket: null,
      source: null,
      setAt: null,
    });
  });

  it('列里是脏值 (值域外字符串) → 同未选折叠, 不把脏值当档位透出', () => {
    expect(resolvePositionBucket('half', T1).bucket).toBeNull();
    expect(resolvePositionBucket('half', T1).source).toBeNull();
  });

  it('有档无时刻 (T002 建列未回填的历史行) → 照实回 null 时刻, 不编一个', () => {
    const resolved = resolvePositionBucket('lt_one_third', null);
    expect(resolved.bucket).toBe('lt_one_third');
    expect(resolved.source).toBe('manual');
    expect(resolved.setAt).toBeNull();
  });
});

describe('SetPositionBucketUseCase — 水位手选写端 (FR-017, plan D-UI-5)', () => {
  let m: PrismaMock;
  let useCase: SetPositionBucketUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new SetPositionBucketUseCase(m.prisma);
  });

  it('落档位 + 设置时刻, 回值带 ticker 与来源标', async () => {
    const result = await useCase.execute(ANCHOR_ID, 'one_to_two_thirds', T1);
    const data = m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.positionBucketManual).toBe('one_to_two_thirds');
    expect(data.positionBucketSetAt).toEqual(T1);
    expect(result).toEqual({
      anchorId: ANCHOR_ID,
      ticker: TICKER,
      bucket: 'one_to_two_thirds',
      source: 'manual',
      setAt: T1,
    });
  });

  it('🚨 update 键集恰好 {positionBucketManual, positionBucketSetAt} —— 不碰估值 / 人工位 / 复审列', async () => {
    await useCase.execute(ANCHOR_ID, 'lt_one_third', T1);
    const data = m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['positionBucketManual', 'positionBucketSetAt']);
  });

  it('🚨 蓄意不落 anchor_change 痕迹 (痕迹表是估值口径的 PIT 机制, 水位不在其中)', async () => {
    await useCase.execute(ANCHOR_ID, 'lt_one_third', T1);
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('重复设置**不同档** → 覆盖且时刻前进', async () => {
    const first = await useCase.execute(ANCHOR_ID, 'lt_one_third', T1);
    const second = await useCase.execute(ANCHOR_ID, 'gte_two_thirds', T2);
    expect(first.bucket).toBe('lt_one_third');
    expect(second.bucket).toBe('gte_two_thirds');
    expect(second.setAt!.getTime()).toBeGreaterThan(first.setAt!.getTime());
    expect(m.updateMany).toHaveBeenCalledTimes(2);
  });

  it('🚨 重复设置**同一档** → 时刻照样前进 (记的是「人最后一次确认」, 不是「值变没变」)', async () => {
    const first = await useCase.execute(ANCHOR_ID, 'gte_two_thirds', T1);
    const second = await useCase.execute(ANCHOR_ID, 'gte_two_thirds', T2);
    expect(second.bucket).toBe(first.bucket);
    expect(second.setAt!.getTime()).toBeGreaterThan(first.setAt!.getTime());
    const data = m.updateMany.mock.calls[1]![0].data as Record<string, unknown>;
    expect(data.positionBucketSetAt).toEqual(T2);
  });

  it('锚不存在 → 404 ANCHOR_NOT_FOUND, 一个字段都不写', async () => {
    m = buildPrismaMock(null);
    useCase = new SetPositionBucketUseCase(m.prisma);
    await expect(useCase.execute(ANCHOR_ID, 'lt_one_third', T1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('读写窗内被并发删除 (updateMany count = 0) → 与不存在同折叠 404', async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    await expect(useCase.execute(ANCHOR_ID, 'lt_one_third', T1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('按锚 id 定位单行 (where 恰好是 id, 无第二个谓词)', async () => {
    await useCase.execute(ANCHOR_ID, 'lt_one_third', T1);
    expect(m.updateMany.mock.calls[0]![0].where).toEqual({ id: ANCHOR_ID });
  });
});

describe('toPositionBucketResponse — 详情 DTO 带「人工输入」标 (plan D-UI-5)', () => {
  it('🚨 手选值在响应里带 source = manual (M3 接真实水位时靠它分辨哪些是人填的)', async () => {
    const m = buildPrismaMock();
    const result = await new SetPositionBucketUseCase(m.prisma).execute(
      ANCHOR_ID,
      'gte_two_thirds',
      T1,
    );
    expect(toPositionBucketResponse(result)).toEqual({
      anchorId: '7',
      ticker: TICKER,
      positionBucket: 'gte_two_thirds',
      positionBucketSource: 'manual',
      positionBucketSetAt: '2026-08-04T02:15:00.000Z',
    });
  });

  it('锚 id 以数字串下发 (BigInt 过 JSON 会丢精度)', async () => {
    const m = buildPrismaMock();
    const result = await new SetPositionBucketUseCase(m.prisma).execute(
      9007199254740993n,
      'lt_one_third',
      T1,
    );
    expect(toPositionBucketResponse(result).anchorId).toBe('9007199254740993');
  });
});
