import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Ip } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HTTP_ADAPTER_OPTIONS } from './http-adapter.options';

// prod 拓扑下 app 不暴露公网端口、恒在 nginx 之后 ⇒ 不开 trustProxy 时 `@Ip()` 拿到的是
// nginx 在 docker 网桥上的私网地址, 被 scrubPrivateIp 抹成 null。2026-08-15 prod 取证:
// account.refresh_token 150/150 行 ip_address IS NULL, 零例外。
//
// 本 spec 钉的是 **HTTP_ADAPTER_OPTIONS 这个常量的行为契约**, 不是 Fastify 的实现:
// main.ts 与本 spec 消费同一个常量, 故「把 trustProxy 改回去 / 改错跳数」会在这里翻红。
// Small size: 全程 app.inject(), 无容器、无真 socket。
@Controller('ip-probe')
class IpProbeController {
  @Get()
  whoAmI(@Ip() ip: string): { ip: string } {
    return { ip };
  }
}

describe('security/http-adapter.options — trustProxy 跳数契约', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [IpProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(HTTP_ADAPTER_OPTIONS),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  const probe = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/ip-probe', headers });

  it('单条 XFF (无客户端伪造): req.ip = nginx 追加的真实客户端地址', async () => {
    const res = await probe({ 'x-forwarded-for': '203.0.113.7' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ip).toBe('203.0.113.7');
  });

  it('客户端伪造 XFF: nginx 追加真实地址在后 → 取末项, 伪造项永不被选中 (决定性)', async () => {
    // nginx 侧 `$proxy_add_x_forwarded_for` = <客户端自带值>, <真实 socket 地址>。
    // 攻击者塞 198.51.100.99 想冒充, 真实地址 203.0.113.7 被 nginx 追加在其后。
    const res = await probe({ 'x-forwarded-for': '198.51.100.99, 203.0.113.7' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ip).toBe('203.0.113.7');
  });

  it('多层伪造仍只信一跳: 无论客户端塞几条, 恒取 nginx 追加的末项', async () => {
    const res = await probe({
      'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3, 203.0.113.7',
    });
    expect(res.json().ip).toBe('203.0.113.7');
  });

  it('无 XFF (nginx 未下发 / 直连) → 退回 socket 地址, 安全降级不报错', async () => {
    const res = await probe();
    expect(res.statusCode).toBe(200);
    expect(res.json().ip).toBe('127.0.0.1'); // inject 的伪 socket 地址
  });
});
