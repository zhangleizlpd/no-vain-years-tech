import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { REDIS_CLIENT } from '../security/redis.token';
import { buildOpenApiConfig } from '../openapi.config';
import { OptionsdeskModule } from './optionsdesk.module';
import { CreateAnchorUseCase } from './create-anchor.usecase';
import { UpdateAnchorUseCase } from './update-anchor.usecase';
import { DeleteAnchorUseCase } from './delete-anchor.usecase';
import { ReviewAnchorUseCase } from './review-anchor.usecase';
import { ListAnchorsUseCase, toAnchorView } from './list-anchors.usecase';
import { GetAnchorUseCase } from './get-anchor.usecase';
import { GetAnchorAtUseCase } from './get-anchor-at.usecase';
import { GetLegsUseCase, type LegTableView } from './get-legs.usecase';
import { GetChainReportUseCase, type ChainReportView } from './get-chain-report.usecase';
import { GetRadarUseCase } from './get-radar.usecase';
import { aggregateCell, chainReportGateCounts, chainReportRows } from './chain-report.rules';
import { DISPLAY_LIMIT_BY_PERSPECTIVE } from './leg-rank.rules';
import { RETRIEVAL_CRITERION_KEYS, type PerspectiveCriteria } from './leg-recall.rules';
import { PRICE_KINDS, type PriceKind } from '../marketdata/marketdata.types';
import type { LegView } from './get-legs.usecase';

// boot-time zod 校验的最小 env 集 (与 alert-crud.it.spec.ts 同口径)。必须在 Nest 编译前落位:
// SecurityModule 的 ConfigModule.forRoot 在模块实例化时 .parse()。DB / Redis 均不真连 ——
// PrismaService 懒连接; ioredis 连不上只在后台重试 (silentEmit), 不影响本 spec。
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test_optionsdesk';
process.env.AUTH_JWT_SECRET ??= 'optionsdesk-045-t010-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-045-t010-hmac-secret-min-32-bytes';
// 本地 shell 常泄漏 MARKETDATA_PROVIDER=live (dev 行情) 与 OSS_* 部署凭据 → 两者的 config
// 分支要求整组 env 齐备, 缺一个就在 boot 期 ZodError (CI 环境干净, 只有本地中招)。本 spec
// 既不取行情也不传对象存储 ⇒ 强制归零, 保证本地/CI 同结果。
process.env.MARKETDATA_PROVIDER = 'mock';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 045 T010 — controller / DTO / swagger 契约 IT。
 *
 * 🚨 **NO LIFECYCLE MOCKING** (plan Testing Invariants): 整个 `OptionsdeskModule` 经
 * `Test.createTestingModule({ imports: [...] }).compile()` 装进**真 DI 容器** —— `JwtAuthGuard`
 * / `AccountIdThrottlerGuard` / `ProblemDetailFilter` / `ValidationPipe` 全部在真实
 * lifecycle 顺序 (Guards → Interceptors → Pipes → Controller → Filters) 里跑, **没有一个**
 * 被 `new XxxGuard()` 或 `.overrideGuard()` 抹掉。只有**数据边界**被替换:
 * `PrismaService` (鉴权查账号) + 7 个 usecase (业务已在各自 spec 覆盖) —— 本 spec 的验证面是
 * 「通道层: 路由 / 鉴权 / DTO 形状 / 参数解析 / 状态码」。真落库行为归 T011 IT。
 */
const ACCOUNT_ID = 99n;

/** V=50 ⇒ W=40、内段下界 30 (系数见 anchor.rules); spot 36 = 买区。 */
const anchorRow = {
  id: 7n,
  ticker: 'us:AOS',
  v: new Prisma.Decimal('50'),
  asof: new Date('2026-06-30T00:00:00Z'),
  method: 'dcf',
  confidence: new Prisma.Decimal('8'),
  confidenceSource: 'manual',
  excluded: true,
  excludeReason: '暂不交易',
  nextReview: new Date('2026-07-15T00:00:00Z'),
  lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L2',
  lastClose: new Prisma.Decimal('36'),
  lastCloseDate: new Date('2026-08-01T00:00:00Z'),
  // 061: 盘中两列空 = 还没经历过任何盘中采集 ⇒ 恒收盘档 (本文件只验通道层契约, 不验档位判据)。
  intradayPrice: null,
  intradayAt: null,
  breachStartedOn: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-07-20T00:00:00Z'),
};

const writeResult = { ...anchorRow, overdueAgainstAsof: false };

