import { Injectable, Logger } from '@nestjs/common';
import type { MarketSession, MarketSessionState, MarketStatePort } from './market-state.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途市场时段 adapter (061 T004, `MARKET_STATE_PORT` 的唯一实现)。
 *
 * 打 shim 一个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * GET `<shim>/market-state` → `get_global_state()` 的完整 payload (一行)。
 *
 * ## 🚨🚨 白名单归一在**这里**做完 (Guardrail 2 / plan D7)
 *
 * vendor 的原始状态串 (`MORNING` / `AFTER_HOURS_BEGIN` / …) **不出本文件**, 端口对外只有
 * {@link MarketSession} 三态。把原始串递给消费端 (`optionsdesk`) 让它自己判, 等于把一份
 * vendor 值域知识复制进第二个 bounded context, 两处必漂移, 而漂移的表现是盘前 / 夜盘被当成
 * 常规时段采了价 —— 没有任何断言会红。
 *
 * 归一逻辑刻意**不抽到 `marketdata/*.rules.ts`**: 那样 `optionsdesk` 就能 import 它, 而
 * ESLint boundaries 对这条边是硬拒的 (`from: optionsdesk` 的 `disallow` 明列 `marketdata-rules`)。
 * 撞红时的正确动作是把归一化推回本文件, 不是改 allowlist。
 *
 * ## 🚨 白名单, 禁黑名单 (FR-002)
 *
 * 见 {@link REGULAR_SESSION_STATES}。「不是 CLOSED 就算开市」会把盘前 / 盘后 / 夜盘一并放行,
 * 而本片只取常规时段的最新成交价 (FR-020)。
 *
 * ## 失败一律上抛, 不映射具名错误 (FR-003)
 *
 * 与链 / 快照 / 财报三个 adapter 的「429 顺延 / 400 永久」二分**刻意不同**: 本端口的调用方
 * (盘中投影 tick) 对任何「取不到状态」的结局处置完全一致 —— fail-closed 不采 + 计失败
 * (spec `state_branch` 4)。分成几个错误类型只会多出没人会走的分支。
 */

/**
 * vendor payload 字段 → canonical market。**只有 us / hk**。
 *
 * 🆕 `cn` 刻意缺席, 两条理由缺一不可: ① vendor 用 `market_sh` + `market_sz` **两个**字段表达
 * 一个 canonical market, 合并规则 (两个都开才算开? 任一开就算开?) 没人拍过 ② 富途账号无 A 股
 * 权限, 本片也不含 cn 实时 (spec「故意零覆盖」第 2 条)。将来要加 cn, **先定合并规则**,
 * 别顺手把 `market_sh` 一挂了事 —— 那会让沪深不同步的日子静默判错。
 */
const FIELD_TO_MARKET: Record<string, string> = {
  market_us: 'us',
  market_hk: 'hk',
};

/**
 * **白名单**: 算作常规连续交易时段的 vendor 状态。
 *
 * 两个值都收: `MORNING` / `AFTERNOON` 是 vendor 对**连续竞价**时段的表达 —— 有午休的市场
 * (hk) 上下午各出现一个, 无午休的市场 (us) 只会出现其中之一。收窄到单个值的风险是「整个
 * 交易时段一次都不采」(静默且只在特定市场发作), 而多收一个的风险为零: 另一个值本来就是
 * 常规交易时段。
 *
 * 🚨 **禁黑名单**: 写成「不是 `CLOSED` 就算开市」会把 `PRE_MARKET_BEGIN` /
 * `AFTER_HOURS_BEGIN` / `NIGHT_OPEN` / `OVERNIGHT` 全部放行, 于是盘前价被当成盘中价写进锚表,
 * 雷达照常渲染、排序照常成立、**没有任何断言会红**。
 */
const REGULAR_SESSION_STATES = new Set<string>(['MORNING', 'AFTERNOON']);

/**
 * vendor `MarketState` 的**当前完整值域** (取自装机的 futu SDK `futu.common.constant.MarketState`,
 * 2026-08-17 复核; 与官方文档 v10.10 同源)。
 *
 * 它唯一的用途是分辨「白名单外的**已知**状态」与「vendor **新加**的值」—— 前者归 `other`
 * (预期内, 不采即可), 后者归 `unknown` 并落一条 warn。少了这张表两者混成一个值: vendor 哪天
 * 扩了值域, 我们既不会采错、也**永远不会知道**; 而下一次扩充完全可能是一个本该算常规时段的
 * 新值, 那时表现为「某个时段从此不再采集」。
 */
