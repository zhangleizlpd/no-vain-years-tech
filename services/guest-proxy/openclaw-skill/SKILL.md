---
name: nvy-futu-kline
description: NVY guest channel over the wg2 WireGuard tunnel — the single entry point for every request served by the owner's NVY side (market data of any kind, options, research-report submission, and any other capability the owner exposes). This skill carries NO endpoint list of its own; the live capability catalog is fetched at runtime from the channel. Use it whenever the user asks for anything that could plausibly be served by the NVY channel, and ALWAYS consult the catalog before telling the user something is unavailable.
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

# NVY guest access（薄壳 —— 能力目录在运行时取）

经 wg2 隧道打 NVY 的受限代理。Base URL 固定：`http://10.90.0.1:8811`

**本 skill 刻意不含任何端点清单。** 通道能力由对方随时增删，写死在这里必然过期，而过期的
形态最阴：你照着一份旧清单告诉用户「做不到」，其实对方早就开了。端点、参数、限额、踩坑
全部在运行时从 `/capabilities` 取。

> ℹ️ slug 里的 `kline` 是历史名，早已名不副实。不改名是为了让
> `FORCE=1 ./setup.sh install-skill` 能**原地升级** —— 换名会让新旧两份同时装着，
> 你会选错那个。

## 先决条件（每次会话第一次调用前检查一次即可）

这一段管的是**怎么够到通道**，与通道开了哪些能力无关，所以它留在本地、不随目录下发。

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
>
> 🚨 **`ping 10.90.0.1` 不通是设计如此**（隧道只放 8811/tcp），也别拿它判连通。

## 拉能力目录 —— 这一步不能跳

```bash
curl -sS -m 20 -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/capabilities"
```

返回一份 markdown 正文，**它是本通道能力的唯一真相源**：有哪些端点、每个端点的参数、
必须带什么、限频多少、哪些坑会让你白跑，全在里面。

🚨 **照目录里写的调，不要照你的直觉调。** 这个通道上多个端点的参数形态互不相同（有的用
单数 `code`、有的用复数 `codes`、有的连 code 都没有），凭「一般 API 都这么写」去猜必然被
400 拒 —— 而反复改参数试错会**烧掉对方的限频额度**，那是真实成本，不是你自己的重试预算。

拿到目录后，照它给的 curl 范例替换参数发起真正的调用。

## 判断「做不做得到」的唯一依据是目录

用户要的东西目录里没有 ⇒ 如实说本通道没这个能力，并说明目录里有什么。

🚨 **不要在没拉目录的情况下就下这个结论**，也**绝对不要拿你自己的知识去凑一个答案**。
你手里这份文档不知道通道现在开了什么；而凭记忆编出来的行情 / 财报 / 报价看起来会非常
像真的，用户没有任何办法分辨。**说「查不到」永远比编一个数字好。**

同理：**不要拿一个能用的端点去硬凑另一个用途**。目录里每个端点写清楚了它返回什么，
返回的不是用户要的东西时，就是做不到，不是「换个角度解读一下」。
