import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { WechatAuthPort, WechatIdentity } from './wechat-auth.port';

/**
 * MockWechatAuthGateway — Phase 1 stub for WechatAuthGateway (Phase 2 replacement).
 *
 * 由 authCode 派生**确定性** 28 位 openid（`oMOCKDEV` 前缀 + sha256(authCode)
 * hex 前 20 位）：同 authCode → 同 openid（供冲突 IT：两账号用同 authCode 触发
 * openid 唯一冲突）；不同 authCode → 不同 openid。格式贴齐真 openid（28 位、`o`
 * 开头），契约 phase-stable，Phase 2 仅换 adapter 不改下游。
 *
 * Not for production — auth.module env-gated factory 生产 boot 拒 kind==='mock'。
 */
@Injectable()
export class MockWechatAuthGateway implements WechatAuthPort {
  private readonly logger = new Logger(MockWechatAuthGateway.name);

  async resolveIdentity(authCode: string): Promise<WechatIdentity> {
    const digest = createHash('sha256').update(authCode).digest('hex').slice(0, 20);
    const openid = `oMOCKDEV${digest}`; // 8 + 20 = 28 位, 'o' 开头
    this.logger.log(`[STUB WECHAT] authCode→openid=${openid}`);
    return { openid };
  }
}
