import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma, RefreshToken } from '../generated/prisma/client';
import { JwtTokenService } from './jwt-token.service';
import { PrismaService } from './prisma.service';
import { hashRefreshToken } from './refresh-token-hasher';
import {
  REFRESH_TTL_DAYS,
  decodeDeviceName,
  isActive,
  normalizeDeviceType,
  scrubPrivateIp,
} from './refresh-token.rules';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 设备列表分页上限 (FR-S01 size 上限 100,超限截断)。auth list-devices 编排层共享同一上限算 envelope。 */
export const MAX_DEVICE_PAGE_SIZE = 100;

/**
 * 事务客户端 —— caller 持有的 `$transaction` 回调参数 (Omit 掉 $transaction 等
 * deny-list 方法的 PrismaClient)。跨 ctx 写传入则操作入 caller 的 tx (R2 sync,
 * 撤/写 token 失败回滚整请求, plan D3)；缺省 → 用 service 自己的 PrismaService。
 */
export type TxClient = Prisma.TransactionClient;

/** persist 入参 —— device 元数据来自登录控制器透传 (X-Device-Id 头 + clientIp)。 */
export interface PersistRefreshTokenInput {
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  clientIp?: string | null;
  loginMethod: string;
}

/** rotate 产出 —— 与 auth LoginResponse 同 shape (security 不 import auth 类型,由 auth usecase 映射)。 */
export interface RotatedTokens {
  accountId: bigint;
  accessToken: string;
  refreshToken: string;
}

