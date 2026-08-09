import { isIPv4, isIPv6 } from 'node:net';
import type { RefreshToken } from '../generated/prisma/client';

/**
 * refresh-token 不变量 —— 无状态纯函数 helper + 常量 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * 数据 = Prisma 原始 `RefreshToken` row (绝对贫血)。这里只放对 row 的只读判定 /
 * 入参归一,禁带状态 Domain Class、禁 Entity Mapper。状态转移 (revoke / rotate)
 * 由 RefreshTokenService 在事务内处理。
 */

/** access token TTL —— 与 SecurityModule JwtModule signOptions.expiresIn '15m' 对齐 (单一来源)。 */
export const ACCESS_TTL_MIN = 15;
/** refresh token TTL —— 签发时 expiresAt = now + 30d。 */
export const REFRESH_TTL_DAYS = 30;

/** device_type 值域 (UPPERCASE,与 DB 列 device_type 默认 "UNKNOWN" + login_method 风格一致)。 */
export type DeviceType = 'PHONE' | 'TABLET' | 'DESKTOP' | 'WEB' | 'UNKNOWN';

/**
 * active = 未撤销且未过期。`now` 由调用方注入 (事务内时钟一致 + 可测)。
 * 边界: expiresAt === now 视为已过期 (严格 >)。
 */
export const isActive = (
  record: Pick<RefreshToken, 'revokedAt' | 'expiresAt'>,
  now: Date,
): boolean => record.revokedAt === null && record.expiresAt > now;

/**
 * 规范化客户端上报的 device type → 5 值域之一。大小写不敏感,未知/空 → 'UNKNOWN'。
 */
export function normalizeDeviceType(raw: string | null | undefined): DeviceType {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'phone':
    case 'mobile':
      return 'PHONE';
    case 'tablet':
      return 'TABLET';
    case 'desktop':
      return 'DESKTOP';
    case 'web':
    case 'browser':
      return 'WEB';
    default:
      return 'UNKNOWN';
  }
}

/**
 * 解码客户端上报的 device name → 规范展示值。客户端 (apps/mobile device-store)
 * 用 `encodeURIComponent` 把 unicode 设备名压成 ASCII 以塞进 HTTP header (header 必须
 * ASCII);此处在 ingest 边界解回规范值落库,避免 "Web%20-%20Mozilla%2F5.0" 透传到列表展示。
 * 防御:截断的转义序列 (header 长度上限可能切断 `%XX`) 会让 decodeURIComponent 抛 →
 * 回退原始串而非崩。null/空/纯空白 → null。
 */
export function decodeDeviceName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 私网 / 回环 / 链路本地 IP → null (不落库: 隐私 + 无审计价值);公网 → 原样返回;
 * 无法解析为合法 IP → null (防脏数据)。
 * 覆盖 IPv4 10/8 · 172.16/12 · 192.168/16 · 127/8 · 169.254/16,
 * IPv6 ::1 · fe80::/10 · fc00::/7,以及 IPv4-mapped IPv6 (::ffff:a.b.c.d)。
 */
export function scrubPrivateIp(ip: string | null | undefined): string | null {
  if (ip == null) return null;
  const trimmed = ip.trim();
  if (trimmed === '') return null;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → 按内嵌 IPv4 判定
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(trimmed);
  const candidate = mapped ? mapped[1] : trimmed;

  if (isIPv4(candidate)) {
    return isPrivateIpv4(candidate) ? null : trimmed;
  }
  if (isIPv6(trimmed)) {
    return isPrivateIpv6(trimmed) ? null : trimmed;
  }
  return null;
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  // fe80::/10 link-local → 首 hextet fe80..febf
  if (/^fe[89ab]/.test(lower)) return true;
  // fc00::/7 unique local → fc.. / fd..
  if (/^f[cd]/.test(lower)) return true;
  return false;
}
