import { Prisma } from '../generated/prisma/client';

/**
 * 082 券商代码**字面解析**纯函数 (plan D5; FR-006 / FR-007)。无 I/O、无 DI (ADR-0043 §4)。
 *
 * 只拆字面, **不判正股**: 期权 → 正股归 `resolve-broker-underlying.ts` 按「市场 + 词根」查映射
 * (调整合约的词根与正股代码字面不同, 截字面还原是 FR-006 明令禁止的)。
 *
 * 🚨 **判不出一律 `null`, 不猜** —— 调用方把 `null` 当未解析**保留** (FR-006)。反方向的错更坏:
 * 把一个解析失败的期权码误读成正股, 在 `anchored` 范围下会因「不在锚集」被**静默滤掉**。
 * ⇒ 正股形态刻意收窄 (见 {@link US_STOCK_BODY_RE} / {@link HK_STOCK_BODY_RE}), 宁 null 不误判。
 *
 * 金额 (行权价) 用 `Prisma.Decimal`, 沿 `anchor.rules.ts` / `leg-recall.rules.ts` 既有纪律。
 */

export type BrokerMarket = 'us' | 'hk';

export type ParsedBrokerCode =
  | { kind: 'stock'; market: BrokerMarket; ticker: string }
  | {
      kind: 'option';
      market: BrokerMarket;
      /** 6 位日期之前的字母数字段, **原样** (调整合约 `CMCS1` 不去尾数字)。 */
      root: string;
      /** `YYYY-MM-DD` (码内 `YYMMDD` 按 20YY 展开)。 */
      expiry: string;
      right: 'C' | 'P';
      strike: Prisma.Decimal;
    };

/** 富途 code 前缀 → canonical market。未登记前缀 ⇒ 本解析不承担 ⇒ null。 */
const MARKET_BY_PREFIX: Readonly<Record<string, BrokerMarket>> = { US: 'us', HK: 'hk' };

/** 行权价在码内的放大倍数。EVIDENCE: 行权价 ×1000 整数 —— plan D5 (F6, 082 POC)。 */
const STRIKE_SCALE = 1000;

const PREFIXED_CODE_RE = /^(US|HK)\.(.+)$/;

/**
 * 期权码主体 `<词根><YYMMDD><C|P><行权价×1000>`。形态同 `marketdata/futu-option-chain.adapter.ts`
 * 的 `FUTU_OPTION_CODE_RE` (那边注释记有实取 `US.PEP260918P130000` 与调整词根 `VICI1`)。
 *
 * 切法唯一: 行权价段全是数字直到串尾 ⇒ `[CP]` 必是**最后一个字母**, 其前恰 6 位是日期, 再前
 * 全归词根 —— 惰性词根只是写法, 不是「猜最短」。本仓只收大写字母数字词根 (组合合成码带 `/` 不匹配)。
 */
const OPTION_BODY_RE = /^([A-Z0-9]+?)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/;

/**
 * 美股正股主体: 字母段, 可带点分隔的类别后缀。
 * ASSUMED: 带点美股在富途侧写作 `US.BRK.B` —— 未验证 (spec Assumptions: 带点号美股代码无样本);
 * 错了 ⇒ 该形态解析为 null ⇒ 按未解析保留, 不丢行 (FR-006)。
 */
const US_STOCK_BODY_RE = /^[A-Z]+(?:\.[A-Z]+)*$/;

/** 港股正股主体: 5 位数字, 前导零原样 (锚 ticker 形态 `hk:00700`)。 */
const HK_STOCK_BODY_RE = /^\d{5}$/;

/** 组合单腿串里的 `code=<市场>.<码>`, 到逗号 / 右括号 / 空白为止。 */
const COMBO_LEG_CODE_RE = /code=((?:US|HK)\.[^,)\s]+)/g;

/**
 * 券商代码 → 正股 / 期权结构; 判不出 ⇒ null。
 *
 * 复杂度 O(len): 三条正则均无嵌套量词, 单次线性扫描 (惰性词根的回溯被固定长度的
 * `\d{6}[CP]` 约束, 每个起点至多试一次)。
 */
export function parseBrokerCode(code: string): ParsedBrokerCode | null {
  const prefixed = PREFIXED_CODE_RE.exec(code);
  if (prefixed === null) return null;
  const market = MARKET_BY_PREFIX[prefixed[1] as string] as BrokerMarket;
  const body = prefixed[2] as string;

  const option = OPTION_BODY_RE.exec(body);
  if (option !== null) {
    return {
      kind: 'option',
      market,
      root: option[1] as string,
      expiry: `20${option[2]}-${option[3]}-${option[4]}`,
      right: option[5] as 'C' | 'P',
      strike: new Prisma.Decimal(option[6] as string).div(STRIKE_SCALE),
    };
  }

  const stockRe = market === 'us' ? US_STOCK_BODY_RE : HK_STOCK_BODY_RE;
  if (!stockRe.test(body)) return null;
  return { kind: 'stock', market, ticker: `${market}:${body}` };
}

/**
 * 组合单腿串 → 各腿券商代码 (保持顺序)。**不**解析组合单的合成 `code` (FR-007)。
 *
 * 入参收 `unknown`: 直接喂 vendor 行字段。EVIDENCE: `combo_legs` 为字符串数组、每腿一条
 * `ComboLeg(code=US.PEP260918P120000, trd_side=BUY, qty_ratio=1.0, position_id=N/A)` —— 082 POC-1
 * 原始输出 (2026-09-13)。拼成单串的形态同样可解; 其余 (null / `N/A` / 非串) ⇒ `[]`。
 *
 * 复杂度 O(len)。
 */
export function parseComboLegs(raw: unknown): string[] {
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.filter((leg): leg is string => typeof leg === 'string').join('\n')
        : '';
  return Array.from(text.matchAll(COMBO_LEG_CODE_RE), (m) => m[1] as string);
}
