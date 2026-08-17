import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { GuestUploadAuthGuard } from './guest-upload-auth.guard';
import { guestUploadConfig, type GuestUploadConfig } from '../config/index';

/**
 * 057 T007 GuestUploadAuthGuard HTTP IT（token 三态）。
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
 * 📌 059 期间本文件一度扩成「两把 token 各三态 + 交叉反例」，随第二把 token 一起回退。
 * 直写口与提交口现在持同一把 ⇒ 交叉反例在服务端**不可能成立**，留着只会是假保证。
 * 分流判据落在通道层，钉它的是 `services/guest-proxy/verify-guards.sh` 的锚导入闸。
 */
const UPLOAD_TOKEN = 'g'.repeat(43);

const submitHandler = vi.fn();

@Controller('v1/__guest-probe')
class GuestProbeController {
  @Post('submit')
  @UseGuards(GuestUploadAuthGuard)
  submit(): { ok: true } {
    submitHandler();
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

describe('GuestUploadAuthGuard IT（token 三态，真 DI 容器）', () => {
  let app: NestFastifyApplication;

  const post = (authorization?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/__guest-probe/submit',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

  beforeAll(async () => {
    app = await bootWith({ token: UPLOAD_TOKEN });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('对：token 相符 → 放行（201，命中 handler）', async () => {
    submitHandler.mockClear();
    const res = await post(`Bearer ${UPLOAD_TOKEN}`);
    expect(res.statusCode).toBe(201);
    expect(submitHandler).toHaveBeenCalledTimes(1);
  });

  it('错：token 不符 → 401，handler 不被调用', async () => {
    submitHandler.mockClear();
    const res = await post(`Bearer ${'x'.repeat(43)}`);
    expect(res.statusCode).toBe(401);
    expect(submitHandler).not.toHaveBeenCalled();
  });

  it('缺：无 Authorization 头 → 401', async () => {
    submitHandler.mockClear();
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(submitHandler).not.toHaveBeenCalled();
  });

  it('「缺失」与「不符」的响应逐字节相同（state_branch 15/16：两者对外不可区分）', async () => {
    const missing = await post();
    const wrong = await post(`Bearer ${'x'.repeat(43)}`);
    expect(missing.statusCode).toBe(wrong.statusCode);
    expect(missing.body).toBe(wrong.body);
  });

  it.each([
    ['Bearer', '只有 scheme 没有 token'],
    ['Basic dXNlcjpwYXNz', '换了 scheme'],
    [`Token ${UPLOAD_TOKEN}`, 'scheme 写错但 token 是对的'],
    [UPLOAD_TOKEN, '裸 token 不带 scheme'],
  ])('缺：Authorization 形态不符 %j（%s）→ 401', async (authorization) => {
    const res = await post(authorization);
    expect(res.statusCode).toBe(401);
  });

  it('反例：token 未配置（null）→ 连正确 token 也拒（fail-closed，未配 ≠ 放行）', async () => {
    const unconfigured = await bootWith({ token: null });
    try {
      const res = await unconfigured.inject({
        method: 'POST',
        url: '/v1/__guest-probe/submit',
        headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await unconfigured.close();
    }
  });
});
