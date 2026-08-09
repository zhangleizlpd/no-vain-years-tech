/**
 * 回填自限速节流器 (038 T017, US3 / INV-3 防风控)。
 *
 * 底层共享 `VendorRateLimiter` (perSec:36/perMin:900, `lixinger.constraint-profile.ts`)
 * **不动** —— 本节流器是**叠加**在 backfill 路径之上的更保守层: 把回填期有效调用速率自限到
 * ~600/min (10/s, ≈共享桶 2/3, 对官方 1000/min 累计 ~40% buffer) + 调用间随机 jitter 打散,
 * 避免等间隔机器人特征触发 vendor 风控。**只在 backfill 模式生效** (夜间 delta 不经此路径);
 * 港股回填 job 与 A 股夜同步 job 共享单 `LIXINGER_HTTP_CLIENT` + queue concurrency=1 天然串行,
 * 本层是叠加软护栏而非唯一护栏。
 *
 * 节流数学为**纯函数** (`baseIntervalMs` / `pacerWaitMs`), 单测无需真时钟/真随机; 有状态串行
 * 在 `BackfillPacer` (注入 now/sleep/random 供确定化测试, 镜像 `VendorRateLimiter` 范式)。
 */

/** 回填节流参数: 目标速率 + jitter 上界 + 开关。 */
export interface BackfillPacerConfig {
  /** 目标调用速率 (次/分); base 最小间隔 = 60000/targetPerMin。 */
  targetPerMin: number;
  /** 每次放行在 base 之上叠加的随机 jitter 上界 (ms, 取值 [0, jitterMs])。 */
  jitterMs: number;
  /** false → `pace()` no-op (既有直调 IT / 非 backfill 路径零节流零减速)。缺省 true。 */
  enabled?: boolean;
}

/**
 * 生产回填节流参数: 600/min (10/s) + 40ms jitter。**code 常量非 env** —— INV-3 固定保守层,
 * 不做运维 tuning 面 (env 化会引诱把它调到接近共享桶而失去 buffer 意义)。
 */
export const DEFAULT_BACKFILL_PACER_CONFIG: BackfillPacerConfig = {
  targetPerMin: 600,
  jitterMs: 40,
  enabled: true,
};

/** 纯函数: 目标速率 → 两次放行的基础最小间隔 (ms, 向上取整); targetPerMin ≤ 0 → 0 (关节流)。O(1)。 */
export function baseIntervalMs(targetPerMin: number): number {
  if (targetPerMin <= 0) return 0;
  return Math.ceil(60_000 / targetPerMin);
}

/**
 * 纯函数: 给定上次放行时刻 / 当前时刻 / 本次所需间隔 (= base + jitter), 返还需 sleep 的 ms (≥0)。
 * elapsed ≥ required → 0 (无需等待)。jitter 只增不减 → 每次间隔恒 ≥ base → 有效速率恒 ≤ 目标。O(1)。
 */
export function pacerWaitMs(lastPassMs: number, nowMs: number, requiredIntervalMs: number): number {
  const elapsed = nowMs - lastPassMs;
  return elapsed >= requiredIntervalMs ? 0 : requiredIntervalMs - elapsed;
}

/**
 * 有状态串行回填节流器。`pace()` 在 backfill 每次 vendor 调用前 await —— 距上次放行不足
 * base+jitter 则 sleep 补齐 (不抛)。首次放行无「上次」锚点 → 直通。注入 now/sleep/random 仅为
 * 单测确定化 (生产用 Date.now + setTimeout + Math.random)。
 */
export class BackfillPacer {
  private lastPassMs: number | null = null;
  private readonly base: number;
  private readonly jitterMs: number;
  private readonly enabled: boolean;

  constructor(
    config: BackfillPacerConfig = DEFAULT_BACKFILL_PACER_CONFIG,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly random: () => number = Math.random,
  ) {
    this.enabled = config.enabled ?? true;
    this.base = baseIntervalMs(config.targetPerMin);
    this.jitterMs = Math.max(0, config.jitterMs);
  }

  /** backfill 每次 vendor 调用前 await: 距上次放行不足 base+jitter 则 sleep 补齐节流 (不抛)。 */
  async pace(): Promise<void> {
    if (!this.enabled) return;
    const nowMs = this.now();
    if (this.lastPassMs === null) {
      // 首次放行不等待 (无「上次」锚点), 只记时刻。
      this.lastPassMs = nowMs;
      return;
    }
    const jitter = Math.floor(this.random() * (this.jitterMs + 1)); // [0, jitterMs]
    const wait = pacerWaitMs(this.lastPassMs, nowMs, this.base + jitter);
    if (wait > 0) await this.sleep(wait);
    this.lastPassMs = this.now();
  }

  /** 关闭节流的 pacer (既有直调路径 / 非 backfill IT 用, `pace()` 即 no-op)。 */
  static disabled(): BackfillPacer {
    return new BackfillPacer({ targetPerMin: 600, jitterMs: 0, enabled: false });
  }
}
