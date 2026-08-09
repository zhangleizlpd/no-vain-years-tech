import { describe, it, expect } from 'vitest';
import { AliyunSmsGateway } from '../../src/auth/aliyun-sms.gateway';
import { CockatielRetryExecutor } from '../../src/auth/cockatiel-retry.executor';

/**
 * AliyunSmsGateway 真发 env-gated IT —— 当初 "Skeleton-only (没 cred)" 时
 * 明确延期的「单独 PR」(per aliyun-sms.gateway.ts 头注释 §
 * "真 SMS env-gated IT defer 到 cred + SignName/TemplateCode 审批后单独 PR")。
 *
 * 目的: 用真 Aliyun cred + 已审批 SignName/TemplateCode 向真手机号发一条登录码,
 * 验证整条 prod 链路真实可用 —— SDK 调用 + 签名/模板匹配 + `+86` 去前缀 +
 * RetryExecutor 包装 + 响应 code='OK'(非 OK 时 gateway 抛错,IT 即 fail)。
 *
 * **默认 skip** (env-gated, per memory env_gated_perf_it_pattern):
 *   会真发短信(产生费用 + 占用日额度 + 触发限流),CI / 常规 `nx affected` 不跑。
 *   描述块用 `describe.skipIf(!RUN_SMS_IT)`,未设 env 时整块跳过(与 timing-defense.p95.it 同范式)。
 *
 * **本地启用** (cred 放 gitignored env / shell,禁入仓):
 *   RUN_SMS_IT=true \
 *   ALIYUN_ACCESS_KEY_ID=<id> ALIYUN_ACCESS_KEY_SECRET=<secret> \
 *   ALIYUN_SMS_SIGN_NAME=<已审批签名> ALIYUN_SMS_TEMPLATE_CODE=<已审批模板CODE> \
 *   SMS_IT_PHONE=+8613800138000 \
 *   pnpm nx test server -- aliyun-sms.real-send.vendor
 *
 * **模板约定**: 模板变量名 = `code`(gateway 发 `templateParam={"code": ...}`);
 * 单通用模板 → 登录/注销/撤销共用同一 TemplateCode,本 IT 测默认(登录码)路径即覆盖全链。
 */
const RUN_SMS_IT = process.env.RUN_SMS_IT === 'true';

describe.skipIf(!RUN_SMS_IT)('AliyunSmsGateway 真发 IT (env-gated, 默认 skip)', () => {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID ?? '';
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET ?? '';
  const signName = process.env.ALIYUN_SMS_SIGN_NAME ?? '';
  const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE ?? '';
  const phone = process.env.SMS_IT_PHONE ?? '';

  it('真 cred → 向 SMS_IT_PHONE 发一条登录码,Aliyun 返回 OK(无 throw)', async () => {
    // 缺任一 env → 明确报错(而非静默用空串打到 Aliyun 拿无意义错误)。
    const required = {
      ALIYUN_ACCESS_KEY_ID: accessKeyId,
      ALIYUN_ACCESS_KEY_SECRET: accessKeySecret,
      ALIYUN_SMS_SIGN_NAME: signName,
      ALIYUN_SMS_TEMPLATE_CODE: templateCode,
      SMS_IT_PHONE: phone,
    };
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`真发 IT 缺 env(均需设): ${missing.join(', ')}`);
    }

    const client = AliyunSmsGateway.createClient({
      accessKeyId,
      accessKeySecret,
      signName,
      templateCode,
    });
    const gateway = new AliyunSmsGateway(
      client,
      signName,
      templateCode,
      new CockatielRetryExecutor(),
    );

    const code = '123456'; // 固定值;收到即证明链路通(本 IT 不验码本身)。
    // eslint-disable-next-line no-console
    console.log(
      `[aliyun-sms.real-send.vendor] sending code=${code} to ${phone} (sign=${signName}, tpl=${templateCode})`,
    );

    // gateway 内部对 response.body.code !== 'OK' 抛错 → resolves 即 Aliyun 真实接受。
    await expect(gateway.sendCode(phone, code)).resolves.toBeUndefined();
  }, 30_000);
});
