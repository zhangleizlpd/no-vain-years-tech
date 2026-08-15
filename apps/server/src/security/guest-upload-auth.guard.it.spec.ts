import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { GuestUploadAuthGuard } from './guest-upload-auth.guard';
import { guestUploadConfig } from '../config/index';

/**
 * 057 T007 GuestUploadAuthGuard HTTP IT（token 三态）。
 *
 * 🚨 真 guard 经 `Test.createTestingModule` **DI 装载**，不是 `new GuestUploadAuthGuard()`
 * —— Guard / Interceptor / Filter / Pipe 子类禁隔离单测（plan § Testing Invariants 第一条）：
 * 那样测的是一个方法调用，而不是「Nest 的 lifecycle 里这道闸真的拦得住请求」。范式同
 * `agent-bridge/agent-queue.controller.it.spec.ts`。
 *
 * 挂一个**探针 controller** 而不是真业务 controller：本 guard 落在 security 平台层、与
 * research 无关（将来别的 ctx 也可能挂它），且 057 的投递端点在 T009 才建 —— 用探针能让
 * 这条鉴权断言独立于业务端点的形态变化。
 */
const TOKEN = 'g'.repeat(43);

const handler = vi.fn();

@Controller('v1/__guest-probe')
class GuestProbeController {
  @Post()
  @UseGuards(GuestUploadAuthGuard)
  ingest(): { ok: true } {
    handler();
    return { ok: true };
  }
}

async function bootWithToken(token: string | null): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [GuestProbeController],
    providers: [GuestUploadAuthGuard, { provide: guestUploadConfig.KEY, useValue: { token } }],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('GuestUploadAuthGuard IT（token 三态，真 DI 容器）', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await bootWithToken(TOKEN);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('对：有效 token → 放行（201，命中 handler）', async () => {
    handler.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/__guest-probe',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('错：token 不符 → 401，handler 不被调用', async () => {
    handler.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/__guest-probe',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('缺：无 Authorization 头 → 401', async () => {
    handler.mockClear();
    const res = await app.inject({ method: 'POST', url: '/v1/__guest-probe' });
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['Bearer', '只有 scheme 没有 token'],
    ['Basic dXNlcjpwYXNz', '换了 scheme'],
    [`Token ${TOKEN}`, 'scheme 写错但 token 是对的'],
    [TOKEN, '裸 token 不带 scheme'],
  ])('缺：Authorization 形态不符 %j（%s）→ 401', async (authorization) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/__guest-probe',
      headers: { authorization },
    });
    expect(res.statusCode).toBe(401);
  });

  it('「缺失」与「不符」的响应逐字节相同（state_branch 11/12：两者对外不可区分）', async () => {
    const missing = await app.inject({ method: 'POST', url: '/v1/__guest-probe' });
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/__guest-probe',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    });
    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
  });

  it('反例：token 未配置（null）→ 连正确 token 也拒（fail-closed，未配 ≠ 放行）', async () => {
    const unconfigured = await bootWithToken(null);
    try {
      handler.mockClear();
      const res = await unconfigured.inject({
        method: 'POST',
        url: '/v1/__guest-probe',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await unconfigured.close();
    }
  });
});
