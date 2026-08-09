import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyMultipart from '@fastify/multipart';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  buildHoldingsXlsx,
  FIXTURE_HOLDING_ROWS,
  FIXTURE_TRADE_ROWS,
} from '../../src/portfolio/__fixtures__/build-holdings-xlsx';
import { SHEET_CLOSED, type CellValue } from '../../src/portfolio/holdings-import.rules';
import type { ImportSummaryResponse } from '../../src/portfolio/import-summary.response';

const ASOF = '2026-06-06';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 025 T008 全 boot IT — EP1/EP2/EP3 + 持仓组派生 (覆盖 spec state_branches server 条目):
//  ① 导入成功摘要↔库内逐表一致 (SC-001 数据面, quotable 批查落值)
//  ② 幂等重导 0 差异 (SC-002, 业务字段快照逐表深等)
//  ③ 非法文件 (非 xlsx / 不可解析 / 缺 sheet) → 422 整体拒绝库不变
//  ④ 超 2MB → 413 (multipart limits 层) 库不变
//  ⑤ 行级容错摘要可追溯 (SC-005: 汇总行跳过 / `--` 落 null / 未知类别 warning)
//  ⑥ 持仓组派生闭环 (SC-003: 导入→组员 quotable∧qty>0、清空持仓→组员清空)
//  ⑦ 清仓后重建仓并存 (国茂股份 current + closed 双在, EP2 wire)
//  ⑧ EP3 等值倒序 + 资金行不命中 (wire)
//  EP1 401 反枚举 / EP1 429 (6/60s) / EP2·EP3 401。
// multipart 注册镜像 main.ts (limits 2MB / 1 file); beforeEach flushall 隔离限流桶。
describe('025 portfolio-holdings (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'portfolio-holdings-t008-jwt-secret-min-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'portfolio-holdings-t008-hmac-secret-min-32';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, PortfolioModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // 镜像 main.ts: multipart limits 即 DoS 防线 (单文件 ≤2MB / 每请求 1 文件)。
    await app.register(fastifyMultipart, {
      limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);

    // fixture 两只注册 marketdata.instrument (quotable=true); GC001 故意不注册。
    await prisma.instrument.createMany({
      data: (
        [
          ['603915', '国茂股份'],
          ['601177', '杭齿前进'],
        ] as const
      ).map(([code, name]) => ({
        market: 'cn',
        code,
        name,
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      })),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall(); // 隔离限流桶
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613825${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const BOUNDARY = '----t008portfolioholdings';
  /** 手搭 multipart body (asOf 文本字段在前, file part 在后)。 */
  function multipartBody(
    file: { filename: string; mime: string; data: Buffer } | null,
    fields: Record<string, string> = {},
  ): Buffer {
    const chunks: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
      );
    }
    if (file) {
      chunks.push(
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
            `Content-Type: ${file.mime}\r\n\r\n`,
        ),
      );
      chunks.push(file.data, Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
  }

  const importXlsx = (
    token: string,
    data: Buffer,
    opts: { filename?: string; mime?: string; asOf?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/holdings/import',
      headers: {
        ...auth(token),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        { filename: opts.filename ?? 'holdings.xlsx', mime: opts.mime ?? XLSX_MIME, data },
        { asOf: opts.asOf ?? ASOF },
      ),
    });

  const getHoldings = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/portfolio/holdings', headers: auth(token) });
  const getTrades = (token: string, market: string, code: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/portfolio/trades?market=${market}&code=${code}`,
      headers: auth(token),
    });
  const getGroupItems = (token: string, groupId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}/items`,
      headers: auth(token),
    });

  const summaryOf = (res: { json: () => unknown }) => res.json() as ImportSummaryResponse;

  /** 三表业务字段快照 (剔自增 id / createdAt; Decimal/Date/bigint 统一字符串化)。 */
  async function tableSnapshot(accountId: bigint) {
    const norm = (rows: Record<string, unknown>[]) =>
      rows.map((r) => {
        const { id, createdAt, ...rest } = r;
        void id;
        void createdAt;
        return Object.fromEntries(
          Object.entries(rest).map(([k, v]) => [
            k,
            v === null ? null : v instanceof Date ? v.toISOString() : String(v),
          ]),
        );
      });
    const [h, c, t] = await Promise.all([
      prisma.holding.findMany({ where: { accountId }, orderBy: { code: 'asc' } }),
      prisma.closedPosition.findMany({
        where: { accountId },
        orderBy: [{ code: 'asc' }, { closeDate: 'asc' }],
      }),
      prisma.tradeRecord.findMany({
        where: { accountId },
        orderBy: [{ tradeDate: 'asc' }, { amount: 'asc' }],
      }),
    ]);
    return {
      holdings: norm(h as unknown as Record<string, unknown>[]),
      closed: norm(c as unknown as Record<string, unknown>[]),
      trades: norm(t as unknown as Record<string, unknown>[]),
    };
  }

  /** 27 列持仓行 (code/name/仓位占比/持有数量/单位成本), 其余空。 */
  function holdingRow(code: string, name: string, weight: string, qty: string): CellValue[] {
    const row: CellValue[] = Array.from({ length: 27 }, () => '');
    row[0] = code;
    row[1] = name;
    row[16] = weight;
    row[17] = qty;
    row[21] = '10';
    return row;
  }

  // ── ① 导入成功: 摘要 ↔ 库内逐表一致 (SC-001) ──────────────────────────────
  it('① 导入成功 → 摘要与库内逐表一致 + quotable 批查落值 (SC-001)', async () => {
    const { id, token } = await activeToken();
    const res = await importXlsx(token, await buildHoldingsXlsx());
    expect(res.statusCode).toBe(200);

    const summary = summaryOf(res);
    expect(summary.asOf).toBe(ASOF);
    expect(summary.holdings.imported).toBe(2);
    expect(summary.holdings.skipped).toEqual([{ row: 3, reason: '「汇总」聚合行' }]);
    expect(summary.closed.imported).toBe(1);
    expect(summary.closed.skipped).toEqual([]);
    expect(summary.trades.imported).toBe(4);
    expect(summary.trades.skipped).toEqual([]);

    // 摘要数字 ↔ 库内行数逐表一致
    expect(await prisma.holding.count({ where: { accountId: id } })).toBe(2);
    expect(await prisma.closedPosition.count({ where: { accountId: id } })).toBe(1);
    expect(await prisma.tradeRecord.count({ where: { accountId: id } })).toBe(4);

    // quotable: 两只均已注册 instrument → true; asOf 落表
    const rows = await prisma.holding.findMany({
      where: { accountId: id },
      orderBy: { code: 'asc' },
    });
    expect(rows.map((r) => [r.code, r.quotable])).toEqual([
      ['601177', true],
      ['603915', true],
    ]);
    expect(rows[0]!.asOf.toISOString().slice(0, 10)).toBe(ASOF);
  });

  // ── ② 幂等重导 0 差异 (SC-002) ────────────────────────────────────────────
  it('② 同一文件重导 → 摘要一致 + 三表业务字段快照 0 差异 (SC-002)', async () => {
    const { id, token } = await activeToken();
    const file = await buildHoldingsXlsx();

    const first = await importXlsx(token, file);
    expect(first.statusCode).toBe(200);
    const snapshot1 = await tableSnapshot(id);

    const second = await importXlsx(token, file);
    expect(second.statusCode).toBe(200);
    expect(summaryOf(second)).toEqual(summaryOf(first));
    expect(await tableSnapshot(id)).toEqual(snapshot1);
  });

  // ── ③ 非法文件 → 422 整体拒绝库不变 ───────────────────────────────────────
  it('③ 非 xlsx 扩展 / 不可解析内容 / 缺 sheet → 422 + 库保持导入前状态', async () => {
    const { id, token } = await activeToken();
    expect((await importXlsx(token, await buildHoldingsXlsx())).statusCode).toBe(200);
    const baseline = await tableSnapshot(id);

    // 非 xlsx 扩展 (mimetype 容忍 octet-stream, 扩展必须 .xlsx)
    const wrongExt = await importXlsx(token, Buffer.from('plain text'), {
      filename: 'holdings.csv',
      mime: 'text/csv',
    });
    expect(wrongExt.statusCode).toBe(422);
    expect((wrongExt.json() as { code: string }).code).toBe('HOLDINGS_FILE_INVALID');

    // 扩展对但内容不可解析
    const corrupt = await importXlsx(token, Buffer.from('not a real xlsx payload'));
    expect(corrupt.statusCode).toBe(422);
    expect((corrupt.json() as { code: string }).code).toBe('HOLDINGS_FILE_INVALID');

    // 缺必要 sheet (已清仓)
    const missingSheet = await importXlsx(
      token,
      await buildHoldingsXlsx({ omitSheets: [SHEET_CLOSED] }),
    );
    expect(missingSheet.statusCode).toBe(422);
    expect((missingSheet.json() as { code: string; detail: string }).detail).toContain(
      SHEET_CLOSED,
    );

    expect(await tableSnapshot(id)).toEqual(baseline); // 三连拒后库不变
  });

  // ── ④ 超 2MB → 413 (multipart limits 层) ──────────────────────────────────
  it('④ 文件超 2MB → 413 + 库保持导入前状态', async () => {
    const { id, token } = await activeToken();
    expect((await importXlsx(token, await buildHoldingsXlsx())).statusCode).toBe(200);
    const baseline = await tableSnapshot(id);

    const oversize = await importXlsx(token, Buffer.alloc(2 * 1024 * 1024 + 16, 1));
    expect(oversize.statusCode).toBe(413);
    expect(await tableSnapshot(id)).toEqual(baseline);
  });

  // ── ⑤ 行级容错摘要可追溯 (SC-005) ─────────────────────────────────────────
  it('⑤ 行级容错: `--` 落 null / 汇总行跳过留痕 / 未知交易类别 warning 可追溯 (SC-005)', async () => {
    const { id, token } = await activeToken();
    const res = await importXlsx(
      token,
      await buildHoldingsXlsx({
        tradeRows: [
          ...FIXTURE_TRADE_ROWS,
          // prettier-ignore
          ['2026-05-13', '10:00:00', '603915', '国茂股份', '神秘操作', '100', '10',
            '-1000', '1000', '1', ''],
        ],
      }),
    );
    expect(res.statusCode).toBe(200);

    const summary = summaryOf(res);
    // 汇总聚合行: 跳过 + 行号可追溯 (1-based 数据行序)
    expect(summary.holdings.skipped).toEqual([{ row: 3, reason: '「汇总」聚合行' }]);
    // 未知交易类别: 行入库但 warning 留痕 (行号 + 原文)
    expect(summary.trades.imported).toBe(5);
    expect(summary.trades.warnings).toEqual(['第 5 行: 未知交易类别「神秘操作」按 unknown 入库']);
    const unknownRow = await prisma.tradeRecord.findFirst({
      where: { accountId: id, category: 'unknown' },
    });
    expect(unknownRow?.code).toBe('603915');

    // `--` 字段 (601177 累计盈亏) 按空处理入库
    const dirty = await prisma.holding.findFirst({ where: { accountId: id, code: '601177' } });
    expect(dirty?.cumPnl).toBeNull();
    expect(dirty?.cumPnlPct).toBeNull();
  });

  // ── ⑥ 持仓组派生闭环 (SC-003) ─────────────────────────────────────────────
  it('⑥ 导入→组员 (quotable∧qty>0, GC001 不进组); 清空持仓→组员清空 (SC-003)', async () => {
    const { token } = await activeToken();
    const withGc001 = await buildHoldingsXlsx({
      holdingRows: [...FIXTURE_HOLDING_ROWS, holdingRow('GC001', '国债逆回购', '0.05', '10000')],
    });
    expect((await importXlsx(token, withGc001)).statusCode).toBe(200);

    // 组员 = quotable 持仓集合 (weightPct desc); GC001 未注册 instrument → 不进组
    const items1 = (await getGroupItems(token, 'holdings').then((r) => r.json())) as {
      items: Array<{ code: string }>;
    };
    expect(items1.items.map((i) => i.code)).toEqual(['601177', '603915']); // 0.66 > 0.16

    // GC001 在持仓列表降级展示 (quotable=false 照常返回)
    const holdings = (await getHoldings(token).then((r) => r.json())) as {
      current: Array<{ code: string; quotable: boolean }>;
    };
    expect(holdings.current.find((h) => h.code === 'GC001')?.quotable).toBe(false);

    // 清空持仓 (持仓 sheet 无有效数据行) → 组员清空, 已清仓/流水照常替换
    expect((await importXlsx(token, await buildHoldingsXlsx({ holdingRows: [] }))).statusCode).toBe(
      200,
    );
    const items2 = (await getGroupItems(token, 'holdings').then((r) => r.json())) as {
      items: unknown[];
    };
    expect(items2.items).toEqual([]);
    const empty = (await getHoldings(token).then((r) => r.json())) as {
      asOf: string | null;
      current: unknown[];
      closed: unknown[];
    };
    expect(empty.asOf).toBeNull();
    expect(empty.current).toEqual([]);
    expect(empty.closed).toHaveLength(1); // 已清仓照常入库
  });

  // ── ⑦ 清仓后重建仓并存 (EP2 wire) ─────────────────────────────────────────
  it('⑦ EP2: 同标的已清仓历史与当前持仓并存 (国茂股份双在) + asOf 回显', async () => {
    const { token } = await activeToken();
    expect((await importXlsx(token, await buildHoldingsXlsx())).statusCode).toBe(200);

    const res = await getHoldings(token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      asOf: string | null;
      current: Array<{ code: string; name: string }>;
      closed: Array<{ code: string; closeDate: string }>;
    };
    expect(body.asOf).toBe(ASOF);
    // 国茂股份 2026-05-11 清仓后重建仓: current 与 closed 双在
    expect(body.current.map((h) => h.code)).toContain('603915');
    expect(body.closed).toEqual([
      expect.objectContaining({ code: '603915', closeDate: '2026-05-11' }),
    ]);
  });

  // ── ⑧ EP3: 等值倒序 + 资金行不命中 (wire) ─────────────────────────────────
  it('⑧ EP3: 标的流水等值倒序, 资金行 (code null) 不命中', async () => {
    const { token } = await activeToken();
    expect((await importXlsx(token, await buildHoldingsXlsx())).statusCode).toBe(200);

    const res = await getTrades(token, 'cn', '603915');
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as {
      items: Array<{ tradeDate: string; category: string }>;
    };
    // 流水 4 行中资金行 (其他, 无代码) 不命中 → 3 行, 成交时间倒序
    expect(items.map((t) => [t.tradeDate, t.category])).toEqual([
      ['2026-05-11', 'sell'],
      ['2025-10-23', 'xd'],
      ['2025-08-27', 'buy'],
    ]);
  });

  // ── 认证: EP1 反枚举 401 / EP2·EP3 401 ────────────────────────────────────
  it('EP1: 未认证 vs 非 ACTIVE → 均 401 字节级一致 (反枚举)', async () => {
    const frozen = await prisma.account.create({ data: { phone: nextPhone(), status: 'FROZEN' } });
    const frozenToken = jwt.signAccessToken({ accountId: frozen.id });
    const file = await buildHoldingsXlsx();

    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/holdings/import',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody({ filename: 'holdings.xlsx', mime: XLSX_MIME, data: file }),
    });
    const nonActive = await importXlsx(frozenToken, file);
    expect(noAuth.statusCode).toBe(401);
    expect(nonActive.statusCode).toBe(401);
    const strip = (raw: string) => {
      const { traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      return rest;
    };
    expect(strip(noAuth.body)).toEqual(strip(nonActive.body));
  });

  it('EP2/EP3: 未认证 → 401', async () => {
    const ep2 = await app.inject({ method: 'GET', url: '/api/v1/portfolio/holdings' });
    const ep3 = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio/trades?market=cn&code=603915',
    });
    expect(ep2.statusCode).toBe(401);
    expect(ep3.statusCode).toBe(401);
  });

  // ── 限流: EP1 第 7 次 → 429 (named 桶 6/60s) ──────────────────────────────
  it('EP1 限流: 第 7 次导入 → 429 (portfolio-import-account 6/60s)', async () => {
    const { token } = await activeToken();
    const file = await buildHoldingsXlsx();
    let last;
    for (let i = 0; i < 7; i += 1) last = await importXlsx(token, file);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
