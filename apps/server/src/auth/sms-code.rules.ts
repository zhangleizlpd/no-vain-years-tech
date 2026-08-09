import { randomInt } from 'node:crypto';

/**
 * SMS code 校验 + 生成纯函数 (per ADR-0043 §2 + R-VO 拍平 VO)。原 SmsCode Value
 * Object 降维:6 位数字契约,零 class / 零装箱。SMS code 不 trim(纯数字)。
 */
const SMS_CODE_REGEX = /^\d{6}$/;

export function assertValidSmsCode(raw: string): asserts raw is string {
  if (!SMS_CODE_REGEX.test(raw)) {
    throw new Error(`Invalid SMS code: ${raw}`);
  }
}

/** CSPRNG 6 位数字 (crypto.randomInt 范围 [0, 1_000_000),左 pad 到 6 位)。 */
export function generateSmsCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// 本地手动测试便利码:交互式 dev server 下 mock 网关固定发此码,免去翻日志取码。
const DEV_FIXED_CODE = '999999';

/**
 * 统一发码入口 —— 所有发码流程 (登录 / 注销 / 撤销 / 未来新增) MUST 走此函数,
 * 不直接调 generateSmsCode(),以便固定码开关统一覆盖。
 *
 * 仅「交互式开发」返回固定码,其余一律 CSPRNG:
 *   - 生产 / staging (NODE_ENV ≠ development): 永远 CSPRNG —— 固定码构造上不可能上线。
 *   - 自动化测试套件 (vitest 设 process.env.VITEST): CSPRNG —— IT 仍按真随机码断言
 *     (如 accounts.us1 拿 '999999' 当错码,固定码会让它误成对码)。
 */
export function issueSmsCode(): string {
  if (process.env.NODE_ENV === 'development' && !process.env.VITEST) {
    return DEV_FIXED_CODE;
  }
  return generateSmsCode();
}
