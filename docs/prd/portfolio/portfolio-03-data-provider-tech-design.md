# Portfolio 子文档 03 — Stock 数据层 + 行情 Provider 技术设计（前置依赖）

| 字段              | 内容                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| **隶属模块**      | portfolio（投资大模块）                                                                                       |
| **文档性质**      | **技术设计（Tech Design）**，非产品 PRD——portfolio 多数 UI 特性（04 自选 / 详情 / 预警 / 策略）的前置数据依赖 |
| **对应 Master**   | [portfolio-master-prd.md](portfolio-master-prd.md) §4 技术架构（本文修正 §4.1 关于实时行情的假设，见 §5）     |
| **版本**          | V1.0                                                                                                          |
| **文档状态**      | 草案（待 review → /speckit-specify 拆 server spec）                                                           |
| **第一 provider** | 理杏仁（Lixinger，用户已付费订阅）                                                                            |

> 本文按用户 7 步走组织：① 字段定义 → ② 重要性评级 → ③ 变更频次 → ④ 场景×字段×规模×时效 → ⑤ 理杏仁 API 实证 → ⑥ 数据源映射 → ⑦ 可插拔 provider 抽象。
>
> **⚠️ 修订（2026-06-02）——权威源已迁移**：本 PRD 的数据层设计经深化与订正，**实现权威源 = [Marketdata Master Plan](../../plans/2026-06/06-02-portfolio-marketdata-master.md) + [ADR-0047](../../adr/0047-marketdata-pluggable-data-access.md)**。关键订正：① 同步范畴 **关注池按需拉 → 全量 A 股夜间同步**（为策略实验室；§6 已订正）；② `Instrument` 由**东财 clist 枚举 universe + Lixinger profile 富化**填充（Lixinger 无枚举端点；§8）；③ `DailyBar` 唯一键 **加 `adjust`**（§8 已订正）；④ 端口 **5 → 8**（+ 搜索/universe/交易日历，§7）；⑤ 新增**配置化同步元数据 + 重要度分级 + Vendor Constraint Profile**（双窗限频 1000/min·36/s）；⑥ provider 抽象抽为 **ADR-0047**（取代 §7 非正式描述）。本 PRD 余部为冻结决策记录，不逐条回改。

---

## V1 决策速览

| 决策          | 结论                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 实时价格      | **V1 不做实时**——「最新价」= 最近 EOD 收盘；实时作 capability-port 留兜底，后续接第二 provider 透明替换            |
| 存储          | **V1 仅 PG（事实）+ Redis（热缓存）**；ES 延后（规模/检索需要时再上）                                              |
| 第一 provider | 理杏仁，覆盖 基本面 / 财报 / 日线 / 估值分位 / 公司行动                                                            |
| Provider 形态 | **capability-scoped 多 port**，照搬项目 `SMS_GATEWAY` 范式（Symbol + interface + 工厂 + discriminated-union 配置） |

---

## 1. 字段定义（步骤 1）

两图并集（同花顺 A股详情 + 富途美股详情），按数据类分组：

- **量价**：最新/收盘价、涨跌额、涨跌幅、最高、最低、今开、昨收、均价、振幅、成交量(总手)、成交额、换手率、量比、委比、内盘、外盘、涨停价、跌停价、盘前、52周高低、历史高低。
- **估值**：PE(TTM/静态/动态)、PB、PS(TTM)、股息率(TTM)、总市值、流通市值、总股本、流通股、自由流通股/值、Beta、换股比率(ADR)。
- **估值分位**：PE/PB 历史百分位（3年/5年）。
- **财报衍生**：ROE、毛利率、每股收益(EPS·TTM)、每股净资产(BPS)、市销(TTM)。
- **静态身份/治理**：名称、代码、market、证券类型、币种、表决权差异、注册制、限制减持、扩位简称。
- **第三方专有**：涨停基因（股性评分/封板成功率/近一年涨停/涨停次日开收）——同花顺自算，非通用数据源。

---

## 2-3. 重要性评级 + 变更频次（步骤 2-3）

二者强相关，合并一张表（P0 最高）。与 Master §4.2 的 P0-P3 定级对齐：

