import type { PrismaService } from '../security/prisma.service.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 理杏仁公司类型枚举 (`/{market}/company` 响应字段 `fsTableType`, env-gated IT 校真)。fundamental/fs
 * 按它分端点。cn 5 值; 港股多房托 `reit` + p0 catalog 用 `non`/`other` 命名 (038 T009)。
 */
export type FsType =
  | 'non_financial'
  | 'bank'
  | 'insurance'
  | 'security'
  | 'other_financial'
  | 'non'
  | 'other'
  | 'reit';

/**
 * 按 market 的合法 fsType 值域 (038 T009 解锁 hk reit)。
 * - cn: 5 值 (env-gated IT 校真 2026-06-03)。
 * - hk: p0 catalog `bank/insurance/non/other/reit/security` (S2 端点目录实测) —— 比 cn 多房托 `reit`。
 *   permissive 兼收 cn 式 `non_financial`/`other_financial`: hk `fsTableType` 真值域待 T020 真调确认
 *   (DEFERRED-PROBE), 接受两种命名不丢有效标的 (各值仍路由到自己的 `/hk/company/fundamental/{fsType}`)。
 */
const KNOWN_FS_TYPES_BY_MARKET: Record<string, ReadonlySet<string>> = {
  cn: new Set<FsType>(['non_financial', 'bank', 'insurance', 'security', 'other_financial']),
  hk: new Set<FsType>([
    'bank',
    'insurance',
    'non',
    'other',
    'reit',
    'security',
    'non_financial',
    'other_financial',
  ]),
};

/** 某 market 的合法 fsType 集 (未知 market 兜底走 cn 值域)。 */
function knownFsTypes(market: string): ReadonlySet<string> {
  return KNOWN_FS_TYPES_BY_MARKET[market] ?? KNOWN_FS_TYPES_BY_MARKET.cn;
}

interface LixingerCompanyRow {
  stockCode?: unknown;
  // 理杏仁 /cn/company 真实字段名 = `fsTableType` (env-gated 真 IT 校真 2026-06-03; 旧
  // provisional `fs_type` 是错的 → fsType 永远解析不出 → fundamental/fs 路由空转)。
  fsTableType?: unknown;
}

/**
 * 理杏仁 live adapter 共享传输基座 (015 T006)。
 *
 * 4 个理杏仁 adapter (EOD / fundamental / financials / corporate-action) 共一个
 * `VendorHttpClient` **实例** (共享双窗限频器 + 熔断状态 — 全 Lixinger 调用同一配额),
 * 经本基座统一: ① POST + body 注入 `token` (理杏仁鉴权在 body 非 header); ② 解析
 * `{ code, message, data }` 信封取 `data`。
 *
 * 请求结构已对客户端库求证 (Chaoyingz/lixinger · lixingr2 · txcary/lixinger):
 * 全 endpoint = POST JSON, token 在 body, base `https://open.lixinger.com/api`。
 * 信封 success 码值各版本不一 → 以 `data` 是否为数组判定成功 (env-gated 真 IT 校真值)。
 */
export abstract class LixingerAdapterBase {
  constructor(
    protected readonly http: VendorHttpClient,
    protected readonly token: string,
    protected readonly baseUrl: string,
  ) {}

  /** POST `{path}`，body 自动注入 token；返信封 `data` 数组。 */
  protected async post<T>(path: string, body: Record<string, unknown>): Promise<T[]> {
    const envelope = await this.http.request<{
      code?: number;
      message?: string;
      data?: unknown;
    }>({
      url: `${this.baseUrl}${path}`,
      method: 'POST',
      body: JSON.stringify({ token: this.token, ...body }),
    });

    if (!Array.isArray(envelope?.data)) {
      // 200 + 应用层错 (无效 token / 参数) → 理杏仁返非数组 data + 错误 message。
      throw new Error(
        `[lixinger] ${path} unexpected response (code=${envelope?.code ?? 'n/a'} message=${
          envelope?.message ?? 'n/a'
        })`,
      );
    }
    return envelope.data as T[];
  }