describe('OptionsdeskController — 通道层契约 (FR-001 / FR-004 / FR-005 / FR-009)', () => {
  let app: NestFastifyApplication;
  let document: OpenAPIObject;
  let token: string;

  const createExecute = vi.fn();
  const updateExecute = vi.fn();
  const deleteExecute = vi.fn();
  const reviewExecute = vi.fn();
  const listExecute = vi.fn();
  const getExecute = vi.fn();
  const atExecute = vi.fn();
  const legsExecute = vi.fn();
  const chainReportExecute = vi.fn();
  const radarExecute = vi.fn();

  beforeAll(async () => {
    const prismaStub = {
      account: {
        findUnique: vi.fn().mockResolvedValue({
          id: ACCOUNT_ID,
          phone: '+8613800138000',
          status: 'ACTIVE',
        }),
      },
    };

    // 数据边界之二：Redis。不替换的话 SecurityModule 会真的 `new Redis(url)` 并开 socket ——
    // 本 spec 的验证面是通道层（路由 / 鉴权 / DTO），限流存储不在其中。
    const redisStub = { call: vi.fn(), quit: vi.fn(), on: vi.fn(), status: 'ready' };

    const moduleRef = await Test.createTestingModule({
      imports: [
        OptionsdeskModule,
        // 真 app 的全局 ThrottlerModule 注册在 AuthModule (storage 跨 controller 共享);
        // 本 spec 不引 AuthModule, 故在此给同形态的最小注册, 让两个 Guard 能真实解析。
        ThrottlerModule.forRoot({ throttlers: [{ limit: 1_000, ttl: 60_000 }] }),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisStub)
      .overrideProvider(CreateAnchorUseCase)
      .useValue({ execute: createExecute })
      .overrideProvider(UpdateAnchorUseCase)
      .useValue({ execute: updateExecute })
      .overrideProvider(DeleteAnchorUseCase)
      .useValue({ execute: deleteExecute })
      .overrideProvider(ReviewAnchorUseCase)
      .useValue({ execute: reviewExecute })
      .overrideProvider(ListAnchorsUseCase)
      .useValue({ execute: listExecute })
      .overrideProvider(GetAnchorUseCase)
      .useValue({ execute: getExecute })
      .overrideProvider(GetAnchorAtUseCase)
      .useValue({ execute: atExecute })
      .overrideProvider(GetLegsUseCase)
      .useValue({ execute: legsExecute })
      .overrideProvider(GetChainReportUseCase)
      .useValue({ execute: chainReportExecute })
      // 065 T09: 此前**没有** override —— 本文件零条 radar 用例, 真 use case 拿 prismaStub
      // (只有 account.findUnique) 一跑就炸。加了 radar 断言就必须同时把它换掉。
      .overrideProvider(GetRadarUseCase)
      .useValue({ execute: radarExecute })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    // 与 main.ts 同形态 (transform + whitelist) —— 查询串布尔转换与 body 白名单都靠它。
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    document = SwaggerModule.createDocument(app, buildOpenApiConfig());
    token = app.get(JwtService).sign({ sub: ACCOUNT_ID.toString() });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listExecute.mockResolvedValue([toAnchorView(anchorRow, null)]);
    getExecute.mockResolvedValue(toAnchorView(anchorRow, null));
    createExecute.mockResolvedValue(writeResult);
    updateExecute.mockResolvedValue(writeResult);
    reviewExecute.mockResolvedValue(writeResult);
    deleteExecute.mockResolvedValue(undefined);
    atExecute.mockResolvedValue(null);
    legsExecute.mockResolvedValue(emptyLegTable());
    chainReportExecute.mockResolvedValue(chainReport());
    radarExecute.mockResolvedValue(radarPage());
  });

  const authed = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  describe('鉴权 (FR-009 沿用现有鉴权, 零新对外服务化面)', () => {
    it('无 Bearer → 401, usecase 不被调用 (真 JwtAuthGuard 在真 lifecycle 里拦)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/optionsdesk/anchors' });
      expect(res.statusCode).toBe(401);
      expect(listExecute).not.toHaveBeenCalled();
    });

    it('错误 token → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('有效 token → 放行', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /anchors — 列表 + 筛选 (Guardrail 12 / FR-004 / FR-005)', () => {
    it('🚨 默认不带 excluded 条件 ⇒ 被排除的锚照常在列表 (与雷达态度相反)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
      });
      expect(listExecute).toHaveBeenCalledWith({ pendingReview: undefined, excluded: undefined });
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.items[0].excluded).toBe(true);
      expect(body.items[0].excludeReason).toBe('暂不交易');
    });

    it('?pendingReview=true → 查询串转真布尔传进 usecase (待复审清单)', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors?pendingReview=true',
        headers: authed(),
      });
      expect(listExecute).toHaveBeenCalledWith({ pendingReview: true, excluded: undefined });
    });

    it('?excluded=false → 只看未排除 (false 不被当成 undefined)', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors?excluded=false',
        headers: authed(),
      });
      expect(listExecute).toHaveBeenCalledWith({ pendingReview: undefined, excluded: false });
    });

    it('列表项含全部同屏派生值 (W / 四区间 / 愿卖锚 / 距 W% / 区间归属)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
      });
      const item = res.json().items[0];
      expect(item.w).toBe('40.0000');
      expect(item.zoneFloor).toBe('30.0000');
      expect(item.zone).toBe('buy');
      expect(item.distanceToWPct).toBe('-10.00');
      expect(item.lLevelEffective).toBe('L2');
      expect(item.positionCap).toBe('0.0500');
      expect(item.derivedLLevel).toBe('L2');
    });

    it('金融数值一律 string (禁 Float 精度损失), id 为数字串', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
      });
      const item = res.json().items[0];
      for (const key of ['v', 'vModel', 'w', 'lastClose', 'confidence', 'id']) {
        expect(typeof item[key]).toBe('string');
      }
    });
  });

  describe('POST /anchors — 建锚', () => {
    it('201 + 同屏返回派生值; 三处人工态标记均 false', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
        payload: {
          ticker: 'us:AOS',
          v: '50.0000',
          asof: '2026-06-30',
          method: 'dcf',
          confidence: '8.00',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.vIsManual).toBe(false);
      expect(body.lLevelIsManual).toBe(false);
      expect(body.positionCapIsManual).toBe(false);
      expect(createExecute.mock.calls[0]![0].asof).toEqual(new Date('2026-06-30'));
    });

    it('缺必填字段 → 400 FORM_VALIDATION, usecase 不被调用 (真 ValidationPipe)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/optionsdesk/anchors',
        headers: authed(),
        payload: { ticker: 'us:AOS' },
      });
      expect(res.statusCode).toBe(400);
      expect(createExecute).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /anchors/{id} — 改锚 + 撤销人工位 (FR-032 ③)', () => {
    it('人工位传 null → patch 带 null (撤销), 不被 ?? 吞成 undefined', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/optionsdesk/anchors/7',
        headers: authed(),
        payload: { lLevelManual: null, positionCapManual: null },
      });
      expect(updateExecute).toHaveBeenCalledWith(7n, {
        lLevelManual: null,
        positionCapManual: null,
      });
    });

    it('未提交的字段不进 patch (不整行覆盖)', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/optionsdesk/anchors/7',
        headers: authed(),
        payload: { confidence: '7.50' },
      });
      expect(updateExecute).toHaveBeenCalledWith(7n, { confidence: '7.50' });
    });

    it('非数字 id → 404 (与不存在不可区分)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/optionsdesk/anchors/abc',
        headers: authed(),
        payload: { method: 'dcf' },
      });
      expect(res.statusCode).toBe(404);
      expect(updateExecute).not.toHaveBeenCalled();
    });
  });

  describe('POST /anchors/{id}/review — 复审 (FR-007 / FR-013)', () => {
    it('推进日期 → 200 且日期串转 Date 传进 usecase', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/optionsdesk/anchors/7/review',
        headers: authed(),
        payload: { nextReview: '2026-11-02' },
      });
      expect(res.statusCode).toBe(200);
      expect(reviewExecute).toHaveBeenCalledWith(7n, new Date('2026-11-02'));
    });

    it('nextReview 显式 null → 允许 (本次不排下次复审)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/optionsdesk/anchors/7/review',
        headers: authed(),
        payload: { nextReview: null },
      });
      expect(res.statusCode).toBe(200);
      expect(reviewExecute).toHaveBeenCalledWith(7n, null);
    });

    it('缺 nextReview → 400 (服务端不自造复审周期默认值, FR-030)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/optionsdesk/anchors/7/review',
        headers: authed(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(reviewExecute).not.toHaveBeenCalled();
    });

    it('🚨 FR-013 只有一个解除动作: 无第二个确认端点 (confirm / ack 一律 404)', async () => {
      for (const url of [
        '/api/v1/optionsdesk/anchors/7/confirm',
        '/api/v1/optionsdesk/anchors/7/acknowledge',
      ]) {
        const res = await app.inject({ method: 'POST', url, headers: authed(), payload: {} });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe('DELETE /anchors/{id} 与 GET /anchors/{id}/at', () => {
    it('删锚 → 204 无 body', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/optionsdesk/anchors/7',
        headers: authed(),
      });
      expect(res.statusCode).toBe(204);
      expect(deleteExecute).toHaveBeenCalledWith(7n);
    });

    it('PIT 时点早于建锚 (usecase 返 null) → 404, 不返半截快照', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors/7/at?at=2026-01-01T00:00:00.000Z',
        headers: authed(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('PIT 命中 → 返当时的 V / W / L 层 / 上限 / 愿卖锚 (SC-011)', async () => {
      atExecute.mockResolvedValue({
        v: new Prisma.Decimal('50'),
        w: new Prisma.Decimal('40'),
        lLevel: 'L2',
        positionCap: new Prisma.Decimal('0.05'),
        willingSell: { longHold: new Prisma.Decimal('60'), rent: new Prisma.Decimal('50') },
        vIsManual: false,
        lLevelIsManual: false,
        positionCapIsManual: false,
        derived: { lLevel: 'L2', positionCap: new Prisma.Decimal('0.05') },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors/7/at?at=2026-07-01T00:00:00.000Z',
        headers: authed(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ v: '50.0000', w: '40.0000', lLevel: 'L2' });
      expect(atExecute).toHaveBeenCalledWith(7n, new Date('2026-07-01T00:00:00.000Z'));
    });

    it('缺 at 查询串 → 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/anchors/7/at',
        headers: authed(),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * 053 T001 —— `perspective` 升为「决定返回哪个视角」(FR-001, plan D-API-1)。
   *
   * 🚨 **必须走真 DI 容器**: 判 400 的是 `ValidationPipe` + `@IsIn`, 不是 controller 里的一行
   * `if` —— 隔离单测那个管道压根不跑, 断言会绿在一条从未执行的路径上 (plan Testing Invariants
   * 「新增的查询参数校验若落 ValidationPipe, 其测试必须走 DI 容器」)。
   */
  describe('GET /underlyings/{symbol}/legs — perspective 必填 (053 FR-001)', () => {
    const legsUrl = (query = '') =>
      `/api/v1/optionsdesk/underlyings/us:AOS/legs${query === '' ? '' : `?${query}`}`;

    it('🚨 缺 perspective → 400, usecase **不被调用** (服务端 MUST NOT 替你挑一个默认视角)', async () => {
      const res = await app.inject({ method: 'GET', url: legsUrl(), headers: authed() });
      expect(res.statusCode).toBe(400);
      expect(legsExecute).not.toHaveBeenCalled();
    });

    it('取值不在三视角内 → 400 (枚举由 @IsIn 守, controller 里不再判第二遍)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: legsUrl('perspective=everything'),
        headers: authed(),
      });
      expect(res.statusCode).toBe(400);
      expect(legsExecute).not.toHaveBeenCalled();
    });

    it('三个取值各自透传给 usecase —— 第二个入参就是本次要作答的视角', async () => {
      for (const perspective of ['all', 'build', 'rent'] as const) {
        legsExecute.mockClear();
        const res = await app.inject({
          method: 'GET',
          url: legsUrl(`perspective=${perspective}`),
          headers: authed(),
        });
        expect([perspective, res.statusCode]).toEqual([perspective, 200]);
        // 🚨 末位那个 `true` 是 064 `FR-015` 的**唯一机器判据**: 实时档由**调用点**显式打开,
        // 🚫 MUST NOT 由 use case 按鉴权状态 / 请求来源推断。改成 `expect.anything()` 就等于
        // 把这条断言作废 —— 那时 use case 自己偷偷推断出来的 `true` 照样让它绿。
        expect(legsExecute).toHaveBeenCalledWith(
          'us:AOS',
          perspective,
          undefined,
          null,
          undefined,
          true,
        );
      }
    });

    it('🚨 只给 perspective 不给条件 ⇒ 覆盖为 null (首屏 / 「复位」走的就是这条)', async () => {
      await app.inject({ method: 'GET', url: legsUrl('perspective=rent'), headers: authed() });
      expect(legsExecute).toHaveBeenCalledWith('us:AOS', 'rent', undefined, null, undefined, true);
    });

    it('给了条件 ⇒ 覆盖落在**同一个**视角上 (052 FR-015 一字不改)', async () => {
      await app.inject({
        method: 'GET',
        url: legsUrl('perspective=rent&strikeMax=138'),
        headers: authed(),
      });
      const override = legsExecute.mock.calls[0][3];
      expect(override.perspective).toBe('rent');
      expect(override.criteria.strikeMax.toString()).toBe('138');
    });
  });

  describe('OpenAPI 文档 (swagger 装饰器 = API 唯一 SoT)', () => {
    it('7 个端点全部出现在文档里', () => {
      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/optionsdesk/anchors',
          '/api/v1/optionsdesk/anchors/{id}',
          '/api/v1/optionsdesk/anchors/{id}/review',
          '/api/v1/optionsdesk/anchors/{id}/at',
        ]),
      );
      const anchors = document.paths['/api/v1/optionsdesk/anchors']!;
      const byId = document.paths['/api/v1/optionsdesk/anchors/{id}']!;
      expect([anchors.get, anchors.post, byId.get, byId.patch, byId.delete]).not.toContain(
        undefined,
      );
    });

    it('端点挂 optionsdesk tag + bearer 鉴权 + 429 限流响应', () => {
      const op = document.paths['/api/v1/optionsdesk/anchors']!.get!;
      expect(op.tags).toContain('optionsdesk');
      expect(op.security?.[0]).toHaveProperty('bearer');
      expect(op.responses['401']).toBeDefined();
      expect(op.responses['429']).toBeDefined();
    });

    it('建锚 409 (EC-7 重复 ticker) 在契约里显式声明', () => {
      expect(document.paths['/api/v1/optionsdesk/anchors']!.post!.responses['409']).toBeDefined();
    });

    it('🚨 068 bandStatus: LegResponse 增 nullable 枚举带标 (in/out; 离线恒 null)', () => {
      const props = (
        document.components!.schemas!.LegResponse as {
          properties: Record<string, { type?: string; nullable?: boolean; enum?: string[] }>;
        }
      ).properties;
      expect(props.bandStatus).toBeDefined();
      expect(props.bandStatus.type).toBe('string');
      expect(props.bandStatus.nullable).toBe(true);
      expect(props.bandStatus.enum).toEqual(['in', 'out']);
    });

    it('🚨 nullable string 字段显式 type:string —— 否则 orval 误生 objectmap', () => {
      const props = (
        document.components!.schemas!.AnchorResponse as {
          properties: Record<string, { type?: string; nullable?: boolean }>;
        }
      ).properties;
      for (const field of [
        'excludeReason',
        'nextReview',
        'lastReviewedOn',
        'positionCap',
        'lastClose',
        'lastCloseDate',
        'distanceToWPct',
        'breachStartedOn',
        'vManual',
        'positionCapManual',
        'derivedPositionCap',
      ]) {
        expect(props[field], field).toMatchObject({ type: 'string', nullable: true });
      }
    });

    it('AnchorListResponse 引用 AnchorResponse 数组 (非 objectmap)', () => {
      const schema = document.components!.schemas!.AnchorListResponse as {
        properties: Record<string, { type?: string; items?: { $ref?: string } }>;
      };
      expect(schema.properties.items!.type).toBe('array');
      expect(schema.properties.items!.items!.$ref).toContain('AnchorResponse');
    });
  });

  describe('OptionsdeskController — 055 标的链分析报表契约 (T006)', () => {
    it('鉴权沿用同一道闸 —— 无 Bearer → 401 且 usecase 不被调用', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/underlyings/us:PEP/chain-report',
      });
      expect(res.statusCode).toBe(401);
      expect(chainReportExecute).not.toHaveBeenCalled();
    });

    it('🚨 四段逐段过 wire —— 每格 / 每列 / 每行 / **链级读数** (Key Entities 四项)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/underlyings/us:PEP/chain-report',
        headers: authed(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // 🚨 064 `FR-015`: 报表端与选约表**同一条读路径**, 实时档同样由调用点显式打开
      // (末位 `true`)。两个端点口径若分叉, 用户会在同一屏上拿到两个时刻的数。
      expect(chainReportExecute).toHaveBeenCalledWith('us:PEP', undefined, true);

      // ① 每格
      expect(body.cells.allAnnualized[1][0]).toEqual({
        state: 'valued',
        legCount: 1,
        best: '0.240000',
        runnerUp: null,
      });
      // ② 每列
      expect(body.columns[0]).toMatchObject({
        expiryDate: '2026-09-18',
        dteDays: 38,
        isMonthlyChain: true,
        atmIv: 26.31,
      });
      expect(body.columns[0].inRecallBand.buildQuality).toBe(true);
      // ③ 每行 —— 8 行, 行权价区间随现价
      expect(body.rows).toHaveLength(rowsLength());
      expect(body.rows[0].strikeCeiling).toBe('110.0000');
      expect(body.rows[body.rows.length - 1].otmCeiling).toBeNull();
      // ④ 🚨 链级读数 —— **最容易漏的一段**: 它不属于任何格 / 列 / 行
      expect(body.spot).toBe('100.0000');
      expect([body.marketDate, body.asOf, body.oiAsOf]).toEqual([
        '2026-08-11',
        '2026-08-11',
        '2026-08-10',
      ]);
      expect(body.iv.state).toBe('available');
      expect(body.gateCounts.total).toBe(3);
      expect(body.anchorExcluded).toBe(false);
    });

    it('🚨 四张网格维度逐格相等 —— 切换格值不可能移动任何一格 (SC-002 的契约面)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/underlyings/us:PEP/chain-report',
        headers: authed(),
      });
      const { cells, rows, columns } = res.json();
      for (const grid of [
        cells.buildQuality,
        cells.rentAnnualized,
        cells.allAnnualized,
        cells.activity,
      ]) {
        expect(grid).toHaveLength(rows.length);
        for (const row of grid) expect(row).toHaveLength(columns.length);
      }
    });

    it('🚨 响应内零 `band` 字段 —— 色阶档界住 client, 服务端只下发裸值 (plan D-BAND-1)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/underlyings/us:PEP/chain-report',
        headers: authed(),
      });
      const flat = JSON.stringify(res.json());
      // `inRecallBand` 是**召回段覆盖**不是色阶档 —— 判据只认小写 `"band"` 这个独立键名。
      expect(flat).not.toContain('"band"');
      expect(flat).not.toContain('"bands"');
    });

    it('OpenAPI: 端点已登记, 且 nullable 标量显式标 type (Guardrail 10 的契约面)', () => {
      const path = document.paths['/api/v1/optionsdesk/underlyings/{symbol}/chain-report'];
      expect(path?.get).toBeDefined();
      const schema = document.components?.schemas?.ChainReportResponse;
      const props = (schema as { properties: Record<string, { type?: string }> }).properties;
      // 🚨 漏 type 会让 orval 生成 `{ [k]: unknown } | null` —— 而客户端照样编译得过 (012 实证)。
      for (const key of ['spot', 'marketDate', 'asOf', 'quoteAsOf', 'oiAsOf', 'source']) {
        expect(props[key].type).toBe('string');
      }
    });
  });

  // ── 064 T007: 档位出参与两种 asOf 形态 ─────────────────────────────────────

  /**
   * 064 `FR-010` / `FR-014` —— **两档的 `quoteAsOf` 序列化形态必须不同**。
   *
   * 🚨 实时档 = **时刻** (ISO 含秒), 收盘档 = **交易日** (`YYYY-MM-DD`)。这是
   * `optionsdesk.dto.ts` 文件头那条纪律 (「日历日 vs 时刻, 混成一种会让『数据截至 X · 收盘』的
   * asOf 呈现出错」) 的第二个实例, 也与 061 `resolveAnchorSpot` 的 `asOf` 同一套口径。
   * 📌 混成一种**不会红任何一处**: 收盘档带上时分秒会让用户以为那是此刻的盘口 (而它是昨天
   * 20:31 采的), 实时档只给日期则把「几点几分的价」这件唯一要紧的事抹掉。
   */
  const ISO_INSTANT = /T\d{2}:\d{2}:\d{2}/;
  const TRADING_DAY = /^\d{4}-\d{2}-\d{2}$/;

  /** 一条腿的完整投影 —— 除 `code` / `priceKind` 外全走定值 (本 spec 的验证面是形态不是数值)。 */
  function legView(code: string, priceKind: PriceKind): LegView {
    return {
      code,
      strike: new Prisma.Decimal('120'),
      expiryDate: new Date('2026-09-18T00:00:00.000Z'),
      dteDays: 38,
      bid: new Prisma.Decimal('1.45'),
      ask: new Prisma.Decimal('1.55'),
      contractPremium: new Prisma.Decimal('145'),
      relativeSpread: new Prisma.Decimal('0.0667'),
      bidSize: 25,
      askSize: 26,
      basis: 'annualized',
      periodRate: new Prisma.Decimal('0.0105'),
      weeklyRate: null,
      annualizedRate: new Prisma.Decimal('0.0853'),
      tier: 'acceptable',
      askRate: null,
      effectiveCost: new Prisma.Decimal('118.55'),
      effectiveCostVsWPct: new Prisma.Decimal('-1.04'),
      absDelta: 0.32,
      sigmaDistance: 0.4677,
      openInterest: 1234,
      volume: 87,
      turnover: new Prisma.Decimal('10875'),
      activity: null,
      isRecommended: false,
      isMonthlyChain: true,
      earningsMark: null,
      greeksComplete: true,
      priceKind,
      bandStatus: null,
    };
  }

  /** 区块级 `2026-08-11` 那一场 · 采集时刻 20:31:07 · OI 归属 **T−1** (蓄意不同天)。 */
  const SESSION_DAY = '2026-08-11';
  const OI_DAY = '2026-08-10';

  function legTable(priceKind: PriceKind, legs: readonly LegView[]): LegTableView {
    return {
      ...emptyLegTable(),
      state: 'available',
      asOf: new Date(`${SESSION_DAY}T00:00:00.000Z`),
      quoteAsOf: new Date(`${SESSION_DAY}T20:31:07.000Z`),
      oiAsOf: new Date(`${OI_DAY}T00:00:00.000Z`),
      lastClosedSession: SESSION_DAY,
      source: 'eod',
      spot: new Prisma.Decimal('132.4'),
      legs: [...legs],
      matchedCount: legs.length,
      memberCount: legs.length,
      priceKind,
    };
  }

  const legsBody = async (): Promise<Record<string, unknown>> => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/underlyings/us:AOS/legs?perspective=all',
      headers: authed(),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  describe('064 T007 —— 档位与两种 asOf 形态 (FR-009 / FR-010 / FR-013 / FR-014 / SC-001)', () => {
    it('🚨 `FR-010`: 实时档的区块级 `quoteAsOf` 是**时刻** (ISO 含秒), 且 `priceKind=realtime`', async () => {
      legsExecute.mockResolvedValue(legTable('realtime', [legView('L-A', 'realtime')]));
      const body = await legsBody();

      expect(body['priceKind']).toBe('realtime');
      expect(String(body['quoteAsOf'])).toMatch(ISO_INSTANT);
      expect(String(body['quoteAsOf'])).not.toMatch(TRADING_DAY);
    });

    it('🚨 `FR-010`: 收盘档的区块级 `quoteAsOf` 是**交易日** (`YYYY-MM-DD`), 且 `priceKind=eod_close`', async () => {
      legsExecute.mockResolvedValue(legTable('eod_close', [legView('L-A', 'eod_close')]));
      const body = await legsBody();

      expect(body['priceKind']).toBe('eod_close');
      expect(String(body['quoteAsOf'])).toMatch(TRADING_DAY);
      expect(String(body['quoteAsOf'])).not.toMatch(ISO_INSTANT);
      // 🚨 交易日取的是**快照归属的那一场** (`asOf`), 🚫 不是把采集时刻按 UTC 截一刀 ——
      // 美股收盘采集常落在次日 UTC, 截出来的那个日期会比真交易日晚一天而**看不出异常**。
      expect(body['quoteAsOf']).toBe(SESSION_DAY);
    });

    it('🚨 `FR-009` 逐行: 同一响应里两种档位**都出得来** (页级一刀切在这里会红)', async () => {
      legsExecute.mockResolvedValue(
        legTable('realtime', [legView('L-LIVE', 'realtime'), legView('L-STALE', 'eod_close')]),
      );
      const body = await legsBody();

      const legs = body['legs'] as unknown as { code: string; priceKind: string }[];
      expect(legs.map((leg) => [leg.code, leg.priceKind])).toEqual([
        ['L-LIVE', 'realtime'],
        ['L-STALE', 'eod_close'],
      ]);
    });

    it('🚨 `FR-013` / `SC-006` 反例: `oiAsOf` 是**独立出参**, 实时档下仍是 T−1 交易日', async () => {
      legsExecute.mockResolvedValue(legTable('realtime', [legView('L-A', 'realtime')]));
      const body = await legsBody();

      // 🚨 它 MUST NOT 跟着区块档位变成时刻、更 MUST NOT 变成今天: OI 盘中冻结, 归属日与报价
      // 时刻是两回事, 合成一个「数据截至」会让用户按今天的 OI 判流动性。
      expect(body['oiAsOf']).toBe(OI_DAY);
      expect(String(body['oiAsOf'])).not.toMatch(ISO_INSTANT);
      expect(body['oiAsOf']).not.toBe(body['quoteAsOf']);
    });

    it('🚨 `FR-010`: 链分析报表两档同一口径 (两个读端点 MUST NOT 各出一套形态)', async () => {
      const report = async (priceKind: PriceKind): Promise<Record<string, unknown>> => {
        chainReportExecute.mockResolvedValue({ ...chainReport(), priceKind });
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/optionsdesk/underlyings/us:PEP/chain-report',
          headers: authed(),
        });
        expect(res.statusCode).toBe(200);
        return res.json();
      };

      const live = await report('realtime');
      expect(live['priceKind']).toBe('realtime');
      expect(String(live['quoteAsOf'])).toMatch(ISO_INSTANT);

      const closed = await report('eod_close');
      expect(closed['priceKind']).toBe('eod_close');
      expect(String(closed['quoteAsOf'])).toMatch(TRADING_DAY);
      // OI 归属日在两档下逐字节相同 —— 报表的三个时点各自成句 (FR-033 ③)。
      expect(closed['oiAsOf']).toBe(live['oiAsOf']);
    });

    it('🚨 OpenAPI: 三处 `priceKind` 的 enum **就是** `PRICE_KINDS`, 不是裸 string', () => {
      const schemas = document.components!.schemas!;
      const enumOf = (name: string): unknown => {
        const props = (schemas[name] as { properties: Record<string, { enum?: unknown }> })
          .properties;
        return props['priceKind'].enum;
      };
      // 🚫 裸 `type: 'string'` 会让 orval 生成 `string` —— 客户端拿到的档位判据从此失去值域,
      // 写错一个档位名照样编译得过 (T007 verify 的机器判据就是这条)。
      for (const name of ['LegResponse', 'LegTableResponse', 'ChainReportResponse']) {
        expect([name, enumOf(name)]).toEqual([name, [...PRICE_KINDS]]);
      }
    });

    it('🚨 `FR-013` 服务端半边: 成交量 / 成交额的 description 写明**两档口径差异**', () => {
      const props = (
        document.components!.schemas!['LegResponse'] as {
          properties: Record<string, { description?: string }>;
        }
      ).properties;
      // 判据是「两个档位名都被点到」而不是某句中文 —— 前者改不动 (值域来自 PRICE_KINDS),
      // 后者随文案编辑就会红, 于是必然被改成恒真。
      for (const key of ['volume', 'turnover']) {
        const description = props[key].description ?? '';
        for (const kind of PRICE_KINDS) {
          expect([key, kind, description.includes(kind)]).toEqual([key, kind, true]);
        }
      }
    });
  });

  // ── 065 T09 GET /radar 市场作用域 (FR-001 / FR-002 / FR-016, plan D3 / D6) ──
  //
  // 🚨 本文件此前**零条 radar 用例** —— 雷达的查询串校验从未被通道层验证过。065 给它加了
  //    第一个有值域的参数, 而 `@IsIn` / `@ValidateIf` 这类只有跑**真 ValidationPipe** 才看
  //    得见效果 (use case spec 直接调方法, 绕过整条管道)。

  describe('GET /radar — 市场作用域 (065)', () => {
    it('?market=us 抵达 use case, 且**不混进 filter** (作用域 ≠ 筛选项)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar?market=us',
        headers: authed(),
      });

      expect(res.statusCode).toBe(200);
      const arg = radarExecute.mock.calls.at(-1)![0] as {
        market?: string;
        filter?: Record<string, unknown>;
      };
      expect(arg.market).toBe('us');
      // 🚨 plan D1: 混进 filter 就会只进分页不进计数, 而那条病症没有别的断言抓得到。
      expect(arg.filter?.market).toBeUndefined();
    });

    it('🚨 ?market=jp → 400, use case 不被调用 (真 ValidationPipe 跑 @IsIn)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar?market=jp',
        headers: authed(),
      });

      expect(res.statusCode).toBe(400);
      expect(radarExecute).not.toHaveBeenCalled();
    });

    it('🚨 带 cursor 却不带 market → 400 (D6: 不声明作用域就不许翻页)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar?cursor=WyItMTAuMDAiLCI3Il0',
        headers: authed(),
      });

      // D6 撤销了「market 编进游标」, 这三行校验就是它的**全部**替代保护 —— 少了它,
      // 跨市场续页会静默按上一个市场的游标继续翻。
      expect(res.statusCode).toBe(400);
      expect(radarExecute).not.toHaveBeenCalled();
    });

    it('带 cursor **且**带 market → 200 (正向那半条: 别把翻页整个挡死)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar?cursor=WyItMTAuMDAiLCI3Il0&market=us',
        headers: authed(),
      });

      expect(res.statusCode).toBe(200);
      expect(radarExecute).toHaveBeenCalledTimes(1);
    });

    it('两者都不带 → 200 且 market 为 undefined (= 全集, SC-003 并集断言的前提)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar',
        headers: authed(),
      });

      expect(res.statusCode).toBe(200);
      expect((radarExecute.mock.calls.at(-1)![0] as { market?: string }).market).toBeUndefined();
    });

    it('marketCounts 回全部市场且**不受本次作用域限制** (FR-016 小圆点数据源)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/optionsdesk/radar?market=us',
        headers: authed(),
      });

      const body = res.json() as {
        marketCounts: { market: string; baseTotal: number; actionableTotal: number }[];
      };
      // 请求的是 us, 但 hk 那格照样回来 —— 否则港股有可动锚时美股页签零信号 (plan D4)。
      expect(body.marketCounts.map((c) => c.market).sort()).toEqual(['hk', 'us']);
      expect(body.marketCounts.find((c) => c.market === 'hk')).toEqual({
        market: 'hk',
        baseTotal: 2,
        actionableTotal: 0,
      });
    });

    it('marketCounts 是**数组**不是 map (防 orval 生成 objectmap, 同 012/023/024/025 那族)', () => {
      const schema = document.components!.schemas!['RadarResponse'] as {
        properties: Record<
          string,
          { type?: string; items?: unknown; additionalProperties?: unknown }
        >;
      };
      const prop = schema.properties['marketCounts'];
      expect(prop.type).toBe('array');
      expect(prop.items).toBeDefined();
      expect(prop.additionalProperties).toBeUndefined();
    });
  });
});