| Tier                    | 字段类 | 代表字段                                                 | 变更频次                | 理杏仁覆盖       |
| ----------------------- | ------ | -------------------------------------------------------- | ----------------------- | ---------------- |
| **A · P0 实时量价**     | 量价   | 最新/涨跌/涨幅/成交量/成交额                             | 盘中每 tick（核心实时） | ❌ 仅 EOD 收盘   |
| A · P0 盘中扩展         | 量价   | 最高/最低/今开/量比/委比/内外盘/振幅/均价/盘前           | 盘中每 tick             | ❌ 无盘中源      |
| **B · P1 日频估值**     | 估值   | PE(TTM/静/动)/PB/PS/股息率/市值/流通市值/总股本/流通股   | 每日盘后                | ✅ fundamental   |
| **C · P2 估值分位**     | 分位   | PE/PB 历史百分位(y3/y5)                                  | 每日盘后                | ✅ cvpos（招牌） |
| **D · P3 财报衍生**     | 财报   | ROE/毛利率/EPS/BPS/市销                                  | 财报季                  | ✅ fs            |
| **E · 静态身份**        | 身份   | 名称/代码/market/类型/币种/总股本/52周高低/历史高低/Beta | 极少（年/罕变）         | 部分 ✅          |
| E · 治理                | 治理   | 表决权差异/注册制/限制减持                               | 罕变                    | 部分 ✅          |
| **F · P4 专有（可选）** | 衍生   | 涨停基因/股性评分                                        | 自算                    | ❌ 自算或弃      |

> **衍生字段不抓**：涨停价/跌停价 = 昨收 × ±10%（A股，科创/创业 ±20%）；涨跌额/幅 = 最新 − 昨收。昨收来自 EOD。

---

## 4. 场景 × 字段 × 规模 × 时效（步骤 4）

| 场景                       | 用到字段                                 | 规模               | 时效要求            | V1 实现                                                                      |
| -------------------------- | ---------------------------------------- | ------------------ | ------------------- | ---------------------------------------------------------------------------- |
| **自选列表渲染**（04）     | A(价/涨跌/量) + B(PE/PB/股息率)          | 关注池 N（10-200） | 价=准实时·估值=日频 | **价 = 最近 EOD 收盘**（V1 无盘中）；估值 = 理杏仁日频缓存                   |
| **个股详情页**（详情 PRD） | A+B+C+D+E 全集                           | 1                  | 价=实时·其余=日频   | 价 = EOD 收盘；其余 = 理杏仁 fundamental/fs/分位；**盘中 only 字段 V1 隐藏** |
| **预警引擎**（预警 PRD）   | B/C 冷(PE/分位)先短路 + A 热(价)临界拉取 | 激活预警标的       | 30s 轮询（§4.4）    | V1 价为 EOD → 价格类预警**降级为日频评估**（实时阈值预警待实时源）           |
| **策略实验室**（V2）       | EOD 日线历史 + 财务                      | 大（回测）         | 离线批              | 理杏仁 candlestick + fs，冷存储回放                                          |

**关键约束**：Tier A 实时价 V1 无理杏仁来源 → 上表「价」一律落到 **EOD 收盘**；盘中独有字段（最高/最低/今开/量比/委比/内外盘/盘前）V1 无源，**详情页隐藏、预警不支持盘中阈值**。实时源接入后这些字段与场景自动恢复（端口不变）。

---

## 5. 理杏仁 API 实证（步骤 5）

> 联网调研结论（出处见文末）。**核心修正**：Master §4.1 称"走 Provider 调用理杏仁实时 API"——**理杏仁不提供实时行情**，Master §4.1 已据此更正；实时 provider 候选见 §9。

| 维度      | 结论                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态      | `POST https://open.lixinger.com/api/...`，**token 放 JSON body**，返回 `{code,msg,data}`                                                       |
| 行情      | `cn/company/candlestick`——**仅 EOD 日线**（含复权 fc/bc/ex_rights）；**无 tick / 无分钟 / 无盘中价**                                           |
| 基本面    | `cn/company/fundamental/{non_financial\|bank\|security\|insurance\|other_financial}`——pe_ttm/pb/ps/dyr(股息率)/mc(市值)/cmc(流通市值)/tr(换手) |
| 估值分位  | metricsList 后缀 `pe_ttm.y5.cvpos` 等——**招牌能力**                                                                                            |
| 财报      | `cn/company/fs/{...}`——三表 + ROE/毛利率/EPS/BPS                                                                                               |
| 公司行动  | `cn/company/dividend` / `allotment` / `equity-change`                                                                                          |
| 指数/基金 | `a.indice.*`（指数估值+成分，含分位）；`cn-fund`（A股基金）                                                                                    |
| 市场覆盖  | A股最全；港美股有但薄（`hk/company`、`us-index`，近半年基本面常缺）                                                                            |
| 配额/计费 | **未公开确认**——用户 dashboard 核实                                                                                                            |
| 更新节奏  | 日线+基本面每日盘后；财报随财报季                                                                                                              |