  /**
   * stockCode → fsType (FR-S11, fundamental + fs 共用)。先读 `Instrument.lixingerCompanyType`
   * 缓存; 缺失批量 POST `/{market}/company` 拿 `fsTableType` 并回写缓存 (命中即零外呼)。
   * Instrument 行可能尚未由 016 建 → `updateMany` 0 行即 no-op, 不抛。
   *
   * 038 seam#1: `market` 段参数化 (/cn|/hk) —— 缓存查询 + company 路径 + 回写全按 market 定位。
   * 调用方按市场分组后逐组传入。合法 fsType 值域按 market 定 (`knownFsTypes`): hk 含房托 `reit` (038 T009)。
   */
  protected async resolveFsTypes(
    prisma: PrismaService,
    market: string,
    codes: string[],
  ): Promise<Map<string, FsType>> {
    const result = new Map<string, FsType>();

    const cached = await prisma.instrument.findMany({
      where: { market, code: { in: codes } },
      select: { code: true, lixingerCompanyType: true },
    });
    const cacheByCode = new Map(cached.map((r) => [r.code, r.lixingerCompanyType]));

    const missing: string[] = [];
    for (const code of codes) {
      const ct = cacheByCode.get(code);
      if (ct && knownFsTypes(market).has(ct)) result.set(code, ct as FsType);
      else missing.push(code);
    }
    if (missing.length === 0) return result;

    const rows = await this.post<LixingerCompanyRow>(`/${market}/company`, { stockCodes: missing });
    for (const r of rows) {
      const code = String(r.stockCode);
      const fsType = String(r.fsTableType);
      if (!knownFsTypes(market).has(fsType)) continue; // 未知类型 → 跳过 (不路由错端点)。
      result.set(code, fsType as FsType);
      await prisma.instrument.updateMany({
        where: { market, code },
        data: { lixingerCompanyType: fsType },
      });
    }
    return result;
  }
}

/** 理杏仁数值字段 → string (FR-S08: 跨边界 string)。null/undefined 透传 null。 */
export function lixNumToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return null;
}

/** 理杏仁日期字段 (ISO datetime, 北京时区) → `YYYY-MM-DD`。 */
export function lixDateOnly(v: unknown): string {
  return String(v ?? '').slice(0, 10);
}

/**
 * 理杏仁可空日期字段 (ISO datetime) → `YYYY-MM-DD`; null/缺失/非日期 → null。
 * 用于可空日期列 (如 fund-shareholders 的 `declarationDate` 公告日) —— 与 `lixDateOnly`
 * (必填列, 缺失返空串) 区分: 可空列缺失须落 null 而非 `''`。
 */
export function lixDateOnlyOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

/**
 * 理杏仁日期字段 **HK-aware** 归一 → `YYYY-MM-DD` (042 M1, prod 77 probe verified)。
 *
 * 报告期端点日期格式**不一致**: 营收构成 (operation-revenue-constitution) 的 `date` 是 UTC
 * `...T16:00:00.000Z` (= 次日 00:00+08 HK), 而员工/最新股东是 `...+08:00`。裸 `lixDateOnly`
 * 的 `slice(0,10)` 对 `+08:00` 正确、对 UTC-Z **off-by-one 少 1 天** → 营收会与员工/股东跨维度
 * join 错位 1 天。故先把 UTC 时刻 **+8h 转 HK-local** 再取 date-only, 两种格式都归到同一 HK 日历日。
 * 对已是 `+08:00` 的日期: `Date.parse` 归一到同一 UTC 瞬时, +8h 后取日仍为原 HK 日 (幂等无害)。
 */
export function lixDateOnlyHk(v: unknown): string {
  const ms = Date.parse(String(v ?? ''));
  if (Number.isNaN(ms)) return String(v ?? '').slice(0, 10); // 非日期兜底 (不抛, 同 lixDateOnly 容错)。
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * `lixDateOnlyHk` 的可空变体: null/缺失/非日期 → null (报告期可空日期列如营收 `declarationDate`)。
 * 与 `lixDateOnlyHk` (必填列, 非日期兜底 slice) 区分: 可空列缺失须落 null 而非兜底串。
 */
export function lixDateOnlyHkOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const ms = Date.parse(String(v));
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 今天往前 `days` 天的 `YYYY-MM-DD` —— vendor 区间查询起点。
 *
 * 理杏仁 fundamental/fs 端点**必填** `date|startDate`（缺则 400 ValidationError）；
 * dividend 区间硬上限 **≤10 年**（超则 403）。故 corp-action 用 3650 天（≈9.99yr, 安全
 * 卡在 10yr 内），fundamental/fs 用近窗（取最新一条）。env-gated 真 IT 校真 2026-06-03。
 */
export function daysAgoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
