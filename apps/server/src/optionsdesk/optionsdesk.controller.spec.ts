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
import { RETRIEVAL_CRITERION_KEYS, type PerspectiveCriteria } from './leg-recall.rules';

// boot-time zod 校验的最小 env 集 (与 alert-crud.it.spec.ts 同口径)。必须在 Nest 编译前落位:
// SecurityModule 的 ConfigModule.forRoot 在模块实例化时 .parse()。DB / Redis 均不真连 ——
// PrismaService 懒连接; ioredis 连不上只在后台重试 (silentEmit), 不影响本 spec。
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test_optionsdesk';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6399';
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
        expect(legsExecute).toHaveBeenCalledWith('us:AOS', perspective, undefined, null);
      }
    });

    it('🚨 只给 perspective 不给条件 ⇒ 覆盖为 null (首屏 / 「复位」走的就是这条)', async () => {
      await app.inject({ method: 'GET', url: legsUrl('perspective=rent'), headers: authed() });
      expect(legsExecute).toHaveBeenCalledWith('us:AOS', 'rent', undefined, null);
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
    state: 'chain_not_ready',
    asOf: null,
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
    tabOrder: { all: [], build: [], rent: [] },
    gateCounts: {
      removedByPremiumFloor: 0,
      excludedFromIntentTabs: 0,
      excludedFromIntentTabsByTab: { build: 0, rent: 0 },
    },
    candidateCapDropped: 0,
    criteriaByTab: { all: criteria(), build: criteria(), rent: criteria() },
  };
}