**未确认项**：速率/配额/计费数字、港美股端点完整字段、北交所是否单列、token 是否可走 header。需登录付费 dashboard 或抓真实请求确认（impl 阶段做）。

---

## 6. 数据源映射（步骤 6）

按 §4 场景，V1 全部由理杏仁 + 衍生计算 + EOD 兜底解决：

| 数据需求             | V1 数据源                                                      | 落地                           |
| -------------------- | -------------------------------------------------------------- | ------------------------------ |
| 最新价/涨跌/涨跌幅   | 理杏仁 candlestick 最近一根 EOD（close + 前一根 close 算涨跌） | `QuotePort`（EOD-backed 实现） |
| 成交量/额/换手（日） | 理杏仁 candlestick / fundamental                               | EOD 同步落 PG                  |
| PE/PB/PS/股息率/市值 | 理杏仁 fundamental                                             | 日频快照落 PG + Redis          |
| PE/PB 历史分位       | 理杏仁 fundamental `.cvpos`                                    | 同上                           |
| ROE/毛利率/EPS/BPS   | 理杏仁 fs                                                      | 财报季落 PG                    |
| 分红/拆股/复权       | 理杏仁 dividend/allotment/equity-change                        | 落 PG                          |
| 盘中独有字段         | **无源**                                                       | V1 隐藏/降级，待实时 provider  |

**同步策略**（**已订正 2026-06-02 → 全量 A 股**，权威见 [master plan](../../plans/2026-06/06-02-portfolio-marketdata-master.md) §0/§4.3 + [子 plan 2](../../plans/2026-06/06-02-portfolio-marketdata-p2-sync.md)）：EOD job 每日盘后拉**全量 A 股**（黑名单外全同步，为策略实验室回测留全 universe 历史），按 `syncTier` 序处理（T0 持仓∪自选∪追踪∪预警 优先保底 → T1 → T2），work-conserving 双窗令牌桶（1000/min·36/s）；写 PG（事实层）+ warm Redis（热快照 TTL=至下次 EOD）。Universe 枚举走东财 clist（Lixinger 无枚举端点）。调度 = `@nestjs/schedule @Cron` + Redis 分布式锁（集群单例 HA）。

> 旧策略「只拉关注池并集、不全市场扫描」为冻结记录，已被全量同步取代——分级（tier）继承了「关注池优先」的初衷，但长尾全 universe 仍同步。

---

## 7. 可插拔 Provider 抽象（步骤 7）

### 7.1 设计原则

照搬项目已成熟的 **port/adapter 范式**（`apps/server/src/auth/sms-gateway.port.ts` 等）：`Symbol` token + `interface` + 工厂注入 + discriminated-union Zod 配置。**换 provider 无感的关键**：消费者只依赖 `Symbol`/`interface`，vendor 绑定在 module 工厂里切换。

**关键决策——capability-scoped 多 port**（非单一 MarketDataProvider）：理杏仁能做基本面/财报/日线/分位，但做不了实时价。把能力拆成独立 port，每个 port 各自绑定能实现它的 vendor，单 vendor 覆盖子集即可。这天然支持「理杏仁(基本面) + 未来实时源(价格)」异构组合。

### 7.2 端口清单（canonical symbol = `${market}:${code}`）

> **订正 2026-06-02**：端口由下列 **5 个扩为 8 个**（+ `INSTRUMENT_SEARCH_PORT` / `INSTRUMENT_UNIVERSE_PORT` / `TRADING_CALENDAR_PORT`），权威清单 + vendor 矩阵见 [master §4.2](../../plans/2026-06/06-02-portfolio-marketdata-master.md) + [ADR-0047](../../adr/0047-marketdata-pluggable-data-access.md)。下列 5 port 代码为原始记录。

```ts
export const QUOTE_PORT = Symbol('QUOTE_PORT');
export interface QuotePort {
  // V1: EodBacked 实现返回最近收盘 + 前收算涨跌;V2: 实时 tick adapter 透明替换
  getLatest(symbols: string[]): Promise<QuoteSnapshot[]>;
}

export const FUNDAMENTAL_PORT = Symbol('FUNDAMENTAL_PORT');
export interface FundamentalPort {
  getFundamentals(symbols: string[], asOf?: Date): Promise<FundamentalSnapshot[]>; // PE/PB/股息率/市值/分位
}

export const EOD_BAR_PORT = Symbol('EOD_BAR_PORT');
export interface EodBarPort {
  getDailyBars(
    symbol: string,
    range: DateRange,
    adjust?: 'none' | 'forward' | 'backward',
  ): Promise<DailyBar[]>;
}

export const FINANCIALS_PORT = Symbol('FINANCIALS_PORT');
export interface FinancialsPort {
  getFinancials(symbol: string, periods?: number): Promise<FinancialMetric[]>; // ROE/毛利率/EPS/BPS
}

export const CORPORATE_ACTION_PORT = Symbol('CORPORATE_ACTION_PORT');
export interface CorporateActionPort {
  getActions(symbol: string, range: DateRange): Promise<CorporateAction[]>; // 分红/拆股/复权
}
```

