import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { TimingDefenseExecutor } from './timing-defense.port';

/**
 * BcryptTimingDefenseExecutor — FR-S06 反枚举 timing defense impl.
 *
 * 在反枚举失败路径 (ACTIVE+码错 / ACTIVE+码过期 / ANONYMIZED+正确 / 未注册+码错)
 * 计算 dummy bcrypt compare, 让失败路径 wall-clock 时延与成功路径对齐.
 *
 * cost=10 (50-100ms 量级) — PoC 阶段足以模拟真实 password-bcrypt 验证耗时;
 * 真实 P95 ≤ 50ms 时延差测量推 W3+ `SingleEndpointEnumerationDefenseIT`.
 *
 * onModuleInit 预计算 dummy hash, 让 pad() 只做 compare (~50-100ms).
 */
const DUMMY_INPUT = '__timing_defense_pad_input__';
const BCRYPT_COST = 10;

@Injectable()
export class BcryptTimingDefenseExecutor implements TimingDefenseExecutor, OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await bcrypt.hash(DUMMY_INPUT, BCRYPT_COST);
  }

  async pad(): Promise<void> {
    if (!this.dummyHash) {
      // Lazy init fallback if onModuleInit not invoked (e.g. unit tests).
      this.dummyHash = await bcrypt.hash(DUMMY_INPUT, BCRYPT_COST);
    }
    await bcrypt.compare(DUMMY_INPUT, this.dummyHash);
  }
}