const KNOWN_VENDOR_STATES = new Set<string>([
  'NONE',
  'AUCTION',
  'WAITING_OPEN',
  'MORNING',
  'REST',
  'AFTERNOON',
  'CLOSED',
  'PRE_MARKET_BEGIN',
  'PRE_MARKET_END',
  'AFTER_HOURS_BEGIN',
  'AFTER_HOURS_END',
  'NIGHT_OPEN',
  'NIGHT_END',
  'NIGHT',
  'OVERNIGHT',
  'TRADE_AT_LAST',
  'HK_CAS',
  'STIB_AFTER_HOURS_WAIT',
  'STIB_AFTER_HOURS_BEGIN',
  'STIB_AFTER_HOURS_END',
  'FUTURE_DAY_OPEN',
  'FUTURE_DAY_BREAK',
  'FUTURE_DAY_CLOSE',
  'FUTURE_DAY_WAIT_OPEN',
  'FUTURE_NIGHT_WAIT',
  'FUTURE_AFTERNOON',
  'FUTURE_SWITCH_DATE',
  'FUTURE_OPEN',
  'FUTURE_BREAK',
  'FUTURE_BREAK_OVER',
  'FUTURE_CLOSE',
]);

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

/** 白名单 → `regular`; 已知但不在白名单 → `other`; 其余 → `unknown`。复杂度 O(1)。 */
function normalizeSession(raw: string): MarketSession {
  if (REGULAR_SESSION_STATES.has(raw)) return 'regular';
  return KNOWN_VENDOR_STATES.has(raw) ? 'other' : 'unknown';
}

@Injectable()
export class FutuMarketStateAdapter implements MarketStatePort {
  private readonly logger = new Logger(FutuMarketStateAdapter.name);

  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 复杂度: **1 个 HTTP 请求** + O(已登记市场数) 归一。 */
  async getMarketSessions(): Promise<MarketSessionState[]> {
    const state = await this.fetchState();
    return Object.entries(FIELD_TO_MARKET).map(([field, market]) => ({
      market,
      session: this.sessionOf(state, field, market),
    }));
  }

  /**
   * 单个市场字段 → 归一时段。
   *
   * 🚨 **字段整个缺失 / 不是非空字符串 ⇒ throw, 不降级成 `unknown`**: 那是**契约变更**,
   * 与「vendor 值域扩了一个新状态」是两回事。降级成 unknown 会让盘中链从此不采、**且不计
   * 失败** (unknown 走的是「按闭市处理」那条路) —— 一个永久静默的缺口。响亮地失败, 交上游
   * fail-closed 计数 (spec `state_branch` 4)。
   */
  private sessionOf(state: Record<string, unknown>, field: string, market: string): MarketSession {
    const raw = state[field];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(
        `[futu] market-state 响应缺字段 ${field} 或值不是非空字符串 (契约变更?): ` +
          `market=${market} 值=${JSON.stringify(raw)}`,
      );
    }
    const session = normalizeSession(raw);
    if (session === 'unknown') {
      // 留痕是 `unknown` 这一档存在的**全部**理由 —— 动作上它与 `other` 一样不采。
      this.logger.warn(
        `[futu] market-state ${market} 收到未登记的 vendor 状态 "${raw}", 按闭市处理; ` +
          `富途值域可能已扩充, 需人工复核 REGULAR_SESSION_STATES / KNOWN_VENDOR_STATES`,
      );
    }
    return session;
  }

  /**
   * 打一次 shim + 信封校验。
   *
   * 信封形状 `{ as_of, count: 1, rows: [ <get_global_state payload> ] }`。
   *
   * `as_of` **刻意不读**: 本端口不产出任何落库值, 读进来就得解释它的语义 (同 FR-020 那条
   * 纪律 —— 不消费的字段不碰)。「这一拍是什么时候采的」由调用方自己的墙钟负责。
   *
   * 错误一律原样上抛 (见类注释)。
   */
  private async fetchState(): Promise<Record<string, unknown>> {
    const res = await this.http.request<ShimEnvelope>({
      url: `${this.baseUrl}/market-state`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const rows = res?.rows;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(
        `[futu] market-state 响应须恰好一行全局状态 (契约变更?): ` +
          `rows=${Array.isArray(rows) ? String(rows.length) : typeof rows}`,
      );
    }
    const row: unknown = rows[0];
    if (row === null || typeof row !== 'object') {
      throw new Error(`[futu] market-state 行不是对象 (契约变更?): ${JSON.stringify(row)}`);
    }
    return row as Record<string, unknown>;
  }
}
