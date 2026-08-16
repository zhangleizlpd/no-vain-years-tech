import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { GuestUploadAuthGuard } from './guest-upload-auth.guard';
import { guestUploadConfig, type GuestUploadConfig } from '../config/index';

/**
 * 057 T007 GuestUploadAuthGuard HTTP IT（token 三态）。059 扩为**两把 token 各三态** +
 * 交叉反例。
 *
 * 🚨 真 guard 经 `Test.createTestingModule` **DI 装载**，不是 `new GuestUploadAuthGuard()`
 * —— Guard / Interceptor / Filter / Pipe 子类禁隔离单测（plan § Testing Invariants 第一条）：
 * 那样测的是一个方法调用，而不是「Nest 的 lifecycle 里这道闸真的拦得住请求」。范式同
 * `agent-bridge/agent-queue.controller.it.spec.ts`。
 *
 * 挂**探针 controller** 而不是真业务 controller：本 guard 落在 security 平台层、与 research /
 * optionsdesk 无关（将来别的 ctx 也可能挂它）—— 用探针能让这条鉴权断言独立于业务端点的
 * 形态变化。
 *
 * 🚨 **交叉那两条是本文件最重的断言**（059 Guardrail 6）：两把 token 抄错的表现**不是 401**
 * （那还好查），而是**授权分流形同虚设** —— 他人持有的提交 token 也能打直写口，锚表的最后
 * 一道服务端闸就只剩 nginx 一层了。
 */
const UPLOAD_TOKEN = 'g'.repeat(43);
const ANCHOR_TOKEN = 'a'.repeat(43);

const submitHandler = vi.fn();
const anchorHandler = vi.fn();

@Controller('v1/__guest-probe')
class GuestProbeController {
  /** 提交口：认既有 `GUEST_UPLOAD_TOKEN`（研报投递 / 锚待审提交同款）。 */
  @Post('submit')
  @UseGuards(GuestUploadAuthGuard('upload'))
  submit(): { ok: true } {
    submitHandler();
    return { ok: true };
  }

  /** 直写口：认 `ANCHOR_IMPORT_TOKEN`（059 第二把）。 */
  @Post('anchor')
  @UseGuards(GuestUploadAuthGuard('anchorImport'))
  anchor(): { ok: true } {
    anchorHandler();
    return { ok: true };
  }
}

async function bootWith(cfg: GuestUploadConfig): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [GuestProbeController],
    providers: [{ provide: guestUploadConfig.KEY, useValue: cfg }],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('GuestUploadAuthGuard IT（两把 token 各三态，真 DI 容器）', () => {
  let app: NestFastifyApplication;

  const post = (path: string, authorization?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/__guest-probe/${path}`,
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

  beforeAll(async () => {
    app = await bootWith({ token: UPLOAD_TOKEN, anchorImportToken: ANCHOR_TOKEN });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  describe.each([
    ['submit', UPLOAD_TOKEN, ANCHOR_TOKEN, submitHandler],
    ['anchor', ANCHOR_TOKEN, UPLOAD_TOKEN, anchorHandler],
  ] as const)('%s 口', (path, ownToken, otherToken, handler) => {
    it('对：本口的 token → 放行（201，命中 handler）', async () => {
      handler.mockClear();
      const res = await post(path, `Bearer ${ownToken}`);
      expect(res.statusCode).toBe(201);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('错：token 不符 → 401，handler 不被调用', async () => {
      handler.mockClear();
      const res = await post(path, `Bearer ${'x'.repeat(43)}`);
      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('缺：无 Authorization 头 → 401', async () => {
      handler.mockClear();
      const res = await post(path);
      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('🚨 交叉：拿**另一把** token 打本口 → 401（Guardrail 6 的回归钉）', async () => {
      handler.mockClear();
      const res = await post(path, `Bearer ${otherToken}`);
      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('「缺失」与「不符」的响应逐字节相同（state_branch 15/16：两者对外不可区分）', async () => {
      const missing = await post(path);
      const wrong = await post(path, `Bearer ${'x'.repeat(43)}`);
      expect(missing.statusCode).toBe(wrong.statusCode);
      expect(missing.body).toBe(wrong.body);
    });
  });

  it.each([
    ['Bearer', '只有 scheme 没有 token'],
    ['Basic dXNlcjpwYXNz', '换了 scheme'],
    [`Token ${UPLOAD_TOKEN}`, 'scheme 写错但 token 是对的'],
    [UPLOAD_TOKEN, '裸 token 不带 scheme'],
  ])('缺：Authorization 形态不符 %j（%s）→ 401', async (authorization) => {
    const res = await post('submit', authorization);
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['submit', UPLOAD_TOKEN, { token: null, anchorImportToken: ANCHOR_TOKEN }],
    ['anchor', ANCHOR_TOKEN, { token: UPLOAD_TOKEN, anchorImportToken: null }],
  ] as const)(
    '反例：%s 口的 token 未配置（null）→ 连正确 token 也拒（fail-closed，未配 ≠ 放行）',
    async (path, ownToken, cfg) => {
      const unconfigured = await bootWith(cfg);
      try {
        const res = await unconfigured.inject({
          method: 'POST',
          url: `/v1/__guest-probe/${path}`,
          headers: { authorization: `Bearer ${ownToken}` },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await unconfigured.close();
      }
    },
  );
});