/**
 * RefreshTokenService —— refresh-token 全生命周期, security 平台层持有
 * (PrismaService 直注无 repository + 贫血 Prisma row, per ADR-0043 §1)。
 * persist (签发即落库) / findActiveByHash (查活) / rotate (原子轮换) /
 * revokeAllForAccount (全端登出) / listActiveByAccount + findById +
 * revokeOneForAccount (005 设备列表 + 单行撤销); auth 编排层经 DI 调用
 * (R2 跨 ctx 读/写, rotate / revokeOne 失败抛 → auth 回滚整请求)。
 *
 * T004 骨架: 方法签名占位 + 注册进 SecurityModule providers/exports。
 * 构造器 DI 与各方法体由实现 task 增量补入 (TS noUnusedLocals 不允许提前声明
 * 未使用的注入): T005 (persist, 补 PrismaService + hashRefreshToken) /
 * T008 (findActiveByHash) / T010 (rotate, 补 JwtTokenService) / T016 (revokeAllForAccount)。
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtTokenService,
  ) {}

  /**
   * 签发即持久化: hash token + create 1 条 active 行。
   * expiresAt = now + 30d; deviceId 缺失 → 回退 uuid v4; deviceName 经 decodeDeviceName
   * 解 transport 编码; clientIp 经 scrubPrivateIp (私网/回环/非法 → null);
   * deviceType 经 normalizeDeviceType 归一; revokedAt 默认 null。
   */
  async persist(
    accountId: bigint,
    rawToken: string,
    meta: PersistRefreshTokenInput,
    tx?: TxClient,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * DAY_MS);
    await (tx ?? this.prisma).refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(rawToken),
        accountId,
        expiresAt,
        deviceId: meta.deviceId ?? randomUUID(),
        deviceName: decodeDeviceName(meta.deviceName),
        deviceType: normalizeDeviceType(meta.deviceType),
        ipAddress: scrubPrivateIp(meta.clientIp),
        loginMethod: meta.loginMethod,
      },
    });
  }

  /**
   * 按 tokenHash 命中唯一索引查 + isActive(record, now) 过滤 → record | null。
   * miss (not-found / expired / revoked) 一律返回 null,由 auth 编排折叠成反枚举 401。
   */
  async findActiveByHash(tokenHash: string, now: Date): Promise<RefreshToken | null> {
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return record && isActive(record, now) ? record : null;
  }

  /**
   * 原子轮换: 条件 revoke 旧 (affected-count 乐观锁) → 签新 access/refresh + insert 新行
   * (继承 device 血缘 + 更 IP + 新 30d)。调用方先经 findActiveByHash 拿到 active `record`。
   *
   * 单次使用 + 并发 exactly-once 靠 `updateMany({ where:{ id, revokedAt:null } })` 的
   * **affected-count**: count===0 → 已被并发轮换/撤销 → throw 401 (整 tx 回滚)。
   *
   * 隔离级 **READ COMMITTED 即够** —— 同 token 并发由行锁串行化 (后到者 re-check
   * `revokedAt IS NULL` → count=0 → 401); 独立 token 不共享行,零冲突。
   * **不用 SERIALIZABLE**: 它在共享 `revoked_at IS NULL` 偏索引上产生 SSI 假冲突
   * (Postgres 40001),令独立 token 的高并发轮换批量失败 (T015 实证 72/100),而
   * affected-count 已独立保证 exactly-once → SERIALIZABLE 对 rotate 纯冗余 + 有害。
   * tokenHash 唯一约束 (256-bit 高熵,实际不撞) 若违例 → tx 原子回滚 (旧不撤),client 重试即可。
   *
   * 10 并发同 token → 恰 1 成功 + 9×401;100 并发不同 token → 0 错误 (独立行无争用)。
   */
  async rotate(record: RefreshToken, clientIp: string | null): Promise<RotatedTokens> {
    const accountId = record.accountId;
    return this.prisma.$transaction(
      async (tx) => {
        // 条件 revoke 旧 (乐观锁): 仅当仍 active 才撤; count===0 → 已被并发轮换/撤销。
        const { count } = await tx.refreshToken.updateMany({
          where: { id: record.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (count === 0) {
          throw new UnauthorizedException('INVALID_CREDENTIALS');
        }

        const accessToken = this.jwt.signAccessToken({ accountId });
        const newRefreshToken = this.jwt.generateRefreshToken();
        const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * DAY_MS);
        // 继承 device 血缘 (deviceId/Name/Type + loginMethod), 更新本次 IP, 新 30d 有效期。
        await tx.refreshToken.create({
          data: {
            tokenHash: hashRefreshToken(newRefreshToken),
            accountId,
            expiresAt,
            deviceId: record.deviceId,
            deviceName: record.deviceName,
            deviceType: record.deviceType,
            loginMethod: record.loginMethod,
            ipAddress: scrubPrivateIp(clientIp),
          },
        });

        return { accountId, accessToken, refreshToken: newRefreshToken };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * 全端登出: 撤该账号全部 active refresh-token 行 (含当前 device)。
   * `updateMany where {accountId, revokedAt:null}` set revokedAt=now —— **幂等**:
   * count 忽略 (0/1/N 均 ok),已撤销行因 `revokedAt:null` 过滤不被重写 (时间戳不变)。
   *
   * `tx` 传入 → 撤销入 caller 的事务 (delete/cancel/anonymize 跨 ctx 原子撤 token,
   * R2 sync); 缺省 → service 自己的 PrismaService (003 全端登出既有行为不变)。
   */
  async revokeAllForAccount(accountId: bigint, now: Date, tx?: TxClient): Promise<void> {
    await (tx ?? this.prisma).refreshToken.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * 列某账号全部 active (revokedAt=null) 行 → createdAt DESC 分页 + total
   * (偏索引 idx_refresh_token_account_id_active 驱动)。`size` clamp [1, 100]
   * (FR-S01 上限 100 超限截断),`page` 0-based。findMany + count 在同一 read tx
   * 内取快照,避免并发写下 rows 与 total 不一致。供 auth 设备列表 query 投影 (R2 只读)。
   */
  async listActiveByAccount(
    accountId: bigint,
    page: number,
    size: number,
  ): Promise<{ rows: RefreshToken[]; total: number }> {
    const take = Math.min(Math.max(Math.trunc(size), 1), MAX_DEVICE_PAGE_SIZE);
    const skip = Math.max(Math.trunc(page), 0) * take;
    const where = { accountId, revokedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.refreshToken.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.refreshToken.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * 按行 PK 查 → row | null (不过滤 revokedAt/expiresAt:供 auth 撤销编排做
   * 404/409 guard 的快照判定;活跃性由 conditional UPDATE affected-count 兜底)。
   */
  async findById(recordId: bigint): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { id: recordId } });
  }

  /**
   * 条件撤单行 (affected-count 乐观锁): updateMany WHERE {id, accountId, revokedAt:null}
   * set revokedAt → won = count===1。`WHERE accountId` 双保险防越权撤;已撤 / 竞态败者 /
   * 跨账号 → count=0 → won=false (幂等 200,不发事件)。READ COMMITTED 即够 (同行写锁
   * 串行化并发撤;偏索引 SSI 假冲突 → 禁 SERIALIZABLE/FOR UPDATE, per memory
   * prisma_serializable_p2002_and_p2034)。`tx` 传入 → 撤入 caller tx (auth revoke 编排
   * 撤 + 发事件原子, R2 sync);缺省 → service 自己的 PrismaService。
   */
  async revokeOneForAccount(
    recordId: bigint,
    accountId: bigint,
    now: Date,
    tx?: TxClient,
  ): Promise<{ won: boolean }> {
    const { count } = await (tx ?? this.prisma).refreshToken.updateMany({
      where: { id: recordId, accountId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { won: count === 1 };
  }
}
