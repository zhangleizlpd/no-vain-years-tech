import { DocumentBuilder } from '@nestjs/swagger';

/**
 * OpenAPI 3.1 document config — extracted from bootstrap so SwaggerModule.createDocument
 * can be called in tests (without booting Fastify listener) to assert the generated spec
 * is well-formed per W4 V8 验收.
 */
export function buildOpenApiConfig() {
  return (
    new DocumentBuilder()
      .setTitle('no-vain-years API')
      .setDescription(
        'no-vain-years backend HTTP API. Generated from NestJS controllers; ' +
          'consumed by packages/api-client for cross-app TS types.',
      )
      .setVersion('1.0')
      .setOpenAPIVersion('3.1.0')
      .addTag('accounts', 'Account lifecycle: SMS code request, phone-SMS auth')
      // agent-bridge 通道层 worker token (P1.4): 远程 agent worker 碰 agent-queue 端点。
      // 与用户 JWT 分离的命名 scheme; 端点用 @ApiBearerAuth('worker-token') 引用。
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          description: 'agent-bridge 通道层 worker token (AGENT_WORKER_TOKEN)',
        },
        'worker-token',
      )
      // 057 guest 投递通道 token: 隧道内的 guest-proxy 转发时覆写的常量凭证, 059 起同时
      // 覆盖研报投递 / 锚待审提交 / 锚直写三条 location (刻意一把, 理由单点在
      // config/guest-upload.config.ts 顶部)。与用户 JWT、与 worker-token 三者互不相干;
      // 端点用 @ApiBearerAuth('guest-upload-token') 引用。投递方本人从不持有它 ——
      // 他打的是代理, 代理才持有 (FR-015)。
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          description: 'guest 投递通道 token (GUEST_UPLOAD_TOKEN)',
        },
        'guest-upload-token',
      )
      .build()
  );
}
