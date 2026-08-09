import type { Account } from '../generated/prisma/client';

/**
 * Account 不变量 —— 无状态纯函数 helper (per ADR-0043 §2 贫血 + 纯函数 Helper)。
 *
 * 数据 = Prisma 原始 `Account` row (绝对贫血)。这里只放对 row 的只读判定;
 * 禁带状态 Domain Class、禁 Entity Mapper。状态机转移 use case 由其它 module
 * 处理 (ACTIVE ↔ FROZEN ↔ ANONYMIZED)。
 */
export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  ANONYMIZED = 'ANONYMIZED',
}

export const isActive = (a: Account): boolean => a.status === AccountStatus.ACTIVE;
export const isFrozen = (a: Account): boolean => a.status === AccountStatus.FROZEN;
export const isAnonymized = (a: Account): boolean => a.status === AccountStatus.ANONYMIZED;

/**
 * 注销生命周期常量 (FR-S03 / FR-S14)。
 *  - FREEZE_DURATION_DAYS: 注销发起后冻结期，期满方可匿名化。
 *  - ANONYMIZED_DISPLAY_NAME: 匿名化后 displayName 占位（phone 置空后的展示名）。
 */
export const FREEZE_DURATION_DAYS = 15;
export const ANONYMIZED_DISPLAY_NAME = '已注销用户';

/**
 * 状态转换门槛纯函数 (ACTIVE → FROZEN → {ACTIVE | ANONYMIZED})。仅只读判定;
 * 真正的 conditional UPDATE 由 account 的 Commit*UseCase 落地 (affected-count,
 * per plan D2)。这里的谓词与 UPDATE 的 WHERE 子句一一对应，作为单测可验的不变量真相源。
 *
 * grace 边界 (freezeUntil === now) 严格划分: 撤销用 `>`、匿名化用 `<=` ——
 * 同一瞬间至多一个谓词成立，匿名化恒赢 (plan §2 互斥 + FR-S16)。
 */

// FR-S03: 仅 ACTIVE 账号可发起注销 → 冻结。
export const canFreeze = (a: Account): boolean => isActive(a);

// 冻结宽限期边界 (FR-S09 grace deadline): freezeUntil 严格晚于 now → 在宽限期内;
// null (异常态) 视为不在 grace。抽出供 auth 编排在仅持 inspection (无完整 Account
// row) 时复用同一 `>` 边界 —— 单一边界真相源, 避免在 auth 内重复判定 drift (plan §2 互斥)。
export const isWithinGrace = (freezeUntil: Date | null, now: Date): boolean =>
  freezeUntil !== null && freezeUntil.getTime() > now.getTime();

// FR-S09: 冻结期内 (freezeUntil 尚未到) 的 FROZEN 账号可撤销注销。
export const isFrozenInGrace = (a: Account, now: Date): boolean =>
  isFrozen(a) && isWithinGrace(a.freezeUntil, now);

export const canCancelFromFrozen = (a: Account, now: Date): boolean => isFrozenInGrace(a, now);

// FR-S13: 冻结期满 (freezeUntil <= now) 的 FROZEN 账号可匿名化。边界归此分支。
export const canAnonymize = (a: Account, now: Date): boolean =>
  isFrozen(a) && a.freezeUntil !== null && a.freezeUntil.getTime() <= now.getTime();

/**
 * 输入校验纯函数 (per ADR-0043 §2 + R-VO 拍平 VO 为纯函数)。Phone / DisplayName
 * 原 Value Object 降维:校验 + trim 归一,返回规范化 string (零 class / 零装箱)。
 * 失败抛 Error,由 ProblemDetailFilter 映射 HTTP 400。
 */

// Phone — E.164 +86 CN mobile only (FR-S01)。trim 后校验,返回 trimmed。
const CN_MOBILE_REGEX = /^\+861[3-9]\d{9}$/;

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!CN_MOBILE_REGEX.test(trimmed)) {
    throw new Error(`Invalid phone: ${raw}`);
  }
  return trimmed;
}

// DisplayName — FR-005。禁字符查 raw (trim 会吞 BOM),再 trim + code-point 长度 [1,32]。
const DISPLAY_NAME_MIN_CP = 1;
const DISPLAY_NAME_MAX_CP = 32;
/* eslint-disable no-control-regex */
// 控制字符 (U+0000-U+001F + U+007F) + 零宽字符 (U+200B-U+200F, U+FEFF) +
// 行/段分隔符 (U+2028, U+2029) —— FR-005 deny-list。
const DISPLAY_NAME_FORBIDDEN = new RegExp('[\\x00-\\x1F\\x7F\\u200B-\\u200F\\uFEFF\\u2028\\u2029]');
/* eslint-enable no-control-regex */

export function normalizeDisplayName(raw: string): string {
  if (DISPLAY_NAME_FORBIDDEN.test(raw)) {
    throw new Error(
      'INVALID_DISPLAY_NAME: contains forbidden characters (control chars, zero-width chars, or line separators)',
    );
  }
  const trimmed = raw.trim();
  const cpCount = [...trimmed].length;
  if (cpCount < DISPLAY_NAME_MIN_CP || cpCount > DISPLAY_NAME_MAX_CP) {
    throw new Error(
      `INVALID_DISPLAY_NAME: length must be ${DISPLAY_NAME_MIN_CP}-${DISPLAY_NAME_MAX_CP} Unicode code points after trim, got ${cpCount}`,
    );
  }
  return trimmed;
}

// Bio (个人简介) — 007 FR-S03。校验口径镜像 displayName（trim + code-point 计长 +
// 同一禁字符 deny-list），仅上限 32→120 且【允许空】(trim 后空串 = 清空 bio)。
const BIO_MAX_CP = 120;

export function normalizeBio(raw: string): string {
  // 禁字符查 raw（trim 会吞 BOM），复用 displayName 的控制/零宽/行段分隔符 deny-list。
  if (DISPLAY_NAME_FORBIDDEN.test(raw)) {
    throw new Error(
      'INVALID_BIO: contains forbidden characters (control chars, zero-width chars, or line separators)',
    );
  }
  const trimmed = raw.trim();
  const cpCount = [...trimmed].length;
  if (cpCount > BIO_MAX_CP) {
    throw new Error(
      `INVALID_BIO: length must be at most ${BIO_MAX_CP} Unicode code points after trim, got ${cpCount}`,
    );
  }
  return trimmed;
}

/**
 * Gender (性别) — 008 FR-S01/S03。存为英文 enum 字符串 (镜像 status String，无 native
 * Prisma enum)；前端中文标签映射 (男/女/非二元/保密) 仅展示层，存储恒英文。
 */
export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  NON_BINARY = 'NON_BINARY',
  PRIVATE = 'PRIVATE',
}

const GENDER_VALUES = new Set<string>(Object.values(Gender));

/**
 * Gender 校验 (008 FR-S03)。null / 空串 / 纯空白 → null (清空 gender，canonical 未设态)；
 * 合法 4 枚举之一 → 返回该值；其余 → 抛 INVALID_GENDER (use case 映 400)。严格枚举，
 * 不接受自由文本 / 中文标签。
 */
export function normalizeGender(raw: string | null): Gender | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  if (!GENDER_VALUES.has(raw)) {
    throw new Error(`INVALID_GENDER: must be one of ${[...GENDER_VALUES].join(' / ')}, got ${raw}`);
  }
  return raw as Gender;
}
