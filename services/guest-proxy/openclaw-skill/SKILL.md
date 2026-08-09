---
name: nvy-futu-kline
description: Fetch US-equity daily K-line (OHLC) and US option data (expiry ladder, contract chain, live quotes with greeks/IV/OI, and per-underlying IV rank/percentile) from the NVY futu-shim guest endpoint over the wg2 WireGuard tunnel. Use when asked for US stock historical bars/candles or US options chains/quotes; US-only, six endpoints, rate-limited and shared with the owner's production collector.
metadata:
  {
    'openclaw':
      {
        'emoji': '📈',
        'requires': { 'bins': ['curl', 'wg'] },
        'install':
          [
            {
              'id': 'brew',
              'kind': 'brew',
              'formula': 'wireguard-tools',
              'bins': ['wg'],
              'label': 'Install WireGuard tools (brew)',
            },
          ],
      },
  }
---

# NVY futu US 行情（guest access）

取**美股日线历史**与**美股期权**（到期日阶梯 / 合约链 / 实时报价含 greeks / 标的级 IV 分位）。经 wg2 隧道打
NVY 的受限代理，代理背后是港机上的 futu-shim → 富途 OpenD。**只放美股、只有六个端点**，
别把它当通用行情 API。

> ℹ️ slug 里的 `kline` 是历史名 —— 本 skill 现在也覆盖期权面。不改名是为了让
> `FORCE=1 ./setup.sh install-skill` 能**原地升级**，避免新旧两份同时装着让你选错。

## 先决条件（每次会话第一次调用前检查一次即可）

token 从这里取（**不要写进任何文件或消息**）：

```bash
TOKEN="${NVY_FUTU_TOKEN:-$(cat ~/.config/nvy-futu/token 2>/dev/null)}"
```

取不到就停下问用户要，别继续瞎试。

通路检查 —— **用 `/healthz`，不要用 `wg show`**：

```bash
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" http://10.90.0.1:8811/healthz
```

- `200` → 通路 OK，可以往下走
- `000` → 隧道没起。让用户跑 `sudo wg-quick up ~/.config/wireguard/wg2.conf`。
  **你不要自己 sudo** —— 需要密码，会把你挂住
- `401` → token 不对，找用户要

> 🚨 **别用 `wg show wg2` 判连通**（2026-08-04 实测踩过）：macOS 上 ① 它需要 `sudo`
> ② 接口真名是 `utun<N>` 不是 `wg2`（`wg-quick` 在 macOS 走 utun 设备）。
> 不带 sudo 只会得到 `Unable to access interface`，**必然误报「隧道没起」**。
> `/healthz` 既不需要提权、也直接测的是你真正关心的那条路。

## 端点一览（只有这六个）

| 端点                  | 干什么                                                                 | 关键参数                           |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `/healthz`            | 通路探针                                                               | 无                                 |
| `/kline`              | 日线历史 OHLC                                                          | `code` `ktype` `start` `end`       |
| `/option-expirations` | 某标的**有哪些到期日**                                                 | `code`                             |
| `/option-chain`       | 某到期日窗上**有哪些合约**（静态属性，无报价）                         | `code` `start` `end` `option_type` |
| `/option-snapshot`    | 一批合约**现在多少钱**（报价 + greeks + OI）                           | `codes`（复数，逗号分隔）          |
| `/overview`           | 一批**标的**的 IV 分位（`iv` / `iv_rank` / `iv_percentile` + HV 梯队） | `codes`（复数，≤500）              |

## 日线

```bash
curl -sS -m 90 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/kline?code=US.PEP&ktype=K_DAY&start=2026-07-01&end=2026-07-31"
```

| 参数            | 说明                                                           |
| --------------- | -------------------------------------------------------------- |
| `code`          | **必须 `US.` 前缀**（`US.PEP` / `US.AAPL`）。非美股会被 400 拒 |
| `ktype`         | `K_DAY` 日线（还有 `K_WEEK` / `K_MON`）                        |
| `start` / `end` | `YYYY-MM-DD`，可省（省略取默认区间）                           |

## 期权：**三步一条链，顺序不能跳**

期权链和报价是**两个接口**，不存在「一发拿到带报价的整条链」。照下面三步走：

```bash
# ① 先问有哪些到期日（便宜，随便调）
curl -sS -m 90 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/option-expirations?code=US.PEP"

# ② 再按到期日窗取合约。🚨 窗口跨度**最多 30 天（含首尾）**，超了直接 400。
#    要覆盖更长的阶梯就自己切成多个窗 —— 但先读下面的限频，这一步很贵。
curl -sS -m 90 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/option-chain?code=US.PEP&start=2026-08-15&end=2026-09-13"

# ③ 拿 ② 返回的合约 code 去取报价。一次最多 400 个 code。
#    💡 把**标的自己的 code** 也放进同一批，它的 last_price 会一起回来 —— 这样拿
#       现货价不用多打一次。
curl -sS -m 90 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/option-snapshot?codes=US.PEP,US.PEP250815P00150000,US.PEP250815C00150000"
```