/** `GetLegsUseCase` 的「链未就绪」空壳 —— 本 spec 只验通道层, 业务形态归 use case 自己的 spec。 */
function emptyLegTable(): LegTableView {
  const blank = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    livenessMin: null,
    relativeSpreadMax: null,
  };
  const criteria = (): PerspectiveCriteria => ({
    defaults: blank,
    effective: blank,
    outcomes: Object.fromEntries(
      RETRIEVAL_CRITERION_KEYS.map((key) => [key, { state: 'default', excludedCount: 0 }]),
    ) as PerspectiveCriteria['outcomes'],
  });
  return {
    symbol: 'us:AOS',
    perspective: 'all',
    march: null,
    state: 'chain_not_ready',
    asOf: null,
    // 064: 空壳一个实时值都没取到 ⇒ 恒收盘档 (本 fixture 只验通道层, 档位判据归 use case)。
    priceKind: 'eod_close',
    realtimeDegrade: null,
    quoteAsOf: null,
    oiAsOf: null,
    lastClosedSession: null,
    source: null,
    spot: null,
    w: new Prisma.Decimal('40'),
    zone: null,
    lLevel: 'L2',
    positionBucket: null,
    positionBucketSource: null,
    positionBucketSetAt: null,
    intent: 'pending',
    rentDepth: null,
    legs: [],
    gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
    candidateCapDropped: 0,
    matchedCount: 0,
    memberCount: 0,
    displayLimit: DISPLAY_LIMIT_BY_PERSPECTIVE.all,
    criteria: criteria(),
  };
}