### 7.3 V1 适配器绑定

| Port                  | V1 实现                          | 说明                                                                                               |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `FundamentalPort`     | `LixingerFundamentalAdapter`     | POST fundamental + cvpos 分位                                                                      |
| `EodBarPort`          | `LixingerEodBarAdapter`          | POST candlestick + 复权                                                                            |
| `FinancialsPort`      | `LixingerFinancialsAdapter`      | POST fs                                                                                            |
| `CorporateActionPort` | `LixingerCorporateActionAdapter` | dividend/allotment/equity-change                                                                   |
| `QuotePort`           | **`EodBackedQuoteAdapter`**      | 依赖 `EodBarPort` 取最近收盘 + 前收算涨跌——**实时源就位后换 `RealtimeQuoteAdapter`，消费者零改动** |
| 全部                  | `MockMarketDataAdapter`          | 测试/开发，内存固定数据                                                                            |

### 7.4 配置与工厂（照搬 SMS 范式）

```ts
const ProviderConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lixinger'),
    token: z.string(),
    baseUrl: z.string().default('https://open.lixinger.com/api/'),
  }),
  z.object({ kind: z.literal('mock') }),
]);
```

工厂里 `if (cfg.kind === 'lixinger')` 把各 port 绑到 Lixinger adapter，`QUOTE_PORT` 绑到 `EodBackedQuoteAdapter`。token 走 `@nestjs/config` + env（`LIXINGER_TOKEN`），与 `ALIYUN_ACCESS_KEY_*` 同范式。

### 7.5 鲁棒性与 fallback-chain（Master §4.5）

- 复用项目 `CockatielRetryExecutor`（重试 + 熔断）包裹每个 vendor adapter。
- **fallback-chain seam**：定义 `FallbackChainAdapter<T> implements Port`，包裹 `[primary, ...secondaries]`，主源 503/超时/配额耗尽 → 指数退避重试 → 熔断 → 平移下一顺位（per Master §4.5）。**V1 单 vendor，chain 长度 1，但缝已留**——加 Tushare/东财只是往 chain 里塞 adapter，消费者无感。
- **符号归一化**：每个 adapter 负责 canonical `market:code` ↔ vendor symbol（理杏仁 stockCode）的双向映射，port 对外永远 vendor-neutral。

---

## 8. Schema 草案（PG · portfolio schema · 设计级非最终）

camelCase + `@map` snake_case + `@@schema("portfolio")`（per ADR-0043）。