几个会让你白跑的点：

- **`/option-chain` 返回的是静态属性**（行权价 / 到期日 / 认购认沽），**没有任何报价**。
  要价格必须走第 ③ 步。看到返回里没有 bid/ask 不是出错。
- **`option_type` 默认 `ALL`**（认购 + 认沽都返）。只要认沽就自己在结果里筛，别以为漏了。
- **`codes` 里每一段都必须是 `US.`**，混一个港股整发被 400 拒（不是只丢那一个）。
- **greeks 可能整块缺失**，那种行**照常返回**并带 `greeks_complete: false`。这是实值腿的
  数学固有现象（报价跌破内在价值 ⇒ IV 无解），**不是数据坏了**，别把这些行丢掉或重试。
- 返回信封统一是 `{"as_of": …, "count": N, "rows": [...]}`。`as_of` 是**采集时刻**，
  不是行情时刻。字段名直接透传富途 SDK，**不要假设它做过归一化**。

## 标的级 IV 分位（`/overview`）—— 挑票的第一步用它，不是用链

```bash
curl -sS -m 90 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/overview?codes=US.PEP,US.KO,US.VICI"
```

一发最多 **500 个标的**，返回每个标的的：

- `iv` —— 富途的**标的级聚合 IV**（不是某张合约的 IV，也没锁 30 天 / 平价，富途未文档化其口径）
- **`iv_rank` / `iv_percentile`** —— 当前 IV 在过去一年里的位置（0-100）。**这是卖方最常看的读数**：
  分位高 = 期权贵 = 适合卖；分位低 = 便宜 = 卖了不划算
- HV 梯队（30/60/90/120/365 天，各带自己的百分位）

用法上的建议：**先用这条在一批自选票里挑出 IV 分位高的，再去对那几只拉链**。反过来做
（先拉一堆链再挑）会把 `/option-chain` 那个每分钟 10 次的紧池打爆。

⚠️ `codes` 的规则与 `/option-snapshot` 完全一样：**每一段都必须 `US.` 前缀**，混一个港股整发被拒。

## 错误对照（照着判，别猜）

| 码      | 含义                                                                                                         | 怎么办                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **502** | 上游行情网关暂时不可用（多半正在重启）。**注意：这不是「冷启，等等就好」** —— 网关是常驻的，正常首发就该 200 | **隔 30 秒重打一次**。仍 502 就**如实告诉用户上游有问题**并停手 —— 别连续重试、别当正常现象吞掉 |
| 400     | `code` / `codes` 不是 `US.` 前缀；或到期日窗 > 30 天；或 `codes` 超过 400 个；或参数格式不对                 | 看返回体的 `detail`，它说得很具体。**港股/A 股本通道一律不可用**，直说做不到，别换端点试        |
| 401     | token 不对，或缺 `Bearer` scheme（`Bearer` 与 token 之间要有一个空格）                                       | 找用户要 token，别重试                                                                          |
| 404     | 你打了白名单外的端点                                                                                         | **只有上面那六个**，别探别的。财报日历、IV 历史一类的端点上游有、但**没对访客开**               |
| 429     | 超了限频（**期权链那条只有 10 次/分，见下**）                                                                | 退避后重试。**别并发刷**                                                                        |

## 硬约束（违反会给对方造成真实成本）

- 🚨 **`/option-chain` 每分钟只有 10 次 —— 这是全通道最紧的一条。** 它对应的上游官方限额
  本身就只有 10 次/30 秒（= 20 次/分），而那个池**与对方每天早上的生产采集共用** ——
  给你的 10 次/分是**从中对半分出来的**，你打满他那轮就只剩一半速度、会真的跑不完。
  ⇒ **不要循环扫多只票的整条到期日阶梯。** 用户要看某只票时，先问清楚要哪几个到期日，
  只取那几个窗。
- 🚨 **期权其余三条每分钟 20 次，且是共享的** —— `/option-expirations` · `/option-snapshot` ·
  `/overview` **三条合起来 20 次**，不是各 20 次。
- ℹ️ `/kline` 宽松得多（**110 次/分**）：那个池对方自己用得很少。但**额度按证券计**那条
  仍然适用（见下一条），别因为限频宽就去批量扫票。
- 🚨 **不要批量扫标的。** 历史 K 线额度按**证券**计、7 天滚动窗；**同一只票反复查免费，
  查一只新票就占一个槽位、七天才释放**。一个 loop 扫几百只票 = 把对方的额度吃掉。
  用户明确要多只时，逐只确认清单，不要自作主张扩展。
- 🚨 **只有美股。** 港股 / A 股不在此通道 —— 这条通道按**最小权限**开，只放行实际需要的
  市场。做不到就直说，不要换端点或改参数试探。
- 🚨 **`ping 10.90.0.1` 不通是设计如此**（隧道只放 8811/tcp），别用它判断连通性 ——
  用 `/healthz`。
