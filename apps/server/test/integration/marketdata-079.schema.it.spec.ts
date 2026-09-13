import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MONO_ROOT = resolve(SERVER_DIR, '../..');

// 079 T008 (FR-013, plan §D3): 财报日期层 4 表 expand-only migration —— migrate deploy 后验
// ① 四表落 marketdata schema ② 各业务唯一键存在且真去重 (period_key 非空, 唯一键不被 NULL 绕过)
// ③ MODEL_OWNERSHIP 登记 4 model 归 marketdata + 护城河 0 违规 ④ optionsdesk 零读口 (FR-022)。
// 纯数据层形态验证 —— 写侧行为 (观测 upsert / 合并 / 流水) 归 T013 / T014。
const TABLES = [
  'earnings_date_event',
  'earnings_date_event_log',
  'earnings_date_observation',
  'earnings_meeting_lag',
] as const;

const ACCESSORS = [
  'earningsDateObservation',
  'earningsDateEvent',
  'earningsDateEventLog',
  'earningsMeetingLag',
] as const;

describe('079 marketdata 财报日期层 schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;
  let instrumentId: bigint;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();

    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00700',
        name: '騰訊控股',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    instrumentId = inst.id;
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.drop();
  });

  const uniqueIndexes = (table: string) =>
    prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'marketdata' AND tablename = $1
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        ORDER BY indexname`,
      table,
    );

  const expectP2002 = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe('P2002');
  };

  it('四表落 marketdata schema', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'marketdata' AND table_name LIKE 'earnings\\_%'
        ORDER BY table_name`,
    );
    // earnings_event (047) 同前缀、与本层并存 (🚫 复用它, D1 / FR-021)。
    expect(rows.map((r) => r.table_name)).toEqual([
      'earnings_date_event',
      'earnings_date_event_log',
      'earnings_date_observation',
      'earnings_event',
      'earnings_meeting_lag',
    ]);
  });

  it('唯一键恰为 plan §D3 所列 (多出一条 = 偷加了唯一维度; 流水 append-only 无业务唯一键)', async () => {
    const got = Object.fromEntries(
      await Promise.all(
        TABLES.map(
          async (t) =>
            [
              t,
              (await uniqueIndexes(t)).map((r) => r.indexdef.replace(/^.*USING btree /, '')),
            ] as const,
        ),
      ),
    );
    expect(got).toEqual({
      earnings_date_event: ['(id)', '(instrument_id, period_key)'],
      earnings_date_event_log: ['(id)'],
      earnings_date_observation: ['(id)', '(source, instrument_id, period_key)'],
      earnings_meeting_lag: ['(id)', '(instrument_id, report_kind)'],
    });
  });

  it('period_key 非空 (唯一键不被 NULL 绕过, migration-rules §4)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string; is_nullable: string }[]>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'marketdata' AND column_name = 'period_key'
          AND table_name IN ('earnings_date_observation', 'earnings_date_event')
        ORDER BY table_name`,
    );
    expect(rows).toEqual([
      { table_name: 'earnings_date_event', is_nullable: 'NO' },
      { table_name: 'earnings_date_observation', is_nullable: 'NO' },
    ]);
  });

  it('观测唯一键 (source, instrument_id, period_key): 同来源同期撞 P2002, 异来源同期可并存', async () => {
    const base = {
      instrumentId,
      periodKey: 'P:2026-06-30',
      market: 'hk',
      reportKind: 'interim',
      basis: 'meeting',
      meetingDate: new Date('2026-08-12T00:00:00Z'),
    };
    await prisma.earningsDateObservation.create({
      data: { ...base, source: 'hkex_board_meeting_list' },
    });
    await expectP2002(
      prisma.earningsDateObservation.create({
        data: {
          ...base,
          source: 'hkex_board_meeting_list',
          meetingDate: new Date('2026-08-13T00:00:00Z'),
        },
      }),
    );
    await prisma.earningsDateObservation.create({
      data: {
        ...base,
        source: 'futu_calendar',
        basis: 'structured',
        announceDate: new Date('2026-08-12T00:00:00Z'),
      },
    });
    expect(
      await prisma.earningsDateObservation.count({
        where: { instrumentId, periodKey: base.periodKey },
      }),
    ).toBe(2);
  });

  it('事件唯一键 (instrument_id, period_key) + revision 默认 0 + 流水挂事件', async () => {
    const ev = await prisma.earningsDateEvent.create({
      data: {
        instrumentId,
        periodKey: 'P:2026-06-30',
        market: 'hk',
        status: 'notified_undated',
        sources: [],
      },
    });
    expect(ev.revision).toBe(0);
    await expectP2002(
      prisma.earningsDateEvent.create({
        data: {
          instrumentId,
          periodKey: 'P:2026-06-30',
          market: 'hk',
          status: 'confirmed',
          sources: ['futu_calendar'],
        },
      }),
    );
    await prisma.earningsDateEventLog.create({
      data: {
        eventId: ev.id,
        kind: 'status_change',
        fromStatus: null,
        toStatus: 'notified_undated',
      },
    });
    expect(await prisma.earningsDateEventLog.count({ where: { eventId: ev.id } })).toBe(1);
  });

  it('间隔唯一键 (instrument_id, report_kind): 同类报告只存最近一次', async () => {
    const data = {
      instrumentId,
      reportKind: 'interim',
      lagDays: 0,
      observedAt: new Date('2026-08-12T10:00:00Z'),
    };
    await prisma.earningsMeetingLag.create({ data });
    await expectP2002(prisma.earningsMeetingLag.create({ data: { ...data, lagDays: 1 } }));
    await prisma.earningsMeetingLag.create({ data: { ...data, reportKind: 'annual' } });
    expect(await prisma.earningsMeetingLag.count({ where: { instrumentId } })).toBe(2);
  });

  it('MODEL_OWNERSHIP 登记 4 model 归 marketdata + check-server-moat 0 违规', () => {
    // ⚠️ 诚实标注: 护城河 Check 1 只扫**被 src/** 访问**的 model —— 本 task 尚无读写者 (T011 / T013
    // 起才有), 故「漏登记 ⇒ moat 红」此刻不会由脚本本身体现。登记断言按源码文本钉住, 不依赖访问面。
    const moatSrc = readFileSync(join(MONO_ROOT, 'scripts/checks/check-server-moat.ts'), 'utf8');
    for (const accessor of ACCESSORS) {
      expect(moatSrc, `${accessor} 未在 MODEL_OWNERSHIP 登记为 marketdata`).toMatch(
        new RegExp(`^\\s*${accessor}: 'marketdata',`, 'm'),
      );
    }
    expect(() =>
      execFileSync('pnpm', ['tsx', 'scripts/checks/check-server-moat.ts'], {
        cwd: MONO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);

  it('FR-022 optionsdesk 零读口: src/optionsdesk 下不出现 4 表的任何 accessor', () => {
    const dir = join(SERVER_DIR, 'src/optionsdesk');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    // 正向计数: 目录真被扫到 (空目录 / 路径错时下面的否定断言会平凡成立)。
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      return ACCESSORS.some((a) => src.includes(`.${a}.`));
    });
    expect(hits).toEqual([]);
  });
});