| 表                    | 角色           | 关键字段                                                                                                            | 唯一键                                                                       |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Instrument`          | 静态身份注册表 | market, code, name, type(stock/etf/index), currency, totalShares                                                    | (market, code)                                                               |
| `DailyBar`            | EOD 日线事实   | instrumentId, tradeDate, **adjust**, open, high, low, close, prevClose, volume, amount, turnoverRate                | **(instrumentId, tradeDate, adjust)** ← 订正（none/forward/backward 三序列） |
| `FundamentalSnapshot` | 日频估值快照   | instrumentId, date, peTtm, peStatic, peDynamic, pb, ps, dividendYield, marketCap, circMarketCap, pePctlY5, pbPctlY5 | (instrumentId, date)                                                         |
| `FinancialMetric`     | 财报衍生       | instrumentId, reportPeriod, roe, grossMargin, eps, bps                                                              | (instrumentId, reportPeriod)                                                 |
| `CorporateAction`     | 公司行动       | instrumentId, exDate, type(dividend/split/allotment), payload                                                       | (instrumentId, exDate, type)                                                 |

- `WatchlistItem`（PRD 04）的 `market+code` 外指 `Instrument`（业务主键对齐 Master §4.1）。
- Redis：热快照缓存（最近 close + 关键估值 per 关注 symbol），TTL 至下次 EOD。
- **不引入 ES**（V1 决策）；时序膨胀用 PG 分区表（Master §4.3）属后续。

---

## 9. 实时行情 provider 候选（补 QuotePort 缺口）

理杏仁无实时 → 未来 `QuotePort` 换实时 adapter 时的候选（联网调研，出处见文末）。**V1 不接**，仅留选型结论备查：

| 候选                       | 实时能力                    | 覆盖                | 接入                       | 成本                 | 风险                         |
| -------------------------- | --------------------------- | ------------------- | -------------------------- | -------------------- | ---------------------------- |
| 新浪 `hq.sinajs.cn`        | L1 快照 · HTTP 轮询         | A/港/美/指数/ETF    | 非官方（需 `Referer` 头）  | 免费                 | 无 SLA · 逆向端点            |
| 腾讯 `qt.gtimg.cn`         | L1 快照 · HTTP 轮询         | 同上                | 非官方（裸 URL）           | 免费                 | 同上 · 常作新浪备源          |
| 东财 `push2.eastmoney.com` | L1+盘口 · HTTP 轮询         | 同上（美股 ~15min） | 非官方                     | 免费                 | 字段最全 · 端点偶改版        |
| AllTick                    | 真 tick · WebSocket(~170ms) | A/港/美/外汇/加密   | 官方开放 API               | 免费档 → ~99 USDT/月 | 商业 SLA · A股实盘价待自验   |
| 富途/老虎 OpenAPI          | 真实时 · WS                 | A/港/美 全          | 官方 · 需券商账户+行情权限 | 行情权限收费         | 券级合规 · 需本地 OpenD 守护 |
| Tushare 实时               | 爬虫包装(底层新浪/东财)     | A股                 | 官方 token                 | 免费(积分)           | 实时无优势                   |
| 米筐/聚宽/Wind/iFinD       | 真实时                      | 全                  | 付费数据服务               | 贵                   | 面向机构，个人不划算         |

**推荐结论**：

1. **A股个人最优（免费）**：新浪 + 腾讯 **双源 HTTP 轮询互为故障切换**（参考 `mpquant/Ashare` 范式），需盘口/资金流时叠东财。代价 = L1 非真 tick + 非官方端点无 SLA。
2. **要 WS 推送/真 tick 且接受小额付费**：AllTick（免费档先验，~99 USDT/月升级）。
3. **港美股**：有富途/老虎账户 → 用其 OpenAPI；否则同走免费端点（美股 ~15min 延迟）或 AllTick。
4. **ToS**：新浪/腾讯/东财均为逆向 web 端点，无授权无 SLA，生产须多源容错 + 限频自控；合规敏感走 AllTick / 券商授权。这套候选正好坐进 §7.5 的 `FallbackChainAdapter`（主免费源 + 备源 + 熔断）。

---

## 10. 边界与待办

### Out of Scope（V1 本设计不含）

1. **实时/盘中行情源**——`QuotePort` 用 EOD 兜底，实时 adapter 待第二 provider。
2. **ES 检索层 / 冷热归档 / Parquet**（Master §4.3）——延后。
3. **EOD 同步 job 的调度实现**（cron/queue/DLQ 细节）——本设计只定数据流与按需拉取策略。
4. **港美股深度字段**——理杏仁覆盖薄，V1 以 A 股为主。

### 待办

1. ✅ **已修正 Master §4.1**——删除"理杏仁实时 API"表述，改为 QuotePort EOD 兜底 + 实时 provider 待接（候选见 §9）。
2. **理杏仁配额/计费/端口字段** impl 阶段从付费 dashboard + 真实请求确认。
3. /speckit-specify 拆 server spec：建议把「Instrument 注册表 + EOD 同步 + 5 capability-port + Lixinger adapter + EodBackedQuote」作为关键 functional 锚点。

---

## 出处

### 理杏仁调研

- open.lixinger.com base URL / 鉴权 — `github.com/ShekiLyu/lixinger-openapi`
- CN 端点全清单（源码）— `github.com/tanchangde/lixingr2` `R/cn-company.R`
- POST JSON + token in body + `pe_ttm.cvpos` 分位实战 — CSDN blog `TwistedDemonwy/article/140271954`
- Python SDK 路径映射 — `github.com/Chaoyingz/lixinger`
- 官方 doc 入口（需登录看全）— `lixinger.com/open/api/doc`

### 实时 provider 调研

- 新浪/腾讯双源范式 — `github.com/mpquant/Ashare`
- 新浪接口 `Referer` 要求 — CSDN `yu502586512/article/134306571`
- 东财 push2 用法 + akshare 美股 15min 延迟/改版 — 博客园 + akshare issue #5810
- AllTick 股票 API（A/港/美） — `alltick.io/zh-CN/stock-api`
- 富途 OpenAPI 官方文档 — `openapi.futunn.com/futu-api-doc`
- Tushare 实时（爬虫）+ 积分权限 — `tushare.pro/document` doc_id 315 / 290