/** 055 报表 fixture —— 单列单值, 行轴走真纯函数 (🚫 不手抄 8 行档界)。 */
function chainReport(): ChainReportView {
  const spot = new Prisma.Decimal('100');
  const rows = chainReportRows(spot);
  const cellsOf = (value: string | null) =>
    rows.map((_row, i) => [
      i === 1
        ? aggregateCell(value === null ? [] : [new Prisma.Decimal(value)], 'all_annualized', 2)
        : aggregateCell([], 'all_annualized', 0),
    ]);
  return {
    symbol: 'us:PEP',
    state: 'available',
    spot,
    marketDate: '2026-08-11',
    asOf: new Date('2026-08-11T00:00:00.000Z'),
    priceKind: 'eod_close',
    realtimeDegrade: null,
    quoteAsOf: new Date('2026-08-11T20:15:00.000Z'),
    oiAsOf: new Date('2026-08-10T00:00:00.000Z'),
    source: 'eod',
    lastClosedSession: '2026-08-11',
    iv: {
      state: 'available',
      iv: new Prisma.Decimal('28'),
      ivPercentile: new Prisma.Decimal('62'),
      asOf: new Date('2026-08-11T00:00:00.000Z'),
    },
    anchorExcluded: false,
    gateCounts: chainReportGateCounts([
      { inSkeleton: true, live: true, band: 1 },
      { inSkeleton: true, live: true, band: 1 },
      { inSkeleton: false, live: false, band: null },
    ]),
    rows,
    columns: [
      {
        expiryDate: new Date('2026-09-18T00:00:00.000Z'),
        dteDays: 38,
        isMonthlyChain: true,
        atmIv: 26.31,
        inRecallBand: {
          build_quality: true,
          rent_annualized: true,
          all_annualized: true,
          activity: true,
        },
      },
    ],
    cells: {
      build_quality: cellsOf(null),
      rent_annualized: cellsOf('0.24'),
      all_annualized: cellsOf('0.24'),
      activity: cellsOf('940'),
    },
  };
}

/**
 * 雷达页 fixture —— `marketCounts` 刻意含**两个**市场: FR-016 的小圆点要的正是「非当前页签」
 * 那几格, 只放一个市场的话「计数不受作用域限制」这条断言会退化成恒真。
 */
function radarPage() {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    emptyState: null,
    emptyStateMessage: null,
    marketCounts: {
      us: { baseTotal: 3, actionableTotal: 1 },
      hk: { baseTotal: 2, actionableTotal: 0 },
    },
  };
}

/** 行数取自真纯函数, 🚫 不在断言里写死 8。 */
function rowsLength(): number {
  return chainReportRows(new Prisma.Decimal('100')).length;
}
