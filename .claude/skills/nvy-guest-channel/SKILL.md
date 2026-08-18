---
name: nvy-guest-channel
description: NVY 受限通道接入 —— 经 wg2 隧道打对方 NVY 侧开放的一切能力：任意行情 / 报价 / 期权链 / IV 分位 / 日线 / 交易日历 / 研报投递 / 送估值锚，以及对方随时新开的任何其它能力。本 skill 刻意不含端点清单，能力目录在运行时从通道拉取，那份目录是唯一真相源。触发：用户提"查行情 / 期权 / IV / 日线 / 投研报 / 送估值 / 送锚 / NVY 通道 / guest channel"，或任何可能由该通道提供的市场与金融数据请求。🚨 在凭自己的知识作答、或告诉用户"做不到"之前，永远先拉一次目录。
user-invocable: true
disable-model-invocation: false
model: inherit
---

# nvy-guest-channel — 通道接入（薄壳，能力目录在运行时取）

经 wg2 隧道打 NVY 的受限代理。Base URL 固定：`http://10.90.0.1:8811`

**本 skill 刻意不含任何端点清单。** 通道能力随时增删，写死在这里必然过期，而过期的形态最阴：
你照着一份旧清单告诉用户「做不到」，其实早就开了。端点、参数、限额、踩坑全部在运行时从
`/capabilities` 取。

> ⚠️ **前置**：隧道凭证在本机 `~/.config/nvy-futu/token`（0600）。本机持有的是**持有者本人**
> 的凭证，因此需要「直写」语义的能力对本机可用 —— 具体有哪些口、怎么调，**看目录**，本文不写。
>
> ⚠️ 本 skill 与 `.claude/commands/anchor-import.md` 是**同一份仓内 SoT** 经 symlink 装到
> `~/.claude/` 的。symlink 钉死当前 worktree 路径，仓挪窝要重建：
>
> ```bash
> ln -sfn "$PWD/.claude/skills/nvy-guest-channel" "$HOME/.claude/skills/nvy-guest-channel"
> ln -sfn "$PWD/.claude/commands/anchor-import.md" "$HOME/.claude/commands/anchor-import.md"
> ```

## 先决条件（每次会话第一次调用前检查一次即可）

这一段管的是**怎么够到通道**，与通道开了哪些能力无关，所以它留在本地、不随目录下发。

token 从这里取（**不要写进任何文件或消息**）：

```bash
TOKEN="${NVY_FUTU_TOKEN:-$(cat ~/.config/nvy-futu/token 2>/dev/null)}"
```

取不到就停下问用户要，别继续瞎试。

通路检查 —— **用 `/healthz`，不要用 `wg show`**：

```bash
curl -sS -m 10 --noproxy '*' -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" http://10.90.0.1:8811/healthz
```

- `200` → 通路 OK，可以往下走
- `000` → 隧道没起。让用户跑 `sudo wg-quick up ~/.config/wireguard/wg2.conf`。
  **你不要自己 sudo** —— 需要密码，会把你挂住
- `401` → token 不对，找用户要

> 🚨 **别用 `wg show wg2` 判连通**（2026-08-04 实测踩过）：macOS 上 ① 它需要 `sudo`
> ② 接口真名是 utun 设备不是 `wg2`（`wg-quick` 在 macOS 走 utun）。不带 sudo 只会得到
> `Unable to access interface`，**必然误报「隧道没起」**。`/healthz` 既不需要提权、
> 也直接测的是你真正关心的那条路。
>
> 🚨 **`ping 10.90.0.1` 不通是设计如此**（隧道只放 8811/tcp），也别拿它判连通。
>
> 🚨 **`curl` 必带 `--noproxy '*'`**：交互 shell 里的代理环境变量会让请求绕出隧道，
> 拿到的失败与「隧道没起」不可区分。

## 拉能力目录 —— 这一步不能跳

```bash
curl -sS -m 20 --noproxy '*' -H "Authorization: Bearer $TOKEN" \
  "http://10.90.0.1:8811/capabilities"
```

返回一份 markdown 正文，**它是本通道能力的唯一真相源**：有哪些端点、每个端点的参数、
必须带什么、限频多少、哪些坑会让你白跑，全在里面。

🚨 **照目录里写的调，不要照你的直觉调。** 这个通道上多个端点的参数形态互不相同（有的用
单数 `code`、有的用复数 `codes`、有的连 code 都没有，有的参数必须在 query 而非 body），
凭「一般 API 都这么写」去猜必然被 400 拒 —— 而反复改参数试错会**烧掉限频额度**，
那是真实成本，不是你自己的重试预算。

🚨 **一个端点的参数编码经验不可外推到另一个端点。** 目录里逐条写了哪些参数要手工编码、
哪些绝对不能编码。2026-08-18 实测：模型把某一节的编码建议泛化到另一节，产出的命令必炸。

拿到目录后，照它给的 curl 范例替换参数发起真正的调用。

## 判断「做不做得到」的唯一依据是目录

用户要的东西目录里没有 ⇒ 如实说本通道没这个能力，并说明目录里有什么。

🚨 **不要在没拉目录的情况下就下这个结论**，也**绝对不要拿你自己的知识去凑一个答案**。
你手里这份文档不知道通道现在开了什么；而凭记忆编出来的行情 / 财报 / 报价看起来会非常
像真的，用户没有任何办法分辨。**说「查不到」永远比编一个数字好。**

同理：**不要拿一个能用的端点去硬凑另一个用途**。目录里每个端点写清楚了它返回什么，
返回的不是用户要的东西时，就是做不到，不是「换个角度解读一下」。

## 写口另有纪律，走 command

通道上**会改对方库的那些口**（送估值锚等）不在本 skill 的职责内 —— 它们的字段语义、
发送前的复述闸、应答怎么读，单点在对应的 command 里（送估值锚 → `/anchor-import`）。

🚨 本 skill 只负责「够得到通道」。**不要绕过 command 直接对写口发请求** ——
那些口没有幂等、应答不回显数值，填错不会有任何东西告诉你。
